import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {createLedgerArraySweep} from '../src/watch-sweep.mjs';

const at = '2026-01-01T00:00:00Z';
const homeOf = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-sweep-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');return home;
};
const events = n => Array.from({length: n}, (_, i) => {
  if (i % 7 === 0) return {kind: 'watch-cycle', by: 'watch', pid: 1, t: at};
  if (i % 5 === 0) return {kind: 'done', role: 'w', taskId: 't1', result: i % 2 ? 'ok' : 'failed', t: at}; // 첫 완료만 인정
  if (i % 3 === 0) return {kind: 'start', role: 'w', session: 'kadan-w', panePid: 1 + (i % 4), t: at};
  return {kind: 'send', mailId: `m${i}`, role: 'w', by: 'lead', taskId: 't1', roleInstructions: {status: 'x'}, t: at};
});
const sweepOf = (reader, over = {}) => createLedgerArraySweep({access: {...reader.sweepAccess, ...over}, chunkRows: 7});

test('증분으로 이어 붙인 배열은 모든 시점에서 처음부터 흘려 읽은 지문과 같다', async () => {
  const home = homeOf(), reader = createWatchMailReader(home);
  for (const [index, event] of events(60).entries()) {
    appendLedger(event, home);
    reader.readEntries();
    if (index % 6 === 0) {
      const result = await sweepOf(reader).full();
      assert.equal(result.status, 'match', `이벤트 ${index + 1}: ${JSON.stringify(result)}`);
      assert.deepEqual(sweepOf(reader).light().mismatches, []);
    }
  }
});

test('들고 있는 배열이 원본과 달라지면 차이로 잡고, 교체(초기화) 뒤에는 다시 일치한다', async () => {
  const home = homeOf(), reader = createWatchMailReader(home);
  for (const event of events(30)) appendLedger(event, home);
  const entries = reader.readEntries();
  // 증분 상태가 한 건 어긋난 것처럼 보이게 한다(내용 하나가 바뀐 복사 배열). 같은 상태는 같은 배열로 돌려준다.
  const real = reader.sweepAccess.peek();
  const tampered = {...real, entries: real.entries.map((entry, index) => index === 5 ? {...entry, role: 'tampered'} : entry)};
  const sweep = sweepOf(reader, {peek: () => tampered});
  const found = await sweep.full();
  assert.equal(found.status, 'diff');
  assert.equal(found.diffs[0].key, 'ledger-array');
  assert.match(found.diffs[0].detail, /배열 \d+건/u);
  reader.resetIncremental();
  const rebuilt = reader.readEntries();
  assert.notStrictEqual(rebuilt, entries);
  assert.deepEqual(rebuilt, entries);                       // 같은 내용으로 다시 만들어진다
  assert.equal((await sweepOf(reader).full()).status, 'match');
});

test('비교 도중 원본이 바뀌면 차이로 세지 않고 moved로 돌려준다, 원본 읽기 실패는 error다', async () => {
  const home = homeOf(), reader = createWatchMailReader(home);
  for (const event of events(20)) appendLedger(event, home);
  reader.readEntries();
  let calls = 0;
  const moving = sweepOf(reader, {info: () => {
    const real = reader.sweepAccess.info();
    return ++calls > 2 ? {...real, generation: 'changed'} : real;
  }});
  assert.equal((await moving.full()).status, 'moved');
  const broken = sweepOf(reader, {openSnapshot: () => ({readChunk: () => { throw new Error('원본 검증 실패'); }, close() {}})});
  const failed = await broken.full();
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /원본 검증 실패/u);
});

test('가벼운 대조는 원본 총건수·커서와 어긋난 값만 불일치로 알린다', () => {
  const home = homeOf(), reader = createWatchMailReader(home);
  for (const event of events(12)) appendLedger(event, home);
  reader.readEntries();
  const sweep = sweepOf(reader);
  const light = sweep.light();
  assert.ok(light.items.length >= 2);
  assert.deepEqual(light.mismatches, []);
  const skewed = sweepOf(reader, {total: () => 999});
  assert.equal(skewed.light().mismatches[0].name, '배열 건수 대 원본 총건수');
});

