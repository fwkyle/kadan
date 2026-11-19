// Login and Rottie share the same role-generation lock and exact resume lineage.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {acquireDirLock} from './dir-lock.mjs';
import {readSystemLedger, appendLedger} from './ledger.mjs';
import {commandWords} from './ai-identity.mjs';
import {withInlineScreen} from './inline-screen.mjs';
import {buildStartLedgerEntry} from './cli-start-support.mjs';
import {currentRottieWindow} from './restore.mjs';
import {descendantPids, openFilesOf} from './process-tree.mjs';
import {mergeCodexOptions, dedupeResumeCommand, serializeWords} from './codex-option-merge.mjs';
import {secretaryCommandFromSettings, warnSecretarySkip} from './secretary-settings.mjs';

export const startDigest = entry => createHash('sha256').update(JSON.stringify(entry)).digest('hex');
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
  // 멈춘 잠금(도중에 죽은 restart 등)을 자동으로 지우지 않는다 — 사람이 확인하고 지우게 경로를 보인다(dir-lock 규칙).
  if (!acquireDirLock(lock)) throw new Error(`역할 복원이 진행 중입니다. 중복 실행하지 않습니다. 멈춘 잠금이면 확인 뒤 지운다: ${lock}`);
  try { return run(); } finally { fs.rmdirSync(lock); }
}

