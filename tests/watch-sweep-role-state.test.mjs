import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {ledgerViewPath} from '../src/ledger-view-store.mjs';
import {createLedgerArraySweep} from '../src/watch-sweep.mjs';
import {createSweepDiagnostics, createSweepPolicy} from '../src/watch-sweep-policy.mjs';
import {createSweepRunner} from '../src/watch-sweep-run.mjs';
import {watchRoleState} from '../src/watch-role-facts.mjs';

const at = n => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const role = 'fixture-role-a';
const cards = [{id: 'one', key: 'fixture/one', role, status: 'assigned', at: at(0)},
  {id: 'two', key: 'fixture/two', role, status: 'assigned', at: at(0)}];
const start = {kind: 'start', role, session: `kadan-${role}`, panePid: 11, t: at(1)};
const dispatch = (n, id) => ({kind: 'send', role, session: `kadan-${role}`, taskId: id, executionKey: `fixture/${id}`,
  mailId: `fixture-q-${n}`, baselineMarkers: [], t: at(n)});

// 독립검수 F7 재현: 조회 DB의 발령 상태 행 하나가 실행 중 유실돼도 예전 대조는 둘 다 통과했다.
// 열린 카드 수 불변식이 실제 저장소와 맞도록 카드 사건을 저장소에도 둔다.
const storeCards = (home, list) => list.forEach(card => appendStream(home, `cards/${card.key}/events.jsonl`,
  {key: card.key, id: card.id, repo: card.key.split('/')[0], revision: 1, at: card.at, role: card.role, status: card.status, workType: 'execution'}));
function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-role-state-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  storeCards(home, cards);
  const reader = createWatchMailReader(home, null, {readCards: () => cards});
  const dispatches = () => {
    const raw = reader.readEntries(), entries = reader.project(raw, cards);
    return watchRoleState(entries, cards)?.dispatches ?? null;
  };
  const loseRow = () => {
    const db = new DatabaseSync(ledgerViewPath(home));
    try { db.exec(`DELETE FROM watch_role_dispatches WHERE (session_key,task_key)=(SELECT session_key,task_key FROM watch_role_dispatches ORDER BY task_key LIMIT 1)`); }
    finally { db.close(); }
  };
  return {home, reader, dispatches, loseRow, sweep: () => createLedgerArraySweep({access: reader.sweepAccess, chunkRows: 5})};
}

test('F7: 상태 행이 실행 중 유실되면 가벼운 수 대조와 전체 대조가 모두 잡는다', async () => {
  const s = setup();
  appendLedger(start, s.home);appendLedger(dispatch(2, 'one'), s.home);
  s.reader.readEntries();
  assert.deepEqual(s.sweep().light().mismatches, []);
  assert.equal((await s.sweep().full()).status, 'match');
  s.loseRow();
  const light = s.sweep().light();
  assert.deepEqual(light.mismatches.map(item => item.name), ['역할 상태표 발령 수 대 기록']);   // 저렴한 수 대조
  const full = await s.sweep().full();
  assert.equal(full.status, 'diff');                                                               // 정식 reducer 재생 대조
  assert.deepEqual(full.diffs.map(diff => diff.key), ['role-state']);
  assert.ok(full.roleStateDigest && full.roleStateReplayDigest && full.roleStateDigest !== full.roleStateReplayDigest);
});

test('F7: 유실 뒤 발령이 더 붙어 수가 우연히 맞아도 전체 대조(정식 reducer 재생)가 잡고 교체하면 복구된다', async () => {
  const s = setup();
  appendLedger(start, s.home);appendLedger(dispatch(2, 'one'), s.home);
  s.reader.readEntries();
  s.loseRow();
  appendLedger(dispatch(3, 'two'), s.home);
  const keysOf = value => [...(value.get(`kadan-${role}`) ?? value.get(role) ?? new Map()).keys()].sort();
  assert.deepEqual(keysOf(s.dispatches()), ['fixture/two']);   // 유실된 상태로 판정 입력이 틀려 있다(열린 발령 one이 없음)
  const found = await s.sweep().full();
  assert.equal(found.status, 'diff');
  assert.ok(found.diffs.some(diff => diff.key === 'role-state'));
  s.reader.sweepAccess.roleState.reset();                       // 교체: 상태표 메타를 지워 다음 읽기가 처음부터 재생
  s.reader.readEntries();
  assert.deepEqual(keysOf(s.dispatches()), ['fixture/one', 'fixture/two']);   // 정식 reducer 재생으로 복구
  assert.equal((await s.sweep().full()).status, 'match');
  assert.deepEqual(s.sweep().light().mismatches, []);
});

