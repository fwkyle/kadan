// 디스코드 3단계(#비서 대화) — 설정 읽기, 받기(watch), 보내기(send), 스레드. 판단은 비서(AI)가 하고 코드는 받기·보내기만 한다.
// 받기: REST 주기 조회. #비서 본문 + 그 채널의 활성 스레드를 본다. DISCORD_USER_ID 한 명의 글만 JSON 한 줄씩 낸다.
// 상태 파일($KADAN_HOME/discord-chat-state.json)에는 채널 해시·마지막 메시지 ID·건너뜀 건수만 둔다. 토큰·주소·사용자 ID는 적지 않는다.
// 전달 보장은 "최소 한 번"이다(kyle 질문을 잃는 것이 중복보다 나쁘다): 출력이 실제로 나간 뒤(쓰기 완료·역압 처리) cursor를 저장하고 그다음 읽음 반응을 단다.
// 재시작하면 마지막 저장 이후 글을 다시 낼 수 있다. 각 줄의 메시지 ID로 받는 쪽(비서)이 이미 본 글을 거른다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadSecret} from './secrets.mjs';
import {DiscordError, createApi, apiBase, splitDiscord, DISCORD_LIMIT} from './discord-bot.mjs';
import {scrubSecrets} from './user-notify.mjs';

export const STATE_FILE = 'discord-chat-state.json';
export const LOCK_DIR = 'discord-chat.lock';
export const READ_EMOJI = '👀';
export const DEFAULT_INTERVAL_S = 5;
const THREAD_FORGET_MS = 180 * 24 * 3600 * 1000;
const DISCORD_EPOCH = 1420070400000n;
const THREAD_TYPES = new Set([10, 11, 12]);
const NO_MENTION = {parse: []};
const SUPPRESS_NOTIFICATIONS = 4096; // user-notify.mjs와 같은 값(디스코드 SUPPRESS_NOTIFICATIONS 플래그)
const isId = v => typeof v === 'string' && /^\d{1,25}$/.test(v);
const idMs = id => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
const idLess = (a, b) => BigInt(a) < BigInt(b);
const maxId = (a, b) => (a && b ? (idLess(a, b) ? b : a) : a ?? b);

// ---------- 설정 ----------
// 반환: {token, userId, secrets[], channelId?(키로 준 경우), webhook?{id,token}, warnings[]} — 값은 호출 쪽 메모리에만 있다.
export function loadChatConfig(env, home) {
  const bot = loadSecret(env, home, 'discord-bot'), hook = loadSecret(env, home, 'discord');
  const fail = message => { throw new Error(`설정 오류: ${message}`); };
  if (bot.source === 'broken') fail(`discord-bot 위치 설정 손상 — ${bot.error}`);
  if (!bot.values) fail(bot.error ?? 'discord-bot 비밀 파일이 없다 — kadan secrets set discord-bot --file <절대경로>');
  const token = bot.values.DISCORD_BOT_TOKEN;
  if (!token || /\s/.test(token)) fail('discord-bot 파일에 DISCORD_BOT_TOKEN이 없거나 형식이 잘못됐다');
  if (hook.source === 'broken') fail(`discord 위치 설정 손상 — ${hook.error}`);
  if (!hook.values) fail(hook.error ?? 'discord 비밀 파일이 없다 — 사용자 ID(DISCORD_USER_ID)를 여기서 읽는다');
  const userId = hook.values.DISCORD_USER_ID;
  if (!isId(userId)) fail('discord 파일의 DISCORD_USER_ID가 없거나 숫자가 아니다');
  const keyed = bot.values.DISCORD_SECRETARY_CHANNEL_ID ?? hook.values.DISCORD_SECRETARY_CHANNEL_ID;
  if (keyed !== undefined && !isId(keyed)) fail('DISCORD_SECRETARY_CHANNEL_ID는 숫자여야 한다');
  const cfg = {token, userId, channelId: keyed ?? null, webhook: null, secrets: [userId, bot.values.DISCORD_APPLICATION_ID].filter(Boolean),
    warnings: [...bot.warnings, ...hook.warnings]};
  const url = hook.values.DISCORD_WEBHOOK_URL_SECRETARY;
  if (url) {
    cfg.secrets.push(url);
    const m = /\/webhooks\/(\d+)\/([\w-]+)/.exec(url);
    if (m) { cfg.webhook = {id: m[1], token: m[2]}; cfg.secrets.push(m[1], m[2]); }
  }
  if (!cfg.channelId && !cfg.webhook) fail('#비서 채널을 알 수 없다 — discord 파일에 DISCORD_WEBHOOK_URL_SECRETARY(웹훅)나 DISCORD_SECRETARY_CHANNEL_ID가 필요하다');
  return cfg;
}

