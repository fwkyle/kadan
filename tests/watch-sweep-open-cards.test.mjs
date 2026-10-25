import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendStream, readStream, createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {createWatchStoreReaders} from '../src/watch-store-cache.mjs';
import {CardStore} from '../src/card-store.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {createLedgerArraySweep} from '../src/watch-sweep.mjs';

// 무작위 카드 상태 사건의 모든 prefix에서 '열린 카드 수 불변식 값 == 정식 카드 읽기(증분 캐시) 결과'를 보인다.
// (이 값만 넣은 이유: 카드의 현재 상태는 stream의 마지막 사건이라 SQL 집계와 정식 규칙이 갈릴 여지가 없다.)
const STATUSES = ['draft', 'ready', 'assigned', 'hold', 'done', 'cancelled', 'assigned'];
const rng = seed => { let a = seed >>> 0;return () => { a = Math.imul(a ^ a >>> 15, 1 | a) + 0x6D2B79F5 >>> 0;return (a ^ a >>> 14) / 4294967296 % 1; }; };
const at = n => new Date(Date.UTC(2020, 0, 1, 0, n)).toISOString();

test('열린 카드 수 불변식은 무작위 카드 사건의 모든 prefix에서 정식 카드 읽기 결과와 같다', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-open-cards-'));
    createDatabase(home);writeStorageMarker(home, 'sqlite');
    const stores = createWatchStoreReaders(home);
    const reader = createWatchMailReader(home, null, {readCards: stores.cards.read});
    const next = rng(seed);
    for (let step = 0; step < 40; step++) {
      const id = `c${Math.floor(next() * 6)}`, key = `r/${id}`, stream = `cards/${key}/events.jsonl`;
      const rows = readStream(home, stream, {optional: true});
      appendStream(home, stream, {key, id, repo: 'r', revision: rows.length + 1, at: at(step), role: 'w', workType: 'execution',
        status: STATUSES[Math.floor(next() * STATUSES.length)]});
      const value = reader.sweepAccess.openCards();
      // 정식 결과: 증분 캐시가 아닌 카드 저장소의 전체 읽기(listWatch)
      const open = new CardStore(home).listWatch().filter(card => ['assigned', 'ready', 'draft'].includes(card.status)).length;
      assert.deepEqual(value, {incremental: open, sql: open}, `seed ${seed} step ${step}`);
      const light = createLedgerArraySweep({access: reader.sweepAccess}).light();
      assert.equal(light.mismatches.some(item => item.name.startsWith('열린 카드 수')), false);
    }
  }
});

test('카드 캐시가 실제와 어긋나면 열린 카드 수 불변식이 불일치로 알린다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-open-cards-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  appendStream(home, 'cards/r/c1/events.jsonl', {key: 'r/c1', id: 'c1', repo: 'r', revision: 1, at: at(0), role: 'w', status: 'assigned'});
  const stale = [{key: 'r/c1', id: 'c1', status: 'done'}];           // 읽기 캐시가 오래된 값을 들고 있는 상황
  const reader = createWatchMailReader(home, null, {readCards: () => stale});
  const light = createLedgerArraySweep({access: reader.sweepAccess}).light();
  const item = light.mismatches.find(entry => entry.name.startsWith('열린 카드 수'));
  assert.deepEqual([item.incremental, item.sql], [0, 1]);
});
