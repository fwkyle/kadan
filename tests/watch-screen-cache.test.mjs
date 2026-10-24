import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWatchScreenCache} from '../src/watch-screen-cache.mjs';
import {collectRoles} from '../src/watch-roles.mjs';
import {tmuxFloor} from '../src/floor-tmux.mjs';
import {appendSpool} from '../src/stop-hook-spool.mjs';

const live = (activity = 100, signature = `${activity}:window`) =>
  ({session: 'kadan-quiet-fixture', pid: '10', screenVersion: {activity, signature}});

test('조용한 화면만 재사용하며 시각 경계·출력·세대·정기 확인은 새로 읽는다', () => {
  let now = 101_000, value = 'first', calls = 0;
  const cache = createWatchScreenCache({now: () => now});
  const read = (item = live()) => cache.read(item.session, item, () => { calls++; return value; });
  assert.equal(read(), 'first');
  now = 161_000;
  assert.equal(read(), 'first'); assert.equal(calls, 1);
  now = 221_000; value = 'periodic';
  assert.equal(read(), 'periodic'); assert.equal(calls, 2);
  value = 'changed';
  assert.equal(read(live(220)), 'changed'); assert.equal(calls, 3);
  value = 'new-generation';
  assert.equal(read({...live(220), pid: '11'}), 'new-generation'); assert.equal(calls, 4);
  value = 'resized';
  assert.equal(read(live(220, '220:resized')), 'resized'); assert.equal(calls, 5);
  now = 222_100; read(live(222));
  now = 222_900; value = 'same-second-later';
  assert.equal(read(live(222)), 'same-second-later'); assert.equal(calls, 7);
  now = 223_000; read(live(222));
  now = 224_000; read(live(222)); assert.equal(calls, 8);
  now = 222_000; read(live(222)); assert.equal(calls, 9, '시계 역행 때 재사용하지 않는다');
});

test('버전 없음·빈 화면·읽기 실패는 캐시하지 않고 활성 세션/바이트만 보관한다', () => {
  const cache = createWatchScreenCache({now: () => 101_000, maxBytes: 10});
  let calls = 0;
  const read = (session, item, value) => cache.read(session, item, () => { calls++; return value; });
  read('a', {}, 'none'); read('a', {}, 'none');
  read('a', live(), ''); read('a', live(), '');
  assert.equal(calls, 4); assert.equal(cache.info().entries, 0);
  read('a', live(), '가나'); read('b', live(), '12345');
  assert.equal(cache.info().entries, 1); assert.equal(cache.info().bytes, 5);
  read('huge', live(), 'x'.repeat(11)); assert.equal(cache.info().entries, 1);
  cache.retain(new Set(['a'])); assert.equal(cache.info().bytes, 0);
  read('a', live(), 'valid');
  assert.throws(() => cache.read('a', live(101), () => { throw new Error('read failed'); }), /read failed/);
  assert.equal(cache.info().entries, 0);
});

test('카드 없는 세션도 읽고 캐시 사용 여부와 관계없이 같은 관측·완료 근거를 만든다', () => {
  let now = 101_000, current = live(), text = 'waiting for input', cachedReads = 0;
  const cache = createWatchScreenCache({now: () => now});
  const entries = [{kind: 'start', t: new Date(0).toISOString(), role: 'quiet-fixture',
    session: current.session, panePid: '10'}];
  const fresh = {list: () => [current], read: () => text};
  const floor = {list: () => [current], read: () => { cachedReads++; return text; }};
  for (const step of [() => {}, () => { now += 60_000; }, () => {
    now += 60_000; current = live(220); text = 'Press Enter to send queued messages now';
  }, () => { now += 60_000; }, () => {
    now += 60_000; current = live(340); text = 'KADAN:DONE fixture ok';
  }]) {
    step();
    assert.deepEqual(collectRoles(floor, entries, new Set(), null, {screenCache: cache}),
      collectRoles(fresh, entries, new Set(), null));
  }
  assert.equal(cachedReads, 3);
  assert.equal(cache.info().hits, 2);
});