// 한 프로세스가 쓰는 도구 묶음. channelId는 처음 필요할 때 한 번 얻는다: 키가 있으면 그것, 없으면 웹훅 조회(GET /webhooks/{id}/{token}, 봇 권한 불필요).
export function createChat({home, env = process.env, cfg = loadChatConfig(env, home), fetchFn, sleep, now}) {
  const api = createApi({base: apiBase(env), token: cfg.token, secrets: cfg.secrets, fetchFn, sleep, now});
  let channelId = cfg.channelId, via = cfg.channelId ? 'key' : null, channel = null;
  const chat = {
    cfg, api, home, now,
    get channelVia() { return via; },
    async channelIdOf() {
      if (channelId) return channelId;
      const r = await api('GET', `/webhooks/${cfg.webhook.id}/${cfg.webhook.token}`, undefined, {noAuth: true});
      if (!isId(r.json?.channel_id)) throw new DiscordError('웹훅 응답에 채널 정보가 없다', {kind: 'http'});
      via = 'webhook';
      return (channelId = r.json.channel_id);
    },
    async channelInfo() { return channel ??= (await api('GET', `/channels/${await chat.channelIdOf()}`)).json; },
  };
  return chat;
}

// ---------- 상태 ----------
const statePath = home => path.join(home, STATE_FILE);
const channelHash = id => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
const emptyState = hash => ({version: 1, channel: hash, main: null, threads: {}, skipped: {others: 0, bots: 0, system: 0}});

// 파일이 없을 때만 null(처음 실행). 있는데 읽기·형식이 깨졌으면 던진다 — 원본은 그대로 두고 cursor를 올리지 않는다.
// 채널이 바뀐 경우(해시 불일치)는 {mismatch:true}로 알려 새 기준선을 잡게 한다.
export function readState(home, hash) {
  const file = statePath(home);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`상태 파일을 읽을 수 없다(${error.code ?? 'ERR'}): ${file}`);
  }
  let v;
  try { v = JSON.parse(text); } catch { v = null; }
  // 읽을 때 쓰는 모든 내부 값을 처음에 검사한다(출력·저장 뒤에 늦게 터지는 변환이 남지 않게).
  const count = n => Number.isInteger(n) && n >= 0;
  const ok = v?.version === 1 && typeof v.channel === 'string' && (v.main === null || isId(v.main))
    && v.threads && typeof v.threads === 'object' && !Array.isArray(v.threads)
    && Object.entries(v.threads).every(([id, last]) => isId(id) && isId(last))
    && v.skipped && typeof v.skipped === 'object' && ['others', 'bots', 'system'].every(k => count(v.skipped[k]));
  if (!ok) throw new Error(`상태 파일이 깨져 있어 멈춘다(원본은 그대로 둔다). 확인한 뒤 이 파일을 옮기면 처음 실행(기준선)으로 다시 시작한다: ${file}`);
  if (v.channel !== hash) return {mismatch: true};
  return {...emptyState(hash), ...v};
}

export function writeState(home, state) {
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const file = statePath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({...state, updatedAt: new Date().toISOString()}) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

// 잠금을 쥔 살아 있는 받기 프로세스의 {pid, mode, to}. 없거나 주인이 죽었으면 null(읽기만 한다 — 치우지 않는다).
// mode: 'mail'(우편 모드, to=받는 역할) | 'stdout' | 'unknown'(모드 기록이 없는 옛 잠금 — 우편 모드로 믿지 않는다).
export function watchLockInfo(home) {
  let pid = NaN;
  try { pid = Number(fs.readFileSync(path.join(home, LOCK_DIR, 'pid'), 'utf8')); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; }
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(home, LOCK_DIR, 'mode'), 'utf8')); } catch { /* 옛 잠금 */ }
  const mode = info.mode === 'mail' && typeof info.to === 'string' ? 'mail' : info.mode === 'stdout' ? 'stdout' : 'unknown';
  return {pid, mode, ...(mode === 'mail' ? {to: info.to} : {})};
}

