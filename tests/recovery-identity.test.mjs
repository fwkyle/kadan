// Why: 로티 탭을 바꾸거나 다시 열어도 같은 tmux 역할은 같은 역할로 이어져야 한다. 역할의 신분 기준이 탭 ID가 아니라
// tmux 쪽(세션·pane PID·작업 폴더·시작 지문)임을 기대 결과 표(A~L)로 고정한다. 탭 ID는 참고값이다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {inspectRecovery, inspectRecoveryBatch, restoreRecovery, recoveryErrorKind} from '../src/recovery.mjs';

const start = (home, role, extra = {}) => ({kind: 'start', floor: 'tmux', role, session: `kadan-${role}`,
  t: '2026-01-01T00:00:00Z', cwd: home, cmd: 'agent', panePid: '20', by: 'lead', ...extra});

function fixture() {
  const home = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'identity-'));
  const entries = [
    // main: 탭 first로 시작한 뒤 창 기록이 현재 탭을 cur로 바꿨다(first는 옛 탭).
    start(home, 'main', {rottieTerminalId: 'first'}),
    {kind: 'window', role: 'main', session: 'kadan-main', panePid: '20', rottieTerminalId: 'cur',
      restoredFrom: 'first'},
    start(home, 'other', {panePid: '40', rottieTerminalId: 'other-cur'}),
    start(home, 'stopped', {panePid: '50', rottieTerminalId: 'stopped-tab'}), {kind: 'stop', session: 'kadan-stopped'},
    start(home, 'broken', {panePid: undefined}),
    // renewed: 탭 gen1(PID 10)이던 세대를 끄고 탭 없이 새로 띄운 세대(PID 60).
    start(home, 'renewed', {panePid: '10', rottieTerminalId: 'gen1'}), {kind: 'stop', session: 'kadan-renewed'},
    start(home, 'renewed', {panePid: '60', t: '2026-01-03T00:00:00Z'}),
  ];
  const panes = {'kadan-main': {pid: '20', dead: false, created: '123'},
    'kadan-other': {pid: '40', dead: false, created: '4'}, 'kadan-renewed': {pid: '60', dead: false, created: '6'}};
  const created = [];
  let tabs = 0;
  const deps = {home, entries, read: () => entries, livePane: session => panes[session] ?? null,
    create: options => { created.push(options); panes[options.session] = {pid: '30', dead: false, created: '456'};
      return {panePid: '30'}; },
    record: entry => entries.push({...entry, t: '2026-01-02T00:00:00Z'}),
    spawn: () => ({status: 0, stdout: JSON.stringify({ok: true, result: {terminal: {id: `new-${++tabs}`}}})}),
  };
  const flags = (context, reuse = 'false') => ({context: JSON.stringify(context), command: 'agent --resume exact',
    'rottie-bin': '/fixture/rottie', 'allow-reuse': reuse});
  return {home, entries, panes, created, deps, flags};
}
const outcome = run => {
  try { return {ok: run()}; } catch (error) { return {kind: recoveryErrorKind(error), message: error.message}; }
};
const MAIN = {session: 'kadan-main', 'pane-pid': '20'};

test('A·B: 현재 창 탭만 보내면 지금과 같고, 원장에 없거나 옛 탭도 세션·pane PID가 맞으면 같은 역할이다', () => {
  const f = fixture();
  const current = inspectRecovery({terminal: 'cur'}, f.deps);
  assert.deepEqual([current.role, current.terminalId, current.panePid, current.sessionCreated],
    ['main', 'cur', '20', '123']);
  for (const terminal of ['unknown-tab', 'first']) {
    for (const extra of [{}, {cwd: f.home}]) { // 로티 묶음 조회는 cwd를 보내지 않는다
      const moved = inspectRecovery({terminal, ...MAIN, ...extra}, f.deps);
      assert.deepEqual(moved, {...current, terminalId: terminal}, `${terminal} ${JSON.stringify(extra)}`);
    }
  }
  // 옛 세대의 탭이어도 살아 있는 pane과 최신 시작 기록이 맞으면 지금 세대의 정보로 답한다(시작 지문은 지금 세대의 것).
  const renewed = inspectRecovery({terminal: 'gen1', session: 'kadan-renewed', 'pane-pid': '60'}, f.deps);
  assert.deepEqual([renewed.role, renewed.terminalId, renewed.panePid, renewed.sessionCreated],
    ['renewed', 'gen1', '60', '6']);
  assert.equal(renewed.startDigest,
    inspectRecovery({terminal: 'x', session: 'kadan-renewed', 'pane-pid': '60'}, f.deps).startDigest);
});

