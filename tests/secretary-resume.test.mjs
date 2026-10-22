import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {checkpointSecretary, resumeSecretary, startDigest, withRecoveryLock,
  advanceSecretaryCheckpoint, savedSecretaryCommand} from '../src/secretary-resume.mjs';
import {commandWords} from '../src/ai-identity.mjs';
import {serializeWords} from '../src/codex-option-merge.mjs';
import {inspectRecovery, restoreRecovery} from '../src/recovery.mjs';
import {runUp} from '../src/quickstart.mjs';

function fixture(startCmd) {
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'secretary-'));
  const transcript = path.join(home, 'rollout-exact.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({type: 'session_meta',
    payload: {id: 'exact-conversation', cwd: home}}) + '\n');
  const entries = [{kind: 'start', floor: 'tmux', role: '비서', session: 'kadan-비서',
    panePid: '20', cwd: home, roleProfile: 'secretary', rottieTerminalId: 'old',
    cmd: startCmd ?? 'codex --model test-model -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox'}];
  let pane = {pid: '20', dead: false, created: '100'};
  const calls = [];
  const floor = {name: 'tmux', alive: () => Boolean(pane), pid: () => pane?.pid,
    create: options => {calls.push(options); pane = {pid: '30', dead: false, created: '200'};
      return {panePid: '30'};}};
  const deps = {home, floor, read: () => entries, record: e => entries.push(e),
    findTranscript: () => transcript, startNew: () => calls.push('new')};
  const recoveryDeps = {...deps, entries, livePane: () => pane, create: floor.create,
    secretaryConversation: () => 'exact-conversation',
    spawn: () => {calls.push('attach'); return {status: 0,
      stdout: JSON.stringify({ok: true, result: {terminal: {id: 'new'}}})};}};
  const context = inspectRecovery({terminal: 'old'}, recoveryDeps);
  const checkpoint = checkpointSecretary(deps);
  return {home, transcript, entries, calls, deps, recoveryDeps, context, checkpoint,
    setPane: value => {pane = value;}};
}

test('login resumes exact conversation/options without a new prompt and repeated up reuses it', () => {
  const f = fixture(); f.setPane(null);
  assert.equal(resumeSecretary(f.deps), 'restored');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].cmd, /'resume' 'exact-conversation'/);
  assert.match(f.calls[0].cmd, /model_reasoning_effort=high/);
  assert.match(f.calls[0].cmd, /--dangerously-bypass-approvals-and-sandbox/);
  assert.equal(f.entries.at(-1).roleProfile, 'secretary');
  assert.equal(f.entries.at(-1).secretaryResumeSource, f.context.startDigest);
  assert.equal(resumeSecretary(f.deps), 'reused');
  assert.equal(f.calls.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'secretary-resume.json')));
  assert.equal(saved.startDigest, startDigest(f.entries.at(-1)));
});

test('autostart first: Rottie attaches same live conversation and never creates another AI', () => {
  const f = fixture(); f.setPane(null); resumeSecretary(f.deps);
  const result = restoreRecovery({context: JSON.stringify(f.context), command: f.checkpoint.command,
    'rottie-bin': '/fixture/rottie', 'allow-reuse': 'false'}, f.recoveryDeps);
  assert.equal(result.context.panePid, '30');
  assert.equal(result.terminalId, 'new');
  assert.equal(f.calls.filter(c => typeof c === 'object').length, 1);
  assert.equal(f.entries.filter(e => e.kind === 'start').length, 2);
  assert.equal(inspectRecovery({terminal: 'new'}, f.recoveryDeps).role, '비서');
});

test('Rottie first: login reuses restored pane and checkpoint advances to its generation', () => {
  const f = fixture(); f.setPane(null);
  restoreRecovery({context: JSON.stringify(f.context), command: f.checkpoint.command,
    'rottie-bin': '/fixture/rottie'}, f.recoveryDeps);
  const current = f.entries.findLast(e => e.kind === 'start');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'secretary-resume.json'))).startDigest,
    startDigest(current));
  assert.equal(resumeSecretary(f.deps), 'reused');
  assert.equal(f.calls.filter(c => typeof c === 'object').length, 1);
});

test('unknown/replaced/stopped/corrupt conversations never create a fresh secretary', () => {
  for (const kind of ['missing', 'replaced', 'stopped', 'changed-dialogue', 'wrong-command']) {
    const f = fixture(); f.setPane(null);
    if (kind === 'missing') fs.renameSync(path.join(f.home, 'secretary-resume.json'), path.join(f.home, 'saved'));
    if (kind === 'replaced') f.entries.push({...f.entries[0], panePid: '99'});
    if (kind === 'stopped') f.entries.push({kind: 'stop', session: 'kadan-비서'});
    if (kind === 'changed-dialogue') fs.writeFileSync(f.transcript,
      JSON.stringify({type: 'session_meta', payload: {id: 'other', cwd: f.home}}));
    if (kind === 'wrong-command') {
      const saved = {...f.checkpoint, command: 'codex resume other'};
      fs.writeFileSync(path.join(f.home, 'secretary-resume.json'), JSON.stringify(saved));
    }
    assert.throws(() => resumeSecretary(f.deps));
    assert.equal(f.calls.length, 0, kind);
  }
});

