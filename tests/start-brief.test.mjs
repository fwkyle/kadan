import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, spawnSync} from 'node:child_process';
import {readLedger} from '../src/ledger.mjs';
import {briefMessage, briefSkipReason, briefStartedRole, isAiRunnerCommand, SECRETARY_BRIEF} from '../src/start-brief.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

// 단위: 보낼지 말지의 판단과 본문.
test('isAiRunnerCommand: 등록 실행기만 true, sh·카단 도구·셸 연산은 false', () => {
  for (const cmd of ['claude', 'codex --model x', '/usr/bin/claude --effort low', 'env FOO=1 codex', 'FOO=1 claude', 'kadan-claude --model x'])
    assert.equal(isAiRunnerCommand(cmd), true, cmd);
  for (const cmd of ['sh', 'node /repo/src/cli.mjs dashboard', 'claude && rm x', 'bash -c "x"', '', undefined])
    assert.equal(isAiRunnerCommand(cmd), false, String(cmd));
});

test('briefSkipReason: 재사용·프로필 없음·--no-prompt·실행기 아님·같은 대화 이어 열기는 건너뛴다', () => {
  const base = {reusing: false, roleProfile: 'worker', noPrompt: false, cmd: 'claude --model x'};
  assert.equal(briefSkipReason(base), null);
  assert.equal(briefSkipReason({...base, reusing: true}), 'reusing');
  assert.equal(briefSkipReason({...base, roleProfile: undefined}), 'no-profile');
  assert.equal(briefSkipReason({...base, noPrompt: true}), 'no-prompt');
  assert.equal(briefSkipReason({...base, cmd: 'sh'}), 'not-ai-runner');
  assert.equal(briefSkipReason({...base, cmd: 'codex resume 0197aaaa-1111-4222-8333-444455556666'}), 'resume');
  // R2: env 앞붙임·kadan 래퍼·경로 붙은 실행기로 이어 열어도 같은 판정이다. 이어 열기를 알 수 없는 실행기는 보내지 않는다.
  for (const cmd of ['env A=B codex resume 0197aaaa-1111-4222-8333-444455556666', 'env -u X codex resume 0197aaaa-1111-4222-8333-444455556666',
    'kadan-codex resume 0197aaaa-1111-4222-8333-444455556666', '/usr/bin/env -u X /opt/bin/claude --resume abc', 'A=B kadan-claude --continue'])
    assert.equal(briefSkipReason({...base, cmd}), 'resume', cmd);
  assert.equal(briefSkipReason({...base, cmd: 'env A=B claude --model x'}), null);
  assert.equal(briefSkipReason({...base, cmd: 'omo --model x'}), 'resume-unknown');
  assert.equal(briefSkipReason({...base, cmd: 'codex fork 0197aaaa-1111-4222-8333-444455556666'}), null);
});

test('briefStartedRole: 보내기 직전 세대가 바뀌었거나 확인할 수 없으면 건너뛴다', () => {
  const base = {role: 'r', session: 'kadan-r', roleProfile: 'super', cmd: 'claude', reusing: false, sleep: () => {}, floor: {read: () => 'ready'}};
  for (const current of [false, null, undefined]) {
    const warns = [];
    assert.equal(briefStartedRole({...base, isCurrent: () => current, send: () => assert.fail('보내면 안 됨'), warn: l => warns.push(l)}), 'skipped:generation-changed');
    assert.match(warns[0], /첫 안내 건너뜀 — 세대가 바뀜/);
  }
  assert.equal(briefStartedRole({...base, isCurrent: () => true, send: () => ({bytes: 1, mailId: 'm'}), log: () => {}}), 'sent');
});

