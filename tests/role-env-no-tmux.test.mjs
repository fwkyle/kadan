// 역할 AI 명령은 TMUX·TMUX_PANE 없이 돈다(2026-11-04 사고: 카단 pane 안 QA 스크립트가 소켓 없는 tmux로 운영 서버를 종료).
// 실제 tmux 시험은 tests/run.mjs가 깐 격리 소켓·실행별 TMUX_TMPDIR 안에서만 돈다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildTmuxCreateArgv, wrapNoTmux, tmux, currentSocket, tmuxClientEnv, TMUX_CLIENT_ENV_STRIP,
} from '../src/floor-tmux.mjs';
import {insideKadanPane, inheritedNoneOverridden} from '../src/window-setting.mjs';
import {inheritedWindowWarning, buildStartLedgerEntry} from '../src/cli-start-support.mjs';

const socket = currentSocket();

test('단순 명령은 exec env -u 로, 연산자가 든 명령은 unset 앞머리로, 명령이 없으면 로그인 셸로 감싼다', () => {
  assert.equal(wrapNoTmux('codex --model m'), 'exec env -u TMUX -u TMUX_PANE codex --model m');
  assert.equal(wrapNoTmux('LC_ALL=C claude --model m'), 'exec env -u TMUX -u TMUX_PANE LC_ALL=C claude --model m');
  assert.equal(wrapNoTmux('a && b'), 'unset TMUX TMUX_PANE; a && b');
  assert.equal(wrapNoTmux('exec codex -m x'), 'exec env -u TMUX -u TMUX_PANE codex -m x');
  assert.equal(wrapNoTmux('exec exec codex'), 'exec env -u TMUX -u TMUX_PANE codex');
  assert.equal(wrapNoTmux('env X=1 codex'), 'exec env -u TMUX -u TMUX_PANE env X=1 codex');
  assert.equal(wrapNoTmux('env -i codex'), 'unset TMUX TMUX_PANE; env -i codex');
  assert.equal(wrapNoTmux('exec env X=1 codex'), 'exec env -u TMUX -u TMUX_PANE env X=1 codex');
  assert.equal(wrapNoTmux('nohup codex'), 'unset TMUX TMUX_PANE; nohup codex');
  assert.equal(wrapNoTmux('exec nohup codex'), 'unset TMUX TMUX_PANE; exec nohup codex');
  assert.equal(wrapNoTmux('X=1 command codex'), 'unset TMUX TMUX_PANE; X=1 command codex');
  assert.equal(wrapNoTmux('exec'), 'unset TMUX TMUX_PANE; exec');
  assert.match(wrapNoTmux(undefined), /^exec env -u TMUX -u TMUX_PANE "\$\{SHELL:-\/bin\/sh\}" -l$/);
});

test('buildTmuxCreateArgv: 감싼 명령과 KADAN_PANE_SOCKET 표시, 앞쪽 inlineScreenEnv는 그대로', () => {
  const claude = 'claude --model claude-fable-5-1';
  const argv = buildTmuxCreateArgv({session: 'kadan-x', role: 'x', cwd: '/tmp', cmd: claude});
  assert.equal(argv.at(-1), `exec env -u TMUX -u TMUX_PANE ${claude}`);
  assert.ok(argv.includes(`KADAN_PANE_SOCKET=${socket}`));
  assert.ok(argv.includes('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1'));
  assert.equal(buildTmuxCreateArgv({session: 'kadan-x', role: 'x', cwd: '/tmp'}).at(-1), wrapNoTmux(undefined));
});

test('원장 start 사건의 cmd·harness·model은 감싸기 전 원문 기준이다', () => {
  const cmd = 'codex --model gpt-test';
  const entry = buildStartLedgerEntry({role: 'x', session: 'kadan-x', cmd, evidence: {panePid: 1}, floorName: 'tmux'});
  assert.equal(entry.cmd, cmd);
  assert.equal(entry.harness, 'codex');
  assert.equal(entry.model, 'gpt-test');
});

test('TMUX_CLIENT_ENV_STRIP에 KADAN_PANE_SOCKET이 있고 tmuxClientEnv가 뺀다', () => {
  assert.ok(TMUX_CLIENT_ENV_STRIP.includes('KADAN_PANE_SOCKET'));
  assert.deepEqual(tmuxClientEnv({KADAN_PANE_SOCKET: 's', PATH: '/p'}), {PATH: '/p'});
});

