// 무거운 명령 동시 실행 제한. 카단 폴더의 잠금 파일로 기계 전체에서 무거운 명령을 한 줄(기본 동시 1개)로 세운다.
// 왜: 병렬 에이전트가 설치·빌드·러스트 빌드를 한꺼번에 돌려 부하 75·스왑 25GB까지 갔다 (2026-10-02 [kyle]).
// 종류별 상한은 종류가 다르면 셋이 겹쳐 돌아, 2026-11-21 커널 패닉 재부팅 2회 뒤 종류와 상관없는 한 줄로 합쳤다.
// 자리를 잡은 뒤 명령을 띄우기 직전에 맥 전체 압축 메모리 공간을 재서 높으면 자리를 쥔 채 기다리고(시작 관문),
// 도는 동안에도 5초마다 재서 위험하면 그 명령의 프로세스 그룹을 끊는다(실행 중 보호). 기준은 src/memory-check.mjs.
// 데몬·서비스 없이 잠금 파일만 쓴다. 죽은 PID의 잠금과, PID를 다른 프로세스가 다시 받은 잠금은 다음 사람이 회수한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {isRoleName} from './role-name.mjs';
import {MEMORY_GROUP_GONE_MS, MEMORY_KILL_GRACE_MS, MEMORY_POLL_MS, MEMORY_START_MAX_PCT, MEMORY_STOP_EXIT, MEMORY_WAIT_EXIT,
  MEMORY_WAIT_MS, NO_STOP_STREAK, judgeRunning, judgeStart, memoryCheckEnabled, nextStopStreak, stopReason} from './memory-check.mjs';
import {readMachineMemory} from './machine-memory.mjs';

// 종류는 대기 줄·status 표시와 rust의 CARGO_BUILD_JOBS에만 쓴다. 자리 묶음은 종류와 상관없이 하나다.
// 시험·브라우저·vite·playwright·내장 Postgres는 build로 돌린다.
export const HEAVY_KINDS = ['rust', 'install', 'build'];
export const DEFAULT_CONFIG = {reviewSlots: 4, leaseMaxHours: 12, heavy: 1};
export const LIMIT_USAGE = 'kadan limit run <rust|install|build> -- <명령...> | status | set conductor-works <0 이상의 정수>. 무거운 명령은 종류와 상관없이 맥 전체에서 한 줄이다(기본 동시 1개, $KADAN_HOME/resource-limits.json의 heavy로 바꾼다. 옛 limits는 더 쓰지 않는다). 맥에서는 자리를 잡은 뒤 명령을 띄우기 직전에 맥 전체 압축 메모리 공간(세그먼트·보관 페이지 중 큰 비율)이 75% 이상이거나 압박 단계가 위급이거나 값을 못 읽으면 자리를 쥔 채 5초마다 다시 재며 최대 90초 기다리고, 그래도 풀리지 않으면 명령을 돌리지 않고 자리를 풀고 종료 코드 75로 끝난다. 도는 동안에도 5초마다 재서 압축 공간 85% 이상이 2번 연속이거나 압박 위급이면서 75% 이상이 2번 연속이면(두 기준은 따로 센다) 그 명령의 프로세스 그룹에 SIGTERM, 10초 뒤에도 남아 있으면 SIGKILL을 보내고 종료 코드 76으로 끝난다(76이면 같은 명령을 바로 다시 돌리지 않는다). 맥이 아니면 재지 않는다. $KADAN_HOME/memory-check.off 파일이나 환경 변수 KADAN_MEMORY_CHECK=off면 시작 전 확인도 실행 중 보호도 하지 않는다(도는 중에는 재는 회차마다 다시 읽는다). 명령은 자기 프로세스 그룹에서 표준 입력 없이 돈다(입력을 받는 명령은 돌리지 않는다). rust는 CARGO_BUILD_JOBS=2를 붙인다(이미 지정·-j/--jobs가 있으면 그대로). limit run 안에서 limit run·slot deps를 다시 부르지 않는다(같은 자리를 기다려 멈춘다). set conductor-works는 일반감독 한 명에게 맡길 진행 중 업무의 기준 개수(기본 3, 0이면 안내 문장 끔)를 같은 파일에 적는다. 상세: docs/review-slots.md';
const CARGO_JOBS = '2';

