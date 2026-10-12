// Login and Rottie share the same role-generation lock and exact resume lineage.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {acquireDirLock} from './dir-lock.mjs';
import {readSystemLedger, appendLedger} from './ledger.mjs';
import {commandWords} from './ai-identity.mjs';
import {buildStartLedgerEntry} from './cli-start-support.mjs';
import {currentRottieWindow} from './restore.mjs';

export const startDigest = entry => createHash('sha256').update(JSON.stringify(entry)).digest('hex');
const quote = word => `'${String(word).replace(/'/g, "'\\''")}'`;
const checkpointPath = home => path.join(home, 'secretary-resume.json');

function conversationOptions(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const offset = Math.max(0, size - 4 * 1024 * 1024);
    const bytes = Buffer.alloc(size - offset);
    fs.readSync(fd, bytes, 0, bytes.length, offset);
    let context;
    for (const line of bytes.toString('utf8').split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'turn_context') context = event.payload;
      } catch { /* Partial first/last JSONL lines carry no usable options. */ }
    }
    if (!context) return [];
    const args = [];
    if (typeof context.model === 'string' && /^[\w./:-]+$/.test(context.model)) {
      args.push('--model', context.model);
    }
    for (const [key, value, allowed] of [
      ['model_reasoning_effort', context.effort, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['approval_policy', context.approval_policy, ['never', 'on-request', 'on-failure', 'untrusted']],
      ['sandbox_mode', context.sandbox_policy?.type, ['danger-full-access', 'workspace-write', 'read-only']],
    ]) {
      if (allowed.includes(value)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    }
    return args;
  } finally { fs.closeSync(fd); }
}

export function withRecoveryLock(home, session, run) {
  const dir = path.join(home, 'recovery');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const lock = path.join(dir, `role-${startDigest(session)}.lock`);
  if (!acquireDirLock(lock)) throw new Error('역할 복원이 진행 중입니다. 중복 실행하지 않습니다.');
  try { return run(); } finally { fs.rmdirSync(lock); }
}

function secretaryStart(entries) {
  const events = entries.filter(e => e.session === 'kadan-비서');
  const index = events.findLastIndex(e => e.kind === 'start');
  if (index < 0) return null;
  if (events.slice(index + 1).some(e => e.kind === 'stop')) {
    throw new Error('직접 종료한 비서는 자동으로 복원하지 않습니다.');
  }
  return events[index];
}

export function transcriptIdentity(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(65536);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const first = JSON.parse(bytes.toString('utf8', 0, length).split('\n')[0]);
    if (first.type !== 'session_meta' || !first.payload?.id || !first.payload?.cwd) {
      throw new Error('비서 대화의 원본 정보를 확인하지 못했습니다.');
    }
    return {id: first.payload.id, cwd: first.payload.cwd};
  } finally { fs.closeSync(fd); }
}

// Only files held by this exact live pane's process tree are candidates. Never use "latest".
export function liveSecretaryTranscript(panePid, run = spawnSync) {
  const ps = run('ps', ['-axo', 'pid=,ppid='], {encoding: 'utf8', timeout: 2000});
  if (ps.status !== 0) throw new Error('비서 프로세스 조회 실패');
  const rows = ps.stdout.trim().split('\n').map(line => line.trim().split(/\s+/));
  const pids = new Set([String(panePid)]);
  for (let i = 0; i < rows.length; i++) {
    let changed = false;
    for (const [pid, parent] of rows) {
      if (pids.has(parent) && !pids.has(pid)) { pids.add(pid); changed = true; }
    }
    if (!changed) break;
  }
  const result = run('lsof', ['-p', [...pids].join(','), '-Fn'], {encoding: 'utf8', timeout: 3000});
  if (result.status !== 0) throw new Error('비서 대화 파일 조회 실패');
  const files = [...new Set(result.stdout.split('\n')
    .filter(line => /^n.*\/rollout-[^/]+\.jsonl$/.test(line)).map(line => line.slice(1)))];
  if (files.length !== 1) throw new Error('비서 대화 파일을 하나로 확인하지 못했습니다.');
  return files[0];
}

