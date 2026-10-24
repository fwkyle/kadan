import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {appendLedger, saveMailBody} from '../src/ledger.mjs';
import {transaction} from '../src/storage.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {createDashboardMailReader} from '../src/dashboard-mail-reader.mjs';
import {createWallServer} from '../src/wall.mjs';

const urlOf = query => new URL('http://local/api/dashboard/mail?' + (query ?? ''));
const content = value => Object.fromEntries(Object.entries(value)
  .filter(([key]) => !['collectedAt', 'runtime', 'cursorReset', 'nextCursor', 'previousCursor'].includes(key)));
function fixture() {
  const f = dashboardFixture({count:3});
  saveMailBody('body-a', '검색 전용 원문 Alpha BETA', f.home);
  transaction(f.home, () => {
    for (let i = 0; i < 161; i++) appendLedger({kind:'send', mailId:`mail-${i}`,
      t:'2026-01-01T00:00:00Z', role:`fixture-${i % 3}`, by:i % 4 ? 'fixture-lead' : 'watch',
      taskId:i % 2 ? 'card-1' : 'card-2', executionKey:i % 2 ? 'demo/card-1' : 'demo/card-2',
      workKey:'demo/dashboard', preview:i % 2 ? `미리보기 ${i}` : '', digest:i % 5 ? 'absent' : 'body-a',
      expectReply:i % 3 === 0, deliveredRead:i % 4 === 0}, f.home);
    appendLedger({kind:'mail-read', mailId:'mail-3', role:'fixture-0', by:'fixture-0'}, f.home);
    appendLedger({kind:'mail-cancel', mailId:'mail-6', role:'fixture-0', by:'fixture-lead'}, f.home);
    appendLedger({kind:'handover', phase:'transferred', from:'fixture-2', to:'fixture-next', handoverId:'h'}, f.home);
    appendLedger({kind:'start', role:'fixture-0', session:'kadan-fixture-0', panePid:1}, f.home);
    appendLedger({kind:'start', role:'fixture-0', session:'kadan-fixture-0', panePid:2}, f.home);
  });
  return {...f, read:createDashboardMailReader(f.home)};
}

test('조건·숫자 쪽·통계·역할·원문/대소문자 검색이 기존 화면과 같다', () => {
  const f = fixture(), snapshot = f.snapshot();
  const cases = ['', 'mailPage=2', 'mailPage=999', 'mailView=waiting', 'mailView=to-reply',
    'mailRole=fixture-next', 'mailRole=fixture-0&mailView=received', 'mailRole=fixture-lead&mailView=sent',
    'mailReply=cancelled', 'mailUnread=1', 'mailUnread=previous', 'hideWatch=1',
    'mailCard=card-1', 'mailCard=demo/card-1', 'mailCard=demo/dashboard', 'mailCard=other/card-1',
    'mailQ=beta', 'mailQ=미리보기', 'mailQ=fixture', 'mailQ=fixture&mailPage=999',
    'mailQ=beta&mailUnread=1', 'mailView=unknown', "mailRole=' OR 1=1 --"];
  for (const query of cases) assert.deepEqual(content(f.read(urlOf(query))),
    content(dashboardData(snapshot, urlOf(query))), query);
});

test('새 우편은 쪽 사이에 끼지 않으며 기존 우편의 상태 변경은 첫 쪽으로 돌아간다', () => {
  const f = fixture(), first = f.read(urlOf());
  appendLedger({kind:'send', mailId:'new', role:'fixture-new', by:'fixture-lead'}, f.home);
  const url = urlOf();url.searchParams.set('mailCursor', first.nextCursor);
  const second = f.read(url);assert.equal(second.page, 2);assert.equal(second.total, first.total);
  const back = urlOf();back.searchParams.set('mailCursor', second.previousCursor);
  assert.deepEqual(f.read(back).items, first.items);
  appendLedger({kind:'mail-read', mailId:'mail-1', role:'fixture-1', by:'fixture-1'}, f.home);
  const updated = f.read(url);assert.equal(updated.cursorReset, true);assert.equal(updated.page, 1);
  assert.deepEqual(updated.items, f.read(urlOf()).items);
  const changed = urlOf('mailRole=fixture-next');changed.searchParams.set('mailCursor', first.nextCursor);
  assert.equal(f.read(changed).cursorReset, true);
  assert.throws(() => f.read(urlOf('mailCursor=bad')), error => error.status === 400);
});