test('a different live dialogue cannot be attached through an autostart lineage', () => {
  const f = fixture(); f.setPane(null); resumeSecretary(f.deps);
  f.recoveryDeps.secretaryConversation = () => 'other';
  assert.throws(() => restoreRecovery({context: JSON.stringify(f.context),
    command: f.checkpoint.command, 'rottie-bin': '/fixture/rottie'}, f.recoveryDeps), /실제 대화가/);
  assert.equal(f.calls.length, 1);
});

test('both launch paths share a role lock; a blocked secretary still allows dashboard startup', () => {
  const f = fixture(); f.setPane(null);
  const lock = path.join(f.home, 'recovery', `role-${startDigest('kadan-비서')}.lock`);
  withRecoveryLock(f.home, 'kadan-비서', () => assert.ok(fs.existsSync(lock)));
  assert.equal(fs.existsSync(lock), false);
  const started = [], sent = [];
  const out = runUp({home: f.home, flags: {cmd: 'codex'},
    floor: {...f.deps.floor, attach: () => 'attach'}, sessionName: role => `kadan-${role}`,
    cliPath: '/fixture/cli', start: args => started.push(args[0]), send: m => sent.push(m),
    restoreSecretary: () => {throw new Error('missing exact dialogue');}, log: () => {}});
  assert.equal(out.secretary, 'blocked');
  assert.deepEqual(started, ['대시보드']);
  assert.equal(sent.length, 0);
});

test('resume does not repeat the initial role prompt', () => {
  const sent = [];
  const out = runUp({home: fixture().home, flags: {cmd: 'codex'},
    floor: {alive: () => false, attach: () => 'attach'}, sessionName: role => `kadan-${role}`,
    cliPath: '/fixture/cli', start: () => {}, send: m => sent.push(m),
    restoreSecretary: () => 'restored', log: () => {}});
  assert.equal(out.secretary, 'restored');
  assert.equal(sent.length, 0);
});

test('implicit model, high effort and bypass are checkpointed from the actual dialogue', () => {
  const f = fixture(); f.entries[0].cmd = 'codex';
  fs.appendFileSync(f.transcript, JSON.stringify({type: 'turn_context', payload: {
    model: 'test-model', effort: 'high', approval_policy: 'never',
    sandbox_policy: {type: 'danger-full-access'},
  }}) + '\n');
  const context = inspectRecovery({terminal: 'old'}, f.recoveryDeps);
  const checkpoint = checkpointSecretary(f.deps);
  assert.match(checkpoint.command, /'--model' 'test-model'/);
  assert.match(checkpoint.command, /model_reasoning_effort="high"/);
  assert.match(checkpoint.command, /approval_policy="never"/);
  assert.match(checkpoint.command, /sandbox_mode="danger-full-access"/);
  f.setPane(null); resumeSecretary(f.deps);
  restoreRecovery({context: JSON.stringify(context), command: 'codex resume exact-conversation',
    'rottie-bin': '/fixture/rottie'}, f.recoveryDeps);
  assert.equal(f.calls.filter(c => typeof c === 'object').length, 1);
});

