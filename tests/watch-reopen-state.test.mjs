import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {applyWatchRoleState} from '../src/watch-role-state.mjs';
import {collectRoles} from '../src/watch-roles.mjs';
import {captureWatchRoleState, rememberWatchRoleState, watchRoleState} from '../src/watch-role-facts.mjs';
import {encodeMailValue} from '../src/mail-view-store.mjs';
import {startDigest} from '../src/secretary-resume.mjs';
import {buildStartLedgerEntry} from '../src/cli-start-support.mjs';
import {reuseOfFor} from '../src/role-conversation.mjs';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {ledgerViewPath} from '../src/ledger-view-store.mjs';
import {createLedgerArraySweep} from '../src/watch-sweep.mjs';

// kadan reopen의 감시 발령 이어받기를 감시기의 저장 상태에서 확인한다(PR #371 재검수 R1·R2).
// 판정 근거는 sessions 표의 start_position(그 세션의 마지막 start)·generation_position(지금 세대)뿐이다. 이 두 칸은
// reopen을 모르는 옛 프로그램도 같은 규칙으로 갱신하므로, 옛 프로그램이 같은 상태를 번갈아 써도 다른 세대의 발령을 잇지 않는다.
const ID = '0197aaaa-1111-4222-8333-444455556666';
const cards = ['c1', 'c2'].map(id => ({key: `probe/${id}`, id, repo: 'probe', status: 'assigned', role: 'w'}));
let serial = 0;
const stamp = (kind, values = {}) => ({kind, t: new Date(Date.UTC(2026, 10, 10, 0, 0, ++serial)).toISOString(), ...values});
const launch = (role, pid) => stamp('start', {role, session: `kadan-${role}`, floor: 'tmux', panePid: String(pid), cmd: 'codex --model test-model',
  outputLog: `/fixture/out/kadan-${role}/gen-${serial + 1}/manifest.json`});
const send = (role, id) => stamp('send', {role, session: `kadan-${role}`, taskId: id, executionKey: `probe/${id}`});
const stop = start => stamp('stop', {role: start.role, session: start.session, conversationStart: startDigest(start)});
// reopen이 남기는 start: reopenOf는 stop 직전의 마지막 start 사건(last)의 지문이다.
const reopen = (last, pid, extra = {}) => ({...launch(last.role, pid), conversationMode: 'resume', conversationRef: ID,
  cmd: `codex --model test-model resume ${ID}`, reopenOf: startDigest(last), reopenConversation: ID, ...extra});
const done = (role, id) => stamp('done', {role, taskId: id, executionKey: `probe/${id}`, result: 'ok'});

// 메모리 SQLite 위의 감시 상태. views 표는 "감시 영역의 사건 위치"만 담고, 사건 본문은 events 배열에서 읽는다.
function fixture(events) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE views(position INTEGER PRIMARY KEY,domain TEXT)');
  const put = db.prepare("INSERT INTO views VALUES(?,'watch')");
  events.forEach((_, index) => put.run(index + 1));
  const store = {scope: 'watch', db, key: encodeMailValue, load: position => events[position - 1] ?? null, clear() {}, prepare: sql => db.prepare(sql)};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-reopen-state-'));
  return {db, store, home, events, apply: position => applyWatchRoleState(home, store, {generation: 'g1', position}, cards)};
}

