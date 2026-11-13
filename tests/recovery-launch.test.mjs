import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {inspectRecovery, restoreRecovery} from '../src/recovery.mjs';
import {readCarryOptions, recoveryLaunch} from '../src/recovery-launch.mjs';
import {writeClaudeSettings, claudeSettingsPath} from '../src/stop-hook-settings.mjs';
import {commandWords, launchIdentityOf} from '../src/ai-identity.mjs';
import {conversationOf} from '../src/conversation-ref.mjs';
import {parseRestoreCommand} from '../src/server-restore-command.mjs';
import {rebuildResumeCommand} from '../src/runner-table.mjs';

const OLD = '11111111-1111-4111-8111-111111111111';
const NOW = '22222222-2222-4222-8222-222222222222';
// Rottie가 살아 있던 프로세스 인자로 다시 만든 꼴: 절대경로 실행 파일, 낱말마다 작은따옴표.
const rottieClaude = (...extra) => ["'/tools/claude'", "'--resume'", `'${NOW}'`, ...extra.map(w => `'${w}'`),
  "'--model'", "'opus'", "'--effort'", "'medium'"].join(' ');
const rottieCodex = (...extra) => ["'/tools/codex'", "'resume'", `'${NOW}'`, ...extra.map(w => `'${w}'`),
  "'--model'", "'fixture-model'"].join(' ');
// 대화를 갈라 연 뒤 권한 옵션이 뒤따르는 시작 명령(옛 홈의 설정 경로 포함).
const FORKED = `claude --settings '/old/home/stop-hook/claude-settings.json' --resume ${OLD} --fork-session`
  + " --model opus --effort medium '--permission-mode' 'bypassPermissions'";

function fixture(originalCmd, {settings = true} = {}) {
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'launch-'));
  if (settings) writeClaudeSettings(home, '/fixture/stop-hook.sh');
  const entries = [{kind: 'start', floor: 'tmux', role: 'lead', session: 'kadan-lead',
    t: '2026-01-01T00:00:00Z', cwd: home, cmd: originalCmd, panePid: '20',
    roleProfile: 'conductor', by: 'owner', rottieTerminalId: 'old'}];
  let pane = null, nextPid = 30, terminal = 0;
  const created = [], warnings = [];
  const deps = {home, entries, read: () => entries, livePane: () => pane,
    create: options => { created.push(options); pane = {pid: String(nextPid), dead: false, created: String(nextPid)};
      return {panePid: String(nextPid++)}; },
    record: entry => entries.push({...entry, t: '2026-01-02T00:00:00Z'}),
    warn: message => warnings.push(message),
    spawn: () => ({status: 0, stdout: JSON.stringify({ok: true, result: {terminal: {id: `new-${++terminal}`}}})}),
  };
  const restore = (command, terminalId = 'old') => {
    const context = inspectRecovery({terminal: terminalId}, deps);
    pane = null;
    const receipt = restoreRecovery({context: JSON.stringify(context), command: `exec ${command}`,
      'rottie-bin': '/fixture/rottie', 'allow-reuse': 'false'}, deps);
    return {receipt, launched: created.at(-1).cmd, start: entries.findLast(e => e.kind === 'start')};
  };
  return {home, entries, deps, created, warnings, restore, settingsFile: claudeSettingsPath(home)};
}
const hookWords = f => ['--settings', f.settingsFile];

test('the forked-then-permission start keeps its permission mode and gets the current-home hook', () => {
  const f = fixture(FORKED);
  const {launched, start} = f.restore(rottieClaude());
  assert.deepEqual(commandWords(launched), ['/tools/claude', ...hookWords(f), '--resume', NOW,
    '--model', 'opus', '--effort', 'medium', '--permission-mode', 'bypassPermissions']);
  assert.equal(start.cmd, launched);
  assert.equal(start.optionCarry, 'added');
  assert.deepEqual(start.optionCarryKeys, ['permission-mode']);
  assert.equal(launched.includes('/old/home'), false);
  assert.deepEqual(f.warnings, []);
  // 기록된 명령을 나중에 읽는 판독들이 같은 실행기·모델·대화로 읽는다.
  assert.deepEqual(launchIdentityOf(start.cmd), {ok: true, harness: 'claude', model: 'opus'});
  assert.equal(start.conversationMode, conversationOf(rottieClaude()).conversationMode);
  assert.equal(start.conversationRef, NOW);
  const parsed = parseRestoreCommand(start.cmd);
  assert.equal(parsed.id, NOW);
  assert.deepEqual(parsed.options.slice(-2), ['--permission-mode', 'bypassPermissions']);
});

test('a start without permission options gains none', () => {
  const f = fixture('claude --model opus --effort medium');
  const {launched, start} = f.restore(rottieClaude());
  assert.deepEqual(commandWords(launched), ['/tools/claude', ...hookWords(f), '--resume', NOW,
    '--model', 'opus', '--effort', 'medium']);
  assert.equal('optionCarry' in start, false);
  assert.deepEqual(f.warnings, []);
});

