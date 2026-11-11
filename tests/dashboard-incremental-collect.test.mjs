// 수집의 버전 확인·설명 입력 읽기가 "새 사건만 이어 읽기"로 바뀐 뒤에도 결과가 매번 전체를 읽던 때와 같은지 본다.
// 기준(오라클)은 바꾸기 전 구현을 이 파일에 그대로 옮긴 것이다. 새 모듈의 전체 읽기 갈래를 기준으로 쓰지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {appendStream, createDatabase, databaseIdentity, storageMode, storagePath, storageSnapshot,
  storageVersion, transaction, writeStorageMarker} from '../src/storage.mjs';
import {cardFilesFingerprint, DERIVED_MAX_AGE_MS, wallCache} from '../src/wall-snapshot-cache.mjs';
import {createDashboardDataVersions, dashboardDataVersions,
  dashboardDataVersionsInfo} from '../src/dashboard-data-versions.mjs';
import {createDashboardBriefReader} from '../src/dashboard-brief-reader.mjs';
import {humanBriefReaderInfo} from '../src/human-brief.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {loadWallSnapshot} from '../src/commands/tree-wall.mjs';
import {floor} from '../src/floor.mjs';

// ── 기준 1: 바꾸기 전 dashboardDataVersions (origin/main baacb9e의 src/dashboard-data-versions.mjs 그대로)
function oracleVersions(home) {
  if (storageMode(home) === 'none') return {all: null, cards: null, works: null};
  return storageSnapshot(home, db => {
    const identity = `${path.resolve(home)}|${databaseIdentity(home)}`;
    const hashes = {cards: createHash('sha256'), works: createHash('sha256')};
    const query = db.prepare('SELECT stream,seq FROM heads WHERE stream GLOB ? ORDER BY stream');
    for (const kind of ['cards', 'works']) {
      for (const row of query.iterate(`${kind}/*/events.jsonl`)) hashes[kind].update(JSON.stringify(row));
    }
    const files = cardFilesFingerprint(home);
    return {all: `${identity}|${storageVersion(home)}|${files}`,
      cards: `${identity}|${hashes.cards.digest('hex')}|${files}`,
      works: `${identity}|${hashes.works.digest('hex')}`};
  });
}

// ── 기준 2: 바꾸기 전 createDashboardBriefReader (origin/main baacb9e의 src/dashboard-brief-reader.mjs 그대로)
function createOracleBriefReader(home) {
  let identity = null, cached = new Map();
  const stats = {rows: 0};
  return {
    read(keys) {
      try {
        if (storageMode(home) === 'none') {cached.clear();identity = null;return new Map();}
        return transaction(home, db => {
          const currentIdentity = databaseIdentity(home);
          const streams = keys.map(key => `cards/${key}/briefs.jsonl`);
          const heads = db.prepare(`SELECT h.stream,h.seq,h.payload,e.payload AS original
            FROM json_each(?) wanted JOIN heads h ON h.stream=wanted.value
            LEFT JOIN events e ON e.stream=h.stream AND e.seq=h.seq`).all(JSON.stringify(streams));
          if (identity !== currentIdentity || heads.some(h => h.seq < (cached.get(h.stream)?.seq ?? 0))) {
            cached = new Map();
          }
          const next = new Map(), changed = [];
          for (const head of heads) {
            const previous = cached.get(head.stream);
            if (previous?.seq === head.seq && previous.payload === head.payload
                && head.payload === head.original) {next.set(head.stream, previous);continue;}
            const reuse = previous && previous.seq < head.seq;
            next.set(head.stream, {seq: reuse ? previous.seq : 0, payload: head.payload,
              error: head.payload !== head.original || (reuse && previous.error), brief: null});
            changed.push({stream: head.stream, seq: reuse ? previous.seq : 0});
          }
          if (changed.length) {
            const query = db.prepare(`SELECT e.stream,e.seq,e.payload FROM json_each(?) c
              JOIN events e ON e.stream=json_extract(c.value,'$.stream')
                AND e.seq>json_extract(c.value,'$.seq') ORDER BY e.stream,e.seq`);
            for (const row of query.iterate(JSON.stringify(changed))) {
              const state = next.get(row.stream), value = JSON.parse(row.payload);
              state.error ||= row.seq !== state.seq + 1 || value?.key !== row.stream.slice(6, -13)
                || !value?.sourceHash;
              state.seq = row.seq;state.brief = value;stats.rows++;
            }
          }
          for (const head of heads) {
            const state = next.get(head.stream);
            state.error ||= state.seq !== head.seq || !state.brief;
          }
          if (currentIdentity !== databaseIdentity(home)) throw new Error('조회 중 저장소 파일 교체');
          cached = next;identity = currentIdentity;
          return new Map(heads.map(h => {
            const value = next.get(h.stream);
            return [h.stream.slice(6, -13), {brief: value.error ? null : value.brief,
              error: value.error ? '설명 기록을 읽을 수 없습니다' : null}];
          }));
        }, {readOnly: true});
      } catch (error) {cached.clear();identity = null;throw error;}
    },
    info: () => ({...stats, streams: cached.size}),
  };
}