// reopen을 모르는 옛 프로그램의 갱신 규칙을 시험 코드로 직접 적용한다(새 reducer를 부르지 않는다).
// start: 마지막 start 위치와 세대 위치를 덮고 그 세션의 발령을 비운다 / send: 지금 세대에 발령을 더한다 / stop: 세대만 비운다.
// 옛 프로그램에는 reopenOf 분기가 없으므로 reopen의 start도 "새 세대"로 처리한다. meta의 진도·계수도 옛 프로그램처럼 갱신한다.
function applyOldRules(f, upTo) {
  const {db} = f, key = encodeMailValue;
  const meta = JSON.parse(db.prepare('SELECT value FROM watch_role_meta WHERE id=1').get().value);
  for (let position = meta.position + 1; position <= upTo; position++) {
    const entry = f.events[position - 1];
    const row = db.prepare('SELECT * FROM watch_role_sessions WHERE key=?').get(key(entry.session));
    if (entry.kind === 'start') {
      const generation = row?.generation_position ? f.events[row.generation_position - 1] : null;
      const reused = Boolean(generation) && String(entry.panePid) === String(generation.panePid) && generation.role === entry.role;
      if (!row) meta.sessionCount++;
      db.prepare(`INSERT INTO watch_role_sessions VALUES(?,?,?,?,?,1) ON CONFLICT(key) DO UPDATE SET
        start_position=excluded.start_position,generation_position=excluded.generation_position,dispatch_ready=1`)
        .run(key(entry.session), encodeMailValue(entry.session), row?.rank ?? position, position, reused ? row.generation_position : position);
      if (!reused && !(entry.restartOf && row?.dispatch_ready))
        meta.dispatchCount -= db.prepare('DELETE FROM watch_role_dispatches WHERE session_key=?').run(key(entry.session)).changes;
      meta.stateVersion = position;
    } else if (entry.kind === 'stop') {
      if (db.prepare('UPDATE watch_role_sessions SET generation_position=NULL WHERE key=?').run(key(entry.session)).changes) meta.stateVersion = position;
    } else if (entry.kind === 'send') {
      const generation = row?.generation_position ? f.events[row.generation_position - 1] : null;
      if (entry.role === generation?.role && row?.dispatch_ready) {
        db.prepare('INSERT INTO watch_role_dispatches VALUES(?,?,?,?,?,NULL)')
          .run(key(entry.session), key(entry.executionKey), encodeMailValue(entry.executionKey), position, ++meta.nextRank);
        meta.dispatchCount++; meta.stateVersion = position;
      }
    } else throw new Error(`옛 규칙 흉내가 다루지 않는 사건: ${entry.kind}`);
  }
  meta.position = upTo;
  db.prepare('UPDATE watch_role_meta SET value=? WHERE id=1').run(JSON.stringify(meta));
}

// 살아 있는 세션 목록은 사건으로 만든다. store를 주면 저장 상태 경로, 안 주면 원장 전체를 훑는 경로다.
function observe(events, store = null) {
  const live = new Map();
  for (const entry of events) {
    if (entry.kind === 'start') live.set(entry.session, {session: entry.session, pid: entry.panePid, alive: true});
    if (entry.kind === 'stop') live.delete(entry.session);
  }
  const floor = {list: () => [...live.values()], read: () => '• KADAN:DONE c1 ok\n›\n  gpt-test · 100% left'};
  const entries = [...events];
  if (store) rememberWatchRoleState(entries, cards, captureWatchRoleState(store, cards));
  if (store) assert.ok(watchRoleState(entries, cards), '저장 상태 경로가 쓰였다');
  return [...collectRoles(floor, entries, null, cards, {hookHome: os.tmpdir()}).observations].map(([session, value]) => ({session,
    dispatches: [...value.completionDispatches].map(([key, entry]) => [key, entry.confirmedResult ?? null]).sort()}));
}
const dispatchesOf = (observed, session = 'kadan-w') => observed.find(item => item.session === session)?.dispatches.map(([key]) => key) ?? null;

const a = launch('w', 100), s1 = send('w', 'c1'), sa = stop(a);
const b = launch('w', 300), s2 = send('w', 'c2'), sb = stop(b);
const reuse = stamp('start', {role: 'w', session: 'kadan-w', floor: 'tmux', panePid: '100', reuseOf: startDigest(a)});
// reuseOf 칸이 생기기 전의 재사용 기록, 그리고 출력 기록을 붙이지 못한 세션을 띄운 기록.
const {reuseOf: _noReuseOf, ...legacyReuse} = reuse;
const {outputLog: _noOutputLog, ...bare} = launch('w', 100);
const heir = launch('heir', 400);
const transfer = stamp('handover', {phase: 'transferred', from: 'w', to: 'heir', taskIds: ['c1'], handoverId: 'h1'});

