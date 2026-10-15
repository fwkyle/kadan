// One bounded wait per adoption. It never sends keys, retries adoption, or closes a tab.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {transferStatus} from './adopt-transfer.mjs';
import {notifyAdoption} from './adopt-notice.mjs';

const self = fileURLToPath(import.meta.url);
export function startAdoptMonitor(home, id) {
  const log = fs.openSync(path.join(home, 'adoptions', id, 'monitor.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [self, home, id], {
      detached: true, stdio: ['ignore', log, log], env: process.env,
    });
    child.on('error', () => console.error('인수 확인 대기 실행 실패. adopt status로 확인하세요.'));
    child.unref();
  } finally { fs.closeSync(log); }
}

export async function monitorAdoption(home, id, {status = () => transferStatus(home, id),
  notify = details => notifyAdoption(home, details), now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeout = 180000} = {}) {
  const deadline = now() + timeout;
  let current;
  do {
    current = status();
    if (current.status === 'accepted') {
      if (['close-failed', 'remove-failed'].includes(current.source)) {
        notify({id, role: current.role, reason: `인수는 확인했으나 원본 탭 정리 결과: ${current.source}`});
      }
      return current;
    }
    if (now() >= deadline) break;
    await sleep(Math.min(1000, deadline - now()));
  } while (true);
  notify({id, role: current.role, reason: '인수 확인이 아직 끝나지 않았습니다. 두 창과 인수 기록을 확인해 주세요.'});
  return current;
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try { await monitorAdoption(process.argv[2], process.argv[3]); }
  catch {
    try { notifyAdoption(process.argv[2], {id: process.argv[3], role: '확인 필요',
      reason: '인수 확인 대기 프로그램 오류. 원본을 보존하고 인수 기록을 확인해 주세요.'}); }
    catch { /* Keep the local failure visible even if the mailbox is unavailable. */ }
    console.error('인수 확인 대기 오류. 원본 탭은 자동 종료하지 않습니다.');
    process.exitCode = 1;
  }
}