export function checkpointSecretary({home, floor, read = () => readSystemLedger(home),
  findTranscript = liveSecretaryTranscript} = {}) {
  const entries = read();
  const start = secretaryStart(entries);
  if (!start || floor.name !== 'tmux') return null;
  const words = commandWords(start.cmd);
  if (!words || words[0]?.split('/').pop() !== 'codex') return null;
  if (String(floor.pid(start.session)) !== String(start.panePid)) {
    throw new Error('비서의 현재 실행과 시작 기록이 다릅니다.');
  }
  const transcript = findTranscript(start.panePid);
  const identity = transcriptIdentity(transcript);
  if (identity.cwd !== start.cwd) throw new Error('비서 대화의 작업 폴더가 다릅니다.');
  let args = words.slice(1);
  if (args[0] === 'resume') {
    if (args[1] !== identity.id) throw new Error('비서 복원 명령과 실제 대화가 다릅니다.');
    args = args.slice(2);
  }
  const checkpoint = {version: 1, startDigest: startDigest(start), transcript,
    conversation: identity.id, cwd: start.cwd,
    command: [words[0], 'resume', identity.id, ...args, ...conversationOptions(transcript)]
      .map(quote).join(' ')};
  // Recheck the generation before atomically publishing the checkpoint.
  if (startDigest(secretaryStart(read())) !== checkpoint.startDigest
    || String(floor.pid(start.session)) !== String(start.panePid)) {
    throw new Error('비서 대화 정보를 저장하는 동안 역할이 바뀌었습니다.');
  }
  const file = checkpointPath(home);
  fs.mkdirSync(home, {recursive: true});
  fs.writeFileSync(file + '.tmp', JSON.stringify(checkpoint) + '\n', {mode: 0o600});
  fs.renameSync(file + '.tmp', file);
  return checkpoint;
}

export function resumeSecretary({home, floor, startNew, read = () => readSystemLedger(home),
  record = entry => appendLedger(entry, home)} = {}) {
  return withRecoveryLock(home, 'kadan-비서', () => {
    if (floor.alive('kadan-비서')) return 'reused';
    const entries = read();
    const start = secretaryStart(entries);
    if (!start) { startNew(); return 'started'; }
    const file = checkpointPath(home);
    if (!fs.existsSync(file)) throw new Error('이전 비서 대화 정보가 없습니다. 새 비서를 중복 생성하지 않습니다.');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const identity = transcriptIdentity(saved.transcript);
    const resumeWords = commandWords(saved.command);
    if (saved.version !== 1 || saved.startDigest !== startDigest(start)
      || saved.conversation !== identity.id || saved.cwd !== identity.cwd || saved.cwd !== start.cwd
      || resumeWords?.[0]?.split('/').pop() !== 'codex' || resumeWords[1] !== 'resume'
      || resumeWords[2] !== identity.id || !fs.statSync(saved.cwd).isDirectory()) {
      throw new Error('저장된 비서 대화와 현재 역할 기록이 다릅니다. 자동 복원을 중단합니다.');
    }
    const window = currentRottieWindow(entries, start.session);
    const evidence = floor.create({session: start.session, role: start.role,
      cwd: saved.cwd, cmd: saved.command});
    record({...buildStartLedgerEntry({floorName: 'tmux', role: start.role, session: start.session,
      evidence, window: 'hidden', cmd: saved.command, cwd: saved.cwd,
      rottieTerminalId: window?.rottieTerminalId}), roleProfile: start.roleProfile || 'secretary',
      by: start.by || '사람', secretaryResumeSource: saved.startDigest,
      secretaryConversation: saved.conversation});
    // Same conversation, new pane generation. Preserve the checkpoint if UI startup is later.
    const current = secretaryStart(read());
    if (!current || String(current.panePid) !== String(evidence.panePid)) {
      throw new Error('비서 복원 시작 기록 확인 필요. 자동 재시도하지 않습니다.');
    }
    fs.writeFileSync(file + '.tmp', JSON.stringify({...saved, startDigest: startDigest(current)}) + '\n',
      {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
    return 'restored';
  });
}

export function advanceSecretaryCheckpoint(home, previous, current, command) {
  if (current.role !== '비서' || !fs.existsSync(checkpointPath(home))) return;
  const saved = JSON.parse(fs.readFileSync(checkpointPath(home), 'utf8'));
  const words = commandWords(command);
  if (saved.startDigest !== previous || words?.[1] !== 'resume'
    || words[2] !== saved.conversation) return;
  const file = checkpointPath(home);
  fs.writeFileSync(file + '.tmp', JSON.stringify({...saved, startDigest: startDigest(current)}) + '\n',
    {mode: 0o600});
  fs.renameSync(file + '.tmp', file);
}

// An autostart may precede Rottie. Only a continuous exact-conversation lineage may attach.
export function resumedSecretaryStart(context, entries, command) {
  if (context.role !== '비서') return null;
  const events = entries.filter(e => e.session === context.session);
  const index = events.findIndex(e => e.kind === 'start' && startDigest(e) === context.startDigest);
  if (index < 0) return null;
  let previous = events[index], resumed = false;
  for (const event of events.slice(index + 1)) {
    if (event.kind === 'stop') return null;
    if (event.kind !== 'start') continue;
    if (event.secretaryResumeSource !== startDigest(previous) || event.cwd !== context.cwd
      || event.role !== context.role) return null;
    previous = event; resumed = true;
  }
  if (!resumed) return null;
  const words = commandWords(command);
  if (!words || words[0]?.split('/').pop() !== 'codex'
    || words[1] !== 'resume' || words[2] !== previous.secretaryConversation) return null;
  return previous;
}