test('R1: 새 프로그램이 A를 처리하고 옛 프로그램이 B를 처리한 뒤 A를 가리키는 reopen start는 아무 발령도 잇지 않는다', () => {
  const events = [a, s1, sa, b, s2, sb, reopen(a, 200)], f = fixture(events);
  f.apply(3);             // 새 프로그램: A 시작·c1 발령·A 종료
  applyOldRules(f, 6);    // 옛 프로그램: B 시작·c2 발령·B 종료
  f.apply(7);             // 새 프로그램: A를 가리키는 reopen start
  const stored = observe(events, f.store);
  assert.deepEqual(dispatchesOf(stored), [], '다른 세대(B)의 c2를 잇지 않는다');
  assert.deepEqual(stored, observe(events), '원장 전체를 훑은 결과와 같다');
});

test('옛 프로그램이 처리한 종료 뒤에도 올바른 세대를 reopen하면 발령을 잇는다', () => {
  // (가) 옛 프로그램이 A의 stop만 처리했다.
  const one = [a, s1, sa, reopen(a, 200)], f = fixture(one);
  f.apply(2); applyOldRules(f, 3); f.apply(4);
  assert.deepEqual(dispatchesOf(observe(one, f.store)), ['probe/c1']);
  assert.deepEqual(observe(one, f.store), observe(one));
  // (나) 옛 프로그램이 B의 시작·발령·종료를 모두 처리했고, B를 가리키는 reopen이 온다.
  const two = [a, s1, sa, b, s2, sb, reopen(b, 500)], g = fixture(two);
  g.apply(3); applyOldRules(g, 6); g.apply(7);
  assert.deepEqual(dispatchesOf(observe(two, g.store)), ['probe/c2']);
  assert.deepEqual(observe(two, g.store), observe(two));
});

test('남는 한계: reopen의 start 자체를 옛 프로그램이 먼저 처리하면 이어받지 않는다(다른 세대를 잇는 일은 없다)', () => {
  const events = [a, s1, sa, reopen(a, 200)], f = fixture(events);
  f.apply(3); applyOldRules(f, 4);
  assert.deepEqual(dispatchesOf(observe(events, f.store)), [], '옛 규칙은 새 세대로 보고 발령을 비운다');
  assert.deepEqual(dispatchesOf(observe(events)), ['probe/c1'], '새 프로그램이 처음부터 다시 만들면 잇는다');
});

test('살아 있는 세션을 다시 연 start가 마지막 start일 때: reopen이 그 사건을 가리키면 잇고, 세대를 띄운 start를 가리키면 잇지 않는다', () => {
  const pointsAtLast = [a, reuse, s1, sa, reopen(reuse, 200)];
  const pointsAtLaunch = [a, reuse, s1, sa, reopen(a, 200)];
  for (const [events, expected] of [[pointsAtLast, ['probe/c1']], [pointsAtLaunch, []]]) {
    const f = fixture(events);
    f.apply(events.length);
    assert.deepEqual(dispatchesOf(observe(events, f.store)), expected);
    assert.deepEqual(observe(events, f.store), observe(events), '두 경로가 같은 사건(마지막 start)을 본다');
  }
});