test('isolated real tmux/process/file: reboot resume and Rottie attachment preserve one dialogue', async t => {
  const {spawnSync, spawn} = await import('node:child_process');
  const {appendLedger, readSystemLedger} = await import('../src/ledger.mjs');
  const {tmuxFloor, tmux} = await import('../src/floor-tmux.mjs');
  const {buildStartLedgerEntry} = await import('../src/cli-start-support.mjs');
  if (spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux unavailable');
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'real-secretary-'));
  const transcript = path.join(home, 'rollout-live.jsonl');
  const executable = path.join(home, 'codex');
  fs.writeFileSync(transcript, JSON.stringify({type: 'session_meta',
    payload: {id: 'live-exact', cwd: home}}) + '\n');
  fs.writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';\n` +
    `fs.openSync(${JSON.stringify(transcript)}, 'a');\nconsole.log('ready');\n` +
    `setInterval(() => {}, 1000);\n`);
  fs.chmodSync(executable, 0o700);
  const priorSocket = process.env.KADAN_SOCKET;
  process.env.KADAN_SOCKET = `secretary-resume-test-${process.pid}`;
  const entries = [], calls = [];
  const record = e => {
    appendLedger(e, home);
    entries.splice(0, entries.length, ...readSystemLedger(home));
  };
  const waitPane = async () => {
    for (let i = 0; i < 40; i++) {
      if (tmuxFloor.read('kadan-비서').includes('ready')) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('isolated fake CLI did not start');
  };
  try {
    const evidence = tmuxFloor.create({session: 'kadan-비서', role: '비서', cwd: home,
      cmd: executable});
    record({...buildStartLedgerEntry({floorName: 'tmux', role: '비서', session: 'kadan-비서',
      cwd: home, cmd: executable, evidence, window: 'rottie', rottieTerminalId: 'old'}),
      roleProfile: 'secretary'});
    await waitPane();
    const deps = {home, floor: tmuxFloor, read: () => entries, record, startNew: () => assert.fail('fresh')};
    const context = inspectRecovery({terminal: 'old'}, {...deps, entries});
    const saved = checkpointSecretary(deps);
    assert.equal(saved.conversation, 'live-exact');
    tmux(['kill-server']);
    const source = `import {resumeSecretary} from ${JSON.stringify(new URL('../src/secretary-resume.mjs', import.meta.url).href)};
      import {tmuxFloor} from ${JSON.stringify(new URL('../src/floor-tmux.mjs', import.meta.url).href)};
      console.log(resumeSecretary({home: process.env.KADAN_HOME, floor: tmuxFloor,
        startNew: () => {throw new Error('fresh forbidden');}}));`;
    const restoreOnce = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        env: {...process.env, KADAN_HOME: home}, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '', error = '';
      child.stdout.on('data', chunk => {output += chunk;});
      child.stderr.on('data', chunk => {error += chunk;});
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
    });
    const states = await Promise.all([restoreOnce(), restoreOnce()]);
    assert.deepEqual(states.sort(), ['restored', 'reused']);
    entries.splice(0, entries.length, ...readSystemLedger(home));
    await waitPane();
    const result = restoreRecovery({context: JSON.stringify(context), command: saved.command,
      'rottie-bin': '/fixture/rottie', 'allow-reuse': 'false'}, {...deps, entries,
      spawn: () => {calls.push('attach'); return {status: 0,
        stdout: JSON.stringify({ok: true, result: {terminal: {id: 'new'}}})};}});
    assert.equal(result.context.role, '비서');
    assert.equal(checkpointSecretary(deps).conversation, 'live-exact');
    assert.equal(resumeSecretary(deps), 'reused');
    assert.equal(entries.filter(e => e.kind === 'start').length, 2);
    assert.deepEqual(calls, ['attach']);
  } finally {
    tmux(['kill-server']);
    if (priorSocket === undefined) delete process.env.KADAN_SOCKET;
    else process.env.KADAN_SOCKET = priorSocket;
  }
});

test('Rottie first also keeps implicit high effort and bypass from the exact checkpoint', () => {
  const f = fixture(); f.entries[0].cmd = 'codex';
  fs.appendFileSync(f.transcript, JSON.stringify({type: 'turn_context', payload: {
    model: 'test-model', effort: 'high', approval_policy: 'never',
    sandbox_policy: {type: 'danger-full-access'},
  }}) + '\n');
  const context = inspectRecovery({terminal: 'old'}, f.recoveryDeps);
  checkpointSecretary(f.deps); f.setPane(null);
  restoreRecovery({context: JSON.stringify(context), command: 'codex resume exact-conversation',
    'rottie-bin': '/fixture/rottie'}, f.recoveryDeps);
  assert.match(f.calls[0].cmd, /model_reasoning_effort="high"/);
  assert.match(f.calls[0].cmd, /sandbox_mode="danger-full-access"/);
  assert.match(f.calls[0].cmd, /'--model' 'test-model'/);
});

const optionCount = (command, flag) => commandWords(command).filter(word => word === flag).length;
const doubledCommand = () => "'codex' 'resume' 'exact-conversation' '--model' 'start-model' '-c' 'k=v' "
  + "'--model' 'other-model' '-c' 'k=w'";

test('checkpoint keeps the start model and fills only missing keys from the dialogue', () => {
  const f = fixture();
  fs.appendFileSync(f.transcript, JSON.stringify({type: 'turn_context', payload: {
    model: 'other-model', effort: 'low', approval_policy: 'never',
    sandbox_policy: {type: 'danger-full-access'},
  }}) + '\n');
  const words = commandWords(checkpointSecretary(f.deps).command);
  assert.equal(optionCount(words.join(' '), '--model'), 1);
  assert.equal(words[words.indexOf('--model') + 1], 'test-model');
  assert.equal(words.filter(word => word.startsWith('model_reasoning_effort=')).length, 1);
  assert.ok(words.includes('model_reasoning_effort=high'));
  assert.ok(words.includes('approval_policy="never"') || words.includes('approval_policy=never'));
});

