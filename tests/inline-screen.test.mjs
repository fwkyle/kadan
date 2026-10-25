// 카단이 띄우는 대화형 codex 명령에 --no-alt-screen을 붙여 스크롤백 화면으로 고정한다 (2026-10-18 [kyle] 결정).
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {withInlineScreen, withoutInlineScreen, inlineScreenEnv, CLAUDE_INLINE_ENV} from '../src/inline-screen.mjs';
import {buildTmuxCreateArgv} from '../src/floor-tmux.mjs';
import {launchFor, launchForFallback} from '../src/runner-settings.mjs';
import {rebuildResumeCommand} from '../src/runner-table.mjs';
import {launchIdentityOf} from '../src/ai-identity.mjs';
import {conversationOf} from '../src/conversation-ref.mjs';
import {describeStartCmd} from '../src/cli-start-support.mjs';
import {readLedger} from '../src/ledger.mjs';
import {codexBasis} from '../src/ocx-refresh.mjs';

const F = '--no-alt-screen';

test('대화형 codex는 끝에 한 번만 붙고, 이미 있으면 그대로다', () => {
  const base = 'codex -p lite --model gpt-6-sol -c model_reasoning_effort="high"';
  assert.equal(withInlineScreen(base), `${base} ${F}`);
  assert.equal(withInlineScreen(`${base} ${F}`), `${base} ${F}`);
  assert.equal(withInlineScreen(withInlineScreen(base)), `${base} ${F}`);
  assert.equal(withInlineScreen(`${base}  `), `${base} ${F}`);
  assert.equal(withInlineScreen('codex resume 0197aaaa-1111-4222-8333-444455556666 --model m'),
    `codex resume 0197aaaa-1111-4222-8333-444455556666 --model m ${F}`);
  assert.equal(withInlineScreen('codex fork abc --model m'), `codex fork abc --model m ${F}`);
  assert.equal(withInlineScreen('LC_ALL=C /opt/bin/codex --model m'), `LC_ALL=C /opt/bin/codex --model m ${F}`);
  assert.equal(withInlineScreen('kadan-codex --model m'), `kadan-codex --model m ${F}`);
});

test('codex exec·review 같은 비대화형 하위 명령과 codex가 아닌 실행기에는 붙이지 않는다', () => {
  for (const cmd of ['codex exec --model m "작업"', 'codex e -m m', 'codex -c a=b exec x', 'codex review --base main',
    'codex login', 'codex mcp list', 'claude --model claude-fable-5-1', 'cat', 'omo --model m']) {
    assert.equal(withInlineScreen(cmd), cmd, cmd);
  }
});

test('`--` 뒤는 프롬프트라 플래그를 그 앞에 넣는다(없으면 끝에, 이미 있으면 그대로)', () => {
  const id = '0197aaaa-1111-4222-8333-444455556666';
  assert.equal(withInlineScreen(`codex resume ${id} --`), `codex resume ${id} ${F} --`);
  assert.equal(withInlineScreen('codex resume existing-conversation --'), `codex resume existing-conversation ${F} --`);
  assert.equal(withInlineScreen(`codex fork ${id} --`), `codex fork ${id} ${F} --`);
  assert.equal(withInlineScreen('codex --model m -- "새 프롬프트 --"'), `codex --model m ${F} -- "새 프롬프트 --"`);
  assert.equal(withInlineScreen('codex -- exec'), `codex ${F} -- exec`); // exec는 프롬프트 낱말이다
  assert.equal(withInlineScreen('codex exec --model m -- x'), 'codex exec --model m -- x');
  assert.equal(withInlineScreen(`codex resume ${id} ${F} --`), `codex resume ${id} ${F} --`);
  assert.equal(withInlineScreen(`codex resume ${id}`), `codex resume ${id} ${F}`);
  // 붙인 결과를 다시 풀어도 대화 해석이 같고 `--` 뒤 낱말은 그대로다
  assert.deepEqual(conversationOf(withInlineScreen(`codex resume ${id} --`)), {conversationMode: 'resume', conversationRef: id});
  assert.equal(withInlineScreen('codex "--"'), 'codex "--"'); // 따옴표 안 "--"는 낱말 분해로 구분되지 않아 안전하게 그대로 둔다
});