test('모든 분할 지점에서 저장 상태 경로와 전체 훑기 경로의 관측이 같다', () => {
  const scenarios = {
    valid: [a, s1, sa, reopen(a, 200)],
    wrongDigest: [a, s1, sa, reopen(a, 200, {reopenOf: 'f'.repeat(64)})],
    directResume: [a, s1, sa, reopen(a, 200, {reopenOf: undefined})],
    otherGeneration: [a, s1, sa, b, s2, sb, reopen(a, 200)],
    validB: [a, s1, sa, b, s2, sb, reopen(b, 500)],
    nameReuse: [a, s1, sa, b],
    noStop: [a, s1, reopen(a, 200)],
    samePaneReuseLast: [a, reuse, s1, sa, reopen(reuse, 200)],
    samePaneReuseLaunch: [a, reuse, s1, sa, reopen(a, 200)],
    legacyReuseLast: [a, legacyReuse, s1, sa, reopen(legacyReuse, 200)],
    launchWithoutOutputLog: [bare, {...s1}, stop(bare), reopen(bare, 200)],
    handedOver: [a, s1, heir, transfer, {...sa, handoverId: 'h1'}, reopen(a, 200)],
    doneBeforeStop: [a, s1, done('w', 'c1'), sa, reopen(a, 200)],
    doneAfterStop: [a, s1, sa, done('w', 'c1'), reopen(a, 200)],
    doneAfterReopen: [a, s1, sa, reopen(a, 200), done('w', 'c1')],
    doubleStop: [a, s1, sa, {...sa, t: '2026-11-10T00:59:00.000Z'}, reopen(a, 200)],
    reopenTwice: (() => { const first = reopen(a, 200); return [a, s1, sa, first, stop(first), reopen(first, 250)]; })(),
    nonKadanSession: (() => {
      const plain = {...launch('w', 100), session: 'plain-w'}, sent = {...send('w', 'c1'), session: 'plain-w'};
      return [plain, sent, {...stop(plain), session: 'plain-w'}, {...reopen(plain, 200), session: 'plain-w'}];
    })(),
  };
  let comparisons = 0;
  for (const [name, events] of Object.entries(scenarios)) {
    // 한 사건씩, 한 번에, 그리고 가능한 모든 한 번의 끊는 지점.
    const schedules = [events.map((_, index) => index + 1), [events.length], ...events.slice(0, -1).map((_, index) => [index + 1, events.length])];
    for (const schedule of schedules) {
      const f = fixture(events);
      try {
        for (const end of schedule) {
          f.apply(end);
          assert.deepEqual(observe(events.slice(0, end), f.store), observe(events.slice(0, end)), `${name}: ${schedule} 중 ${end}`);
          comparisons++;
        }
      } finally { f.db.close(); }
    }
  }
  assert.ok(comparisons > 200, `대조 ${comparisons}회`);
  const final = name => dispatchesOf(observe(scenarios[name]), name === 'nonKadanSession' ? 'plain-w' : 'kadan-w');
  assert.deepEqual(final('valid'), ['probe/c1']);
  assert.deepEqual(final('reopenTwice'), ['probe/c1'], '껐다 열기를 되풀이해도 이어진다');
  for (const name of ['wrongDigest', 'directResume', 'otherGeneration', 'noStop', 'handedOver', 'samePaneReuseLaunch',
    'legacyReuseLast', 'launchWithoutOutputLog']) assert.deepEqual(final(name), [], name);
  assert.deepEqual(final('samePaneReuseLast'), ['probe/c1']);
  assert.equal(final('nonKadanSession'), null, 'kadan- 세션이 아니면 관측 대상이 아니다');
});

// ---- 3차 검수 N1: 본문이 같은 start는 지문도 같다 ----
// 실제 start 생성 함수(buildStartLedgerEntry)와 실제 reuseOf 계산(reuseOfFor)으로 기록을 만든다.
// 살아 있는 세션을 다시 연 start에는 명령·출력 기록 경로가 없다. 두 세대의 그런 기록에 PID·기록 시각까지 같게 넣어도,
// 각자 자기 세대를 띄운 start의 지문(reuseOf)을 품으므로 본문이 달라야 한다.
const build = ({pid, cmd, outputLog, t, extra = {}}) => ({...buildStartLedgerEntry({floorName: 'tmux', role: 'w', session: 'kadan-w',
  evidence: {panePid: pid, ...(outputLog ? {outputLog} : {})}, window: 'hidden', cwd: '/fixture-work', cmd, env: {KADAN_ROLE: 'fixture'}}), ...extra, t});
// kadan start가 살아 있는 세션에 남기는 기록: 그때까지의 원장으로 reuseOf를 계산해 붙인다(start.mjs와 같은 순서).
const buildReuse = (before, {pid, t}) => {
  const reuseOf = reuseOfFor(before, 'kadan-w', pid);
  return build({pid, t, extra: reuseOf ? {reuseOf} : {}});
};
const CMD = 'codex --model test-model';
const both = events => {
  const f = fixture(events);
  try { f.apply(events.length); return {stored: dispatchesOf(observe(events, f.store)), full: dispatchesOf(observe(events))}; }
  finally { f.db.close(); }
};
const sendOf = (id, t) => ({kind: 'send', role: 'w', session: 'kadan-w', taskId: id, executionKey: `probe/${id}`, t});
const stopAt = t => ({kind: 'stop', role: 'w', session: 'kadan-w', t});
const reopenOf = (last, t) => build({pid: '300', cmd: `${CMD} resume ${ID}`, outputLog: '/fixture/out/C/manifest.json', t,
  extra: {reopenOf: startDigest(last), conversationMode: 'resume'}});

