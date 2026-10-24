import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {createDashboardStoreReader} from '../src/dashboard-store-reader.mjs';
import {createDashboardBriefReader} from '../src/dashboard-brief-reader.mjs';
import {BriefStore, buildHumanBrief} from '../src/human-brief.mjs';
import {appendStream, storagePath} from '../src/storage.mjs';
import {createWorkLettersReader, workLetters} from '../src/work-mail.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';
import {taskIdentity} from '../src/task-identity.mjs';
import {operationsFlowSummaries} from '../src/operations-flow.mjs';
import {loadWallSnapshot} from '../src/commands/tree-wall.mjs';
import {wallCache} from '../src/wall-snapshot-cache.mjs';
import {floor} from '../src/floor.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {createWallServer} from '../src/wall.mjs';

test('목록 전용 수집도 목록·상세 응답은 전체 수집과 같다', () => {
  const f = dashboardFixture({count: 2});process.env.KADAN_HOME = f.home;
  const original = floor.list;floor.list = () => [];wallCache.clear();
  try {
    const full = loadWallSnapshot(), list = loadWallSnapshot(null, {listOnly: true});
    full.home = f.home;list.home = f.home;
    assert.equal(list.center.monitoring, undefined);assert.equal(list.resources, undefined);
    for (const route of ['workspace?collection=executions&state=all', 'workspace?collection=work',
      'detail?card=demo/card-1', 'detail?card=work:demo/dashboard']) {
      const url = new URL('http://local/api/dashboard/' + route);
      const strip = ({collectedAt, ...value}) => value;
      assert.deepEqual(strip(dashboardData(list, url)), strip(dashboardData(full, url)), route);
    }
  } finally {floor.list = original;wallCache.clear();}
});

