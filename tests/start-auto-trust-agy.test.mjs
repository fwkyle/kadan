// kadan start가 새로 만든 agy(Antigravity CLI) 세션의 폴더 신뢰 창 자동 통과 시험.
// agy 창은 기본 선택이 이미 Yes라 Enter 1회만 보낸다(화살표 없음). 선택이 No이거나 모르면 키 0개.
// 논리 시험은 2026-11-24 실측 화면 꼴의 고정 입력만 쓴다 — 실제 agy는 띄우지 않는다(agy는 신뢰 목록에 임시 폴더를 더한다).
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {autoAcceptTrust, hasAgyTrustPrompt, readAgyTrustSelection} from '../src/trust-accept.mjs';
import {hasTrustPrompt, sendTmux} from '../src/floor-tmux.mjs';
import {readLedger} from '../src/ledger.mjs';
import {ANSWERING_TAIL, FULL_120, FULL_152, HALF_120, HALF_80, INPUT_TAIL, TRUNCATED_80} from './fixtures/agy-trust-screens.mjs';

const CLI = path.resolve(import.meta.dirname, '../src/cli.mjs');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-auto-trust-agy-')));
const WORK = path.join(root, 'work'), HOME = path.join(root, 'home');
fs.mkdirSync(WORK); fs.mkdirSync(HOME);
const hasTmux = () => spawnSync('tmux', ['-V']).status === 0;

