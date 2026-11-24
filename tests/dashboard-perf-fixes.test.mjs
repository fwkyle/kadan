import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {appendLedger, saveMailBody} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker, storageSnapshot, storagePath} from '../src/storage.mjs';
import {DatabaseSync} from 'node:sqlite';
import {floor} from '../src/floor.mjs';
import {wallCache} from '../src/wall-snapshot-cache.mjs';
import {createWallServer, withWaitSnapshots} from '../src/wall.mjs';
import {createWallSnapshotLoader, createDashboardReaders, loadWallSnapshot} from '../src/commands/tree-wall.mjs';
import {createDashboardSummaryReader} from '../src/dashboard-summary-reader.mjs';
import {createDashboardMailReader} from '../src/dashboard-mail-reader.mjs';
import {createDashboardStoreReader} from '../src/dashboard-store-reader.mjs';
import {watchOverview, watchOverviewMemoInfo, createCachedWatchProcesses, attachWatchOverview}
  from '../src/watch-overview.mjs';
import {createHash} from 'node:crypto';

// 시험이 실제 카단 세션(tmux)을 보지 않게 존재하지 않는 소켓을 쓴다.
process.env.KADAN_SOCKET = process.env.KADAN_LITE_SOCKET = 'kadan-test-none-' + process.pid;
// 이 시험이 만든 임시 폴더만 프로세스가 끝날 때 지운다(isolated-home과 같은 방식).
const made = [];
process.once('exit', () => {for (const dir of made) fs.rmSync(dir, {recursive: true, force: true});});
const tempDir = prefix => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));made.push(dir);
  return dir;
};
const sqliteHome = () => {
  const home = tempDir('kadan-perf-fixes-');
  createDatabase(home);writeStorageMarker(home, 'sqlite');process.env.KADAN_HOME = home;wallCache.clear();
  return home;
};
const start = async server => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
};
const closeAfter = (t, server) => t.after(() => new Promise(resolve => server.close(resolve)));

// 결함 감사 전의 withWaitSnapshots(역할마다 목록을 걸러 정렬). 새 구현이 같은 결과를 내는지 비교하는 기준이다.
function legacyWithWaitSnapshots(tree, home) {
  const outDir = path.join(home, 'out');
  let names;
  try { names = fs.readdirSync(outDir); } catch { return tree; }
  return tree.map(board => ({...board, roles: board.roles.map(role => {
    const prefix = `${role.session}.wait-`;
    const fileName = names.filter(name => name.startsWith(prefix) && name.endsWith('.txt')).sort().at(-1);
    if (!fileName) return role;
    try {
      const lines = fs.readFileSync(path.join(outDir, fileName), 'utf8').split('\n');
      while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop();
      return {...role, waitSnapshot: {fileName, tail: lines.slice(-3).join('\n')}};
    } catch { return role; }
  })}));
}

test('대기 출력 인덱싱은 옛 방식과 같은 파일을 고르고 out 폴더를 한 번만 읽는다', t => {
  const home = tempDir('kadan-wait-index-');
  const out = path.join(home, 'out');fs.mkdirSync(out);
  const write = (name, text) => fs.writeFileSync(path.join(out, name), text);
  write('kadan-a.wait-1.txt', 'one\n');write('kadan-a.wait-2.txt', 'a\nb\nc\nd\n\n\n');
  // 세션 이름이 다른 세션의 접두어이고 .wait-가 이름에 여러 번 나오는 경우
  write('kadan-a.wait-b.wait-1.txt', 'nested-1\n');write('kadan-a.wait-b.wait-3.txt', 'nested-3\n');
  write('kadan-a.wait-x.log', 'not txt\n');write('kadan-other.wait-1.txt', 'other\n');
  write('undefined.wait-1.txt', 'undefined session\n');
  // 사전순 마지막 파일을 읽을 수 없으면 앞 파일로 내려가지 않는다(옛 동작).
  write('kadan-c.wait-1.txt', 'older\n');fs.mkdirSync(path.join(out, 'kadan-c.wait-9.txt'));
  const role = session => ({role: String(session), session, cards: []});
  const tree = [{board: 'p', roles: [role('kadan-a'), role('kadan-a.wait-b'), role('kadan-none'),
    role('kadan-c'), {role: 'no-session', cards: []}]},
  {board: 'q', roles: [role('kadan-other')]}];
  const expected = legacyWithWaitSnapshots(tree, home);
  assert.ok(expected[0].roles[0].waitSnapshot && expected[0].roles[1].waitSnapshot, '기준 구현이 두 역할을 찾는다');
  assert.equal(expected[0].roles[3].waitSnapshot, undefined, '기준 구현도 읽기 실패한 최신 파일에서 내려가지 않는다');
  const reads = [];
  const original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (target, ...rest) => {reads.push(String(target));return original(target, ...rest);});
  assert.deepEqual(withWaitSnapshots(tree, home), expected);
  assert.deepEqual(reads.filter(target => target === out), [out], '역할 수와 상관없이 out 폴더는 한 번 읽는다');
  assert.equal(withWaitSnapshots(tree, path.join(home, 'missing')), tree, 'out 폴더가 없으면 tree 그대로');
});

