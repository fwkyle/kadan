// 포럼 채널의 업무 글 기록 — `업무 키 → 글 id`만 $KADAN_HOME/notify-threads.json에 둔다(주소·토큰은 저장하지 않는다).
// 감시기와 CLI가 동시에 쓸 수 있어 잠금(mkdir 잠금 + 오래된 잠금 치우기)을 걸고, 쓸 때는 임시 파일 → rename(0600)이다.
// 상태 읽기 → (새 글 만들기) → 상태 갱신은 한 잠금 안에서 한다.
import fs from 'node:fs';
import path from 'node:path';

export const THREADS_FILE = 'notify-threads.json';
const LOCK_STALE_MS = 20000; // 알림 한 번의 최대 시간(약 14초)보다 길게
const file = home => path.join(home, THREADS_FILE);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function readThreads(home) {
  try {
    const v = JSON.parse(fs.readFileSync(file(home), 'utf8'));
    return v?.version === 1 && v.threads && typeof v.threads === 'object' ? v.threads : {};
  } catch { return {}; }
}

// 최신 파일을 다시 읽고 자기 업무 줄만 바꿔 쓴다(다른 업무의 기록을 지우지 않는다). 잠금 안에서 부른다.
export function setThread(home, work, threadId) {
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const tmp = `${file(home)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({version: 1, threads: {...readThreads(home), [work]: threadId}}, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file(home));
}

// 잠금을 얻어 fn(threads)을 돌린다. lockUntilMs(절대 시각)까지 못 얻으면 fn을 돌리지 않고 {locked:false}를 돌려준다 —
// 잠금 없이 읽기·전송·쓰기를 하지 않는다. 호출 쪽은 전체 알림 종료 시각을 넘지 않게 lockUntilMs를 정한다.
export function withThreadLock(home, lockUntilMs, fn) {
  const lock = `${file(home)}.lock`;
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  let held = false;
  while (!held) {
    try { fs.mkdirSync(lock); held = true; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lock); } catch { /* 다른 프로세스가 치움 */ }
      if (Date.now() >= lockUntilMs) return {locked: false};
      sleep(Math.max(1, Math.min(50, lockUntilMs - Date.now())));
    }
  }
  try { return {locked: true, value: fn(readThreads(home))}; }
  finally { try { fs.rmdirSync(lock); } catch { /* 이미 없음 */ } }
}
