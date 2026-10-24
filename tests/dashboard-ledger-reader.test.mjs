import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {transaction} from '../src/storage.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {createDashboardLedgerReader} from '../src/dashboard-ledger-reader.mjs';
import {createWallServer} from '../src/wall.mjs';

const urlOf = (query = '') => new URL('http://local/api/dashboard/ledger?' + query);
const content = value => ({items:value.items, total:value.total, page:value.page, pages:value.pages, pageSize:value.pageSize});
function fixture() {
  const f = dashboardFixture({count:3});
  transaction(f.home, () => {
    for (let i = 0; i < 171; i++) appendLedger({kind:i % 3 === 0 ? 'watch-cycle' : 'alert',
      t:i % 5 === 0 ? 'bad time' : `2026-01-0${i % 3 + 1}T15:30:00Z`,
      by:i % 3 === 0 ? 'watch' : 'fixture-lead', role:`fixture-${i % 4}`,
      taskId:i % 2 ? 'card-1' : 'other/card-1', executionKey:i % 2 ? 'demo/card-1' : 'other/card-1',
      resolved:i % 4 !== 0, reason:i % 7 === 0 ? 'failure' : '', n:i}, f.home);
  });
  return {...f, read:createDashboardLedgerReader(f.home)};
}

test('SQL 조건·숫자 쪽 호환은 기존 화면 결과와 같다', () => {
  const f = fixture();
  const cases = ['', 'logPage=2', 'logPage=999', 'ledgerRoutine=1', 'ledgerRoutine=1&logPage=3',
    'ledgerKind=incident', 'ledgerKind=incident&ledgerRoutine=1', 'ledgerRole=fixture-2',
    'ledgerCard=card-1', 'ledgerCard=demo/card-1', 'ledgerCard=other/card-1',
    'ledgerDate=2026-01-02', 'ledgerRole=fixture-1&ledgerCard=demo/card-1&ledgerDate=2026-01-04',
    'ledgerDomain=mail', 'ledgerDomain=tasks', 'ledgerDomain=system', 'ledgerDomain=invalid',
    'ledgerRole=absent', 'ledgerDate=bad', "ledgerRole=' OR 1=1 --"];
  const snapshot = f.snapshot();
  for (const query of cases) assert.deepEqual(content(f.read(urlOf(query))),
    content(dashboardData(snapshot, urlOf(query))), query);
});

test('앞·뒤 커서는 새 사건이 들어와도 같은 조회 범위를 왕복하고 본문 50개만 읽는다', () => {
  const f = fixture(), first = f.read(urlOf());
  appendLedger({kind:'alert', role:'fixture-new'}, f.home);
  const secondUrl = urlOf('logPage=2');secondUrl.searchParams.set('logCursor', first.nextCursor);
  let decoded = 0;
  const parse = JSON.parse;
  JSON.parse = function(value, ...rest) {
    if (typeof value === 'string' && value.includes('"n":')) decoded++;
    return parse(value, ...rest);
  };
  let second;
  try {second = f.read(secondUrl);} finally {JSON.parse = parse;}
  assert.equal(second.total, first.total);
  assert.equal(second.page, 2);
  assert.ok(decoded <= 52, `과거 사건의 본문을 모두 해석하지 않는다: ${decoded}`);
  const previousUrl = urlOf();previousUrl.searchParams.set('logCursor', second.previousCursor);
  assert.deepEqual(content(f.read(previousUrl)), content(first));
  const current = f.read(urlOf());
  assert.equal(current.total, first.total + 1);
  assert.equal(current.items[0].target, 'fixture-new');
});

test('다른 조건의 cursor는 첫 쪽으로 돌아가고 깨진 cursor는 거부한다', () => {
  const f = fixture(), first = f.read(urlOf());
  const changed = urlOf('ledgerRole=fixture-2&logPage=2');
  changed.searchParams.set('logCursor', first.nextCursor);
  const result = f.read(changed);
  assert.equal(result.cursorReset, true);assert.equal(result.page, 1);
  assert.deepEqual(content(result), content(f.read(urlOf('ledgerRole=fixture-2'))));
  assert.throws(() => f.read(urlOf('logCursor=not-json')), error => error.status === 400);
});

test('기록 HTTP 조회는 공통 수집·tmux 없이 처리하고 인증/출처·304·강제 갱신을 지킨다', async () => {
  const f = fixture();
  let captures = 0;
  const server = createWallServer(() => {captures++;throw new Error('공통 수집 금지');},
    {home:f.home, loadLedger:f.read});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/dashboard/ledger`;
  try {
    const first = await fetch(base);assert.equal(first.status, 200);await first.json();
    const second = await fetch(base, {headers:{'if-none-match':first.headers.get('etag')}});
    assert.equal(second.status, 304);
    const fresh = await fetch(base + '?fresh=1', {headers:{'if-none-match':first.headers.get('etag')}});
    assert.equal(fresh.status, 200);await fresh.json();
    const denied = await fetch(base, {headers:{origin:'https://bad.invalid'}});
    assert.equal(denied.status, 403);
    const post = await fetch(base, {method:'POST'});assert.equal(post.status, 405);
    assert.equal(captures, 0);
  } finally {await new Promise(resolve => server.close(resolve));}
});

test('정상 첫 쪽 쿼리는 OFFSET·전체 count·본문 전체 조회를 쓰지 않는다', () => {
  const f = fixture();f.read(urlOf());
  const statements = [], original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {statements.push(sql);return original.call(this, sql);};
  try {f.read(urlOf());} finally {DatabaseSync.prototype.prepare = original;}
  assert.equal(statements.some(sql => /\bOFFSET\b/i.test(sql)), false);
  assert.equal(statements.some(sql => /count\(\*\).*FROM views/is.test(sql)), false);
  const payloadQueries = statements.filter(sql => /SELECT r\.stream,r\.seq/.test(sql));
  assert.equal(payloadQueries.length, 1);
  assert.match(payloadQueries[0], /LIMIT \?/);
});

test('날짜 범위 끝의 기록은 일반 조회를 막지 않고 날짜 거르기 오류도 보존한다', () => {
  const f = fixture();
  appendLedger({kind:'alert', t:'+275760-09-13T00:00:00.000Z', role:'edge'}, f.home);
  assert.deepEqual(content(f.read(urlOf())), content(dashboardData(f.snapshot(), urlOf())));
  const date = urlOf('ledgerDate=2026-01-01');
  assert.throws(() => dashboardData(f.snapshot(), date), RangeError);
  assert.throws(() => f.read(date), RangeError);
  const unrelated = urlOf('ledgerDate=2026-01-01&ledgerRole=fixture-1');
  assert.deepEqual(content(f.read(unrelated)), content(dashboardData(f.snapshot(), unrelated)));
});