test('대시보드 서버 수집은 대기 출력 꼬리를 건너뛰고 옛 화면과 기본 호출만 붙인다', async t => {
  const home = sqliteHome();
  const list = floor.list;floor.list = () => [{session: 'kadan-worker', pid: 111, alive: true}];
  t.after(() => {floor.list = list;});
  appendLedger({kind: 'start', role: 'worker', t: new Date().toISOString(), panePid: 111, pid: 111, by: 'boss'});
  fs.mkdirSync(path.join(home, 'out'));
  fs.writeFileSync(path.join(home, 'out/kadan-worker.wait-1.txt'), 'old\nnew tail\n');
  const roleOf = snapshot => snapshot.center.roles.find(r => r.role === 'worker');
  const original = fs.readdirSync;
  const outReads = [];
  t.mock.method(fs, 'readdirSync', (target, ...rest) => {
    if (String(target).endsWith(path.join(home, 'out'))) outReads.push(String(target));
    return original(target, ...rest);
  });
  const spa = loadWallSnapshot(null, {summaryBodies: true});
  assert.equal(spa.waitSnapshotsApplied, false);
  assert.equal(roleOf(spa).waitSnapshot, undefined);
  assert.deepEqual(outReads, [], '요약 본문 모드(대시보드 서버)는 out 폴더를 읽지 않는다');
  assert.equal(roleOf(loadWallSnapshot(null, {summaryBodies: true, includeWaitSnapshots: true})).waitSnapshot.tail,
    'old\nnew tail');
  assert.equal(roleOf(loadWallSnapshot()).waitSnapshot.tail, 'old\nnew tail', '기본 호출은 옛 동작 그대로');
  t.mock.restoreAll();
  const server = createWallServer(createWallSnapshotLoader(null, {summaryBodies: true}),
    {home, cacheSec: 0, gui: true, warmAfterMs: 60_000});
  closeAfter(t, server);
  const base = await start(server);
  const legacy = await (await fetch(base + '/?legacy=1')).text();
  assert.match(legacy, /kadan-worker\.wait-1\.txt/, '옛 화면은 그릴 때 대기 출력 꼬리를 붙인다');
  const status = await fetch(base + '/api/dashboard/status');
  assert.equal(status.status, 200);
  assert.doesNotMatch(await status.text(), /waitSnapshot/, '새 화면 응답에는 대기 출력 꼬리가 없다');
});

test('현황과 목록 수집이 번갈아 와도 서로의 공통 수집을 밀어내지 않는다', async t => {
  const home = tempDir('kadan-two-slots-');
  const snapshot = () => ({center: null, centerError: null, collectedAt: new Date().toISOString(), entries: [],
    ledgerLines: 0, error: null, resources: null, tree: []});
  const loads = {status: 0, list: 0};
  let clock = 1_000_000;
  const server = createWallServer(() => {loads.status++;return snapshot();},
    {home, cacheSec: 10, now: () => clock, warmAfterMs: 600_000,
      loadListSnapshot: () => {loads.list++;return snapshot();}});
  closeAfter(t, server);
  const base = await start(server);
  // 주소마다 query가 달라 응답 캐시에는 안 걸리고 공통 수집(sharedSnapshot)만 시험한다.
  const get = async route => (await fetch(base + '/api/dashboard/' + route)).status;
  await get('status?n=1');await get('workspace?n=1');await get('status?n=2');await get('workspace?n=2');
  await get('detail?n=1');await get('status?n=3');
  assert.deepEqual(loads, {status: 1, list: 1}, '번갈아 요청해도 로더마다 한 번만 수집한다');
  await get('status?n=4&fresh=1');
  assert.deepEqual(loads, {status: 2, list: 1}, 'fresh는 두 칸 모두 비운다');
  await get('workspace?n=5');await get('status?n=6');
  assert.deepEqual(loads, {status: 2, list: 2}, 'fresh 직후 현황 수집은 재사용하고 목록은 다시 수집한다');
  clock += 11_000;
  await get('status?n=7');await get('workspace?n=7');
  assert.deepEqual(loads, {status: 3, list: 3}, 'cacheSec가 지나면 각자 다시 수집한다');
});

