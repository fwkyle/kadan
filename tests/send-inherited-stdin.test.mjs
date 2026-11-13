// kadan send·mail: 위치 인자 본문과 표준 입력(파일)이 함께 왔을 때의 판정.
// 막으려는 것: `--expect-reply '질문' < 본문파일`처럼 이 명령에 직접 준 파일(읽기 위치 0)이 조용히 버려지는 일.
// 막으면 안 되는 것: 부모가 이미 읽은 표준 입력(heredoc으로 띄운 스크립트 등)을 물려받은 호출.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger, readMailBody} from '../src/ledger.mjs';
import {stdinBodyConflict, stdinOffset} from '../src/stdin-body.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const REJECT = /본문이 두 곳에 있다/;
const HINT = /<\/dev\/null/;

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-send-stdin-'));
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: path.basename(home), KADAN_WINDOW: 'none',
    KADAN_FLOOR: 'tmux', KADAN_ROLE: 'boss', KADAN_NOTIFY: 'off', KADAN_TEST_NODE: process.execPath, KADAN_TEST_CLI: cli};
  delete env.TMUX; delete env.TMUX_PANE;
  // 시작 기록만 있고 세션이 없는 역할: 우편은 보관된다(tmux 창을 만들지 않는다).
  appendLedger({kind: 'start', role: 'worker', session: 'kadan-worker', panePid: 4242, t: '2026-10-21T00:00:00Z'}, home);
  const bodies = () => readLedger(home).filter(e => e.kind === 'send').map(e => readMailBody(e.digest, home));
  const file = (name, text) => { const p = path.join(home, name); fs.writeFileSync(p, text); return p; };
  // 파일을 열어 consumed 바이트를 미리 읽은 fd를 표준 입력으로 준다(부모가 읽다 만 표준 입력과 같은 상태).
  const withFd = (args, filePath, consumed) => {
    const fd = fs.openSync(filePath, 'r');
    try {
      if (consumed > 0) assert.equal(fs.readSync(fd, Buffer.alloc(consumed), 0, consumed, null), consumed);
      const result = spawnSync(process.execPath, [cli, ...args],
        {env, cwd: os.tmpdir(), encoding: 'utf8', stdio: [fd, 'pipe', 'pipe'], timeout: 20000});
      // 자식이 끝난 뒤 같은 fd에서 이어 읽은 내용: 판정이 부모의 남은 입력을 건드렸는지 본다.
      const rest = Buffer.alloc(4096), n = fs.readSync(fd, rest, 0, rest.length, null);
      return {...result, rest: rest.subarray(0, n).toString('utf8')};
    } finally { fs.closeSync(fd); }
  };
  const shell = script => spawnSync('/bin/sh', [file(`script-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`, script)],
    {env, cwd: os.tmpdir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000});
  return {home, env, bodies, file, withFd, shell};
}

test('재현: 부모가 끝까지 읽은 파일 표준 입력을 물려받은 위치 인자 호출은 보낸다(send·mail)', () => {
  const f = fixture();
  const script = f.file('parent-script.txt', 'import subprocess\nsubprocess.run([...])\n');
  const size = fs.statSync(script).size;
  for (const command of ['send', 'mail']) {
    const result = f.withFd([command, 'worker', `완료 통지 ${command}`], script, size);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).status, 'stored', command);
  }
  const bodies = f.bodies();
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].endsWith('완료 통지 send') && bodies[1].endsWith('완료 통지 mail'), bodies.join('|'));
  assert.ok(bodies.every(body => !body.includes('subprocess')), '부모 스크립트가 본문에 섞이지 않는다');
});