test('목록 HTTP는 별도 수집을 쓰며 현황 캐시와 섞지 않는다', async () => {
  const f = dashboardFixture({count: 2});let full = 0, lists = 0, fail = false;
  const server = createWallServer(() => {full++;return f.snapshot();}, {
    home: f.home, warmAfterMs: 60_000, loadListSnapshot: () => {
      lists++;if (fail) throw new Error('조회 실패');return f.snapshot();
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/dashboard/`;
  const get = async (route, options) => {const r = await fetch(base + route, options);await r.text();return r.status;};
  try {
    assert.equal(await get('workspace?collection=executions'), 200);
    assert.equal(await get('detail?card=demo/card-1'), 200);assert.equal(lists, 1);
    assert.equal(full, 0);
    assert.equal(await get('status'), 200);assert.equal(full, 1);
    assert.equal(await get('workspace?collection=work'), 200);assert.equal(lists, 2);
    assert.equal(full, 1);
    assert.equal(await get('workspace?fresh=1'), 200);assert.equal(lists, 3);
    assert.equal(await get('workspace', {headers: {origin: 'https://untrusted.invalid'}}), 403);
    assert.equal(lists, 3);
    fail = true;assert.equal(await get('workspace?fresh=1'), 503);assert.equal(lists, 4);
  } finally {await new Promise(resolve => server.close(resolve));}
});

test('목록 뒤의 선행 수집은 전체 현황 대신 가벼운 목록 경로를 쓴다', async () => {
  const f = dashboardFixture({count: 2});let full = 0, lists = 0;
  const server = createWallServer(() => {full++;throw new Error('전체 수집 금지');}, {
    home: f.home, warmAfterMs: 5, loadListSnapshot: () => {lists++;return f.snapshot();},
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/dashboard/workspace?collection=executions`;
    const response = await fetch(url);assert.equal(response.status, 200);await response.text();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(full, 0);assert.equal(lists, 2);
  } finally {await new Promise(resolve => server.close(resolve));}
});

test('카드·업무의 묶음 조회는 전체 상세와 같고 새 사건·수정 본문만 읽는다', () => {
  const f = dashboardFixture({count: 2});
  for (const kind of ['cards', 'works']) {
    const store = f[kind], reader = createDashboardStoreReader(f.home, kind);
    const first = reader.read(), before = reader.info();
    assert.deepEqual(first, store.list());assert.deepEqual(reader.read(), first);
    assert.deepEqual(reader.info(), before);
    const old = first[0];
    appendStream(f.home, `${kind}/${old.key}/events.jsonl`,
      {...old.history.at(-1), revision: old.revision + 1, title: '새 제목'});
    assert.deepEqual(reader.read(), store.list());
    assert.equal(reader.info().rows - before.rows, 1);
    assert.equal(first[0].revision, old.revision, '이전 snapshot을 바꾸지 않는다');
    if (kind === 'cards') {
      const file = old.path, stat = fs.statSync(file);
      fs.writeFileSync(file, '# 본문만 수정');fs.utimesSync(file, stat.atime, stat.mtime);
      assert.deepEqual(reader.read(), store.list());
      assert.equal(reader.info().bodies - before.bodies, 1);
    }
  }
});

test('순번 빈틈·head 불일치·잘못된 revision은 부분 결과 없이 거절한다', () => {
  for (const sql of [
    "UPDATE heads SET payload=json_set(payload,'$.title','손상') WHERE stream='cards/demo/card-1/events.jsonl'",
    "INSERT INTO events(stream,seq,payload) SELECT stream,2,json_set(payload,'$.revision',9) FROM heads "
      + "WHERE stream='cards/demo/card-1/events.jsonl';"
      + "UPDATE heads SET seq=2,payload=json_set(payload,'$.revision',9) WHERE stream='cards/demo/card-1/events.jsonl'",
    "INSERT INTO events(stream,seq,payload) SELECT stream,3,json_set(payload,'$.revision',3) FROM heads "
      + "WHERE stream='cards/demo/card-1/events.jsonl';"
      + "UPDATE heads SET seq=3,payload=json_set(payload,'$.revision',3) WHERE stream='cards/demo/card-1/events.jsonl'",
  ]) {
    const f = dashboardFixture({count: 2}), reader = createDashboardStoreReader(f.home, 'cards');
    reader.read();
    const db = new DatabaseSync(storagePath(f.home));db.exec(sql);db.close();
    assert.throws(() => reader.read(), /이력 손상/);
    assert.equal(reader.info().streams, 0);
  }
});

test('저장소 파일을 교체하면 같은 순번도 이전 카드·설명을 재사용하지 않는다', () => {
  const a = dashboardFixture({count: 2}), b = dashboardFixture({count: 2});
  const cards = createDashboardStoreReader(a.home, 'cards'), briefs = createDashboardBriefReader(a.home);
  const key = 'demo/card-1';
  for (const [f, title] of [[a, '이전'], [b, '복원']]) {
    appendStream(f.home, `cards/${key}/briefs.jsonl`, {key, sourceHash: title, title});
  }
  cards.read();assert.equal(briefs.read([key]).get(key).brief.title, '이전');
  fs.renameSync(storagePath(a.home), path.join(a.home, 'previous.sqlite'));
  fs.copyFileSync(storagePath(b.home), storagePath(a.home));
  assert.deepEqual(cards.read(), a.cards.list());
  assert.equal(briefs.read([key]).get(key).brief.title, '복원');
});

test('설명은 과거 손상을 숨기지 않고 정상 카드·없는 설명·새 설명을 구분한다', () => {
  const f = dashboardFixture({count: 3}), reader = createDashboardBriefReader(f.home);
  const keys = ['demo/card-1', 'demo/card-2', 'demo/card-3'];
  for (const key of keys.slice(0, 2)) {
    appendStream(f.home, `cards/${key}/briefs.jsonl`, {key, sourceHash: 'old', title: '첫 설명'});
  }
  assert.equal(reader.read(keys).size, 2);
  const before = reader.info();reader.read(keys);assert.deepEqual(reader.info(), before);
  const key = keys[0];
  appendStream(f.home, `cards/${key}/briefs.jsonl`, {key, sourceHash: 'new', title: '새 설명'});
  assert.deepEqual(reader.read(keys).get(key).brief, new BriefStore(f.home).read(key));
  assert.equal(reader.info().rows - before.rows, 1);
  appendStream(f.home, `cards/${keys[1]}/briefs.jsonl`, null);
  assert.ok(reader.read(keys).get(keys[1]).error);
  appendStream(f.home, `cards/${keys[1]}/briefs.jsonl`, {key: keys[1], sourceHash: 'valid'});
  assert.ok(reader.read(keys).get(keys[1]).error, '옛 손상을 새 정상 줄로 숨기지 않는다');
  const rows = buildHumanBrief(f.snapshot().center, f.home);
  assert.equal(rows.get(key).error, null);assert.ok(rows.get(keys[1]).error);
  assert.equal(rows.get(keys[2]).error, null);
  reader.read([key]);assert.equal(reader.info().streams, 1, '현재 조회 대상만 보관');
});

test('업무 요약은 공급된 전체 이력을 재사용하고 없는 이력은 원본에서 읽는다', () => {
  const f = dashboardFixture({count: 2}), works = f.works.list(), cards = f.cards.list();
  const before = operationsFlowSummaries(f.home, works, {cards});
  const heads = cards.map(({history, body, ...head}) => head);
  const after = operationsFlowSummaries(f.home, works, {cards: heads});
  for (const result of [before, after]) for (const value of result.values()) delete value.timing.elapsedMs;
  assert.deepEqual(before, after);
  const failed = operationsFlowSummaries(f.home, works, {cards,
    get decisions() {throw new Error('결정 조회 실패');}});
  assert.equal(failed.get(works[0].key).followup.state, 'unknown');
  assert.match(failed.get(works[0].key).followup.next, /후속 근거 조회 실패/);
});

// 변경 전의 전체 filter·답장 연결 절차로 별도 계산해 우편의 연결과 순서를 대조한다.
function originalLetters(work, entries, cards) {
  const sends = entries.filter(e => e.kind === 'send'), identity = taskIdentity(cards);
  const keys = new Set(work.executions.map(e => e.key));
  const refs = new Map();
  for (const e of sends) for (const ref of [e.mailId, e.digest].filter(Boolean)) {
    if (!refs.has(ref)) refs.set(ref, []);refs.get(ref).push(e);
  }
  const selected = new Set(sends.filter(e => e.workKey === work.key
    || !e.workKey && keys.has(identity.resolve(e.taskId, e.executionKey).key)
    || work.mailRefs.some(ref => e.mailId === ref || e.digest === ref)));
  const queue = [...selected];
  for (let i = 0; i < queue.length; i++) for (const e of sends) {
    const parents = refs.get(e.replyTo);
    if (parents?.length !== 1 || parents[0] !== queue[i] || e.workKey && e.workKey !== work.key) continue;
    if (!selected.has(e)) {selected.add(e);queue.push(e);}
  }
  const projected = mailboxLetters(entries), byEntry = new Map(sends.map((e, i) => [e, projected[i]]));
  return [...selected].map(e => byEntry.get(e)).reverse();
}

test('업무 우편 색인은 중복 ID·별칭·인계·답장 순서와 다른 업무 경계를 보존한다', () => {
  const cards = [{key: 'r/a', id: 'a'}, {key: 'r/b', id: 'b'}, {key: 'other/b', id: 'b'}];
  const entries = [
    {kind: 'send', mailId: 'reply', replyTo: 'root', by: 'next', role: 'boss'},
    {kind: 'send', mailId: 'root', taskId: 'a', by: 'boss', role: 'worker', expectReply: true},
    {kind: 'send', mailId: 'duplicate-1', digest: 'same', workKey: 'r/work'},
    {kind: 'send', mailId: 'duplicate-2', digest: 'same', executionKey: 'r/b'},
    {kind: 'send', mailId: 'ambiguous-reply', replyTo: 'same'},
    {kind: 'handover', phase: 'transferred', handoverId: 'h', from: 'worker', to: 'next', taskIds: ['a']},
    {kind: 'send', mailId: 'outside', replyTo: 'root', workKey: 'other/work'},
    {kind: 'send', mailId: 'short-ambiguous', taskId: 'b'},
    {kind: 'send', mailId: 'grandchild', replyTo: 'reply'},
  ];
  const read = createWorkLettersReader(entries, cards);
  for (const mailRefs of [[], ['same'], [null], [undefined]]) {
    const work = {key: 'r/work', executions: [{key: 'r/a'}], mailRefs};
    assert.deepEqual(read(work), originalLetters(work, entries, cards));
    const mutable = read(work);mutable[0].replyRecipients.push('changed');
    assert.deepEqual(workLetters(work, entries, cards), originalLetters(work, entries, cards));
  }
  const duplicate = entries.concat({...entries[1]});
  assert.throws(() => createWorkLettersReader(duplicate, cards), /중복 mailId/);
  assert.throws(() => originalLetters({key: 'r/work', executions: [], mailRefs: []}, duplicate, cards),
    /중복 mailId/);
});