// 받기 프로세스 하나만: mkdir 잠금 + pid. 주인이 죽었으면(ESRCH) 치우고 한 번 더 얻는다. 같은 상태 파일을 두 곳이 쓰면 중복 줄이 나온다.
export function acquireWatchLock(home, info = {mode: 'stdout'}) {
  const lock = path.join(home, LOCK_DIR), pidFile = path.join(lock, 'pid'), modeFile = path.join(lock, 'mode');
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  for (let tries = 0; tries < 2; tries++) {
    try { fs.mkdirSync(lock); fs.writeFileSync(modeFile, JSON.stringify(info)); fs.writeFileSync(pidFile, String(process.pid)); break; } catch (error) { // 모드를 pid보다 먼저 쓴다: pid가 보이면 모드도 있다
      if (error.code !== 'EEXIST') throw error;
      let pid = NaN;
      try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { /* pid 파일이 아직 없음 */ }
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
      if (alive || tries === 1) throw new Error('이미 다른 kadan discord watch가 돌고 있다(같은 상태 파일을 둘이 쓰면 중복 줄이 나온다)');
      fs.rmSync(pidFile, {force: true}); fs.rmSync(modeFile, {force: true}); fs.rmdirSync(lock);
    }
  }
  const release = () => { try { fs.rmSync(pidFile, {force: true}); fs.rmSync(modeFile, {force: true}); fs.rmdirSync(lock); } catch { /* 이미 없음 */ } };
  process.once('exit', release); // 강제 종료 경로(process.exit)에서도 잠금을 돌려준다
  return () => { process.removeListener('exit', release); release(); };
}

// ---------- 메시지 분류 ----------
// 반환: {skip:'system'|'bot'|'other'|'handled'} 또는 {line}. 줄 모양(고정): id, channelId, threadId|null, where, at, content, quoted (+선택 필드)
export function classifyMessage(msg, {userId, where, threadId = null}) {
  if (msg.type !== 0 && msg.type !== 19) return {skip: 'system'};     // 일반·답장만. 스레드 생성·시작 글 같은 시스템 글은 제외
  if (msg.author?.bot) return {skip: 'bot'};
  if (msg.author?.id !== userId) return {skip: 'other'};
  if (msg.reactions?.some(r => r.me && r.emoji?.name === READ_EMOJI)) return {skip: 'handled'};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const snapshots = Array.isArray(msg.message_snapshots) ? msg.message_snapshots : [];
  const quoted = Boolean(msg.message_reference) || snapshots.length > 0;
  const line = {id: msg.id, channelId: msg.channel_id, threadId, where, at: msg.timestamp ?? null, content, quoted};
  if (quoted) {
    line.quotedKind = snapshots.length ? 'forward' : 'reply';
    const ref = msg.referenced_message;
    line.quotedAuthor = snapshots.length ? 'unknown' : !ref ? 'unknown' : ref.author?.id === userId ? 'self' : 'other';
    const text = snapshots.length ? snapshots.map(s => s?.message?.content ?? '').join('\n') : ref?.content ?? '';
    if (text) line.quotedContent = text.slice(0, 500);
  }
  // 판단 보조: 본문 안에 인용 줄(>)이나 코드 블록이 있으면 붙여넣은 남의 글일 수 있다. 지시 여부는 비서가 정한다.
  if (/^\s*>/m.test(content) || content.includes('```')) line.containsQuote = true;
  const attachments = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
  if (attachments) line.attachments = attachments;
  // 본문이 비면 Message Content Intent가 꺼진 것일 수 있다(첨부·임베드·전달·답장 없이 빈 글).
  if (!content && !attachments && !snapshots.length && !(msg.embeds?.length)) line.empty = true;
  return {line};
}

const sortById = list => [...list].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));