test('토큰 단위로 본다: 모델 이름에 alt-screen이 들어가도 붙고, 값 낱말을 하위 명령으로 읽지 않는다', () => {
  assert.equal(withInlineScreen('codex --model my-no-alt-screen-model'), `codex --model my-no-alt-screen-model ${F}`);
  assert.equal(withInlineScreen('codex -c note=--no-alt-screen'), `codex -c note=--no-alt-screen ${F}`);
  assert.equal(withInlineScreen('codex -m exec'), `codex -m exec ${F}`); // exec는 모델 값이다
});

test('판단할 수 없는 명령(셸 연산·따옴표 깨짐·빈 값)은 그대로 둔다', () => {
  for (const cmd of ['codex --model m && echo hi', 'codex "unterminated', '', undefined]) {
    assert.equal(withInlineScreen(cmd), cmd);
  }
});

test('설정 틀 채우기(fill)와 폴백은 codex에만 붙이고 claude 틀은 그대로다', () => {
  const settings = {
    revision: 3, activePreset: 'B',
    runners: {
      codex: {spawn: 'codex -p lite --model "{model}" -c model_reasoning_effort="{effort}"'},
      claude: {spawn: 'claude --model {model} --effort {effort}'},
    },
    presets: {B: {roles: {worker: {runner: 'codex', model: 'gpt-6-sol', effort: 'high'},
      reviewer: {runner: 'claude', model: 'claude-fable-5-1', effort: 'high'}},
    fallback: {worker: [{runner: 'codex', model: 'zai/glm-5.3', effort: 'high'}]}}},
  };
  assert.equal(launchFor(settings, 'worker').cmd,
    `codex -p lite --model "gpt-6-sol" -c model_reasoning_effort="high" ${F}`);
  assert.equal(launchFor(settings, 'reviewer').cmd, 'claude --model claude-fable-5-1 --effort high');
  assert.equal(launchForFallback(settings, 'worker', 1).cmd,
    `codex -p lite --model "zai/glm-5.3" -c model_reasoning_effort="high" ${F}`);
});

test('길어진 명령에서도 실행기·모델·대화 해석이 그대로다', () => {
  const cmd = withInlineScreen('codex -p lite --model "gpt-6-sol" -c model_reasoning_effort="high"');
  const {cmd: shown, ...fields} = describeStartCmd(cmd);
  assert.equal(shown, cmd);
  assert.deepEqual(fields, {harness: 'codex', model: 'gpt-6-sol', conversationMode: 'new'});
  assert.deepEqual(launchIdentityOf(cmd), {ok: true, harness: 'codex', model: 'gpt-6-sol'});
  assert.equal(conversationOf(cmd).conversationMode, 'new');
  const id = '0197aaaa-1111-4222-8333-444455556666';
  const resumed = withInlineScreen(`codex --model m resume ${id}`);
  assert.deepEqual(conversationOf(resumed), {conversationMode: 'resume', conversationRef: id});
  const forked = withInlineScreen(`codex fork ${id} --model m`);
  assert.deepEqual(conversationOf(forked), {conversationMode: 'fork', conversationRef: id});
});

test('restart의 resume 명령 재조립은 붙은 플래그를 떼고 다시 붙여도 resume 꼬리가 맞는다', () => {
  const settings = {runners: {codex: {spawn: 'codex --model {model}', resume: 'codex --model {model} resume {conversation}'}}};
  const id = '0197aaaa-1111-4222-8333-444455556666';
  const old = `codex --model m ${F}`;
  const rebuilt = withInlineScreen(rebuildResumeCommand(settings, 'codex', old, id));
  assert.equal(rebuilt, `codex --model m resume ${id} ${F}`);
  assert.equal(withInlineScreen(rebuildResumeCommand(settings, 'codex', rebuilt, id)), rebuilt);
});