test('교체 뒤 재발생: 실제 reset → reader 재생 → 보류 해제 → 경보·재개 후보가 다시 나온다(상태표 유실 기준)', async () => {
  const s = setup();
  appendLedger(start, s.home);appendLedger(dispatch(2, 'one'), s.home);
  s.reader.readEntries();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-role-state-diag-'));
  const policy = createSweepPolicy({diagnostics: createSweepDiagnostics(dir)});
  const resets = [];
  const runner = createSweepRunner({engine: s.sweep(), policy, lightEvery: 1, intervalMs: 10 ** 12,
    reset: keys => { resets.push(keys);if (keys.includes('role-state')) s.reader.sweepAccess.roleState.reset(); }});
  runner.tick();await runner.idle();                           // 시작 대조: 일치
  assert.equal(runner.tick().holding, false);
  const before = s.dispatches();
  s.loseRow();
  const held = runner.tick();await runner.idle();              // 가벼운 대조 불일치 → 즉시 보류(F1), 쿨다운이라 전체 대조는 안 돈다
  assert.equal(held.holding, true);
  assert.ok(held.alerts.some(alert => alert.id.startsWith('sweep-hold:light:')));
  // 쿨다운이 지난 뒤(가짜 시계 대신 새 runner로 같은 정책 상태를 이어 쓴다) 전체 대조가 diff를 잡고 교체한다.
  const runner2 = createSweepRunner({engine: s.sweep(), policy, lightEvery: 1, intervalMs: 10 ** 12,
    reset: keys => { resets.push(keys);if (keys.includes('role-state')) s.reader.sweepAccess.roleState.reset(); }});
  runner2.tick();await runner2.idle();                          // 새 runner의 시작 대조: diff → 교체
  assert.deepEqual(resets.at(-1), ['role-state']);
  assert.equal(policy.holding(), true);                         // 교체했어도 일치가 확인되기 전까지 보류 유지
  const afterReset = s.dispatches();                            // 실제 reader 재생
  assert.deepEqual([...afterReset.keys()], [...before.keys()]);  // 발령 상태가 원래대로 복원
  runner2.tick();                                               // (돌고 있는 대조 없음)
  const again = createSweepRunner({engine: s.sweep(), policy, lightEvery: 1, intervalMs: 10 ** 12, reset() {}});
  again.tick();await again.idle();                              // 일치 확인 → 보류 해제
  assert.equal(policy.holding(), false);
  assert.deepEqual(policy.alerts(), []);
  assert.ok(createSweepDiagnostics(dir).rows().some(row => row.kind === 'released'));
  // 재개·경보 판단의 입력인 발령 상태가 다시 나온다.
  assert.ok(watchRoleState(s.reader.project(s.reader.readEntries(), cards), cards));
});

test('교체 뒤 다음 순회: 실제 reader·정기 대조·reset으로 보류→재생→해제를 거친 뒤 한도 재개가 다시 나가고, 보류 경보가 기록·해소된다', async () => {
  const {runWatch} = await import('../src/watch-runner.mjs');
  const failure = '■ exceeded retry limit, last status: 429 Too Many Requests';
  const screen = `${failure}\n\n›\n kimi/k3[1m] max`;
  const worker = 'worker', session = 'kadan-worker';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-role-state-run-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  const card = {id: 'task', key: 'repo/task', role: worker, status: 'assigned', workType: 'execution', at: new Date(0).toISOString()};
  storeCards(home, [card]);
  const reader = createWatchMailReader(home, null, {readCards: () => [card]});
  appendLedger({kind: 'start', role: worker, session, panePid: 1, t: new Date(0).toISOString()}, home);
  appendLedger({kind: 'send', role: worker, session, taskId: 'task', executionKey: 'repo/task', baselineMarkers: [], t: new Date(0).toISOString()}, home);
  reader.readEntries();                                           // 상태표를 한 번 만든다
  const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-role-state-diag-'));
  const policy = createSweepPolicy({diagnostics: createSweepDiagnostics(diagDir)});
  const sweepRunner = createSweepRunner({engine: createLedgerArraySweep({access: reader.sweepAccess, chunkRows: 5}), policy,
    lightEvery: 1000, intervalMs: 0,                              // 가벼운 대조는 끄고(전체 대조만), 매 순회 전체 대조
    reset: keys => { if (keys.includes('role-state')) reader.sweepAccess.roleState.reset(); }});
  // 상태 행 유실: 열린 발령 상태가 사라진 채로 시작한다.
  const db = new DatabaseSync(ledgerViewPath(home));
  try { db.exec('DELETE FROM watch_role_dispatches'); } finally { db.close(); }
  const controller = new AbortController(), resumes = [], seen = [];
  let now = 0, cycle = 0;
  await runWatch({floor: {list: () => [{session, pid: 1, alive: true}], read: () => screen},
    readEntries: reader.readEntries, projectEntries: reader.project, readCards: () => [card], readWorks: () => [],
    record: e => appendLedger({...e, t: new Date(now).toISOString()}, home),
    resume429: (...args) => resumes.push(args), sendAlert: () => {},
    sweepTick: () => sweepRunner.tick(),
    intervalMs: 60000, stallN: 100, routes: new Map(), superRole: 'boss', now: () => now,
    spawn: () => ({status: 0, stdout: String(process.pid)}), signal: controller.signal, print: () => {},
    sleep: async () => {
      await sweepRunner.idle();                                    // 이번 순회에서 시작한 대조가 끝나길 기다린다(결정적 시험)
      seen.push({cycle, resumes: resumes.length, holding: policy.holding()});
      now += 60000;
      if (++cycle === 4) controller.abort();
    }});
  // 순회 0: 대조가 diff를 잡고 교체(reset). 순회 1: 보류 중이라 재개가 나가지 않는다. 그 뒤 일치로 풀리고 재개가 나간다.
  assert.equal(seen[0].holding, true);
  assert.equal(seen.find(item => item.holding)?.resumes, 0);
  assert.equal(seen.at(-1).holding, false);
  assert.equal(resumes.length, 1);
  assert.ok(seen.at(-1).resumes === 1);
  const kinds = createSweepDiagnostics(diagDir).rows().map(row => row.kind);
  assert.ok(kinds.includes('hold') && kinds.includes('released'));
  const { readLedger } = await import('../src/ledger.mjs');
  const ledger = readLedger(home);
  assert.ok(ledger.some(e => e.kind === 'alert' && e.id === 'sweep-hold:role-state'));          // 보류 경보 기록
  assert.ok(ledger.some(e => e.kind === 'alert' && e.id === 'sweep-hold:role-state' && e.resolved === true));   // 해제로 해소
});
