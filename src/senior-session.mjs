// 시니어 대화형 세션. senior-mode에 headless를 명시하면 기존 헤드리스 경로를 사용한다.
// codex 대화형 화면을 카단 전용 tmux 소켓(`-L kadan-senior`)에 띄워 질문 한 줄을 넣고, 답 파일의 끝 표지와 화면을 보고 끝을 안다.
// 끝난 세션은 끄지 않고 남겨 둔다(2026-11-19 [kyle]: 사람이 화면의 모델·강도를 직접 볼 수 있게). 끄는 것은 정리 명령
// (`kadan senior cleanup`)과 남긴 세션 상한을 넘겼을 때의 내보내기뿐이다.
// agy(gemini)도 같은 소켓·같은 자리·같은 끄기 확인을 쓰되 작업 폴더·관문·답 회수가 다르다(실행기별 갈래는 아래 seatKind, agy 쪽은 src/senior-agy.mjs).
// 역할이 아니다: 원장 start·stop·지침 우편·감시 대상에 들지 않는다. 기록은 호출마다 advice 한 줄과 증거 폴더다.
// 지키는 것(설계 2026-11-17):
//  - 키는 두 단계로만 나간다: 붙여넣기 직전에 빈 입력칸, Enter 직전에 '입력칸의 글 = 방금 붙인 자기 한 줄'. 아니면 키 0회로 실패한다.
//    2026-11-17 업데이트 선택 창에 Enter가 들어가 전역 codex 업데이트가 시작된 적이 있다. Esc는 보내지 않는다(알아본 닫기 대상이 없다).
//  - 끄기(정리 명령·내보내기·만들다 만 자리)는 모두 같은 확인(killOwn)을 쓴다: 소켓·세션 이름·생성 식별값·pane PID가 기록과 같을 때만.
//  - 호출이 끝난 세션에는 키를 하나도 보내지 않는다. 끝남은 기록(session.json)에만 적는다(markKept) — 정상·실패·시간 초과·신호 모두.
//    정리 명령이 쓰는 tmux 명령은 list-sessions·display-message·kill-session뿐이다.
//  - 자동 재시도·헤드리스 전환·한도 새로고침을 하지 않는다. 운영 코드에 kill-server는 없다.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {acquireDirLock} from './dir-lock.mjs';
import {ensureTmuxConf, sendTmux, tmuxClientEnv, tmuxConfPath} from './floor-tmux.mjs';
import {splitGhostText} from './ghost-text.mjs';
import {ALLOW_LIVE_FLOOR_ENV, isDefaultHome} from './live-floor-guard.mjs';
import {composerHolds, composerReady, limitScreen, markerOf, readAnswerText, screenWorking,
  ANSWER_LIMIT_BYTES} from './senior-screen.mjs';
import {agyArgv, agyAskLine, askSeatAgy, passGateAgy, prepareAgyWorkdir, removeAgyAsk, writeAgyAsk} from './senior-agy.mjs';

export const SENIOR_MODE_FILE = 'senior-mode';
// 질문이 제출되면 호출 폴더에 이 파일이 생긴다. 부른 쪽(kadan senior)이 이것을 보고 로티 읽기 전용 탭을 연다.
export const SUBMITTED_FILE = 'submitted.json';
export const SENIOR_SOCKET = 'kadan-senior';
export const SENIOR_SEATS = 4;
// 남긴 세션의 상한(3번 부른 분량). 진행 중 자리(위 4개)와 따로 센다. 넘으면 가장 오래 남긴 것부터 끈다.
export const SENIOR_KEPT = 6;
export const SESSION_ENTRY = fileURLToPath(new URL('./senior-session-run.mjs', import.meta.url));
// 세션 안 codex가 물려받으면 안 되는 값. KADAN_ROLE이 새면 사용자 설정의 카단 Stop 훅이 부른 감독의 역할로 돈다.
export const PANE_ENV_STRIP = ['KADAN_ROLE', 'TMUX', 'TMUX_PANE'];
// 화면에 넣는 한 줄. 작업 폴더가 out/이라 input.txt는 한 칸 위다(2026-11-17 실측한 꼴 그대로 — 짧아서 입력칸에서 감기지 않는다).
export const ASK_LINE = '../input.txt 를 끝까지 읽고 거기 적힌 대로 수행하라.';
// 기록 만료의 여유. 호출 상한이 지나고 이만큼 뒤에는 끝남 기록이 없어도 끝난 호출로 본다(부른 쪽이 기록 없이 죽은 경우).
const REAP_MARGIN_MS = 120_000;
export const SESSION_TIMING = {pollMs: 2000, startupMs: 60_000, settleMs: 3000, submitGraceMs: 30_000,
  idleConfirm: 2, keyGapS: '1'};

const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const fail = (code, message, more = {}) => Object.assign(new Error(message), {code, ...more});
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const keyWhy = error => error.why ?? error.code ?? 'send-failed';