// ── 도우미
function newHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-incr-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  return home;
}
// 씨앗이 같으면 같은 순서가 나오는 난수(실패를 다시 만들 수 있게).
function random(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
function shuffled(rand, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));[out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const delta = (after, before) => Object.fromEntries(Object.keys(after).map(k => [k, after[k] - before[k]]));
const clock = (start = 1_000_000) => {const c = () => c.t;c.t = start;return c;};

// 한글, GLOB 특수문자, 그리고 UTF-8 바이트 순과 UTF-16 단위 순이 갈리는 쌍(보충 평면 글자 U+20000 대 U+FF21·U+F900).
const KEYS = ['demo/card-1', 'demo/card-2', '데모/카드-가', '데모/카드-나', 'z/\u{20000}', 'z/Ａ', 'z/豈',
  'a-b/c_d', 'demo/[x]', 'demo/a*', 'demo/a?', 'demo/card-10'];
// 카드·업무 패턴에 걸릴 듯 말 듯한 이름과 다른 영역 흐름.
const OTHER = ['cards/events.jsonl', 'cards//events.jsonl', 'cardsx/a/b/events.jsonl', 'cards/a/b/c/events.jsonl',
  'cards/a/b/events.jsonl.bak', 'works/events.jsonl', 'works//events.jsonl', 'Cards/a/b/events.jsonl',
  'system/events.jsonl', 'mail/events.jsonl', 'tasks/events.jsonl', 'ledger.jsonl', 'decisions/events.jsonl'];
const VERSION_STREAMS = [...KEYS.flatMap(key => [`cards/${key}/events.jsonl`, `works/${key}/events.jsonl`,
  `cards/${key}/briefs.jsonl`]), ...OTHER];

test('이 시험의 흐름 이름은 JS 기본 정렬과 SQLite 바이트 순이 실제로 갈린다', () => {
  const names = ['cards/z/\u{20000}/events.jsonl', 'cards/z/Ａ/events.jsonl'];
  const utf16 = [...names].sort(), bytes = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.notDeepEqual(utf16, bytes);
  const home = newHome();
  for (const name of names) appendStream(home, name, {n: 1});
  const stored = transaction(home, db => db.prepare('SELECT stream FROM heads ORDER BY stream').all()
    .map(row => row.stream), {readOnly: true});
  assert.deepEqual(stored, bytes);
});

test('버전 세 문자열은 무작위로 사건을 덧붙이는 동안 매번 전체를 읽던 구현과 글자까지 같다', () => {
  for (const seed of [11, 2026, 77777]) {
    const rand = random(seed), home = newHome(), now = clock();
    const reader = createDashboardDataVersions(home, {now});
    let sweeps = 0;
    for (let step = 0; step < 220; step++) {
      const appends = Math.floor(rand() * 4);
      for (let i = 0; i < appends; i++) appendStream(home, pick(rand, VERSION_STREAMS), {step, i});
      if (rand() < 0.03) {now.t += DERIVED_MAX_AGE_MS;sweeps++;}
      const actual = reader.read(), expected = oracleVersions(home);
      for (const name of ['all', 'cards', 'works']) {
        assert.equal(actual[name], expected[name], `씨앗 ${seed} 단계 ${step} ${name}`);
      }
    }
    // 이어 읽기 갈래가 실제로 쓰였다: 전체 읽기는 처음 한 번과 10분 안전망 때뿐이다.
    assert.equal(reader.info().full, 1 + sweeps, `씨앗 ${seed}`);
  }
});

test('버전 확인은 변경이 없으면 heads·events를 0줄 읽고, 바뀌면 그 흐름 몫만 읽는다', () => {
  const home = newHome(), reader = createDashboardDataVersions(home, {now: clock()});
  for (const key of KEYS) {
    appendStream(home, `cards/${key}/events.jsonl`, {revision: 1});
    appendStream(home, `works/${key}/events.jsonl`, {revision: 1});
    appendStream(home, `cards/${key}/briefs.jsonl`, {key, sourceHash: 'a'});
  }
  const first = reader.read();
  assert.deepEqual(reader.info(), {heads: KEYS.length * 2, events: 0, full: 1, streams: KEYS.length * 2});
  let before = reader.info();
  assert.deepEqual(reader.read(), first);
  assert.deepEqual(delta(reader.info(), before), {heads: 0, events: 0, full: 0, streams: 0}, '변경 없음');

  before = reader.info();
  appendStream(home, 'cards/demo/card-1/events.jsonl', {revision: 2});
  const card = reader.read();
  assert.deepEqual(delta(reader.info(), before), {heads: 1, events: 1, full: 0, streams: 0}, '카드 사건 1건');
  assert.notEqual(card.cards, first.cards);assert.equal(card.works, first.works);

  before = reader.info();
  appendStream(home, 'works/demo/card-1/events.jsonl', {revision: 2});
  const work = reader.read();
  assert.deepEqual(delta(reader.info(), before), {heads: 1, events: 1, full: 0, streams: 0}, '업무 사건 1건');
  assert.equal(work.cards, card.cards);assert.notEqual(work.works, card.works);

  before = reader.info();
  appendStream(home, 'system/events.jsonl', {kind: 'watch-cycle'});
  appendStream(home, 'cards/demo/card-1/briefs.jsonl', {key: 'demo/card-1', sourceHash: 'b'});
  const other = reader.read();
  assert.deepEqual(delta(reader.info(), before), {heads: 0, events: 2, full: 0, streams: 0}, '시스템·설명 사건');
  assert.notEqual(other.all, work.all);assert.equal(other.cards, work.cards);assert.equal(other.works, work.works);

  before = reader.info();
  appendStream(home, 'cards/demo/new-card/events.jsonl', {revision: 1});
  assert.deepEqual(reader.read(), oracleVersions(home));
  assert.deepEqual(delta(reader.info(), before), {heads: 1, events: 1, full: 0, streams: 1}, '새 카드');
});

test('설명 입력은 무작위 사건·무작위 key 묶음에서 바꾸기 전 판독기와 값·순서가 같다', () => {
  const bad = key => [null, {key: 'other/key', sourceHash: 'x'}, {key}];
  for (const seed of [5, 404, 31337]) {
    const rand = random(seed), home = newHome(), now = clock();
    const reader = createDashboardBriefReader(home, {now}), oracle = createOracleBriefReader(home);
    let sweeps = 0, calls = 0;
    for (let step = 0; step < 220; step++) {
      const appends = Math.floor(rand() * 4);
      for (let i = 0; i < appends; i++) {
        const key = pick(rand, KEYS), roll = rand();
        if (roll < 0.55) {
          appendStream(home, `cards/${key}/briefs.jsonl`, rand() < 0.1 ? pick(rand, bad(key))
            : {key, sourceHash: `h${step}`, title: `설명 ${step}-${i}`});
        } else appendStream(home, pick(rand, VERSION_STREAMS.filter(s => !s.endsWith('/briefs.jsonl'))), {step, i});
      }
      if (rand() < 0.03) {now.t += DERIVED_MAX_AGE_MS;sweeps++;}
      const keys = rand() < 0.6 ? shuffled(rand, KEYS)
        : shuffled(rand, KEYS).slice(0, Math.floor(rand() * (KEYS.length + 1)));
      const actual = [...reader.read(keys)], expected = [...oracle.read(keys)];
      assert.deepEqual(actual, expected, `씨앗 ${seed} 단계 ${step} (함께 돌린 기준)`);
      // 기억이 없는 새 기준 판독기(전부 처음부터 검증)와도 같다.
      assert.deepEqual(actual, [...createOracleBriefReader(home).read(keys)], `씨앗 ${seed} 단계 ${step} (새 기준)`);
      assert.equal(reader.info().streams, oracle.info().streams, `씨앗 ${seed} 단계 ${step} 보관 수`);
      calls++;
    }
    assert.ok(reader.info().full <= 1 + sweeps, `씨앗 ${seed}: 전체 확인 ${reader.info().full}회`);
    assert.ok(reader.info().asked < calls * KEYS.length / 2, `씨앗 ${seed}: heads에 물은 흐름 ${reader.info().asked}`);
  }
});

test('설명 입력은 변경이 없으면 0줄, 바뀌면 그 흐름만 읽고, 흐름 없는 key를 다시 묻지 않는다', () => {
  const home = newHome(), reader = createDashboardBriefReader(home, {now: clock()});
  const withBrief = KEYS.slice(0, 8), keys = KEYS; // 뒤 4개는 설명 흐름이 없다
  for (const key of KEYS) appendStream(home, `cards/${key}/events.jsonl`, {revision: 1});
  for (const key of withBrief) appendStream(home, `cards/${key}/briefs.jsonl`, {key, sourceHash: 'a', title: '첫'});
  assert.equal(reader.read(keys).size, 8);
  assert.deepEqual(reader.info(), {rows: 8, asked: 12, heads: 8, events: 0, full: 1, streams: 8});

  let before = reader.info();
  assert.equal(reader.read(keys).size, 8);
  assert.deepEqual(delta(reader.info(), before), {rows: 0, asked: 0, heads: 0, events: 0, full: 0, streams: 0},
    '변경 없음: 흐름 없는 key 4개도 다시 묻지 않는다');

  before = reader.info();
  appendStream(home, 'system/events.jsonl', {kind: 'watch-cycle'});
  appendStream(home, 'cards/demo/card-1/events.jsonl', {revision: 2});
  appendStream(home, 'works/demo/card-1/events.jsonl', {revision: 1});
  reader.read(keys);
  assert.deepEqual(delta(reader.info(), before), {rows: 0, asked: 0, heads: 0, events: 3, full: 0, streams: 0},
    '시스템·카드·업무 사건: 설명 줄 0');

  before = reader.info();
  const key = withBrief[2];
  appendStream(home, `cards/${key}/briefs.jsonl`, {key, sourceHash: 'b', title: '둘째'});
  assert.equal(reader.read(keys).get(key).brief.title, '둘째');
  assert.deepEqual(delta(reader.info(), before), {rows: 1, asked: 1, heads: 1, events: 1, full: 0, streams: 0},
    '설명 사건 1건');

  // (다) 흐름이 없던 key에 설명이 생기면 새 사건으로 잡힌다.
  before = reader.info();
  const late = KEYS[10];
  assert.equal(reader.read(keys).has(late), false);
  appendStream(home, `cards/${late}/briefs.jsonl`, {key: late, sourceHash: 'c', title: '늦게 생김'});
  assert.equal(reader.read(keys).get(late).brief.title, '늦게 생김');
  assert.deepEqual(delta(reader.info(), before), {rows: 1, asked: 1, heads: 1, events: 1, full: 0, streams: 1});
});

test('한 판독기를 key 묶음이 다른 호출이 함께 써도, 요청에 없던 흐름의 변경을 낡은 값으로 돌려주지 않는다', () => {
  const home = newHome(), reader = createDashboardBriefReader(home, {now: clock()});
  const [a, b, c] = KEYS;
  for (const key of [a, b]) appendStream(home, `cards/${key}/briefs.jsonl`, {key, sourceHash: '1', title: '처음'});
  assert.equal(reader.read([a, b, c]).get(b).brief.title, '처음');
  // b가 바뀌고 c가 생긴 뒤의 호출은 a만 요청한다(사건 번호는 이 호출에서 앞으로 간다).
  appendStream(home, `cards/${b}/briefs.jsonl`, {key: b, sourceHash: '2', title: '바뀜'});
  appendStream(home, `cards/${c}/briefs.jsonl`, {key: c, sourceHash: '2', title: '생김'});
  assert.deepEqual([...reader.read([a]).keys()], [a]);
  assert.equal(reader.info().streams, 1, '요청한 key만 보관한다');
  const next = reader.read([a, b, c]);
  assert.equal(next.get(b).brief.title, '바뀜');assert.equal(next.get(c).brief.title, '생김');
  assert.deepEqual([...next], [...createOracleBriefReader(home).read([a, b, c])]);
});

// DB 파일을 통째로 바꾼다(새 파일 = 새 식별값).
function replaceDatabase(home, from) {
  fs.renameSync(storagePath(home), path.join(home, `previous-${Date.now()}-${Math.random()}.sqlite`));
  fs.copyFileSync(storagePath(from), storagePath(home));
}
// 같은 파일에 내용만 덮어쓴다(식별값은 그대로).
function overwriteDatabase(home, from) {
  // 쓰기 연결을 열었다 닫아 WAL을 비운다(읽기 연결이 남긴 빈 -wal·-shm이 덮어쓴 내용과 섞이지 않게).
  const db = new DatabaseSync(storagePath(home));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
  for (const suffix of ['-wal', '-shm']) {
    assert.equal(fs.existsSync(storagePath(home) + suffix), false, `덮어쓰기 전 ${suffix} 없음`);
  }
  const identity = databaseIdentity(home);
  fs.writeFileSync(storagePath(home), fs.readFileSync(storagePath(from)));
  assert.equal(databaseIdentity(home), identity, '같은 파일에 덮어썼다');
}

test('DB 파일이 교체되거나 사건 번호가 뒤로 가면 기억을 버리고 전체를 다시 읽는다', () => {
  const a = newHome(), b = newHome(), c = newHome();
  const [k1, k2] = KEYS;
  // a와 b는 사건 수(마지막 사건 번호)가 같고 내용이 다르다. c는 사건이 더 적다.
  appendStream(a, `cards/${k1}/events.jsonl`, {revision: 1});
  appendStream(a, `cards/${k1}/events.jsonl`, {revision: 2});
  appendStream(a, `cards/${k1}/briefs.jsonl`, {key: k1, sourceHash: 'a', title: '이전'});
  appendStream(b, `cards/${k1}/events.jsonl`, {revision: 1});
  appendStream(b, `cards/${k2}/events.jsonl`, {revision: 1});
  appendStream(b, `cards/${k1}/briefs.jsonl`, {key: k1, sourceHash: 'b', title: '복원'});
  appendStream(c, `cards/${k2}/briefs.jsonl`, {key: k2, sourceHash: 'c', title: '더 짧은 원장'});
  assert.equal(storageVersion(a), storageVersion(b));
  const versions = createDashboardDataVersions(a, {now: clock()});
  const briefs = createDashboardBriefReader(a, {now: clock()});
  const before = versions.read();
  assert.equal(briefs.read([k1, k2]).get(k1).brief.title, '이전');

  replaceDatabase(a, b);
  const replaced = versions.read();
  assert.deepEqual(replaced, oracleVersions(a));assert.notEqual(replaced.cards, before.cards);
  assert.equal(versions.info().full, 2);
  assert.equal(briefs.read([k1, k2]).get(k1).brief.title, '복원');
  assert.equal(briefs.info().full, 2);

  overwriteDatabase(a, c);
  assert.ok(storageVersion(a) < storageVersion(b));
  assert.deepEqual(versions.read(), oracleVersions(a));
  assert.equal(versions.info().full, 3);
  const shorter = briefs.read([k1, k2]);
  assert.deepEqual([...shorter], [...createOracleBriefReader(a).read([k1, k2])]);
  assert.equal(shorter.has(k1), false);assert.equal(shorter.get(k2).brief.title, '더 짧은 원장');
  assert.equal(briefs.info().full, 3);
});

// 수집은 바깥 읽기 연결(storageSnapshot) 안에서 돈다. 그 안에서 판독기가 식별값을 두 번째로 잴 때 파일이 바뀌어 있게 한다.
function swapDuringRead(home, from, run) {
  const file = storagePath(home), original = fs.statSync;
  let stats = 0;
  fs.statSync = function (target, ...args) {
    if (target === file && ++stats === 2) replaceDatabase(home, from);
    return original.call(this, target, ...args);
  };
  try {
    assert.throws(() => storageSnapshot(home, run), /조회 중 저장소 파일 교체/);
  } finally {fs.statSync = original;}
  return stats;
}

test('바깥 읽기 연결 안에서 읽는 도중 파일이 교체되면 재시도 없이 오류로 끝내고 기억을 버린다', () => {
  const [k1] = KEYS;
  const setup = () => {
    const a = newHome(), b = newHome();
    appendStream(a, `cards/${k1}/events.jsonl`, {revision: 1});
    appendStream(a, `cards/${k1}/briefs.jsonl`, {key: k1, sourceHash: 'a', title: '이전'});
    appendStream(b, `works/${k1}/events.jsonl`, {revision: 1});
    appendStream(b, `cards/${k1}/briefs.jsonl`, {key: k1, sourceHash: 'b', title: '복원'});
    return {a, b};
  };
  {
    const {a, b} = setup(), reader = createDashboardDataVersions(a, {now: clock()});
    reader.read();
    appendStream(a, `cards/${k1}/events.jsonl`, {revision: 2});
    const before = reader.info();
    // 식별값을 잰 횟수 2 = 읽기 전·후 한 번씩. 같은 연결로 다시 읽지 않았다.
    assert.equal(swapDuringRead(a, b, () => reader.read()), 2);
    assert.equal(reader.info().streams, 0, '기억을 버렸다');
    assert.equal(reader.info().full, before.full, '오류로 끝난 호출은 전체 읽기를 다시 하지 않았다');
    assert.deepEqual(reader.read(), oracleVersions(a));
    assert.equal(reader.info().full, before.full + 1, '다음 호출이 전체 읽기');
  }
  {
    const {a, b} = setup(), reader = createDashboardBriefReader(a, {now: clock()});
    assert.equal(reader.read([k1]).get(k1).brief.title, '이전');
    const before = reader.info();
    assert.equal(swapDuringRead(a, b, () => reader.read([k1])), 2);
    assert.equal(reader.info().streams, 0, '기억을 버렸다');
    assert.equal(reader.info().full, before.full, '오류로 끝난 호출은 전체 확인을 다시 하지 않았다');
    assert.equal(reader.read([k1]).get(k1).brief.title, '복원');
    assert.equal(reader.info().full, before.full + 1, '다음 호출이 전체 확인');
  }
});

test('저장소가 없는 홈은 지금처럼 빈 결과이고, 저장소가 생기면 처음부터 읽는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-incr-none-'));
  const versions = createDashboardDataVersions(home), briefs = createDashboardBriefReader(home);
  assert.deepEqual(versions.read(), {all: null, cards: null, works: null});
  assert.deepEqual(versions.read(), oracleVersions(home));
  assert.deepEqual([...briefs.read(KEYS)], []);
  const [k1] = KEYS;
  appendStream(home, `cards/${k1}/events.jsonl`, {revision: 1});
  appendStream(home, `cards/${k1}/briefs.jsonl`, {key: k1, sourceHash: 'a', title: '첫'});
  assert.deepEqual(versions.read(), oracleVersions(home));
  assert.equal(briefs.read(KEYS).get(k1).brief.title, '첫');
});

