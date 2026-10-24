import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {summarizeCardBody, hydrateCardBody} from '../src/dashboard-card-body.mjs';
import {buildExplainInput} from '../src/explain-input.mjs';
import {Scribe, briefInput} from '../src/human-brief.mjs';
import {EXPLAIN_BY} from '../src/actors.mjs';
import {cardPurpose} from '../src/dashboard-flow.mjs';
import {createDashboardStoreReader} from '../src/dashboard-store-reader.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {appendStream} from '../src/storage.mjs';
import {loadWallSnapshot, createWallSnapshotLoader} from '../src/commands/tree-wall.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {renderCenterWall} from '../src/center-wall.mjs';
import {wallCache} from '../src/wall-snapshot-cache.mjs';
import {floor} from '../src/floor.mjs';
import {createWallServer} from '../src/wall.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const bodies = ['', '일반 본문', '# 제목\n## Why\n- 첫 목적\n```\n## Why\n가짜\n```\n## 목적\n추가 목적',
  '# 제목\n## Why\n' + '긴 목적 🙂 '.repeat(1500), 'a'.repeat(3999) + '🙂끝',
  'Bearer ' + 'x'.repeat(40) + '\0\n' + '본문 '.repeat(3000)];

test('본문 요약은 설명 입력·수동/AI 설명 신선도·목록 목적과 같다', () => {
  for (const body of bodies) {
    const card = {key:'demo/card', id:'card', title:'제목', revision:9, status:'draft',
      displayState:'draft', body, history:[], runs:[]};
    const {body:removed, ...summary} = card;
    summary.bodySummary = summarizeCardBody(card, body);
    assert.deepEqual(buildExplainInput(summary), buildExplainInput(card));
    assert.equal(cardPurpose(summary).text, cardPurpose(card).text.slice(0, 220));
    assert.deepEqual(cardPurpose(summary, {goal:'지정 목적'}), cardPurpose(card, {goal:'지정 목적'}));
    const brief = {title:'쉬운 제목', workstream:'분류', summary:'현재 설명',
      sourceHash:digest(JSON.stringify([card.revision, body])),
      contentHash:digest(JSON.stringify([card.title, body]))};
    for (const value of [null, {...brief, by:'사람'}, {...brief, by:EXPLAIN_BY,
      inputHash:briefInput(card).hash}, {...brief, sourceHash:'낡은 설명'}]) {
      assert.deepEqual(new Scribe().summarize(summary, value), new Scribe().summarize(card, value));
    }
    assert.ok(JSON.stringify(summary.bodySummary).length < 8000);
    assert.equal(removed, body);
  }
});

test('본문 원문은 보관하지 않고 변경 파일·제목·revision의 지문만 새로 만든다', () => {
  const f = dashboardFixture({count:2});
  const reader = createDashboardStoreReader(f.home, 'cards', {summaryBodies:true});
  const first = reader.read(), stats = reader.info();
  assert.ok(first.every(c => !Object.hasOwn(c, 'body')));
  assert.deepEqual(first.map(hydrateCardBody), f.cards.list());
  assert.deepEqual(reader.read(), first);assert.deepEqual(reader.info(), stats);
  const old = first[0];
  appendStream(f.home, `cards/${old.key}/events.jsonl`,
    {...old.history.at(-1), revision:old.revision + 1, title:'바뀐 제목'});
  const second = reader.read();
  assert.notEqual(second[0].bodySummary.sourceHash, old.bodySummary.sourceHash);
  assert.notEqual(second[0].bodySummary.contentHash, old.bodySummary.contentHash);
  assert.deepEqual(second.map(hydrateCardBody), f.cards.list());
  appendStream(f.home, `cards/${old.key}/events.jsonl`,
    {...second[0].history.at(-1), revision:old.revision + 2, note:'기록만 추가'});
  const third = reader.read();
  assert.notEqual(third[0].bodySummary.sourceHash, second[0].bodySummary.sourceHash);
  assert.equal(third[0].bodySummary.contentHash, second[0].bodySummary.contentHash);
  assert.deepEqual(third.map(hydrateCardBody), f.cards.list());
  const stat = fs.statSync(old.path);
  fs.writeFileSync(old.path, '# 본문 변경\n## Why\n새 목적');fs.utimesSync(old.path, stat.atime, stat.mtime);
  assert.throws(() => hydrateCardBody(old), {code:'KADAN_BODY_CHANGED'});
  assert.deepEqual(reader.read().map(hydrateCardBody), f.cards.list());
  assert.equal(reader.info().bodies - stats.bodies, 3);
  assert.equal(first[0].revision, old.revision, '이전 수집 결과는 바꾸지 않는다');
});

