// 무거운 명령 동시 실행 제한. 카단 폴더의 잠금 파일로 기계 전체에서 종류별 동시 개수를 막는다.
// 왜: 병렬 에이전트가 설치·빌드·러스트 빌드를 한꺼번에 돌려 부하 75·스왑 25GB까지 갔다 (2026-10-02 [kyle]).
// 데몬·서비스 없이 잠금 파일만 쓴다. 죽은 PID의 잠금은 다음 사람이 회수한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export const DEFAULT_LIMITS = {rust: 1, install: 2, build: 2};
export const DEFAULT_CONFIG = {reviewSlots: 4, leaseMaxHours: 12, limits: DEFAULT_LIMITS};
export const LIMIT_USAGE = 'kadan limit run <rust|install|build> -- <명령...> | status. 종류별 동시 개수는 기본 rust 1·install 2·build 2이고 $KADAN_HOME/resource-limits.json의 limits로 바꾼다. rust는 CARGO_BUILD_JOBS=2를 붙인다(이미 지정·-j/--jobs가 있으면 그대로). 상세: docs/review-slots.md';
const CARGO_JOBS = '2';

// 설정 파일은 선택이다. 없으면 기본값을 쓴다 (2026-10-02 [kyle]: 손잡이를 늘리지 않는다).
export function readResourceConfig(home) {
  const file = path.join(home, 'resource-limits.json');
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {...DEFAULT_CONFIG, ...value, limits: {...DEFAULT_LIMITS, ...(value.limits ?? {})}};
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 회수: 남의 잠금은 이름을 바꿔 치운 뒤 다시 시도한다. 두 회수자가 겹치는 아주 짧은 틈은 수용 위험으로 둔다
// (드문 경합에 두 단계 잠금을 만들지 않는다, 2026-10-02 [kyle]).
export function reclaim(file) {
  try { fs.renameSync(file, `${file}.stale-${randomUUID()}`); } catch { return false; }
  for (const name of fs.readdirSync(path.dirname(file))) {
    if (name.startsWith(`${path.basename(file)}.stale-`)) fs.rmSync(path.join(path.dirname(file), name), {force: true});
  }
  return true;
}

// 원자적 생성('wx')이 곧 잠금이다. 성공하면 true, 이미 있으면 false.
export function createExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try { fs.writeSync(fd, JSON.stringify(value) + '\n'); } finally { fs.closeSync(fd); }
  return true;
}

const limitDir = home => path.join(home, 'limits');
const lockFile = (home, kind, n) => path.join(limitDir(home), `${kind}-${n}.lock`);

function capOf(home, kind) {
  const limits = readResourceConfig(home).limits;
  if (!Object.hasOwn(limits, kind)) throw new Error(`알 수 없는 종류: ${kind} (${Object.keys(limits).join('|')})`);
  const cap = Number(limits[kind]);
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`잘못된 동시 개수: ${kind}=${limits[kind]}`);
  return cap;
}

export function limitHolders(home, kind) {
  const dir = limitDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /\.lock$/.test(name) && (!kind || name.startsWith(`${kind}-`)))
    .map(name => ({lock: name, ...(readJson(path.join(dir, name)) ?? {})}))
    .map(h => ({...h, alive: processAlive(h.pid)}));
}

// 빈 자리 하나를 잡는다. 죽은 PID의 잠금은 회수한다. 못 잡으면 null.
export function tryAcquireLimit(home, kind, holder) {
  const cap = capOf(home, kind);
  for (let n = 1; n <= cap; n++) {
    const file = lockFile(home, kind, n);
    if (createExclusive(file, holder)) return file;
    const current = readJson(file);
    if (current && !processAlive(current.pid) && reclaim(file) && createExclusive(file, holder)) return file;
  }
  return null;
}

// rust는 코어를 다 쓰지 않게 CARGO_BUILD_JOBS=2를 환경으로 붙인다. 인자에 -j를 끼우면 `cargo test -- …`처럼
// 위치가 중요한 명령을 깨뜨릴 수 있어 환경 변수 방식을 쓴다 (2026-10-02 [kyle]).
export function limitEnv(kind, command, env = process.env) {
  if (kind !== 'rust' || env.CARGO_BUILD_JOBS) return env;
  const jobs = command.some(a => a === '-j' || a === '--jobs' || /^(-j\d+|--jobs=)/.test(a));
  return jobs ? env : {...env, CARGO_BUILD_JOBS: CARGO_JOBS};
}

const describe = holders => holders.map(h => `${h.lock} pid ${h.pid}${h.alive ? '' : '(죽음)'} ${h.since ?? ''} ${(h.command ?? []).join(' ')}`.trim()).join('; ');

// 자리가 날 때까지 기다렸다가 명령을 돌리고, 성공·실패·중단 어느 쪽이든 잠금을 푼다. 종료 코드는 명령의 것을 돌려준다.
export async function runLimited(home, kind, command, {cwd = process.cwd(), env = process.env, pollMs = 2000, log = m => console.error(m), stdio = 'inherit'} = {}) {
  if (!command.length) throw new Error('실행할 명령 필요: kadan limit run <종류> -- <명령...>');
  capOf(home, kind);
  const holder = {pid: process.pid, kind, command, cwd, since: new Date().toISOString()};
  let file = null, child = null;
  const release = () => { try { if (file && readJson(file)?.pid === process.pid) fs.rmSync(file, {force: true}); } catch {} };
  // 신호 처리는 잠금을 잡기 전에 건다. 잡은 직후·명령 시작 전에 신호가 와도 잠금을 풀고 끝낸다.
  const onSignal = signal => {
    if (child) { try { child.kill(signal); } catch {} return; }
    release(); process.exit(128 + (os.constants.signals[signal] ?? 1));
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);
  process.on('exit', release);
  try {
    file = tryAcquireLimit(home, kind, holder);
    let shown = '';
    while (!file) {
      const now = describe(limitHolders(home, kind));
      if (now !== shown) { log(`대기: ${kind} 자리 모두 사용 중 — ${now}`); shown = now; }
      await sleep(pollMs);
      file = tryAcquireLimit(home, kind, holder);
    }
    child = spawn(command[0], command.slice(1), {cwd, env: limitEnv(kind, command, env), stdio});
    return await new Promise(resolve => {
      child.once('error', error => { log(`실행 실패: ${error.message}`); resolve(127); });
      child.once('exit', (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] ?? 1)));
    });
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    process.off('exit', release);
    release();
  }
}

export async function limitCommand(args, {home, env = process.env}) {
  const [action, kind] = args;
  if (!action || action === '--help') return LIMIT_USAGE;
  if (action === 'status') {
    const limits = readResourceConfig(home).limits;
    return {limits, holders: limitHolders(home)};
  }
  if (action !== 'run') throw new Error(LIMIT_USAGE);
  const split = args.indexOf('--');
  if (split !== 2 || !kind) throw new Error(LIMIT_USAGE);
  const code = await runLimited(home, kind, args.slice(split + 1), {env});
  process.exitCode = code;
  return null;
}
