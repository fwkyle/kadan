// Rottie owns conversation references; Kadan owns role generations and tmux creation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ledgerHome, readSystemLedger, appendLedger} from './ledger.mjs';
import {assertWritable} from './storage.mjs';
import {tmuxFloor, tmux, buildRottieCreateArgv, parseRottieCreateResult} from './floor-tmux.mjs';
import {currentRottieWindow} from './restore.mjs';
import {buildStartLedgerEntry} from './cli-start-support.mjs';
import {commandWords, launchIdentityOf} from './ai-identity.mjs';
import {reportRecovery} from './recovery-report.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const fail = message => { throw new Error(message); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value);

function latest(entries, session) {
  const events = entries.filter(e => e.session === session);
  const startIndex = events.findLastIndex(e => e.kind === 'start');
  if (startIndex < 0) fail('카단 역할 시작 기록이 없습니다.');
  if (events.slice(startIndex + 1).some(e => e.kind === 'stop')) {
    fail('직접 종료한 카단 역할은 복원하지 않습니다.');
  }
  const start = events[startIndex];
  if ((start.floor && start.floor !== 'tmux') || !start.panePid || !absolute(start.cwd)) {
    fail('tmux 역할 시작 기록이 불완전합니다.');
  }
  return start;
}

// Follow only the exact prior Rottie tab of this same role. Early recovery versions
// omitted --effort from the new start; the original start still owns that option.
function effortOf(start, entries, seen = new Set()) {
  if (seen.has(start) || seen.size >= 16) fail('추론 강도 복원 기록이 순환합니다.');
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
      fail('저장된 Claude 추론 강도를 확인하지 못했습니다.');
    }
  }
  if (effort) return effort;
  if (!start.restoredFrom) return undefined;
  const previous = entries.filter(e => e.kind === 'start' && e.session === start.session
    && e.role === start.role && e.cwd === start.cwd && e.rottieTerminalId === start.restoredFrom);
  if (previous.length !== 1) fail('추론 강도의 원본 역할 기록을 확인하지 못했습니다.');
  return effortOf(previous[0], entries, seen);
}

function socketContext(socketPath, home) {
  const socket = process.env.KADAN_SOCKET || process.env.KADAN_LITE_SOCKET || 'kadan';
  const root = process.env.TMUX_TMPDIR || '/tmp';
  const expected = path.join(fs.realpathSync(root), `tmux-${process.getuid()}`, socket);
  if (socketPath && path.resolve(socketPath) !== expected) fail('카단 tmux 서버 경로가 다릅니다.');
  return {home: fs.realpathSync(home), socket, tmuxTmpdir: fs.realpathSync(root)};
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
  const lines = result.stdout.trim().split('\n');
  if (lines.length !== 1) fail('여러 pane의 카단 역할은 자동 복원하지 않습니다.');
  const [pid, dead, created] = lines[0].split('\t');
  if (!/^\d+$/.test(pid) || !['0', '1'].includes(dead) || !/^\d+$/.test(created)) {
    fail('카단 pane 정보를 확인하지 못했습니다.');
  }
  return {pid, dead: dead === '1', created};
}

export function inspectRecovery(flags, deps = {}) {
  const home = deps.home || ledgerHome();
  const entries = deps.entries || readSystemLedger(home);
  const terminalId = flags.terminal;
  if (typeof terminalId !== 'string' || !terminalId) fail('원본 Rottie 탭 ID가 필요합니다.');
  const sessions = [...new Set(entries.filter(e => e.rottieTerminalId === terminalId).map(e => e.session))];
  const matches = sessions.filter(session => currentRottieWindow(entries, session)?.rottieTerminalId === terminalId);
  if (matches.length !== 1) fail('이 탭의 현재 카단 역할을 확인하지 못했습니다. 새 역할로 교체됐을 수 있습니다.');
  const session = matches[0];
  const start = latest(entries, session);
  if (session !== `kadan-${start.role}` || (flags.session && flags.session !== session)) {
    fail('카단 역할 주소가 다릅니다.');
  }
  if (flags.cwd && flags.cwd !== start.cwd) fail('카단 역할 작업 폴더가 다릅니다.');
  if (flags['pane-pid'] && String(flags['pane-pid']) !== String(start.panePid)) {
    fail('카단 역할의 pane PID가 다릅니다.');
  }
  const server = socketContext(flags['socket-path'], home);
  const pane = (deps.livePane || livePane)(session);
  const launch = launchIdentityOf(start.cmd);
  const effort = effortOf(start, entries);
  if (flags['pane-pid'] && (!pane || pane.dead || pane.pid !== String(start.panePid))) {
    fail('관찰한 카단 pane과 시작 기록이 다릅니다.');
  }
  return {
    version: 1, ...server, role: start.role, session, cwd: start.cwd, terminalId,
    startDigest: digest(start), panePid: String(start.panePid),
    ...(launch.ok ? {model: launch.model} : {}),
    ...(effort ? {effort} : {}),
    sessionCreated: pane && !pane.dead && pane.pid === String(start.panePid) ? pane.created : null,
  };
}

