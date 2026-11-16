// kadan start가 새로 만든 claude 세션의 폴더 신뢰 창을 확인 절차를 거쳐 통과하는 장치의 시험.
// 논리 시험은 가짜 화면만 쓰고, 마지막 격리 tmux 시험은 가짜 claude 스크립트로 보낸 키 이름을 실제로 확인한다. 운영 세션·실제 새 폴더는 쓰지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {autoAcceptTrust, readTrustSelection, sameWorkspace} from '../src/trust-accept.mjs';
import {readLedger} from '../src/ledger.mjs';

const CLI = path.resolve(import.meta.dirname, '../src/cli.mjs');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-auto-trust-')));
const WORK = path.join(root, 'work'), HOME = path.join(root, 'home');
fs.mkdirSync(WORK); fs.mkdirSync(HOME);
const hasTmux = () => spawnSync('tmux', ['-V']).status === 0;

const QUESTION = 'Is this a project you created or one you trust?';
const INPUT_BOX = ['─'.repeat(40), '❯ ', '─'.repeat(40), '  ? for shortcuts'].join('\n');
const trustScreen = ({shown = WORK, selected = 'no', marks} = {}) => [
  ' Accessing workspace:', '', ` ${shown}`, '',
  ` Quick safety check: ${QUESTION} (Like your own code, a well-known open source`,
  ' project, or work from your team).', '', ' Security guide', '',
  `${marks?.[0] ?? (selected === 'no' ? ' ❯' : '  ')} No, exit`,
  `${marks?.[1] ?? (selected === 'yes' ? ' ❯' : '  ')} Yes, I trust this folder`, '', ' Enter to confirm · Esc to cancel',
].join('\n');
// 공백이 빠진 사고 원본 꼴.
const incident = shown => ['Accessingworkspace:', '', shown, '', `Quicksafetycheck:${QUESTION.replace(/ /g, '')}(Likeyourowncode)`, '',
  '❯No,exit', 'Yes,Itrustthisfolder', '', 'EntertoconfirmESCtocancel'].join('\n');
const PERMISSION = ['Do you want to run this command?', '❯ 1. Yes', '  2. No', 'Enter to confirm'].join('\n');
const LOGIN = ['Select login method:', '❯ 1. Claude account', '  2. Anthropic Console account', 'Enter to confirm'].join('\n');

// 화면 상태 기계: Down은 선택을 옮기고, Yes에서 Enter면 입력창, No에서 Enter면 pane이 죽는다.
function fakePane(first, {stuck = false, vanishAfterDown = false, dieAfterEnter = false, refuse = null, promptStays = false, dieOnFinalRead = false} = {}) {
  const state = {screen: first, keys: [], atKey: [], alive: true, selected: 'no', reads: 0};
  const shown = () => WORK; // 이 시험의 Down 뒤 화면은 같은 경로로 다시 그린다
  return {state, deps: {
    workdir: WORK, home: HOME,
    read: () => { state.reads += 1; if (dieOnFinalRead && state.keys.includes('Enter')) state.alive = false; return state.screen; },
    key: name => {
      if (refuse) throw Object.assign(new Error('거절'), refuse);
      state.keys.push(name); state.atKey.push({name, reads: state.reads});
      if (name === 'Down') {
        if (!stuck) state.selected = state.selected === 'no' ? 'yes' : 'no';
        state.screen = vanishAfterDown ? INPUT_BOX : trustScreen({shown: shown(), selected: state.selected});
      } else if (name === 'Enter') {
        if (dieAfterEnter || state.selected === 'no') state.alive = false;
        else if (!promptStays) state.screen = INPUT_BOX;
      }
    },
    paneLive: () => state.alive, sleep: () => {}, tries: 4, intervalMs: 1, enterTries: 3,
  }};
}
const run = (screen, opts, patch = {}) => {
  const pane = fakePane(screen, opts);
  const result = autoAcceptTrust({...pane.deps, ...patch});
  return {result, keys: pane.state.keys};
};

test('성공: 선택이 No면 Down 1회 → 다시 읽기 → Enter 1회, 창이 사라지면 accepted', () => {
  const {result, keys} = run(trustScreen());
  assert.deepEqual(keys, ['Down', 'Enter']);
  assert.equal(result.result, 'accepted');
  assert.deepEqual(result.keys, ['Down', 'Enter']);
  assert.equal(result.path, WORK);
});

