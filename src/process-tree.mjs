// Why: 역할 pane이 연 파일·프로세스를 찾을 때는 pane PID 자신이 아니라 그 자손 전체를 봐야 한다
// (래퍼 `kadan-claude`가 실행기를 exec하거나 자식을 낳는다). 비서 복원과 restart가 같은 걸음을 쓴다.
import {spawnSync} from 'node:child_process';

// panePid와 그 모든 자손 PID(문자열). ps를 못 읽으면 던진다 — 추측해서 일부만 돌려주지 않는다.
export function descendantPids(panePid, run = spawnSync) {
  const ps = run('ps', ['-axo', 'pid=,ppid='], {encoding: 'utf8', timeout: 2000});
  if (ps.status !== 0) throw new Error('프로세스 조회 실패');
  const rows = ps.stdout.trim().split('\n').map(line => line.trim().split(/\s+/));
  const pids = new Set([String(panePid)]);
  for (let i = 0; i < rows.length; i++) {
    let changed = false;
    for (const [pid, parent] of rows) {
      if (pids.has(parent) && !pids.has(pid)) { pids.add(pid); changed = true; }
    }
    if (!changed) break;
  }
  return [...pids];
}

// 그 PID들이 열어 둔 파일 경로(중복 없이). lsof 실패는 던진다.
export function openFilesOf(pids, run = spawnSync) {
  const result = run('lsof', ['-p', pids.join(','), '-Fn'], {encoding: 'utf8', timeout: 3000});
  if (result.status !== 0) throw new Error('열린 파일 조회 실패');
  return [...new Set(result.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)))];
}

// panePid와 자손의 {pid, args}. 어느 프로세스가 실행기 본체인지 args로 가리기 위해 쓴다(대화 파일의 주인 확인).
export function processTree(panePid, run = spawnSync) {
  const ps = run('ps', ['-axo', 'pid=,ppid=,args='], {encoding: 'utf8', timeout: 2000});
  if (ps.status !== 0) throw new Error('프로세스 조회 실패');
  const rows = ps.stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, args]) => ({pid, ppid, args}));
  const wanted = new Set([String(panePid)]);
  for (let i = 0; i < rows.length; i++) {
    let changed = false;
    for (const row of rows) if (wanted.has(row.ppid) && !wanted.has(row.pid)) { wanted.add(row.pid); changed = true; }
    if (!changed) break;
  }
  return rows.filter(row => wanted.has(row.pid)).map(({pid, args}) => ({pid, args}));
}