// ---- 감시 개요 재사용 ----
const text = JSON.stringify({worker: 'supervisor', supervisor: 'super', super: '@user'});
const hashOf = value => createHash('sha256').update(value).digest('hex');
const now = Date.parse('2026-09-07T02:00:00Z');
const makeCenter = (roles = ['worker', 'super']) => ({runtimeKnown: true,
  roles: roles.map(role => ({role, life: {state: 'alive', pidState: 'match'}})),
  cards: [{id: 'c', key: 'r/c', role: 'worker', status: 'assigned', workType: 'execution',
    displayState: 'running', runs: []}],
  boards: [{name: 'p', cards: [{id: 'c', key: 'r/c', role: 'worker', status: 'assigned', workType: 'execution',
    displayState: 'running', runs: []}], runs: []}]});
const makeEntries = () => [
  {kind: 'hierarchy-loaded', pid: 42, path: '/test/hierarchy.json', hash: hashOf(text), t: '2026-09-07T01:00:00Z'},
  {kind: 'send', role: 'worker', taskId: 'c', t: '2026-09-07T01:01:00Z'},
  {kind: 'watch-cycle', pid: 42, t: new Date(now - 60_000).toISOString(), hierarchy: '/test/hierarchy.json',
    judge: true, ok: true},
  {kind: 'watch-ai-request', role: 'worker', source: 'stall', t: new Date(now - 24 * 3600_000 + 10_000).toISOString()}];
const makeInput = (over = {}) => ({center: makeCenter(), entries: makeEntries(), works: [],
  processes: [{pid: 42, startedAt: '2026-09-07T00:00:00Z'}], readFile: () => text, now, ...over});
// 입력 참조를 모두 새로 만들어 재사용이 불가능한 같은 내용의 기준 결과를 만든다.
const cold = input => watchOverview({...input, center: structuredClone(input.center),
  entries: structuredClone(input.entries), works: structuredClone(input.works)});
const delta = (before, after) => ({scopes: after.scopes - before.scopes, boards: after.boards - before.boards});

test('감시 개요는 같은 입력이면 비싼 범위 계산을 재사용하고 시각에 달린 값은 매번 새로 계산한다', () => {
  const input = makeInput();
  const before = watchOverviewMemoInfo();
  const first = watchOverview(input);
  assert.deepEqual(delta(before, watchOverviewMemoInfo()), {scopes: 1, boards: 1});
  assert.equal(first.boards[0].state, 'configured');
  assert.equal(first.boards[0].aiActivity[0].requests, 1);
  const later = watchOverview({...input, now: now + 30_000});
  assert.deepEqual(delta(before, watchOverviewMemoInfo()), {scopes: 1, boards: 1}, '30초 뒤 같은 입력은 재사용');
  assert.equal(later.cycle.ageMs, first.cycle.ageMs + 30_000, '주기 경과는 시각 따라 새로 계산');
  assert.equal(later.boards[0].aiActivity[0].requests, 0, '24시간 창 밖으로 나간 호출은 새로 센다');
  // 프로필 경로가 바뀌어도 재사용한 파생 위에 새 값이 실린다(아래 cold 호출은 한 칸 기억을 바꾸므로 먼저 본다).
  const mark = watchOverviewMemoInfo();
  const profiled = watchOverview({...input, profilePath: '/home/watch-profile.json'});
  assert.equal(profiled.profilePath, '/home/watch-profile.json');
  assert.deepEqual(delta(mark, watchOverviewMemoInfo()), {scopes: 0, boards: 0});
  assert.deepEqual(later, cold({...input, now: now + 30_000}), '재사용한 결과는 처음부터 계산한 결과와 같다');
  assert.deepEqual(first, cold(input));
});

