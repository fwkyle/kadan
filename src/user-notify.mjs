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
import {setThread, withThreadLock} from './notify-threads.mjs';
import {WorkStore} from './work-store.mjs';

export const DISCORD_LIMIT = 2000;
export const NOTIFY_LOG_FILE = 'notify-log.jsonl';
const SENDER = new URL('./discord-send.mjs', import.meta.url).pathname;
// 경보는 같은 id가 해소됐다가 다시 뜰 수 있어 짧은 창 안에서만 중복으로 본다. 결정·우편 id는 한 번뿐이라 창이 없다.
export const ALERT_DEDUP_WINDOW_MS = 10 * 60 * 1000;
export const TOTAL_BUDGET_MS = 12000; // 한 알림 전체의 공통 예산
const MIN_SEND_MS = 1500;             // 이보다 적게 남으면 더 기다리거나 보내지 않는다
const SYSTEM_TIMEOUT_MS = 3000;
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
  const result = spawn('osascript', ['-e', script], {encoding: 'utf8', timeout: SYSTEM_TIMEOUT_MS});
  return result.status === 0 ? null : (result.stderr ?? 'osascript 실패').trim();
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
//   (포럼 새 글이면 channelId가 새 글 id). 메시지 수정(PATCH)은 아직 없다.
// 반환: {outcome, attempts, status, reason, messageId?, channelId?}
export function postDiscordWebhook({webhook, content, allowedMentions, threadName, threadId, wait = false, budgetMs}) {
  const payload = {content, allowed_mentions: allowedMentions, ...(threadName ? {thread_name: String(threadName).slice(0, 100)} : {})};
  const child = spawnSync(process.execPath, [SENDER], {
    input: JSON.stringify({webhook, payload, threadId, wait: wait || Boolean(threadName), budgetMs}), encoding: 'utf8',
    timeout: (budgetMs ?? 12000) + 2000, maxBuffer: 1 << 16,
  });
  if (child.error || child.status !== 0) {
    // 강제 종료되면 요청이 나갔는지 알 수 없다.
    return {outcome: 'uncertain', attempts: null, reason: child.error?.code === 'ETIMEDOUT' ? '자식 프로세스 시간 초과' : '자식 프로세스 오류'};
  }
  try { return JSON.parse(child.stdout.trim().split('\n').at(-1)); } catch { return {outcome: 'uncertain', attempts: null, reason: '전송 결과 해석 실패'}; }
}

const budgetOut = () => ({outcome: 'failed', attempts: 0, reason: '시간 예산 소진'});

// 포럼 채널: 업무 키마다 글 하나. 상태 읽기 → (새 글 만들기) → 상태 갱신을 한 잠금 안에서 한다.
// 기록된 글이 있으면 thread_id로 이어 붙이고, 그 글이 429 아닌 4xx로 거절되면(지워짐 등) thread_name으로 새 글을 한 번 만든다
// (같은 요청의 재시도가 아니라 다른 요청). 잠금을 종료 시각 안에 못 얻으면 보내지 않는다: 업무 글로 가야 할 내용을
// 기본 #브리핑에 섞지 않고, 상태 파일을 잠금 없이 건드리지 않으려고 시스템 알림으로 내려간다(잘못된 채널로 새지 않는 쪽).
function sendForum({home, webhook, work, title, content, allowedMentions, deadline}) {
  const left = () => deadline - Date.now();
  const threadName = `${work} ${title ?? ''}`.trim().slice(0, 100);
  const post = extra => left() < MIN_SEND_MS ? budgetOut() : postDiscordWebhook({webhook, content, allowedMentions, budgetMs: left(), ...extra});
  const lock = withThreadLock(home, deadline - MIN_SEND_MS, threads => {
    const known = threads[work];
    if (known) {
      const r = post({threadId: known});
      if (!(r.outcome === 'failed' && r.status >= 400 && r.status < 500 && r.status !== 429)) return r;
    }
    const r = post({threadName, wait: true});
    if (r.outcome === 'sent' && r.channelId) setThread(home, work, r.channelId);
    return r;
  });
  return lock.locked ? lock.value : {outcome: 'lock-timeout', attempts: 0, reason: '포럼 상태 잠금을 시간 안에 못 얻음'};
}