test('성공: 이미 Yes가 선택돼 있으면 Enter만 보낸다', () => {
  const pane = fakePane(trustScreen({selected: 'yes'}));
  pane.state.selected = 'yes';
  const result = autoAcceptTrust(pane.deps);
  assert.deepEqual(pane.state.keys, ['Enter']);
  assert.equal(result.result, 'accepted');
  // 처음부터 Yes여도 Enter 직전에 화면을 한 번 더 읽는다(첫 읽기 + 직전 재확인 = 2회).
  assert.deepEqual(pane.state.atKey, [{name: 'Enter', reads: 2}]);
});

test('중단: 처음부터 Yes인데 Enter 직전 재확인에서 선택이 바뀌었거나 창이 사라졌으면 Enter 0개', () => {
  for (const next of [trustScreen({selected: 'no'}), INPUT_BOX, trustScreen({shown: path.dirname(WORK), selected: 'yes'})]) {
    const pane = fakePane(trustScreen({selected: 'yes'}));
    let n = 0;
    const result = autoAcceptTrust({...pane.deps, read: () => (++n === 1 ? trustScreen({selected: 'yes'}) : next)});
    assert.deepEqual(pane.state.keys, []);
    assert.deepEqual([result.result, result.reason], ['failed', 'screen-changed']);
  }
});

test('키 0개(SPLIT_PATH): 경로가 두 줄 이상이면 첫 줄이 실제 경로여도 멈춘다 — 줄을 이어 붙이지 않는다', () => {
  for (const shown of [`${WORK}\n /other`, `${WORK}\n${WORK}`, `${WORK}/\n ${WORK}`]) {
    const {result, keys} = run(trustScreen({shown}));
    assert.deepEqual(keys, [], shown);
    assert.deepEqual([result.result, result.reason], ['skipped', 'path-ambiguous'], shown);
  }
  assert.deepEqual(readTrustSelection(trustScreen({shown: `${WORK}\n /other`})).pathAmbiguous, true);
});

test('중단(DEATH_DURING_READ): Enter 뒤 마지막 읽기 도중 pane이 죽으면 accepted로 기록하지 않는다', () => {
  const {result, keys} = run(trustScreen(), {dieOnFinalRead: true});
  assert.deepEqual(keys, ['Down', 'Enter']);
  assert.deepEqual([result.result, result.reason], ['failed', 'pane-dead']);
});

test('성공: 공백이 빠진 사고 원본 꼴도 같은 절차로 통과한다(경로가 맞을 때)', () => {
  const pane = fakePane(incident(WORK));
  pane.state.screen = incident(WORK);
  const result = autoAcceptTrust(pane.deps);
  assert.deepEqual(pane.state.keys, ['Down', 'Enter']);
  assert.equal(result.result, 'accepted');
});

test('키 0개: 경로가 다르거나 일부만 같으면 멈춘다(앞·뒤 일부 일치 금지)', () => {
  fs.mkdirSync(path.join(WORK, 'child'), {recursive: true});
  const sibling = `${WORK}-other`; fs.mkdirSync(sibling, {recursive: true});
  for (const shown of [path.dirname(WORK), path.join(WORK, 'child'), sibling, '/home/user/elsewhere', 'work', `${WORK}…`]) {
    const {result, keys} = run(trustScreen({shown}));
    assert.deepEqual(keys, [], shown);
    assert.equal(result.result, 'skipped', shown);
    assert.match(result.reason, /^path-(mismatch|unreadable)$/, shown);
  }
});

test('키 0개: 경로 줄이 없거나 읽을 수 없으면 멈춘다', () => {
  const noPath = trustScreen().replace(/ Accessing workspace:\n\n .+\n\n/, '');
  for (const screen of [noPath, trustScreen({shown: ''})]) {
    const {result, keys} = run(screen);
    assert.deepEqual(keys, []);
    assert.equal(result.result, 'skipped');
    assert.equal(result.reason, 'path-unreadable');
  }
});

test('키 0개: 선택 표시가 정확히 하나가 아니면 멈춘다', () => {
  for (const marks of [['  ', '  '], [' ❯', ' ❯']]) {
    const {result, keys} = run(trustScreen({marks}));
    assert.deepEqual(keys, [], JSON.stringify(marks));
    assert.equal(result.reason, 'selection-unknown');
  }
});

test('키 0개: 다른 모달·인용·정상 화면은 신뢰 창이 아니라 null(원장에도 안 남는다)', () => {
  const quoted = `> ${QUESTION}\n> Yes, I trust this folder\n${INPUT_BOX}`;
  for (const screen of [PERMISSION, LOGIN, quoted, INPUT_BOX, `${trustScreen()}\n${INPUT_BOX}`]) {
    const {result, keys} = run(screen);
    assert.equal(result, null, screen);
    assert.deepEqual(keys, [], screen);
  }
});

