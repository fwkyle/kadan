// 실행기(tests/run.mjs)가 끝날 때 자기 실행 폴더(runTmp) 아래에서 생긴 tmux 서버·도우미만 끈다.
// 이유: 시험 파일이 만든 격리 tmux 서버(-L kadan-handover-background-… 등)와 출력 기록 자식, kadan-watch가
// 실행 폴더를 지운 뒤에도 부모 1로 남았다(2026-11-04 실측 11개, 오래된 것은 10시간). 폴더가 지워지면 소켓도 사라져 다시 붙을 수 없다.
// 소유 기준은 "내 runTmp 아래" 하나다. 소속을 확인하지 못하면 끄지 않는다. 운영 소켓(-L kadan)은 어떤 경로로도 대상이 아니다.
// 10배 규모: 실행 끝에 한 번, 자기 폴더 아래 파일과 프로세스 목록을 한 번씩 훑는다(주기 작업이 아니다).
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {processes} from './child-cleanup.mjs';

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LSTART = String.raw`\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+\s+`;
const OPS_SOCKET = /(^|\s)-L\s*kadan(\s|$)/; // 운영 카단 구획. 명령줄·환경 어디에 runTmp가 있어도 이 줄은 끄지 않는다.

// /private/tmp/… 와 /tmp/… 두 표기를 모두 본다. 뒤 경계를 둬서 kadan-run-AbCdEf가 kadan-run-AbCdEfX를 잡지 않게 한다.
export function runTmpPattern(runTmp) {
  const real = path.resolve(runTmp);
  const forms = new Set([real]);
  if (real.startsWith('/private/tmp/')) forms.add(real.slice('/private'.length));
  if (real.startsWith('/tmp/')) forms.add(`/private${real}`);
  return new RegExp(`(?:${[...forms].map(escape).join('|')})(?=[/\\s'"=:]|$)`);
}

// 실행 폴더 아래의 유닉스 소켓(tmux-<uid>/<이름> 등)을 모두 찾는다. 링크는 따라가지 않는다.
export function findSockets(root) {
  const found = [], stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isSocket()) found.push(full);
    }
  }
  return found.sort();
}

// 모든 프로세스의 작업 폴더(cwd)를 한 번에 읽는다(lsof 한 번, 약 0.4초). 실패하면 빈 표 — cwd 근거 없이 판정한다.
function lsofCwds() {
  const result = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'],
    {encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024});
  const cwds = new Map();
  let pid = null;
  for (const line of (result.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

// 이 runTmp 소속인 프로세스인가. 명령줄·환경(ps eww)에 경로가 있거나 작업 폴더가 그 아래면 소속이다.
// macOS는 시스템 프로그램(/bin/sleep 등)과 process.title로 이름을 바꾼 도우미(kadan-watch:<세션>)의 환경을 보여 주지 않는다 —
// 그때는 cwd만 근거다. 어느 쪽으로도 확인하지 못하면 null(끄지 않음).
export function ownership(row, runTmp, {cwd} = {}) {
  const pattern = runTmpPattern(runTmp);
  const command = row.identity.replace(new RegExp(`^${LSTART}`), '');
  if (OPS_SOCKET.test(command)) return null;
  if (pattern.test(command)) return 'command';
  return typeof cwd === 'string' && pattern.test(cwd) ? 'cwd' : null;
}

export function sweepRun(runTmp, {
  list = () => processes(undefined, {timeout: 5000}),
  check = pid => processes(pid, {timeout: 5000}),
  cwds = lsofCwds,
  signal = (pid, sig) => process.kill(pid, sig),
  killServer = socket => spawnSync('tmux', ['-S', socket, 'kill-server'], {stdio: 'ignore', timeout: 3000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'TMUX' && key !== 'TMUX_PANE'))}),
  sleep = pause,
  self = process.pid,
  graceMs = 1000,
} = {}) {
  const result = {sockets: [], signaled: [], skipped: []};
  if (!runTmp || !path.isAbsolute(runTmp)) { result.skipped.push('실행 폴더가 절대경로가 아님'); return result; }
  const root = path.resolve(runTmp);
  // 1) 소켓으로 끈다: -S <절대경로>라 운영 이름 소켓(-L kadan)에 닿을 수 없다.
  for (const socket of findSockets(root)) {
    if (!socket.startsWith(`${root}${path.sep}`)) continue;
    killServer(socket);
    result.sockets.push(socket);
  }
  // 2) 남은 소속 프로세스(소켓 폴더가 밖에 있던 tmux 서버, 출력 기록 자식, kadan-watch 등)를 끈다.
  let rows;
  try { rows = list(); } catch (error) { result.skipped.push(`프로세스 조회 실패: ${error.message}`); return result; }
  let cwdOf;
  try { cwdOf = cwds(); } catch { cwdOf = new Map(); }
  const owned = rows.filter(row => row.pid > 1 && row.pid !== self && ownership(row, root, {cwd: cwdOf.get(row.pid)}));
  const send = (row, sig) => {
    let current;
    try { current = check(row.pid).find(p => p.pid === row.pid); } catch { return false; }
    if (!current || current.identity !== row.identity) return false; // 번호가 재사용됐으면 건드리지 않는다
    try { signal(row.pid, sig); return true; } catch { return false; }
  };
  for (const row of owned) if (send(row, 'SIGTERM')) result.signaled.push(row.pid);
  if (!result.signaled.length) return result;
  const end = Date.now() + graceMs;
  const alive = () => {
    let now;
    try { now = new Set(list().map(p => `${p.pid} ${p.identity}`)); } catch { return []; }
    return owned.filter(row => now.has(`${row.pid} ${row.identity}`));
  };
  let left = alive();
  while (left.length && Date.now() < end) { sleep(100); left = alive(); }
  for (const row of left) send(row, 'SIGKILL');
  return result;
}
