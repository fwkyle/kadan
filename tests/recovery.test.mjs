import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {inspectRecovery, restoreRecovery} from '../src/recovery.mjs';
import {inspectCardSendIdentity} from '../src/ai-identity.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'recovery-'));
  const entries = [{kind: 'start', floor: 'tmux', role: 'super', session: 'kadan-super',
    t: '2026-01-01T00:00:00Z', cwd: home, cmd: 'agent', panePid: '20',
    roleProfile: 'super', by: 'secretary', rottieTerminalId: 'old'}];
  let pane = {pid: '20', dead: false, created: '123'};
  const calls = [];
  const deps = {home, entries, read: () => entries, livePane: () => pane,
    create: options => {calls.push(options); pane = {pid: '30', dead: false, created: '456'};
      return {panePid: '30'};},
    record: entry => entries.push({...entry, t: '2026-01-02T00:00:00Z'}),
    spawn: (bin, argv) => {calls.push({bin, argv});
      return {status: 0, stdout: JSON.stringify({ok: true, result: {terminal: {id: 'new'}}})};},
  };
  const context = inspectRecovery({terminal: 'old', session: 'kadan-super', 'pane-pid': '20', cwd: home}, deps);
  const flags = {context: JSON.stringify(context), command: 'agent --resume exact',
    'rottie-bin': '/fixture/rottie', 'allow-reuse': 'false'};
  return {deps, entries, flags, context, calls, setPane: value => {pane = value;}};
}

test('reboot rebuilds the exact role, conversation command and tmux attachment', () => {
  const f = fixture(); f.setPane(null);
  const result = restoreRecovery(f.flags, f.deps);
  assert.equal(result.context.terminalId, 'new');
  assert.equal(result.context.role, 'super');
  assert.equal(result.context.panePid, '30');
  assert.notEqual(result.context.startDigest, f.context.startDigest);
  assert.equal(f.calls[0].cmd, 'agent --resume exact');
  assert.equal(f.entries.at(-2).roleProfile, 'super');
  assert.equal(f.entries.at(-2).by, 'secretary');
  const command = f.calls[1].argv[f.calls[1].argv.indexOf('--command') + 1];
  assert.match(command, /tmux -u -S .* attach -t '=kadan-super'/);
  assert.match(f.calls[1].argv.join(' '), /kadan-recovery-/);
  assert.throws(() => restoreRecovery(f.flags, f.deps), /교체되거나 연결 정보/);
});

test('a replaced role never acquires the old conversation', () => {
  const f = fixture();
  f.entries.push({...f.entries[0], panePid: '99', rottieTerminalId: undefined, t: 'later'});
  assert.throws(() => inspectRecovery({terminal: 'old'}, f.deps), /교체됐을/);
  assert.throws(() => restoreRecovery(f.flags, f.deps), /교체되거나/);
  assert.equal(f.calls.length, 0);
});

test('stopped role, changed pane and changed cwd are refused', () => {
  const f = fixture();
  assert.throws(() => inspectRecovery({terminal: 'old', 'pane-pid': '99'}, f.deps), /PID가/);
  assert.throws(() => inspectRecovery({terminal: 'old', cwd: '/wrong'}, f.deps), /폴더가/);
  f.entries.push({kind: 'stop', session: 'kadan-super'});
  assert.throws(() => restoreRecovery(f.flags, f.deps), /직접 종료/);
});

test('live original can reconnect only with the explicit identity agreement', () => {
  const f = fixture();
  assert.throws(() => restoreRecovery(f.flags, f.deps), /이미 있습니다/);
  const result = restoreRecovery({...f.flags, 'allow-reuse': 'true'}, f.deps);
  assert.equal(result.context.panePid, '20');
  assert.equal(f.calls.length, 1);
  assert.equal(f.entries.filter(e => e.kind === 'start').length, 1);
});