test('#188 codexBasis는 플래그가 붙은 start 줄에서도 같은 판정이다', () => {
  const entry = cmd => ({kind: 'start', role: 'r', ...describeStartCmd(cmd)});
  const plain = 'codex -p lite --model gpt-6-sol -c model_reasoning_effort="high"';
  assert.deepEqual(codexBasis([entry(withInlineScreen(plain))], 'r'), codexBasis([entry(plain)], 'r'));
  assert.equal(codexBasis([entry(withInlineScreen(plain))], 'r').target, true);
  const other = 'codex --model zai/glm-5.3';
  assert.equal(codexBasis([entry(withInlineScreen(other))], 'r').reason, 'other-provider');
});

test('비교는 셸 낱말 단위다: 따옴표 안 공백 차이는 다른 명령', () => {
  assert.notEqual(withoutInlineScreen('codex -c "a=b  c"'), withoutInlineScreen('codex -c "a=b c"'));
  assert.equal(withoutInlineScreen(`codex   -c "a=b c" ${F}`), withoutInlineScreen('codex -c "a=b c"'));
  assert.equal(withoutInlineScreen('codex a && b'), 'codex a && b');
});

test('옛 세션 명령과 기본값은 플래그만 달라도 같은 명령으로 본다', () => {
  assert.equal(withoutInlineScreen(`codex --model m ${F}`), withoutInlineScreen('codex --model m'));
});

test('claude는 명령을 바꾸지 않고 tmux 환경(-e)으로 대체 화면을 끈다', () => {
  const claude = 'claude --model claude-fable-5-1 --effort high';
  assert.deepEqual(inlineScreenEnv(claude), [CLAUDE_INLINE_ENV]);
  assert.deepEqual(inlineScreenEnv('LC_ALL=C /opt/bin/claude --model m'), [CLAUDE_INLINE_ENV]);
  assert.deepEqual(inlineScreenEnv('codex --model m'), []);
  assert.deepEqual(inlineScreenEnv('cat'), []);
  assert.deepEqual(inlineScreenEnv(undefined), []);
  const argv = buildTmuxCreateArgv({session: 'kadan-x', role: 'x', cwd: '/tmp', cmd: claude});
  assert.deepEqual(argv.slice(-3), ['-e', CLAUDE_INLINE_ENV, claude]);
  assert.equal(argv.at(-1), claude); // 명령 문자열은 그대로
  assert.ok(!buildTmuxCreateArgv({session: 'kadan-x', role: 'x', cwd: '/tmp', cmd: 'codex --model m'}).includes(CLAUDE_INLINE_ENV));
});

// start 원장의 alternateOn: 가짜 실행기가 \e[?1049h를 찍으면 1, 안 찍으면 0.
test('CLI: start가 tmux alternate_on을 읽어 원장 alternateOn(0/1)에 적고, 1이면 경고한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-inline-'));
  const socket = `inline-screen-test-${process.pid}-${Date.now()}`;
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux', KADAN_WINDOW: 'none',
    KADAN_ROLE: '시험-슈퍼', KADAN_ALT_CHECK_MS: '3000'};
  delete env.KADAN_LITE_HOME;
  const fullscreen = path.join(home, 'full', 'codex'), inline = path.join(home, 'inline', 'codex');
  fs.mkdirSync(path.dirname(fullscreen)); fs.mkdirSync(path.dirname(inline));
  fs.writeFileSync(fullscreen, '#!/bin/sh\nprintf "\\033[?1049h"\nexec sleep 30\n', {mode: 0o755});
  fs.writeFileSync(inline, '#!/bin/sh\necho scrollback\nexec sleep 30\n', {mode: 0o755});
  const start = (role, cmd) => spawnSync(process.execPath, [cli, 'start', role, '--hidden', '--no-prompt', '--cmd', cmd],
    {env, encoding: 'utf8', timeout: 20000});
  try {
    const on = start('inline-on', fullscreen);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stderr, /풀스크린/);
    const off = start('inline-off', inline);
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stderr, /풀스크린/);
    const starts = readLedger(home).filter(e => e.kind === 'start');
    const byRole = role => starts.find(e => e.role === role);
    assert.equal(byRole('inline-on').alternateOn, 1);
    assert.equal(byRole('inline-off').alternateOn, 0);
    // --cmd로 직접 준 codex도 플래그가 붙어 기록된다.
    assert.equal(byRole('inline-off').cmd, `${inline} ${F}`);
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});
