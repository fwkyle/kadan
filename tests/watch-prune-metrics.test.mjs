import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWatch} from '../src/watch-runner.mjs';
import {runDailyHierarchyPrune} from '../src/watch-prune.mjs';
import {createWatchReplayMetrics, WATCH_METRIC_COUNT_MAX,
  WATCH_METRIC_DURATION_MAX} from '../src/watch-replay-metrics.mjs';
import {pruneHierarchy} from '../src/hierarchy-prune.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';

test('정리 성공·거절을 세고 실제 전체 읽기 입구 호출만 합산한다; 생략은 0이다', () => {
  const metrics = createWatchReplayMetrics(), records = [];
  let clock = 0;
  const args = {entries:[], now:100000, file:'fixture', metrics,
    measure:() => { clock += 12.25;return clock; }, record:row => records.push(row)};
  runDailyHierarchyPrune({...args, prune:({onFullRead}) => {
    onFullRead();onFullRead();return {file:'fixture', applied:false, removeCount:0, retainCount:1};
  }});
  assert.deepEqual(metrics.snapshot().replay.prune, {count:1, ms:12.3, fullReads:2});
  runDailyHierarchyPrune({...args, prune:() => { throw new Error('fixture locked'); }});
  assert.deepEqual(metrics.snapshot().replay.prune, {count:2, ms:24.6, fullReads:2});
  assert.equal(records[1].error, 'fixture locked');
  metrics.clear();
  runDailyHierarchyPrune({...args, entries:[{kind:'hierarchy-prune', t:new Date(args.now).toISOString()}],
    prune:() => assert.fail('not due')});
  assert.deepEqual(metrics.snapshot().replay.prune, {count:0, ms:0, fullReads:0});
});

test('정리의 시간·읽기·횟수는 고정 상한이고 잘못된 숫자는 관측 오류다', () => {
  const metrics = createWatchReplayMetrics();
  metrics.prune(1e8, 1e8);
  assert.deepEqual(metrics.snapshot().replay.prune,
    {count:1, ms:WATCH_METRIC_DURATION_MAX, fullReads:WATCH_METRIC_COUNT_MAX});
  metrics.prune(-1, 0);metrics.prune(0, NaN);
  assert.equal(metrics.snapshot().processMemory.failures, 2);
});

test('정리 구간은 기존 5분 주기 기록에 실리고 다음 구간에서 초기화된다', async () => {
  const times = [100000, 160000, 460000, 100000 + 25 * 3600000];
  const records = [], end = new Error('fixture finished');
  let index = 0, elapsed = 0;
  await assert.rejects(() => runWatch({floor:{list:() => [], read:() => ''},
    readEntries:() => records, readCards:() => [],
    now:() => times[index], measure:() => { elapsed += 2;return elapsed; },
    hierarchyPath:'fixture', intervalMs:60000,
    pruneHierarchy:({onFullRead}) => {
      onFullRead();return {file:'fixture', applied:false, removeCount:0, retainCount:0};
    },
    record:row => records.push({...row, t:new Date(times[index]).toISOString()}),
    sleep:async () => { if (++index === times.length) throw end; },
    print:() => {}, sendAlert:() => {},
  }), error => error === end);
  const cycles = records.filter(row => row.kind === 'watch-cycle');
  assert.equal(cycles.length, 3);
  assert.deepEqual(cycles.map(row => row.timing.replay.prune), [
    {count:1, ms:2, fullReads:1}, {count:0, ms:0, fullReads:0}, {count:1, ms:2, fullReads:1},
  ]);
});

test('읽기 콜백은 두 잠금 안에서만 부르고 버전이 모르면 파일·백업을 쓰지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-version-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  const file = path.join(home, 'parents.json'), table = {fixture:'@user'};
  fs.writeFileSync(file, JSON.stringify(table));
  let called = 0;
  assert.throws(() => pruneHierarchy({home, file, floor:{list:() => []}, apply:true,
    readSnapshot:() => assert.fail('extra full snapshot'),
    readCurrentSnapshot:() => {
      called++;
      assert.ok(fs.existsSync(path.join(home, 'handovers', '.lock')));
      assert.ok(fs.existsSync(path.join(home, 'hierarchy-register.lock')));
      return {entries:[], cards:[], works:[], version:null};
    },
  }), /원장 버전/);
  assert.equal(called, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), table);
  assert.equal(fs.existsSync(path.join(home, '.trash')), false);
});