// B 조율 질문: 트리거를 끄고 과거 events 한 줄만 고친 손상을 전체 대조가 잡는가.
async function tamperOldEvent(home, field = 'role') {
  const {DatabaseSync} = await import('node:sqlite');
  const {storagePath} = await import('../src/storage.mjs');
  const db = new DatabaseSync(storagePath(home));
  try {
    db.exec('DROP TRIGGER events_no_update');
    const changed = db.prepare(`UPDATE events SET payload=json_set(payload,'$.${field}','tampered')
      WHERE rowid=(SELECT min(rowid) FROM events WHERE json_extract(payload,'$.kind')='send')`).run().changes;
    assert.equal(changed, 1);
  } finally { db.close(); }
}

test('실행 중에 과거 events를 트리거 없이 고치면 전체 대조가 diff로 잡는다(조용히 match하지 않는다)', async () => {
  const home = homeOf(), reader = createWatchMailReader(home);
  for (const event of events(20)) appendLedger(event, home);
  reader.readEntries();
  assert.equal((await sweepOf(reader).full()).status, 'match');
  await tamperOldEvent(home);
  const result = await sweepOf(reader).full();
  assert.notEqual(result.status, 'match', JSON.stringify(result));
  assert.equal(result.status, 'diff');
});

test('시작(첫 적재) 전에 고쳐진 과거 events는 증분 상태와 원본이 같은 값을 읽어 전체 대조만으로는 알 수 없다', async () => {
  const home = homeOf();
  for (const event of events(20)) appendLedger(event, home);
  await tamperOldEvent(home, 'preview'); // 스키마 검증을 통과하는 값 변경(검증에 걸리는 변경은 조회 계층이 적재 때 던진다)
  const reader = createWatchMailReader(home);
  reader.readEntries();
  const result = await sweepOf(reader).full();
  // 한계를 시험으로 고정한다: 이 경우를 잡으려면 불변 체크섬(별도 검증)이 필요하다.
  assert.equal(result.status, 'match');
});

test('F5: 전체 재생은 하나의 고정 snapshot에서 읽는다 — 도중에 원본이 바뀌어도 섞지 않고, 바뀐 내용은 다음 대조가 잡는다', async () => {
  const home = homeOf(), reader = createWatchMailReader(home);
  for (const event of events(30)) appendLedger(event, home);
  const entries = reader.readEntries();
  let yields = 0, tampered = false;
  const arrayYields = Math.ceil(entries.length / 4);
  const sweep = createLedgerArraySweep({access: reader.sweepAccess, chunkRows: 4, yieldNow: async () => {
    // 원본 조각을 읽기 시작한 뒤(배열 지문 조각 수 + 1번째 양보)에 다른 연결이 과거 행을 고친다.
    if (++yields === arrayYields + 1 && !tampered) { tampered = true;await tamperOldEvent(home, 'preview'); }
  }});
  const during = await sweep.full();
  assert.ok(tampered);
  assert.equal(during.status, 'match', JSON.stringify(during));   // 고정 snapshot이라 도중 변경이 섞이지 않는다
  assert.equal(during.arrayDigest, during.sourceDigest);
  const next = await sweepOf(reader).full();                       // 새 snapshot은 바뀐 내용을 본다
  assert.equal(next.status, 'diff');
  assert.ok(next.arrayDigest && next.sourceDigest && next.arrayDigest !== next.sourceDigest);
  assert.equal(typeof next.position, 'number');
});

test('F5: 대조 도중 새 사건이 붙어도(실제 감시처럼 배열이 계속 새로 만들어져도) 어긋남은 moved가 아니라 diff로 잡힌다', async () => {
  const home = homeOf(), reader = createWatchMailReader(home);
  for (const event of events(24)) appendLedger(event, home);
  reader.readEntries();
  const real = reader.sweepAccess.peek();
  const tampered = {...real, entries: real.entries.map((entry, index) => index === 3 ? {...entry, role: 'tampered'} : entry)};
  let appended = 0;
  const sweep = createLedgerArraySweep({access: {...reader.sweepAccess, peek: () => tampered}, chunkRows: 5, yieldNow: async () => {
    if (appended++ < 2) { appendLedger({kind: 'send', mailId: `live-${appended}`, role: 'w', by: 'lead', taskId: 't1', t: at}, home);reader.readEntries(); }
  }});
  const result = await sweep.full();
  assert.equal(result.status, 'diff', JSON.stringify(result));
});
