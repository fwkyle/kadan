// Rottie owns conversation references; Kadan owns role generations and tmux creation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ledgerHome, readSystemLedger, readRecoveryLedger, appendLedger} from './ledger.mjs';
import {assertWritable, storageMode} from './storage.mjs';
import {tmuxFloor, tmux, buildRottieCreateArgv, parseRottieCreateResult} from './floor-tmux.mjs';
import {currentRottieWindow} from './restore.mjs';
import {buildStartLedgerEntry} from './cli-start-support.mjs';
import {commandWords, launchIdentityOf} from './ai-identity.mjs';
import {reportRecovery} from './recovery-report.mjs';
import {resumedSecretaryStart, withRecoveryLock, advanceSecretaryCheckpoint,
  liveSecretaryTranscript, transcriptIdentity, savedSecretaryCommand} from './secretary-resume.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
// 조회 실패의 종류(recovery inspect의 error.kind). refused면 Rottie가 저장한 역할 정보를 지우므로
// 카단이 판단해서 거절한 지점에만 직접 붙인다. 붙이지 않은 실패와 모르는 예외는 모두 unavailable이다.
const fail = (message, kind) => { throw Object.assign(new Error(message), kind ? {recoveryKind: kind} : {}); };
const REFUSED = 'refused', INVALID = 'invalid', UNAVAILABLE = 'unavailable';
const KINDS = [REFUSED, UNAVAILABLE, INVALID];
export const recoveryErrorKind = error => KINDS.includes(error?.recoveryKind) ? error.recoveryKind : UNAVAILABLE;
const absolute = value => typeof value === 'string' && path.isAbsolute(value);

function latest(entries, session) {
  const events = entries.filter(e => e.session === session);
  const startIndex = events.findLastIndex(e => e.kind === 'start');
  if (startIndex < 0) fail('카단 역할 시작 기록이 없습니다.', REFUSED);
  if (events.slice(startIndex + 1).some(e => e.kind === 'stop')) {
    fail('직접 종료한 카단 역할은 복원하지 않습니다.', REFUSED);
  }
  const start = events[startIndex];
  if ((start.floor && start.floor !== 'tmux') || !start.panePid || !absolute(start.cwd)) {
    fail('tmux 역할 시작 기록이 불완전합니다.', REFUSED);
  }
  return start;
}

// Follow only the exact prior Rottie tab of this same role. Early recovery versions
// omitted --effort from the new start; the original start still owns that option.
function effortOf(start, entries, seen = new Set()) {
  if (seen.has(start) || seen.size >= 16) fail('추론 강도 복원 기록이 순환합니다.', REFUSED);
  seen.add(start);
  const words = commandWords(start.cmd);
  if (!words) return undefined;
  const executable = words.find(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))?.split('/').pop();
  if (!['claude', 'kadan-claude'].includes(executable)) return undefined;
  let effort;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === '--') break;
    if (words[i] === '--effort') effort = words[++i];
    else if (words[i].startsWith('--effort=')) effort = words[i].slice(9);
    else continue;
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      fail('저장된 Claude 추론 강도를 확인하지 못했습니다.', REFUSED);
    }
  }
  if (effort) return effort;
  if (!start.restoredFrom) return undefined;
  const previous = entries.filter(e => e.kind === 'start' && e.session === start.session
    && e.role === start.role && e.cwd === start.cwd && e.rottieTerminalId === start.restoredFrom);
  if (previous.length !== 1) fail('추론 강도의 원본 역할 기록을 확인하지 못했습니다.', REFUSED);
  return effortOf(previous[0], entries, seen);
}

function assertSocketPath(socketPath) {
  const socket = process.env.KADAN_SOCKET || process.env.KADAN_LITE_SOCKET || 'kadan';
  const root = process.env.TMUX_TMPDIR || '/tmp';
  const expected = path.join(fs.realpathSync(root), `tmux-${process.getuid()}`, socket);
  if (socketPath && path.resolve(socketPath) !== expected) fail('카단 tmux 서버 경로가 다릅니다.', INVALID);
  return {socket, tmuxTmpdir: fs.realpathSync(root)};
}

function socketContext(socketPath, home) {
  const {socket, tmuxTmpdir} = assertSocketPath(socketPath);
  return {home: fs.realpathSync(home), socket, tmuxTmpdir};
}

