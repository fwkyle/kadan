// 포럼 채널의 업무 글 기록 — `업무 키 → 글 id`만 $KADAN_HOME/notify-threads.json에 둔다(주소·토큰은 저장하지 않는다).
// 감시기와 CLI가 동시에 쓸 수 있어 잠금(mkdir 잠금 + 오래된 잠금 치우기)을 걸고, 쓸 때는 임시 파일 → rename(0600)이다.
import fs from 'node:fs';
import path from 'node:path';

export const THREADS_FILE = 'notify-threads.json';
const LOCK_WAIT_MS = 5000, LOCK_STALE_MS = 20000;
const file = home => path.join(home, THREADS_FILE);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function readThreads(home) {
  try {
    const v = JSON.parse(fs.readFileSync(file(home), 'utf8'));
    return v?.version === 1 && v.threads && typeof v.threads === 'object' ? v.threads : {};
  } catch { return {}; }
}

function write(home, threads) {
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const tmp = `${file(home)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({version: 1, threads}, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file(home));
}

// 잠금 안에서 fn(threads) → 새 threads를 돌려주면 쓴다. 잠금을 못 얻으면(5초) 잠금 없이 진행한다 — 알림을 막지 않는다.
export function withThreads(home, fn) {
  const lock = `${file(home)}.lock`;
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  let held = false;
  for (const start = Date.now(); !held && Date.now() - start < LOCK_WAIT_MS;) {
    try { fs.mkdirSync(lock); held = true; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lock); } catch { /* 다른 프로세스가 치움 */ }
      sleep(50);
    }
  }
  try {
    const next = fn(readThreads(home));
    if (next) write(home, next);
  } finally { if (held) try { fs.rmdirSync(lock); } catch { /* 이미 없음 */ } }
}