test('N1: 두 세대의 재사용 start가 PID·기록 시각까지 같아도, 옛 세대를 가리키는 reopen은 다른 세대의 발령을 잇지 않는다', () => {
  const SAME_T = '2026-11-10T00:01:00.000Z';
  const a1 = build({pid: '100', cmd: CMD, outputLog: '/fixture/out/A/manifest.json', t: '2026-11-10T00:00:00.000Z'});
  const ra = buildReuse([a1], {pid: '100', t: SAME_T});
  const first = [a1, ra, sendOf('c1', '2026-11-10T00:02:00.000Z'), stopAt('2026-11-10T00:03:00.000Z')];
  const b1 = build({pid: '100', cmd: CMD, outputLog: '/fixture/out/B/manifest.json', t: '2026-11-10T00:00:30.000Z'});
  const rb = buildReuse([...first, b1], {pid: '100', t: SAME_T});
  const second = [b1, rb, sendOf('c2', '2026-11-10T00:04:00.000Z'), stopAt('2026-11-10T00:05:00.000Z')];
  // 재현 조건이 맞는지: reuseOf를 빼면 두 재사용 기록의 본문은 글자 그대로 같다(지난 판에서 지문이 같아지던 이유).
  const strip = ({reuseOf, ...rest}) => rest;
  assert.deepEqual(strip(ra), strip(rb));
  assert.equal(ra.reuseOf, startDigest(a1)); assert.equal(rb.reuseOf, startDigest(b1));
  assert.notEqual(startDigest(ra), startDigest(rb), '세대가 다르면 재사용 기록의 본문(지문)이 다르다');
  // A의 재사용 start를 가리키는 reopen: 마지막 start는 B의 재사용 기록이다. 두 경로 모두 발령 0건이어야 한다.
  const stale = both([...first, ...second, reopenOf(ra, '2026-11-10T00:10:00.000Z')]);
  assert.deepEqual(stale.stored, [], '저장 상태 경로: B의 c2를 잇지 않는다');
  assert.deepEqual(stale.full, [], '전체 훑기 경로: B의 c2를 잇지 않는다');
  // 정상 방향: 재사용 start가 있는 세대를 올바르게 가리키면 그 세대의 발령만 잇는다.
  const right = both([...first, ...second, reopenOf(rb, '2026-11-10T00:10:00.000Z')]);
  assert.deepEqual(right.stored, ['probe/c2']); assert.deepEqual(right.full, ['probe/c2']);
  const onlyA = both([...first, reopenOf(ra, '2026-11-10T00:10:00.000Z')]);
  assert.deepEqual(onlyA.stored, ['probe/c1']); assert.deepEqual(onlyA.full, ['probe/c1']);
});

test('N1: reuseOf 칸이 없는 옛 재사용 start가 마지막 start이면, 지문이 맞아도 잇지 않는다(본문이 같은 다른 세대와 구분할 수 없다)', () => {
  const SAME_T = '2026-11-10T00:01:00.000Z';
  const a1 = build({pid: '100', cmd: CMD, outputLog: '/fixture/out/A/manifest.json', t: '2026-11-10T00:00:00.000Z'});
  const b1 = build({pid: '100', cmd: CMD, outputLog: '/fixture/out/B/manifest.json', t: '2026-11-10T00:00:30.000Z'});
  // 옛 프로그램이 남긴 재사용 기록 둘: reuseOf가 없어 본문이 같다.
  const ra = build({pid: '100', t: SAME_T}), rb = build({pid: '100', t: SAME_T});
  assert.equal(startDigest(ra), startDigest(rb));
  const events = [a1, ra, sendOf('c1', '2026-11-10T00:02:00.000Z'), stopAt('2026-11-10T00:03:00.000Z'),
    b1, rb, sendOf('c2', '2026-11-10T00:04:00.000Z'), stopAt('2026-11-10T00:05:00.000Z'), reopenOf(ra, '2026-11-10T00:10:00.000Z')];
  assert.deepEqual(both(events), {stored: [], full: []}, '지난 판에서는 여기서 c2를 이었다');
  // 한 세대뿐이어도 같은 규칙이다: 구분하는 값이 없는 기록은 근거로 쓰지 않는다.
  assert.deepEqual(both([a1, ra, sendOf('c1', '2026-11-10T00:02:00.000Z'), stopAt('2026-11-10T00:03:00.000Z'), reopenOf(ra, '2026-11-10T00:10:00.000Z')]),
    {stored: [], full: []});
});

