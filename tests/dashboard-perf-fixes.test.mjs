import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {appendLedger, saveMailBody} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker, storageSnapshot} from '../src/storage.mjs';
import {floor} from '../src/floor.mjs';
import {wallCache} from '../src/wall-snapshot-cache.mjs';
import {createWallServer, withWaitSnapshots} from '../src/wall.mjs';
import {createWallSnapshotLoader, createDashboardReaders, loadWallSnapshot} from '../src/commands/tree-wall.mjs';
import {createDashboardSummaryReader} from '../src/dashboard-summary-reader.mjs';
import {createDashboardMailReader} from '../src/dashboard-mail-reader.mjs';
import {watchOverview, watchOverviewMemoInfo, createCachedWatchProcesses} from '../src/watch-overview.mjs';
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
