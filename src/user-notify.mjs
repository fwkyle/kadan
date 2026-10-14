// 사용자(@user) 알림의 단일 통로. 다섯 호출 지점(감시 전달·겹알림·watch send·인계·사용자 우편)과 결정 알림이 모두 여기를 지난다.
// 디스코드 설정이 있으면 디스코드로 보내고, 설정 없음·전송 실패·불확실이면 맥 시스템 알림(osascript)으로 내려간다.
// 호출하는 쪽이 모두 동기라서 동기 API를 유지한다: 디스코드 전송은 자식 프로세스(discord-send.mjs)를 spawnSync로 띄워
// 강제 시간 제한(부모 14초, 자식 재시도 포함 12초)을 건다. 감시 주기를 막는 최악 시간은 전송 14초 + 시스템 알림이다.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ledgerHome} from './ledger.mjs';
import {resolveNotifyTarget, readDiscordSecrets} from './notify-setting.mjs';

export const DISCORD_LIMIT = 2000;
export const NOTIFY_LOG_FILE = 'notify-log.jsonl';
const CHILD_TIMEOUT_MS = 14000;
const SENDER = new URL('./discord-send.mjs', import.meta.url).pathname;
// 경보는 같은 id가 해소됐다가 다시 뜰 수 있어 짧은 창 안에서만 중복으로 본다. 결정·우편 id는 한 번뿐이라 창이 없다.
export const ALERT_DEDUP_WINDOW_MS = 10 * 60 * 1000;

export function systemNotify(message, spawn) {
  const script = `display notification ${JSON.stringify(message)} with title "kadan watch"`;
  const result = spawn('osascript', ['-e', script], {encoding: 'utf8'});
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

// 디스코드 웹훅 요청이 나가는 유일한 함수. 이어서 붙일 기능(thread_id로 기존 스레드에 보내기, ?wait=true 응답의
// 메시지 ID를 받아 PATCH로 수정)을 위해 인자·반환을 열어 둔다. 1단계는 둘 다 만들지 않는다 — 받은 값은 무시하고,
// 반환은 {outcome, attempts, status, reason}이며 나중에 messageId를 더할 수 있다.
export function postDiscordWebhook({webhook, content, allowedMentions, ...future}) {
  void future; // threadId, wait, editMessageId 자리
  const payload = {content, allowed_mentions: allowedMentions};
  const child = spawnSync(process.execPath, [SENDER], {
    input: JSON.stringify({webhook, payload}), encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: 1 << 16,
  });
  if (child.error || child.status !== 0) {
    // 강제 종료되면 요청이 나갔는지 알 수 없다.
    return {outcome: 'uncertain', attempts: null, reason: child.error?.code === 'ETIMEDOUT' ? '자식 프로세스 시간 초과' : '자식 프로세스 오류'};
  }
  try { return JSON.parse(child.stdout.trim().split('\n').at(-1)); } catch { return {outcome: 'uncertain', attempts: null, reason: '전송 결과 해석 실패'}; }
}

// 레포별 비밀 파일에 사용자 ID가 없으면 기본 비밀 파일의 값을 쓴다.
function resolveSecrets(target) {
  if (!target.envFile) return {};
  const own = readDiscordSecrets(target.envFile, {optionalUser: target.source === 'repo'});
  if (own.error || own.userId || target.source !== 'repo') return own;
  if (!target.fallbackEnvFile) return {error: '설정 오류: 레포 비밀 파일에 DISCORD_USER_ID가 없고 기본 비밀 파일도 없다'};
  const base = readDiscordSecrets(target.fallbackEnvFile);
  return base.error ? {error: `설정 오류: 레포 비밀 파일에 DISCORD_USER_ID가 없고 기본 비밀 파일을 쓸 수 없다`} : {webhook: own.webhook, userId: base.userId};
}

// message: 시스템 알림에 쓰는 짧은 문구. discord: {content, mention} 또는 (사용자ID)=>{content, mention}을 주면 디스코드에는 그 본문을 쓴다.
// opts: {kind, key, repo, dedupWindowMs, home, env, discord}. repo는 카드·업무·실행 키의 저장소 앞부분(모르면 생략 → 기본 웹훅).
// 반환: {via:'discord'|'system', error, duplicate?, discord:{outcome,reason}|null}
//   error는 호출 쪽이 쓰던 "시스템 알림 실패 문구"(성공이면 null)다. 디스코드 성공이면 항상 null.
export function notifyUser(message, spawn, opts = {}) {
  const env = opts.env ?? process.env;
  const result = {via: 'system', error: null, discord: null};
  let home = null, secrets = [];
  if (env.KADAN_NOTIFY !== 'off') {
    try {
      home = opts.home ?? ledgerHome();
      const cfg = resolveNotifyTarget(env, home, opts.repo);
      if (cfg.error) result.discord = {outcome: 'config-error', reason: scrubSecrets(cfg.error)};
      else if (cfg.envFile) {
        const sec = resolveSecrets(cfg);
        if (sec.error) result.discord = {outcome: 'config-error', reason: scrubSecrets(sec.error)};
        else {
          secrets = [sec.webhook, sec.userId];
          const now = (opts.now ?? Date.now)();
          if (opts.key && alreadySent(home, opts.key, opts.dedupWindowMs, now))
            return {via: 'discord', error: null, duplicate: true, discord: {outcome: 'duplicate', reason: '같은 키로 이미 보냄'}};
          const d = (typeof opts.discord === 'function' ? opts.discord(sec.userId) : opts.discord) ?? {content: fitDiscord(message), mention: false};
          const sent = postDiscordWebhook({webhook: sec.webhook, content: d.content,
            allowedMentions: d.mention === true ? {users: [sec.userId]} : {parse: []}});
          result.discord = {outcome: sent.outcome, reason: scrubSecrets(sent.reason ?? '', secrets), attempts: sent.attempts ?? null, status: sent.status ?? null};
          if (sent.outcome === 'sent') result.via = 'discord';
        }
      }
    } catch (error) {
      result.discord = {outcome: 'config-error', reason: scrubSecrets(error.message, secrets)};
    }
    if (home && result.discord) {
      appendLog(home, {at: new Date((opts.now ?? Date.now)()).toISOString(), key: opts.key ?? null, kind: opts.kind ?? null, repo: opts.repo ?? undefined,
        via: 'discord', outcome: result.discord.outcome, reason: result.discord.reason || undefined, attempts: result.discord.attempts ?? undefined, status: result.discord.status ?? undefined});
    }
  }
  if (result.via === 'discord') return result;
  result.error = systemNotify(message, spawn);
  return result;
}