// 호출 시작 시 한 번 읽는다. 설정 파일이 없으면 interactive이고 잘못된 값은 거절한다.
export function readSeniorMode(home) {
  let text;
  try { text = fs.readFileSync(path.join(home, SENIOR_MODE_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return 'interactive'; throw error; }
  const value = text.trim();
  if (value !== 'interactive' && value !== 'headless') {
    const shown = JSON.stringify(value.slice(0, 40));
    throw new Error(`${SENIOR_MODE_FILE} 값 오류: ${shown} — interactive 또는 headless 한 줄이어야 한다`);
  }
  return value;
}

// 시니어 세션의 소켓 이름. 운영은 kadan-senior 하나이고, 격리 소켓(시험)이면 그 이름에 -senior를 붙인다.
// 기본이 아닌 홈이 운영 시니어 소켓에 닿는 것은 거절한다(live-floor-guard와 같은 이유).
export function seniorSocket(env = process.env, home) {
  const base = env.KADAN_SOCKET || env.KADAN_LITE_SOCKET || 'kadan';
  const socket = base === 'kadan' ? SENIOR_SOCKET : `${base}-senior`;
  assertSeniorSocket(socket, home, env);
  return socket;
}

export function assertSeniorSocket(socket, home, env = process.env) {
  if (typeof socket !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(socket)) throw new Error(`시니어 소켓 이름 형식 오류: ${socket}`);
  if (socket === SENIOR_SOCKET && !isDefaultHome(home) && env[ALLOW_LIVE_FLOOR_ENV] !== '1') {
    throw fail('KADAN_LIVE_FLOOR_DENIED', `KADAN_LIVE_FLOOR_DENIED: 기본이 아닌 KADAN_HOME=${home}으로 ` +
      `운영 시니어 소켓(-L ${SENIOR_SOCKET})에 닿는 것을 거절한다. KADAN_SOCKET을 격리 이름으로 바꿔라`);
  }
}

// 전용 소켓 실행 함수. 늘 `-L <소켓>`과 카단 tmux 설정(-f)으로 부른다 — 개인 기본 tmux 서버와 사용자 tmux.conf를 쓰지 않는다.
// run(args, input)은 실패하면 던지고 stdout을 돌려준다(sendTmux의 run 계약). run.try는 결과를 그대로 돌려준다.
// readOnly: 조회만 하는 호출(정리 명령의 --dry-run). 설정 파일이 없어도 만들지 않는다 — 조회 명령은 서버를 띄우지 않아 설정이 쓰이지 않는다.
export function seniorTmux({socket, home, env = process.env, spawn = spawnSync, readOnly = false}) {
  assertSeniorSocket(socket, home, env);
  // tmux 서버는 처음 띄운 클라이언트의 환경을 물려받는다. 역할·바깥 tmux 값을 여기서도 뺀다(pane 명령에서 한 번 더 지운다).
  const clientEnv = tmuxClientEnv(env);
  for (const name of PANE_ENV_STRIP) delete clientEnv[name];
  let conf = null;
  // more: 그 호출에만 얹는 실행 옵션(전체 스크롤 캡처의 maxBuffer).
  const call = (args, input, more = {}) => {
    conf ??= !readOnly ? ensureTmuxConf(home) : fs.existsSync(tmuxConfPath(home)) ? tmuxConfPath(home) : '/dev/null';
    const options = {input, encoding: 'utf8', env: clientEnv, timeout: 15_000, ...more};
    return spawn('tmux', ['-u', '-L', socket, '-f', conf, ...args], options);
  };
  const run = (args, input) => {
    const result = call(args, input);
    const why = String(result.stderr || result.error?.message || '').trim();
    // signal: 그 tmux 호출이 신호로 죽었다(같은 프로세스 묶음에 TERM이 온 경우). 부른 쪽이 죽은 세션과 가를 수 있게 싣는다.
    if (result.status !== 0) {
      const error = new Error(`tmux ${args[0]} 실패: ${why || result.signal || ''}`);
      throw Object.assign(error, {signal: result.signal ?? null});
    }
    return result.stdout;
  };
  return Object.assign(run, {try: call, socket, home});
}

// 실행 꼴은 코드에 고정한다(실행기 표의 spawn 틀은 작업자용이라 쓰지 않는다). -s·-a는 반드시 준다(사용자 기본값이 더 넓을 수 있다).
// codex 설정 폴더(CODEX_HOME)는 건드리지 않는다. 업데이트 확인 끄기 -c는 로그인 안 된 시험 홈에서 선택 창을 막는 것을 관찰했다
// (2026-11-17, codex 0.166: 옵션 없이 2회 모두 창이 뜨고 옵션을 주면 2회 모두 안 뜸). 로그인된 사용자 설정에서는 확인하지 못했다.
// 실제 방어는 여전히 키 조건이다.
export function codexArgv({out, model, effort}) {
  if (!/^[A-Za-z0-9._\/\-\[\]]+$/u.test(String(model))) throw new Error(`시니어 모델 형식 오류: ${model}`);
  if (!/^[A-Za-z0-9._-]+$/u.test(String(effort))) throw new Error(`시니어 강도 형식 오류: ${effort}`);
  return ['codex', '--no-alt-screen', '-C', out, '-s', 'workspace-write', '-a', 'never', '--model', model,
    '-c', `model_reasoning_effort="${effort}"`, '-c', 'check_for_update_on_startup=false',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.writable_roots=[]'];
}

// 세션은 모델 없이 먼저 만든다: 대기 셸이 문 파일이 생길 때까지 기다렸다가 그 자리에서 exec로 codex가 된다(pane PID가 바뀌지 않는다).
// 기록·예약 종료를 건 뒤에야 문을 연다. 문이 60초 안에 안 열리면(부른 쪽이 죽음) 셸이 스스로 끝나 자리를 비운다.
const WAITER = 'gate=$1; n=0; until [ -e "$gate" ]; do n=$((n+1)); [ "$n" -gt 600 ] && exit 75; sleep 0.1; done; ' +
  'shift; exec "$@"';
export function paneCommand({gate, argv}) {
  return ['exec', '/bin/sh', '-c', quote(WAITER), 'kadan-senior', quote(gate), 'env',
    ...PANE_ENV_STRIP.flatMap(name => ['-u', name]), ...argv.map(quote)].join(' ');
}

const recordPath = dir => path.join(dir, 'session.json');
export function readRecord(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(recordPath(dir), 'utf8'));
    return value && typeof value === 'object' && typeof value.session === 'string' ? value : null;
  } catch { return null; }
}
// 임시 파일에 쓴 뒤 옮긴다: 부른 쪽과 감싼 프로세스가 같은 신호에서 함께 적어도 반쯤 쓴 기록이 남지 않는다.
// (깨진 기록의 세션은 자기 것으로 확인할 수 없어 끄지 못하고 진행 중 자리로 계속 세어진다.)
function writeRecord(dir, record) {
  const file = recordPath(dir), temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 1) + '\n', {mode: 0o600});
  fs.renameSync(temp, file);
}
function patchRecord(dir, patch) {
  // 근거 기록 실패가 끄기를 막지 않는다.
  try { const record = readRecord(dir); if (record) writeRecord(dir, {...record, ...patch}); } catch { /* 위 */ }
}

// 남김 표시: 세션은 끄지 않고 기록에 끝남과 남긴 시각만 적는다. tmux를 부르지 않는다(신호 처리기에서도 쓴다).
// 먼저 적힌 값은 지킨다 — 감싼 프로세스가 적은 끝난 이유를 부른 쪽이 덮어쓰지 않는다. 반환: 적었는가.
export function markKept(dir, reason) {
  try {
    const record = readRecord(dir);
    if (!record) return false;
    const at = new Date().toISOString();
    writeRecord(dir, {...record, endedAt: record.endedAt ?? at, endReason: record.endReason ?? reason, keptAt: record.keptAt ?? at});
    return true;
  } catch { return false; }
}

function processAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// 소켓의 세션 목록. 서버가 없으면 0개다. 그 밖의 조회 실패는 0개로 꾸미지 않고 던진다.
export function listSeniorSessions(run) {
  const result = run.try(['list-sessions', '-F', '#{session_name}\t#{pane_pid}\t#{@kadan_senior_dir}']);
  if (result.status !== 0) {
    if (queryMiss(result) === 'no-session') return [];
    throw new Error(`시니어 소켓 세션 목록 조회 실패: ${String(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout.split('\n').filter(Boolean).map(line => {
    const [name, pid, dir] = line.split('\t');
    return {name, pid, dir: dir || null};
  });
}

// tmux가 '그런 세션·서버가 없다'고 확정해 답한 문구만 부재로 읽는다: 세션을 못 찾음, 서버 없음, 소켓 파일 없음.
// 접속 권한 오류·접속 거부·시간 초과 같은 그 밖의 실패는 세션이 있는지조차 모르는 것이다(query-failed).
const GONE = /can't find session|no server running|error connecting to [^\n]*\(No such file or directory\)/iu;
function queryMiss(result) { return GONE.test(String(result.stderr ?? '')) ? 'no-session' : 'query-failed'; }

// 같은 확인: 이 소켓의 그 이름 세션이 기록과 같은 생성 식별값·호출 폴더·pane PID를 갖고 있을 때만 자기 것이다.
export function confirmOwn(record, run) {
  if (record.socket !== run.socket) return {own: false, why: 'socket-differs'};
  const format = '#{session_name}\t#{pane_pid}\t#{@kadan_senior_ask}\t#{@kadan_senior_dir}';
  const result = run.try(['display-message', '-p', '-t', `=${record.session}:`, format]);
  if (result.status !== 0) return {own: false, why: queryMiss(result)};
  const fields = result.stdout.replace(/\n$/u, '').split('\t');
  // 칸이 다 오지 않은 답은 세션이 있는지조차 모르는 것이다(신호를 받은 tmux 호출은 종료 코드 0·출력 없이 끝난다 — paneAlive 참고).
  if (fields.length !== 4) return {own: false, why: 'query-failed'};
  const [name, pid, ask, dir] = fields;
  // 서버는 살아 있는데 그 이름의 세션이 없으면 tmux는 실패하지 않고 네 칸이 모두 빈 답을 준다(tmux 3.6a, 2026-11-19 격리 소켓에서
  // 관찰: 종료 코드 0, 출력은 구분 글자뿐). 전에는 답을 받자마자 세션을 꺼서 서버도 함께 끝났기 때문에 드러나지 않았다.
  // 세션에는 늘 이름이 있다. 칸이 다 온 답의 이름이 기록과 다르면 그 세션은 없는 것이다 — '기록과 다름'으로 읽지 않는다.
  if (name !== record.session) return {own: false, why: 'no-session'};
  if (ask !== record.askId || dir !== record.dir) return {own: false, why: 'generation-differs'};
  if (String(pid) !== String(record.panePid)) return {own: false, why: 'pid-differs'};
  return {own: true};
}

// 자기 세션만 끈다. 확인이 맞지 않으면 끄지 않고 이유를 기록에 남긴다. 이미 없는 세션은 끝난 것으로만 적는다.
export function killOwn(dir, {run, reason = 'done', env = process.env} = {}) {
  const record = readRecord(dir);
  if (!record) return {killed: false, why: 'no-record'};
  const tmux = run ?? seniorTmux({socket: record.socket, home: record.home, env});
  const verdict = confirmOwn(record, tmux);
  const at = new Date().toISOString();
  // 세션이 없어진 것이 확실할 때만 그 자리가 만든 파일(agy 질문 파일)을 치운다. 끄지 못했거나 모르면 그대로 둔다.
  const release = () => { try { seatKind(record.runner).release?.(record); } catch { /* 정리 실패가 끄기 결과를 바꾸지 않는다 */ } };
  if (!verdict.own) {
    const ended = {endedAt: record.endedAt ?? at, endReason: record.endReason ?? reason};
    if (verdict.why === 'no-session') { patchRecord(dir, ended); release(); }
    else patchRecord(dir, {killSkipped: verdict.why, killSkippedAt: at, killSkippedReason: reason});
    return {killed: false, why: verdict.why};
  }
  // 끝남을 먼저 적는다: 적은 뒤 끄기 전에 죽어도 다음 호출의 청소가 이 기록으로 끈다.
  patchRecord(dir, {endedAt: record.endedAt ?? at, endReason: record.endReason ?? reason});
  const result = tmux.try(['kill-session', '-t', `=${record.session}`]);
  if (result.status !== 0) return {killed: false, why: 'kill-failed'};
  // 끈 시각과 까닭(정리 명령·내보내기·만들다 만 자리)은 끝난 이유와 따로 적는다.
  patchRecord(dir, {closedAt: new Date().toISOString(), closeReason: reason});
  release();
  return {killed: true};
}

// 그 호출이 끝났는가: 끝남 기록이 있거나, 만료 시각이 지났거나, 부른 프로세스가 없다.
// 프로세스가 '살아 있다'만으로는 주인을 확정하지 않는다(PID 재사용) — 그때는 만료 시각까지 그대로 둔다.
const callEnded = (record, nowMs) =>
  record.endedAt != null || nowMs > Number(record.expiresAt) || !processAlive(record.ownerPid);

// 소켓의 세션을 하나씩 가른다. 세션 목록에서 출발해 세션 옵션이 가리키는 기록을 찾는다(이름으로 추측하지 않고 advice/ 전체를 훑지 않는다).
//  kept   — 끝난 호출의 세션이고 기록 대조(confirmOwn)가 맞다. 꺼도 되는 것은 이것뿐이다.
//  active — 그 밖의 모두. 진행 중인 호출(running)뿐 아니라 기록이 없거나(no-record) 이 홈의 것이 아니거나(outside-home)
//           대조가 안 되는(pid-differs 등) 세션도 보수적으로 진행 중 자리로 센다.
// 읽기만 한다: tmux 명령은 list-sessions·display-message뿐이고 기록을 고치지 않는다.
export function seniorSessionStates({home, run, now = Date.now}) {
  const root = path.join(home, 'advice') + path.sep;
  return listSeniorSessions(run).map(row => {
    const base = {name: row.name, dir: row.dir};
    if (!row.dir) return {...base, state: 'active', why: 'no-record'};
    if (!path.resolve(row.dir).startsWith(root)) return {...base, state: 'active', why: 'outside-home'};
    const record = readRecord(row.dir);
    if (!record || record.session !== row.name || record.dir !== row.dir) return {...base, state: 'active', why: 'no-record'};
    if (!callEnded(record, now())) return {...base, record, state: 'active', why: 'running'};
    const verdict = confirmOwn(record, run);
    return verdict.own ? {...base, record, state: 'kept'} : {...base, record, state: 'active', why: verdict.why};
  });
}
const keptOrder = row => String(row.record.keptAt ?? row.record.endedAt ?? row.record.createdAt ?? '');

// 정리 명령의 본체. 끝난 호출이고 대조가 맞는 세션(kept)만 끈다. 진행 중·기록 없음·대조 실패는 그대로 두고 이유를 돌려준다.
// dryRun이면 무엇을 끌지만 돌려주고 아무것도 바꾸지 않는다(끄기 확인 함수도 부르지 않는다 — 그 함수는 거절 이유를 기록에 적는다).
// closeTab(호출 폴더): 그 세션의 열린 로티 탭 닫기(부른 쪽이 준다). 반환: 줄마다 {session, dir, …기록 칸, action, why?, tab?}.
// sweepTabs({seen, dryRun}): 세션 없이 남은 탭 훑기(부른 쪽이 준다). seen은 이번에 본 세션들의 호출 폴더다. 그 줄들이 뒤에 붙는다.
export function cleanupSeniorSessions({home, run, dryRun = false, now = Date.now, closeTab = () => null, sweepTabs = () => []}) {
  const sweep = () => { const rows = sweepSessions(); return [...rows, ...sweepTabs({seen: new Set(rows.map(row => row.dir).filter(Boolean)), dryRun})]; };
  const sweepSessions = () => seniorSessionStates({home, run, now}).map(row => {
    const {record} = row;
    const info = {session: row.name, dir: row.dir, runner: record ? record.runner ?? 'codex' : null, model: record?.model ?? null,
      createdAt: record?.createdAt ?? null, endReason: record?.endReason ?? null, keptAt: record?.keptAt ?? null};
    if (row.state !== 'kept') return {...info, action: 'left', why: row.why};
    if (dryRun) return {...info, action: 'would-close'};
    const result = killOwn(row.dir, {run, reason: 'cleanup'});
    if (!result.killed && result.why !== 'no-session') return {...info, action: 'left', why: result.why};
    let tab = null;
    try { tab = closeTab(row.dir); } catch { /* 탭은 꾸밈이다 */ }
    return {...info, action: 'closed', ...(tab ? {tab} : {})};
  });
  if (dryRun) return sweep();
  // 자리 확보(openSeats)의 분류·내보내기와 겹치지 않게 같은 잠금을 잡는다.
  const lock = path.join(home, 'senior-seats.lock');
  if (!acquireDirLock(lock)) throw new Error(`시니어 자리 잠금을 얻지 못했다(${lock}) — 다른 호출이 자리를 잡는 중이거나 멈춘 잠금이다`);
  try { return sweep(); } finally { fs.rmdirSync(lock); }
}

// codex 자리: 모델 작업 폴더는 호출 폴더의 out/이고 답은 그 안의 result.txt다.
function codexSeat({call}) {
  const out = path.join(call.dir, 'out');
  fs.mkdirSync(out, {recursive: true, mode: 0o700});
  const answer = path.join(out, 'result.txt');
  if (fs.existsSync(answer)) throw new Error(`답 파일이 이미 있다 — 부르지 않는다: ${answer}`);
  // codex는 심볼릭 링크가 낀 작업 폴더를 거부한다(scripts/senior.sh와 같은 이유). 실제 경로로 넘긴다.
  const argv = codexArgv({out: fs.realpathSync(out), model: call.model, effort: call.effort});
  return {cwd: out, argv, line: ASK_LINE, fields: {out}};
}

// agy 자리: 작업 폴더는 홈의 고정 폴더(shared — 자리 준비에서 git 밖 확인·에이전트 파일까지 끝난 실제 경로)이고,
// 모델이 읽을 질문 파일을 자리마다 따로 둔다. 강도는 넘기지 않는다(모델 이름이 정한다).
function agySeat({call, askId, index, shared}) {
  if (typeof call.prompt !== 'string' || !call.prompt) throw new Error('agy 시니어 자리에는 질문 글이 필요하다');
  const argv = agyArgv({model: call.model, readDir: call.readDir ?? null});
  const askFile = writeAgyAsk(shared, askId, index, call.prompt);
  return {cwd: shared, argv, line: agyAskLine(askFile), fields: {workdir: shared, askFile}};
}

// 실행기별 자리 갈래(데이터). 호출·기록(session.json)의 runner 값으로 고른다. 값이 없으면 codex다(이 칸이 생기기 전의 기록·호출).
//  prepare: 자리 준비 잠금 안에서 실행기마다 한 번(반환값이 plan의 shared) · plan: 자리 하나의 작업 폴더·실행 인자·넣을 한 줄
//  gate: 질문 넣기 전 관문 · ask: 질문 넣기와 답 회수 · release: 세션이 없어진 뒤 그 자리가 만든 파일 치우기
// 함수로 둔 이유: 두 모듈이 서로를 가져오므로 모듈을 읽는 시점이 아니라 부르는 시점에 표를 만든다.
function seatKind(runner = 'codex') {
  const kinds = {
    codex: {plan: codexSeat, gate: passGateCodex, ask: askSeatCodex},
    agy: {prepare: prepareAgyWorkdir, plan: agySeat, gate: passGateAgy, ask: askSeatAgy, release: removeAgyAsk},
  };
  if (!Object.hasOwn(kinds, runner)) throw new Error(`시니어 대화형 자리를 만들 수 없는 실행기: ${runner}`);
  return kinds[runner];
}

function createSeat({home, run, askId, call, index, deadlineAt, now, ownerPid, reapMarginMs, shared}) {
  const {dir} = call;
  const kind = seatKind(call.runner);
  const plan = kind.plan({call, askId, index, shared});
  const session = `senior-${askId.slice(0, 8)}-${index + 1}`;
  const gate = path.join(dir, 'launch');
  const release = () => { try { kind.release?.({askId, ...plan.fields}); } catch { /* 정리 실패가 원래 오류를 가리지 않는다 */ } };
  try { run(['new-session', '-d', '-s', session, '-x', '150', '-y', '50', '-c', plan.cwd, paneCommand({gate, argv: plan.argv})]); }
  catch (error) { release(); throw error; }
  // 여기서부터 실패하면 방금 만든 세션을 치운다. 어디까지 했는지를 적어 두고, 치우기 전에 아는 만큼 견준다(discardSeat).
  const made = {session, askId, dir, panePid: null, dirOption: 'none', askOption: 'none'};
  try {
    const panePid = run(['display-message', '-p', '-t', `=${session}:`, '#{pane_pid}']).trim();
    if (!/^\d+$/u.test(panePid)) throw new Error(`시니어 세션의 pane PID를 읽지 못했다: ${session}`);
    made.panePid = panePid;
    // 읽기 전용 탭(로티 `attach -r`)이 붙어도 창 크기가 탭 크기로 바뀌지 않게 고정한다. 입력은 막혀도 크기는 안 막힌다:
    // 150x50 세션이 60x20으로 줄면 codex가 다시 그려 붙여넣기 직전 검사가 정상 호출을 거절할 수 있다(검수 exec-276744c7 실측).
    run(['set-option', '-t', `=${session}:`, 'window-size', 'manual']);
    made.dirOption = 'tried';
    run(['set-option', '-t', `=${session}:`, '@kadan_senior_dir', dir]);
    made.dirOption = 'set';
    made.askOption = 'tried';
    run(['set-option', '-t', `=${session}:`, '@kadan_senior_ask', askId]);
    made.askOption = 'set';
    const expiresAt = deadlineAt + reapMarginMs;
    const record = {askId, session, socket: run.socket, home, dir, ...plan.fields, gate, panePid, ownerPid,
      ...(call.runner ? {runner: call.runner} : {}), model: call.model,
      marker: markerOf(call.token), line: plan.line, createdAt: new Date(now()).toISOString(), deadlineAt, expiresAt,
      timing: call.timing ?? SESSION_TIMING};
    // 기록이 마지막 단계다. 예약 종료는 걸지 않는다(2026-11-19): 끝난 세션은 남겨 두고, 부른 쪽이 기록 없이 죽은 호출은
    // 기록의 만료 시각(expiresAt)·부른 프로세스 생존으로 끝난 것을 안다(callEnded). tmux 서버가 따로 띄우는 일이 없다.
    writeRecord(dir, record);
    return {...record, index};
  } catch (error) {
    const cleanup = discardSeat(made, run);
    // 세션을 껐거나 이미 없을 때만 그 자리가 만든 파일을 치운다.
    if (cleanup.killed || cleanup.why === 'no-session') release();
    error.seatCleanup = cleanup;
    if (!cleanup.killed && cleanup.why !== 'no-session') {
      error.message += ` — 만든 세션 ${session}은 끄지 않았다(${cleanup.why}): 자기 것인지 확인하지 못했다`;
    }
    throw error;
  }
}

// 만들다 만 세션의 정리(기록을 쓰기 전 단계 — 기록이 마지막 단계라 기록을 쓴 자리는 여기로 오지 않는다).
// 같은 이름은 소유 근거가 아니다 — 확인이 틀리거나 불명확하면 끄지 않고 이유를 남긴다.
//  - 방금 읽은 pane PID와, 그때까지 붙인 세션 옵션(호출 폴더·askId)을 다시 읽어 같을 때만 끈다.
//    PID를 읽지 못했으면 견줄 것이 없어 끄지 않는다. 그 세션은 문이 열리지 않은 대기 셸이라 60초 뒤 스스로 끝난다.
//  - 기록까지 쓴 앞자리(다음 자리가 실패한 경우)는 openSeats가 다른 길과 같은 확인(killOwn)으로 끈다.
// 끄지 않은 이유는 호출 폴더의 create-cleanup.json에 남긴다(기록이 없는 단계라 session.json에는 적을 수 없다).
function discardSeat(made, run) {
  const {session, dir} = made;
  const leave = why => {
    const note = {session, socket: run.socket, askId: made.askId, why, at: new Date().toISOString()};
    const text = JSON.stringify(note, null, 1) + '\n';
    try { fs.writeFileSync(path.join(dir, 'create-cleanup.json'), text, {mode: 0o600}); }
    catch { /* 근거 기록 실패가 판정을 바꾸지 않는다 */ }
    return {killed: false, why};
  };
  if (made.panePid == null) return leave('pid-unknown');
  const format = '#{pane_pid}\t#{@kadan_senior_ask}\t#{@kadan_senior_dir}';
  const result = run.try(['display-message', '-p', '-t', `=${session}:`, format]);
  // 세션이 이미 없으면 치울 것이 없다. 그 밖의 조회 실패는 있는지조차 모르는 것이라 끄지 않는다.
  if (result.status !== 0) {
    return queryMiss(result) === 'no-session' ? {killed: false, why: 'no-session'} : leave('query-failed');
  }
  const [pid, ask, optionDir] = result.stdout.replace(/\n$/u, '').split('\t');
  if (String(pid) !== String(made.panePid)) return leave('pid-differs');
  // 옵션은 붙이기 전이면 비어 있어야 하고, 붙였으면 그 값이어야 한다. 붙이다 실패했으면 둘 중 하나다.
  const fits = (value, state, want) =>
    state === 'none' ? value === '' : state === 'set' ? value === want : value === '' || value === want;
  if (!fits(ask ?? '', made.askOption, made.askId) || !fits(optionDir ?? '', made.dirOption, dir)) {
    return leave('generation-differs');
  }
  return run.try(['kill-session', '-t', `=${session}`]).status === 0 ? {killed: true} : leave('kill-failed');
}

// 자리 확보: 짧은 생성 잠금 안에서 분류 → 남긴 세션 내보내기 → 진행 중 수 → `진행 중 + 이번 전원 ≤ 4` → 이번 전원의 세션 만들기를 한 묶음으로 한다.
//  - 진행 중 자리(4개)에는 끝난 호출의 세션 중 대조가 맞는 것(남긴 세션)을 세지 않는다. 기록이 없거나 대조가 안 되는 세션은 진행 중으로 센다.
//  - 남긴 세션은 따로 6개까지다: `남긴 수 + 이번 인원 > 6`이면 가장 오래 남긴 것부터 같은 확인(killOwn)으로 끄고 그 탭을 닫는다(closeKeptTab).
//    남긴 세션 때문에 새 호출을 거절하지 않는다. 끄지 못한 세션은 그대로 두고 진행 중 쪽에 센다.
// 진행 중 자리가 모자라면 아무도 부르지 않는다(줄 세우기 없음). 한 세션을 만든 뒤 다음이 실패하면 만든 자기 세션을 끄고 던진다.
// calls: [{dir, model, effort?, token, timing?}]. 반환: seats[] (session.json 기록과 같은 값 + index).
export function openSeats({home, run, askId, calls, deadlineAt, now = Date.now, ownerPid = process.pid,
  reapMarginMs = REAP_MARGIN_MS, closeKeptTab = () => {}}) {
  const lock = path.join(home, 'senior-seats.lock');
  if (!acquireDirLock(lock)) throw new Error(`시니어 자리 잠금을 얻지 못했다(${lock}) — 다른 호출이 자리를 잡는 중이거나 멈춘 잠금이다`);
  const seats = [];
  const short = current => new Error(`시니어 대화형 자리가 모자란다(지금 ${current}개 + 이번 ${calls.length}명 > ${SENIOR_SEATS}) — 아무도 부르지 않는다. ` +
    '진행 중인 호출이 끝난 뒤 다시 불러라(끝난 세션은 자리를 차지하지 않는다 — 무엇이 남았는지는 kadan senior cleanup --dry-run)');
  try {
    const states = seniorSessionStates({home, run, now});
    let current = states.filter(row => row.state === 'active').length;
    // 내보내기 전에 한 번 본다: 어차피 못 부를 호출 때문에 남긴 세션을 끄지 않는다.
    if (current + calls.length > SENIOR_SEATS) throw short(current);
    const kept = states.filter(row => row.state === 'kept').sort((a, b) => keptOrder(a).localeCompare(keptOrder(b)));
    let over = kept.length + calls.length - SENIOR_KEPT;
    for (const old of kept) {
      if (over <= 0) break;
      const result = killOwn(old.dir, {run, reason: 'evicted'});
      if (result.killed || result.why === 'no-session') {
        over -= 1;
        try { closeKeptTab(old.dir, old.name); } catch { /* 탭은 꾸밈이다 */ }
      } else current += 1; // 끄지 못한 세션은 그대로 두고 진행 중 쪽에 센다.
    }
    if (current + calls.length > SENIOR_SEATS) throw short(current);
    // 실행기마다 한 번 하는 준비(agy의 고정 작업 폴더: git 밖 확인 → 에이전트 파일)를 세션을 하나도 만들기 전에 끝낸다.
    // 여기서 걸리면 던져 아무도 부르지 않는다. 잠금 안이라 첫 두 호출이 같은 폴더를 동시에 만들지 않는다.
    const prepared = new Map();
    for (const call of calls) {
      const key = call.runner ?? 'codex';
      const kind = seatKind(key);
      if (kind.prepare && !prepared.has(key)) prepared.set(key, kind.prepare(home));
    }
    const common = {home, run, askId, deadlineAt, now, ownerPid, reapMarginMs};
    for (const [index, call] of calls.entries()) {
      seats.push(createSeat({...common, call, index, shared: prepared.get(call.runner ?? 'codex')}));
    }
    return seats;
  } catch (error) {
    for (const seat of seats) killOwn(seat.dir, {run, reason: 'partial-create'});
    throw error;
  } finally {
    fs.rmdirSync(lock);
  }
}

// 판정용 화면: 스크롤 기록까지(-S) 색 포함(-e)으로 떠서 입력칸의 흐린 추천 문구를 뺀다. 감긴 줄은 이어 붙인다(-J).
export function captureSeat(run, session) {
  return splitGhostText(run(['capture-pane', '-e', '-p', '-J', '-S', '-400', '-t', `=${session}:`])).judge;
}

// 세션의 pane이 기록한 그 프로세스로 살아 있는가. 반환: {alive: true} | {alive: false, signal?}.
// 감싼 프로세스가 상한에 걸리면 TERM이 프로세스 묶음 전체에 가서, 그때 돌던 tmux 호출도 같이 끝난다. 그 한 번의 답은 믿을 수 없다:
//  - 진짜 tmux 클라이언트는 TERM을 받으면 종료 코드 0·출력 없이 끝난다(tmux 3.6a 관찰) — 답만 보면 죽은 세션과 같다.
//    2026-11-17 리눅스 CI에서 이 답을 pane-dead로 읽어 칸이 timeout이 아니라 call-failed로 남았다.
//  - 신호로 죽은 호출(signal이 있음)은 세션이 아니라 묻는 쪽이 죽은 것이다.
// 그래서 살아 있다는 답이 아니면 한 번 더 묻고, 그래도 아닐 때만 죽은 것으로 본다. 신호는 한 번만 오므로 다시 물으면 제 답이 나오고,
// 중단은 다음 대기에서 신호 처리기가 적는다.
export function paneAlive(run, seat) {
  const ask = () => run.try(['display-message', '-p', '-t', `=${seat.session}:`, '#{pane_pid}|#{pane_dead}']);
  const alive = result => result.status === 0 && result.stdout.trim() === `${seat.panePid}|0`;
  let result = ask();
  if (result.signal) return {alive: false, signal: result.signal};
  if (alive(result)) return {alive: true};
  result = ask();
  if (result.signal) return {alive: false, signal: result.signal};
  return {alive: alive(result)};
}
// 던져진 오류가 '신호로 죽은 tmux 호출'이면 그 신호 이름. sendTmux가 정리 실패를 묶어 던진 경우도 본다.
export function signalOf(error) { return error?.signal ?? error?.errors?.find(inner => inner?.signal)?.signal ?? null; }

// 제출 표지를 읽어 확인한다. 반환: {ok: true} | {ok: false, why}. why: absent(없음) · not-regular-file(링크·폴더 등, lstat) · too-big ·
// unreadable · bad-json · bad-shape · other-call(이번 호출·이번 자리의 값이 아님). 자식이 쓰는 값(askId·세션·pane PID·호출 폴더)이 부른 쪽의
// 자리 기록과 모두 같아야 한다. 있기만 하다고 믿지 않는다 — 깨진 글·폴더·링크·다른 호출의 표지로 탭이 열리지 않게 한다.
export function readSubmitted(dir, seat) {
  const file = path.join(dir, SUBMITTED_FILE);
  let stat;
  try { stat = fs.lstatSync(file); } catch { return {ok: false, why: 'absent'}; }
  if (!stat.isFile()) return {ok: false, why: 'not-regular-file'};
  if (stat.size > 4096) return {ok: false, why: 'too-big'};
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return {ok: false, why: error instanceof SyntaxError ? 'bad-json' : 'unreadable'}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {ok: false, why: 'bad-shape'};
  const same = value.askId === seat.askId && value.session === seat.session && value.dir === seat.dir &&
    String(value.panePid) === String(seat.panePid) && value.panePid != null;
  return same ? {ok: true} : {ok: false, why: 'other-call'};
}

// 탭을 열어도 되는가: 제출 표지가 맞고, 자식이 끝났다는 판정(outcome.json)이 아직 없고, 그 세션의 pane이 기록한 그 프로세스로 살아 있다.
// 열기 직전 한 번 본다. 그 뒤 세션이 끝나는 틈은 막을 수 없다(열린 탭은 기존 닫기·지우기가 정리한다).
export function submittedTabCheck(dir, seat, {run}) {
  const mark = readSubmitted(dir, seat);
  if (!mark.ok) return mark;
  if (readOutcome(dir) || !paneAlive(run, seat).alive) return {ok: false, why: 'session-ended'};
  return {ok: true};
}

// 한 줄을 넣는다. 바닥의 sendTmux(붙여넣기 → PID 재확인 → Enter)를 그대로 쓰되 전용 소켓 실행 함수와 기대 pane PID를 넘기고,
// 그 실행 함수의 키 명령 직전에 화면을 새로 읽어 검사한다. 허용하는 키는 붙여넣기와 Enter뿐이다.
// 시간 상한(호출 시작부터 잰 절대 마감 seat.deadlineAt)도 키 명령 직전마다 다시 본다: 끝났으면 그 키를 보내지 않는다(why: deadline).
// judge: 그 실행기 화면의 판정 묶음 {ready(화면), holds(화면, 글), capture(run, 세션)}. 주지 않으면 codex 화면 판정이다.
export function sendLine(seat, text, {run, keyGapS = SESSION_TIMING.keyGapS, spawn = spawnSync, now = Date.now,
  judge = {ready: composerReady, holds: composerHolds, capture: captureSeat}} = {}) {
  const expired = () => Number.isFinite(seat.deadlineAt) && now() >= seat.deadlineAt;
  const deny = (stage, why) => {
    const withheld = `시니어 세션에 키를 보내지 않는다(${stage}: ${why})`;
    return fail('KADAN_SENIOR_KEY_WITHHELD', withheld, {stage, why, withheld});
  };
  const guarded = (args, input) => {
    // 순서가 중요하다: 화면 읽기(외부 tmux 호출이라 시간이 든다)와 판정을 먼저 끝내고, 남은 시간은 키 명령 바로 앞에서 본다.
    // 마감 검사와 키 명령 사이에는 아무 호출도 두지 않는다 — 화면을 읽는 동안 끝난 상한도 여기서 걸린다.
    if (args[0] === 'paste-buffer') {
      const verdict = judge.ready(judge.capture(run, seat.session));
      if (expired()) throw deny('paste', 'deadline');
      if (!verdict.ok) throw deny('paste', verdict.why);
    } else if (args[0] === 'send-keys') {
      if (args.at(-1) !== 'Enter') throw deny('key', `허용하지 않은 키 ${args.at(-1)}`);
      const verdict = judge.holds(judge.capture(run, seat.session), text);
      if (expired()) throw deny('enter', 'deadline');
      if (!verdict.ok) throw deny('enter', verdict.why);
    }
    return run(args, input);
  };
  // sendTmux는 붙여넣기와 Enter 사이를 `sleep 1`로 띄운다. 그 간격만 주입할 수 있게 한다(시험용).
  const sleeper = (command, args, options) =>
    command === 'sleep' ? spawn('sleep', [String(keyGapS)]) : spawn(command, args, options);
  try { return sendTmux(seat.session, text, {run: guarded, expectedPid: seat.panePid, spawn: sleeper}); }
  catch (error) {
    // sendTmux는 붙여넣기 명령을 부르기 전에 '시도함'으로 적는다. 여기서 멈춘 것은 그 명령이 나가기 전이므로 바로잡는다.
    if (error.code === 'KADAN_SENIOR_KEY_WITHHELD') {
      const pasted = error.stage === 'enter';
      error.delivery = pasted ? 'unknown' : 'not-sent';
      error.message = `${error.withheld}${pasted ? ' — 본문은 붙었고 Enter는 보내지 않았다. 다시 넣지 않는다' : ''}`;
    }
    throw error;
  }
}

// `out/`이 git 저장소 안이면 codex 내장 worktree 도구가 쓸 수 있다. 저장소 밖일 때만 통과한다.
export function outsideGit(out, {spawn = spawnSync} = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const options = {encoding: 'utf8', env, timeout: 10_000};
  const result = spawn('git', ['-C', out, 'rev-parse', '--is-inside-work-tree'], options);
  if (result.error) return {ok: false, why: 'git-check-failed'};
  return result.status === 0 ? {ok: false, why: 'out-inside-git'} : {ok: true};
}

// 질문 넣기 전 관문(전원 준비의 일부). `out/`이 git 밖이고 codex가 빈 입력칸까지 떴을 때만 통과한다. 키는 보내지 않는다.
// 아니면 질문을 넣지 않는다(모델 호출 0회). 반환: {ok, why?, note?}. 던지지 않는다.
// MCP 연결 목록은 보지 않는다(2026-11-18 [kyle]: 사용자 codex 설정 그대로 — 지금 헤드리스 시니어와 같은 수준).
// 시간 상한이 준비 중에 끝났으면 {ok: false, why: 'deadline', timeout: true}로 끝낸다.
// 실행기별 관문은 자리 기록의 runner로 고른다(위 seatKind). 아래는 codex 관문이고 agy 관문은 src/senior-agy.mjs다.
export async function passGate(seat, deps) { return seatKind(seat.runner).gate(seat, deps); }

async function passGateCodex(seat, {run, now = Date.now, sleep = defaultSleep, timing = SESSION_TIMING,
  spawn = spawnSync}) {
  const evidence = {};
  const done = verdict => {
    const text = JSON.stringify({...verdict, ...evidence}, null, 1) + '\n';
    try { fs.writeFileSync(path.join(seat.dir, 'gate.json'), text, {mode: 0o600}); }
    catch { /* 근거 기록 실패가 판정을 바꾸지 않는다 */ }
    return verdict;
  };
  const expired = () => now() >= seat.deadlineAt;
  const late = during => ({ok: false, why: 'deadline', timeout: true, note: `시간 상한이 끝났다(${during})`});
  const untilScreen = async (limitMs, check) => {
    const until = Math.min(now() + limitMs, seat.deadlineAt);
    for (;;) {
      const pane = paneAlive(run, seat);
      if (!pane.alive) return {ok: false, why: pane.signal ? 'interrupted' : 'pane-dead'};
      // 살아 있음을 본 직후에 세션(마지막 세션이면 서버까지)이 사라지면 화면 읽기가 던진다. 그것도 죽은 pane이다.
      let screen;
      try { screen = captureSeat(run, seat.session); }
      catch (error) { return {ok: false, why: signalOf(error) ? 'interrupted' : 'pane-dead'}; }
      const verdict = check(evidence.screen = screen);
      if (verdict.ok || verdict.final) return verdict;
      if (now() >= until) return {ok: false, why: verdict.why};
      await sleep(Math.min(timing.pollMs, 500));
    }
  };
  try {
    const git = outsideGit(seat.out, {spawn});
    if (!git.ok) return done(git);
    fs.writeFileSync(seat.gate, '', {mode: 0o600});
    // 빈 입력칸이 보일 때까지만 기다린다. 업데이트 선택 창·번호 선택 창이 떠 있으면 끝내 키 0회로 실패한다.
    let ready = await untilScreen(timing.startupMs, composerReady);
    if (ready.ok) { await sleep(timing.settleMs); ready = await untilScreen(0, composerReady); }
    // 죽은 세션은 상한과 무관하게 죽은 것이다. 그 밖에 상한이 지났으면 무엇을 기다리다 끝났든 timeout이다.
    const stopped = why => why === 'pane-dead' || why === 'interrupted';
    if (expired() && !stopped(ready.why)) return done(late(ready.ok ? 'before-ask' : `startup:${ready.why}`));
    return done(ready.ok ? {ok: true} : {ok: false, why: `startup:${ready.why}`});
  } catch (error) {
    return done({ok: false, why: 'gate-error', note: String(error?.message ?? error)});
  }
}

export function readAnswerFile(file, marker) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return {ok: false, why: 'no-answer-file'}; }
  if (!stat.isFile()) return {ok: false, why: 'answer-not-regular-file'};
  if (stat.size > ANSWER_LIMIT_BYTES) return {ok: false, why: 'answer-too-big'};
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return {ok: false, why: 'answer-unreadable'}; }
  return readAnswerText(raw, marker);
}

// 질문 한 줄을 넣고 끝을 기다린다. 반환: {reason: ok|empty|limit|timeout|call-failed|interrupted, detail?, answer?}. 던지지 않는다.
// ok는 (1) 답 파일이 답 후보이고 (2) 질문을 넣은 뒤 화면이 일하는 표시를 거쳐 (3) 다시 빈 입력칸으로 쉴 때만이다.
// 이미 제출한 호출은 같은 폴링에서 완성된 답이 timeout보다 먼저다. 제출 전에 상한이 끝났으면 새 입력 없이 timeout이다.
// 처음의 쉬는 화면을 처리 완료로 세지 않는다. 너무 빨리 끝나 일하는 표시를 못 보면 ok로 받지 않는다(오성공 방지).
// 실행기별 질문·답 회수는 자리 기록의 runner로 고른다. 아래는 codex(답 파일)이고 agy(화면 스크롤)는 src/senior-agy.mjs다.
// 두 갈래 모두 같은 반환 모양(reason·detail·answer)으로 끝나 영수증·원장이 같은 글을 가리킨다.
export async function askSeat(seat, deps) { return seatKind(seat.runner).ask(seat, deps); }

async function askSeatCodex(seat, {run, now = Date.now, sleep = defaultSleep, timing = seat.timing ?? SESSION_TIMING,
  spawn = spawnSync, onSubmitted = () => {}}) {
  // 상한이 이미 끝났으면 아무것도 넣지 않는다. 넣는 도중(붙여넣기 직전·Enter 직전)에 끝나도 그 키는 나가지 않는다.
  if (now() >= seat.deadlineAt) return {reason: 'timeout', detail: 'deadline:before-ask'};
  try { sendLine(seat, seat.line, {run, keyGapS: timing.keyGapS, spawn, now}); }
  catch (error) {
    if (error.why === 'deadline') return {reason: 'timeout', detail: `deadline:${error.stage}`};
    if (signalOf(error)) return {reason: 'interrupted', detail: signalOf(error)};
    return {reason: 'call-failed', detail: `key:${keyWhy(error)} — ${error.message}`};
  }
  const submittedAt = now();
  // 질문이 들어갔다(Enter까지 tmux가 받았다). 이 뒤로는 이 세션에 키를 보내지 않는다 — 읽기 전용 탭은 이 알림을 받은 뒤에 붙는다.
  try { onSubmitted(); } catch { /* 알림은 꾸밈이다: 실패해도 호출은 그대로 간다 */ }
  const answerFile = path.join(seat.out, 'result.txt');
  let sawWorking = false, idle = 0;
  for (;;) {
    // tmux 호출이 신호로 죽었으면 세션이 죽은 것이 아니라 이 프로세스가 중단되는 중이다(interrupted — 부른 쪽이 상한 표시와 함께 읽는다).
    const pane = paneAlive(run, seat);
    if (pane.signal) return {reason: 'interrupted', detail: pane.signal};
    if (!pane.alive) return {reason: 'call-failed', detail: 'pane-dead'};
    let screen;
    try { screen = captureSeat(run, seat.session); }
    catch (error) {
      const signal = signalOf(error);
      return signal ? {reason: 'interrupted', detail: signal} : {reason: 'call-failed', detail: 'pane-dead'};
    }
    if (limitScreen(screen, now())) return {reason: 'limit', detail: 'limit-screen'};
    if (screenWorking(screen)) { sawWorking = true; idle = 0; }
    else if (composerReady(screen).ok) {
      idle += 1;
      if (idle >= timing.idleConfirm && sawWorking) {
        const read = readAnswerFile(answerFile, seat.marker);
        return read.ok ? {reason: 'ok', answer: read.answer} : {reason: 'empty', detail: read.why};
      }
      const waited = now() - submittedAt > timing.submitGraceMs;
      if (idle >= timing.idleConfirm && waited) return {reason: 'empty', detail: 'no-work-seen'};
    } else idle = 0;
    if (now() >= seat.deadlineAt) return {reason: 'timeout', detail: 'deadline'};
    await sleep(timing.pollMs);
  }
}

// 호출이 끝났다: 끝 화면을 남기고(읽기만 한다) 세션은 끄지 않은 채 남김 표시만 적는다(정상·실패·시간 초과 공통).
// 이 뒤로 이 세션에는 키를 하나도 보내지 않는다. 끄는 것은 정리 명령·내보내기다.
export function keepSeat(seat, {run, reason}) {
  try { fs.writeFileSync(path.join(seat.dir, 'screen-final.txt'), captureSeat(run, seat.session), {mode: 0o600}); }
  catch { /* 이미 없는 세션이면 화면이 없다 */ }
  return {kept: markKept(seat.dir, reason)};
}

export function writeOutcome(dir, outcome) {
  fs.writeFileSync(path.join(dir, 'outcome.json'), JSON.stringify(outcome, null, 1) + '\n', {mode: 0o600});
}
export function readOutcome(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'outcome.json'), 'utf8'));
    return typeof value?.reason === 'string' ? value : null;
  } catch { return null; }
}

// 감싸는 프로세스의 명령(기존 호출 프로세스 runJudgeProcess가 셸로 돌린다). 그 프로세스가 TERM을 받으면 남김 표시만 적고 나간다.
export const sessionRunCommand = (dir, node = process.execPath) =>
  `${quote(node)} ${quote(SESSION_ENTRY)} ask ${quote(dir)}`;