test('카단 pane 판정: 새 표시만, 옛 TMUX만 있어도 안, 둘 다 다른 소켓이면 밖', () => {
  assert.equal(insideKadanPane({KADAN_PANE_SOCKET: socket}, socket), true);
  assert.equal(insideKadanPane({TMUX: `/tmp/tmux-501/${socket},1,0`}, socket), true);
  assert.equal(insideKadanPane({KADAN_PANE_SOCKET: 'other', TMUX: '/tmp/tmux-501/default,1,0'}, socket), false);
  assert.equal(insideKadanPane({}, socket), false);
  const setting = {window: 'rottie'};
  assert.equal(inheritedNoneOverridden({KADAN_PANE_SOCKET: socket, KADAN_WINDOW: 'none'}, setting, socket), true);
  assert.equal(inheritedNoneOverridden({KADAN_PANE_SOCKET: 'other', KADAN_WINDOW: 'none'}, setting, socket), false);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-pane-warn-'));
  assert.equal(inheritedWindowWarning({env: {KADAN_PANE_SOCKET: 'other', KADAN_WINDOW: 'none'}, home, socket}), null);
});

// --- 실제 tmux(격리 소켓) ---
const isolated = process.env.TMUX_TMPDIR?.startsWith('/tmp/kadan-run-') || process.env.TMUX_TMPDIR?.includes('/kadan-run-');
const real = {skip: isolated ? false : 'TMUX_TMPDIR이 실행별 폴더가 아니다(fail-closed)'};

function waitFor(file, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('END')) return fs.readFileSync(file, 'utf8');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(`시간 초과: ${file}`);
}

function launch(name, cmd, dir) {
  const session = `kadan-test-${name}-${process.pid}`;
  const result = tmux(buildTmuxCreateArgv({session, role: name, cwd: dir, cmd}));
  assert.equal(result.status, 0, result.stderr);
  return session;
}

test('실제 tmux: 단순·복합 명령 모두 TMUX·TMUX_PANE 없이, KADAN_PANE_SOCKET은 있게 뜬다', real, () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'role-env-'));
  const script = path.join(dir, 'dump.sh');
  fs.writeFileSync(script, '#!/bin/sh\nenv > "$1"\necho END >> "$1"\nsleep 20\n');
  const simple = path.join(dir, 'simple.txt'), compound = path.join(dir, 'compound.txt');
  const sessions = [
    launch('simple', `sh ${script} ${simple}`, dir),
    launch('compound', `true && sh ${script} ${compound} && true`, dir),
  ];
  try {
    for (const file of [simple, compound]) {
      const text = waitFor(file);
      assert.ok(!/^TMUX=/m.test(text) && !/^TMUX_PANE=/m.test(text), `${file}에 TMUX가 있다`);
      assert.ok(text.includes(`KADAN_PANE_SOCKET=${socket}`));
    }
  } finally {
    for (const s of sessions) tmux(['kill-session', '-t', `=${s}`]);
  }
});

test('실제 tmux: 역할 안에서 소켓 없는 tmux kill-server를 쳐도 격리 서버는 산다(기본 서버는 실행별 TMUX_TMPDIR 아래)', real, () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'role-env-'));
  const out = path.join(dir, 'kill.txt');
  const session = launch('kill', `tmux kill-server > ${out} 2>&1; echo END >> ${out}; sleep 20`, dir);
  try {
    waitFor(out);
    assert.equal(tmux(['has-session', '-t', `=${session}`]).status, 0, '격리 서버가 죽었다');
  } finally {
    tmux(['kill-session', '-t', `=${session}`]);
  }
});

// --- 실제 셸 실행 회귀(PR #348 검수 P1): 감싼 명령을 진짜 sh·zsh로 실행해 종료 코드와 환경을 본다. tmux는 쓰지 않는다. ---
import {spawnSync} from 'node:child_process';
const dump = `${process.execPath} -e "console.log(JSON.stringify({t:process.env.TMUX,p:process.env.TMUX_PANE,x:process.env.X}))"`;
const heads = [
  ['exec', `exec ${dump}`, undefined],
  ['exec exec', `exec exec ${dump}`, undefined],
  ['exec env X=1', `exec env X=1 ${dump}`, '1'],
  ['env X=1', `env X=1 ${dump}`, '1'],
  ['X=1 직접', `X=1 ${dump}`, '1'],
  ['nohup(애매 앞머리)', `nohup ${dump}`, undefined],
  ['command(애매 앞머리)', `command ${dump}`, undefined],
];
for (const shell of ['/bin/sh', '/bin/zsh']) {
  for (const [name, cmd, x] of heads) {
    test(`실제 ${shell} 실행: ${name} 앞머리 종료 코드 0, TMUX 없음${x ? ', X=1 유지' : ''}`, () => {
      const env = {...process.env, TMUX: '/tmp/x,1,0', TMUX_PANE: '%9'};
      delete env.X;
      const run = spawnSync(shell, ['-c', wrapNoTmux(cmd)], {env, encoding: 'utf8'});
      assert.equal(run.status, 0, run.stderr);
      const seen = JSON.parse(run.stdout.trim().split('\n').at(-1));
      assert.equal(seen.t, undefined);
      assert.equal(seen.p, undefined);
      assert.equal(seen.x, x);
    });
  }
}