test('C~H: 살아 있는 pane·세션·pane PID·작업 폴더 중 하나라도 어긋나면 통과시키지 않는다', () => {
  const f = fixture();
  const ask = flags => outcome(() => inspectRecovery(flags, f.deps));
  const kinds = rows => rows.map(([flags, kind, message]) => {
    const got = ask(flags);
    assert.equal(got.kind, kind, `${JSON.stringify(flags)} → ${got.message ?? '통과'}`);
    assert.match(got.message, message);
  });
  kinds([
    // D: 같은 세션 이름인데 호출자가 든 PID가 최신 시작 기록과 다르다(교체된 세대의 PID).
    [{terminal: 'unknown-tab', session: 'kadan-main', 'pane-pid': '99'}, 'refused', /pane PID가 다릅니다/],
    [{terminal: 'gen1', session: 'kadan-renewed', 'pane-pid': '10'}, 'refused', /pane PID가 다릅니다/],
    // E: 직접 종료·시작 기록 없음·불완전.
    [{terminal: 'unknown-tab', session: 'kadan-stopped', 'pane-pid': '50'}, 'refused', /직접 종료한/],
    [{terminal: 'unknown-tab', session: 'kadan-nobody', 'pane-pid': '20'}, 'refused', /시작 기록이 없습니다/],
    [{terminal: 'unknown-tab', session: 'kadan-broken', 'pane-pid': '20'}, 'refused', /시작 기록이 불완전/],
    // F: 현재 창이 아닌 탭인데 세션이나 pane PID를 안 보냈다(둘 다 있어야 한다).
    [{terminal: 'unknown-tab'}, 'refused', /교체됐을/],
    [{terminal: 'first'}, 'refused', /교체됐을/],
    [{terminal: 'unknown-tab', session: 'kadan-main'}, 'refused', /교체됐을/],
    [{terminal: 'unknown-tab', 'pane-pid': '20'}, 'refused', /교체됐을/],
    [{terminal: 'gen1'}, 'refused', /교체됐을/],
    // G: 원장이 이 탭을 다른 세션의 현재 창으로 적어 뒀다.
    [{terminal: 'other-cur', ...MAIN}, 'refused', /역할 주소가 다릅니다/],
    // H: 작업 폴더가 다르다.
    [{terminal: 'unknown-tab', ...MAIN, cwd: '/elsewhere'}, 'refused', /작업 폴더가 다릅니다/],
  ]);
  // D: 살아 있는 pane의 PID가 시작 기록과 다르면 확정된 거절이다.
  f.panes['kadan-main'] = {pid: '77', dead: false, created: '1'};
  kinds([[{terminal: 'unknown-tab', ...MAIN}, 'refused', /관찰한 카단 pane과 시작 기록이 다릅니다/]]);
  // C: pane이 없거나(재부팅·서버 없음) 죽어 있으면 판단할 수 없다. 로티는 저장한 정보를 유지한다.
  for (const pane of [null, {pid: '20', dead: true, created: '123'}]) {
    f.panes['kadan-main'] = pane;
    kinds([[{terminal: 'unknown-tab', ...MAIN}, 'unavailable', /관찰한 카단 pane과 시작 기록이 다릅니다/],
      [{terminal: 'first', ...MAIN}, 'unavailable', /관찰한 카단 pane과 시작 기록이 다릅니다/]]);
  }
  // A는 그대로다: 현재 창 탭만 보내면 pane이 없어도(재부팅 뒤) 역할 정보를 준다.
  assert.equal(ask({terminal: 'cur'}).ok.sessionCreated, null);
  // 원장 저장소가 없는 홈은 세션·pane PID를 보내도 거절이 아니라 판단 불가다.
  const empty = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'identity-empty-'));
  const none = outcome(() => inspectRecovery({terminal: 'unknown-tab', ...MAIN}, {home: empty, livePane: () => null}));
  assert.deepEqual([none.kind, /교체됐을/.test(none.message)], ['unavailable', true]);
});