test('skip-permissions is carried when missing and left alone when Rottie already kept it', () => {
  const original = 'claude --dangerously-skip-permissions --model opus --effort medium';
  const lost = fixture(original).restore(rottieClaude());
  assert.deepEqual(commandWords(lost.launched).slice(-1), ['--dangerously-skip-permissions']);
  assert.deepEqual(lost.start.optionCarryKeys, ['skip-permissions']);
  const f = fixture(original);
  const kept = f.restore(rottieClaude('--dangerously-skip-permissions'));
  assert.deepEqual(commandWords(kept.launched), ['/tools/claude', ...hookWords(f), '--resume', NOW,
    '--dangerously-skip-permissions', '--model', 'opus', '--effort', 'medium']);
  assert.equal('optionCarry' in kept.start, false);
});

test('a permission already in the restore command is never replaced or widened', () => {
  const f = fixture(FORKED);
  const {launched, start} = f.restore(rottieClaude('--permission-mode', 'plan'));
  const words = commandWords(launched);
  assert.equal(words.includes('bypassPermissions'), false);
  assert.equal(words.filter(w => w === '--permission-mode').length, 1);
  assert.equal('optionCarry' in start, false);
});

test('an ambiguous or unreadable original adds nothing, is marked, and the role still opens', () => {
  for (const [original, reason] of [
    ['claude --mystery --dangerously-skip-permissions --model opus --effort medium', 'original-ambiguous'],
    ['claude --model opus --effort medium --permission-mode nonsense', 'original-ambiguous'],
    ['claude --model opus --effort medium --permission-mode plan --permission-mode auto', 'original-ambiguous'],
  ]) {
    const f = fixture(original);
    const {launched, start} = f.restore(rottieClaude());
    assert.deepEqual(commandWords(launched), ['/tools/claude', ...hookWords(f), '--resume', NOW,
      '--model', 'opus', '--effort', 'medium'], original);
    assert.equal(start.optionCarry, 'skipped');
    assert.equal(start.optionCarryReason, reason);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /잇지 못했다/);
  }
  // 셸 결합이 든 시작 명령은 낱말로 읽지 못한다.
  const direct = recoveryLaunch({command: rottieClaude(), start: {cmd: 'claude --model opus; true'}, entries: []});
  assert.deepEqual(direct.extra, {optionCarry: 'skipped', optionCarryReason: 'original-unreadable'});
  assert.equal(direct.launch, rottieClaude());
});

test('a permission word inside an option value or after -- is not an option', () => {
  for (const original of [
    'claude --append-system-prompt --dangerously-skip-permissions --model opus --effort medium',
    "claude --model opus --effort medium -- 'run with --dangerously-skip-permissions'",
    'claude --model opus --effort medium -- --dangerously-skip-permissions',
  ]) {
    const read = readCarryOptions(original);
    assert.equal(read.ok, true, original);
    assert.deepEqual(read.items, [], original);
  }
});

test('an earlier recovery that lost the option is repaired from the exact previous tab only', () => {
  const f = fixture(FORKED);
  f.entries[0].rottieTerminalId = 'first';
  f.entries.push({...f.entries[0], rottieTerminalId: 'old', panePid: '21', restoredFrom: 'first',
    cmd: `'/tools/claude' '--resume' '${NOW}' '--model' 'opus' '--effort' 'medium'`});
  const repaired = f.restore(rottieClaude());
  assert.deepEqual(commandWords(repaired.launched).slice(-2), ['--permission-mode', 'bypassPermissions']);
  assert.equal(repaired.start.optionCarry, 'added');

  const broken = fixture(FORKED);
  broken.entries[0].rottieTerminalId = 'first';
  broken.entries[0].role = 'someone-else';
  broken.entries.push({...broken.entries[0], role: 'lead', rottieTerminalId: 'old', panePid: '21',
    restoredFrom: 'first', cmd: `'/tools/claude' '--resume' '${NOW}' '--model' 'opus' '--effort' 'medium'`});
  const {launched, start} = broken.restore(rottieClaude());
  assert.equal(commandWords(launched).includes('--permission-mode'), false);
  assert.equal(start.optionCarryReason, 'chain-unresolved');
  assert.equal(broken.warnings.length, 1);
});