test('감시 개요 재사용은 원장·업무·관계 파일·생존 상태·프로세스·시간 만료에서 새 값을 만든다', () => {
  const input = makeInput();
  watchOverview(input);
  const mark = () => watchOverviewMemoInfo();
  let before = mark();
  const extra = {kind: 'send', role: 'worker', taskId: 'c', t: '2026-09-07T01:30:00Z'};
  const grown = watchOverview({...input, entries: [...input.entries, extra]});
  assert.deepEqual(delta(before, mark()), {scopes: 1, boards: 1}, '원장 배열이 바뀌면 둘 다 다시');
  assert.deepEqual(grown.boards[0].roles.map(r => r.role), ['super', 'supervisor', 'worker']);
  const entries = makeEntries();
  watchOverview({...input, entries});
  before = mark();
  const edited = watchOverview({...input, entries, readFile: () => text + ' '});
  assert.equal(edited.configuration.state, 'changed');
  assert.equal(edited.boards[0].state, 'unknown', '관계 파일 지문이 달라지면 이전 범위를 쓰지 않는다');
  assert.equal(delta(before, mark()).boards, 1);
  watchOverview({...input, entries});
  before = mark();
  const changedLive = watchOverview({...input, entries, center: {...input.center, roles: [
    {role: 'worker', life: {state: 'alive', pidState: 'match'}}, {role: 'super', life: {state: 'dead'}}]}});
  assert.deepEqual(delta(before, mark()), {scopes: 0, boards: 1}, '생존 역할이 바뀌면 판 목록만 다시');
  const recipients = result => result.boards[0].roles.map(r => r.recipient);
  assert.notDeepEqual(recipients(changedLive), recipients(cold(input)), '살아 있는 역할이 달라 수신자도 달라진다');
  watchOverview({...input, entries});
  before = mark();
  const gone = watchOverview({...input, entries, processes: []});
  assert.equal(gone.boards[0].state, 'absent', '감시 프로세스가 사라지면 판 상태가 바뀐다');
  assert.equal(delta(before, mark()).boards, 1);
  watchOverview({...input, entries});
  before = mark();
  const works = [{key: 'r/w', board: 'p', executions: [{key: 'r/c'}]}];
  watchOverview({...input, entries, works});
  assert.equal(delta(before, mark()).scopes, 1, '업무 목록이 바뀌면 범위를 다시 만든다');
  watchOverview({...input, entries, works});
  before = mark();
  watchOverview({...input, entries, works, now: now + 61_000});
  assert.deepEqual(delta(before, mark()), {scopes: 1, boards: 1}, '60초가 지나면 같은 입력도 다시 만든다');
});

test('관계 파일을 못 읽으면 이전 범위 기억을 놓고, 판 연결은 이름으로 한 번에 찾는다', () => {
  const input = makeInput();
  watchOverview(input);
  const before = watchOverviewMemoInfo();
  watchOverview({...input, readFile: () => {throw new Error('read failed');}});
  watchOverview(input);
  assert.equal(delta(before, watchOverviewMemoInfo()).scopes, 1, '읽기 실패 뒤에는 이전 범위를 붙들지 않아 다시 만든다');
  const center = {...makeCenter(), boards: [
    {name: 'p', cards: makeCenter().boards[0].cards, runs: []}, {name: 'p', cards: [], runs: []},
    {name: 'q', cards: [], runs: []}]};
  const attached = attachWatchOverview(center, makeEntries(), {works: [], readFile: () => text, now,
    readProcesses: () => [{pid: 42, startedAt: '2026-09-07T00:00:00Z'}]});
  const names = attached.monitoring.boards.map(b => b.name);
  assert.deepEqual(names, ['p', 'p', 'q']);
  for (const board of attached.boards) {
    assert.equal(board.monitoring, attached.monitoring.boards.find(x => x.name === board.name), board.name);
  }
});

