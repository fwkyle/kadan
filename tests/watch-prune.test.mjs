import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWatch } from './helpers/watch-runner.mjs';
import { hierarchyPruneDue, runDailyHierarchyPrune, HIERARCHY_PRUNE_EVERY_MS } from '../src/watch-prune.mjs';
import { pruneHierarchy, PRUNE_GRACE_MS } from '../src/hierarchy-prune.mjs';
import { readWatchProfile, PROFILE_FLAGS } from '../src/watch-profile.mjs';

const HOUR = 3_600_000;
const t0 = Date.parse('2026-10-12T00:00:00Z');
const stamp = ms => new Date(ms).toISOString();
const file = '/tmp/kadan-prune-test/parents.json';

// 가짜 시계로 주기를 돌린다. times[i]가 i번째 주기의 현재 시각이고, ledger는 재시작 사이에 공유한다.
async function drive({times, ledger = [], prune, pruneFile = file, parents = new Map([['boss', '@user']])}) {
  let cycle = 0;
  const end = new Error('end'), calls = [];
  const clock = () => times[Math.min(cycle, times.length - 1)];
  await assert.rejects(() => runWatch({
    floor: {list: () => [], read: () => ''},
    readEntries: () => [...ledger],
    readCards: () => [],
    intervalMs: 60_000, stallN: 100, parents, routes: new Map(), superRole: null,
    hierarchyPath: pruneFile,
    pruneHierarchy: prune === null ? null : args => { calls.push({...args}); return prune(args); },
    now: clock,
    record: r => ledger.push({...r, t: stamp(clock())}),
    sendAlert: () => {}, print: () => {},
    spawn: cmd => {
      if (cmd === 'sleep' && ++cycle === times.length) throw end;
      if (cmd === 'memory_pressure') return {status: 0, stdout: 'System-wide memory free percentage: 80%'};
      if (cmd === 'sysctl') return {status: 0, stdout: 'used = 0M'};
      return {status: 0, stdout: ''};
    },
  }), e => e === end);
  return {cycles: cycle, ledger, calls, records: ledger.filter(e => e.kind === 'hierarchy-prune')};
}
const ok = ({file: f}) => ({file: f, applied: true, removeCount: 3, retainCount: 5, backup: '/h/.trash/p.json.before-prune-x'});

test('같은 시각에 두 번 돌려도 정리는 1회, 23시간 뒤 0회, 24시간 뒤 1회', async () => {
  const same = await drive({times: [t0, t0], prune: ok});
  assert.equal(same.calls.length, 1);
  assert.equal(same.calls[0].file, file);
  const day = await drive({times: [t0, t0 + 23 * HOUR, t0 + 24 * HOUR], prune: ok});
  assert.equal(day.calls.length, 2);
  assert.equal(day.records.length, 2);
  assert.equal(day.records[1].t, stamp(t0 + 24 * HOUR));
});

test('감시기를 새로 만들어도 원장만 있으면 24시간 안에는 다시 정리하지 않는다', async () => {
  const first = await drive({times: [t0], prune: ok});
  assert.equal(first.calls.length, 1);
  const restarted = await drive({times: [t0 + HOUR, t0 + 2 * HOUR], ledger: first.ledger, prune: ok});
  assert.equal(restarted.calls.length, 0);
  const next = await drive({times: [t0 + 25 * HOUR], ledger: first.ledger, prune: ok});
  assert.equal(next.calls.length, 1);
});

test('거절되면 주기는 계속 돌고 거절 이유가 원장에 남고 같은 날 다시 시도하지 않는다', async () => {
  const locked = () => { throw new Error('HIERARCHY_LOCKED: 관계표 잠금'); };
  const result = await drive({times: [t0, t0 + HOUR, t0 + 2 * HOUR, t0 + 3 * HOUR], prune: locked});
  assert.equal(result.calls.length, 1);
  assert.equal(result.records.length, 1);
  assert.deepEqual({applied: result.records[0].applied, backup: result.records[0].backup, removeCount: result.records[0].removeCount},
    {applied: false, backup: null, removeCount: null});
  assert.match(result.records[0].error, /HIERARCHY_LOCKED/);
  assert.equal(result.cycles, 4, '거절 뒤에도 주기가 끝까지 돌았다');
});

test('끄면 호출도 기록도 0건이고 --hierarchy가 없어도 0건이다', async () => {
  const off = await drive({times: [t0, t0 + 48 * HOUR], prune: null});
  assert.equal(off.records.length, 0);
  const none = await drive({times: [t0, t0 + 48 * HOUR], prune: ok, pruneFile: null});
  assert.equal(none.calls.length, 0);
  assert.equal(none.records.length, 0);
});

