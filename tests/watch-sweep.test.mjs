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
  const broken = sweepOf(reader, {readChunk: () => { throw new Error('원본 검증 실패'); }});
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
