import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {createDashboardSummaryReader} from '../src/dashboard-summary-reader.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {appendStream} from '../src/storage.mjs';
import {buildTree} from '../src/cli-tree.mjs';
import {readLedgerIncremental} from '../src/ledger-incremental.mjs';
import {createWallServer} from '../src/wall.mjs';
import {createResponseCache} from '../src/response-cache.mjs';

const url = new URL('http://localhost/api/dashboard/summary');
const withoutTime = ({collectedAt, ...v}) => v;

test('가벼운 요약은 본문을 읽지 않고 전체 화면 수집과 같은 값이다', () => {
  const f = dashboardFixture({count: 3});
  let live = [{session: 'kadan-비서', pid: 12}];
  const read = createDashboardSummaryReader(f.home, {listSessions: () => live});
  const expected = () => {
    const snapshot = f.snapshot();
    snapshot.resourceError = null;
    snapshot.center.roles = buildTree(snapshot.entries,
      Object.fromEntries(live.map(s => [s.session, s])), snapshot.center.cards).flatMap(b => b.roles);
    return withoutTime(dashboardData(snapshot, url));
  };
  const changes = [
    () => {},
    () => appendLedger({kind: 'watch-cycle', timing: {totalMs: 1}}, f.home),
    () => appendLedger({kind: 'send', by: 'reader', role: 'writer', expectReply: true,
      mailId: 'question-2', transport: 'mailbox'}, f.home),
    () => {
      const d = f.decisions.list()[0];
      appendStream(f.home, 'decisions/events.jsonl', {...d, revision: d.revision + 1, status: 'cancelled'});
    },
    () => { live = []; },
  ];
  for (const change of changes) {
    change();
    const full = expected(), original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (String(file).endsWith('/card.md')) throw new Error('요약에서 본문을 읽음');
      return original.call(this, file, ...args);
    };
    try { assert.deepEqual(withoutTime(read()), full); }
    finally { fs.readFileSync = original; }
  }
});

test('원장 밖 조회는 읽기 트랜잭션 종료 후 수행하며 생존 실패는 모름이다', () => {
  const f = dashboardFixture({count: 2});
  const read = createDashboardSummaryReader(f.home, {listSessions: () => {
    // 열린 읽기 transaction 안이었다면 쓰기 금지 예외가 난다.
    appendLedger({kind: 'note', note: 'snapshot 뒤 새 사건'}, f.home);
    throw new Error('세션 조회 실패');
  }});
  const value = read();
  assert.equal(value.secretary, null);
  assert.match(value.errors.join(' '), /생존 못 읽음.*세션 조회 실패/);
  assert.doesNotMatch(value.errors.join(' '), /쓰기 금지/);
});

test('요약 실패를 오래된 정상 값으로 덮지 않는다', () => {
  const f = dashboardFixture({count: 2});
  const read = createDashboardSummaryReader(f.home, {listSessions: () => []});
  read();
  appendStream(f.home, 'cards/demo/card-1/events.jsonl', {key: 'wrong', revision: 2});
  assert.throws(read, /이력 손상/);
});

test('우편과 관계없는 감시 사건은 우편 투영의 배열을 바꾸지 않는다', () => {
  const f = dashboardFixture({count: 2});
  const first = readLedgerIncremental(f.home, {domain: 'mailbox'});
  appendLedger({kind: 'watch-cycle', timing: {totalMs: 2}}, f.home);
  assert.strictEqual(readLedgerIncremental(f.home, {domain: 'mailbox'}), first);
  appendLedger({kind: 'send', role: 'worker', by: 'boss', mailId: 'new-mail'}, f.home);
  assert.notStrictEqual(readLedgerIncremental(f.home, {domain: 'mailbox'}), first);
});

test('요약 HTTP는 전체 수집·선행 수집 없이 ETag와 강제 갱신을 처리한다', async () => {
  const f = dashboardFixture({count: 2});
  let full = 0, small = 0, count = 2;
  const server = createWallServer(() => { full++; throw new Error('전체 수집 금지'); }, {
    home: f.home, warmAfterMs: 5, loadSummary: () => {
      small++; return {collectedAt: new Date(), counts: {executions: count}};
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = await fetch(base + url.pathname), tag = a.headers.get('etag');
    assert.equal(a.status, 200); assert.ok(tag); await a.text();
    const b = await fetch(base + url.pathname, {headers: {'if-none-match': tag}});
    assert.equal(b.status, 304); assert.equal(await b.text(), '');
    const force = await fetch(base + url.pathname + '?fresh=1', {headers: {'if-none-match': tag}});
    assert.equal(force.status, 200); await force.text();
    count++;
    const changed = await fetch(base + url.pathname, {headers: {'if-none-match': tag}});
    assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), tag); await changed.text();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(full, 0); assert.equal(small, 4);
    // fetch는 Host 재정의를 무시하므로 실제 HTTP 요청으로 접근 경계를 검증한다.
    const denied = await new Promise((resolve, reject) => {
      http.get(base + url.pathname, {headers: {host: 'untrusted.invalid'}}, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      }).once('error', reject);
    });
    assert.equal(denied, 403);
    assert.equal(small, 4, '요약 앞에도 기존 접근 판정이 있다');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('응답 캐시는 UTF-8 총 바이트·개수 한도를 지키며 큰 응답은 보관하지 않는다', () => {
  const cache = createResponseCache({maxEntries: 2, maxBytes: 10});
  cache.set('a', {body: '가나'}); cache.set('b', {body: '12345'});
  assert.equal(cache.get('a'), undefined); assert.equal(cache.info().bytes, 5);
  cache.set('b', {body: '1'}); assert.equal(cache.info().bytes, 1);
  cache.set('c', {body: '2'}); cache.set('d', {body: '3'});
  assert.equal(cache.get('b'), undefined); assert.equal(cache.info().entries, 2);
  cache.set('huge', {body: 'x'.repeat(11)}); assert.equal(cache.get('huge'), undefined);
  cache.delete('d'); assert.equal(cache.info().bytes, 1);
  cache.clear(); assert.deepEqual(cache.info(), {entries: 0, bytes: 0});
});