async function react(chat, channelId, messageId) {
  try { await chat.api('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(READ_EMOJI)}/@me`, undefined, {budgetMs: 8000}); return true; }
  catch { return false; } // 읽음 반응 실패는 출력을 막지 않는다
}

// 한 번 조회(한 바퀴). 새 줄을 out(line)으로 낸다. 반환: {emitted, skipped, reactFailed, empty}
export async function pollOnce(chat, state, {out, err = () => {}, initial, signal}) {
  const {userId} = chat.cfg, channelId = await chat.channelIdOf();
  const result = {emitted: 0, reactFailed: 0, empty: 0};
  const hide = text => scrubSecrets(text, [chat.cfg.token, ...chat.cfg.secrets]);
  const halted = () => signal?.aborted === true;
  // 출력 대기를 중단 신호로 끝낼 수 있게 한다. 신호가 이기면 그 줄은 출력된 것으로 보지 않는다(다음 실행에서 다시 나옴).
  const aborted = new Promise(resolve => { if (signal) { if (signal.aborted) resolve('aborted'); else signal.addEventListener('abort', () => resolve('aborted'), {once: true}); } });
  const emit = async line => (signal ? (await Promise.race([Promise.resolve(out(line)).then(() => 'sent'), aborted])) === 'sent' : (await out(line), true));
  const handle = async (messages, where, threadId) => {
    let last = null;
    for (const msg of sortById(messages)) {
      if (halted()) break; // 중단 신호 뒤에는 더 내지도 cursor를 올리지도 않는다
      const c = classifyMessage(msg, {userId, where, threadId});
      if (c.skip) { last = maxId(last, msg.id); if (c.skip !== 'handled') state.skipped[{system: 'system', bot: 'bots', other: 'others'}[c.skip]]++; continue; }
      c.line.content = hide(c.line.content);
      if (c.line.quotedContent) c.line.quotedContent = hide(c.line.quotedContent);
      // 출력이 실제로 나간 뒤(쓰기 완료·역압)에 cursor를 저장하고 그다음 반응을 단다(최소 한 번).
      if (!(await emit(c.line)) || halted()) break; // 출력이 안 끝났거나 끝난 뒤 중단됐으면 cursor를 올리지 않는다
      last = maxId(last, msg.id);
      if (threadId) state.threads[threadId] = msg.id; else state.main = msg.id;
      writeState(chat.home, state);
      result.emitted++;
      if (c.line.empty) { result.empty++; err('본문이 빈 메시지를 받았다 — 봇의 Message Content Intent가 꺼져 있을 수 있다(kadan discord check)'); }
      if (halted()) break;
      if (!(await react(chat, msg.channel_id ?? threadId ?? channelId, msg.id))) result.reactFailed++;
    }
    return last;
  };
  // 한 곳의 새 메시지를 100개씩 끝까지 읽는다.
  const drain = async (source, after, where, threadId) => {
    let cursor = after;
    for (;;) {
      const r = await chat.api('GET', `/channels/${source}/messages?limit=100&after=${cursor}`);
      const list = Array.isArray(r.json) ? r.json : [];
      const last = await handle(list, where, threadId);
      if (last) {
        cursor = maxId(cursor, last);
        if (threadId) state.threads[threadId] = maxId(state.threads[threadId], cursor); else state.main = maxId(state.main, cursor);
        writeState(chat.home, state);
      }
      if (list.length < 100 || halted()) return;
    }
  };

  let active = null;
  const loadActive = async () => {
    const info = await chat.channelInfo();
    return active ??= info.guild_id ? (await chat.api('GET', `/guilds/${info.guild_id}/threads/active`)).json?.threads ?? [] : [];
  };
  if (initial) {
    // 처음(상태 없음): 지금까지의 글은 기준선으로 삼고 내지 않는다. 아무것도 출력하기 전에 기준선(본문·스레드)을 먼저 저장한다 —
    // 안 그러면 첫 출력이 실패한 뒤 재시작이 방금 본 질문까지 기준선으로 삼아 건너뛴다.
    state.main = (await chat.channelInfo()).last_message_id ?? '0';
    for (const t of await loadActive()) if (t.parent_id === channelId && THREAD_TYPES.has(t.type) && isId(t.id)) state.threads[t.id] = t.last_message_id ?? t.id;
    writeState(chat.home, state);
  }
  await drain(channelId, state.main ?? '0', 'channel', null);

  if (halted()) return result;
  const activeList = await loadActive();
  const now = (chat.now ?? Date.now)();
  for (const t of activeList) {
    if (halted()) return result;
    if (t.parent_id !== channelId || !THREAD_TYPES.has(t.type) || !isId(t.id)) continue;
    if (!state.threads[t.id]) {
      // 모르는 스레드: 처음 실행이면 기준선, 아니면 "처음 본 스레드"라서 첫 글부터 읽는다.
      // (스레드 ID는 시작 글의 ID라서 ID 나이로 새 스레드인지 판단하면 오래된 글에서 연 새 스레드의 첫 질문을 잃는다.)
      state.threads[t.id] = t.id;
      writeState(chat.home, state);
    }
    if (t.last_message_id && !idLess(state.threads[t.id], t.last_message_id)) continue;
    await drain(t.id, state.threads[t.id], 'thread', t.id);
  }
  // 활성 목록에 없고 마지막으로 본 글이 180일보다 오래된 스레드 기록은 잊는다(다시 살아나면 첫 글부터 다시 본다).
  const activeIds = new Set(activeList.map(t => t.id));
  for (const [id, lastSeen] of Object.entries(state.threads)) if (!activeIds.has(id) && now - idMs(lastSeen) > THREAD_FORGET_MS) delete state.threads[id];
  return result;
}

// 반복 조회. 같은 지점 3회 소진(exhausted)·4xx·설정 오류는 멈추고 던진다. 반환은 종료 사유.
export async function runWatch(chat, {once = false, intervalS = DEFAULT_INTERVAL_S, out, err = () => {}, signal, sleep, lockInfo}) {
  const hash = channelHash(await chat.channelIdOf());
  const release = acquireWatchLock(chat.home, lockInfo);
  const wait = sleep ?? (ms => new Promise(resolve => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, {once: true}); }));
  try {
    let state = readState(chat.home, hash), initial = false; // 깨진 상태 파일이면 여기서 던진다(복구는 문서 참고)
    if (state?.mismatch) err('#비서 채널이 이전과 달라 새 기준선부터 시작한다');
    if (!state || state.mismatch) { state = emptyState(hash); initial = true; }
    for (;;) {
      await pollOnce(chat, state, {out, err, initial, signal});
      initial = false;
      writeState(chat.home, state);
      if (once || signal?.aborted) break;
      await wait(intervalS * 1000);
      if (signal?.aborted) break;
    }
    err(`건너뜀(누적) — 다른 사람 ${state.skipped.others}건, 봇 ${state.skipped.bots}건, 시스템 ${state.skipped.system}건`);
    return 'done';
  } finally { release(); }
}

