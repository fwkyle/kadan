// 프로세스가 살아 있는지. kill -0은 좀비(죽었지만 부모가 거두지 않은 프로세스)도 살아 있다고 답한다.
// 컨테이너처럼 거두는 쪽이 없으면 낡은 잠금이 영원히 산 것으로 보이므로 ps 상태 Z는 죽은 것으로 본다.
import { spawnSync } from 'node:child_process';

export function pidAlive(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; }
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return !(state.status === 0 && /^\s*Z/.test(state.stdout));
}
