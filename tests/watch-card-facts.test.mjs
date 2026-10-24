import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendStream} from '../src/storage.mjs';
import {CardStore} from '../src/card-store.mjs';
import {createWatchStoreReaders} from '../src/watch-store-cache.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {endedExecutionKeys} from '../src/watch-supervisor.mjs';
import {planStaleNotices} from '../src/watch-stale-notice.mjs';

const time = year => `${year}-01-01T00:00:00.000Z`;
const withoutHistory = value => JSON.parse(JSON.stringify(value, (key, item) =>
  ['history', 'watchHistorySummary'].includes(key) ? undefined : item));
const normalize = cards => cards.map(c => ({...c, history:c.history ?? []}));
const observe = (cards, doneAt, entries = []) => {
  const ledger = [{kind:'send', role:'fixture-worker', taskId:'card', t:time(1950)},
    {kind:'done', role:'fixture-worker', taskId:'card', result:'ok', t:doneAt}, ...entries];
  const input = {cards, entries:ledger, now:Date.parse(time(2100)), liveSessions:new Set()};
  return {center:withoutHistory(buildCardCenter({...input, cards:normalize(cards), tree:[]})),
    ended:[...endedExecutionKeys(input)].sort(), stale:planStaleNotices(input)};
};

test('원래 인접 전환·역전/무효 시각·질문 순서·닫힘 뒤 재개 판정이 전체 이력과 같다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-card-facts-'));
  const store = new CardStore(home), readers = createWatchStoreReaders(home);
  const patches = [
    {status:'assigned', at:time(1960), noteKind:'question'},
    {status:'ready', at:time(2020), noteKind:'answer'},
    {status:'assigned', at:time(2010), noteKind:'question'},
    {status:'assigned', at:time(2050), noteKind:'progress'},
    {status:'assigned', role:'fixture-next', at:'invalid'},
    {status:'assigned', role:'fixture-worker', at:time(1940)},
    {status:'done', at:time(2020)},
    {status:'hold', at:time(2030), noteKind:'answer'},
    {status:'draft', at:time(2010), noteKind:'question'},
    {status:'assigned', at:time(2015), noteKind:'answer'},
    {status:'assigned', at:time(2015), noteKind:'question'},
  ];
  let previous = null, before = null;
  for (const [index, patch] of patches.entries()) {
    appendStream(home, 'cards/r/card/events.jsonl', {key:'r/card', repo:'r', id:'card',
      role:'fixture-worker', revision:index+1, ...patch});
    const actual = readers.cards.read(), expected = store.listWatch();
    if (previous) assert.equal(JSON.stringify(previous), before, '이전 수집의 요약을 바꾸지 않음');
    assert.ok(actual.every(card => !Object.hasOwn(card, 'history')));
    for (const doneAt of [time(1930), time(1965), time(2015), time(2025), 'invalid']) {
      assert.deepEqual(observe(actual, doneAt), observe(expected, doneAt), `${index+1} ${doneAt}`);
    }
    const cold = createWatchStoreReaders(home).cards.read();
    assert.deepEqual(cold, actual, '새 프로세스용 첫 재생과 증분 요약이 같음');
    if (index === 1) {
      const stripped = expected.map(({history, ...card}) => card);
      assert.notDeepEqual(observe(stripped, time(2015)), observe(expected, time(2015)),
        '이력이 실제 판정을 바꾸는 입력');
    }
    previous = actual;before = JSON.stringify(previous);
  }
});
