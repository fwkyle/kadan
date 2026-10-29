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

export function signalPid(pid, signal) {
  try { process.kill(pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

// 파일별 독립 프로세스 그룹과 그 자손만 고른다. 운영 세션 이름/소켓은 조회하지 않는다.
export function childPids(pid) {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], {encoding: 'utf8', timeout: 1000});
  if (result.status !== 0) throw new Error(`시험 자식 PID 조회 실패: ${result.error?.code ?? result.status}`);
  const rows = result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([pid]);
  for (const [id, , group] of rows) if (group === pid) owned.add(id);
  let size;
  do {
    size = owned.size;
    for (const [id, parent] of rows) if (owned.has(parent)) owned.add(id);
  } while (size !== owned.size);
  return [...owned].filter(id => rows.some(([p]) => p === id));
}