test('N1: 출력 기록 경로가 없는 채로 띄운 세션은 본문이 같은 다른 세대와 구분할 수 없어 잇지 않고, 그 세대의 재사용 기록에는 reuseOf를 적지 않는다', () => {
  const SAME_T = '2026-11-10T00:00:00.000Z';
  // 출력 기록을 붙이지 못한 두 세대: 역할·PID·명령·작업 폴더·기록 시각이 같으면 본문이 같다.
  const a1 = build({pid: '100', cmd: CMD, t: SAME_T}), b1 = build({pid: '100', cmd: CMD, t: SAME_T});
  assert.equal(startDigest(a1), startDigest(b1));
  const events = [a1, sendOf('c1', '2026-11-10T00:02:00.000Z'), stopAt('2026-11-10T00:03:00.000Z'),
    b1, sendOf('c2', '2026-11-10T00:04:00.000Z'), stopAt('2026-11-10T00:05:00.000Z'), reopenOf(a1, '2026-11-10T00:10:00.000Z')];
  assert.deepEqual(both(events), {stored: [], full: []});
  assert.equal(reuseOfFor([a1], 'kadan-w', '100'), null, '띄운 start에 구분하는 값이 없으면 reuseOf도 적지 않는다');
  // reuseOf를 적지 않는 다른 경우: 띄운 start를 못 찾음, PID가 다름, 세션이 이미 꺼짐.
  const launched = build({pid: '100', cmd: CMD, outputLog: '/fixture/out/A/manifest.json', t: SAME_T});
  assert.equal(reuseOfFor([launched], 'kadan-w', '100'), startDigest(launched));
  assert.equal(reuseOfFor([launched], 'kadan-w', '999'), null);
  assert.equal(reuseOfFor([launched], 'kadan-other', '100'), null);
  assert.equal(reuseOfFor([launched, stopAt('2026-11-10T00:03:00.000Z')], 'kadan-w', '100'), null);
  assert.equal(reuseOfFor([], 'kadan-w', '100'), null);
  // 재사용 기록 뒤에 또 다시 연 기록: 같은 세대를 띄운 start를 가리킨다.
  const again = buildReuse([launched], {pid: '100', t: '2026-11-10T00:01:00.000Z'});
  assert.equal(reuseOfFor([launched, again], 'kadan-w', '100'), startDigest(launched));
});