test('묶음 조회: 항목마다 같은 입력의 단건과 같고 물은 탭 ID를 그대로 돌려준다', () => {
  const f = fixture();
  const items = [{terminal: 'cur'}, {terminal: 'unknown-tab', session: 'kadan-main', panePid: '20'},
    {terminal: 'first', session: 'kadan-main', panePid: '20', cwd: f.home},
    {terminal: 'gen1', session: 'kadan-renewed', panePid: '60'}, {terminal: 'unknown-tab'},
    {terminal: 'unknown-tab', session: 'kadan-main', panePid: '99'},
    {terminal: 'other-cur', session: 'kadan-main', panePid: '20'},
    {terminal: 'unknown-tab', session: 'kadan-stopped', panePid: '50'}];
  const results = inspectRecoveryBatch({schemaVersion: 1, items}, f.deps);
  assert.deepEqual(results.map(row => row.ok ? row.result.terminalId : row.error.kind),
    ['cur', 'unknown-tab', 'first', 'gen1', 'refused', 'refused', 'refused', 'refused']);
  for (const [index, item] of items.entries()) {
    const single = outcome(() => inspectRecovery({terminal: item.terminal, session: item.session,
      'pane-pid': item.panePid, cwd: item.cwd}, f.deps));
    assert.deepEqual(results[index], single.ok ? {terminal: item.terminal, ok: true, result: single.ok}
      : {terminal: item.terminal, ok: false, error: {message: single.message, kind: single.kind}});
  }
});

test('I: 살아 있을 때 받은 복원 정보는 탭 ID가 원장에 없어도 재부팅 뒤 같은 역할을 복원한다', () => {
  const f = fixture();
  const context = inspectRecovery({terminal: 'swapped', ...MAIN}, f.deps); // 로티가 탭을 바꾼 뒤 살아 있을 때 조회
  f.panes['kadan-main'] = null; // 재부팅
  const receipt = restoreRecovery(f.flags(context), f.deps);
  assert.deepEqual([receipt.role, receipt.session, receipt.terminalId, receipt.context.terminalId],
    ['main', 'kadan-main', 'new-1', 'new-1']);
  assert.equal(f.created.length, 1);
  const [started, window] = f.entries.slice(-2);
  assert.deepEqual([started.kind, started.rottieTerminalId, started.restoredFrom, started.recoverySource],
    ['start', 'new-1', 'swapped', context.startDigest]);
  assert.deepEqual([window.kind, window.rottieTerminalId, window.restoredFrom], ['window', 'new-1', 'swapped']);
  // 다음 세대: 새 탭은 현재 창이고, 옛 탭도 새 pane PID를 들면 같은 역할이다. 옛 세대의 PID로는 거절이다.
  assert.equal(inspectRecovery({terminal: 'new-1'}, f.deps).startDigest, receipt.context.startDigest);
  assert.equal(inspectRecovery({terminal: 'swapped', session: 'kadan-main', 'pane-pid': '30'}, f.deps).startDigest,
    receipt.context.startDigest);
  assert.equal(outcome(() => inspectRecovery({terminal: 'swapped', ...MAIN}, f.deps)).kind, 'refused');
});

test('I: 살아 있는 pane은 탭 ID가 달라도 다시 잇고 세션·시작 기록을 새로 만들지 않는다', () => {
  const f = fixture();
  const starts = () => f.entries.filter(entry => entry.kind === 'start').length;
  const before = starts();
  const context = inspectRecovery({terminal: 'swapped', ...MAIN}, f.deps);
  assert.throws(() => restoreRecovery(f.flags(context), f.deps), /이미 있습니다/);
  assert.equal(restoreRecovery(f.flags(context, 'true'), f.deps).terminalId, 'new-1');
  assert.throws(() => restoreRecovery(f.flags(context, 'true'), f.deps), /이미 요청/); // 같은 요청은 한 번
  // 같은 세대를 다른 탭 ID로 물은 요청도 통과한다: 로티 탭이 하나 더 붙을 뿐 세션은 그대로다.
  const again = inspectRecovery({terminal: 'another', ...MAIN}, f.deps);
  assert.equal(again.startDigest, context.startDigest);
  assert.equal(restoreRecovery(f.flags(again, 'true'), f.deps).terminalId, 'new-2');
  assert.deepEqual([f.created.length, starts()], [0, before]);
  assert.deepEqual(f.entries.slice(-2).map(entry => [entry.kind, entry.rottieTerminalId, entry.restoredFrom]),
    [['window', 'new-1', 'swapped'], ['window', 'new-2', 'another']]);
});