test('PID reuse, dead pane, changed start fingerprint and server are refused', () => {
  for (const pane of [{pid:'20', dead:false, created:'999'}, {pid:'20', dead:true, created:'123'}]) {
    const f = fixture(); f.setPane(pane);
    assert.throws(() => restoreRecovery({...f.flags, 'allow-reuse':'true'}, f.deps), /이미 있습니다/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.entries[0].cmd = 'different';
  assert.throws(() => restoreRecovery(f.flags, f.deps), /교체되거나/);
  assert.throws(() => restoreRecovery({...f.flags,
    context: JSON.stringify({...f.context, socket:'another'})}, f.deps), /서버가/);
});

test('uncertain tab creation leaves a durable claim and never launches twice', () => {
  const f = fixture(); f.setPane(null);
  f.deps.spawn = () => ({status: 1, stdout: ''});
  assert.throws(() => restoreRecovery(f.flags, f.deps), /자동 재시도/);
  assert.equal(f.entries.at(-1).window, 'hidden');
  assert.equal(f.entries.at(-1).panePid, '30');
  // Simulate the original generation still visible after an interrupted write.
  f.entries.pop(); f.setPane(null);
  assert.throws(() => restoreRecovery(f.flags, f.deps), /이미 요청/);
  assert.equal(f.calls.filter(c => c.cmd).length, 1);
});

test('Rottie exec/quoted options preserve the restored role model and card identity', () => {
  const f = fixture();
  f.entries[0].cmd = "'/tools/codex' '--model' 'fixture-model'";
  const context = inspectRecovery({terminal: 'old'}, f.deps);
  assert.equal(context.model, 'fixture-model');
  f.setPane(null);
  const receipt = restoreRecovery({...f.flags, context: JSON.stringify(context),
    command: "exec '/tools/codex' 'resume' 'exact' '--model' 'fixture-model'"}, f.deps);
  const identity = inspectCardSendIdentity({entries: f.entries, session: 'kadan-super', currentPid: '30'});
  assert.equal(identity.ok, true);
  assert.equal(identity.model, 'fixture-model');
  assert.equal(receipt.context.model, 'fixture-model');
  assert.equal(f.entries.at(-2).harness, 'codex');
  assert.equal(f.calls[0].cmd.startsWith('exec '), false);
});

test('a model change in the saved context or resume command never launches a role', () => {
  const f = fixture(); f.entries[0].cmd = 'codex --model original-model';
  const context = inspectRecovery({terminal: 'old'}, f.deps); f.setPane(null);
  const flags = {...f.flags, context: JSON.stringify(context), command: 'codex resume exact --model wrong-model'};
  assert.throws(() => restoreRecovery(flags, f.deps), /모델이 원본 역할/);
  assert.throws(() => restoreRecovery({...flags,
    context:JSON.stringify({...context, model:'wrong-model'})}, f.deps), /원본 모델 정보/);
  assert.equal(f.calls.length, 0);
});

function claudeFixture(command = 'claude --model opus --effort high') {
  const f = fixture(); f.entries[0].cmd = command; f.setPane(null);
  f.flags.context = JSON.stringify(inspectRecovery({terminal: 'old'}, f.deps));
  f.flags.command = 'claude --resume exact --model opus --effort high';
  return f;
}

test('Claude effort survives role recovery and the next recovery generation', () => {
  const f = claudeFixture();
  assert.equal(JSON.parse(f.flags.context).effort, 'high');
  const result = restoreRecovery(f.flags, f.deps);
  assert.equal(result.context.effort, 'high');
  assert.match(f.calls[0].cmd, /--effort high/);
});

test('legacy recovery reads effort only from the exact previous role tab', () => {
  const f = claudeFixture('/tools/kadan-claude --model opus --effort=high');
  f.entries.push({...f.entries[0], rottieTerminalId: 'intermediate', panePid: '21',
    cmd: 'claude --resume exact --model opus', restoredFrom: 'old'});
  assert.equal(inspectRecovery({terminal: 'intermediate'}, f.deps).effort, 'high');
  f.entries[0].role = 'other';
  assert.throws(() => inspectRecovery({terminal: 'intermediate'}, f.deps), /원본 역할 기록/);
});

test('missing, changed or malformed effort never creates the role', () => {
  for (const command of ['claude --resume exact --model opus',
    'claude --resume exact --model opus --effort medium']) {
    const f = claudeFixture();
    assert.throws(() => restoreRecovery({...f.flags, command}, f.deps), /추론 강도가 원본/);
    assert.equal(f.calls.length, 0);
  }
  const f = claudeFixture();
  assert.throws(() => restoreRecovery({...f.flags,
    context: JSON.stringify({...JSON.parse(f.flags.context), effort: 'max'})}, f.deps), /원본 추론 강도/);
  f.entries[0].cmd = 'claude --model opus --effort=invalid';
  assert.throws(() => inspectRecovery({terminal: 'old'}, f.deps), /저장된 Claude/);
});