test('본문 검색은 DB 밖에서 읽으며 커서 왕복과 빈 검색·숫자 마지막 쪽도 같다', () => {
  const f = fixture();f.read(urlOf());
  const original = fs.readFileSync, prepare = DatabaseSync.prototype.prepare, databases = new Set();
  DatabaseSync.prototype.prepare = function(sql) {
    assert.equal(typeof this.isOpen, 'boolean');databases.add(this);return prepare.call(this, sql);
  };
  fs.readFileSync = function(file, ...rest) {
    if (String(file).endsWith('/mail/body-a.txt')) {
      for (const db of databases) if (db.isOpen) assert.equal(db.isTransaction, false, '본문 검색 때 열린 DB snapshot');
    }
    return original.call(this, file, ...rest);
  };
  try {
    const first = f.read(urlOf('mailQ=fixture'));
    const next = urlOf('mailQ=fixture');next.searchParams.set('mailCursor', first.nextCursor);
    const second = f.read(next);assert.equal(second.page, 2);
    next.searchParams.set('mailCursor', second.previousCursor);assert.deepEqual(f.read(next).items, first.items);
    assert.equal(f.read(urlOf('mailQ=not-found-anywhere')).total, 0);
    assert.ok(f.read(urlOf('mailQ=beta')).total > 0);
  } finally {fs.readFileSync = original;DatabaseSync.prototype.prepare = prepare;}
});

test('본문 단건·본문 없음·없는 주소와 HTTP 출처/방법/304 경계가 같다', async () => {
  const f = fixture(), body = new URL('http://local/api/dashboard/mail-body?id=fixture-letter');
  assert.deepEqual(content(f.read(body)), content(dashboardData(f.snapshot(), body)));
  body.searchParams.set('id', 'mail-1');assert.equal(f.read(body).error, '본문 없음 또는 읽기 불가');
  body.searchParams.set('id', 'missing');assert.throws(() => f.read(body), error => error.status === 404);
  let heavy = 0;
  const server = createWallServer(() => {heavy++;throw new Error('전체 수집 금지');}, {home:f.home, loadMail:f.read});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/dashboard/mail`;
  try {
    const first = await fetch(base);assert.equal(first.status, 200);await first.json();
    const cached = await fetch(base, {headers:{'if-none-match':first.headers.get('etag')}});
    assert.equal(cached.status, 304);
    const fresh = await fetch(base + '?fresh=1', {headers:{'if-none-match':first.headers.get('etag')}});
    assert.equal(fresh.status, 200);await fresh.json();
    assert.equal((await fetch(base, {headers:{origin:'https://bad.invalid'}})).status, 403);
    assert.equal((await fetch(base, {method:'POST'})).status, 405);
    assert.equal(heavy, 0);
  } finally {await new Promise(resolve => server.close(resolve));}
});

test('일반 첫 쪽은 과거 우편 본문을 모두 해석하거나 OFFSET으로 건너뛰지 않는다', () => {
  const f = fixture();f.read(urlOf());
  const statements = [], prepare = DatabaseSync.prototype.prepare, parse = JSON.parse;
  let decoded = 0;
  DatabaseSync.prototype.prepare = function(sql) {statements.push(sql);return prepare.call(this, sql);};
  JSON.parse = function(value, ...rest) {
    if (typeof value === 'string' && value.includes('"mailId":"mail-')) decoded++;
    return parse(value, ...rest);
  };
  try {f.read(urlOf());} finally {DatabaseSync.prototype.prepare = prepare;JSON.parse = parse;}
  assert.equal(statements.some(sql => /\bOFFSET\b/i.test(sql)), false);
  assert.ok(decoded <= 52, `선택한 50건과 끝 지문만 읽어야 한다: ${decoded}`);
});

test('본문 검색 중 상태가 바뀌면 서로 다른 시점의 결과를 합치지 않는다', () => {
  const f = fixture();f.read(urlOf());
  const original = fs.readFileSync;
  let changed = false;
  fs.readFileSync = function(file, ...rest) {
    if (!changed && String(file).endsWith('/mail/body-a.txt')) {
      changed = true;
      appendLedger({kind:'mail-read', mailId:'mail-1', role:'fixture-1', by:'fixture-1'}, f.home);
    }
    return original.call(this, file, ...rest);
  };
  try {assert.throws(() => f.read(urlOf('mailQ=beta')), /검색 중 우편 상태가 바뀌었습니다/);}
  finally {fs.readFileSync = original;}
  assert.equal(changed, true);
});