test('재현(실제 heredoc): heredoc으로 띄운 스크립트가 표준 입력을 물려준 채 위치 인자만으로 보내면 전달된다', () => {
  const f = fixture();
  // 인터프리터가 heredoc을 끝까지 읽은 뒤 자식을 띄운다. 자식은 그 표준 입력을 그대로 물려받는다(python subprocess.run의 기본과 같다).
  const result = f.shell(`"$KADAN_TEST_NODE" - <<'JS'
const {spawnSync} = require('node:child_process');
const r = spawnSync(process.env.KADAN_TEST_NODE, [process.env.KADAN_TEST_CLI, 'send', 'worker', 'heredoc 완료 통지'],
  {stdio: [0, 'pipe', 'pipe'], encoding: 'utf8'});
process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);
JS
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'stored');
  assert.deepEqual(f.bodies().map(body => body.endsWith('heredoc 완료 통지')), [true]);
});

test('이 명령에 직접 준 파일(읽기 위치 0) + 위치 인자는 계속 거절하고, 고치는 법을 알려 준다', () => {
  const f = fixture();
  const body = f.file('body.txt', '긴 본문\n둘째 줄\n');
  for (const command of ['mail', 'send']) {
    const result = f.withFd([command, 'worker', '--expect-reply', '질문'], body, 0);
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, REJECT, command);
    assert.match(result.stderr, HINT, command);
    assert.equal(result.rest, '긴 본문\n둘째 줄\n', '판정이 파일을 읽어 버리지 않는다');
  }
  assert.equal(f.bodies().length, 0);
});

test('직접 준 heredoc + 위치 인자도 계속 거절한다(본문이 버려지는 원래 사고 꼴)', () => {
  const f = fixture();
  const result = f.shell(`"$KADAN_TEST_NODE" "$KADAN_TEST_CLI" mail worker --expect-reply '질문' <<'EOF'
긴 본문
EOF
`);
  // heredoc을 파이프로 만드는 셸(dash 등)에서는 검출하지 못한다 — 그때는 위치 인자만 전달된다.
  if (result.status === 0) {
    assert.deepEqual(f.bodies().map(body => body.endsWith('질문')), [true]);
    return;
  }
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, REJECT);
  assert.equal(f.bodies().length, 0);
});

test('부모가 읽다 만 파일(위치가 0도 끝도 아님)은 위치 인자만 보내고 남은 입력을 건드리지 않는다', () => {
  const f = fixture();
  const lines = f.file('lines.txt', 'line1\nline2\nline3\n');
  const result = f.withFd(['mail', 'worker', '위치 본문'], lines, 6);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.rest, 'line2\nline3\n', '부모의 남은 입력이 그대로다');
  const [stored] = f.bodies();
  assert.ok(stored.endsWith('위치 본문') && !stored.includes('line2'), stored);
});

test('while read 반복문 안의 호출: 줄마다 보내고 반복문은 모든 줄을 본다', () => {
  const f = fixture();
  const lines = f.file('loop.txt', 'alpha\nbeta\ngamma\n');
  const result = f.shell(`while read -r line; do
  "$KADAN_TEST_NODE" "$KADAN_TEST_CLI" mail worker "줄 $line" >/dev/null || echo "FAIL $line"
done < '${lines}'
echo loop-done
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'loop-done', result.stdout + result.stderr);
  assert.deepEqual(f.bodies().map(body => body.split('\n').at(-1)), ['줄 alpha', '줄 beta', '줄 gamma']);
});