// 설정 파일은 선택이다. 없으면 기본값을 쓴다 (2026-10-02 [kyle]: 손잡이를 늘리지 않는다).
export function readResourceConfig(home) {
  const file = path.join(home, 'resource-limits.json');
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {...DEFAULT_CONFIG, ...value};
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

// 프로세스의 시작 표지: 번호(PID)가 같아도 다른 프로세스면 달라지고, 같은 프로세스면 벽시계를 고쳐도 변하지 않는 값이다.
// Linux: 부팅 식별값 + 부팅 뒤 틱으로 센 시작 시각(/proc/<pid>/stat의 22번째 칸). 벽시계를 쓰지 않는다.
//   Linux의 `ps lstart`는 "부팅 시각 + 시작 틱"으로 계산돼 시계가 앞으로 보정되면 살아 있는 프로세스의 값도 같이 밀리므로 쓰지 않는다.
// macOS: 커널이 프로세스를 만들 때 저장해 둔 시작 시각을 ps가 그대로 찍는다. 시간대에 따라 글자가 달라지지 않게 UTC로 읽는다.
// 그 밖의 OS는 ps 값이 시계 보정에 안전한지 확인하지 않아 표지를 만들지 않는다. 읽지 못하거나 모양이 다르면 null이다.
const LINUX_TOKEN = /^linux:[0-9a-f-]{8,64}:\d+$/i;
const PS_TOKEN = /^ps:[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/;
const tokenMethod = token => (LINUX_TOKEN.test(token) ? 'linux' : PS_TOKEN.test(token) ? 'ps' : null);
export function processStartToken(pid, {platform = process.platform, readFile = fs.readFileSync, run = spawnSync} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let token = null;
  try {
    if (platform === 'linux') {
      const stat = readFile(`/proc/${pid}/stat`, 'utf8');
      // 둘째 칸(명령 이름)은 괄호 안에 공백·괄호를 담을 수 있어 마지막 ')' 뒤부터 센다. 그 뒤 20번째 값이 22번째 칸이다.
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      token = `linux:${readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${ticks}`;
    } else if (platform === 'darwin') {
      const result = run('ps', ['-o', 'lstart=', '-p', String(pid)],
        {encoding: 'utf8', timeout: 2000, env: {...process.env, LC_ALL: 'C', TZ: 'UTC'}});
      if (result.status === 0) token = `ps:${String(result.stdout ?? '').trim()}`;
    }
  } catch { return null; }
  return token && tokenMethod(token) ? token : null;
}

// 잠금 주인의 상태. 잠금에는 잡을 때 읽은 주인의 시작 표지(startToken)가 있다. PID가 살아 있어도 지금 그 PID의 표지가
// 다르면 번호만 같은 다른 프로세스다(재부팅·PID 재사용) — 'pid-reused'이고 죽은 잠금으로 본다.
// 모르면 살아 있다고 본다(표지 없는 옛 잠금·모양이 다른 표지·지금 표지를 못 읽음·읽는 방법이 다름): 잘못 남긴 잠금은
// 자리 하나가 줄 뿐이지만 잘못 회수하면 무거운 명령이 겹친다. 표지는 PID가 살아 있고 잠금에 표지가 있을 때만 읽는다.
export function lockOwnerState(lock, {startToken = processStartToken} = {}) {
  if (!processAlive(lock?.pid)) return 'dead';
  const method = typeof lock.startToken === 'string' ? tokenMethod(lock.startToken) : null;
  if (!method) return 'alive';
  let current = null;
  try { current = startToken(lock.pid); } catch { return 'alive'; }
  if (typeof current !== 'string' || tokenMethod(current) !== method) return 'alive';
  return current === lock.startToken ? 'alive' : 'pid-reused';
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

// 원자적 생성이 곧 잠금이다. 성공하면 true, 이미 있으면 false.
// 내용을 임시 파일에 먼저 다 쓰고 hard link로 한 번에 잠금 이름을 만든다(이미 있으면 EEXIST).
// 'wx'로 먼저 만들고 나중에 쓰면 그 사이에 죽을 때 내용 없는 잠금이 남아 모든 무거운 작업이 멈춘다(2026-11-21 검수).
export function createExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
  try { fs.linkSync(tmp, file); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { fs.rmSync(tmp, {force: true}); }
}

const limitDir = home => path.join(home, 'limits');
const lockFile = (home, n) => path.join(limitDir(home), `heavy-${n}.lock`);

function capOf(home) {
  const heavy = readResourceConfig(home).heavy;
  const cap = Number(heavy);
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`잘못된 동시 개수: heavy=${heavy}`);
  return cap;
}
const checkKind = kind => {
  if (!HEAVY_KINDS.includes(kind)) throw new Error(`알 수 없는 종류: ${kind} (${HEAVY_KINDS.join('|')})`);
};

// 잠금 파일에는 주인 명령의 인자·cwd를 적지 않는다: 명령줄에 토큰이 실리면 남의 세션 기록에 비밀이 남는다(2026-11-18).
// 잠금에는 아래 모양의 값만 적고, 읽어 내보낼 때도 같은 허용 목록만 통과시킨다(옛 형식 잠금의 command·cwd, 모르는 필드는 버린다).
const KIND_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SINCE_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;
const shown = (value, re) => (typeof value === 'string' && re.test(value) ? value : undefined);
export function publicHolder(lock, state, raw) {
  const pid = Number.isSafeInteger(raw?.pid) && raw.pid > 0 ? raw.pid : undefined;
  const fields = {pid, kind: shown(raw?.kind, KIND_RE), since: shown(raw?.since, SINCE_RE), role: isRoleName(raw?.role) ? raw.role : undefined};
  return {lock, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), alive: state === 'alive', state};
}
function lockRecord(holder) {
  const {pid, kind, since, startToken, role} = holder;
  return {pid, kind, since, ...(typeof startToken === 'string' ? {startToken} : {}), ...(isRoleName(role) ? {role} : {})};
}

// alive는 잠금이 살아 있는지(state가 alive)다. state는 alive·dead·pid-reused 중 하나다. 돌려주는 값은 허용 목록 필드만이다.
// 새 코드의 자리는 heavy-N.lock뿐이다. 옛 코드가 남긴 <종류>-N.lock은 세지도 회수하지도 않는다(머지 직후 잠깐 겹칠 수 있다).
export function limitHolders(home, deps) {
  const dir = limitDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^heavy-\d+\.lock$/.test(name))
    .map(name => { const raw = readJson(path.join(dir, name)); return publicHolder(name, lockOwnerState(raw, deps), raw); });
}