test('J·G: 다른 세대로 교체됐거나 원장이 그 탭을 다른 세션의 창으로 적어 뒀으면 복원하지 않는다', () => {
  const f = fixture();
  const context = inspectRecovery({terminal: 'swapped', ...MAIN}, f.deps);
  f.panes['kadan-main'] = null;
  for (const bad of [{...context, terminalId: 'other-cur'}, {...context, startDigest: 'f'.repeat(64)},
    {...context, role: 'other'}, {...context, cwd: '/elsewhere'}]) {
    assert.throws(() => restoreRecovery(f.flags(bad), f.deps), /교체되거나/);
  }
  for (const terminalId of [undefined, '', 7]) {
    assert.throws(() => restoreRecovery(f.flags({...context, terminalId}), f.deps), /형식이 잘못/);
  }
  f.entries.push(start(f.home, 'main', {panePid: '99', t: 'later'})); // 같은 이름의 새 세대
  assert.throws(() => restoreRecovery(f.flags(context), f.deps), /교체되거나/);
  assert.equal(f.created.length, 0);
});

test('K: 추론 강도의 원본은 탭 ID가 아니라 시작 지문으로 찾는다', () => {
  const f = fixture();
  f.entries.push(start(f.home, 'claude', {cmd: 'claude --model opus --effort high', rottieTerminalId: 'k-old'}));
  f.panes['kadan-claude'] = {pid: '20', dead: false, created: '7'};
  const source = inspectRecovery({terminal: 'k-old'}, f.deps).startDigest;
  // 탭이 바뀐 뒤 복원된 세대: restoredFrom은 원장에 없는 탭 ID이고 원본은 recoverySource가 가리킨다.
  const next = start(f.home, 'claude', {cmd: 'claude --resume exact --model opus', panePid: '21',
    rottieTerminalId: 'k-new', restoredFrom: 'tab-not-in-ledger', recoverySource: source, t: 'later'});
  f.entries.push(next);
  assert.equal(inspectRecovery({terminal: 'k-new'}, f.deps).effort, 'high');
  // 지문 칸이 있는데 그 시작 기록이 없으면, 탭 ID로 찾을 수 있어도 내려가지 않고 거절한다.
  next.restoredFrom = 'k-old'; next.recoverySource = 'f'.repeat(64);
  const lost = outcome(() => inspectRecovery({terminal: 'k-new'}, f.deps));
  assert.deepEqual([lost.kind, /원본 역할 기록/.test(lost.message)], ['refused', true]);
  // 지문 칸이 없는 옛 기록은 지금처럼 탭 ID로 찾는다.
  delete next.recoverySource;
  assert.equal(inspectRecovery({terminal: 'k-new'}, f.deps).effort, 'high');
});

test('L: 같은 세대를 두 탭이 요청해도 세션은 하나만 만든다', () => {
  // 차례로: 먼저 온 요청이 새 세대를 기록하면 뒤 요청은 시작 지문이 달라 거절된다.
  const a = fixture();
  const one = inspectRecovery({terminal: 'cur'}, a.deps), two = inspectRecovery({terminal: 'swapped', ...MAIN}, a.deps);
  assert.equal(one.startDigest, two.startDigest);
  a.panes['kadan-main'] = null;
  restoreRecovery(a.flags(one), a.deps);
  assert.throws(() => restoreRecovery(a.flags(two), a.deps), /교체되거나/);
  assert.equal(a.created.length, 1);
  // 동시에: 앞 요청이 세션을 만드는 동안 온 다른 탭의 요청은 역할 잠금에 막힌다.
  const b = fixture();
  const first = inspectRecovery({terminal: 'cur'}, b.deps);
  const second = inspectRecovery({terminal: 'swapped', ...MAIN}, b.deps);
  b.panes['kadan-main'] = null;
  let during;
  const create = b.deps.create;
  restoreRecovery(b.flags(first), {...b.deps, create: options => {
    during = outcome(() => restoreRecovery(b.flags(second), b.deps));
    return create(options);
  }});
  assert.match(during.message, /역할 복원이 진행 중/);
  assert.equal(b.created.length, 1);
  // 세션을 만든 뒤 시작 기록 전에 끊기고 그 pane도 사라졌다: 다른 탭 ID의 같은 세대 요청도 다시 띄우지 않는다.
  const c = fixture();
  const lost = inspectRecovery({terminal: 'cur'}, c.deps);
  const other = inspectRecovery({terminal: 'swapped', ...MAIN}, c.deps);
  c.panes['kadan-main'] = null;
  assert.throws(() => restoreRecovery(c.flags(lost), {...c.deps, record: () => { throw new Error('끊김'); }}), /끊김/);
  assert.equal(c.entries.filter(entry => entry.kind === 'start' && entry.session === 'kadan-main').length, 1);
  c.panes['kadan-main'] = null;
  assert.throws(() => restoreRecovery(c.flags(other), c.deps), /세대의 복원을 이미 요청/);
  assert.throws(() => restoreRecovery(c.flags(lost), c.deps), /이미 요청/);
  assert.equal(c.created.length, 1);
});