test('briefMessage: 프로필별 스킬 이름이 들어가고 완성된 DONE 마커는 없다', () => {
  assert.equal(briefMessage({role: '비서', profile: 'secretary'}), SECRETARY_BRIEF);
  for (const [profile, skill] of [['super', 'kadan-super'], ['conductor', 'kadan-conductor']]) {
    const m = briefMessage({role: 'r1', profile});
    assert.match(m, new RegExp(`/${skill}`)); assert.match(m, /r1/);
  }
  for (const profile of ['worker', 'reviewer']) {
    const m = briefMessage({role: 'r1', profile});
    assert.match(m, /card-template/); assert.doesNotMatch(m, /kadan-(super|conductor|secretary)/);
  }
  for (const profile of ['super', 'conductor', 'worker', 'reviewer', 'secretary']) assert.doesNotMatch(briefMessage({role: 'r', profile}), /KADAN:DONE/);
});

test('briefStartedRole: 시간 초과·전송 실패는 던지지 않고 한 줄만 낸다', () => {
  const base = {role: 'r', session: 'kadan-r', roleProfile: 'super', cmd: 'claude', reusing: false, sleep: () => {}, tries: 3};
  const warns = [], logs = [];
  let n = 0;
  const moving = {read: () => `frame${n++}`};
  assert.equal(briefStartedRole({...base, floor: moving, send: () => assert.fail('보내면 안 됨'), warn: l => warns.push(l), log: l => logs.push(l)}), 'not-ready');
  assert.match(warns[0], /첫 안내 못 보냄.*\/kadan-super/);
  const still = {read: () => 'ready'};
  assert.equal(briefStartedRole({...base, floor: still, send: () => { throw new Error('입력 거절'); }, warn: l => warns.push(l)}), 'failed');
  assert.match(warns[1], /입력 거절/);
  assert.equal(briefStartedRole({...base, floor: still, send: () => ({bytes: 9, mailId: 'm'}), log: l => logs.push(l)}), 'sent');
  assert.match(logs[0], /첫 안내 전송됨/);
  assert.equal(briefStartedRole({...base, reusing: true, floor: still, send: () => assert.fail('재사용에는 보내면 안 됨')}), 'skipped:reusing');
});

// 격리 tmux: PATH 앞의 가짜 claude(한 번 그리고 기다린다)로 start를 실제로 돌린다. 실제 claude·codex는 띄우지 않는다.
function world(t, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kadan-brief-${tag}-`));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin');
  fs.mkdirSync(home); fs.mkdirSync(bin);
  const fake = body => fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${body}\n`, {mode: 0o755});
  fake('echo ready\nexec sleep 600');
  const socket = `kb${process.pid}${tag}`;
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux',
    KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_START_BRIEF_INTERVAL_MS: '100', KADAN_START_BRIEF_TRIES: '30'};
  delete env.KADAN_ROLE;
  const kadan = (...args) => spawnSync(process.execPath, [CLI, ...args], {env, encoding: 'utf8', timeout: 60000});
  const tmux = (...args) => spawnSync('tmux', ['-u', '-L', socket, ...args], {encoding: 'utf8'});
  t.after(() => tmux('kill-server'));
  const sends = () => readLedger(home).filter(e => e.kind === 'send');
  return {root, home, bin, fake, env, kadan, tmux, sends};
}
const hasTmux = () => spawnSync('tmux', ['-V']).status === 0;

test('격리 tmux: 새 세션 + --profile은 프로필이 붙은 첫 안내를 정확히 1건 보낸다', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'p');
  const expected = {super: 'kadan-super', conductor: 'kadan-conductor', secretary: 'kadan-secretary', worker: 'card-template', reviewer: 'card-template'};
  for (const [profile, needle] of Object.entries(expected)) {
    const role = `r-${profile}`;
    const before = w.sends().length;
    const r = w.kadan('start', role, '--hidden', '--profile', profile, '--cmd', 'claude', '--reason', 'brief test');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /첫 안내 전송됨/);
    const added = w.sends().slice(before);
    assert.equal(added.length, 1, `${profile}: 영수증 1건`);
    assert.equal(added[0].role, role); assert.equal(added[0].roleProfile, profile);
    assert.ok(added[0].roleInstructions, `${profile}: receiver-instructions 메타데이터`);
    const screen = w.tmux('capture-pane', '-p', '-J', '-S', '-2000', '-t', `=kadan-${role}:`).stdout;
    assert.match(screen, new RegExp(needle), `${profile}: 본문/지침에 ${needle}`);
    assert.match(screen, /kadan:receiver-instructions/);
  }
});

