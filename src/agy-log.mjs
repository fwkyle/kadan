// agy(Antigravity CLI) 로그 읽기 — 읽기 전용. 로그 파일 `cli-YYYYMMDD_HHMMSS.log` 하나는 agy 프로세스 하나가 쓴다.
// 로그인 저장소는 맥 하나에 하나이고, 떠 있는 agy는 약 한 시간마다 토큰을 새로 고치며 저장소를 자기 계정으로 덮는다.
// 그래서 로그에서 읽는 것은 세 가지다: 그 프로세스의 계정, 저장소를 덮은 마지막 사건(갱신·브라우저 로그인), 지금 토큰의 만료 시각.
// 로그 줄에는 연도가 없다. 파일 이름의 날짜와 합쳐 읽는다(자정을 넘으면 월일이 파일보다 작아지지 않는다 — 해가 바뀐 경우만 +1년).
// 로그는 커질 수 있다(실측: 한 파일 2.6MB). 파일마다 끝에서부터 덩어리로 읽고, 필요한 줄을 찾으면 멈춘다.
// 메모리는 덩어리 하나와 가장 긴 한 줄이면 되고, 읽는 양에는 상한(READ_BUDGET)이 있다. 상한 안에서 못 찾으면 '모름'으로 둔다.
import fs from 'node:fs';
import path from 'node:path';

export const LOG_NAME = /^cli-(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)\.log$/u;
export const CHUNK = 64 * 1024;
export const READ_BUDGET = 32 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;

const STAMP = /^[IWEF](\d\d)(\d\d) (\d\d):(\d\d):(\d\d)/u;
// `OAuth: authenticated successfully as <계정>` — 파일 열 때(저장소에서 읽음)와 브라우저 로그인 직후에 찍힌다.
const AUTH = /server_oauth\.go:\d+\] OAuth: authenticated successfully as (\S+)/u;
const LOADED = /keyringAuth: loaded token, expiry=(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:\.\d+)? ([+-]\d{4})/u;
const REFRESHED = /token refreshed, new expiry=(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:\.\d+)? ([+-]\d{4})/u;
const LOGIN = /consumerOAuth: token acquired, expiry=(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:\.\d+)? ([+-]\d{4})/u;
const EXITED = /CLI program exited/u;

// 로그 파일 이름 → 시작 시각(맥 현지 시각). 로그가 아니면 null.
export function logStartMs(name) {
  const m = LOG_NAME.exec(name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

// 만료 시각 글자(`2026-11-24 14:15:43 +0900`) → 시각. 오프셋이 글에 있으므로 맥 시간대와 상관없다.
export function expiryMs(date, offset) {
  const ms = Date.parse(`${date.replace(' ', 'T')}${offset.slice(0, 3)}:${offset.slice(3)}`);
  return Number.isFinite(ms) ? ms : null;
}

// 줄 앞의 `I1124 15:19:52` → 시각. 연도는 파일 이름의 것을 쓴다(해가 바뀌면 +1).
export function lineMs(line, fileStartMs) {
  const m = STAMP.exec(line);
  if (!m) return null;
  const start = new Date(fileStartMs);
  let ms = new Date(start.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4], +m[5]).getTime();
  if (ms < fileStartMs - 86_400_000) ms = new Date(start.getFullYear() + 1, +m[1] - 1, +m[2], +m[3], +m[4], +m[5]).getTime();
  return ms;
}

// 파일을 끝에서부터 줄 단위로 부른다. onLine이 true를 돌려주면 멈춘다. 읽은 바이트가 budget을 넘으면 멈추고 {complete: false}.
// 덩어리 경계의 줄은 이어 붙여 한 줄로 낸다. 반환: {complete} — 파일 처음까지 다 봤는가(멈춘 경우 true).
export function scanBackward(file, onLine, {budget = READ_BUDGET, chunk = CHUNK} = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    let used = 0;
    while (pos > 0) {
      if (used >= budget) return {complete: false};
      const size = Math.min(chunk, pos);
      pos -= size;
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, pos);
      used += size;
      let data = Buffer.concat([buf, tail]);
      let end = data.length;
      for (let i = data.lastIndexOf(0x0a, end - 1); i >= 0; i = data.lastIndexOf(0x0a, end - 1)) {
        if (end - i - 1 > 0 && onLine(data.toString('utf8', i + 1, end))) return {complete: true};
        end = i;
        if (end === 0) break;
      }
      tail = data.subarray(0, end);
    }
    if (tail.length && onLine(tail.toString('utf8'))) return {complete: true};
    return {complete: true};
  } finally { fs.closeSync(fd); }
}