test('감시 프로세스 목록은 15초 재사용하고 실패는 저장하지 않으며 이름이 바뀌면 다시 읽는다', () => {
  let clock = 0, calls = 0, failing = false;
  const read = (spawn, name) => {
    calls++;
    if (failing) throw new Error('ps 실패');
    return [{pid: calls, name}];
  };
  const cached = createCachedWatchProcesses({read, now: () => clock, ttlMs: 15_000});
  assert.deepEqual(cached('kadan-watch'), [{pid: 1, name: 'kadan-watch'}]);
  clock = 14_999;assert.equal(cached('kadan-watch')[0].pid, 1);
  assert.equal(calls, 1, 'TTL 안에서는 ps를 다시 부르지 않는다');
  assert.equal(cached('other-watch')[0].pid, 2, '이름이 바뀌면 다시 읽는다');
  clock = 30_000;failing = true;
  assert.throws(() => cached('other-watch'), /ps 실패/, '실패는 그대로 던져 모름으로 보인다');
  failing = false;
  assert.equal(cached('other-watch')[0].pid, 4, '실패한 값은 저장하지 않아 바로 다시 읽는다');
  clock = 25_000;
  assert.equal(cached('other-watch')[0].pid, 5, '시계가 뒤로 가면 재사용하지 않는다');
});

test('대시보드 수집은 데이터와 생존이 같으면 감시 개요의 판 목록을 다시 만들지 않는다', t => {
  sqliteHome();
  const list = floor.list;floor.list = () => [{session: 'kadan-worker', pid: 111, alive: true}];
  t.after(() => {floor.list = list;});
  appendLedger({kind: 'start', role: 'worker', t: new Date().toISOString(), panePid: 111, pid: 111, by: 'boss'});
  const loader = createWallSnapshotLoader(null, {summaryBodies: true});
  const build = () => loader.build(storageSnapshot(process.env.KADAN_HOME, loader.read));
  const before = watchOverviewMemoInfo();
  const first = build();
  assert.ok(first.center?.monitoring, '감시 개요가 붙는다');
  const afterFirst = watchOverviewMemoInfo();
  assert.equal(delta(before, afterFirst).boards, 1);
  const second = build();
  assert.deepEqual(delta(afterFirst, watchOverviewMemoInfo()), {scopes: 0, boards: 0});
  assert.deepEqual(second.center.monitoring.boards, first.center.monitoring.boards);
});

// ---- 카드·업무 읽기 공유 ----
test('요약·우편 읽기는 카드·업무 읽기를 한 벌만 쓰고 따로 읽을 때와 결과가 같다', () => {
  const f = dashboardFixture({count: 3});made.push(f.home);
  wallCache.clear();
  saveMailBody('body-a', '검색 전용 원문', f.home);
  for (let i = 0; i < 6; i++) {
    appendLedger({kind: 'send', mailId: `mail-${i}`, t: '2026-01-01T00:00:00Z', role: `fixture-${i % 3}`, by: 'lead',
      taskId: i % 2 ? 'card-1' : 'card-2', executionKey: i % 2 ? 'demo/card-1' : 'demo/card-2',
      workKey: 'demo/dashboard', preview: `미리보기 ${i}`, digest: i % 2 ? 'absent' : 'body-a'}, f.home);
  }
  const fixedNow = () => Date.parse('2026-02-03T04:05:06Z');
  const sessions = () => [{session: 'kadan-비서', pid: 12}];
  const readers = createDashboardReaders(f.home, {listSessions: sessions, now: fixedNow});
  const own = createDashboardSummaryReader(f.home, {listSessions: sessions, now: fixedNow});
  const ownMail = createDashboardMailReader(f.home, {now: fixedNow});
  const mailUrl = new URL('http://local/api/dashboard/mail');
  assert.deepEqual(readers.loadSummary(), own(), '요약: 따로 읽은 값과 같다');
  assert.deepEqual(readers.loadMail(mailUrl), ownMail(mailUrl), '우편: 따로 읽은 값과 같다');
  assert.ok(readers.loadMail(mailUrl).items.some(item => item.card?.title), '공유한 카드 읽기로 카드 제목이 붙는다');
  // 공유 읽기는 데이터 버전이 같으면 같은 배열·같은 객체를 돌려 준다(재사용·메모리 한 벌).
  const cards = readers.readCards(), works = readers.readWorks();
  assert.equal(cards.length, 3);
  readers.loadSummary();readers.loadMail(mailUrl);
  assert.equal(readers.readCards(), cards, '요약·우편을 읽어도 카드 읽기는 한 벌 그대로');
  assert.equal(readers.readWorks(), works);
  // 새 카드가 생기면 다음 읽기부터 모두 새 값이다.
  f.cards.create({repo: 'demo', id: 'card-9', repoPath: f.home, title: '새 카드', body: '# 새 카드', by: '사람'});
  assert.equal(readers.readCards().length, 4);
  assert.equal(readers.loadSummary().counts.executions, 4);
  const fresh = createDashboardSummaryReader(f.home, {listSessions: sessions, now: fixedNow});
  assert.deepEqual(readers.loadSummary(), fresh());
});

