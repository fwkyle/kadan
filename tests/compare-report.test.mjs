import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {compareFixture, choice} from './helpers/compare-fixture.mjs';
import {calculateCompareReport, compareReport, formatCompareReport, relativeRounds} from '../src/compare-report.mjs';
import {readCompareData, REPORT_SQL, REPORT_HEAD_SQL} from '../src/compare-report-data.mjs';
import {setCompare, PICK_COUNT_SQL} from '../src/runner-compare.mjs';
import {appendStream, storageSnapshot, storageTransaction, storageVersion} from '../src/storage.mjs';

const epoch = '2026-10-27T00:00:00.000Z';
const stamp = minutes => new Date(Date.parse(epoch) + minutes * 60000).toISOString();
function fixture() {
  const data = {entries: [], works: [], cards: []};
  const add = ({work = 'test/work', preset = 'A', round = 1, passRound = round, failed = false,
    pending = false, reviewer = 'claude-one', worker = 'gpt-one', fallback = null, review = true} = {}) => {
    const n = data.entries.length, key = `test/impl-${n}`, reviewKey = `test/review-${n}`;
    let w = data.works.find(w => w.key === work);
    if (!w) { w = {key: work, executions: []}; data.works.push(w); }
    const workerRole = `test-worker-${n}`, reviewRole = `test-reviewer-${n}`, pickId = `pick-${n}`;
    const pick = {kind: 'compare-pick', pickId, preset, role: workerRole, epoch, t: stamp(0),
      worker: choice(worker), reviewer: choice(reviewer, 'high')};
    const start = {kind: 'start', role: workerRole, cmd: 'fake', roleProfile: 'worker',
      compareMode: true, settingsPreset: preset, pickId, t: stamp(0)};
    const send = {kind: 'send', taskId: key.split('/')[1], executionKey: key, workKey: work,
      role: workerRole, compareMode: fallback !== 'worker', settingsPreset: preset, pickId,
      launchSource: fallback === 'worker' ? 'fallback' : 'settings',
      runnerChoice: choice(worker), t: stamp(1)};
    data.entries.push(pick, start, send);
    w.executions.push({key, phase: 'implementation', round});
    if (!pending) data.entries.push({kind: 'done', taskId: key.split('/')[1], executionKey: key,
      role: workerRole, result: failed ? 'failed' : 'ok', t: stamp(11)});
    if (review) {
      w.executions.push({key: reviewKey, phase: 'review', round: passRound ?? round});
      data.entries.push({kind: 'send', taskId: reviewKey.split('/')[1], executionKey: reviewKey, workKey: work,
        role: reviewRole, reviewFor: {role: workerRole}, compareMode: fallback !== 'reviewer',
        settingsPreset: preset, pickId, runnerChoice: choice(reviewer, 'high'), t: stamp(12)});
      if (!pending) {
        data.entries.push({kind: 'done', taskId: reviewKey.split('/')[1], executionKey: reviewKey,
          role: reviewRole, result: 'ok', t: stamp(20)});
        data.cards.push({key: reviewKey, result: {outcome: passRound == null ? 'changes' : 'pass'}});
      }
    }
    return {key, reviewKey, send, start, pick, workerRole, reviewRole};
  };
  return {data, add};
}
const rows = result => result.groups.flatMap(g => g.rows);

test('검수자별 묶음, 업무당 1표본, 병렬 구현 중앙값과 상대 라운드', () => {
  const f = fixture();
  f.add({round: 4, passRound: 5}); f.add({round: 4, passRound: 5});
  f.add({work: 'test/second'});
  f.add({work: 'test/terra', preset: 'E', worker: 'claude-one', reviewer: 'gpt-6.1-terra'});
  const report = calculateCompareReport(f.data, {epoch});
  assert.equal(report.groups.length, 2);
  const row = rows(report).find(r => r.preset === 'A');
  assert.equal(row.samples, 3); assert.equal(row.independentSamples, 2);
  assert.equal(row.completedSamples, 2); assert.equal(row.firstRoundPassRate, 0.5);
  assert.equal(row.medianRounds, 1.5); assert.equal(row.medianImplementationMs, 600000);
  assert.deepEqual(row.workIds, ['test/work', 'test/second']); assert.equal(row.cardIds.length, 6);
  // trial-metrics.py: passed - imp.round + 1, 시작 라운드가 1이 아닌 고정 예시까지 대조.
  for (const [implementation, passed, expected] of [[1, 1, 1], [4, 5, 2], [9, 12, 4], [5, null, null]]) {
    assert.equal(relativeRounds(implementation, passed), expected);
  }
  assert.match(formatCompareReport(report), /검수자 codex\/gpt-6.1-terra\/high/);
  assert.doesNotMatch(formatCompareReport(report), /엄격도|1위|순위: /);
});

test('혼합 군은 업무 전체 제외, 기간 밖 비교 구현도 혼합 판정에 포함', () => {
  const f = fixture(); f.add();
  const other = f.add({preset: 'B'}); other.send.t = stamp(30);
  const report = calculateCompareReport(f.data, {since: stamp(25)});
  assert.equal(report.mixed.length, 1);
  assert.deepEqual(report.mixed[0].presets, ['A', 'B']);
  assert.equal(report.mixed[0].cardIds.length, 2);
  assert.equal(rows(report).reduce((n, r) => n + r.independentSamples, 0), 0);
});

