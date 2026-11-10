// 디코 한 마디로 Autopilot 켜고 끄기 — 다리(kadan discord watch --to-mail)의 정해진 규칙 코드다. 비서(AI)가 아니다.
// #비서 채널 본문 글이 아래 문구와 정확히 같을 때만 사람 명의로 `autopilotCommand`를 부른다. 그 밖의 글은 건드리지 않는다(비서 우편으로 간다).
// 설계: docs/daily/research/2026-11-02_나이트-모드-단계화.md 8절. 결정 답(discord-decision.mjs)과 같은 늦은 글·처리 표시 규칙을 쓴다.
// 반환(handle): true면 이 글은 여기서 끝났다(우편으로 보내지 않는다), false면 일반 글이다.
import {autopilotCommand} from './commands/autopilot.mjs';
import {userActorNames} from './actors.mjs';
import {sendText} from './discord-chat.mjs';
import {readLedger} from './ledger.mjs';
import {clock} from './autopilot.mjs';
import {MODE, LEVEL_CRUISE, LEVEL_AUTOPILOT, LEVEL_FULL, LEVEL_LABEL} from './autopilot-terms.mjs';
import {
  messageTimeMs, LATE_ANSWER_MS, FUTURE_LIMIT_MS, readHandled, markHandled, readLate, markLate,
} from './discord-decision.mjs';

const cut = (text, n) => { const t = String(text).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// 글 전체(앞뒤 공백만 지움)가 정확히 맞을 때만 인정한다. 공백 여럿·"잘게요"·"잘게 자동으로"는 일반 글이다.
const ON = /^잘게(?: (자동))?(?: (?:(\d+)시간|(\d{1,2}:\d{2})까지))?$/;
export function parseAutopilotWord(content) {
  const t = String(content ?? '').trim();
  if (t === '일어남') return {kind: 'off'};
  if (/^잘게 바이패스(?: .*)?$/.test(t)) return {kind: 'bypass'};
  const m = ON.exec(t);
  if (!m) return null;
  return {kind: 'on', auto: Boolean(m[1]), ...(m[2] ? {hours: m[2]} : {}), ...(m[3] ? {until: m[3]} : {})};
}

export function createAutopilotWordHandler({home, chat, env = process.env, log = () => {}, deps = {}, lateMs = LATE_ANSWER_MS,
  now = () => (chat.now ?? Date.now)()}) {
  const by = userActorNames(env)[0];
  const post = async (text) => {   // 채널에 조용히 한 통. 실패해도 켜기·끄기 기록은 그대로다
    try { await sendText(chat, text, {quiet: true}); return true; } catch (error) { log(`Autopilot 한 마디 응답 글을 못 올렸다(${error.status ?? error.kind ?? 'ERR'}): ${error.message}`); return false; }
  };

  return async function handle(line) {
    if (line.where !== 'channel' || line.threadId || line.channel || line.quoted) return false;   // #비서 본문의 새 글만
    const word = parseAutopilotWord(line.content);
    if (!word) return false;                                                                       // 문구 비교 한 번으로 끝난다
    if (readHandled(home).includes(line.id)) return true;                                          // 재시작 뒤 같은 글을 두 번 처리하지 않는다
    const age = now() - messageTimeMs(line.id);
    if (!(age <= lateMs && age >= -FUTURE_LIMIT_MS)) {                                             // 늦은 글·손상된 미래 id: 켜지 않는다
      if (!readLate(home).includes(line.id)) {
        log(`늦게 받은 Autopilot 한 마디를 처리하지 않았다: 디코 글 ${line.id} (${Math.round(age / 1000)}초 전)`);
        markLate(home, line.id);
        markHandled(home, line.id);
        await post('늦게 받은 글이라 켜지 않았습니다. 다시 써 주세요');
      }
      return true;
    }
    if (word.kind === 'bypass') {
      markHandled(home, line.id);
      await post(`${LEVEL_LABEL[LEVEL_FULL]}은 아직 없습니다. 켜지 않았습니다`);
      return true;
    }
    if (word.kind === 'on') {   // 켠 뒤 처리 표시 전에 죽었다면 원장에 이 글 id가 이미 있다 → 다시 켜지 않는다
      try { if (readLedger(home).some(e => e?.kind === 'autopilot' && e.phase === 'on' && e.discordMessageId === line.id)) { markHandled(home, line.id); return true; } } catch { /* 읽기 실패면 아래 autopilotCommand가 막는다 */ }
    }
    const nowMs = now();
    const run = {home, by, deps: {now: () => nowMs, ...deps}};
    let reply;
    try {
      if (word.kind === 'off') {
        autopilotCommand(['off'], {}, run);
        reply = 'Autopilot 끔 — 아침 요약은 슈퍼감독 우편·알림으로 갑니다';
      } else {
        const flags = {'discord-message': line.id, level: word.auto ? LEVEL_AUTOPILOT : LEVEL_CRUISE,
          ...(word.hours ? {for: `${word.hours}h`} : {}), ...(word.until ? {until: word.until} : {})};
        const r = autopilotCommand(['on', `디코 한 마디로 켬: "${String(line.content).trim()}"`], flags, run);
        const ok = (r.delivered ?? []).filter(d => d.ok !== false).length;
        reply = `${MODE} 켬: ${LEVEL_LABEL[word.auto ? LEVEL_AUTOPILOT : LEVEL_CRUISE]} · ${r.untilLocal.slice(6)}까지 · 슈퍼감독 ${ok}명에게 전달 · 끄려면 '일어남'`;
      }
    } catch (error) {
      reply = cut(`켜지 않았습니다: ${error.message}`, 300);
      if (word.kind === 'off') reply = cut(`끄지 못했습니다: ${error.message}`, 300);
      log(`Autopilot 한 마디 실패: ${error.message}`);
    }
    markHandled(home, line.id);
    await post(reply);
    return true;
  };
}