test('tmux 출력 버전은 명시 조회에만 붙고 불완전하면 재사용 근거를 주지 않는다', () => {
  const run = () => ({status: 0, stdout: 'kadan-test\t0\t1\t10\t100\t@3\t80\t24\t0\t0\t0\n'});
  const row = tmuxFloor.list({run, observeOutput: true})[0];
  assert.deepEqual(row.screenVersion, {activity: 100, signature: '100:@3:80:24:0:0:0'});
  assert.equal(tmuxFloor.list({run})[0].screenVersion, undefined);
  assert.equal(tmuxFloor.list({observeOutput: true, run: () => ({status: 0,
    stdout: 'kadan-test\t0\t1\t10\t\t@3\t80\t24\t0\t0\t0\n'})})[0].screenVersion, undefined);
});

test('캐시된 화면에도 새 훅을 매번 반영하고 발령 여러 개의 훅 파일은 한 번만 읽는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-hooks-'));
  const item = live(), role = 'quiet-fixture', session = item.session;
  const t = new Date(0).toISOString();
  const entries = [{kind: 'start', role, session, panePid: item.pid, t},
    ...['a', 'b'].map(taskId => ({kind: 'send', role, session, taskId, t}))];
  const floor = {list: () => [item], read: () => 'no screen marker'};
  const screenCache = createWatchScreenCache({now: () => 101_000});
  const options = {hookHome: home, screenCache};
  const read = () => collectRoles(floor, entries, null, null, options).observations.get(session);
  assert.equal(read().doneMarker, null);
  appendSpool(home, {role, at: new Date(1000).toISOString(), taskId: 'b', result: 'ok'});
  const original = fs.openSync; let opens = 0;
  fs.openSync = function(file, ...args) {
    if (String(file).endsWith('/stop-hook-spool.jsonl')) opens++;
    return original.call(this, file, ...args);
  };
  try {
    assert.deepEqual(read().doneMarker, {taskId: 'b', result: 'ok'});
    assert.equal(opens, 1); assert.equal(screenCache.info().hits, 1);
  } finally { fs.openSync = original; }
  appendSpool(home, {role, at: new Date(2000).toISOString(), taskId: 'b', result: 'failed', conflict: true});
  assert.equal(read().doneMarker, null, '최신 훅 충돌은 이전 성공을 되살리지 않는다');
});

test('실제 tmux: 정지 화면 재사용 뒤 새 출력·크기 변경을 바로 읽는다', {
  skip: spawnSync('tmux', ['-V']).status !== 0,
}, async t => {
  const socket = `kadan-screen-${randomUUID()}`, session = 'kadan-screen-fixture';
  const old = process.env.KADAN_SOCKET;
  process.env.KADAN_SOCKET = socket;
  t.after(() => {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
    if (old === undefined) delete process.env.KADAN_SOCKET;
    else process.env.KADAN_SOCKET = old;
  });
  const run = args => {
    const result = spawnSync('tmux', ['-u', '-L', socket, '-f', '/dev/null', ...args],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  run(['new-session', '-d', '-s', session, 'cat']);
  const cache = createWatchScreenCache();
  const read = () => cache.read(session, tmuxFloor.list({strict: true, observeOutput: true})[0],
    () => tmuxFloor.read(session));
  run(['send-keys', '-t', `=${session}:`, '-l', 'first-output']);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.match(read(), /first-output/);
  const before = cache.info().reads;
  assert.match(read(), /first-output/); assert.equal(cache.info().reads, before);
  run(['send-keys', '-t', `=${session}:`, '-l', 'second-output']);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(read(), /second-output/); assert.equal(cache.info().reads, before + 1);
  run(['resize-window', '-t', `=${session}:`, '-x', '60', '-y', '20']);
  read(); assert.equal(cache.info().reads, before + 2);
});