test('키 0개: 끄는 스위치 auto-trust.off가 있으면 멈춘다', () => {
  const off = path.join(HOME, 'auto-trust.off');
  fs.writeFileSync(off, '');
  try {
    const {result, keys} = run(trustScreen());
    assert.deepEqual(keys, []);
    assert.deepEqual([result.result, result.reason], ['skipped', 'switch-off']);
  } finally { fs.renameSync(off, `${off}.done`); }
});

test('키 0개: 사람이 방금 입력했거나 입력 시각을 모르면 멈춘다', () => {
  for (const code of ['KADAN_HUMAN_ACTIVE', 'KADAN_HUMAN_ACTIVITY_UNKNOWN']) {
    const {result, keys} = run(trustScreen(), {refuse: {code}});
    assert.deepEqual(keys, []);
    assert.deepEqual([result.result, result.reason, result.keys], ['skipped', 'human-active', []]);
  }
});

test('중단: Down 뒤에도 Yes가 안 되면 Down은 최대 2회, Enter는 0회', () => {
  const {result, keys} = run(trustScreen(), {stuck: true});
  assert.deepEqual(keys, ['Down', 'Down']);
  assert.deepEqual([result.result, result.reason], ['failed', 'select-failed']);
});

test('중단: Down 뒤 화면이 신뢰 창이 아니게 바뀌면 Enter를 보내지 않는다', () => {
  const {result, keys} = run(trustScreen(), {vanishAfterDown: true});
  assert.deepEqual(keys, ['Down']);
  assert.deepEqual([result.result, result.reason], ['failed', 'screen-changed']);
});

test('중단: Enter 뒤 pane이 죽으면 failed(pane-dead), 창이 안 사라지면 failed(prompt-remains)', () => {
  const dead = run(trustScreen(), {dieAfterEnter: true});
  assert.deepEqual(dead.keys, ['Down', 'Enter']);
  assert.deepEqual([dead.result.result, dead.result.reason], ['failed', 'pane-dead']);
  const stays = run(trustScreen(), {promptStays: true});
  assert.deepEqual([stays.result.result, stays.result.reason], ['failed', 'prompt-remains']);
});

test('중단: 키 전송이 거절되면(PID 불일치 등) 그 뒤 키를 보내지 않는다', () => {
  const pane = fakePane(trustScreen());
  let calls = 0;
  const result = autoAcceptTrust({...pane.deps, key: name => { calls += 1; if (calls === 2) throw new Error('PID 불일치'); pane.deps.key(name); }});
  assert.deepEqual(pane.state.keys, ['Down']);
  assert.deepEqual([result.result, result.reason, result.keys], ['failed', 'key-refused', ['Down']]);
});

test('화면을 못 읽거나 신뢰 창이 끝내 안 뜨면 null이고 키는 0개', () => {
  const pane = fakePane('');
  assert.equal(autoAcceptTrust({...pane.deps, read: () => { throw new Error('x'); }}), null);
  assert.equal(autoAcceptTrust({...pane.deps, read: () => ''}), null);
  assert.deepEqual(pane.state.keys, []);
});

test('readTrustSelection·sameWorkspace: 선택·경로 읽기와 ~ 풀기', () => {
  assert.deepEqual(readTrustSelection(trustScreen({selected: 'yes'})), {path: WORK, pathAmbiguous: false, selected: 'yes'});
  assert.deepEqual(readTrustSelection(trustScreen()), {path: WORK, pathAmbiguous: false, selected: 'no'});
  assert.equal(sameWorkspace('~/proj', '/home/ax/proj', {home: '/home/ax', realpath: p => p}), true);
  assert.equal(sameWorkspace('~/proj', '/home/ay/proj', {home: '/home/ax', realpath: p => p}), false);
  assert.equal(sameWorkspace('proj', '/home/ax/proj', {home: '/home/ax', realpath: p => p}), false);
  assert.equal(sameWorkspace('/a/b', '/a/b/', {realpath: p => p.replace(/\/$/, '')}), true);
});

