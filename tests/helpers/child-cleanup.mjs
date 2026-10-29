import {spawnSync} from 'node:child_process';

// exit를 기다리되 읽지 않는 파이프 때문에 close를 무한히 기다리지 않는다.
export async function stopChild(child, graceMs = 500) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const wait = ms => new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    const timer = setTimeout(done, ms);
    child.once('exit', done);
  });
  child.kill('SIGTERM');
  await wait(graceMs);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await wait(graceMs);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`시험 자식 종료 실패: PID ${child.pid}`);
  }
}

// 환경은 표지 확인에만 쓰고 출력/예외에 담지 않는다. ps 실패는 정리 대상을 늘리지 않는다.
function processes(pid) {
  const args = pid ? ['eww', '-p', String(pid)] : ['axeww'];
  const result = spawnSync('ps', [...args, '-o', 'pid=,lstart=,command='], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 32 * 1024 * 1024,
    env: {...process.env, LC_ALL: 'C'},
  });
  if (pid && result.status === 1 && !result.stdout?.trim()) return [];
  if (result.status !== 0) throw new Error('시험 프로세스 신원 조회 실패');
  return result.stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    return match ? [{pid: Number(match[1]), identity: `${match[2]} ${match[3]}`}]: [];
  });
}

const marked = (row, marker) => row.identity.split(/\s+/).includes(`${marker}=1`);

// 부모가 종료되어 PPID가 1로 바뀌어도 실행별 표지는 상속된다.
export function markedChildren(marker) {
  return processes().filter(row => row.pid > 1 && row.pid !== process.pid && marked(row, marker));
}

export function signalChild(row, marker, signal) {
  const current = processes(row.pid).find(p => p.pid === row.pid);
  if (!current || current.identity !== row.identity || !marked(current, marker)) return false;
  try { process.kill(row.pid, signal); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw new Error('시험 프로세스 신호 전송 실패'); }
  return false;
}