test('10분 안전망: 사건 없이 heads만 달라진 변경은 다음 전체 읽기 때 기준과 다시 같아진다', () => {
  const home = newHome(), now = clock(), [k1, k2] = KEYS;
  for (const key of [k1, k2]) {
    appendStream(home, `cards/${key}/events.jsonl`, {revision: 1});
    appendStream(home, `cards/${key}/events.jsonl`, {revision: 2});
    appendStream(home, `cards/${key}/briefs.jsonl`, {key, sourceHash: 'a', title: '원래'});
  }
  const versions = createDashboardDataVersions(home, {now}), briefs = createDashboardBriefReader(home, {now});
  const first = versions.read();
  assert.equal(briefs.read([k1, k2]).get(k1).error, null);
  // 코드에는 없는 길(날 SQL)로 heads만 고친다: 사건 번호는 그대로다.
  const db = new DatabaseSync(storagePath(home));
  db.prepare('UPDATE heads SET seq=1 WHERE stream=?').run(`cards/${k1}/events.jsonl`);
  db.prepare("UPDATE heads SET payload=json_set(payload,'$.title','손상') WHERE stream=?")
    .run(`cards/${k1}/briefs.jsonl`);
  db.close();
  const expected = oracleVersions(home);
  assert.notEqual(expected.cards, first.cards, '매번 전체를 읽던 구현은 바로 알아챈다');
  assert.ok(createOracleBriefReader(home).read([k1, k2]).get(k1).error);

  now.t += DERIVED_MAX_AGE_MS - 1;
  let before = versions.info();
  assert.deepEqual(versions.read(), first, '10분 전에는 기억한 값을 쓴다(알고 줄인 대조)');
  assert.deepEqual(delta(versions.info(), before), {heads: 0, events: 0, full: 0, streams: 0});
  assert.equal(briefs.read([k1, k2]).get(k1).error, null);

  now.t += 1;
  before = versions.info();
  assert.deepEqual(versions.read(), expected, '10분이 되면 전체를 다시 읽는다');
  assert.deepEqual(delta(versions.info(), before), {heads: 2, events: 0, full: 1, streams: 0});
  const swept = briefs.read([k1, k2]);
  assert.ok(swept.get(k1).error);assert.equal(swept.get(k2).error, null);
  assert.equal(briefs.info().full, 2);
  // 전체 읽기 뒤에는 다시 10분 동안 이어 읽는다.
  before = versions.info();
  versions.read();briefs.read([k1, k2]);
  assert.deepEqual(delta(versions.info(), before), {heads: 0, events: 0, full: 0, streams: 0});
  assert.equal(briefs.info().full, 2);
});