// ---- 격리 tmux: 가짜 claude가 받은 키 이름을 파일로 남긴다 ----
function world(t, tag) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kadan-at-${tag}-`)));
  const home = path.join(dir, 'home'), work = path.join(dir, 'work'), bin = path.join(dir, 'bin');
  for (const d of [home, work, bin]) fs.mkdirSync(d);
  const socket = `kat${process.pid}${tag}`;
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux',
    KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_ALT_CHECK_MS: '0', KADAN_TRUST_INTERVAL_MS: '200'};
  for (const name of ['KADAN_ROLE', 'KADAN_ROTTIE_BIN', 'TMUX', 'TMUX_PANE']) delete env[name];
  const tmux = (...args) => spawnSync('tmux', ['-u', '-L', socket, ...args], {encoding: 'utf8'});
  t.after(() => { tmux('kill-server'); });
  const kadan = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], {env, cwd, encoding: 'utf8', timeout: 60000});
  return {dir, home, work, bin, kadan, tmux};
}
// 신뢰 창을 그리고 받은 키를 해석하는 가짜 claude. 기본 선택은 No이고, No에서 Enter면 종료(실제 사고와 같은 결과)한다.
function writeFakeClaude(w, {shown, name = 'claude'}) {
  const log = path.join(w.dir, 'keys.log');
  const body = `#!${process.execPath}
const fs = require('fs');
const log = ${JSON.stringify(log)};
let selected = 'no';
const draw = () => {
  process.stdout.write('\\x1bc');
  process.stdout.write([' Accessing workspace:', '', ' ' + ${JSON.stringify(shown ?? '')}.replace('%CWD%', process.cwd()), '',
    ' Quick safety check: ${QUESTION} (x)', '', ' Security guide', '',
    (selected === 'no' ? ' ❯' : '  ') + ' No, exit', (selected === 'yes' ? ' ❯' : '  ') + ' Yes, I trust this folder', '',
    ' Enter to confirm · Esc to cancel', ''].join('\\n'));
};
draw();
process.stdin.setRawMode(true);
process.stdin.on('data', chunk => {
  const text = chunk.toString('latin1');
  const name = /^\\x1b(\\[|O)B$/.test(text) ? 'Down' : /^\\x1b(\\[|O)A$/.test(text) ? 'Up' : text === '\\r' ? 'Enter' : JSON.stringify(text);
  fs.appendFileSync(log, name + '\\n');
  if (name === 'Down' || name === 'Up') { selected = selected === 'no' ? 'yes' : 'no'; draw(); }
  else if (name === 'Enter') {
    if (selected === 'no') process.exit(1);
    process.stdout.write('\\x1bc─────\\n❯ \\n─────\\n  ? for shortcuts\\n');
  }
});
setInterval(() => {}, 1000);
`;
  fs.writeFileSync(path.join(w.bin, name), body, {mode: 0o755});
  return log;
}
const readKeys = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

test('격리 tmux: 가짜 claude 신뢰 창을 Down → Enter로 통과하고 trust 사건 accepted 1줄을 남긴다', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'a');
  const log = writeFakeClaude(w, {shown: '%CWD%'});
  const r = w.kadan(w.work, 'start', 'trust-a', '--hidden', '--cmd', 'claude', '--reason', 'auto trust test', '--no-prompt');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /폴더 신뢰 확인 후 통과/);
  assert.deepEqual(readKeys(log), ['Down', 'Enter']);
  const trust = readLedger(w.home).filter(e => e.kind === 'trust');
  assert.equal(trust.length, 1);
  assert.deepEqual([trust[0].result, trust[0].role, trust[0].session, trust[0].cwd, trust[0].keys], ['accepted', 'trust-a', 'kadan-trust-a', w.work, ['Down', 'Enter']]);
  assert.equal(w.tmux('has-session', '-t', '=kadan-trust-a').status, 0, '세션이 살아 있다');
});

test('격리 tmux: 경로가 다른 신뢰 창·끄는 스위치·claude가 아닌 실행기·재사용은 키 0개', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'b');
  const log = writeFakeClaude(w, {shown: '/home/user/elsewhere'});
  const mismatch = w.kadan(w.work, 'start', 'trust-b', '--hidden', '--cmd', 'claude', '--reason', 't', '--no-prompt');
  assert.equal(mismatch.status, 0, mismatch.stdout + mismatch.stderr);
  assert.deepEqual(readKeys(log), []);
  const events = readLedger(w.home).filter(e => e.kind === 'trust');
  assert.deepEqual(events.map(e => [e.result, e.reason, e.keys]), [['skipped', 'path-mismatch', []]]);
  // 이미 살아 있는 세션 재사용: 새로 만들지 않았으므로 신뢰 사건도 키도 없다.
  const again = w.kadan(w.work, 'start', 'trust-b', '--hidden', '--cmd', 'claude', '--reason', 't', '--no-prompt');
  assert.match(again.stdout, /이미 살아 있음/);
  assert.deepEqual(readKeys(log), []);
  assert.equal(readLedger(w.home).filter(e => e.kind === 'trust').length, 1);
  // 끄는 스위치
  w.tmux('kill-session', '-t', '=kadan-trust-b');
  fs.writeFileSync(path.join(w.home, 'auto-trust.off'), '');
  fs.writeFileSync(path.join(w.bin, 'claude'), fs.readFileSync(path.join(w.bin, 'claude'), 'utf8').replace(JSON.stringify('/home/user/elsewhere'), JSON.stringify('%CWD%')));
  const off = w.kadan(w.work, 'start', 'trust-c', '--hidden', '--cmd', 'claude', '--reason', 't', '--no-prompt');
  assert.equal(off.status, 0, off.stdout + off.stderr);
  assert.deepEqual(readKeys(log), []);
  assert.deepEqual(readLedger(w.home).filter(e => e.kind === 'trust' && e.role === 'trust-c').map(e => [e.result, e.reason, e.keys]), [['skipped', 'switch-off', []]]);
});

test('격리 tmux: codex·이어 연 claude 대화는 신뢰 창이 떠 있어도 키 0개, trust 사건 없음(지금처럼 멈춤)', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'c');
  const log = writeFakeClaude(w, {shown: '%CWD%', name: 'codex'});
  writeFakeClaude(w, {shown: '%CWD%'});
  const cases = [['trust-d', 'codex'], ['trust-e', 'claude --resume 00000000-0000-4000-8000-000000000000'], ['trust-f', 'claude --continue']];
  for (const [role, cmd] of cases) {
    const r = w.kadan(w.work, 'start', role, '--hidden', '--cmd', cmd, '--reason', 'auto trust test', '--no-prompt');
    assert.equal(r.status, 0, `${cmd}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /폴더 신뢰/, cmd);
  }
  assert.deepEqual(readKeys(log), []);
  assert.equal(readLedger(w.home).filter(e => e.kind === 'trust').length, 0);
});

