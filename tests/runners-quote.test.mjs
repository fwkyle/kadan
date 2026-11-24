// Autopilot 중 역할 세션의 `kadan runners` 쓰기: --quote "<kyle 원문>"이 있으면 통과하고 원장에 원문·쓴 역할·viaChat이 남는다.
// 격리 홈·가짜 실행기만 쓰고 운영 홈·tmux에 닿지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {autopilotGuard, guardedReason} from '../src/autopilot-guard.mjs';
import {initSettings} from '../src/runner-settings.mjs';
import {runnersCommand} from '../src/runners-command.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const example = new URL('../skills/kadan-conductor/references/agent-runners.example.json', import.meta.url).pathname;
const QUOTE = '실행 모델 설정을 fast 프리셋으로 만들어 줘';

function makeHome({on = true} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-runners-quote-'));
  fs.copyFileSync(example, path.join(home, 'agent-runners.json'));
  initSettings(home, {by: '사람', reason: '시험', record: () => {}, detect: {installed: ['codex'], readCodexModels: () => ({models: []}), notes: []}});
  if (on) appendLedger({kind: 'autopilot', phase: 'on', by: '사람', text: 'cli', viaChat: false, until: new Date(Date.now() + 3600_000).toISOString(),
    to: [], delivered: [], t: new Date().toISOString()}, home);
  return home;
}
const cli = (home, argv, role) => spawnSync(process.execPath, [CLI, ...argv], {
  env: {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none', KADAN_ROLE: role ?? ''}, encoding: 'utf8', timeout: 20_000});
const presets = home => Object.keys(JSON.parse(fs.readFileSync(path.join(home, 'runner-settings.json'), 'utf8')).presets);
const settingsEvents = home => readLedger(home).filter(e => e.kind === 'runner-settings');

// 쓰기 하위 명령 × --quote 여부. export는 --out 없을 때만 읽기다.
const WRITES = [['set', 'worker'], ['preset', 'fast'], ['preset', 'add', 'fast'], ['fallback', 'worker'], ['compare', 'on'], ['compare', 'off'],
  ['runner', 'codex'], ['model', 'codex'], ['block', 'm'], ['import', 'f.json'], ['favorite'], ['init']];

test('가드: 쓰기는 비어 있지 않은 --quote 문자열이 있을 때만 통과(값 없음 true·빈 값·공백은 거절)', () => {
  for (const args of WRITES) {
    assert.equal(guardedReason('runners', args, {quote: QUOTE}), null, args.join(' '));
    for (const quote of [undefined, true, '', '   ']) assert.match(guardedReason('runners', args, quote === undefined ? {} : {quote}), /^runners /, `${args.join(' ')} ${JSON.stringify(quote)}`);
  }
  // export --out은 원장 사건이 없어 원문을 남길 수 없으므로 --quote로도 거절한다. --out 없는 export·읽기는 그대로 통과.
  assert.equal(guardedReason('runners', ['export', 'p'], {out: 'x.json', quote: QUOTE}), 'runners export');
  for (const [args, flags] of [[['show'], {}], [['report'], {}], [['compare', 'show'], {}], [['export', 'p'], {}], [[], {}], [['show'], {quote: QUOTE}]])
    assert.equal(guardedReason('runners', args, flags), null, args.join(' '));
});

test('가드: 켜짐+역할 세션의 거절 문구에 --quote 안내, 사람·꺼짐은 그대로', () => {
  const home = makeHome();
  const call = (flags, env = {KADAN_ROLE: 'a-작업'}) => autopilotGuard({command: 'runners', args: ['preset', 'fast'], flags, home, env});
  assert.throws(() => call({}), error => error.exitCode === 2 && /runners preset/.test(error.message) && /--quote "<kyle 원문>"/.test(error.message));
  call({quote: QUOTE});
  call({}, {}); // 사람
  const off = makeHome({on: false});
  autopilotGuard({command: 'runners', args: ['preset', 'fast'], flags: {}, home: off, env: {KADAN_ROLE: 'a-작업'}}); // 꺼짐
});

test('runnersCommand: 역할이 --quote로 쓰면 설정 변경 사건에 원문·viaChat·by가 남고, 사람은 원문을 남기지 않는다', () => {
  const home = makeHome({on: false});
  const events = [];
  const record = e => events.push(e);
  runnersCommand(['preset', 'add', 'fast'], {revision: 1, reason: '시험', quote: `  ${QUOTE}  `}, {home, by: 'a-작업', record});
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].kind, events[0].by, events[0].quote, events[0].viaChat], ['runner-settings', 'a-작업', QUOTE, true]);
  runnersCommand(['preset', 'add', 'quick'], {revision: 2, reason: '시험', quote: QUOTE}, {home, by: '사람', record});
  assert.equal(events[1].quote, undefined);
  assert.equal(events[1].viaChat, undefined);
  assert.throws(() => runnersCommand(['preset', 'add', 'long'], {revision: 3, reason: '시험', quote: 'x'.repeat(4001)}, {home, by: 'a-작업', record}), /4000자를 넘습니다/);
  assert.equal(events.length, 2);
});

test('CLI: 켜진 홈의 역할 세션 — --quote 있으면 저장·원장에 원문, 없음·빈 값·값 없음은 종료 2·저장 안 됨, 읽기·사람은 그대로', () => {
  const home = makeHome();
  const base = ['runners', 'preset', 'add', 'fast', '--revision', '1', '--reason', '시험'];
  for (const extra of [[], ['--quote', ''], ['--quote', '  '], ['--quote']]) {
    const r = cli(home, [...base, ...extra], 'a-작업');
    assert.equal(r.status, 2, `${extra.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Autopilot이 켜져 있어/);
    assert.match(r.stderr, /--quote/);
  }
  assert.deepEqual(presets(home).includes('fast'), false);
  assert.equal(settingsEvents(home).length, 0); // 거절된 쓰기는 사건도 없다(시험용 init은 record를 비웠다)
  const ok = cli(home, [...base, '--quote', QUOTE], 'a-작업');
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(presets(home).includes('fast'));
  const last = settingsEvents(home).at(-1);
  assert.deepEqual([last.action, last.by, last.quote, last.viaChat, last.revision], ['preset-add', 'a-작업', QUOTE, true, 2]);
  assert.equal(cli(home, ['runners', 'show'], 'a-작업').status, 0);
  assert.equal(cli(home, ['runners', 'compare', 'show'], 'a-작업').status, 0);
  const human = cli(home, ['runners', 'preset', 'add', 'quick', '--revision', '2', '--reason', '시험']);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(settingsEvents(home).at(-1).quote, undefined);
});

test('CLI: 꺼진 홈에서는 역할 세션도 --quote 없이 쓴다', () => {
  const home = makeHome({on: false});
  const r = cli(home, ['runners', 'preset', 'add', 'fast', '--revision', '1', '--reason', '시험'], 'a-작업');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(settingsEvents(home).at(-1).quote, undefined);
});
