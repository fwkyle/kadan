// Why: `kadan start` 설정 불일치 오류 문구가 설정 명령 원문 대신 describeCommand 요약을 써서
// 앞머리 환경변수 값과 명령 원문 조각이 화면에 새지 않는지 확인한다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describeCommand} from '../src/command-summary.mjs';
import {readLedger} from '../src/ledger.mjs';
import {DEFAULT_FAMILIES, launchFor, readSettings} from '../src/runner-settings.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const hasTmux = spawnSync('tmux', ['-V']).status === 0;

function makeRig(name, {runner = 'codex', spawn, model = 'gpt-6-sol', effort = 'high'}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `kadan-start-mismatch-${name}-`));
  const settings = {
    version: 1,
    revision: 1,
    activePreset: '기본',
    families: DEFAULT_FAMILIES,
    runners: {
      [runner]: {
        spawn,
        models: [{model, efforts: effort ? [effort] : []}],
      },
    },
    presets: {
      '기본': {
        label: '시험용',
        roles: {worker: {runner, model, ...(effort ? {effort} : {})}},
      },
    },
    blocked: [],
  };
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
  const socket = `kadan-start-mismatch-${name}-${process.pid}-${Date.now().toString(36)}`;
  const env = {
    ...process.env,
    KADAN_HOME: home,
    KADAN_SOCKET: socket,
    KADAN_FLOOR: 'tmux',
    KADAN_WINDOW: 'none',
    KADAN_NOTIFY: 'off',
    KADAN_ALT_CHECK_MS: '0',
    KADAN_ROLE: '시험-감독',
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.KADAN_LITE_HOME;
  delete env.KADAN_LITE_SOCKET;
  const run = (...args) =>
    spawnSync(process.execPath, [CLI, ...args], {env, encoding: 'utf8', timeout: 15000});
  const alive = role =>
    spawnSync('tmux', ['-L', socket, 'has-session', '-t', `=kadan-${role}`], {env}).status === 0;
  const cleanup = () => {
    console.log(`격리 소켓 kill-server: ${socket}`);
    spawnSync('tmux', ['-L', socket, 'kill-server'], {env, stdio: 'ignore'});
    fs.rmSync(home, {recursive: true, force: true});
  };
  return {home, env, run, alive, cleanup};
}

function assertNonePresent(text, forbidden, label) {
  const found = forbidden.filter(fragment => text.includes(fragment));
  assert.deepEqual(found, [], `${label}: 오류 문구에 남은 금지 조각\n${text}`);
}

test(
  'start 설정 불일치: 앞머리 가짜 값과 명령 원문 조각이 오류 문구에 0건이고 --reason을 주면 통과한다',
  {skip: !hasTmux},
  () => {
    const fakeEnvKey = 'KADAN_FAKE_VALUE';
    const fakeEnvVal = 'zz-not-a-secret-456';
    const fakeCfgVal = 'zz-not-a-cfg-789';
    const spawn =
      `${fakeEnvKey}=${fakeEnvVal} codex -p lite --model {model} ` +
      `-c model_reasoning_effort="{effort}" -c sample_opt="${fakeCfgVal}"`;
    const rig = makeRig('env-prefix', {spawn, model: 'gpt-6-sol', effort: 'high'});
    try {
      const expectedCmd = launchFor(readSettings(rig.home), 'worker').cmd;
      const expectedSummary = describeCommand(expectedCmd);

      // --reason 없이 다른 --cmd로 시작하면 거절되고 세션을 만들지 않는다.
      const refused = rig.run(
        'start', 'mismatch-a', '--hidden', '--no-prompt', '--profile', 'worker', '--cmd', 'cat',
      );
      assert.equal(refused.status, 2, refused.stderr);
      assert.equal(rig.alive('mismatch-a'), false);

      const output = `${refused.stdout}\n${refused.stderr}`;
      assert.match(output, /실행 모델 설정과 다른 명령이다 — --reason <이유>를 함께 줘라\./);
      assert.ok(output.includes(`설정값: ${expectedSummary}`), output);
      assertNonePresent(
        output,
        [
          fakeEnvKey,
          fakeEnvVal,
          `${fakeEnvKey}=${fakeEnvVal}`,
          fakeCfgVal,
          expectedCmd,
          'codex -p lite',
          '-p lite',
          '--model gpt-6-sol',
          'model_reasoning_effort',
          'sample_opt=',
          '--no-alt-screen',
        ],
        '앞머리 환경변수 설정 불일치',
      );

      // --reason을 함께 주면 지금처럼 통과하고 원장에 override 기록이 남는다.
      const allowed = rig.run(
        'start', 'mismatch-b', '--hidden', '--no-prompt', '--profile', 'worker',
        '--cmd', 'cat', '--reason', '시험용 대체 명령',
      );
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.equal(rig.alive('mismatch-b'), true);

      const start = readLedger(rig.home)
        .filter(e => e.kind === 'start' && e.role === 'mismatch-b')
        .at(-1);
      assert.equal(start.launchSource, 'override');
      assert.equal(start.overrideReason, '시험용 대체 명령');
      assert.equal(start.cmd, 'cat');
      assert.equal(start.settingsCmd, expectedCmd);
      rig.run('stop', 'mismatch-b');
    } finally {
      rig.cleanup();
    }
  },
);