test('성공과 0줄 두 경우의 원장 사건 필드', () => {
  const records = [];
  const zero = () => ({file, applied: false, removeCount: 0, retainCount: 8, backup: null, remove: [{role: 'x'}]});
  runDailyHierarchyPrune({entries: [], now: t0, file, prune: ok, record: r => records.push(r)});
  runDailyHierarchyPrune({entries: [], now: t0, file, prune: zero, record: r => records.push(r)});
  assert.deepEqual(records[0], {kind: 'hierarchy-prune', by: 'watch', file, applied: true, removeCount: 3, retainCount: 5,
    backup: '/h/.trash/p.json.before-prune-x', error: null});
  assert.deepEqual(records[1], {kind: 'hierarchy-prune', by: 'watch', file, applied: false, removeCount: 0, retainCount: 8,
    backup: null, error: null});
});

test('24시간 경계: 정확히 24시간은 대상, 그 전은 아니다; 시각을 못 읽는 기록은 없는 것과 같다', () => {
  const at = n => [{kind: 'hierarchy-prune', t: stamp(t0 - n)}];
  assert.equal(hierarchyPruneDue(at(HIERARCHY_PRUNE_EVERY_MS - 1), t0), false);
  assert.equal(hierarchyPruneDue(at(HIERARCHY_PRUNE_EVERY_MS), t0), true);
  assert.equal(hierarchyPruneDue([{kind: 'hierarchy-prune', t: 'bad'}], t0), true);
  assert.equal(hierarchyPruneDue([{kind: 'hierarchy-prune', t: stamp(t0 + 1)}], t0), true);
  assert.equal(hierarchyPruneDue([], t0), true);
});

test('실제 정리: 지운 줄이 있으면 백업이 남고 관계표가 줄며, 바뀐 표는 다음 주기에 다시 읽힌다', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-prune-'));
  const table = path.join(home, 'parents.json');
  fs.writeFileSync(table, JSON.stringify({boss: '@user', leaf: 'boss'}));
  const old = stamp(t0 - 2 * PRUNE_GRACE_MS), began = stamp(t0 - 3 * PRUNE_GRACE_MS);
  const ledger = [{kind: 'hierarchy-loaded', path: table},
    ...['boss', 'leaf'].flatMap(role => [{kind: 'start', role, panePid: 10, t: began}, {kind: 'stop', role, t: old}])];
  const loads = [];
  let cycle = 0;
  const end = new Error('end'), times = [t0, t0 + HOUR];
  await assert.rejects(() => runWatch({
    floor: {list: () => [], read: () => ''}, readEntries: () => [...ledger], readCards: () => [],
    intervalMs: 60_000, stallN: 100, parents: new Map(), routes: new Map(), superRole: null,
    hierarchyPath: table,
    loadHierarchy: () => {
      const text = fs.readFileSync(table, 'utf8');
      loads.push(text);
      return {parents: new Map(Object.entries(JSON.parse(text))), path: table, hash: text};
    },
    pruneHierarchy: ({file, now}) => pruneHierarchy({home, floor: {list: () => []}, file, apply: true, now: () => now,
      readSnapshot: () => ({entries: ledger, cards: [], works: [], version: null})}),
    now: () => times[Math.min(cycle, 1)],
    record: r => ledger.push({...r, t: stamp(times[Math.min(cycle, 1)])}),
    sendAlert: () => {}, print: () => {},
    spawn: cmd => {
      if (cmd === 'sleep' && ++cycle === 2) throw end;
      if (cmd === 'memory_pressure') return {status: 0, stdout: 'System-wide memory free percentage: 80%'};
      if (cmd === 'sysctl') return {status: 0, stdout: 'used = 0M'};
      return {status: 0, stdout: ''};
    },
  }), e => e === end);
  const [record] = ledger.filter(e => e.kind === 'hierarchy-prune');
  assert.equal(record.applied, true);
  assert.equal(record.removeCount, 1);
  assert.equal(record.error, null);
  assert.equal(path.dirname(record.backup), path.join(home, '.trash'));
  assert.match(path.basename(record.backup), /^parents\.json\.before-prune-/);
  assert.deepEqual(JSON.parse(fs.readFileSync(table, 'utf8')), {boss: '@user'});
  // 같은 주기 안에서 정리 뒤 읽으므로 감시기는 처음부터 줄어든 표를 쓴다.
  assert.deepEqual(JSON.parse(loads[0]), {boss: '@user'});
});

test('프로필 플래그에 hierarchy-prune이 있고 off 값을 읽는다', () => {
  assert.equal(PROFILE_FLAGS.has('hierarchy-prune'), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-profile-'));
  const f = path.join(dir, 'watch-profile.json');
  fs.writeFileSync(f, JSON.stringify({flags: {hierarchy: 'h.json', 'hierarchy-prune': 'off'}}));
  assert.equal(readWatchProfile(f).flags['hierarchy-prune'], 'off');
});

test('미래 시각 기록은 근거가 아니다: 한 번 정리하고 새 기록이 생기면 같은 날 다시 돌지 않는다', async () => {
  const future = {kind: 'hierarchy-prune', by: 'watch', t: stamp(t0 + 7 * 24 * HOUR)};
  const result = await drive({times: [t0, t0 + HOUR, t0 + 2 * HOUR], ledger: [future], prune: ok});
  assert.equal(result.calls.length, 1);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[1].t, stamp(t0));
  assert.equal(result.ledger[0], future, '옛 기록은 그대로 둔다');
});