// ---------- 보내기 ----------
// 대상이 #비서 채널의 스레드인지 확인한다. 다른 채널로 새는 것을 막는다.
async function assertSecretaryThread(chat, id) {
  if (!isId(id)) throw new Error('스레드 ID는 숫자여야 한다');
  const info = (await chat.api('GET', `/channels/${id}`)).json;
  if (!THREAD_TYPES.has(info?.type) || info.parent_id !== await chat.channelIdOf()) throw new Error('#비서 채널의 스레드가 아니다');
  return info;
}

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// 새 주제(채널 본문의 메시지)에서 스레드를 연다. 이미 있으면(스레드 ID = 그 메시지 ID) 그대로 쓴다. 반환: 스레드 ID
export async function openThread(chat, messageId, name) {
  if (!isId(messageId)) throw new Error('메시지 ID는 숫자여야 한다');
  const channelId = await chat.channelIdOf();
  let title = oneLine(name, 100);
  if (!title) {
    const msg = (await chat.api('GET', `/channels/${channelId}/messages/${messageId}`)).json;
    title = oneLine(msg?.content, 50) || '비서 대화';
  }
  try {
    const r = await chat.api('POST', `/channels/${channelId}/messages/${messageId}/threads`, {name: title, auto_archive_duration: 1440});
    return isId(r.json?.id) ? r.json.id : messageId;
  } catch (error) {
    if (error.status === 400 && error.code === 160004) return messageId; // 이 메시지에는 이미 스레드가 있다
    throw error;
  }
}