// 못 읽거나(내용 없음·JSON 아님) pid가 없는 잠금은 주인을 알 수 없다. 막 만든 것은 쓰는 중일 수 있어 두고,
// 파일 수정 시각이 이 시간을 넘으면 죽은 잠금처럼 회수한다(영원히 막지 않는다).
export const ORPHAN_LOCK_MS = 60_000;
const ageMs = file => { try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return 0; } };
function staleLock(file, deps) {
  const current = readJson(file);
  if (current && Number.isSafeInteger(current.pid)) return lockOwnerState(current, deps) !== 'alive';
  return fs.existsSync(file) && ageMs(file) > ORPHAN_LOCK_MS;
}

// 죽은 잠금을 치우고 새로 잡는다. 두 회수자가 같은 죽은 잠금을 보고 한쪽이 새로 잡은 살아 있는 잠금을 다른 쪽이 치우지 않게,
// 자리마다 회수 표지(<잠금>.reclaim)를 잡은 쪽만 회수하고, 표지 안에서 잠금을 다시 읽어 아직 죽은 것일 때만 치운다.
// 표지에는 주인(pid·시작 표지)을 적고 잠금과 같은 주인 판정으로 본다: 주인이 살아 있으면 오래 걸려도 치우지 않고,
// 죽었거나 PID가 재사용됐으면 치우고 한 번 다시 잡는다. 못 읽는 표지는 잠금의 고아 규칙(60초)을 따른다.
// 표지를 못 잡으면 회수하지 않고 다음 바퀴에 다시 본다. 치우기 직전에 표지가 아직 내 것인지 확인하고, 끝날 때는 내 것일 때만 지운다.
function takeOver(file, deps, create) {
  const guard = `${file}.reclaim`;
  const token = processStartToken(process.pid);
  const mine = {pid: process.pid, ...(token ? {startToken: token} : {}), since: new Date().toISOString(), nonce: randomUUID()};
  const ownGuard = () => readJson(guard)?.nonce === mine.nonce;
  if (!createExclusive(guard, mine)) {
    if (!staleLock(guard, deps) || !reclaim(guard) || !createExclusive(guard, mine)) return false;
  }
  try { return staleLock(file, deps) && ownGuard() && reclaim(file) && create(); }
  finally { if (ownGuard()) fs.rmSync(guard, {force: true}); }
}