const INPUT_BOX = ['─'.repeat(40), '> ', '─'.repeat(40), '  ? for shortcuts'].join('\n');
const agyScreen = ({shown = WORK, selected = 'yes', marks} = {}) => [
  '  Accessing workspace:', `  ${shown}`, '  Do you trust the contents of this project?',
  '  Antigravity CLI requires permission to read, edit, and execute files here.',
  `${marks?.[0] ?? (selected === 'yes' ? '  >' : '   ')} Yes, I trust this folder`,
  `${marks?.[1] ?? (selected === 'no' ? '  >' : '   ')} No, exit`,
  '  ↑/↓ Navigate · enter Confirm',
].join('\n');
const CLAUDE_SCREEN = [' Accessing workspace:', '', ` ${WORK}`, '', ' Quick safety check: Is this a project you created or one you trust? (x)', '',
  ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'].join('\n');

// 화면 상태 기계: Yes에서 Enter면 입력창, No에서 Enter면 pane이 죽는다. Down은 선택을 옮긴다(보내면 안 되는 키라 기록만 본다).
function fakePane(first, {selected = 'yes', promptStays = false, dieAfterEnter = false} = {}) {
  const state = {screen: first, keys: [], alive: true, selected};
  return {state, deps: {
    harness: 'agy', workdir: WORK, home: HOME,
    read: () => state.screen,
    key: name => {
      state.keys.push(name);
      if (name === 'Enter') {
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

test('성공: agy 창에서 Yes가 선택돼 있으면 Enter 1회만 보내고 accepted(enter)', () => {
  const {result, keys} = run(agyScreen());
  assert.deepEqual(keys, ['Enter']);
  assert.deepEqual([result.result, result.reason, result.keys, result.path], ['accepted', 'enter', ['Enter'], WORK]);
});

test('키 0개: 선택이 No면 화살표도 Enter도 보내지 않고 skipped(selection-not-yes)', () => {
  const {result, keys} = run(agyScreen({selected: 'no'}), {selected: 'no'});
  assert.deepEqual(keys, []);
  assert.deepEqual([result.result, result.reason, result.keys], ['skipped', 'selection-not-yes', []]);
});

test('키 0개: 선택 표시가 없거나 둘이거나 선택지 줄이 아닌 곳에 있으면 skipped(selection-unknown)', () => {
  for (const marks of [['   ', '   '], ['  >', '  >']]) {
    const {result, keys} = run(agyScreen({marks}));
    assert.deepEqual(keys, [], JSON.stringify(marks));
    assert.deepEqual([result.result, result.reason], ['skipped', 'selection-unknown'], JSON.stringify(marks));
  }
  const stray = agyScreen({marks: ['   ', '   ']}).replace('  Antigravity CLI', '> Antigravity CLI');
  const {result, keys} = run(stray);
  assert.deepEqual(keys, []);
  assert.deepEqual([result.result, result.reason], ['skipped', 'selection-unknown']);
});

test('키 0개: 경로가 다르거나 일부만 같거나 두 줄이면 멈춘다', () => {
  fs.mkdirSync(path.join(WORK, 'child'), {recursive: true});
  for (const shown of [path.dirname(WORK), path.join(WORK, 'child'), `${WORK}-other`, 'work', `${WORK}…`]) {
    const {result, keys} = run(agyScreen({shown}));
    assert.deepEqual(keys, [], shown);
    assert.equal(result.result, 'skipped', shown);
    assert.match(result.reason, /^path-(mismatch|unreadable)$/, shown);
  }
  for (const shown of [`${WORK}\n  /other`, `${WORK}\n  ${WORK}`]) {
    const {result, keys} = run(agyScreen({shown}));
    assert.deepEqual(keys, [], shown);
    assert.deepEqual([result.result, result.reason], ['skipped', 'path-ambiguous'], shown);
  }
});

test('키 0개: auto-trust.off가 있으면 skipped(switch-off)', t => {
  const off = path.join(HOME, 'auto-trust.off');
  fs.writeFileSync(off, '');
  t.after(() => fs.rmSync(off, {force: true}));
  const {result, keys} = run(agyScreen());
  assert.deepEqual(keys, []);
  assert.deepEqual([result.result, result.reason], ['skipped', 'switch-off']);
});

test('중단: Enter 직전 재확인에서 선택이 No로 바뀌었거나 창이 사라졌거나 경로가 달라졌으면 Enter 0개', () => {
  for (const next of [agyScreen({selected: 'no'}), INPUT_BOX, agyScreen({shown: path.dirname(WORK)})]) {
    const pane = fakePane(agyScreen());
    let n = 0;
    const result = autoAcceptTrust({...pane.deps, read: () => (++n === 1 ? agyScreen() : next)});
    assert.deepEqual(pane.state.keys, []);
    assert.deepEqual([result.result, result.reason], ['failed', 'screen-changed']);
  }
});

test('실패: Enter 뒤에도 창이 남으면 prompt-remains, pane이 죽으면 pane-dead — accepted로 기록하지 않는다', () => {
  const stay = run(agyScreen(), {promptStays: true});
  assert.deepEqual(stay.keys, ['Enter']);
  assert.deepEqual([stay.result.result, stay.result.reason], ['failed', 'prompt-remains']);
  const dead = run(agyScreen(), {dieAfterEnter: true});
  assert.deepEqual([dead.result.result, dead.result.reason], ['failed', 'pane-dead']);
});

test('판정 경계: 창이 아닌 화면(인용·claude 창·입력창)은 agy 창이 아니고, agy 창은 claude 판정에 안 걸린다', () => {
  assert.equal(hasAgyTrustPrompt(agyScreen()), true);
  assert.deepEqual(readAgyTrustSelection(agyScreen()), {path: WORK, pathAmbiguous: false, selected: 'yes'});
  assert.deepEqual(readAgyTrustSelection(agyScreen({selected: 'no'})).selected, 'no');
  // 창 문구를 인용한 응답은 아래에 입력창이 이어진다 → 안내 줄이 마지막이 아니라 창이 아니다.
  assert.equal(hasAgyTrustPrompt(`${agyScreen()}\n${INPUT_BOX}`), false);
  assert.equal(hasAgyTrustPrompt(INPUT_BOX), false);
  assert.equal(hasAgyTrustPrompt(CLAUDE_SCREEN), false);
  assert.equal(hasAgyTrustPrompt(''), false);
  assert.equal(hasAgyTrustPrompt(undefined), false);
  // claude 판정(hasTrustPrompt)은 agy 화면을 창으로 보지 않는다 — claude 판정을 바꾸지 않은 것을 못 박는다(agy는 별도 판정).
  assert.equal(hasTrustPrompt(agyScreen()), false);
  // 실행기를 잘못 짚으면 창으로 보지 않아 키 0개.
  const wrongKind = run(CLAUDE_SCREEN);
  assert.equal(wrongKind.result, null);
  assert.deepEqual(wrongKind.keys, []);
  const claudeOnAgy = fakePane(agyScreen());
  assert.equal(autoAcceptTrust({...claudeOnAgy.deps, harness: 'claude'}), null);
  assert.deepEqual(claudeOnAgy.state.keys, []);
  assert.equal(autoAcceptTrust({...claudeOnAgy.deps, harness: 'codex'}), null);
});

test('성공: 화면 폭으로 접혀 -J로 합쳐진 긴 경로(한 줄로 읽힘)가 작업 폴더와 같으면 accepted, 합쳐도 다르면 skipped', () => {
  const long = path.join(root, 'a'.repeat(40), 'b'.repeat(40), 'work');
  fs.mkdirSync(long, {recursive: true});
  assert.ok(long.length > 80);
  const same = run(agyScreen({shown: long}), {}, {workdir: long});
  assert.deepEqual(same.keys, ['Enter']);
  assert.deepEqual([same.result.result, same.result.path], ['accepted', long]);
  const other = run(agyScreen({shown: `${long}-other`}), {}, {workdir: long});
  assert.deepEqual(other.keys, []);
  assert.equal(other.result.result, 'skipped');
});

// ---- 우편·알림(sendTmux)도 agy 신뢰 창에서 멈춘다 ----
function fakeRun(screen, calls) {
  return args => {
    calls.push(args);
    if (args[0] === 'capture-pane') return screen;
    if (args[0] === 'display-message') return '0\n';
    if (args[0] === 'list-clients') return '';
    return undefined;
  };
}
const noopSpawn = () => ({});
const keysSent = calls => calls.filter(c => ['load-buffer', 'paste-buffer', 'send-keys'].includes(c[0])).length;

test('sendTmux: agy 신뢰 창이면 일반·카드·알림 전송 모두 키 0회 + KADAN_TRUST_PROMPT + not-sent', () => {
  const variants = {
    '일반 우편': {},
    '카드 발령(cardIdentity)': {cardIdentity: {currentPid: '1', harness: 'agy', model: 'm'}},
    '감시 알림(강제 차례)': {notificationGuard: {force: true, humanIdleMs: 30000}},
  };
  for (const selected of ['yes', 'no']) {
    for (const [name, options] of Object.entries(variants)) {
      const calls = [];
      assert.throws(() => sendTmux('kadan-trust', '본문', {run: fakeRun(agyScreen({selected}), calls), spawn: noopSpawn, ...options}), error => {
        assert.equal(error.code, 'KADAN_TRUST_PROMPT', name);
        assert.equal(error.delivery, 'not-sent', name);
        assert.match(error.message, /agy가 폴더 신뢰 확인 창/);
        return true;
      }, name);
      assert.equal(keysSent(calls), 0, `${name}: 키 0회`);
      assert.deepEqual(calls.map(c => c[0]), ['capture-pane'], `${name}: 화면 읽기 한 번뿐`);
    }
  }
});

test('sendTmux: agy 보통 입력창·창 문구를 인용한 화면은 그대로 보낸다, claude 신뢰 창은 지금처럼 멈춘다', () => {
  for (const screen of [INPUT_BOX, `${agyScreen()}\n${INPUT_BOX}`, '  Do you trust the contents of this project?\n> ']) {
    const calls = [];
    const receipt = sendTmux('kadan-trust', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn});
    assert.equal(receipt.keyDelivery, 'sent');
    assert.equal(calls.filter(c => c[0] === 'send-keys').length, 1);
  }
  const calls = [];
  assert.throws(() => sendTmux('kadan-trust', '본문', {run: fakeRun(CLAUDE_SCREEN, calls), spawn: noopSpawn}), e => e.code === 'KADAN_TRUST_PROMPT' && /Claude/.test(e.message));
  assert.equal(keysSent(calls), 0);
});

// ---- 안내 줄 아래에 상태 글이 있는 꼴(2026-11-26 실제 화면, tests/fixtures/agy-trust-screens.mjs) ----
const REAL_SCREENS = {HALF_80, HALF_120, FULL_120, FULL_152};

test('상태 글 꼴: 실제 화면(폭별·그리는 중·완성)은 agy 창이고 경로·선택을 읽어 Enter 1회로 통과, 우편은 키 0회로 멈춘다', () => {
  for (const [name, build] of Object.entries(REAL_SCREENS)) {
    const screen = build(WORK);
    assert.deepEqual(readAgyTrustSelection(screen), {path: WORK, pathAmbiguous: false, selected: 'yes'}, name);
    const {result, keys} = run(screen);
    assert.deepEqual(keys, ['Enter'], name);
    assert.deepEqual([result.result, result.path], ['accepted', WORK], name);
    const calls = [];
    assert.throws(() => sendTmux('kadan-trust', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn}),
      e => e.code === 'KADAN_TRUST_PROMPT' && e.delivery === 'not-sent', name);
    assert.equal(keysSent(calls), 0, name);
  }
});

test('상태 글 꼴: 선택이 No면 selected no로 읽어 키 0개, 경로 줄이 둘이면 pathAmbiguous', () => {
  const no = FULL_152(WORK).replace('> Yes, I trust', '  Yes, I trust').replace('  No, exit', '> No, exit');
  assert.deepEqual(readAgyTrustSelection(no), {path: WORK, pathAmbiguous: false, selected: 'no'});
  const {result, keys} = run(no, {selected: 'no'});
  assert.deepEqual(keys, []);
  assert.deepEqual([result.result, result.reason], ['skipped', 'selection-not-yes']);
  assert.deepEqual(readAgyTrustSelection(FULL_152(`${WORK}\n/other`)), {path: null, pathAmbiguous: true, selected: 'yes'});
});

test('상태 글 꼴 음성: 창 문구를 인용한 뒤 입력창·답 쓰는 중 화면이 이어지면 창이 아니다', () => {
  const quoted = FULL_152(WORK).trimEnd();
  for (const [name, tail] of Object.entries({INPUT_TAIL, ANSWERING_TAIL})) {
    // 입력창 전체가 이어지는 꼴과, 바닥 안내+상태 글 한 줄만 안내 줄 바로 아래에 오는 더 가까운 꼴.
    for (const screen of [`${quoted}\n${tail}`, `${FULL_152(WORK).split('\n').slice(0, 12).join('\n')}\n${tail.split('\n').at(-1)}`]) {
      assert.equal(readAgyTrustSelection(screen), null, `${name}\n${screen}`);
    }
  }
});

test('상태 글 꼴 음성: 안내 줄 아래에 상태 글이 아닌 줄이 있거나 상태 글 뒤에 줄이 더 있으면 창이 아니다', () => {
  const window = agyScreen();
  const status = `${' '.repeat(60)}auto · Gemini 4 Neon · high`;
  assert.notEqual(readAgyTrustSelection(`${window}\n${status}`), null, '대조군');
  const wide = ' '.repeat(60);
  for (const line of [
    'Enter to confirm · Esc to cancel',
    '  ↑/↓ Navigate · enter Confirm',
    '? for shortcuts          auto · Gemini 4 Neon · high',
    'auto · Gemini 4 Neon · high',
    '    auto · Gemini 4 Neon · high',
    `${wide}Gemini 4 Neon`,
    `${wide}? for shortcuts · high`,
    `${wide}esc to cancel     auto · high`,
    `${wide}위 창은 · 인용입니다`,
    `${wide}one · two · three · four`,
    `${wide}${'word '.repeat(16)}end · high`,
  ]) {
    assert.equal(readAgyTrustSelection(`${window}\n${line}`), null, line);
  }
  for (const rest of [`${status}\n> `, `${status}\n${status}`, `  hello\n${status}`]) {
    assert.equal(readAgyTrustSelection(`${window}\n${rest}`), null, rest);
  }
});

test("상태 글 꼴: 강도 끝이 잘린 실제 화면('mediu', 경로 두 줄)은 창이라 우편은 키 0회, 경로가 모호해 자동 통과도 키 0개", () => {
  const screen = TRUNCATED_80(`${WORK}-first-half`, 'second-half/work');
  assert.deepEqual(readAgyTrustSelection(screen), {path: null, pathAmbiguous: true, selected: 'yes'});
  const {result, keys} = run(screen);
  assert.deepEqual(keys, []);
  assert.deepEqual([result.result, result.reason], ['skipped', 'path-ambiguous']);
  const calls = [];
  assert.throws(() => sendTmux('kadan-trust', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn}), e => e.code === 'KADAN_TRUST_PROMPT');
  assert.equal(keysSent(calls), 0);
});

test('상태 글 꼴: 강도 낱말(low·medium·high·xhigh)은 모드가 있든 없든 창이다(시니어 시험 꼴 포함)', () => {
  for (const status of ['Gemini 3.8 Flash · low', 'auto · Fake Model · medium', 'Gemini 4 Neon · high', 'auto · Gemini 4 Neon · xhigh']) {
    const screen = `${agyScreen()}\n${' '.repeat(60)}${status}`;
    assert.deepEqual(readAgyTrustSelection(screen), {path: WORK, pathAmbiguous: false, selected: 'yes'}, status);
  }
});

// 검수 exec-07d2fdf3의 반례: 상태 글 없이 인용한 창 뒤에 들여쓴 일반 문장이 화면 끝에 있다.
test('상태 글 꼴 음성: 인용한 창 뒤의 들여쓴 일반 문장은 창이 아니라 우편이 가고 자동 통과 키 0개, 입력창이 이어져도 같다', () => {
  const quoted = FULL_152(WORK).trimEnd().split('\n').slice(0, -1).join('\n');
  const prose = `${quoted}\n        Review notes · See above`;
  for (const screen of [prose, `${prose}\n${INPUT_TAIL}`]) {
    assert.equal(readAgyTrustSelection(screen), null, screen);
    const {result, keys} = run(screen);
    assert.equal(result, null);
    assert.deepEqual(keys, []);
    const calls = [];
    assert.equal(sendTmux('kadan-trust', '본문', {run: fakeRun(screen, calls), spawn: noopSpawn}).keyDelivery, 'sent');
    assert.equal(calls.filter(c => c[0] === 'send-keys').length, 1);
  }
});

test('상태 글 꼴 음성: 마지막 칸이 강도 낱말이 아니거나 칸이 셋인데 첫 칸이 모드 낱말이 아니면 창이 아니다', () => {
  for (const status of [
    'Review notes · See above', 'Gemini 4 Neon · fast', 'auto · Gemini 4 Neon · ready', 'Gemini 4 Neon · High',
    'Gemini 4 Neon · highest', 'Gemini 4 Neon · high.', 'Gemini 4 Neon · mediums', 'Gemini 4 Neon · medi',
    'high · Gemini 4 Neon', 'Review · Gemini 4 Neon · high', 'automatic · Gemini 4 Neon · high',
  ]) {
    assert.equal(readAgyTrustSelection(`${agyScreen()}\n${' '.repeat(60)}${status}`), null, status);
  }
});

// ---- 격리 tmux: 가짜 agy가 받은 키 이름을 파일로 남긴다 ----
function world(t, tag, {deep = false} = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kadan-aa-${tag}-`)));
  const home = path.join(dir, 'home'), work = deep ? path.join(dir, 'a'.repeat(40), 'b'.repeat(40), 'work') : path.join(dir, 'work'), bin = path.join(dir, 'bin');
  for (const d of [home, work, bin]) fs.mkdirSync(d, {recursive: true});
  const socket = `kaa${process.pid}${tag}`;
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux',
    KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_ALT_CHECK_MS: '0', KADAN_TRUST_INTERVAL_MS: '200'};
  for (const name of ['KADAN_ROLE', 'KADAN_ROTTIE_BIN', 'TMUX', 'TMUX_PANE']) delete env[name];
  const tmux = (...args) => spawnSync('tmux', ['-u', '-L', socket, ...args], {encoding: 'utf8'});
  t.after(() => { tmux('kill-server'); });
  const kadan = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], {env, cwd, encoding: 'utf8', timeout: 60000});
  return {dir, home, work, bin, kadan, tmux};
}
function writeFakeAgy(w, {shown, selected = 'yes', name = 'agy'}) {
  const log = path.join(w.dir, 'keys.log');
  const body = `#!${process.execPath}
const fs = require('fs');
const log = ${JSON.stringify(log)};
let selected = ${JSON.stringify(selected)};
const draw = () => {
  process.stdout.write('\\x1bc');
  process.stdout.write(['  Accessing workspace:', '  ' + ${JSON.stringify(shown)}.replace('%CWD%', process.cwd()),
    '  Do you trust the contents of this project?', '  Antigravity CLI requires permission to read, edit, and execute files here.',
    (selected === 'yes' ? '  >' : '   ') + ' Yes, I trust this folder', (selected === 'no' ? '  >' : '   ') + ' No, exit',
    '  ↑/↓ Navigate · enter Confirm', ''].join('\\n'));
};
draw();
process.stdin.setRawMode(true);
process.stdin.on('data', chunk => {
  const text = chunk.toString('latin1');
  const key = /^\\x1b(\\[|O)B$/.test(text) ? 'Down' : /^\\x1b(\\[|O)A$/.test(text) ? 'Up' : text === '\\r' ? 'Enter' : JSON.stringify(text);
  fs.appendFileSync(log, key + '\\n');
  if (key === 'Down' || key === 'Up') { selected = selected === 'no' ? 'yes' : 'no'; draw(); }
  else if (key === 'Enter') {
    if (selected === 'no') process.exit(1);
    process.stdout.write('\\x1bc─────\\n> \\n─────\\n  ? for shortcuts\\n');
  }
});
setInterval(() => {}, 1000);
`;
  fs.writeFileSync(path.join(w.bin, name), body, {mode: 0o755});
  return log;
}
const readKeys = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const start = (w, role, cmd) => w.kadan(w.work, 'start', role, '--hidden', '--cmd', cmd, '--reason', 'auto trust agy test', '--no-prompt');

test('격리 tmux: 가짜 agy 신뢰 창을 Enter 1회로 통과하고 trust 사건 accepted 1줄을 남긴다', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'a');
  const log = writeFakeAgy(w, {shown: '%CWD%'});
  const r = start(w, 'trust-a', 'agy --model gemini-x');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /폴더 신뢰 확인 후 통과/);
  assert.deepEqual(readKeys(log), ['Enter']);
  const trust = readLedger(w.home).filter(e => e.kind === 'trust');
  assert.equal(trust.length, 1);
  assert.deepEqual([trust[0].result, trust[0].reason, trust[0].role, trust[0].cwd, trust[0].keys, trust[0].screenPath],
    ['accepted', 'enter', 'trust-a', w.work, ['Enter'], w.work]);
  assert.equal(w.tmux('has-session', '-t', '=kadan-trust-a').status, 0, '세션이 살아 있다');
});

test('격리 tmux: 선택이 No인 agy 창·경로가 다른 창·끄는 스위치·이어 연 대화·재사용은 키 0개', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'b');
  const log = writeFakeAgy(w, {shown: '%CWD%', selected: 'no'});
  const no = start(w, 'trust-b', 'agy');
  assert.equal(no.status, 0, no.stdout + no.stderr);
  assert.deepEqual(readKeys(log), []);
  assert.deepEqual(readLedger(w.home).filter(e => e.kind === 'trust').map(e => [e.result, e.reason, e.keys]), [['skipped', 'selection-not-yes', []]]);
  assert.match(no.stdout, /폴더 신뢰 창 자동 통과 안 함/);
  // 이미 살아 있는 세션 재사용: 새로 만들지 않았으므로 신뢰 사건도 키도 없다.
  assert.match(start(w, 'trust-b', 'agy').stdout, /이미 살아 있음/);
  assert.equal(readLedger(w.home).filter(e => e.kind === 'trust').length, 1);
  // 경로가 다른 창
  writeFakeAgy(w, {shown: '/home/user/elsewhere'});
  assert.equal(start(w, 'trust-c', 'agy').status, 0);
  assert.deepEqual(readKeys(log), []);
  assert.deepEqual(readLedger(w.home).filter(e => e.role === 'trust-c' && e.kind === 'trust').map(e => [e.result, e.reason]), [['skipped', 'path-mismatch']]);
  // 끄는 스위치
  writeFakeAgy(w, {shown: '%CWD%'});
  fs.writeFileSync(path.join(w.home, 'auto-trust.off'), '');
  assert.equal(start(w, 'trust-d', 'agy').status, 0);
  assert.deepEqual(readKeys(log), []);
  assert.deepEqual(readLedger(w.home).filter(e => e.role === 'trust-d' && e.kind === 'trust').map(e => [e.result, e.reason]), [['skipped', 'switch-off']]);
  fs.rmSync(path.join(w.home, 'auto-trust.off'));
  // 이어 연 대화
  for (const [role, cmd] of [['trust-e', 'agy --conversation 00000000-0000-4000-8000-000000000000'], ['trust-f', 'agy --continue']]) {
    const resumed = start(w, role, cmd);
    assert.equal(resumed.status, 0, `${cmd}: ${resumed.stdout}${resumed.stderr}`);
    assert.doesNotMatch(resumed.stdout, /폴더 신뢰/, cmd);
  }
  assert.deepEqual(readKeys(log), []);
  assert.equal(readLedger(w.home).filter(e => e.kind === 'trust' && ['trust-e', 'trust-f'].includes(e.role)).length, 0);
});

test('격리 tmux: 화면 폭(80)으로 접힌 긴 경로가 -J로 합쳐져 작업 폴더와 같으면 Enter 1회·accepted, 합쳐도 다르면 키 0개', t => {
  if (!hasTmux()) return t.skip('tmux 없음');
  const w = world(t, 'f', {deep: true});
  assert.ok(w.work.length > 90, `접힘이 일어나려면 80자를 넘어야 한다: ${w.work.length}`);
  const log = writeFakeAgy(w, {shown: '%CWD%-other'});
  // 대조군(먼저): 합쳐도 작업 폴더와 다른 경로. 화면이 남아 있어 실제로 접혔는지(-J 없이 읽으면 한 줄에 안 들어감)도 확인한다.
  assert.equal(start(w, 'trust-g', 'agy').status, 0);
  assert.deepEqual(readKeys(log), []);
  assert.deepEqual(readLedger(w.home).filter(e => e.kind === 'trust').map(e => [e.result, e.reason, e.keys, e.screenPath]),
    [['skipped', 'path-mismatch', [], `${w.work}-other`]]);
  const plain = w.tmux('capture-pane', '-p', '-t', '=kadan-trust-g:').stdout;
  assert.ok(!plain.split('\n').some(line => line.includes(`${w.work}-other`)), '-J 없이는 경로가 한 줄에 없다(접힘)');
  // 같은 경로(접힘): accepted
  writeFakeAgy(w, {shown: '%CWD%'});
  const r = start(w, 'trust-h', 'agy');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readKeys(log), ['Enter']);
  assert.deepEqual(readLedger(w.home).filter(e => e.role === 'trust-h' && e.kind === 'trust').map(e => [e.result, e.keys, e.screenPath]),
    [['accepted', ['Enter'], w.work]]);
});