test('표준 입력으로 읽히는 셸 스크립트 가운데 줄의 호출: 보내고, 다음 줄도 그대로 실행된다', () => {
  const f = fixture();
  const result = f.shell(`/bin/sh <<'EOF'
"$KADAN_TEST_NODE" "$KADAN_TEST_CLI" mail worker '가운데 줄 본문' >/dev/null || echo FAIL
echo next-line-alive
EOF
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'next-line-alive', result.stdout + result.stderr);
  assert.equal(f.bodies().length, 1);
});

test('빈 파일·/dev/null·파이프·닫힌 표준 입력은 위치 인자를 그대로 보낸다', () => {
  const f = fixture();
  const empty = f.file('empty.txt', '');
  assert.equal(f.withFd(['mail', 'worker', '빈 파일'], empty, 0).status, 0);
  const run = (script) => { const r = f.shell(script); assert.equal(r.status, 0, r.stderr); };
  run(`"$KADAN_TEST_NODE" "$KADAN_TEST_CLI" mail worker 'dev null' </dev/null >/dev/null\n`);
  // 파이프는 검출하지 않는다: 위치 인자가 본문이고 파이프 내용은 읽지 않는다(잡지 못하는 꼴).
  run(`printf '파이프 본문\\n' | "$KADAN_TEST_NODE" "$KADAN_TEST_CLI" mail worker '파이프와 함께' >/dev/null\n`);
  run(`"$KADAN_TEST_NODE" "$KADAN_TEST_CLI" mail worker '닫힌 입력' <&- >/dev/null\n`);
  assert.deepEqual(f.bodies().map(body => body.split('\n').at(-1)), ['빈 파일', 'dev null', '파이프와 함께', '닫힌 입력']);
});

test('위치 인자 없이 파일만 주면 파일이 본문이다(기존 동작)', () => {
  const f = fixture();
  const body = f.file('body.txt', '파일 본문\n');
  const result = f.withFd(['mail', 'worker', '--expect-reply'], body, 0);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.bodies()[0].endsWith('파일 본문'));
});

test('TTY 표준 입력 + 위치 인자는 보낸다', {skip: !hasTmux}, () => {
  const f = fixture();
  const socket = path.basename(f.home), session = 'stdin-tty-probe';
  const status = path.join(f.home, 'tty-status'), err = path.join(f.home, 'tty-err');
  const q = value => "'" + value.replaceAll("'", "'\\''") + "'";
  // tmux 창 안의 명령은 표준 입력이 TTY다. 격리 소켓(-L)만 쓰고 자기 세션만 지운다.
  const command = `${q(process.execPath)} ${q(cli)} mail worker 'TTY 본문' >/dev/null 2>${q(err)}; echo $? > ${q(status)}; sleep 30`;
  const start = spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', session, command], {env: f.env, encoding: 'utf8'});
  assert.equal(start.status, 0, start.stderr);
  try {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(status) && Date.now() < deadline) spawnSync('sleep', ['0.1']);
    assert.equal(fs.readFileSync(status, 'utf8').trim(), '0', fs.existsSync(err) ? fs.readFileSync(err, 'utf8') : '상태 파일 없음');
    assert.deepEqual(f.bodies().map(body => body.endsWith('TTY 본문')), [true]);
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-session', '-t', session], {env: f.env});
  }
});

test('판정 규칙: 비어 있지 않은 파일이고 읽기 위치가 0일 때만 충돌, 위치를 모르면 거절(실패 닫힘)', () => {
  const file = size => ({isFile: () => true, size});
  const verdict = (stat, offset) => stdinBodyConflict({stat: () => stat, offset: () => offset});
  assert.equal(verdict(file(10), 0), 'unread-file');
  assert.equal(verdict(file(10), 4), null);
  assert.equal(verdict(file(10), 10), null);
  assert.equal(verdict(file(10), null), 'offset-unknown');
  assert.equal(verdict(file(0), 0), null);
  assert.equal(verdict({isFile: () => false, size: 5}, 0), null);
  assert.equal(stdinBodyConflict({stat: () => { throw new Error('EBADF'); }, offset: () => 0}), null);
  // 파일이 아니거나 비어 있으면 위치 조회(외부 명령)를 하지 않는다.
  let asked = 0;
  stdinBodyConflict({stat: () => file(0), offset: () => { asked++; return 0; }});
  stdinBodyConflict({stat: () => ({isFile: () => false, size: 5}), offset: () => { asked++; return 0; }});
  assert.equal(asked, 0);
});

test('읽기 위치 조회: procfs가 있으면 그 값을, 없으면 도우미 출력을 쓰고, 둘 다 못 쓰면 null', () => {
  const noProc = () => { throw new Error('ENOENT'); };
  assert.equal(stdinOffset({readFile: () => 'pos:\t42\nflags:\t0100000\n', spawn: () => assert.fail('도우미를 부르지 않는다')}), 42);
  assert.equal(stdinOffset({readFile: noProc, spawn: () => ({status: 0, stdout: '169'})}), 169);
  assert.equal(stdinOffset({readFile: noProc, spawn: () => ({status: 0, stdout: '0'})}), 0);
  assert.equal(stdinOffset({readFile: noProc, spawn: () => ({status: 0, stdout: ''})}), null);
  assert.equal(stdinOffset({readFile: noProc, spawn: () => ({status: null, stdout: '', error: new Error('ETIMEDOUT')})}), null);
  assert.equal(stdinOffset({readFile: noProc, spawn: () => ({status: 1, stdout: '12'})}), null);
});