test('checkpoint -> resume cycles three times without growing the command', () => {
  const f = fixture();
  fs.appendFileSync(f.transcript, JSON.stringify({type: 'turn_context', payload: {
    model: 'other-model', effort: 'low', approval_policy: 'never',
    sandbox_policy: {type: 'danger-full-access'},
  }}) + '\n');
  checkpointSecretary(f.deps);
  let length = 0; // 첫 순환은 --no-alt-screen 한 낱말이 붙는다. 그 뒤로는 길이가 변하면 안 된다
  for (let i = 0; i < 4; i++) {
    f.setPane(null);
    assert.equal(resumeSecretary(f.deps), 'restored');
    f.entries[f.entries.length - 1].cmd = f.calls.at(-1).cmd;
    const next = checkpointSecretary(f.deps);
    if (i > 0) assert.equal(next.command.length, length);
    length = next.command.length;
    assert.equal(optionCount(next.command, '--model'), 1);
  }
});

test('resume launches a doubled checkpoint with one --model and one of each -c key', () => {
  const f = fixture(); f.setPane(null);
  const file = path.join(f.home, 'secretary-resume.json');
  fs.writeFileSync(file, JSON.stringify({...f.checkpoint, command: doubledCommand()}) + '\n');
  assert.equal(resumeSecretary(f.deps), 'restored');
  const launched = commandWords(f.calls.at(-1).cmd);
  assert.deepEqual(launched.slice(0, 7), ['codex', 'resume', 'exact-conversation', '--model', 'start-model',
    '-c', 'k=v']);
  assert.equal(launched.filter(word => word === '--model').length, 1);
  assert.equal(launched.filter(word => word.startsWith('k=')).length, 1);
  assert.equal(commandWords(JSON.parse(fs.readFileSync(file, 'utf8')).command).filter(w => w === '--model').length, 1);
});

test('savedSecretaryCommand also dedupes a doubled checkpoint for the Rottie path', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'secretary-resume.json'),
    JSON.stringify({...f.checkpoint, command: doubledCommand()}) + '\n');
  const command = savedSecretaryCommand(f.home, f.context, 'codex resume exact-conversation');
  assert.equal(commandWords(command).filter(word => word === '--model').length, 1);
});

test('single quotes in a setting survive two restores and stay readable by commandWords', () => {
  const f = fixture(`codex --model gpt-x -c "model_reasoning_effort='high'"`);
  const want = ['codex', 'resume', 'exact-conversation', '--model', 'gpt-x', '-c', "model_reasoning_effort='high'"];
  assert.deepEqual(commandWords(f.checkpoint.command), want);
  f.setPane(null);
  assert.equal(resumeSecretary(f.deps), 'restored');
  const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'secretary-resume.json')));
  assert.deepEqual(commandWords(saved.command), want);
  f.setPane(null);
  assert.equal(resumeSecretary(f.deps), 'restored');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(commandWords(f.calls[1].cmd).slice(0, 7), want);
});

const MIXED = `developer_instructions="Don't modify files"`;
const mixedStart = `codex --model gpt-x -c 'developer_instructions="Don'"'"'t modify files"'`;

test('a mixed-quote setting in the start command is checkpointed and restored twice in a row', () => {
  const f = fixture(mixedStart);
  const want = ['codex', 'resume', 'exact-conversation', '--model', 'gpt-x', '-c', MIXED];
  assert.deepEqual(commandWords(f.checkpoint.command), want);
  for (let i = 0; i < 2; i++) {
    f.setPane(null);
    assert.equal(resumeSecretary(f.deps), 'restored');
  }
  assert.equal(f.calls.length, 2);
  assert.deepEqual(commandWords(f.calls[1].cmd).slice(0, 7), want);
  const saved = JSON.parse(fs.readFileSync(path.join(f.home, 'secretary-resume.json')));
  assert.deepEqual(commandWords(saved.command), want);
});

test('savedSecretaryCommand keeps a mixed-quote setting and one --model on the Rottie path', () => {
  const f = fixture(mixedStart);
  fs.writeFileSync(path.join(f.home, 'secretary-resume.json'),
    JSON.stringify({...f.checkpoint, command: serializeWords(['codex', 'resume', 'exact-conversation',
      '--model', 'gpt-x', '-c', MIXED, '--model', 'gpt-y'])}) + '\n');
  const words = commandWords(savedSecretaryCommand(f.home, f.context, 'codex resume exact-conversation'));
  assert.deepEqual(words.slice(0, 7), ['codex', 'resume', 'exact-conversation', '--model', 'gpt-x', '-c', MIXED]);
  assert.equal(words.filter(w => w === '--model').length, 1);
});