// 반환: [{id, channelId, part, parts}] (고친 경우 part 1/1). 2,000자 넘는 새 글은 나눠 순서대로, 하나 실패하면 거기서 멈춘다.
// 울림: 새 글은 기본으로 kyle을 멘션해 휴대폰이 울린다(나눌 때는 첫 조각만). quiet면 멘션 없이 flags 4096으로 조용히 올린다.
// 고치기(PATCH)는 디스코드가 푸시를 보내지 않으므로 멘션·flags 없이 고친다 — 최종 답은 고치기가 아니라 새 글로 올려야 울린다.
export async function sendText(chat, text, {thread, replyTo, edit, threadName, quiet = false} = {}) {
  const body = String(text ?? '');
  if (!body.trim()) throw new Error('보낼 글이 비었다');
  if (thread && replyTo) throw new Error('--thread와 --reply-to는 함께 쓰지 않는다');
  let target;
  if (replyTo) {
    if (edit) throw new Error('--edit는 --reply-to와 함께 쓰지 않는다(고칠 글이 있는 --thread를 준다)');
    target = await openThread(chat, replyTo, threadName);
  } else if (thread) { await assertSecretaryThread(chat, thread); target = thread; }
  else target = await chat.channelIdOf();
  if (edit) {
    if (!isId(edit)) throw new Error('메시지 ID는 숫자여야 한다');
    if (body.length > DISCORD_LIMIT) throw new Error(`고치는 글은 ${DISCORD_LIMIT}자를 넘을 수 없다(${body.length}자)`);
    const r = await chat.api('PATCH', `/channels/${target}/messages/${edit}`, {content: body, allowed_mentions: NO_MENTION});
    return [{id: r.json?.id ?? edit, channelId: target, part: 1, parts: 1}];
  }
  const {userId} = chat.cfg, ring = `<@${userId}> `;
  // 멘션이 첫 조각 앞에 붙어도 2,000자를 넘지 않게, 울릴 때는 모든 조각을 그만큼 짧게 나눈다(조각 길이 차이는 한 줄 이내).
  const parts = splitDiscord(body, quiet ? DISCORD_LIMIT : DISCORD_LIMIT - ring.length);
  const sent = [];
  for (const [i, text] of parts.entries()) {
    const rings = !quiet && i === 0;
    const payload = rings ? {content: ring + text, allowed_mentions: {users: [userId]}}
      : {content: text, allowed_mentions: NO_MENTION, flags: SUPPRESS_NOTIFICATIONS};
    try {
      const r = await chat.api('POST', `/channels/${target}/messages`, payload);
      sent.push({id: r.json?.id ?? null, channelId: target, part: i + 1, parts: parts.length});
    } catch (error) {
      error.sent = sent; // 호출 쪽이 어디까지 올라갔는지 보여 준다
      throw error;
    }
  }
  return sent;
}

// 스레드 이름 바꾸기·보관(필요한 최소만).
export async function editThread(chat, id, {rename, archive}) {
  await assertSecretaryThread(chat, id);
  const body = {...(rename ? {name: oneLine(rename, 100)} : {}), ...(archive ? {archived: true} : {})};
  if (!Object.keys(body).length) throw new Error('--rename 또는 --archive 중 하나가 필요하다');
  await chat.api('PATCH', `/channels/${id}`, body);
  return body;
}

// 점검: 토큰·채널·권한·Message Content Intent. 값(ID)은 출력하지 않고 결과만 준다.
export async function checkChat(chat) {
  const lines = [];
  const step = async (label, fn) => { try { lines.push(`${label}: ${await fn()}`); } catch (error) { lines.push(`${label}: 실패 — ${error.message}`); } };
  await step('봇 로그인', async () => { await chat.api('GET', '/users/@me'); return '정상'; });
  await step('#비서 채널 ID', async () => { await chat.channelIdOf(); return `확인됨(얻은 방법: ${chat.channelVia === 'key' ? '설정 키' : '웹훅 조회'})`; });
  await step('채널 읽기', async () => { const info = await chat.channelInfo(); return info.guild_id ? '정상(서버 채널)' : '정상'; });
  await step('Message Content Intent', async () => {
    const app = (await chat.api('GET', '/applications/@me')).json;
    const on = Number(app?.flags ?? 0), full = (on & (1 << 18)) !== 0, limited = (on & (1 << 19)) !== 0;
    return full || limited ? `켜져 있음(${full ? '승인됨' : '제한(100서버 미만) 켜짐'})` : '꺼져 있음 — 개발자 화면에서 켜야 kyle의 글 본문을 받는다(kyle이 켠다)';
  });
  return lines;
}
