// 사용자(@user) 알림의 단일 통로. 다섯 호출 지점(감시 전달·겹알림·watch send·인계·사용자 우편)과 결정 알림이 모두 여기를 지난다.
// 디스코드 설정이 있으면 디스코드로 보내고, 설정 없음·전송 실패·불확실이면 맥 시스템 알림(osascript)으로 내려간다.
// 호출하는 쪽이 모두 동기라서 동기 API를 유지한다: 디스코드 전송은 자식 프로세스(discord-send.mjs)를 spawnSync로 띄워
// 강제 시간 제한을 건다. 한 알림 전체(잠금 대기·재시도·새 글·상태 기록)는 공통 종료 시각 12초 안에서 끝나고,
// 자식 강제 종료 여유 2초를 더한 약 14초가 상한이다. 시스템 알림은 따로 3초 제한이다.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ledgerHome} from './ledger.mjs';
import {effectiveNotifyEnvFile, readDiscordSecrets} from './notify-setting.mjs';
import {setThread, setArchived, setDecision, readDecisions, readThreads, withThreadLock} from './notify-threads.mjs';
import {setArchivedSync, botSecrets} from './thread-archive.mjs';
import {WorkStore} from './work-store.mjs';
import {buildWorkStatus} from './work-status-message.mjs';

export const DISCORD_LIMIT = 2000;
export const SUPPRESS_NOTIFICATIONS = 4096;
export const NOTIFY_LOG_FILE = 'notify-log.jsonl';
const SENDER = new URL('./discord-send.mjs', import.meta.url).pathname;
// 경보는 같은 id가 해소됐다가 다시 뜰 수 있어 짧은 창 안에서만 중복으로 본다. 결정·우편 id는 한 번뿐이라 창이 없다.
export const ALERT_DEDUP_WINDOW_MS = 10 * 60 * 1000;
export const TOTAL_BUDGET_MS = 12000; // 한 알림 전체의 공통 예산
const MIN_SEND_MS = 1500;             // 이보다 적게 남으면 더 기다리거나 보내지 않는다
const SYSTEM_TIMEOUT_MS = 3000;
// 시험 전용: 부하 속에서도 가짜 osascript가 끝나길 기다릴 수 있게 환경변수로만 늘린다. 운영에서는 설정하지 않는다.
// 정수 1000~120000만 받고 그 밖의 값(빈 값·문자·0·음수·소수·Infinity·너무 큰 값)은 기본 3초다 — spawnSync가 범위 밖 timeout에 던지지 않게.
export function systemTimeoutMs(env = process.env) {
  const raw = env.KADAN_TEST_SYSTEM_NOTIFY_TIMEOUT_MS;
  return typeof raw === 'string' && /^\d+$/.test(raw) && Number(raw) >= 1000 && Number(raw) <= 120000 ? Number(raw) : SYSTEM_TIMEOUT_MS;
}
// 연결 실패·시간 초과·429/5xx 소진으로 끝나면 이 시간 동안 같은 프로세스의 다음 알림은 디스코드를 건너뛰고 바로 시스템 알림으로 간다.
// 근거: 장애 때 알림 한 건이 최대 12초를 막아 경보 두 건인 감시 주기가 24초 걸렸다(1라운드 검수). 60초면 감시 주기(기본 수 초~수십 초)
// 당 한 번만 기다리고, 디스코드가 되살아나면 1분 안에 돌아온다. 4xx(설정·요청 문제)는 장애가 아니라서 막지 않는다.
export const DISCORD_BLOCK_MS = 60000;
let blockedUntil = 0;
export const resetDiscordBlock = () => { blockedUntil = 0; };

function workTitleOf(home, work) {
  if (!work) return '';
  try { return new WorkStore(home).get(work).title ?? ''; } catch { return ''; }
}

export function systemNotify(message, spawn) {
  const script = `display notification ${JSON.stringify(message)} with title "kadan watch"`;
  const result = spawn('osascript', ['-e', script], {encoding: 'utf8', timeout: systemTimeoutMs()});
  // 성공은 종료 코드 0이면서 오류·신호가 없을 때만이다. 시간 초과(spawnSync는 status:null, error.code:ETIMEDOUT, signal:SIGTERM)는
  // stderr가 비어 있어도 실패다 — 빈 문자열을 돌려주면 호출 쪽의 `if (errorText)`가 성공으로 읽는다(3라운드 검수 R4).
  // 사유에는 명령 원문과 stderr(알림 문구가 섞일 수 있다)를 싣지 않고 짧은 분류만 담는다.
  if (result.status === 0 && !result.error && !result.signal) return null;
  if (result.error?.code === 'ETIMEDOUT' || result.signal) return '시스템 알림 시간 초과';
  if (result.error) return `시스템 알림 실패(${result.error.code ?? '오류'})`;
  return `시스템 알림 실패(종료 코드 ${result.status ?? '없음'})`;
}