test(
  'start 설정 불일치: env 앞머리와 읽을 수 없는 설정 명령도 가짜 값과 원문 조각이 0건이다',
  {skip: !hasTmux},
  () => {
    const fakeEnvKey = 'KADAN_FAKE_VALUE';
    const fakeEnvVal = 'zz-not-a-secret-456';
    const fakeInline = 'zz-inline-val-321';
    const fakeShell = 'zz-shell-tail-999';

    const envRig = makeRig('env-cmd', {
      runner: 'claude',
      model: 'claude-fixture',
      effort: 'medium',
      spawn:
        `env ${fakeEnvKey}=${fakeEnvVal} claude --model {model} ` +
        `--effort {effort} --token=${fakeInline}`,
    });
    try {
      const expectedCmd = launchFor(readSettings(envRig.home), 'worker').cmd;
      const refused = envRig.run(
        'start', 'mismatch-env', '--hidden', '--no-prompt', '--profile', 'worker', '--cmd', 'cat',
      );
      assert.equal(refused.status, 2, refused.stderr);
      assert.equal(envRig.alive('mismatch-env'), false);
      const output = `${refused.stdout}\n${refused.stderr}`;
      assert.ok(output.includes(`설정값: ${describeCommand(expectedCmd)}`), output);
      assertNonePresent(
        output,
        [
          fakeEnvKey,
          fakeEnvVal,
          fakeInline,
          expectedCmd,
          'env ',
          '--model claude-fixture',
          '--effort medium',
          '--token=',
        ],
        'env 앞머리 설정 불일치',
      );
    } finally {
      envRig.cleanup();
    }

    const unsafeRig = makeRig('unsafe-cmd', {
      runner: 'codex',
      model: 'gpt-6-sol',
      effort: 'high',
      spawn: `${fakeEnvKey}=${fakeEnvVal} codex --model {model}; echo ${fakeShell}`,
    });
    try {
      const expectedCmd = launchFor(readSettings(unsafeRig.home), 'worker').cmd;
      const refused = unsafeRig.run(
        'start', 'mismatch-unsafe', '--hidden', '--no-prompt', '--profile', 'worker', '--cmd', 'cat',
      );
      assert.equal(refused.status, 2, refused.stderr);
      assert.equal(unsafeRig.alive('mismatch-unsafe'), false);
      const output = `${refused.stdout}\n${refused.stderr}`;
      assert.match(output, /설정값: 시작 명령을 읽지 못함\(내용은 표시하지 않음\)/);
      assertNonePresent(
        output,
        [fakeEnvKey, fakeEnvVal, fakeShell, expectedCmd, '; echo', '--model gpt-6-sol'],
        '읽을 수 없는 설정 명령 불일치',
      );
    } finally {
      unsafeRig.cleanup();
    }
  },
);