test('요약 읽기는 카드·업무 읽기와 트리 입력 기억을 넘겨받을 수 있고 없으면 기존 방식이다', () => {
  const f = dashboardFixture({count: 2});made.push(f.home);
  const calls = {cards: 0, works: 0};
  const readers = createDashboardReaders(f.home, {listSessions: () => [], now: () => 1});
  const read = createDashboardSummaryReader(f.home, {listSessions: () => [], now: () => 1,
    readCards: () => {calls.cards++;return readers.readCards();},
    readWorks: () => {calls.works++;return readers.readWorks();}});
  assert.deepEqual(read(), createDashboardSummaryReader(f.home, {listSessions: () => [], now: () => 1})());
  assert.deepEqual(calls, {cards: 1, works: 1});
});

test('요약·우편 읽기는 한 벌을 공유하고 요약을 읽어도 수집의 카드 상태 기억이 흔들리지 않는다', t => {
  const f = dashboardFixture({count: 3});made.push(f.home);
  process.env.KADAN_HOME = f.home;wallCache.clear();
  const list = floor.list;floor.list = () => [];
  t.after(() => {floor.list = list;});
  const loader = createWallSnapshotLoader(null, {summaryBodies: true});
  const build = () => loader.build(storageSnapshot(f.home, loader.read));
  const readers = createDashboardReaders(f.home, {listSessions: () => [], now: () => 1});
  build();
  const cards = readers.readCards(), works = readers.readWorks();
  assert.equal(cards.length, 3);
  assert.equal(readers.readCards(), cards, '바뀐 것이 없으면 같은 배열 참조');
  assert.equal(readers.readWorks(), works);
  const stat = () => ({hit: wallCache.stats().center?.hit ?? 0, miss: wallCache.stats().center?.miss ?? 0});
  const before = stat();
  readers.loadSummary();
  build();
  assert.deepEqual(stat(), {hit: before.hit + 1, miss: before.miss},
    '요약을 읽은 사이에도 수집의 카드 상태 기억이 그대로 적중한다(트리 입력 공유가 revision을 흔들지 않음)');
  assert.equal(readers.readCards(), cards, '수집(본문 읽기)을 거쳐도 사건에서 온 행 배열은 그대로');
});

// ---- 검수 중요 3건: 요약·우편 경로는 본문(card.md)과 파일 지문을 쓰지 않는다 ----
function summaryServer(t, f, readers) {
  process.env.KADAN_HOME = f.home;wallCache.clear();
  const list = floor.list;floor.list = () => [];
  t.after(() => {floor.list = list;});
  const server = createWallServer(createWallSnapshotLoader(null, {summaryBodies: true}), {home: f.home, cacheSec: 0,
    gui: true, warmAfterMs: 600_000, loadSummary: readers.loadSummary, loadMail: readers.loadMail});
  closeAfter(t, server);
  return start(server);
}
function mailedFixture() {
  const f = dashboardFixture({count: 2});made.push(f.home);
  appendLedger({kind: 'send', mailId: 'mail-1', t: '2026-01-01T00:00:00Z', role: 'fixture-0', by: 'lead',
    taskId: 'card-1', executionKey: 'demo/card-1', workKey: 'demo/dashboard', preview: '첫 우편'}, f.home);
  return f;
}
const unrelated = f => appendLedger({kind: 'watch-cycle', t: new Date().toISOString(), by: 'watch'}, f.home);

test('다른 카드 한 장의 card.md가 없어도 요약은 200이고 정상 카드의 우편 링크가 남는다', async t => {
  const f = mailedFixture();
  const readers = createDashboardReaders(f.home, {listSessions: () => []});
  const base = await summaryServer(t, f, readers);
  const summary = async () => (await fetch(base + '/api/dashboard/summary?fresh=1'));
  const mail = async () => (await fetch(base + '/api/dashboard/mail?fresh=1'));
  const linked = async () => (await (await mail()).json()).items[0]?.card?.key;
  assert.equal((await (await summary()).json()).counts.executions, 2);
  assert.equal(await linked(), 'demo/card-1');
  const second = path.join(f.home, 'cards/demo/card-2/card.md'), moved = second + '.moved';
  fs.renameSync(second, moved);
  unrelated(f);
  const missing = await summary();
  assert.equal(missing.status, 200, '다른 카드의 본문 누락이 요약을 503으로 바꾸지 않는다');
  assert.equal((await missing.json()).counts.executions, 2);
  const withMissing = await mail();
  assert.equal(withMissing.status, 200);
  assert.equal((await withMissing.json()).items[0]?.card?.key, 'demo/card-1', '정상 카드의 우편 링크가 남는다');
  fs.renameSync(moved, second);
  assert.equal((await summary()).status, 200, '본문을 돌려놓아도 정상');
  assert.equal(await linked(), 'demo/card-1');
});