test('격리 tmux(CLI_SPLIT_PATH): 경로가 두 줄이면 첫 줄이 작업 폴더여도 키 0개, path-ambiguous', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'd');
  const log = writeFakeClaude(w, {shown: '%CWD%\n/other'});
  const r = w.kadan(w.work, 'start', 'trust-g', '--hidden', '--cmd', 'claude', '--reason', 'auto trust test', '--no-prompt');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readKeys(log), []);
  assert.deepEqual(readLedger(w.home).filter(e => e.kind === 'trust').map(e => [e.result, e.reason, e.keys]), [['skipped', 'path-ambiguous', []]]);
  assert.doesNotMatch(r.stdout, /폴더 신뢰 확인 후 통과/);
});

test('격리 tmux(CLI_DEAD_PANE): Enter 뒤 프로세스가 끝나 remain-on-exit로 같은 PID의 죽은 pane이 남으면 failed(pane-dead)', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'e');
  const log = writeFakeClaude(w, {shown: '%CWD%'});
  const file = path.join(w.bin, 'claude');
  let body = fs.readFileSync(file, 'utf8');
  body = body.replace("const fs = require('fs');", "const fs = require('fs');\nrequire('child_process').spawnSync('tmux', ['-L', process.env.KADAN_SOCKET, 'set-option', '-w', 'remain-on-exit', 'on']);");
  body = body.replace("process.stdout.write('\\x1bc─────\\n❯ \\n─────\\n  ? for shortcuts\\n');", "process.stdout.write('\\x1bcREADY\\n'); process.exit(0);");
  fs.writeFileSync(file, body);
  const r = w.kadan(w.work, 'start', 'trust-h', '--hidden', '--cmd', 'claude', '--reason', 'auto trust test', '--no-prompt');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(w.tmux('display-message', '-p', '-t', '=kadan-trust-h:', '#{pane_pid}|#{pane_dead}').stdout, /\|1/, '죽은 pane이 남아야 시험이 성립한다');
  assert.deepEqual(readKeys(log), ['Down', 'Enter']);
  const trust = readLedger(w.home).filter(e => e.kind === 'trust');
  assert.deepEqual(trust.map(e => [e.result, e.reason]), [['failed', 'pane-dead']]);
  assert.doesNotMatch(r.stdout, /폴더 신뢰 확인 후 통과/);
});