function readHead(file, bytes = HEAD_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n).split('\n');
  } finally { fs.closeSync(fd); }
}

// 로그 하나의 상태. 못 읽으면 null. 계정은 여기서만 전체 글자로 다루고, 보여 주기 전에 가린다(agy-accounts.mjs).
//  account      — 마지막 인증 줄의 계정. 못 찾았거나 읽기 상한 안에서 확정 못 하면 null
//  lastWrite    — 저장소를 덮은 마지막 사건 {kind: 'refreshed'|'browser-login', atMs, expiryMs, account}. 없으면 null
//  expiryMs     — 이 프로세스가 지금 쥔 토큰의 만료 시각(마지막 덮어쓰기의 것, 없으면 시작 때 읽은 것). 모르면 null
//  loadedExpiry — 시작 때 저장소에서 읽은 토큰의 만료 시각
//  exited       — 끝 표지(`CLI program exited`)가 있는가. 살아 있는지는 lsof로 정한다(끝 표지 없이 죽은 로그도 있다).
export function readAgyLog(file, {budget = READ_BUDGET, chunk = CHUNK} = {}) {
  const name = path.basename(file);
  const startMs = logStartMs(name);
  if (startMs == null) return null;
  let head;
  try { head = readHead(file); } catch { return null; }
  let loadedExpiry = null;
  let firstAccount = null;
  for (const line of head) {
    const loaded = loadedExpiry == null ? LOADED.exec(line) : null;
    if (loaded) loadedExpiry = expiryMs(loaded[1], loaded[2]);
    const auth = firstAccount == null ? AUTH.exec(line) : null;
    if (auth) firstAccount = auth[1];
    if (loadedExpiry != null && firstAccount != null) break;
  }
  let account = null;
  let lastWrite = null;
  let exited = false;
  // 갱신(refreshed)의 계정은 그 줄 앞의 마지막 인증 줄이다. 브라우저 로그인은 토큰을 받은 줄 바로 뒤에 인증 줄이 찍힌다.
  let nearestAfter = null; // 끝에서부터 읽으며 가장 최근에 지나온 인증 줄 = 지금 읽는 줄 바로 뒤의 인증 줄
  let waitingRefreshAccount = false;
  let scan;
  try {
    scan = scanBackward(file, line => {
      if (!exited && EXITED.test(line)) exited = true;
      const auth = AUTH.exec(line);
      if (auth) {
        nearestAfter = auth[1];
        if (account == null) account = auth[1];
        if (waitingRefreshAccount) { lastWrite.account = auth[1]; waitingRefreshAccount = false; return true; }
        return false;
      }
      if (lastWrite == null) {
        const login = LOGIN.exec(line);
        const refreshed = login ? null : REFRESHED.exec(line);
        const hit = login ?? refreshed;
        if (hit) {
          lastWrite = {kind: login ? 'browser-login' : 'refreshed', atMs: lineMs(line, startMs),
            expiryMs: expiryMs(hit[1], hit[2]), account: login ? nearestAfter : null};
          if (!login) waitingRefreshAccount = true;
          else return account != null;
        }
      }
      return false;
    }, {budget, chunk});
  } catch { return null; }
  // 사건 앞에 인증 줄이 없으면(시작하자마자 갱신해 인증 줄보다 먼저 찍힘) 시작 때 읽은 계정이 그 사건의 계정이다.
  // 상한 안에서 파일 처음까지 못 가면(scan.complete가 false) 계정은 모름으로 둔다 — 중간에 계정이 바뀌었을 수 있다.
  if (lastWrite && lastWrite.account == null && waitingRefreshAccount && scan.complete) lastWrite.account = firstAccount;
  if (account == null && scan.complete) account = firstAccount;
  const expiry = lastWrite?.expiryMs ?? loadedExpiry;
  return {file, startMs, account, lastWrite, expiryMs: expiry, loadedExpiry, exited, complete: scan.complete};
}