function validateContext(context, home, entries) {
  if (!context || context.version !== 1 || !absolute(context.home) || !absolute(context.tmuxTmpdir)) {
    fail('카단 복원 정보 형식이 잘못됐습니다.');
  }
  const server = socketContext(null, home);
  if (context.home !== server.home || context.socket !== server.socket || context.tmuxTmpdir !== server.tmuxTmpdir) {
    fail('카단 복원 저장소 또는 서버가 다릅니다.');
  }
  const start = latest(entries, context.session);
  if (digest(start) !== context.startDigest || start.role !== context.role || start.cwd !== context.cwd
    || currentRottieWindow(entries, context.session)?.rottieTerminalId !== context.terminalId) {
    fail('카단 역할이 교체되거나 연결 정보가 바뀌었습니다. 옛 역할은 복원하지 않습니다.');
  }
  const originalIdentity = launchIdentityOf(start.cmd);
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
  // Rottie uses exec for standalone PTYs. The stored Kadan command starts at the executable
  // so existing AI identity/card checks continue to recognize the restored role.
  const command = typeof flags.command === 'string' ? flags.command.replace(/^exec /, '') : flags.command;
  const bin = flags['rottie-bin'];
  if (typeof command !== 'string' || !command.trim() || !absolute(bin)) {
    fail('정확한 대화 복원 명령과 Rottie 실행 파일이 필요합니다.');
  }
  assertWritable(home);
  const read = deps.read || (() => readSystemLedger(home));
  const entries = read();
  const start = validateContext(context, home, entries);
  const resumedIdentity = launchIdentityOf(command);
  const originalIdentity = launchIdentityOf(start.cmd);
  if (originalIdentity.ok && (!resumedIdentity.ok || resumedIdentity.harness !== originalIdentity.harness
    || resumedIdentity.model !== originalIdentity.model)) {
    fail('복원 명령의 실행기 또는 모델이 원본 역할과 다릅니다.');
  }
  const effort = effortOf(start, entries);
  if (effort && effortOf({cmd: command}, []) !== effort) {
    fail('복원 명령의 추론 강도가 원본 역할과 다릅니다.');
  }
  if (!fs.statSync(context.cwd).isDirectory()) fail('카단 작업 폴더를 찾을 수 없습니다.');
  const pane = (deps.livePane || livePane)(context.session);
  if (pane && (pane.dead || flags['allow-reuse'] !== 'true'
    || pane.pid !== context.panePid || pane.created !== context.sessionCreated)) {
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
  validateContext(context, home, read());
  const evidence = pane ? {panePid: pane.pid} : (deps.create || tmuxFloor.create)({
    session: context.session, role: context.role, cwd: context.cwd, cmd: command,
  });
  const attachedPane = (deps.livePane || livePane)(context.session);
  if (!attachedPane || attachedPane.dead || attachedPane.pid !== String(evidence.panePid)
    || (pane && attachedPane.created !== pane.created)) {
    fail('카단 pane이 연결 전에 바뀌었습니다. 자동 재시도하지 않습니다.');
  }
  validateContext(context, home, read());
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
  if (!pane) recordStart(terminal.id);
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

export function recoveryCommand(argv, flags) {
  try {
    if (argv[0] !== 'report' && process.env.KADAN_FLOOR && process.env.KADAN_FLOOR !== 'tmux') fail('역할 복원은 tmux에서만 지원합니다.');
    const result = argv[0] === 'inspect' ? inspectRecovery(flags)
      : argv[0] === 'restore' ? restoreRecovery(flags)
      : argv[0] === 'report' ? reportRecovery(flags) : fail('recovery inspect|restore|report가 필요합니다.');
    console.log(JSON.stringify({schemaVersion: 1, ok: true, result}));
  } catch (error) {
    console.log(JSON.stringify({schemaVersion: 1, ok: false, error: {message: error.message}}));
    process.exitCode = 1;
  }
}