test('격리 tmux: 재사용 세션·--no-prompt·--cmd sh·프로필 없음은 0건', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'n');
  assert.equal(w.kadan('start', 'a', '--hidden', '--profile', 'worker', '--cmd', 'claude', '--reason', 't', '--no-prompt').status, 0);
  assert.equal(w.sends().length, 0, '--no-prompt');
  const again = w.kadan('start', 'a', '--hidden', '--profile', 'worker');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /이미 살아 있음/);
  assert.equal(w.sends().length, 0, '재사용 세션은 소급 주입하지 않는다');
  assert.equal(w.kadan('start', 'b', '--hidden', '--profile', 'worker', '--cmd', 'sh', '--reason', 't').status, 0);
  assert.equal(w.sends().length, 0, '--cmd sh');
  assert.equal(w.kadan('start', 'c', '--hidden', '--cmd', 'claude').status, 0);
  assert.equal(w.sends().length, 0, '프로필 없음');
});

test('격리 tmux: 화면이 끝내 안정되지 않으면 start는 종료 코드 0, 한 줄 안내, 세션은 살아 있다', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 't');
  w.fake('i=0\nwhile true; do i=$((i+1)); echo "frame $i"; done');
  const r = w.kadan('start', 'slow', '--hidden', '--profile', 'super', '--cmd', 'claude', '--reason', 't');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /첫 안내 못 보냄.*\/kadan-super/);
  assert.equal(w.sends().length, 0);
  assert.equal(w.tmux('has-session', '-t', '=kadan-slow').status, 0, '세션을 닫지 않는다');
});

test('격리 tmux: kadan up은 새로 띄운 비서에 1건(이중 아님), 재실행·--no-prompt는 0건 더', async t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'u');
  const port = await new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const up = (...extra) => w.kadan('up', '--cmd', 'claude', '--port', String(port), '--hidden', ...extra);
  const first = up();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(w.sends().filter(e => e.role === '비서').length, 1);
  assert.equal(w.sends()[0].roleProfile, 'secretary');
  const second = up();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(w.sends().length, 1, '재사용한 비서에는 다시 보내지 않는다');
});

test('격리 tmux: kadan up --no-prompt는 새 비서에도 보내지 않는다', async t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'q');
  const port = await new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const quiet = w.kadan('up', '--cmd', 'claude', '--port', String(port), '--hidden', '--no-prompt');
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.equal(w.tmux('has-session', '-t', '=kadan-비서').status, 0);
  assert.equal(w.sends().length, 0);
});

test('격리 tmux: 화면을 기다리는 동안 세션이 다른 세대로 바뀌면 옛 start는 보내지 않고 종료 코드 0', async t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'g');
  w.env.KADAN_START_BRIEF_INTERVAL_MS = '1500';
  const child = spawn(process.execPath, [CLI, 'start', 'swap', '--hidden', '--profile', 'worker', '--cmd', 'claude', '--reason', 't'], {env: w.env});
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const done = new Promise(res => child.on('close', res));
  for (let i = 0; i < 60 && !stdout.includes('시작됨'); i++) await new Promise(r => setTimeout(r, 50));
  assert.match(stdout, /시작됨/);
  // 화면 대기 중에 세션을 닫고 같은 이름으로 새 세대를 띄운다(새 세대는 안내 없이).
  assert.equal(w.tmux('kill-session', '-t', '=kadan-swap').status, 0);
  const second = w.kadan('start', 'swap', '--hidden', '--profile', 'worker', '--cmd', 'claude', '--reason', 't', '--no-prompt');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(await done, 0, stdout + stderr);
  assert.match(stderr, /첫 안내 건너뜀 — 세대가 바뀜/);
  assert.equal(w.sends().length, 0, '바뀐 세대에 안내가 들어가면 안 된다');
  assert.equal(w.tmux('has-session', '-t', '=kadan-swap').status, 0);
});
