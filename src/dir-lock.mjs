// JSONL 저장의 폴더 잠금(mkdir). 남이 쓰는 중이면 잠깐 기다렸다가 다시 얻는다(2026-10-08 [kyle]:
// 감독이 작업자 5명을 동시에 띄우자 즉시 포기한 쪽이 세션만 남고 시작 기록이 빠졌다). 예산 안에 못 얻으면
// 기존처럼 실패한다. 멈춘 잠금은 지우지 않는다 — 원인을 모르는 잠금은 사람이 확인한다.
import fs from 'node:fs';

export const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 얻으면 true, 예산 안에 못 얻으면 false. 이미 있음 외의 오류는 그대로 던진다.
export function acquireDirLock(lock, { waitMs = LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lock); return true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      sleepSync(Math.min(LOCK_POLL_MS, left));
    }
  }
}

// 잠금이 풀릴 때까지 기다린다. 풀렸으면 true, 예산이 끝나면 false.
export function waitDirUnlocked(lock, { waitMs = LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + waitMs;
  while (fs.existsSync(lock)) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    sleepSync(Math.min(LOCK_POLL_MS, left));
  }
  return true;
}