test('요약 본문 loader의 목록·상세·작업시간·검수 결과는 전체 loader와 같다', t => {
  t.mock.timers.enable({apis:['Date'], now:Date.parse('2026-01-01T12:00:00Z')});
  const f = dashboardFixture({count:2});process.env.KADAN_HOME = f.home;
  const file = f.cards.get('demo/card-1').path;
  fs.writeFileSync(file, '# 지시문\n## Why\n' + '긴 목적 '.repeat(100) + '\n## 작업\n전체 상세');
  const list = floor.list;floor.list = () => [];wallCache.clear();
  try {
    const full = loadWallSnapshot(null, {listOnly:true});full.home = f.home;
    const summary = loadWallSnapshot(null, {listOnly:true,summaryBodies:true});summary.home = f.home;
    assert.ok(summary.center.cards.every(c => !Object.hasOwn(c, 'body')));
    for (const route of ['workspace?collection=executions&state=all', 'workspace?collection=work',
      'detail?card=demo/card-1', 'detail?card=work:demo/dashboard', 'worktime', 'runs', 'kanban']) {
      const url = new URL('http://local/api/dashboard/' + route);
      assert.deepEqual(dashboardData(summary, url), dashboardData(full, url), route);
    }
    const read = fs.readFileSync;
    try {
      fs.readFileSync = function(file, ...args) {
        assert.ok(!String(file).endsWith('/card.md'), '목록 계산에서 본문을 다시 열지 않는다');
        return read.call(this, file, ...args);
      };
      dashboardData({...summary}, new URL('http://local/api/dashboard/workspace?collection=executions'));
    } finally {fs.readFileSync = read;}
    const options = {token:'same-token', url:new URL('http://local/?partial=detail&card=demo/card-1')};
    assert.equal(renderCenterWall(summary, options), renderCenterWall(full, options));
  } finally {floor.list = list;wallCache.clear();}
});

test('상세가 캐시 뒤 바뀐 본문을 만나면 한 번 새로 수집하고 최신 원문을 반환한다', async () => {
  const f = dashboardFixture({count:2});process.env.KADAN_HOME = f.home;
  const list = floor.list;floor.list = () => [];wallCache.clear();
  const reader = createWallSnapshotLoader(null, {listOnly:true,summaryBodies:true});let reads = 0;
  const loader = {read:() => {reads++;return reader.read();}, build:reader.build};
  const server = createWallServer(loader, {home:f.home,loadListSnapshot:loader,warmAfterMs:60_000});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/dashboard/`;
  try {
    const first = await fetch(base + 'workspace?collection=executions');
    assert.equal(first.status, 200);await first.text();assert.equal(reads, 1);
    const file = f.cards.get('demo/card-1').path, body = '# 새 원문\n## Why\n현재 목적';
    fs.writeFileSync(file, body);
    const detail = await fetch(base + 'detail?card=demo/card-1');
    assert.equal(detail.status, 200);assert.equal((await detail.json()).instructions.body, body);
    assert.equal(reads, 2);
    loader.build = value => {
      const snapshot = reader.build(value);
      fs.writeFileSync(file, body + `\n변경 ${reads}`);
      return snapshot;
    };
    const changed = await fetch(base + 'detail?card=demo/card-1&fresh=1');
    assert.equal(changed.status, 503);await changed.text();
    assert.equal(reads, 4, '연속 변경도 새 수집은 한 번뿐이다');
  } finally {
    await new Promise(resolve => server.close(resolve));floor.list = list;wallCache.clear();
  }
});
