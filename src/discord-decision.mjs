// 디코에서 결정에 답하기 — 다리(kadan discord watch --to-mail)의 정해진 규칙 코드다. 비서(AI)가 아니다.
// 레포 포럼 스레드 안의 kyle 글이 결정 요청에 대한 답인지 알아보고, 정확히 맞을 때만 `DecisionStore.answer`로 기록한다.
// 기록은 사용자 명의(기존 사용자 행위자 이름) + source 'discord' + 디코 글 id다. isUserActor는 넓히지 않았다(비서 이름으로는 여전히 거절).
// 승인·머지·배포 같은 실행은 하지 않는다. 결정 기록까지만이다. 자유 텍스트 답(--text)은 1차 범위 밖이라 되묻기가 대신한다.
// 반환(handle): true면 이 글은 결정 쪽에서 끝났다(우편으로 보내지 않는다), false면 일반 글로 비서 우편에 보낸다.
import fs from 'node:fs';
import path from 'node:path';
import {DecisionStore} from './decisions.mjs';
import {readDecisions} from './notify-threads.mjs';
import {userActorNames} from './actors.mjs';
import {sendText} from './discord-chat.mjs';
import {findMailBySourceKey} from './ledger.mjs';
import {SECRETARY} from './mailbox.mjs';

export const HANDLED_FILE = 'discord-decision-handled.json';
const MAX_HANDLED = 500;
const cut = (text, n) => { const t = String(text).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const head = d => cut(String(d.question).split('\n').find(l => l.trim()) ?? d.question, 40);
const optionList = d => d.options.map((o, i) => `${i + 1}) ${cut(o, 100)}`).join(' ');

// 앞뒤 공백만 지운 글이 선택지 문구와 정확히 같거나, 1부터 센 번호일 때만 인정한다. "1번"·"1 — 이유"·문구 일부는 인정하지 않는다.
export function matchChoice(options, content) {
  const t = String(content ?? '').trim();
  if (options.includes(t)) return t;
  if (/^[1-9]\d*$/.test(t) && Number(t) <= options.length) return options[Number(t) - 1];
  return null;
}
// 선택지처럼 보이는 글: 숫자만 있거나 어느 한 결정의 선택지 문구와 정확히 같다.
const looksLikeChoice = (decisions, content) => {
  const t = String(content ?? '').trim();
  return /^[1-9]\d*$/.test(t) || decisions.some(d => d.options.includes(t));
};

function readHandled(home) {
  try { const v = JSON.parse(fs.readFileSync(path.join(home, HANDLED_FILE), 'utf8')); return Array.isArray(v.ids) ? v.ids.filter(x => typeof x === 'string') : []; } catch { return []; }
}
function markHandled(home, id) {
  const ids = [...readHandled(home).filter(x => x !== id), id].slice(-MAX_HANDLED);
  const file = path.join(home, HANDLED_FILE), tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  fs.writeFileSync(tmp, JSON.stringify({ids}) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

// 디코 글 id는 시간순(snowflake)이다. 결정 요청 메시지보다 먼저(같은 id 포함) 쓰인 글은 그 결정의 답이 될 수 없다.
// 상태 파일·cursor·재등록이 어떻게 꼬여도 옛 글이 새 결정의 답으로 읽히지 않게 하는 바탕 규칙이다.
// 양쪽이 십진 숫자열 id 모양이어야 비교한다 — BigInt가 받아들이는 `0x1`·`+1`·`-1`·공백·빈 값 같은 손상 값은 후보에서 뺀다.
const DISCORD_ID = /^[1-9][0-9]{0,19}$/;
export const writtenAfter = (messageId, requestMessageId) =>
  typeof messageId === 'string' && typeof requestMessageId === 'string' && DISCORD_ID.test(messageId) && DISCORD_ID.test(requestMessageId)
  && BigInt(messageId) > BigInt(requestMessageId);

// 상태 파일이 어떻게 꼬여도 감시하지 않던 동안 쓴 글이 결정으로 기록되지 않게 하는 상태와 무관한 상한.
// 다리는 5초마다 조회하고 꺼져도 1분 안에 되살아나므로 정상 답은 몇 초~몇 분 안에 처리된다. 10분 넘게 늦게 받은 글은 결정으로 기록하지 않는다.
// 미래 시각 id(시계 차이)는 정상으로 보되 1시간 넘게 미래면 손상으로 보고 기록하지 않는다.
export const LATE_ANSWER_MS = 10 * 60 * 1000;
export const FUTURE_LIMIT_MS = 60 * 60 * 1000;
const DISCORD_EPOCH_MS = 1420070400000n;
export const messageTimeMs = id => Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);

export function createDecisionAnswerer({home, chat, env = process.env, log = () => {}, store = new DecisionStore(home), mailRole = SECRETARY,
  now = () => (chat.now ?? Date.now)(), lateMs = LATE_ANSWER_MS}) {
  const by = userActorNames(env)[0];
  // 같은 스레드에 답 글을 올린다. 실패하면 false(받기를 멈추지 않는다 — 봇에게 스레드 쓰기 권한이 아직 없을 수 있다).
  const post = async (line, text, quiet) => {
    try { await sendText(chat, text, {thread: line.threadId, quiet}); return true; } catch (error) { log(`결정 응답 글을 못 올렸다(${error.status ?? error.kind ?? 'ERR'}): ${error.message}`); return false; }
  };
  const stateText = d => (d.status === 'answered' ? `이미 답변됨: ${cut(d.answer.choice ?? d.answer.text, 100)}` : '이미 취소됨');
  const settled = async (line, d) => { if (!await post(line, `${stateText(d)} (결정 ${d.id.slice(0, 8)}) — 기록을 바꾸지 않았습니다.`, true)) return false; markHandled(home, line.id); return true; };

  async function record(line, d, choice) {
    const age = now() - messageTimeMs(line.id);
    if (!(age <= lateMs && age >= -FUTURE_LIMIT_MS)) {       // 늦게 받은 답(또는 손상된 미래 id): 기록하지 않고 조용히 알린 뒤 일반 글로 비서 우편에 보낸다
      log(`늦게 받은 결정 답을 기록하지 않았다: 디코 글 ${line.id} (${Math.round(age / 1000)}초 전)`);
      await post(line, `늦게 받은 답이라 기록하지 않았습니다. 다시 답해 주세요: ${optionList(d)}`, true);
      return false;
    }
    let fresh;
    try { fresh = store.get(d.id); } catch { return false; }
    if (fresh.status !== 'open') return settled(line, fresh);
    try {
      store.answer(d.id, {revision: fresh.revision, text: choice, choice, source: 'discord', messageId: line.id}, by);
    } catch (error) {
      let now = null;
      try { now = store.get(d.id); } catch { /* 아래에서 우편으로 보낸다 */ }
      if (now?.answer?.messageId !== line.id) {            // 기록된 것이 내 답이 아니다
        if (now && now.status !== 'open') return settled(line, now);
        log(`결정 답 기록 실패: ${error.message}`);
        return false;                                       // 일반 글로 비서에게 간다
      }
      log(`결정 답은 기록됐고 뒤처리에서 오류: ${error.message}`);
    }
    log(`결정 답 기록: ${d.id.slice(0, 8)} ← 디코 글 ${line.id}`);
    await post(line, `기록됨: ${choice}`, true);          // 기록이 본체다. 확인 글이 실패해도 기록은 그대로다
    markHandled(home, line.id);
    return true;
  }

  const askOne = async (line, d) => {
    if (!await post(line, `기록하지 않았습니다. 선택지 번호나 문구 그대로 답해 주세요: ${optionList(d)}`, false)) return false;
    markHandled(home, line.id);
    return true;
  };
  const askMany = async (line, open) => {
    const list = open.map((d, i) => `${i + 1}) ${head(d)}`).join('\n');
    const text = `열린 결정이 여러 개라 어느 결정의 답인지 알 수 없어 기록하지 않았습니다. 답하려는 결정 요청 글에 답장(Reply)으로 선택지 번호나 문구 그대로 답해 주세요.\n열린 결정:\n${list}`;
    if (!await post(line, text, false)) return false;
    markHandled(home, line.id);
    return true;
  };

  return async function handle(line) {
    if (line.where !== 'thread' || !line.threadId || !line.channel) return false;     // 레포 포럼 스레드 안의 글만
    if (readHandled(home).includes(line.id)) return true;                              // 재시작 뒤 같은 글을 두 번 처리하지 않는다
    // 이미 우편으로 저장된 글은 다시 분류하지 않는다(저장 직후 cursor 저장 전에 죽은 뒤 재시작해도 그 글이 새 결정의 답이 되지 않는다)
    try { if (findMailBySourceKey(home, mailRole, `discord:${line.id}`)) return true; } catch { /* 조회 실패면 아래 바탕 규칙이 막는다 */ }
    let all;
    try { all = store.list(); } catch (error) { log(`결정 이력을 읽지 못했다: ${error.message}`); return false; }
    if (all.some(d => d.answer?.messageId === line.id)) return true;                   // 이미 이 글로 기록됐다
    const known = readDecisions(home);
    const here = all.filter(d => known[d.id]?.messageId && known[d.id].threadId === line.threadId && writtenAfter(line.id, known[d.id].messageId));
    if (!here.length) return false;
    // (가) 저장된 결정 요청 메시지에 대한 디코 답장
    const target = line.replyTo ? here.find(d => known[d.id].messageId === line.replyTo) : undefined;
    // 답장인데 이 스레드의 결정 요청 메시지를 가리키지 않으면(경보·상태 글, 다른 스레드의 결정, 모르는 메시지) 결정 답이 아니다. (나)로 내려가지 않는다.
    if (line.replyTo && !target) return false;
    if (target) {
      if (target.status !== 'open') return settled(line, target);
      const choice = matchChoice(target.options, line.content);
      return choice ? record(line, target, choice) : askOne(line, target);
    }
    // (나) 답장은 아니지만 이 스레드에 요청 메시지가 있는 열린 결정이 정확히 하나
    const open = here.filter(d => d.status === 'open');
    if (open.length === 1) {
      const choice = matchChoice(open[0].options, line.content);
      return choice ? record(line, open[0], choice) : false;                           // 맞지 않는 글은 일반 글
    }
    if (open.length > 1 && looksLikeChoice(open, line.content)) return askMany(line, open);
    return false;
  };
}
