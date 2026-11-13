// 무거운 명령 동시 실행 제한. 카단 폴더의 잠금 파일로 기계 전체에서 종류별 동시 개수를 막는다.
// 왜: 병렬 에이전트가 설치·빌드·러스트 빌드를 한꺼번에 돌려 부하 75·스왑 25GB까지 갔다 (2026-10-02 [kyle]).
// 데몬·서비스 없이 잠금 파일만 쓴다. 죽은 PID의 잠금과, PID를 다른 프로세스가 다시 받은 잠금은 다음 사람이 회수한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {processStartedAt} from './process-tree.mjs';

export const DEFAULT_LIMITS = {rust: 1, install: 2, build: 2};
export const DEFAULT_CONFIG = {reviewSlots: 4, leaseMaxHours: 12, limits: DEFAULT_LIMITS};
export const LIMIT_USAGE = 'kadan limit run <rust|install|build> -- <명령...> | status | set conductor-works <0 이상의 정수>. 종류별 동시 개수는 기본 rust 1·install 2·build 2이고 $KADAN_HOME/resource-limits.json의 limits로 바꾼다. rust는 CARGO_BUILD_JOBS=2를 붙인다(이미 지정·-j/--jobs가 있으면 그대로). set conductor-works는 일반감독 한 명에게 맡길 진행 중 업무의 기준 개수(기본 3, 0이면 안내 문장 끔)를 같은 파일에 적는다. 상세: docs/review-slots.md';
const CARGO_JOBS = '2';

// 설정 파일은 선택이다. 없으면 기본값을 쓴다 (2026-10-02 [kyle]: 손잡이를 늘리지 않는다).
export function readResourceConfig(home) {
  const file = path.join(home, 'resource-limits.json');
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {...DEFAULT_CONFIG, ...value, limits: {...DEFAULT_LIMITS, ...(value.limits ?? {})}};
}

// 일반감독 한 명에게 맡길 진행 중 업무의 기준 개수. 슈퍼감독이 맡기는 순간의 안내 한 줄이 쓴다(conductor-load-hint.mjs).
// 파일이 없거나 깨졌거나 값이 이상하면 기본값으로 읽는다: 이 값 때문에 우편 전송이 막히면 안 된다. 0은 "기준 문장 끔"이다.
export const DEFAULT_CONDUCTOR_OPEN_WORKS = 3;
const validThreshold = value => Number.isInteger(value) && value >= 0;
export function readConductorOpenWorks(home) {
  try {
    const value = readResourceConfig(home).conductorOpenWorks;
    return validThreshold(value) ? value : DEFAULT_CONDUCTOR_OPEN_WORKS;
  } catch { return DEFAULT_CONDUCTOR_OPEN_WORKS; }
}

// 다른 키(모르는 키 포함)는 그대로 두고 이 키만 바꾼다. 파일이 없으면 이 키만 든 새 파일을 만든다.
// 깨진 파일은 덮어쓰지 않고 거절한다(남이 적어 둔 값을 잃지 않게). 쓰기는 임시 파일 → rename, 0600.
export function setConductorOpenWorks(home, raw) {
  const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (!validThreshold(value) || !Number.isSafeInteger(value)) {
    const error = new Error(`기준 개수는 0 이상의 정수만 받는다: ${raw ?? '(없음)'}`);
    error.exitCode = 2;
    throw error;
  }
  const file = path.join(home, 'resource-limits.json');
  let current = {};
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { current = null; }
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`${file}을 읽지 못해 쓰지 않았다. 파일을 고치거나 치운 뒤 다시 한다`);
    }
  }
  fs.mkdirSync(home, {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({...current, conductorOpenWorks: value}, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
  return value;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

// 잠금 주인의 상태. PID가 살아 있어도 그 프로세스가 잠금을 잡은 시각(since)보다 뒤에 시작됐으면 원래 주인이 아니다
// (재부팅·PID 재사용) — 'pid-reused'이고 죽은 잠금으로 본다. ps의 시작 시각은 초 아래를 버리므로 2초 여유를 둔다.
// 모르면 살아 있다고 본다(since 없음·해석 불가·시작 시각 조회 실패): 잘못 남긴 잠금은 자리 하나가 줄 뿐이지만
// 잘못 회수하면 무거운 명령이 겹친다. 시작 시각은 PID가 살아 있을 때만 묻는다(죽은 PID에는 ps를 부르지 않는다).
const START_SLACK_MS = 2000;
export function lockOwnerState(lock, {startedAt = processStartedAt} = {}) {
  if (!processAlive(lock?.pid)) return 'dead';
  const since = typeof lock.since === 'string' ? Date.parse(lock.since) : NaN;
  if (!Number.isFinite(since)) return 'alive';
  let started;
  try { started = startedAt(lock.pid); } catch { return 'alive'; }
  return Number.isFinite(started) && started > since + START_SLACK_MS ? 'pid-reused' : 'alive';
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

// alive는 잠금이 살아 있는지(state가 alive)다. state는 alive·dead·pid-reused 중 하나다.
export function limitHolders(home, kind, deps) {
  const dir = limitDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /\.lock$/.test(name) && (!kind || name.startsWith(`${kind}-`)))
    .map(name => ({lock: name, ...(readJson(path.join(dir, name)) ?? {})}))
    .map(h => { const state = lockOwnerState(h, deps); return {...h, alive: state === 'alive', state}; });
}

// 빈 자리 하나를 잡는다. 주인이 죽었거나 PID가 재사용된 잠금은 회수한다. 못 잡으면 null.
export function tryAcquireLimit(home, kind, holder, deps) {
  const cap = capOf(home, kind);
  for (let n = 1; n <= cap; n++) {
    const file = lockFile(home, kind, n);
    if (createExclusive(file, holder)) return file;
    const current = readJson(file);
    const stale = current && lockOwnerState(current, deps) !== 'alive';
    if (stale && reclaim(file) && createExclusive(file, holder)) return file;
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

const OWNER_MARK = {alive: '', dead: '(죽음)', 'pid-reused': '(PID 재사용: 잠금보다 늦게 시작)'};
const describe = holders => holders
  .map(h => `${h.lock} pid ${h.pid}${OWNER_MARK[h.state]} ${h.since ?? ''} ${(h.command ?? []).join(' ')}`.trim()).join('; ');

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
    return {limits, holders: limitHolders(home), conductorOpenWorks: readConductorOpenWorks(home)};
  }
  if (action === 'set') {
    if (kind !== 'conductor-works' || args.length !== 3) { const error = new Error(LIMIT_USAGE); error.exitCode = 2; throw error; }
    return {conductorOpenWorks: setConductorOpenWorks(home, args[2])};
  }
  if (action !== 'run') throw new Error(LIMIT_USAGE);
  const split = args.indexOf('--');
  if (split !== 2 || !kind) throw new Error(LIMIT_USAGE);
  const code = await runLimited(home, kind, args.slice(split + 1), {env});
  process.exitCode = code;
  return null;
}