// 빈 자리 하나를 잡는다. 주인이 죽었거나 PID가 재사용된 잠금, 오래된 깨진 잠금은 회수한다. 못 잡으면 null.
export function tryAcquireLimit(home, holder, deps) {
  const cap = capOf(home);
  for (let n = 1; n <= cap; n++) {
    const file = lockFile(home, n);
    if (createExclusive(file, lockRecord(holder))) return file;
    if (staleLock(file, deps) && takeOver(file, deps, () => createExclusive(file, lockRecord(holder)))) return file;
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

const OWNER_MARK = {alive: '', dead: '(죽음)', 'pid-reused': '(PID 재사용: 시작 표지 다름)'};
// 대기 줄에는 누가 쥐었는지(잠금 이름·PID·상태·시작 시각·종류·역할)만 쓴다. 명령 인자·cwd는 남의 세션 기록에 남지 않게 뺀다.
const describe = holders => holders
  .map(h => `${h.lock} pid ${h.pid}${OWNER_MARK[h.state]} ${h.since ?? ''}${h.kind ? ` 종류 ${h.kind}` : ''}${h.role ? ` 역할 ${h.role}` : ''}`.trim()).join('; ');

const spanText = ms => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}분` : `${Math.round(ms / 1000)}초`);

// 시작 관문. 자리를 쥔 채 메모리가 풀리길 기다린다(그동안 다른 무거운 작업도 시작하지 못한다). 시작해도 되면 null,
// 기다림이 상한을 넘으면 잰 값 한 줄(못 읽었으면 "못 읽음")을 돌려준다. 값이 바뀔 때만 대기 줄을 다시 낸다.
// 측정은 pollMs 간격으로 시작한다: 측정에 걸린 시간만큼 덜 쉬고, 상한까지 남은 시간보다 오래 쉬지 않는다.
// 그래서 자리를 쥐는 시간의 상한은 "waitMs + 측정 1회"다.
async function waitForMemory({measure, waitMs, pollMs, now, sleepFn, log}) {
  const started = now();
  let shown = '', last = null;
  for (;;) {
    // 상한을 넘었으면 새 측정이 통과여도 시작하지 않는다. 경과는 단조 시계(performance.now)로 잰다: 벽시계 변경에 안 흔들린다.
    if (last && now() - started >= waitMs) return last;
    const measuredAt = now();
    let verdict;
    try { verdict = judgeStart(measure()); } catch { verdict = judgeStart(null); }
    if (verdict.ok) {
      // 측정이 끝난 뒤에도 한 번 더 본다: 측정 중에 상한을 넘었으면 통과여도 시작하지 않는다.
      return last && now() - started >= waitMs ? last : null;
    }
    last = verdict.line;
    if (verdict.line !== shown) {
      log(`대기: 메모리 — ${verdict.line}. 압축 공간 ${MEMORY_START_MAX_PCT}% 미만·압박 위급 아님이어야 시작한다. 자리는 쥔 채 기다림(최대 ${spanText(waitMs)})`);
      shown = verdict.line;
    }
    const current = now();
    await sleepFn(Math.max(0, Math.min(pollMs - (current - measuredAt), waitMs - (current - started))));
  }
}

// 명령의 프로세스 그룹(음수 PID). 번호로만 알아본다: 조회와 조회 사이, 조회와 신호 사이에 그 번호가 다른 그룹에
// 다시 쓰이는 경우는 가려내지 못한다(받아들인 한계, docs/review-slots.md). 다만 조회나 신호에서 한 번 "없다"(ESRCH)를 본 뒤에는
// 다시 조회하지도 신호를 보내지도 않는다: 그 뒤에 같은 번호가 보이면 다른 그룹이다. ESRCH가 아닌 오류(EPERM 등: 좀비만 남았거나
// 신호를 보낼 수 없는 프로세스만 남은 그룹)는 "아직 있다"로 본다.
function processGroup(pid) {
  let gone = !Number.isInteger(pid) || pid <= 1;
  const call = signal => {
    if (gone) return false;
    try { process.kill(-pid, signal); return true; }
    catch (error) { if (error.code === 'ESRCH') { gone = true; return false; } return signal === 0; }
  };
  return {pid, signal: name => call(name), alive: () => call(0)};
}
async function groupGone(group, ms) {
  const end = performance.now() + ms;
  while (group.alive()) {
    if (performance.now() >= end) return false;
    await sleep(Math.min(50, Math.max(1, ms)));
  }
  return true;
}
// 그룹을 끊는다: SIGTERM을 보내고, 유예가 지나도 남은 프로세스가 있으면 SIGKILL을 보낸 뒤 goneMs 동안 사라지는지 본다.
// 그래도 남으면 남은 프로세스의 번호를 적은 한 줄을 남기고 돌아간다(자리를 무기한 쥐지 않는다). 사라졌으면 true.
// leaderRunning()은 선두(명령 자신)가 아직 끝나지 않았는지다. 그룹 번호는 선두의 PID와 같다.
async function stopGroup(group, {graceMs, goneMs, log, leaderRunning}) {
  group.signal('SIGTERM');
  if (await groupGone(group, graceMs)) return true;
  group.signal('SIGKILL');
  if (await groupGone(group, goneMs)) return true;
  const left = leaderRunning() ? `선두 PID ${group.pid} 포함` : `그룹 번호 ${group.pid}`;
  log(`메모리 보호: SIGKILL 뒤 ${spanText(goneMs)}가 지나도 프로세스 그룹(${group.pid})이 남았다. 자리는 푼다 — 남은 프로세스(${left})는 끝내지 못했으니 직접 확인한다`);
  return false;
}

// 실행 중 보호. pollMs마다 끄는 스위치를 다시 읽고, 켜져 있으면 재서 두 기준의 연속 셈을 따로 센다.
// 어느 한쪽이 MEMORY_STOP_STREAK번 연속이면 그 명령의 그룹을 끊는다. 스위치가 꺼진 회차는 재지 않고, 못 읽은 회차·측정 예외와 함께
// 끊는 근거로 쓰지 않으며 두 셈을 0으로 되돌린다. 끊기로 한 뒤에는 더 재지 않는다. 회차는 예외를 밖으로 내지 않는다.
// stopping은 끊기를 시작했을 때만 생기는 약속(그룹 종료 확인까지, 사라졌으면 true)이고, stop()은 타이머를 멈춘다.
// leftover는 확인 시간이 지나도 그룹이 남았을 때만 끝나는 약속이다: 호출한 쪽이 선두의 종료를 더 기다리지 않게 한다.
function watchMemory(group, {isOn, measure, pollMs, graceMs, goneMs, log, leaderRunning}) {
  let streak = NO_STOP_STREAK, timer = null, giveUp;
  const state = {stopping: null, leftover: new Promise(resolve => { giveUp = resolve; }),
    stop() { clearTimeout(timer); timer = null; }};
  const tick = () => {
    timer = null;
    let verdict = null;
    try { if (isOn()) verdict = judgeRunning(measure()); } catch { verdict = judgeRunning(null); }
    streak = nextStopStreak(streak, verdict);
    const reason = stopReason(streak);
    if (!reason) { timer = setTimeout(tick, pollMs); return; }
    const say = line => { try { log(line); } catch { /* 알림 줄 때문에 끊기를 멈추지 않는다 */ } };
    say(`메모리 보호로 명령을 끊음(종료 ${MEMORY_STOP_EXIT}): ${verdict.line}. ${reason}이라 이 명령의 프로세스 그룹을 끊는다. 같은 명령을 바로 다시 돌리지 않는다`);
    state.stopping = stopGroup(group, {graceMs, goneMs, log: say, leaderRunning})
      .then(gone => { if (!gone) giveUp(); return gone; });
  };
  timer = setTimeout(tick, pollMs);
  return state;
}

// 자리가 날 때까지 기다렸다가 메모리를 확인하고 명령을 돌리고, 성공·실패·중단 어느 쪽이든 잠금을 푼다.
// 종료 코드는 명령의 것을 돌려준다. 메모리가 끝내 풀리지 않으면 명령을 돌리지 않고 MEMORY_WAIT_EXIT(75)를,
// 도는 중에 메모리 보호가 끊었으면 MEMORY_STOP_EXIT(76)를 돌려준다. 명령 자신이 75·76으로 끝난 경우와 구별해야 하면
// runLimitedResult의 started(명령을 띄웠는지)와 memoryStop(메모리 보호가 끊었을 때만 true로 붙는다)을 본다.
// 명령은 자기 프로세스 그룹(detached)에서 표준 입력 없이 돈다: 끊을 때 명령이 띄운 프로세스까지 함께 끊으려는 것이다.
// 분리된 자식은 터미널의 Ctrl-C를 직접 받지 못하므로 이 프로세스가 받은 신호를 그룹에 전달한다.
// 메모리 옵션(memory): enabled·platform·measure·waitMs·pollMs·graceMs·goneMs·now·sleepFn. 시험이 측정과 시계를 넣는 자리다.
// beforeStart·afterExit는 자리를 쥔 동안 부른다: beforeStart()는 관문을 통과한 뒤 명령을 띄우기 직전(75로 시작하지 못하면 부르지 않는다),
// afterExit(결과)는 명령이 끝난 뒤 자리를 풀기 전이다. 둘 중 어느 쪽이 예외를 내도 자리는 풀리고 예외는 그대로 나간다.
export async function runLimited(...args) { return (await runLimitedResult(...args)).code; }
export async function runLimitedResult(home, kind, command, {cwd = process.cwd(), env = process.env, pollMs = 2000, log = m => console.error(m), stdio = ['ignore', 'inherit', 'inherit'], memory = {}, beforeStart, afterExit} = {}) {
  if (!command.length) throw new Error('실행할 명령 필요: kadan limit run <종류> -- <명령...>');
  checkKind(kind);
  capOf(home);
  const token = processStartToken(process.pid);
  const holder = {pid: process.pid, kind, since: new Date().toISOString(),
    ...(token ? {startToken: token} : {}), ...(env.KADAN_ROLE ? {role: env.KADAN_ROLE} : {})};
  let file = null, child = null, watch = null, group = null;
  const release = () => { try { if (file && readJson(file)?.pid === process.pid) fs.rmSync(file, {force: true}); } catch {} };
  // 신호 처리는 잠금을 잡기 전에 건다. 잡은 직후·명령 시작 전에 신호가 와도 잠금을 풀고 끝낸다.
  const onSignal = signal => {
    if (child) { group?.signal(signal); return; }
    release(); process.exit(128 + (os.constants.signals[signal] ?? 1));
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);
  process.on('exit', release);
  try {
    // 한 바퀴(회수 시도 + 바로 뒤의 대기 줄) 안에서는 같은 PID의 시작 표지를 한 번만 읽는다.
    const oncePerPid = () => {
      const seen = new Map();
      return {startToken: pid => { if (!seen.has(pid)) seen.set(pid, processStartToken(pid)); return seen.get(pid); }};
    };
    let lookup = oncePerPid();
    file = tryAcquireLimit(home, holder, lookup);
    let shown = '';
    while (!file) {
      const now = describe(limitHolders(home, lookup));
      if (now !== shown) { log(`대기: ${kind} 자리 모두 사용 중(맥 전체 한 줄) — ${now}`); shown = now; }
      await sleep(pollMs);
      lookup = oncePerPid();
      file = tryAcquireLimit(home, holder, lookup);
    }
    // 끄는 스위치: 시작 관문은 여기서 한 번 읽고, 실행 중 보호는 재는 회차마다 다시 읽는다(도는 중에 파일을 놓거나 치우면
    // 다음 회차부터 적용된다). 넘겨받은 환경(env)이 비어 있어도 이 프로세스의 환경에 스위치가 있으면 끈다(tests/run.mjs 아래의
    // 시험이 맥을 재지 않게).
    const {enabled, platform = process.platform, measure = () => readMachineMemory(), waitMs = MEMORY_WAIT_MS,
      pollMs: memoryPollMs = MEMORY_POLL_MS, graceMs = MEMORY_KILL_GRACE_MS, goneMs = MEMORY_GROUP_GONE_MS,
      now = () => performance.now(), sleepFn = sleep} = memory;
    const isOn = () => enabled ?? (memoryCheckEnabled(home, env) && memoryCheckEnabled(home, process.env));
    const mac = platform === 'darwin';
    const on = isOn();
    if (on && !mac) log(`메모리 확인 건너뜀: 맥이 아님(${platform})`);
    if (on && mac) {
      const short = await waitForMemory({measure, waitMs, pollMs: memoryPollMs, now, sleepFn, log});
      if (short) {
        log(`메모리 보호로 시작하지 않음(종료 ${MEMORY_WAIT_EXIT}): ${short}. ${spanText(waitMs)} 기다렸지만 풀리지 않아 명령은 돌리지 않고 자리를 풀었다`);
        return {code: MEMORY_WAIT_EXIT, started: false};
      }
    }
    beforeStart?.();
    child = spawn(command[0], command.slice(1), {cwd, env: limitEnv(kind, command, env), stdio, detached: true});
    const started = child.pid !== undefined; // 실행 파일이 없어 못 띄우면 pid가 없다
    group = processGroup(child.pid);
    const exited = new Promise(resolve => {
      child.once('error', error => { log(`실행 실패: ${error.message}`); resolve(127); });
      child.once('exit', (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] ?? 1)));
    });
    // 맥이면 스위치가 꺼진 채 시작했어도 회차는 돈다: 도는 중에 스위치가 켜지면 다음 회차부터 잰다.
    const leaderRunning = () => child.exitCode === null && child.signalCode === null;
    if (mac && started) {
      watch = watchMemory(group, {isOn, measure, pollMs: memoryPollMs, graceMs, goneMs, log, leaderRunning});
    }
    // 보통은 명령(선두)이 끝나길 기다린다. 메모리 보호가 끊었는데 확인 시간이 지나도 그룹이 남았으면 선두의 종료를 더 기다리지 않는다.
    const code = await (watch ? Promise.race([exited, watch.leftover]) : exited);
    watch?.stop();
    let result = {code, started};
    // 끊기를 시작한 뒤라면 명령이 무슨 코드로 끝났든 메모리 보호 중단이다. 그룹이 사라졌거나 확인 시간이 지난 뒤에 자리를 푼다.
    if (watch?.stopping) {
      const gone = await watch.stopping;
      // 끝내 남은 프로세스는 붙들지 않는다: 이 프로세스가 선두의 종료를 기다리느라 끝나지 못하는 일이 없게 한다.
      if (!gone) child.unref();
      result = {code: MEMORY_STOP_EXIT, started, memoryStop: true};
    }
    afterExit?.(result);
    return result;
  } finally {
    watch?.stop();
    for (const signal of signals) process.off(signal, onSignal);
    process.off('exit', release);
    release();
  }
}

export async function limitCommand(args, {home, env = process.env}) {
  const [action, kind] = args;
  if (!action || action === '--help') return LIMIT_USAGE;
  if (action === 'status') {
    const config = readResourceConfig(home);
    return {heavy: config.heavy, holders: limitHolders(home), conductorOpenWorks: readConductorOpenWorks(home),
      memoryCheck: memoryCheckEnabled(home, env) && memoryCheckEnabled(home, process.env) ? '켜짐' : '꺼짐',
      ...(config.limits !== undefined ? {notice: 'resource-limits.json의 limits(종류별 동시 개수)는 더 이상 쓰지 않음: 종류와 상관없이 맥 전체 한 줄(heavy)이다'} : {})};
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