test('미완료는 비율 분모에서 제외, failed는 별도 열, 미통과는 통과로 세지 않는다', () => {
  const f = fixture(); f.add(); f.add({work: 'test/pending', pending: true});
  f.add({work: 'test/failed', failed: true, review: false});
  f.add({work: 'test/changes', passRound: null});
  const row = rows(calculateCompareReport(f.data))[0];
  assert.equal(row.independentSamples, 4); assert.equal(row.completedSamples, 3);
  assert.equal(row.firstRoundPassRate, 1 / 3); assert.equal(row.failed, 1); assert.equal(row.inProgress, 1);
});

test('양쪽 폴백·명시 명령과 중간 교체 제외, cmd 없는 재사용은 허용', () => {
  const f = fixture();
  const worker = f.add({work: 'test/worker-fallback'});
  f.data.entries.push({...worker.send, compareMode: false, t: stamp(2)});
  f.add({work: 'test/reviewer-fallback', fallback: 'reviewer'});
  f.add({work: 'test/direct-worker-fallback', fallback: 'worker'});
  const replaced = f.add({work: 'test/replaced'});
  f.data.entries.push({...replaced.start, t: stamp(2)});
  const reused = f.add({work: 'test/reused'});
  f.data.entries.push({...reused.start, cmd: undefined, t: stamp(2)});
  // 종료·PID와 무관: stop 기록이 있어도 발령 귀속을 보존한다.
  f.data.entries.push({kind: 'stop', role: reused.workerRole, t: stamp(21)});
  const report = calculateCompareReport(f.data);
  assert.equal(report.excluded['폴백·명시 명령'], 3);
  assert.equal(report.excluded['중간 교체'], 1);
  assert.equal(rows(report)[0].independentSamples, 1);
  assert.equal(rows(report)[0].completedSamples, 1);
});

test('검수자 귀속 불명·업무 안 다른 검수자는 제외하며 예약과 실제 시작 차이를 드러낸다', () => {
  const f = fixture();
  f.add({reviewer: 'claude-one'}); f.add({reviewer: 'claude-two'});
  const reservation = {...f.data.entries[0], pickId: 'only-pick', preset: 'reservation'};
  f.data.entries.push(reservation);
  const report = calculateCompareReport(f.data);
  assert.equal(report.excluded['검수자 변경'], 1);
  assert.deepEqual(report.reservationsWithoutStart, ['only-pick']);
  const row = rows(report).find(r => r.preset === 'reservation');
  assert.equal(row.picks, 1); assert.equal(row.starts, 0);
});

test('SQLite 범위 조회와 실제 report CLI: 과거 원장 제외, 읽기 전후 불변, EXPLAIN', () => {
  const f = compareFixture();
  storageTransaction(f.home, () => {
    for (let i = 0; i < 200; i++) appendStream(f.home, 'test/archive',
      {kind: 'old-unrelated', t: '2020-01-01T00:00:00.000Z', text: 'old'});
  });
  const config = setCompare(f.home, {enabled: true, presets: 'A', now: () => epoch, ...f.meta()});
  assert.equal(config.compare.afterRowid, 200);
  const fake = fixture(); fake.add();
  storageTransaction(f.home, () => {
    for (const entry of fake.data.entries) f.record(entry);
    for (const work of fake.data.works) appendStream(f.home, `works/${work.key}/events.jsonl`, work);
    for (const card of fake.data.cards) appendStream(f.home, `cards/${card.key}/events.jsonl`, card);
  });
  const before = storageVersion(f.home);
  const data = readCompareData(f.home, config.compare);
  assert.equal(data.entries.some(e => e.kind === 'old-unrelated'), false);
  assert.equal(rows(compareReport(f.home))[0].independentSamples, 1);
  storageSnapshot(f.home, db => {
    for (const [label, sql, args] of [['pick', PICK_COUNT_SQL, [200, epoch]],
      ['report', REPORT_SQL, [200]], ['head', REPORT_HEAD_SQL, ['works/test/work/events.jsonl']]]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => r.detail);
      console.log(`EXPLAIN ${label}: ${plan.join(' / ')}`);
      assert.ok(plan.some(s => /SEARCH .* (INTEGER PRIMARY KEY \(rowid>\?\)|INDEX .*\(stream=\?\))/.test(s)), plan);
      assert.equal(plan.some(s => /SCAN events/.test(s)), false);
    }
  });
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [cli, 'runners', 'report', ...args],
    {env: {...process.env, KADAN_HOME: f.home}, encoding: 'utf8', timeout: 15000});
  const json = run('--json'); assert.equal(json.status, 0, json.stderr);
  assert.equal(rows(JSON.parse(json.stdout))[0].completedSamples, 1);
  const plain = run(); assert.equal(plain.status, 0, plain.stderr); assert.match(plain.stdout, /^비교 결과/);
  console.log(`CLI report:\n${plain.stdout}`);
  assert.equal(rows(JSON.parse(run('--json', '--since', stamp(30)).stdout)).length, 0);
  assert.notEqual(run('--since', 'broken').status, 0);
  assert.equal(storageVersion(f.home), before);
});