// ---- 실제 SQLite 감시 조회 상태(createWatchMailReader) ----
const role = 'w', session = 'kadan-w';
function realSetup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-reopen-real-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const list = cards.map(card => ({...card, at: '2026-11-10T00:00:00.000Z'}));
  // 정기 대조의 열린 카드 수 불변식이 실제 저장소와 맞도록 카드 사건도 둔다.
  list.forEach(card => appendStream(home, `cards/${card.key}/events.jsonl`,
    {key: card.key, id: card.id, repo: 'probe', revision: 1, at: card.at, role: card.role, status: card.status, workType: 'execution'}));
  const reader = createWatchMailReader(home, null, {readCards: () => list});
  const floor = {list: () => [{session, pid: '200', alive: true}], read: () => '›'};
  const read = () => reader.project(reader.readEntries(), list);
  const stored = () => {
    const entries = read();
    assert.ok(watchRoleState(entries, list), '저장 상태 경로가 쓰였다');
    return [...collectRoles(floor, entries, null, list, {hookHome: home}).observations.get(session).completionDispatches.keys()];
  };
  const tamper = sql => { const db = new DatabaseSync(ledgerViewPath(home)); try { return db.exec(sql); } finally { db.close(); } };
  const query = sql => { const db = new DatabaseSync(ledgerViewPath(home)); try { return db.prepare(sql).all(); } finally { db.close(); } };
  // A 시작 → c1 발령 → A 종료까지 감시기가 읽은 상태를 만든다. 돌려주는 것은 원장에 실제로 적힌 A의 start다.
  appendLedger({kind: 'start', role, session, floor: 'tmux', panePid: '100', cmd: 'codex --model test-model',
    outputLog: path.join(home, 'out', session, 'gen-a', 'manifest.json')}, home);
  appendLedger({kind: 'send', role, session, taskId: 'c1', executionKey: 'probe/c1'}, home);
  const started = readLedger(home).findLast(entry => entry.kind === 'start');
  appendLedger({kind: 'stop', role, session, conversationStart: startDigest(started)}, home);
  assert.deepEqual(stored(), ['probe/c1']);
  const addReopen = () => appendLedger({kind: 'start', role, session, floor: 'tmux', panePid: '200', conversationMode: 'resume',
    cmd: `codex --model test-model resume ${ID}`, reopenOf: startDigest(started), reopenConversation: ID}, home);
  return {home, reader, stored, tamper, query, addReopen, sweep: () => createLedgerArraySweep({access: reader.sweepAccess, chunkRows: 5})};
}

test('R2: 예전 판이 남긴 보조 표가 잘못된 모양으로 있어도 감시 수집은 그 표를 보지 않고 계속된다', async () => {
  const s = realSetup();
  s.tamper('CREATE TABLE watch_role_stopped(key TEXT PRIMARY KEY)');
  s.addReopen();
  assert.deepEqual(s.stored(), ['probe/c1'], 'readEntries가 던지지 않고, 올바른 reopen은 발령을 잇는다');
  assert.equal((await s.sweep().full()).status, 'match', '정기 대조와 어긋나지 않는다');
});

test('R2: 판정이 읽는 칸(마지막 start 위치)이 깨져 있으면 던지지 않고 이어받지 않으며, 정기 대조가 어긋남을 잡아 다시 만들면 복구된다', async () => {
  const sendPosition = s => s.query('SELECT position FROM watch_role_dispatches')[0].position;
  for (const damage of ['없는 위치', 'start가 아닌 사건', '빈 값']) {
    const s = realSetup();
    const value = damage === '없는 위치' ? 999999 : damage === 'start가 아닌 사건' ? sendPosition(s) : 'NULL';
    s.tamper(`UPDATE watch_role_sessions SET start_position=${value}`);
    s.addReopen();
    assert.deepEqual(s.stored(), [], `${damage}: 던지지 않고, 근거를 읽지 못하면 이어받지 않는다`);
    assert.deepEqual(s.stored(), [], `${damage}: 다음 수집도 계속된다`);
    // 기존의 "상태가 어긋나면 다시 만든다" 경로: 정식 reducer를 처음부터 재생한 지문과 다르면 교체한다.
    const found = await s.sweep().full();
    assert.equal(found.status, 'diff', damage);
    assert.ok(found.diffs.some(diff => diff.key === 'role-state'), damage);
    s.reader.sweepAccess.roleState.reset();
    assert.deepEqual(s.stored(), ['probe/c1'], `${damage}: 다시 만들면 원장대로 이어받는다`);
    assert.equal((await s.sweep().full()).status, 'match', damage);
  }
});

test('보조 표를 만들지 않는다: 감시 상태의 표는 예전과 같은 세 개뿐이다', () => {
  const s = realSetup();
  s.addReopen();
  s.stored();
  const tables = s.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'watch_role_%' ORDER BY name").map(row => row.name);
  assert.deepEqual(tables, ['watch_role_dispatches', 'watch_role_meta', 'watch_role_sessions']);
});