function livePane(session, run = tmux) {
  // -N prevents a read-only probe from starting a tmux server.
  const result = run(['-N', 'list-panes', '-s', '-t', `=${session}:`,
    '-F', '#{pane_pid}\t#{pane_dead}\t#{session_created}']);
  if (result.status !== 0) {
    if (/can't find session|can't find window|no server running|No such file or directory/.test(result.stderr || '')) {
      return null;
    }
    fail(`카단 tmux 조회 실패: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return onePane(result.stdout.trim().split('\n'));
}

function onePane(lines) {
  if (lines.length !== 1) fail('여러 pane의 카단 역할은 자동 복원하지 않습니다.', REFUSED);
  const [pid, dead, created] = lines[0].split('\t');
  if (!/^\d+$/.test(pid) || !['0', '1'].includes(dead) || !/^\d+$/.test(created)) {
    fail('카단 pane 정보를 확인하지 못했습니다.');
  }
  return {pid, dead: dead === '1', created};
}

// 묶음 조회용: 서버의 모든 pane을 읽기 전용 목록 조회 한 번으로 읽어 세션별로 답한다. 실패도 한 번만 겪는다
// (항목마다 tmux를 다시 부르지 않는다). 아무 항목도 pane 확인까지 가지 않으면 tmux를 부르지 않는다.
// 세션 이름을 마지막 칸에 둬서 이름에 탭이 있어도 앞 칸이 밀리지 않는다.
function sharedLivePane(run = tmux) {
  let state;
  const load = () => {
    const result = run(['-N', 'list-panes', '-a',
      '-F', '#{pane_pid}\t#{pane_dead}\t#{session_created}\t#{session_name}']);
    if (result.status !== 0) {
      if (/no server running|No such file or directory/.test(result.stderr || '')) return {panes: new Map()};
      return {error: `카단 tmux 조회 실패: ${(result.stderr || result.error?.message || '').trim()}`};
    }
    const panes = new Map();
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const [pid, dead, created, ...name] = line.split('\t');
      const session = name.join('\t');
      panes.set(session, [...(panes.get(session) || []), [pid, dead, created].join('\t')]);
    }
    return {panes};
  };
  return session => {
    if (!state) { try { state = load(); } catch (error) { state = {thrown: error}; } }
    if (state.thrown) throw state.thrown;
    if (state.error) fail(state.error);
    const lines = state.panes.get(session);
    return lines ? onePane(lines) : null;
  };
}

export function inspectRecovery(flags, deps = {}) {
  const home = deps.home || ledgerHome();
  const entries = deps.entries || readRecoveryLedger(home);
  const terminalId = flags.terminal;
  if (typeof terminalId !== 'string' || !terminalId) fail('원본 Rottie 탭 ID가 필요합니다.', INVALID);
  // 다른 카단 서버의 탭은 이 원장에 없다. 서버 경로를 먼저 대조해야 그 탭을 "교체됨"(거절)으로 답하지 않는다.
  if (flags['socket-path']) assertSocketPath(flags['socket-path']);
  const sessions = [...new Set(entries.filter(e => e.rottieTerminalId === terminalId).map(e => e.session))];
  const matches = sessions.filter(session => currentRottieWindow(entries, session)?.rottieTerminalId === terminalId);
  if (matches.length !== 1) {
    // 원장 저장소가 아예 없는 홈(홈을 잘못 가리킨 호출)은 판단할 근거가 없다. 문구는 같고 종류만 unavailable이다.
    const judged = deps.entries || storageMode(home) !== 'none';
    fail('이 탭의 현재 카단 역할을 확인하지 못했습니다. 새 역할로 교체됐을 수 있습니다.', judged ? REFUSED : undefined);
  }
  const session = matches[0];
  const start = latest(entries, session);
  if (session !== `kadan-${start.role}` || (flags.session && flags.session !== session)) {
    fail('카단 역할 주소가 다릅니다.', REFUSED);
  }
  if (flags.cwd && flags.cwd !== start.cwd) fail('카단 역할 작업 폴더가 다릅니다.', REFUSED);
  if (flags['pane-pid'] && String(flags['pane-pid']) !== String(start.panePid)) {
    fail('카단 역할의 pane PID가 다릅니다.', REFUSED);
  }
  const server = socketContext(flags['socket-path'], home);
  const pane = (deps.livePane || (name => livePane(name, deps.tmux)))(session);
  const launch = launchIdentityOf(start.cmd);
  const effort = effortOf(start, entries);
  if (flags['pane-pid'] && (!pane || pane.dead || pane.pid !== String(start.panePid))) {
    fail('관찰한 카단 pane과 시작 기록이 다릅니다.', REFUSED);
  }
  return {
    version: 1, ...server, role: start.role, session, cwd: start.cwd, terminalId,
    startDigest: digest(start), panePid: String(start.panePid),
    ...(launch.ok ? {model: launch.model} : {}),
    ...(effort ? {effort} : {}),
    sessionCreated: pane && !pane.dead && pane.pid === String(start.panePid) ? pane.created : null,
  };
}

function validateContext(context, home, entries, command) {
  if (!context || context.version !== 1 || !absolute(context.home) || !absolute(context.tmuxTmpdir)) {
    fail('카단 복원 정보 형식이 잘못됐습니다.');
  }
  const server = socketContext(null, home);
  if (context.home !== server.home || context.socket !== server.socket || context.tmuxTmpdir !== server.tmuxTmpdir) {
    fail('카단 복원 저장소 또는 서버가 다릅니다.');
  }
  const start = latest(entries, context.session);
  const resumed = resumedSecretaryStart(context, entries, command);
  if ((!resumed && digest(start) !== context.startDigest) || start.role !== context.role || start.cwd !== context.cwd
    || currentRottieWindow(entries, context.session)?.rottieTerminalId !== context.terminalId) {
    fail('카단 역할이 교체되거나 연결 정보가 바뀌었습니다. 옛 역할은 복원하지 않습니다.');
  }
  const original = resumed ? entries.find(e => e.kind === 'start' && digest(e) === context.startDigest) : start;
  const originalIdentity = launchIdentityOf(original.cmd);
  if ((originalIdentity.ok ? originalIdentity.model : undefined) !== context.model) {
    fail('카단 역할의 원본 모델 정보가 다릅니다.');
  }
  if (context.effort !== undefined && context.effort !== effortOf(start, entries)) {
    fail('카단 역할의 원본 추론 강도가 다릅니다.');
  }
  return start;
}

export function restoreRecovery(flags, deps = {}) {
  const home = deps.home || ledgerHome();
  const context = JSON.parse(flags.context || 'null');
  if (!context?.session) fail('카단 복원 역할 주소가 필요합니다.');
  return withRecoveryLock(home, context.session, () => restoreLocked(flags, deps));
}

function restoreLocked(flags, deps) {
  const home = deps.home || ledgerHome();
  const context = JSON.parse(flags.context || 'null');
  // Rottie uses exec for standalone PTYs. The stored Kadan command starts at the executable
  // so existing AI identity/card checks continue to recognize the restored role.
  const requested = typeof flags.command === 'string' ? flags.command.replace(/^exec /, '') : flags.command;
  const command = savedSecretaryCommand(home, context, requested);
  const bin = flags['rottie-bin'];
  if (typeof command !== 'string' || !command.trim() || !absolute(bin)) {
    fail('정확한 대화 복원 명령과 Rottie 실행 파일이 필요합니다.');
  }
  assertWritable(home);
  const read = deps.read || (() => readSystemLedger(home));
  const entries = read();
  const start = validateContext(context, home, entries, command);
  const autostart = resumedSecretaryStart(context, entries, command);
  const resumedIdentity = launchIdentityOf(command);
  const originalIdentity = launchIdentityOf(start.cmd);
  if (!autostart && originalIdentity.ok && (!resumedIdentity.ok || resumedIdentity.harness !== originalIdentity.harness
    || resumedIdentity.model !== originalIdentity.model)) {
    fail('복원 명령의 실행기 또는 모델이 원본 역할과 다릅니다.');
  }
  const effort = effortOf(start, entries);
  if (effort && effortOf({cmd: command}, []) !== effort) {
    fail('복원 명령의 추론 강도가 원본 역할과 다릅니다.');
  }
  if (!fs.statSync(context.cwd).isDirectory()) fail('카단 작업 폴더를 찾을 수 없습니다.');
  const pane = (deps.livePane || livePane)(context.session);
  if (autostart && pane && (deps.secretaryConversation || (pid =>
    transcriptIdentity(liveSecretaryTranscript(pid)).id))(pane.pid) !== start.secretaryConversation) {
    fail('자동 복원된 비서의 실제 대화가 다릅니다. 새 비서를 만들지 않습니다.');
  }
  if (pane && (pane.dead || (autostart
    ? pane.pid !== String(start.panePid)
    : flags['allow-reuse'] !== 'true' || pane.pid !== context.panePid
      || pane.created !== context.sessionCreated))) {
    fail('같은 이름의 카단 역할이 이미 있습니다. 새 역할이나 빈 pane에 옛 대화를 넣지 않습니다.');
  }
  const dir = path.join(home, 'recovery');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const claim = path.join(dir, `${digest(context)}.json`);
  let fd;
  try { fd = fs.openSync(claim, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') fail('이 역할 복원을 이미 요청했습니다. 새 탭을 먼저 확인하세요.');
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify({state: 'claimed', context})); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  // Recheck after claiming. A concurrent new-session also fails atomically on name collision.
  validateContext(context, home, read(), command);
  const evidence = pane ? {panePid: pane.pid} : (deps.create || tmuxFloor.create)({
    session: context.session, role: context.role, cwd: context.cwd, cmd: command,
  });
  const attachedPane = (deps.livePane || livePane)(context.session);
  if (!attachedPane || attachedPane.dead || attachedPane.pid !== String(evidence.panePid)
    || (pane && attachedPane.created !== pane.created)) {
    fail('카단 pane이 연결 전에 바뀌었습니다. 자동 재시도하지 않습니다.');
  }
  validateContext(context, home, read(), command);
  const recordStart = terminalId => (deps.record || (entry => appendLedger(entry, home)))({
    ...buildStartLedgerEntry({floorName: 'tmux', role: context.role, session: context.session,
      evidence, window: terminalId ? 'rottie' : 'hidden', rottieTerminalId: terminalId,
      cmd: command, cwd: context.cwd}),
    ...(start.roleProfile ? {roleProfile: start.roleProfile} : {}),
    ...(resumedIdentity.ok ? {
      harness: resumedIdentity.harness, model: resumedIdentity.model,
    } : {}),
    by: start.by || '사람', restoredFrom: context.terminalId, recoverySource: context.startDigest,
  });
  const socketPath = path.join(context.tmuxTmpdir, `tmux-${process.getuid()}`, context.socket);
  const argv = buildRottieCreateArgv({role: context.role, session: context.session, cwd: context.cwd,
    panePid: evidence.panePid, command: `tmux -u -S ${quote(socketPath)} attach -t ${quote(`=${context.session}`)}`,
    idempotencyKey: `kadan-recovery-${digest(context)}`});
  const result = (deps.spawn || spawnSync)(bin, argv, {encoding: 'utf8', timeout: 15000});
  const terminal = parseRottieCreateResult(result.stdout || '');
  if (result.status !== 0 || !terminal.ok) {
    if (!pane) recordStart(undefined);
    fail('역할은 시작됐을 수 있으나 Rottie 탭 연결을 확인하지 못했습니다. 자동 재시도하지 않습니다.');
  }
  if (!pane) {
    recordStart(terminal.id);
    advanceSecretaryCheckpoint(home, context.startDigest, latest(read(), context.session), command);
  }
  (deps.record || (entry => appendLedger(entry, home)))({kind: 'window', role: context.role,
    session: context.session, panePid: evidence.panePid, rottieTerminalId: terminal.id,
    restoredFrom: context.terminalId, by: '사람'});
  const refreshed = inspectRecovery({terminal: terminal.id, cwd: context.cwd}, {
    ...deps, home, entries: read(),
  });
  const receipt = {role: context.role, session: context.session, terminalId: terminal.id, context: refreshed};
  fs.writeFileSync(claim, JSON.stringify({state: 'completed', result: receipt}), {mode: 0o600});
  return receipt;
}

const ITEM_FIELDS = {session: 'session', cwd: 'cwd', panePid: 'pane-pid', socketPath: 'socket-path'};
const BATCH_LIMIT = 32;
const batchFail = (message, code) => { throw Object.assign(new Error(message), {batchCode: code}); };
const itemError = error => ({message: error.message, kind: recoveryErrorKind(error)});

// 묶음 항목 하나를 단건 조회의 인자 꼴로 바꾼다. 빈 칸(null·없음)은 주지 않은 것이다.
function itemFlags(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail('조회 항목이 객체가 아닙니다.', INVALID);
  const flags = {terminal: item.terminal};
  for (const [key, flag] of Object.entries(ITEM_FIELDS)) {
    const value = item[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') fail(`조회 항목의 ${key} 칸은 문자열이어야 합니다.`, INVALID);
    flags[flag] = value;
  }
  return flags;
}

// 탭 여러 개를 한 번에 묻는다. 원장은 한 번(같은 스냅샷), 살아 있는 pane 목록도 한 번만 읽고
// 항목마다 단건과 같은 inspectRecovery를 거친다. 항목 실패는 그 항목의 error로만 남고 명령은 성공이다.
export function inspectRecoveryBatch(input, deps = {}) {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1 || !Array.isArray(input.items)) {
    batchFail('묶음 조회 입력은 {"schemaVersion":1,"items":[…]} 모양이어야 합니다.', 'batch-invalid');
  }
  if (input.items.length > BATCH_LIMIT) {
    batchFail(`묶음 조회는 한 번에 ${BATCH_LIMIT}개까지입니다.`, 'batch-too-many');
  }
  const home = deps.home || ledgerHome();
  let entries = deps.entries;
  try {
    // 저장소가 없는 홈을 빈 원장으로 읽으면 모든 항목이 거절로 나가 Rottie가 저장한 역할 정보를 모두 지운다.
    if (!entries && storageMode(home) === 'none') fail('원장 저장소가 없습니다.');
    entries ??= readRecoveryLedger(home);
  } catch (error) { batchFail(`카단 원장을 읽지 못했습니다: ${error.message}`, 'store-unreadable'); }
  const shared = {...deps, home, entries, livePane: deps.livePane || sharedLivePane(deps.tmux)};
  return input.items.map(item => {
    const terminal = typeof item?.terminal === 'string' ? item.terminal : null;
    try { return {terminal, ok: true, result: inspectRecovery(itemFlags(item), shared)}; }
    catch (error) { return {terminal, ok: false, error: itemError(error)}; }
  });
}

// 표준 입력이 터미널이면 기다리지 않는다(Rottie의 명령 시간 상한 안에 답해야 한다).
function readBatchInput(read = () => (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'))) {
  let text;
  try { text = read(); } catch { text = ''; }
  if (!text.trim()) batchFail('묶음 조회 입력(표준 입력 JSON)이 없습니다.', 'batch-invalid');
  try { return JSON.parse(text); }
  catch { return batchFail('묶음 조회 입력이 JSON이 아닙니다.', 'batch-invalid'); }
}

// 묶음의 전체 실패에는 code가 꼭 있다. Rottie는 code 없는 ok:false를 옛 카단으로 보고 단건으로 내려간다.
export function recoveryBatchOutput(io = {}) {
  try {
    if (process.env.KADAN_FLOOR && process.env.KADAN_FLOOR !== 'tmux') {
      batchFail('역할 복원은 tmux에서만 지원합니다.', 'not-tmux');
    }
    const results = inspectRecoveryBatch(readBatchInput(io.read), io.deps);
    return {exitCode: 0, body: {schemaVersion: 1, ok: true, results}};
  } catch (error) {
    return {exitCode: 1, body: {schemaVersion: 1, ok: false,
      error: {message: error.message, code: error.batchCode || 'internal'}}};
  }
}

export function recoveryCommand(argv, flags) {
  if (argv[0] === 'inspect' && flags.batch !== undefined) {
    const output = recoveryBatchOutput();
    console.log(JSON.stringify(output.body));
    if (output.exitCode) process.exitCode = output.exitCode;
    return;
  }
  try {
    if (argv[0] !== 'report' && process.env.KADAN_FLOOR && process.env.KADAN_FLOOR !== 'tmux') fail('역할 복원은 tmux에서만 지원합니다.');
    const result = argv[0] === 'inspect' ? inspectRecovery(flags)
      : argv[0] === 'restore' ? restoreRecovery(flags)
      : argv[0] === 'report' ? reportRecovery(flags) : fail('recovery inspect|restore|report가 필요합니다.');
    console.log(JSON.stringify({schemaVersion: 1, ok: true, result}));
  } catch (error) {
    // 실패 종류는 조회(inspect)에만 붙인다. restore·report 출력은 그대로다.
    const kind = argv[0] === 'inspect' ? {kind: recoveryErrorKind(error)} : {};
    console.log(JSON.stringify({schemaVersion: 1, ok: false, error: {message: error.message, ...kind}}));
    process.exitCode = 1;
  }
}