// 레포별 웹훅이 있고 업무 키가 있으면 포럼 글로, 아니면 기본 웹훅으로 보낸다.
function route({sec, repo, work}) {
  return sec.repoWebhook && work ? {forum: true, webhook: sec.repoWebhook} : {forum: false, webhook: sec.webhook};
}

// message: 시스템 알림에 쓰는 짧은 문구. discord: {content, mention} 또는 (사용자ID)=>{content, mention}을 주면 디스코드에는 그 본문을 쓴다.
// opts: {kind, key, work, workTitle, repo, dedupWindowMs, home, env, discord}. work: 업무 키(없으면 기본 #브리핑),
//   repo: 생략하면 업무 키의 저장소 앞부분. 레포 웹훅(DISCORD_WEBHOOK_URL_<레포>)이 있고 업무 키가 있을 때만 포럼 글로 간다.
// 반환: {via:'discord'|'system', error, duplicate?, discord:{outcome,reason}|null}
//   error는 호출 쪽이 쓰던 "시스템 알림 실패 문구"(성공이면 null)다. 디스코드 성공이면 항상 null.
export function notifyUser(message, spawn, opts = {}) {
  const env = opts.env ?? process.env;
  const deadline = Date.now() + (opts.totalMs ?? TOTAL_BUDGET_MS);
  const result = {via: 'system', error: null, discord: null};
  let home = null, secrets = [];
  if (env.KADAN_NOTIFY !== 'off') {
    try {
      home = opts.home ?? ledgerHome();
      const cfg = effectiveNotifyEnvFile(env, home);
      const repo = opts.repo ?? (opts.work?.includes('/') ? opts.work.split('/')[0] : undefined);
      if (cfg.error) result.discord = {outcome: 'config-error', reason: scrubSecrets(cfg.error)};
      else if (cfg.envFile) {
        const sec = readDiscordSecrets(cfg.envFile, {repo});
        if (sec.error) result.discord = {outcome: 'config-error', reason: scrubSecrets(sec.error)};
        else {
          secrets = [sec.webhook, sec.repoWebhook, sec.userId];
          const now = (opts.now ?? Date.now)();
          if (opts.key && alreadySent(home, opts.key, opts.dedupWindowMs, now))
            return {via: 'discord', error: null, duplicate: true, discord: {outcome: 'duplicate', reason: '같은 키로 이미 보냄'}};
          const d = (typeof opts.discord === 'function' ? opts.discord(sec.userId) : opts.discord) ?? {content: fitDiscord(message), mention: false};
          const allowedMentions = d.mention === true ? {users: [sec.userId]} : {parse: []};
          const to = route({sec, repo, work: opts.work});
          const title = opts.workTitle ?? workTitleOf(home, opts.work);
          const sent = Date.now() < blockedUntil
            ? {outcome: 'skipped', attempts: 0, reason: '디스코드 장애 직후라 건너뜀(60초)'}
            : to.forum
              ? sendForum({home, webhook: to.webhook, work: opts.work, title, content: d.content, allowedMentions, deadline})
              : postDiscordWebhook({webhook: to.webhook, content: d.content, allowedMentions, budgetMs: Math.max(MIN_SEND_MS, deadline - Date.now())});
          if (sent.outcome === 'uncertain' || (sent.outcome === 'failed' && sent.attempts !== 0 && (sent.status === undefined || sent.status >= 500 || sent.status === 429)))
            blockedUntil = Date.now() + DISCORD_BLOCK_MS;
          result.discord = {outcome: sent.outcome, reason: scrubSecrets(sent.reason ?? '', secrets), attempts: sent.attempts ?? null, status: sent.status ?? null};
          if (sent.outcome === 'sent') result.via = 'discord';
        }
      }
    } catch (error) {
      result.discord = {outcome: 'config-error', reason: scrubSecrets(error.message, secrets)};
    }
    if (home && result.discord) {
      appendLog(home, {at: new Date((opts.now ?? Date.now)()).toISOString(), key: opts.key ?? null, kind: opts.kind ?? null, work: opts.work ?? undefined,
        via: 'discord', outcome: result.discord.outcome, reason: result.discord.reason || undefined, attempts: result.discord.attempts ?? undefined, status: result.discord.status ?? undefined});
    }
  }
  if (result.via === 'discord') return result;
  result.error = systemNotify(message, spawn);
  return result;
}