test('수집(loadWallSnapshot)을 변경 없이 다시 하면 버전 확인·설명 입력이 heads·events를 0줄 읽는다', () => {
  const f = dashboardFixture({count: 4});process.env.KADAN_HOME = f.home;
  const original = floor.list;floor.list = () => [];
  wallCache.clear();
  try {
    appendStream(f.home, 'cards/demo/card-1/briefs.jsonl', {key: 'demo/card-1', sourceHash: 'a', title: '설명'});
    const first = loadWallSnapshot();
    assert.equal(first.error, null);assert.equal(first.centerError, null);
    assert.equal(first.briefInputs.stored.get('demo/card-1').brief.title, '설명');
    const versions = dashboardDataVersionsInfo(), briefs = humanBriefReaderInfo();
    assert.equal(versions.full, 1);assert.equal(briefs.full, 1);

    const second = loadWallSnapshot();
    assert.deepEqual(delta(dashboardDataVersionsInfo(), versions), {heads: 0, events: 0, full: 0, streams: 0});
    assert.deepEqual(delta(humanBriefReaderInfo(), briefs),
      {rows: 0, asked: 0, heads: 0, events: 0, full: 0, streams: 0});
    assert.equal(second.centerKey, first.centerKey);assert.equal(second.workModelKey, first.workModelKey);
    assert.deepEqual([...second.briefInputs.stored], [...first.briefInputs.stored]);

    // 역할 없는 시스템 사건 1건: 새 사건 한 줄만 훑고 카드·업무·설명 줄은 읽지 않는다.
    appendLedger({kind: 'watch-cycle', timing: {totalMs: 3}}, f.home);
    const third = loadWallSnapshot();
    assert.deepEqual(delta(dashboardDataVersionsInfo(), versions), {heads: 0, events: 1, full: 0, streams: 0});
    assert.deepEqual(delta(humanBriefReaderInfo(), briefs),
      {rows: 0, asked: 0, heads: 0, events: 1, full: 0, streams: 0});
    assert.equal(third.centerKey, first.centerKey);assert.notEqual(third.workModelKey, first.workModelKey);
    assert.deepEqual(dashboardDataVersions(f.home), oracleVersions(f.home));
  } finally {floor.list = original;}
});