// 원장·콘솔·화면에 가기 전에 웹훅 주소와 사용자 ID를 가린다. 오류 원문에 섞여 들어올 수 있다.
export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? '').replace(/https?:\/\/[^\s"'<>]*\/api\/webhooks\/[^\s"'<>]*/gi, '[주소 가림]');
  for (const s of secrets) if (s) out = out.split(s).join('[가림]');
  return out;
}

// 디스코드 본문 2,000자 제한. 끝(예: 링크)이 중요하면 tail로 남기고 앞을 줄인다.
export function fitDiscord(head, tail = '') {
  const t = tail ? `\n${tail}` : '';
  if (head.length + t.length <= DISCORD_LIMIT) return head + t;
  return head.slice(0, Math.max(0, DISCORD_LIMIT - t.length - 1)) + '…' + t;
}

function logPath(home) { return path.join(home, NOTIFY_LOG_FILE); }

function readLog(home) {
  try {
    return fs.readFileSync(logPath(home), 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// 주소·ID·본문은 적지 않는다. 키·길·결과·사유 코드만 남긴다.
function appendLog(home, entry) {
  try {
    fs.mkdirSync(home, {recursive: true, mode: 0o700});
    fs.appendFileSync(logPath(home), JSON.stringify(entry) + '\n', {mode: 0o600});
  } catch { /* 기록 실패가 알림을 막지 않는다 */ }
}

function alreadySent(home, key, windowMs, nowMs) {
  return readLog(home).some(e => e.key === key && e.via === 'discord' && (e.outcome === 'sent' || e.outcome === 'uncertain')
    && (!windowMs || nowMs - Date.parse(e.at) < windowMs));
}

// 디스코드 웹훅 요청이 나가는 유일한 함수.
//   threadName: 포럼 채널에 새 글을 만든다(100자 안). threadId: 기존 글에 이어 붙인다. wait: 응답의 messageId·channelId를 받는다
//   (포럼 새 글이면 channelId가 새 글 id). messageId: 그 메시지를 새로 올리지 않고 고친다(PATCH, threadId와 함께).
//   울림 기준: allowedMentions.users가 있는 요청(사용자를 멘션하는 결정 요청·경보)만 알림이 울린다. 나머지는 모두
//   flags 4096(SUPPRESS_NOTIFICATIONS)을 붙여 글은 남기고 휴대폰은 울리지 않는다 — 기본값이 조용히라서 새 알림 종류도 조용하다.
//   고치기(PATCH)는 새 알림이 아니므로 flags를 붙이지 않는다.
// 반환: {outcome, attempts, status, reason, messageId?, channelId?}
export function postDiscordWebhook({webhook, content, allowedMentions, threadName, threadId, wait = false, messageId, budgetMs}) {
  const rings = !messageId && allowedMentions?.users?.length > 0;
  const payload = {content, allowed_mentions: allowedMentions, ...(rings || messageId ? {} : {flags: SUPPRESS_NOTIFICATIONS}), ...(threadName ? {thread_name: String(threadName).slice(0, 100)} : {})};
  const child = spawnSync(process.execPath, [SENDER], {
    input: JSON.stringify({webhook, payload, threadId, messageId, wait: wait || Boolean(threadName), budgetMs}), encoding: 'utf8',
    timeout: (budgetMs ?? 12000) + 2000, maxBuffer: 1 << 16,
  });
  if (child.error || child.status !== 0) {
    // 강제 종료되면 요청이 나갔는지 알 수 없다.
    return {outcome: 'uncertain', attempts: null, reason: child.error?.code === 'ETIMEDOUT' ? '자식 프로세스 시간 초과' : '자식 프로세스 오류'};
  }
  try { return JSON.parse(child.stdout.trim().split('\n').at(-1)); } catch { return {outcome: 'uncertain', attempts: null, reason: '전송 결과 해석 실패'}; }
}

const budgetOut = () => ({outcome: 'failed', attempts: 0, reason: '시간 예산 소진'});

const is4xx = r => r.outcome === 'failed' && r.status >= 400 && r.status < 500 && r.status !== 429;
const outageOf = r => r.outcome === 'uncertain' || (r.outcome === 'failed' && r.attempts !== 0 && (r.status === undefined || r.status >= 500 || r.status === 429));
const noteOutage = r => { if (outageOf(r)) blockedUntil = Date.now() + DISCORD_BLOCK_MS; };

// ---------- 끝난 업무 글 보관·재개 ----------
// 웹훅은 보관을 못 해서 봇(thread-archive.mjs)이 한다. 보관된 글에 쓰면 디코가 다시 열어 주는지는 실측하지 못했다(실제 전송 금지) —
// 그래서 두 경우를 모두 처리한다: (1) 기록이 archived인 글에는 쓰기 전에 먼저 재개한다. (2) 기록이 없는데 웹훅이 '보관된 스레드' 오류를
// 내면(손으로 보관한 글) 재개한 뒤 한 번만 다시 시도한다. 재개가 막히면(403 등) 그 쓰기를 건너뛰고 기록에 사유만 남긴다.
export const ARCHIVED_THREAD_CODE = 50083; // 디스코드 JSON 오류 코드: 보관된 스레드에 쓰려 함
const isArchivedError = r => r.outcome === 'failed' && r.status === 400 && r.code === ARCHIVED_THREAD_CODE;

// 한 번의 잠금 안에서 쓰는 묶음. resumed: 이번 사건에서 이미 재개를 시도했는가(재개는 한 번만).
function workCtx({home, env, webhook, work, deadline, secrets}) {
  return {home, env, webhook, work, deadline, secrets, resumed: false, left: () => deadline - Date.now()};
}

// 글을 봇으로 다시 연다. 반환 {ok:true} 또는 {ok:false, result}.
//   404(글 없음)는 result를 그대로 돌려줘 호출 쪽의 '지워진 글' 경로가 이어받는다.
//   그 밖의 4xx·봇 설정 없음은 'archived-skip'(쓰기 건너뜀, 시스템 알림으로 대신하지 않음, blockedUntil 없음), 5xx·불확실은 실패 그대로.
function resumeThread(ctx, threadId) {
  ctx.resumed = true;
  const r = ctx.left() < MIN_SEND_MS ? budgetOut() : setArchivedSync({home: ctx.home, env: ctx.env, threadId, archived: false, budgetMs: ctx.left()});
  if (r.outcome === 'sent') { setArchived(ctx.home, ctx.work, false); return {ok: true}; }
  if (r.outcome === 'failed' && r.status === 404) return {ok: false, result: r};
  if (r.skip === true || is4xx(r))
    return {ok: false, result: {outcome: 'archived-skip', attempts: r.attempts ?? 0, status: r.status, reason: `보관된 글을 다시 열지 못해 쓰기를 건너뜀 — ${r.reason ?? '사유 없음'}`}};
  return {ok: false, result: r};
}
const resumeGone = o => !o.ok && o.result.outcome === 'failed' && o.result.status === 404;

// 웹훅 쓰기 하나를 하되, '보관된 스레드' 오류면 재개 → 한 번만 다시 시도한다.
function withResume(ctx, threadId, attempt) {
  const r = attempt();
  if (!isArchivedError(r) || ctx.resumed) return r;
  const o = resumeThread(ctx, threadId);
  return o.ok ? attempt() : o.result;
}

function logArchive(ctx, a) {
  appendLog(ctx.home, {at: new Date().toISOString(), key: null, kind: 'archive', work: ctx.work, via: 'discord', outcome: a.outcome,
    reason: scrubSecrets(a.reason ?? '', ctx.secrets) || undefined, attempts: a.attempts ?? undefined, status: a.status ?? undefined});
}

// 끝난(완료·취소) 업무의 글을 보관한다. 조건(모두): 상태 메시지 고치기가 sent, 결정 글 아님, 아직 보관 안 됨, 시간 예산 있음.
// 실패(403 등)는 사유만 기록하고 글은 보관 안 됨으로 둔다. 알림 결과는 바꾸지 않는다. 장애성 실패만 60초 차단에 센다.
function archiveIfEnded(ctx, status, r) {
  if (!status.ended || r.outcome !== 'sent' || ctx.work.endsWith('/__decisions__')) return null;
  const entry = readThreads(ctx.home)[ctx.work];
  if (!entry || entry.archived) return null;
  const a = ctx.left() < MIN_SEND_MS ? {outcome: 'skipped', attempts: 0, reason: '시간 예산이 모자라 보관을 건너뜀(다음 사건 때 다시 시도)'}
    : setArchivedSync({home: ctx.home, env: ctx.env, threadId: entry.threadId, archived: true, budgetMs: ctx.left()});
  if (a.outcome === 'sent') setArchived(ctx.home, ctx.work, true);
  noteOutage(a);
  logArchive(ctx, a);
  return a;
}

// 업무 글의 상태 메시지를 올리거나 고친 뒤(끝난 업무면) 글을 보관한다. 잠금 안에서 부른다.
// entry: 글 기록 {threadId, statusMessageId, archived}.
//   끝난 업무인데 이미 보관된 글이면 아무것도 안 한다(늦게 온 실행 done이 끝난 글을 다시 열지 않는다).
//   업무가 열려 있는데 보관된 글이면(reopen) 먼저 재개한다.
function syncWork(ctx, entry) {
  const status = buildWorkStatus(ctx.home, ctx.work);
  if (!status) return {outcome: 'none', attempts: 0};
  if (entry.archived) {
    if (status.ended) return {outcome: 'none', attempts: 0};
    const o = resumeThread(ctx, entry.threadId);
    if (!o.ok && !resumeGone(o)) return o.result;
  }
  const r = syncStatus(ctx, status, entry);
  const archive = archiveIfEnded(ctx, status, r);
  return archive ? {...r, archive} : r;
}

// 상태 메시지를 올리거나 고친다. 예산이 모자라면 버린다(상태는 다음 사건 때 다시 계산된다).
//   기록된 메시지가 있으면 고친다 → 404(지워짐)면 같은 글에 새 상태 메시지를 올리고 id를 바꾼다
//   → 글까지 404면 상태 메시지를 첫 글로 새 글을 만든다. 404 아닌 실패(400·403·5xx·불확실)는 더 시도하지 않고 버린다.
function syncStatus(ctx, status, {threadId, statusMessageId}) {
  const {home, webhook, work} = ctx;
  const raw = extra => ctx.left() < MIN_SEND_MS ? budgetOut()
    : postDiscordWebhook({webhook, content: status.content, allowedMentions: {parse: []}, budgetMs: ctx.left(), ...extra});
  const call = extra => (extra.threadId ? withResume(ctx, extra.threadId, () => raw(extra)) : raw(extra));
  const gone = r => r.outcome === 'failed' && r.status === 404;
  let r;
  if (statusMessageId) {
    r = call({threadId, messageId: statusMessageId});
    if (!gone(r)) return r;
  }
  r = call({threadId, wait: true});
  if (r.outcome === 'sent' && r.messageId) { setThread(home, work, {threadId, statusMessageId: r.messageId}); return r; }
  if (!gone(r)) return r;
  r = call({threadName: `${work} ${status.title}`.trim().slice(0, 100), wait: true});
  if (r.outcome === 'sent' && r.channelId) setThread(home, work, {threadId: r.channelId, statusMessageId: r.messageId ?? null});
  return r;
}

// 포럼 채널: 업무 키마다 글 하나(결정은 레포마다 '<레포>/__decisions__' 글 하나). 상태 읽기 → (새 글 만들기) → 상태 갱신을 한 잠금 안에서 한다.
// 기록된 글이 있으면 thread_id로 이어 붙이고, 그 글이 429 아닌 4xx로 거절되면(지워짐 등) thread_name으로 새 글을 한 번 만든다
// (같은 요청의 재시도가 아니라 다른 요청). 잠금을 종료 시각 안에 못 얻으면 보내지 않는다: 업무 글로 가야 할 내용을
// 기본 #브리핑에 섞지 않고, 상태 파일을 잠금 없이 건드리지 않으려고 시스템 알림으로 내려간다(잘못된 채널로 새지 않는 쪽).
// 알림이 나간 뒤에는 같은 잠금 안에서 상태 메시지도 맞춘다(결과는 statusSync에 따로 담고 알림 결과를 바꾸지 않는다).
// decision: {id, edit?}. 요청이면 메시지 id를 남기고(wait), 해결(edit 본문 있음)이면 남긴 메시지를 고친다 — 못 찾을 때(기록 없음·404)만 새 메시지.
function sendForum({home, env, webhook, work, threadName, content, allowedMentions, deadline, decision, secrets}) {
  const left = () => deadline - Date.now();
  const ctx = workCtx({home, env, webhook, work, deadline, secrets});
  const lock = withThreadLock(home, deadline - MIN_SEND_MS, threads => {
    const plan = planDecision(home, decision, content, allowedMentions);
    if (plan.skip) return plan.skip;
    const post = extra => left() < MIN_SEND_MS ? budgetOut() : postDiscordWebhook({webhook, content: plan.content, allowedMentions: plan.allowedMentions, budgetMs: left(), ...extra});
    if (decision?.edit) {
      const done = editDecision({home, decision, post, forum: true});
      if (done) {
        // 메시지를 고쳤어도 그 업무 글의 상태 메시지는 기준대로 맞춘다(결정 전용 글은 업무가 아니라 'none').
        const known = threads[work];
        return done.outcome === 'sent' && known ? {...done, statusSync: syncWork(ctx, known)} : done;
      }
    }
    let known = threads[work];
    const wait = Boolean(decision);
    let r, entry = null;
    if (known?.archived) {                       // 보관된 글에는 쓰기 전에 먼저 다시 연다(재개가 막히면 이 쓰기를 건너뛴다)
      const o = resumeThread(ctx, known.threadId);
      if (o.ok) known = {...known, archived: false};
      else if (resumeGone(o)) known = null;
      else return o.result;
    }
    if (known) {
      r = withResume(ctx, known.threadId, () => post({threadId: known.threadId, wait}));
      if (r.outcome === 'sent') entry = known;
    }
    if (!entry && !(r && (!is4xx(r) || isArchivedError(r)))) {
      r = post({threadName, wait: true});
      if (r.outcome === 'sent' && r.channelId) { entry = {threadId: r.channelId, statusMessageId: null}; setThread(home, work, entry); }
    }
    if (entry && wait && r.messageId) setDecision(home, decision.id, {threadId: entry.threadId, messageId: r.messageId, forum: true, resolved: plan.resolved});
    if (entry) r = {...r, statusSync: syncWork(ctx, entry)};
    return noteRead(r, plan);
  });
  return lock.locked ? lock.value : {outcome: 'lock-timeout', attempts: 0, reason: '포럼 상태 잠금을 시간 안에 못 얻음'};
}

// 기본 #브리핑 채널로 가는 결정 알림: 요청의 메시지 id를 남기고 해결 때 고친다(포럼과 같은 잠금·규칙).
function sendDefaultDecision({home, webhook, content, allowedMentions, deadline, decision}) {
  const left = () => deadline - Date.now();
  const lock = withThreadLock(home, deadline - MIN_SEND_MS, () => {
    const plan = planDecision(home, decision, content, allowedMentions);
    if (plan.skip) return plan.skip;
    const post = extra => left() < MIN_SEND_MS ? budgetOut() : postDiscordWebhook({webhook, content: plan.content, allowedMentions: plan.allowedMentions, budgetMs: left(), ...extra});
    if (decision.edit) {
      const done = editDecision({home, decision, post, forum: false});
      if (done) return done;
    }
    const r = post({wait: true});
    if (r.outcome === 'sent' && r.messageId) setDecision(home, decision.id, {threadId: null, messageId: r.messageId, forum: false, resolved: plan.resolved});
    return noteRead(r, plan);
  });
  return lock.locked ? lock.value : {outcome: 'lock-timeout', attempts: 0, reason: '알림 상태 잠금을 시간 안에 못 얻음'};
}

// 잠금 안에서 보내기 직전에 결정의 현재 상태를 다시 읽는다(요청 알림이 취소·답변보다 늦게 잠금을 잡는 경합).
// 해결 기록은 한 방향이다: 기록에 resolved가 있으면 읽기 성공·실패와 관계없이 열린 요청을 보내지 않고 기록을 덮지 않는다(resolved-skip).
// 기록이 없고 이미 해결된 걸 읽었으면 해결 모양(멘션 없음)으로 보낸다. 기록이 없고 읽기가 실패하면 요청을 버리지 않고 그대로 보내되
// readFailed로 표시해 결과 사유에 '최신 상태 확인 실패'를 남긴다(요청 유실이 오래된 요청 한 줄보다 나쁘다).
// 돌려주는 값: {content, allowedMentions, resolved(기록에 남길 '해결 메시지' 표시), readFailed?, skip?}
function planDecision(home, decision, content, allowedMentions) {
  const plan = {content, allowedMentions, resolved: Boolean(decision?.edit)};
  if (!decision || decision.edit) return plan;
  if (readDecisions(home)[decision.id]?.resolved) return {...plan, skip: {outcome: 'resolved-skip', attempts: 0, reason: '이미 해결 메시지를 보냄'}};
  if (typeof decision.latest !== 'function') return plan;
  let now = null;
  try { now = decision.latest(); } catch { return {...plan, readFailed: true}; }
  if (!now) return {...plan, readFailed: true};
  if (now.status === 'open') return plan;
  return {content: decision.resolvedContent(now), allowedMentions: {parse: []}, resolved: true};
}
const READ_FAILED = '최신 상태 확인 실패(요청 그대로 보냄)';
const noteRead = (r, plan) => (plan.readFailed ? {...r, readFailed: true} : r);

// 남긴 결정 요청 메시지를 고친다. 돌려주는 값: 결과(고침 성공, 또는 404 아닌 실패라 더 시도하지 않음) 또는 null(못 찾음 → 호출 쪽이 새 메시지).
// 기록이 없거나, 기록한 길(포럼/기본)이 지금 길과 다르거나, 수정이 404(지워짐·다른 웹훅)면 못 찾은 것이다.
function editDecision({home, decision, post, forum}) {
  const known = readDecisions(home)[decision.id];
  if (!known || known.forum !== forum) return null;
  const r = post({threadId: known.threadId ?? undefined, messageId: known.messageId, content: decision.edit, allowedMentions: {parse: []}});
  if (r.outcome === 'failed' && r.status === 404) return null;
  if (r.outcome === 'sent') setDecision(home, decision.id, {...known, resolved: true});
  return r;
}

// 사건 지점(업무 알림·work 변경·실행 done)에서 부르는 함수 하나: 그 업무 글의 상태 메시지를 현재 업무 기록으로 맞춘다.
// 글이 아직 없으면(알림이 한 번도 안 나간 업무) 아무것도 안 한다 — 글은 알림이 만든다. 디코 설정 없음·레포 웹훅 없음·
// KADAN_NOTIFY=off·장애 직후 60초면 요청 0건. 실패해도 시스템 알림으로 대신하지 않고 버린다. 반환은 시험·기록용.
export function refreshWorkStatus(home, work, opts = {}) {
  const env = opts.env ?? process.env;
  if (env.KADAN_NOTIFY === 'off' || typeof work !== 'string' || !work.includes('/')) return {outcome: 'off'};
  let secrets = [];
  try {
    const cfg = effectiveNotifyEnvFile(env, home);
    if (cfg.error || !cfg.envFile) return {outcome: 'none'};
    const sec = readDiscordSecrets(cfg.envFile, {repo: work.split('/')[0]});
    if (sec.error || !sec.repoWebhook) return {outcome: 'none'};
    secrets = [sec.webhook, sec.repoWebhook, sec.userId, ...botSecrets(home, env)];
    if (Date.now() < blockedUntil) return {outcome: 'skipped', reason: '디스코드 장애 직후라 건너뜀(60초)'};
    const deadline = Date.now() + (opts.totalMs ?? TOTAL_BUDGET_MS);
    const ctx = workCtx({home, env, webhook: sec.repoWebhook, work, deadline, secrets});
    const lock = withThreadLock(home, deadline - MIN_SEND_MS, threads =>
      threads[work] ? syncWork(ctx, threads[work]) : {outcome: 'none', attempts: 0});
    const r = lock.locked ? lock.value : {outcome: 'lock-timeout', attempts: 0, reason: '포럼 상태 잠금을 시간 안에 못 얻음'};
    noteOutage(r);
    if (r.outcome !== 'none') logStatus(home, work, r, secrets);
    return {outcome: r.outcome, status: r.status ?? null};
  } catch (error) {
    return {outcome: 'config-error', reason: scrubSecrets(error.message, secrets)};
  }
}

function logStatus(home, work, r, secrets) {
  appendLog(home, {at: new Date().toISOString(), key: null, kind: 'status', work, via: 'discord', outcome: r.outcome,
    reason: scrubSecrets(r.reason ?? '', secrets) || undefined, attempts: r.attempts ?? undefined, status: r.status ?? undefined});
}

// 레포별 웹훅이 있고 글 키(업무 키, 없으면 결정의 레포 '결정' 글 키)가 있으면 포럼 글로, 아니면 기본 웹훅으로 보낸다.
function route({sec, key}) {
  return sec.repoWebhook && key ? {forum: true, webhook: sec.repoWebhook} : {forum: false, webhook: sec.webhook};
}

// 디코를 거치지 않은 경로(설정 없음·설정 오류)에서 최신 상태 읽기 실패를 로그에 남기려고 같은 판단(해결 기록 확인 → 읽기)을 한 번 더 한다.
function decisionReadFailed(home, decision) {
  if (!decision || decision.edit || typeof decision.latest !== 'function') return false;
  try { if (home && readDecisions(home)[decision.id]?.resolved) return false; } catch { /* 아래에서 읽기 */ }
  try { return !decision.latest(); } catch { return true; }
}

function decisionSystemMessage(home, decision, message) {
  if (!decision || decision.edit || typeof decision.latest !== 'function') return message;
  try { if (home && readDecisions(home)[decision.id]?.resolved) return null; } catch { /* 기록을 못 읽으면 아래 판단으로 */ }
  try {
    const now = decision.latest();
    return now && now.status !== 'open' && decision.resolvedShort ? decision.resolvedShort(now) : message;
  } catch { return message; }
}

// message: 시스템 알림에 쓰는 짧은 문구. discord: {content, mention} 또는 (사용자ID)=>{content, mention}을 주면 디스코드에는 그 본문을 쓴다.
// opts: {systemFallback(false면 디코 실패 때 맥 알림으로 대신하지 않음), ring, kind, key, work, workTitle, repo, tagRepo, forumKey, forumTitle, decision, dedupWindowMs, home, env, discord}. work: 업무 키(없으면 기본 #브리핑),
//   repo: 생략하면 업무 키의 저장소 앞부분. 레포 웹훅(DISCORD_WEBHOOK_URL_<레포>)이 있고 업무 키(또는 forumKey)가 있을 때만 포럼 글로 간다.
//   tagRepo: 알림 첫머리 `[레포]`에 쓸 이름(생략하면 repo, 그것도 모르면 표시하지 않는다 — 추측 금지). discord 본문을 직접 주면 그쪽이 표시를 책임진다.
//   forumKey·forumTitle: 업무가 없을 때 쓰는 포럼 글 키와 글 제목(결정의 레포 '결정' 글). decision: {id, edit?, latest?, resolvedContent?} — 요청은 메시지 id를 남기고(보내기 직전 latest()로 현재 상태를 다시 읽어 이미 해결됐으면 resolvedContent로 대신 보내거나 건너뜀), edit 본문이 있으면 남긴 메시지를 고친다.
// 반환: {via:'discord'|'system', error, duplicate?, discord:{outcome,reason}|null}
//   error는 호출 쪽이 쓰던 "시스템 알림 실패 문구"(성공이면 null)다. 디스코드 성공이면 항상 null.
export function notifyUser(message, spawn, opts = {}) {
  const env = opts.env ?? process.env;
  const deadline = Date.now() + (opts.totalMs ?? TOTAL_BUDGET_MS);
  const result = {via: 'system', error: null, discord: null};
  let home = null, secrets = [], warnings = [], readFailed = false, judged = false;
  const tagName = opts.tagRepo ?? opts.repo ?? (opts.work?.includes('/') ? opts.work.split('/')[0] : undefined);
  const tag = tagName ? `[${tagName}] ` : '';
  const tagged = text => (tag && !String(text).startsWith(tag) ? tag + text : text);
  message = tagged(message);
  if (env.KADAN_NOTIFY !== 'off') {
    try {
      home = opts.home ?? ledgerHome();
      const cfg = effectiveNotifyEnvFile(env, home);
      const repo = opts.repo ?? (opts.work?.includes('/') ? opts.work.split('/')[0] : undefined);
      if (cfg.error) result.discord = {outcome: 'config-error', reason: scrubSecrets(cfg.error)};
      else if (cfg.envFile) {
        const sec = readDiscordSecrets(cfg.envFile, {repo, checkDir: cfg.source === 'default'});
        if (sec.error) result.discord = {outcome: 'config-error', reason: scrubSecrets(sec.error)};
        else {
          secrets = [sec.webhook, sec.repoWebhook, sec.userId, ...botSecrets(home, env)];
          warnings = sec.warnings ?? [];
          const now = (opts.now ?? Date.now)();
          if (opts.key && alreadySent(home, opts.key, opts.dedupWindowMs, now))
            return {via: 'discord', error: null, duplicate: true, discord: {outcome: 'duplicate', reason: '같은 키로 이미 보냄'}};
          // opts.ring: 사용자에게 올라간 경보 — 결정 요청과 같은 방식으로 멘션을 붙여 울린다. 나머지는 조용히 보낸다.
          const d = (typeof opts.discord === 'function' ? opts.discord(sec.userId) : opts.discord)
            ?? (opts.ring === true ? {content: fitDiscord(`<@${sec.userId}> ${message}`), mention: true} : {content: fitDiscord(message), mention: false});
          const allowedMentions = d.mention === true ? {users: [sec.userId]} : {parse: []};
          const forumKey = opts.work ?? opts.forumKey;
          const to = route({sec, key: forumKey});
          const threadName = (opts.work ? `${opts.work} ${opts.workTitle ?? workTitleOf(home, opts.work)}`.trim() : opts.forumTitle ?? '').slice(0, 100);
          // 해결 알림(edit)은 원래 메시지를 고치므로 멘션이 없고, 못 찾을 때만 d.content(새 메시지)가 나간다.
          const decision = opts.decision ?? null;
          const sent = Date.now() < blockedUntil
            ? {outcome: 'skipped', attempts: 0, reason: '디스코드 장애 직후라 건너뜀(60초)'}
            : to.forum
              ? sendForum({home, env, webhook: to.webhook, work: forumKey, threadName, content: d.content, allowedMentions, deadline, decision, secrets})
              : decision
                ? sendDefaultDecision({home, webhook: to.webhook, content: d.content, allowedMentions, deadline, decision})
                : postDiscordWebhook({webhook: to.webhook, content: d.content, allowedMentions, budgetMs: Math.max(MIN_SEND_MS, deadline - Date.now())});
          judged = true; readFailed = sent.readFailed === true;
          noteOutage(sent);
          if (sent.statusSync) { noteOutage(sent.statusSync); if (sent.statusSync.outcome !== 'none') logStatus(home, opts.work, sent.statusSync, secrets); }
          result.discord = {outcome: sent.outcome, reason: scrubSecrets(sent.reason ?? '', secrets), attempts: sent.attempts ?? null, status: sent.status ?? null};
          if (warnings.length) result.discord.warning = warnings.join(' / ');
          if (sent.outcome === 'sent' || sent.outcome === 'resolved-skip') result.via = 'discord';
        }
      }
    } catch (error) {
      result.discord = {outcome: 'config-error', reason: scrubSecrets(error.message, secrets)};
    }
    if (home && !judged) readFailed = decisionReadFailed(home, opts.decision);
    if (home && (result.discord || readFailed)) {
      const reason = [result.discord?.reason, readFailed ? READ_FAILED : ''].filter(Boolean).join(' / ');
      appendLog(home, {at: new Date((opts.now ?? Date.now)()).toISOString(), key: opts.key ?? null, kind: opts.kind ?? null, work: opts.work ?? undefined,
        via: result.discord ? 'discord' : 'system', outcome: result.discord?.outcome ?? 'no-discord', reason: reason || undefined, attempts: result.discord?.attempts ?? undefined, status: result.discord?.status ?? undefined, warning: result.discord?.warning});
    }
  }
  if (result.via === 'discord') return result;
  // 보관된 글을 다시 열지 못해 쓰기를 건너뛴 경우: 잘못된 채널(#브리핑·시스템 알림)로 새지 않게 대신 보내지 않는다. 사유는 notify-log에 있다.
  if (result.discord?.outcome === 'archived-skip') return {...result, via: 'none', error: null};
  // opts.systemFallback === false: 디코로 못 보내면 맥 시스템 알림으로 대신하지 않는다(조용한 알림 전용 — 놓쳐도 되는 알림이 맥을 울리지 않게).
  if (opts.systemFallback === false) return {...result, via: 'none', error: null};
  // 시스템 알림도 같은 판단이다: 이미 해결 메시지를 보낸 결정의 요청은 다시 띄우지 않고, 해결됐다고 읽히면 해결 문구로 바꾼다.
  const sysMessage = decisionSystemMessage(home, opts.decision, message);
  if (sysMessage === null) return {...result, via: 'discord', discord: result.discord ?? {outcome: 'resolved-skip', reason: '이미 해결됨'}};
  result.error = systemNotify(tagged(sysMessage), spawn);
  return result;
}