test('카드가 그대로인 채 무관한 원장 사건이 생겨도 요약·우편은 카드 본문 파일을 stat하지 않는다', async t => {
  const f = mailedFixture();
  const readers = createDashboardReaders(f.home, {listSessions: () => []});
  const base = await summaryServer(t, f, readers);
  const get = async route => (await fetch(base + '/api/dashboard/' + route + '?fresh=1')).status;
  assert.equal(await get('summary'), 200);assert.equal(await get('mail'), 200);
  const seen = [];
  const original = fs.statSync;
  t.mock.method(fs, 'statSync', (target, ...rest) => {
    if (String(target).endsWith('card.md')) seen.push(String(target));
    return original(target, ...rest);
  });
  unrelated(f);
  assert.equal(await get('summary'), 200);assert.equal(await get('mail'), 200);
  unrelated(f);
  assert.equal(await get('summary'), 200);assert.equal(await get('mail'), 200);
  assert.deepEqual(seen, [], '요약·우편 경로의 card.md stat은 0회');
});

test('같은 사건 번호에서 heads 최신 행이 events와 어긋나면 요약이 바로 이력 손상으로 실패한다', async t => {
  const f = mailedFixture();
  const readers = createDashboardReaders(f.home, {listSessions: () => []});
  const base = await summaryServer(t, f, readers);
  const summary = async () => fetch(base + '/api/dashboard/summary?fresh=1');
  assert.equal((await summary()).status, 200);
  const db = new DatabaseSync(storagePath(f.home));
  try {
    const stream = 'cards/demo/card-1/events.jsonl';
    const changed = db.prepare("UPDATE heads SET payload=json_set(payload,'$.title','변조') WHERE stream=?").run(stream);
    assert.equal(changed.changes, 1, '시험 준비: heads 한 행을 바꿨다');
  } finally {db.close();}
  const broken = await summary();
  assert.equal(broken.status, 503);
  assert.match(await broken.text(), /카드 이력 손상/, '무관 사건이 없어도 같은 사건 번호에서 바로 잡는다');
  unrelated(f);
  const again = await summary();
  assert.equal(again.status, 503);
  assert.match(await again.text(), /카드 이력 손상/, '무관 사건 뒤에도 마찬가지');
});

test('readRows는 본문 없이 사건에서 온 행을 주고 read와 같은 동기화 상태를 공유한다', t => {
  const f = dashboardFixture({count: 2});made.push(f.home);
  const reader = createDashboardStoreReader(f.home, 'cards', {summaryBodies: true, facts: true});
  const original = fs.statSync, original2 = fs.readFileSync;
  const touched = [];
  t.mock.method(fs, 'statSync', (target, ...rest) => {
    if (String(target).endsWith('card.md')) touched.push('stat');
    return original(target, ...rest);
  });
  t.mock.method(fs, 'readFileSync', (target, ...rest) => {
    if (String(target).endsWith('card.md')) touched.push('read');
    return original2(target, ...rest);
  });
  const rows = reader.readRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(touched, [], 'readRows는 card.md를 읽지도 stat하지도 않는다');
  assert.equal(reader.readRows(), rows, '바뀐 것이 없으면 같은 배열');
  assert.ok(rows.every(row => row.path.endsWith('card.md') && !('bodySummary' in row)));
  const full = reader.read();
  assert.ok(touched.length > 0 && full.every(row => row.bodySummary), 'read는 본문 요약을 붙인다');
  assert.equal(reader.readRows(), rows, 'read를 거쳐도 사건이 같으면 같은 배열');
  assert.equal(full.length, rows.length);
  f.cards.create({repo: 'demo', id: 'card-9', repoPath: f.home, title: '새', body: '# 새', by: '사람'});
  const next = reader.readRows();
  assert.notEqual(next, rows);
  assert.equal(next.length, 3);
});
