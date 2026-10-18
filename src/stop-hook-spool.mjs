// Stop 훅 증거(spool) — 실행기가 턴을 마칠 때 훅이 남긴 DONE 마커 줄을 읽고 쓴다(2026-10-18 [kyle] 승인).
// 훅은 빠른 길일 뿐이다: 여기서 증거를 못 찾으면 소비처는 지금의 화면 판정으로 넘어간다.
// 한 줄 = {at, role, harness, sessionId, taskId, result}. 응답 본문은 저장하지 않는다. 원장에는 쓰지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SPOOL_FILE = 'stop-hook-spool.jsonl';
const TAIL_BYTES = 256 * 1024; // 읽을 때는 꼬리만 본다: 최근 턴 증거만 쓰이고 파일은 계속 자란다

// 훅 프로세스는 시험 홈 검사(assertTestHome)를 거치지 않는다. ledgerHome()과 같은 우선순위만 따른다.
export function spoolHome(env = process.env) {
  return env.KADAN_HOME || env.KADAN_LITE_HOME || path.join(os.homedir(), '.kadan');
}

export const spoolPath = home => path.join(home, SPOOL_FILE);

export function appendSpool(home, record) {
  fs.mkdirSync(home, {recursive: true});
  fs.appendFileSync(spoolPath(home), `${JSON.stringify(record)}\n`, {mode: 0o600});
}

export function readSpool(home) {
  let fd;
  try {
    fd = fs.openSync(spoolPath(home), 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // 잘린 첫 줄
    return lines.flatMap(line => {
      try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row] : []; } catch { return []; }
    });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// role이 since(ISO 시각) 뒤에 남긴 훅 DONE 증거. taskMatches(taskId)가 참인 것만 시간순으로 돌려준다(필수).
// conflict(같은 응답에 같은 실행의 다른 결과 마커)가 가장 최근 줄이면 아무것도 돌려주지 않는다.
// 시각을 못 읽는 줄·기준 시각을 못 읽는 경우는 증거로 치지 않는다(안전하게 화면 판정으로 넘어간다).
export function hookDoneSince({home, role, since, taskMatches}) {
  if (typeof taskMatches !== 'function') return []; // 카드 조건이 없으면 증거로 쓰지 않는다(다른 실행의 마커로 끝나는 오판 방지)
  const floor = Date.parse(since);
  if (!Number.isFinite(floor)) return [];
  const rows = readSpool(home).filter(row => row.role === role && typeof row.taskId === 'string'
    && (row.result === 'ok' || row.result === 'failed') && Date.parse(row.at) > floor && taskMatches(row.taskId));
  if (rows.at(-1)?.conflict === true) return []; // 가장 최근 응답이 상충하면 이전 줄도 쓰지 않는다 — 화면 판정으로 넘긴다
  return rows.filter(row => row.conflict !== true).map(row => ({taskId: row.taskId, result: row.result, at: row.at, via: 'hook'}));
}