test('the next recovery generation keeps one hook and the same permission', () => {
  const f = fixture(FORKED);
  const first = f.restore(rottieClaude());
  const second = f.restore(rottieClaude(), first.receipt.terminalId);
  assert.deepEqual(commandWords(second.launched), commandWords(first.launched));
  assert.equal(second.start.optionCarry, 'added');
  // Rottie가 권한 낱말을 옮겨 준 다음 세대에서는 더하지 않는다.
  const third = f.restore(rottieClaude('--permission-mode', 'bypassPermissions'), second.receipt.terminalId);
  assert.equal(commandWords(third.launched).filter(w => w === '--permission-mode').length, 1);
  assert.equal(commandWords(third.launched).filter(w => w === '--settings').length, 1);
  assert.equal('optionCarry' in third.start, false);
});

test('a later restart can rebuild the recorded command and keeps what was carried', () => {
  const NEXT = '33333333-3333-4333-8333-333333333333';
  const settings = {runners: {
    claude: {spawn: 'claude --model {model}', resume: 'claude --model {model} --resume {conversation}'},
    codex: {spawn: 'codex --model {model}', resume: 'codex --model {model} resume {conversation}'},
  }};
  const f = fixture(FORKED);
  const claude = f.restore(rottieClaude()).start.cmd;
  assert.deepEqual(commandWords(rebuildResumeCommand(settings, 'claude', claude, NEXT)),
    ['/tools/claude', ...hookWords(f), '--model', 'opus', '--effort', 'medium',
      '--permission-mode', 'bypassPermissions', '--resume', NEXT]);
  const codex = fixture('codex -p fixture-profile --model fixture-model -c model_reasoning_effort="high"')
    .restore(rottieCodex()).start.cmd;
  assert.deepEqual(commandWords(rebuildResumeCommand(settings, 'codex', codex, NEXT)),
    ['/tools/codex', '--model', 'fixture-model', '-p', 'fixture-profile', '-c', 'model_reasoning_effort=high',
      'resume', NEXT]);
});

test('wrapper executable and the inline value spelling are carried as written', () => {
  const f = fixture('/tools/kadan-claude --model opus --effort medium --permission-mode=acceptEdits');
  const {launched, start} = f.restore(rottieClaude());
  assert.deepEqual(commandWords(launched).slice(-1), ['--permission-mode=acceptEdits']);
  assert.deepEqual(start.optionCarryKeys, ['permission-mode']);
});

test('without a settings file nothing but the carried option changes', () => {
  const f = fixture(FORKED, {settings: false});
  const {launched} = f.restore(rottieClaude());
  assert.equal(launched, `${rottieClaude()} '--permission-mode' 'bypassPermissions'`);
  assert.equal(fixture('claude --model opus --effort medium', {settings: false}).restore(rottieClaude()).launched,
    rottieClaude());
});

test('codex profile and settings are carried per key and never overwritten', () => {
  const original = 'codex -p fixture-profile --model "fixture-model" -c model_reasoning_effort="high"'
    + ' --config approval_policy=never --no-alt-screen';
  const f = fixture(original);
  const all = f.restore(rottieCodex());
  assert.equal(all.launched, `${rottieCodex()} '-p' 'fixture-profile' '-c' 'model_reasoning_effort=high'`
    + " '--config' 'approval_policy=never'");
  assert.deepEqual(all.start.optionCarryKeys, ['profile', 'c:model_reasoning_effort', 'c:approval_policy']);
  assert.equal(all.launched.includes('--settings'), false);
  assert.deepEqual(launchIdentityOf(all.start.cmd), {ok: true, harness: 'codex', model: 'fixture-model'});
  assert.deepEqual(commandWords(all.start.cmd).slice(0, 3), ['/tools/codex', 'resume', NOW]);

  const partial = fixture(original).restore(rottieCodex('-c', 'model_reasoning_effort=low', '--profile', 'other'));
  const words = commandWords(partial.launched);
  assert.equal(words.includes('model_reasoning_effort=high'), false);
  assert.equal(words.includes('fixture-profile'), false);
  assert.deepEqual(words.slice(-2), ['--config', 'approval_policy=never']);
  assert.deepEqual(partial.start.optionCarryKeys, ['c:approval_policy']);

  const none = fixture('codex --model fixture-model --no-alt-screen').restore(rottieCodex());
  assert.equal(none.launched, rottieCodex());
  assert.equal('optionCarry' in none.start, false);
});

test('codex settings in an unsafe or unknown position are not carried', () => {
  for (const original of ['codex --mystery -p fixture-profile --model fixture-model',
    'codex --model fixture-model -c not-a-setting', 'codex --model fixture-model -p one -p two']) {
    const f = fixture(original);
    const {launched, start} = f.restore(rottieCodex());
    assert.equal(launched, rottieCodex(), original);
    assert.equal(start.optionCarryReason, 'original-ambiguous', original);
  }
});

test('runners outside the carry rules and live-pane reuse are untouched', () => {
  const f = fixture('agent');
  const {launched, start} = f.restore('agent --resume exact');
  assert.equal(launched, 'agent --resume exact');
  assert.equal('optionCarry' in start, false);
  assert.deepEqual(f.warnings, []);
});