function secretaryStart(entries) {
  const events = entries.filter(e => e.session === 'kadan-비서');
  const index = events.findLastIndex(e => e.kind === 'start');
  if (index < 0) return null;
  // restart가 남긴 stop(restart:true)은 사용자가 직접 끈 것이 아니다 — 바로 이어서 같은 대화를 다시 연다.
  if (events.slice(index + 1).some(e => e.kind === 'stop' && e.restart !== true)) {
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
  let files;
  try { files = openFilesOf(descendantPids(panePid, run), run); }
  catch (error) { throw new Error(error.message.startsWith('프로세스') ? '비서 프로세스 조회 실패' : '비서 대화 파일 조회 실패'); }
  files = files.filter(file => /\/rollout-[^/]+\.jsonl$/.test(file));
  if (files.length !== 1) throw new Error('비서 대화 파일을 하나로 확인하지 못했습니다.');
  return files[0];
}

// 저장된 체크포인트가 지금 비서 시작 기록·대화 파일과 맞는지 본다. 복원(resumeSecretary)과 doctor가 같은 판정을 쓴다. 읽기만 한다.
function assertCheckpointMatches(saved, start) {
  const identity = transcriptIdentity(saved.transcript);
  const resumeWords = commandWords(saved.command);
  if (saved.version !== 1 || saved.startDigest !== startDigest(start)
    || saved.conversation !== identity.id || saved.cwd !== identity.cwd || saved.cwd !== start.cwd
    || resumeWords?.[0]?.split('/').pop() !== 'codex' || resumeWords[1] !== 'resume'
    || resumeWords[2] !== identity.id || !fs.statSync(saved.cwd).isDirectory()) {
    throw new Error('저장된 비서 대화와 현재 역할 기록이 다릅니다. 자동 복원을 중단합니다.');
  }
}

// doctor용 읽기 전용 조회. 파일을 만들거나 고치지 않는다. kind:
// 'none'(비서 시작 기록 없음) | 'stopped'(사람이 끔) | 'not-codex'(체크포인트 대상 아님) | 'missing' | 'broken' | 'ok'
export function inspectSecretaryCheckpoint({home, entries}) {
  let start;
  try { start = secretaryStart(entries); } catch (error) { return {kind: 'stopped', message: error.message}; }
  if (!start) return {kind: 'none'};
  const words = commandWords(start.cmd);
  const runner = words?.[0]?.split('/').pop() ?? null;
  if (runner !== 'codex') return {kind: 'not-codex', runner};
  const file = checkpointPath(home);
  if (!fs.existsSync(file)) return {kind: 'missing', file};
  try {
    assertCheckpointMatches(JSON.parse(fs.readFileSync(file, 'utf8')), start);
    return {kind: 'ok', file};
  } catch (error) { return {kind: 'broken', file, message: error.message}; }
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
  const head = [words[0], 'resume', identity.id];
  // 대화 옵션에 인용할 수 없는 낱말(줄바꿈)이 있으면 그 합치기만 건너뛰고 시작 명령 낱말로 저장한다.
  // 저장을 거절하면 옛 startDigest가 남아 다음 복원이 막힌다. 시작 명령 낱말은 이미 읽힌 것이라 언제나 인용된다.
  const command = serializeWords([...head, ...mergeCodexOptions(args, conversationOptions(transcript))])
    ?? serializeWords([...head, ...mergeCodexOptions(args)]);
  if (!command) throw new Error('비서 복원 명령을 안전하게 저장할 수 없습니다.');
  const checkpoint = {version: 1, startDigest: startDigest(start), transcript,
    conversation: identity.id, cwd: start.cwd, command};
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

// openTab({entries, session, role, cwd, panePid})은 로티 탭을 열고 {window, rottieTerminalId, ...}를 돌려준다(던지지 않음).
// 세션을 먼저 만든 뒤에만 부르고, 탭이 안 열려도(없음·실패·시간 초과) 시작은 성공이며 숨김으로 기록한다.
// 실행 모델 설정에 비서 자리가 있으면 저장된 명령의 모델·강도 값만 그 값으로 바꿔 연다(secretary-settings.mjs).
// onSettings(결과)는 세션을 만든 뒤 한 번 불린다. 기본은 적용하지 못한 이유를 표준 오류에 한 줄 낸다.
export function resumeSecretary({home, floor, startNew, read = () => readSystemLedger(home),
  record = entry => appendLedger(entry, home), startExtra = {}, openTab = null, onSettings = warnSecretarySkip} = {}) {
  return withRecoveryLock(home, 'kadan-비서', () => {
    if (floor.alive('kadan-비서')) return 'reused';
    const entries = read();
    const start = secretaryStart(entries);
    if (!start) { startNew(); return 'started'; }
    const file = checkpointPath(home);
    if (!fs.existsSync(file)) throw new Error('이전 비서 대화 정보가 없습니다. 새 비서를 중복 생성하지 않습니다.');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertCheckpointMatches(saved, start);
    const window = currentRottieWindow(entries, start.session);
    const savedCommand = dedupeResumeCommand(saved.command); // 이미 겹쳐 쌓인 체크포인트도 한 벌로 낫는다
    const fromSettings = secretaryCommandFromSettings({home, command: savedCommand});
    const command = withInlineScreen(fromSettings.command); // 옛 체크포인트에도 인라인 화면을 붙인다
    const evidence = floor.create({session: start.session, role: start.role,
      cwd: saved.cwd, cmd: command});
    try { onSettings(fromSettings); } catch { /* 알림 실패는 시작을 막지 않는다 */ }
    let tab = null;
    try { tab = openTab?.({entries, session: start.session, role: start.role, cwd: saved.cwd,
      panePid: evidence.panePid}) ?? null; } catch { /* 탭을 못 열어도 시작은 성공(숨김) */ }
    const tabOpened = tab?.window === 'rottie' && Boolean(tab.rottieTerminalId);
    record({...buildStartLedgerEntry({floorName: 'tmux', role: start.role, session: start.session,
      evidence, window: tabOpened ? 'rottie' : 'hidden', cmd: command, cwd: saved.cwd,
      rottieTerminalId: tabOpened ? tab.rottieTerminalId : window?.rottieTerminalId}),
      ...(tabOpened ? {rottieBundleId: tab.rottieBundleId, rottieConnect: tab.rottieConnect} : {}), roleProfile: start.roleProfile || 'secretary',
      by: start.by || '사람', secretaryResumeSource: saved.startDigest,
      secretaryConversation: saved.conversation, ...fromSettings.extra, ...startExtra});
    // Same conversation, new pane generation. Preserve the checkpoint if UI startup is later.
    const current = secretaryStart(read());
    if (!current || String(current.panePid) !== String(evidence.panePid)) {
      throw new Error('비서 복원 시작 기록 확인 필요. 자동 재시도하지 않습니다.');
    }
    // 체크포인트에는 실제로 띄운 명령(설정값을 입혔으면 그 값)을 남긴다. 이 세대의 시작 명령과 같아야 다음 체크포인트·
    // 로티 탭 복원의 원본 대조가 어긋나지 않고, 나중에 비서 자리를 비워도 옛 모델로 되돌아가지 않는다.
    const advanced = {...saved, command: fromSettings.command, startDigest: startDigest(current)};
    fs.writeFileSync(file + '.tmp', JSON.stringify(advanced) + '\n', {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
    return 'restored';
  });
}

// launched: 이번에 실제로 띄운 명령(인라인 화면 옵션 앞). 설정값을 입혀 띄웠을 때만 주고, 체크포인트의 명령도 그것으로 바꾼다.
export function advanceSecretaryCheckpoint(home, previous, current, command, launched = null) {
  if (current.role !== '비서' || !fs.existsSync(checkpointPath(home))) return;
  const saved = JSON.parse(fs.readFileSync(checkpointPath(home), 'utf8'));
  const words = commandWords(command);
  if (saved.startDigest !== previous || words?.[1] !== 'resume'
    || words[2] !== saved.conversation) return;
  const file = checkpointPath(home);
  fs.writeFileSync(file + '.tmp', JSON.stringify({...saved, ...(launched ? {command: launched} : {}),
    startDigest: startDigest(current)}) + '\n', {mode: 0o600});
  fs.renameSync(file + '.tmp', file);
}

// Rottie may start before login; its older plan need not contain implicit Codex settings.
// 반환: 저장된 체크포인트의 옵션으로 채운 명령(인라인 화면 옵션 앞), 또는 체크포인트가 이 세대 것이 아니면 null.
function savedSecretaryBase(home, context, command) {
  if (!fs.existsSync(checkpointPath(home))) return null;
  const saved = JSON.parse(fs.readFileSync(checkpointPath(home), 'utf8'));
  if (saved.startDigest !== context.startDigest) return null;
  const words = commandWords(command);
  const savedWords = commandWords(saved.command);
  const identity = transcriptIdentity(saved.transcript);
  if (words?.[0]?.split('/').pop() !== 'codex' || words[1] !== 'resume'
    || words[2] !== saved.conversation || savedWords?.[1] !== 'resume'
    || savedWords[2] !== identity.id || identity.id !== saved.conversation
    || identity.cwd !== context.cwd || saved.cwd !== context.cwd) {
    throw new Error('비서 복원 요청과 저장된 대화가 다릅니다.');
  }
  const joined = serializeWords([words[0], ...savedWords.slice(1)]);
  return joined ? dedupeResumeCommand(joined) : null;
}

// 로티 탭 복원이 비서를 띄울 명령. resumeSecretary와 같은 함수(secretaryCommandFromSettings)로 실행 모델 설정의 비서 자리 값을 입힌다.
// 반환: {command, base, settings, checkpoint}
// - base: 설정값을 입히기 전 명령(지금까지의 savedSecretaryCommand 결과와 글자까지 같다). 원본 역할과의 모델 대조는 이것으로 한다.
// - command: 실제로 띄울 명령. 비서 자리가 비었거나 적용하지 못했으면 base와 같다.
// - settings: secretaryCommandFromSettings의 결과(extra·applied·skipped). 비서가 아니면 null.
// - checkpoint: 설정값으로 값이 바뀌었을 때만, 체크포인트에 남길 명령(인라인 화면 옵션 앞).
export function savedSecretaryLaunch(home, context, command) {
  if (context.role !== '비서') return {command, base: command, settings: null, checkpoint: null};
  const plain = savedSecretaryBase(home, context, command);
  // 체크포인트가 이 세대 것이 아니면 로티가 준 명령이 바탕이다(이미 인라인 화면 옵션이 있을 수 있어 다시 붙이지 않는다).
  const base = plain === null ? command : withInlineScreen(plain);
  const settings = secretaryCommandFromSettings({home, command: plain ?? command});
  if (!settings.applied?.changed) return {command: base, base, settings, checkpoint: null};
  return {command: plain === null ? settings.command : withInlineScreen(settings.command), base, settings,
    checkpoint: plain === null ? null : settings.command};
}

export const savedSecretaryCommand = (home, context, command) => savedSecretaryLaunch(home, context, command).command;

// An autostart may precede Rottie. Only a continuous exact-conversation lineage may attach.
export function resumedSecretaryStart(context, entries, command) {
  if (context.role !== '비서') return null;
  const events = entries.filter(e => e.session === context.session);
  const index = events.findIndex(e => e.kind === 'start' && startDigest(e) === context.startDigest);
  if (index < 0) return null;
  let previous = events[index], resumed = false;
  for (const event of events.slice(index + 1)) {
    if (event.kind === 'stop') { if (event.restart === true) continue; return null; }
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
