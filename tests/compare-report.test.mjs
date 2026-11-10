import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {compareFixture, choice} from './helpers/compare-fixture.mjs';
import {calculateCompareReport, compareReport, formatCompareReport, relativeRounds} from '../src/compare-report.mjs';
import {readCompareData, ORDER_SLACK_MS, REPORT_SQL, REPORT_HEAD_SQL, REPORT_PROBE_SQL,
  REPORT_FIRST_SQL} from '../src/compare-report-data.mjs';
import {PICK_COUNT_SQL} from '../src/runner-compare.mjs';
import {readSettings} from '../src/runner-settings.mjs';
import {appendStream, storageSnapshot, storageTransaction, storageVersion} from '../src/storage.mjs';

const epoch = '2026-10-27T00:00:00.000Z';
const stamp = minutes => new Date(Date.parse(epoch) + minutes * 60000).toISOString();
function fixture() {
  const data = {entries: [], works: [], cards: []};
  const add = ({work = 'test/work', preset = 'A', round = 1, passRound = round, failed = false,
    pending = false, reviewer = 'claude-one', worker = 'gpt-one', fallback = null, review = true,
    role = null, compare = true, phase = 'implementation'} = {}) => {
    const n = data.entries.length, key = `test/${phase.slice(0, 4)}-${n}`, reviewKey = `test/review-${n}`;
    let w = data.works.find(w => w.key === work);
    if (!w) { w = {key: work, status: 'open', executions: []}; data.works.push(w); }
    const workerRole = role ?? `test-worker-${n}`, reviewRole = `test-reviewer-${n}`, pickId = `pick-${n}`;
    const pick = {kind: 'compare-pick', pickId, preset, role: workerRole, epoch, t: stamp(0),
      worker: choice(worker), reviewer: choice(reviewer, 'high')};
    const start = {kind: 'start', role: workerRole, cmd: 'fake', roleProfile: 'worker',
      compareMode: true, settingsPreset: preset, pickId, t: stamp(0)};
    const send = {kind: 'send', taskId: key.split('/')[1], executionKey: key, workKey: work,
      role: workerRole, compareMode: compare && fallback !== 'worker', settingsPreset: preset,
      pickId: compare ? pickId : null,
      launchSource: fallback === 'worker' ? 'fallback' : 'settings',
      runnerChoice: choice(worker), t: stamp(1)};
    // 비교가 꺼진 발령에는 예약도 비교 표시도 없다. 귀속 값(runnerChoice·launchSource)만 남는다.
    data.entries.push(...(compare ? [pick, start] : []), send);
    w.executions.push({key, phase, round});
    if (!pending) data.entries.push({kind: 'done', taskId: key.split('/')[1], executionKey: key,
      role: workerRole, result: failed ? 'failed' : 'ok', t: stamp(11)});
    if (review) {
      w.executions.push({key: reviewKey, phase: 'review', round: passRound ?? round});
      data.entries.push({kind: 'send', taskId: reviewKey.split('/')[1], executionKey: reviewKey, workKey: work,
        role: reviewRole, reviewFor: {role: workerRole}, compareMode: compare && fallback !== 'reviewer',
        settingsPreset: preset, pickId: compare ? pickId : null,
        launchSource: fallback === 'reviewer' ? 'fallback' : 'review-for',
        runnerChoice: choice(reviewer, 'high'), t: stamp(12)});
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
  const report = calculateCompareReport(f.data);
  assert.equal(report.groups.length, 2);
  const row = rows(report).find(r => r.presets.includes('A'));
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

test('같은 조합은 프리셋이 달라도 한 행, 첫 구현이 기간 밖이면 업무 전체 제외', () => {
  const f = fixture(); f.add();
  const other = f.add({preset: 'B'}); other.send.t = stamp(30);
  f.add({work: 'test/second', preset: 'C'});
  const report = calculateCompareReport(f.data, {since: stamp(0)});
  assert.equal(rows(report).length, 1);
  assert.deepEqual(rows(report)[0].presets, ['A', 'B', 'C']);
  assert.equal(rows(report)[0].independentSamples, 2);
  assert.equal(rows(report)[0].samples, 3);
  assert.deepEqual(report.mixed, {});
  assert.equal(rows(calculateCompareReport(f.data, {since: stamp(25)})).length, 0);
});

test('비교가 꺼진 발령도 집계하고, 검수 발령이 아직 없으면 검수 발령 없음 묶음에 둔다', () => {
  const f = fixture();
  f.add({compare: false, preset: 'B', worker: 'claude-one', reviewer: 'gpt-one'});
  f.add({work: 'test/no-review', compare: false, preset: 'B', worker: 'claude-one', review: false, pending: true});
  assert.equal(f.data.entries.some(e => e.kind === 'compare-pick' || e.compareMode), false);
  const report = calculateCompareReport(f.data);
  assert.equal(report.groups.length, 2);
  const [reviewed, waiting] = report.groups;
  assert.deepEqual(reviewed.reviewer, choice('gpt-one', 'high'));
  assert.equal(reviewed.rows[0].independentSamples, 1);
  assert.equal(reviewed.rows[0].firstRoundPasses, 1);
  assert.equal(reviewed.rows[0].launch, null);
  assert.equal(waiting.reviewer, null);
  assert.equal(waiting.rows[0].inProgress, 1);
  assert.equal(report.unknown.count, 0);
  assert.match(formatCompareReport(report), /^조합별 성과[^\n]*\n\n검수자 codex\/gpt-one\/high/);
  assert.match(formatCompareReport(report), /검수자 검수 발령 없음/);
});

test('귀속 불명: runnerChoice나 띄운 방식이 없는 발령·연결 안 된 발령은 추정하지 않는다', () => {
  const f = fixture();
  f.add();
  delete f.add({work: 'test/no-choice', compare: false}).send.runnerChoice;
  f.add({work: 'test/no-source', compare: false}).send.launchSource = null;
  const review = f.add({work: 'test/review-no-choice', compare: false});
  delete f.data.entries.find(e => e.executionKey === review.reviewKey && e.kind === 'send').runnerChoice;
  f.data.entries.push({kind: 'send', taskId: 'lost', executionKey: 'test/lost', role: 'test-lost',
    runnerChoice: choice('gpt-one'), launchSource: 'settings', t: stamp(1)});
  const report = calculateCompareReport(f.data);
  assert.deepEqual(report.unknown.workIds, ['test/no-choice', 'test/no-source', 'test/review-no-choice']);
  assert.equal(report.unknown.count, 3);
  assert.deepEqual(report.unknown.unlinkedCards, ['test/lost']);
  assert.equal(rows(report).length, 1);
  assert.equal(rows(report)[0].independentSamples, 1);
  assert.match(formatCompareReport(report), /귀속 불명 3: test\/no-choice/);
});

test('수정(fix) 발령의 조합이 다르면 작업자 변경으로 섞임, 같으면 그대로 센다', () => {
  const f = fixture();
  f.add({passRound: null, role: 'test-changed'});
  f.add({phase: 'fix', round: 2, worker: 'gpt-two', role: 'test-changed', compare: false});
  f.add({work: 'test/same', passRound: null, role: 'test-same'});
  f.add({work: 'test/same', phase: 'fix', round: 2, role: 'test-same', compare: false});
  const report = calculateCompareReport(f.data);
  const row = rows(report)[0];
  assert.deepEqual(row.mixed, {'작업자 변경': 1});
  assert.deepEqual(row.mixedWorkIds, ['test/work']);
  assert.deepEqual(row.workIds, ['test/same']);
  assert.equal(row.samples, 1); assert.equal(row.medianRounds, 2);
  assert.deepEqual(report.mixed, {'작업자 변경': 1});
});

test('기간: --since·--until은 첫 구현 발령 시각으로 업무를 고르고, 기본은 최근 14일', () => {
  const f = fixture();
  f.add({work: 'test/early', compare: false}).send.t = stamp(-60);
  f.add({work: 'test/inside', compare: false});
  f.add({work: 'test/late', compare: false}).send.t = stamp(120);
  const ids = options => rows(calculateCompareReport(f.data, options)).flatMap(r => r.workIds);
  assert.deepEqual(ids(), ['test/early', 'test/inside', 'test/late']);
  assert.deepEqual(ids({since: stamp(0)}), ['test/inside', 'test/late']);
  assert.deepEqual(ids({until: stamp(60)}), ['test/early', 'test/inside']);
  assert.deepEqual(ids({since: stamp(0), until: stamp(60)}), ['test/inside']);
  // 기간 끝 뒤에 난 검수 결과도 그 업무의 성과로 센다(끝 시각은 업무를 고르기만 한다).
  assert.equal(rows(calculateCompareReport(f.data, {since: stamp(0), until: stamp(5)}))[0].firstRoundPasses, 1);
  assert.throws(() => calculateCompareReport(f.data, {since: stamp(60), until: stamp(0)}), /--until보다 늦다/);
  assert.throws(() => calculateCompareReport(f.data, {until: 'broken'}), /--until에는 ISO/);
  const home = compareFixture();
  for (const entry of f.data.entries) home.record(entry);
  for (const work of f.data.works) appendStream(home.home, `works/${work.key}/events.jsonl`, work);
  for (const card of f.data.cards) appendStream(home.home, `cards/${card.key}/events.jsonl`, card);
  const at = days => () => new Date(Date.parse(epoch) + days * 86400000);
  const recent = compareReport(home.home, {now: at(5)});
  assert.equal(recent.since, new Date(Date.parse(epoch) - 9 * 86400000).toISOString());
  assert.equal(rows(recent)[0].independentSamples, 3);
  assert.equal(rows(compareReport(home.home, {now: at(20)})).length, 0);
  assert.equal(rows(compareReport(home.home, {now: at(20), until: stamp(60)}))[0].independentSamples, 2);
});

test('순차 2·3라운드는 업무 첫 구현부터 세고 첫 라운드 시간만 집계한다', () => {
  for (const rounds of [2, 3]) {
    const f = fixture();
    for (let round = 1; round <= rounds; round++) {
      const run = f.add({round, passRound: round === rounds ? round : null, role: 'test-sequential'});
      run.send.t = stamp((round - 1) * 40 + 1);
      const done = f.data.entries.find(e => e.kind === 'done' && e.executionKey === run.key);
      done.t = stamp((round - 1) * 40 + 1 + round * 10);
    }
    const row = rows(calculateCompareReport(f.data))[0];
    assert.equal(row.independentSamples, 1);
    assert.equal(row.samples, rounds);
    assert.equal(row.medianRounds, rounds);
    assert.equal(row.firstRoundPasses, 0);
    assert.equal(row.medianImplementationMs, 600000);
    const since = calculateCompareReport(f.data, {since: stamp(25)});
    assert.equal(rows(since).reduce((sum, r) => sum + r.independentSamples, 0), 0);
  }
});

test('병렬 갈래는 모두 통과해야 하며 가장 늦은 갈래의 첫 pass로 왕복을 센다', () => {
  for (const [bPass, expected] of [[null, null], [1, 1], [2, 2]]) {
    const f = fixture();
    f.add({role: 'test-a'});
    f.add({role: 'test-b', passRound: bPass === 1 ? 1 : null});
    if (bPass === 2) f.add({role: 'test-b', round: 2, passRound: 2});
    const row = rows(calculateCompareReport(f.data))[0];
    assert.equal(row.independentSamples, 1);
    assert.equal(row.completedSamples, bPass === null ? 0 : 1);
    assert.equal(row.inProgress, bPass === null ? 1 : 0);
    assert.equal(row.firstRoundPasses, expected === 1 ? 1 : 0);
    assert.equal(row.medianRounds, expected);
  }
  const f = fixture();
  f.add({role: 'test-a'});
  f.add({role: 'test-b', pending: true});
  const row = rows(calculateCompareReport(f.data))[0];
  assert.equal(row.completedSamples, 0);
  assert.equal(row.inProgress, 1);
  assert.equal(row.firstRoundPasses, 0);
  assert.equal(row.medianRounds, null);
  const finished = fixture();
  finished.add({role: 'test-a'});
  const other = finished.add({role: 'test-b', passRound: null});
  finished.data.cards = finished.data.cards.filter(card => card.key !== other.reviewKey);
  const withoutPass = rows(calculateCompareReport(finished.data))[0];
  assert.equal(withoutPass.completedSamples, 0, '열린 업무는 모두 done이어도 진행 중');
  assert.equal(withoutPass.inProgress, 1);
  assert.equal(withoutPass.firstRoundPasses, 0);
  assert.equal(withoutPass.medianRounds, null);
});

test('미통과 갈래의 분모 포함 여부는 실행 done이 아니라 업무 상태로 정한다', () => {
  for (const status of ['open', 'hold', 'done', 'cancelled']) {
    for (const scenario of ['no-review', 'second-review', 'changes', 'exception', 'parallel', 'pending']) {
      const f = fixture();
      if (scenario === 'second-review') {
        f.add({role: 'test-a', passRound: null});
        f.add({role: 'test-a', round: 2, review: false});
      } else if (scenario === 'parallel') {
        f.add({role: 'test-a'});
        f.add({role: 'test-b', passRound: null});
      } else {
        const run = f.add({review: scenario !== 'no-review', passRound: null,
          pending: scenario === 'pending'});
        if (scenario === 'exception') {
          f.data.cards.find(card => card.key === run.reviewKey).result.outcome = 'exception';
        }
      }
      f.data.works[0].status = status;
      const row = rows(calculateCompareReport(f.data))[0];
      const closed = ['done', 'cancelled'].includes(status);
      assert.equal(row.completedSamples, closed ? 1 : 0, `${status}/${scenario}`);
      assert.equal(row.inProgress, closed ? 0 : 1, `${status}/${scenario}`);
      assert.equal(row.firstRoundPasses, 0);
      assert.equal(row.medianRounds, null);
    }
  }
});

test('명시 명령·폴백으로 띄운 업무는 같은 조합이라도 표시가 붙은 별도 행으로 센다', () => {
  const f = fixture();
  f.add();
  for (const [preset, launchSource] of [[null, 'override'], ['outside', 'fallback']]) {
    const run = f.add({work: `test/${launchSource}`, fallback: 'worker', preset});
    run.send.launchSource = launchSource;
    delete run.send.pickId;
    f.data.entries = f.data.entries.filter(e => e !== run.pick && e !== run.start);
  }
  const both = f.add({work: 'test/both', fallback: 'worker'});
  both.send.launchSource = 'override';
  f.data.entries.find(e => e.executionKey === both.reviewKey && e.kind === 'send').launchSource = 'fallback';
  const report = calculateCompareReport(f.data);
  assert.equal(report.groups.length, 1);
  assert.deepEqual(rows(report).map(r => [r.launch, r.independentSamples, r.firstRoundPasses]),
    [[null, 1, 1], ['명시 명령', 1, 1], ['폴백', 1, 1], ['명시 명령·폴백', 1, 1]]);
  assert.deepEqual(rows(report).map(r => r.presets), [['A'], [], ['outside'], ['A']]);
  assert.equal(new Set(rows(report).map(r => JSON.stringify(r.worker))).size, 1);
  assert.match(formatCompareReport(report), /codex\/gpt-one\/medium \[폴백\] \| 1 \| 1 \| 1\/1/);
});

test('미완료는 비율 분모에서 제외, failed는 별도 열, 미통과는 통과로 세지 않는다', () => {
  const f = fixture(); f.add(); f.add({work: 'test/pending', pending: true});
  f.add({work: 'test/failed', failed: true, review: false});
  f.add({work: 'test/changes', passRound: null});
  for (const work of f.data.works) {
    if (['test/failed', 'test/changes'].includes(work.key)) work.status = 'done';
  }
  const row = rows(calculateCompareReport(f.data))[0];
  assert.equal(row.independentSamples, 4); assert.equal(row.completedSamples, 3);
  assert.equal(row.firstRoundPassRate, 1 / 3); assert.equal(row.failed, 1); assert.equal(row.inProgress, 1);
});

test('양쪽 폴백은 폴백 행, 중간 교체는 섞임, cmd 없는 재사용은 허용', () => {
  const f = fixture();
  const worker = f.add({work: 'test/worker-fallback'});
  f.data.entries.push({...worker.send, compareMode: false, launchSource: 'fallback', t: stamp(2)});
  f.add({work: 'test/reviewer-fallback', fallback: 'reviewer'});
  f.add({work: 'test/direct-worker-fallback', fallback: 'worker'});
  const replaced = f.add({work: 'test/replaced'});
  f.data.entries.push({...replaced.start, t: stamp(2)});
  const reused = f.add({work: 'test/reused'});
  f.data.entries.push({...reused.start, cmd: undefined, t: stamp(2)});
  // 종료·PID와 무관: stop 기록이 있어도 발령 귀속을 보존한다.
  f.data.entries.push({kind: 'stop', role: reused.workerRole, t: stamp(21)});
  const report = calculateCompareReport(f.data);
  const [base, fallback] = ['', '폴백'].map(launch => rows(report).find(r => (r.launch ?? '') === launch));
  assert.equal(rows(report).length, 2);
  assert.equal(fallback.independentSamples, 3);
  assert.deepEqual(base.mixed, {'중간 교체': 1});
  assert.deepEqual(base.mixedWorkIds, ['test/replaced']);
  assert.deepEqual(report.mixed, {'중간 교체': 1});
  assert.deepEqual(base.workIds, ['test/reused']);
  assert.equal(base.independentSamples, 1);
  assert.equal(base.completedSamples, 1);
});

test('업무 안 다른 검수자는 섞임이며 시작 없는 예약은 따로 드러낸다', () => {
  const f = fixture();
  f.add({reviewer: 'claude-one'}); f.add({reviewer: 'claude-two'});
  const reservation = {...f.data.entries[0], pickId: 'only-pick', preset: 'reservation'};
  f.data.entries.push(reservation);
  const report = calculateCompareReport(f.data);
  assert.deepEqual(report.mixed, {'검수자 변경': 1});
  assert.deepEqual(report.reservationsWithoutStart, ['only-pick']);
  assert.deepEqual(calculateCompareReport(f.data, {since: stamp(5)}).reservationsWithoutStart, []);
  assert.equal(rows(report).length, 1, '예약만으로는 행을 만들지 않는다');
  assert.equal(rows(report)[0].independentSamples, 0);
});

test('SQLite 범위 조회와 실제 report CLI: 기간 앞 원장을 읽지 않음, 읽기 전후 불변, EXPLAIN', () => {
  const f = compareFixture();
  storageTransaction(f.home, () => {
    for (let i = 0; i < 200; i++) appendStream(f.home, 'test/archive',
      {kind: 'old-unrelated', t: '2020-01-01T00:00:00.000Z', text: 'old'});
  });
  // 기간보다 한참 앞선 발령 30건: 범위 하한이 이 뒤로 잡혀야 한다.
  const fake = fixture();
  for (let i = 0; i < 10; i++) fake.add({work: `test/old-${i}`});
  const oldCount = fake.data.entries.length;
  // 원장 순서가 시각과 조금 어긋난 발령(허용 폭 안): 먼저 적혔지만 기간 안이라 읽혀야 한다.
  fake.add({work: 'test/swapped'});
  const swappedCount = fake.data.entries.length;
  fake.add();
  const justBefore = {kind: 'start', role: 'test-noise', cmd: 'fake', t: stamp(-30)};
  let lastOld;
  storageTransaction(f.home, () => {
    for (const entry of fake.data.entries.slice(0, oldCount)) f.record({...entry, t: stamp(-30 * 24 * 60)});
    lastOld = storageVersion(f.home);
    for (const entry of [...fake.data.entries.slice(oldCount, swappedCount), justBefore,
      ...fake.data.entries.slice(swappedCount)]) f.record(entry);
    for (const work of fake.data.works) appendStream(f.home, `works/${work.key}/events.jsonl`, work);
    for (const card of fake.data.cards) appendStream(f.home, `cards/${card.key}/events.jsonl`, card);
  });
  assert.ok(Date.parse(epoch) - Date.parse(justBefore.t) < ORDER_SLACK_MS);
  const before = storageVersion(f.home);
  const data = readCompareData(f.home, {since: epoch});
  assert.equal(data.afterRowid, lastOld, '기간 앞 행은 읽는 범위 밖');
  assert.equal(data.entries.every(e => e.rowid > lastOld), true);
  assert.equal(data.entries.some(e => e.kind === 'old-unrelated'), false);
  assert.deepEqual(data.works.map(w => w.key).sort(), ['test/swapped', 'test/work']);
  assert.equal(readCompareData(f.home).afterRowid, 0, '기간이 없으면 처음부터');
  assert.deepEqual(rows(compareReport(f.home, {since: epoch})).flatMap(r => r.workIds),
    ['test/swapped', 'test/work']);
  storageSnapshot(f.home, db => {
    for (const [label, sql, args] of [['pick', PICK_COUNT_SQL, [200, epoch]],
      ['report', REPORT_SQL, [200]], ['probe', REPORT_PROBE_SQL, [200]],
      ['head', REPORT_HEAD_SQL, ['works/test/work/events.jsonl']],
      ['first', REPORT_FIRST_SQL, ['cards/test/review-0/events.jsonl']]]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => r.detail);
      console.log(`EXPLAIN ${label}: ${plan.join(' / ')}`);
      assert.ok(plan.some(s => /SEARCH .* (INTEGER PRIMARY KEY \(rowid>\?\)|INDEX .*\(stream=\?)/.test(s)), plan);
      assert.equal(plan.some(s => /SCAN events/.test(s)), false);
    }
  });
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [cli, 'runners', 'report', ...args],
    {env: {...process.env, KADAN_HOME: f.home}, encoding: 'utf8', timeout: 15000});
  const json = run('--json', '--since', epoch); assert.equal(json.status, 0, json.stderr);
  assert.equal(rows(JSON.parse(json.stdout))[0].completedSamples, 2);
  const plain = run('--since', epoch, '--until', stamp(60));
  assert.equal(plain.status, 0, plain.stderr); assert.match(plain.stdout, /^조합별 성과/);
  console.log(`CLI report:\n${plain.stdout}`);
  assert.equal(rows(JSON.parse(run('--json', '--since', stamp(30)).stdout)).length, 0);
  assert.equal(rows(JSON.parse(run('--json', '--since', stamp(-60), '--until', stamp(0)).stdout)).length, 0);
  // 기간을 안 주면 최근 14일: 한 달 전 발령만 있는 원장은 빈 표다.
  const recent = run('--json'); assert.equal(recent.status, 0, recent.stderr);
  assert.ok(Date.now() - Date.parse(JSON.parse(recent.stdout).since) <= 14 * 86400000 + 60000);
  assert.notEqual(run('--since', 'broken').status, 0);
  assert.notEqual(run('--until', 'broken').status, 0);
  assert.equal(storageVersion(f.home), before);
});

test('기간 앞에서 시작한 업무는 그 발령을 읽지 않고도 표본에서 뺀다', () => {
  for (const assigned of [true, false]) {
    const f = compareFixture(), fake = fixture();
    const first = fake.add({passRound: null}), second = fake.add({round: 2});
    const early = new Set([first.key, first.reviewKey]);
    storageTransaction(f.home, () => {
      // 첫 구현 카드는 기간 앞에 만들어졌다. 담당이 정해졌으면 발령된 것으로 본다.
      appendStream(f.home, `cards/${first.key}/events.jsonl`,
        {key: first.key, status: assigned ? 'done' : 'draft', role: assigned ? first.workerRole : null});
      for (const entry of fake.data.entries) {
        if (assigned && early.has(entry.executionKey)) f.record({...entry, t: stamp(-30 * 24 * 60)});
      }
      f.record({kind: 'start', role: 'test-old', cmd: 'fake', t: stamp(-29 * 24 * 60)});
      for (const entry of fake.data.entries) {
        if (entry.executionKey === second.key || entry.executionKey === second.reviewKey) f.record(entry);
      }
      appendStream(f.home, `works/${fake.data.works[0].key}/events.jsonl`, fake.data.works[0]);
      for (const card of fake.data.cards) {
        if (card.key !== first.key) appendStream(f.home, `cards/${card.key}/events.jsonl`, card);
      }
    });
    const data = readCompareData(f.home, {since: epoch});
    assert.ok(data.afterRowid > 0);
    assert.equal(data.entries.some(e => e.executionKey === first.key), false, '기간 앞 발령은 읽지 않는다');
    const report = compareReport(f.home, {since: epoch});
    assert.equal(rows(report).length, assigned ? 0 : 1, assigned ? '기간 전 시작' : '발령 안 된 초안');
    assert.equal(report.unknown.count, 0);
  }
});

test('report는 비교 설정이 없어도 기존 업무 스트림의 마지막 상태로 진행 중 여부를 읽는다', () => {
  const f = compareFixture();
  assert.equal(readSettings(f.home).compare, undefined);
  const fake = fixture(); fake.add({review: false, compare: false});
  for (const entry of fake.data.entries) f.record(entry);
  const work = fake.data.works[0];
  for (const status of ['open', 'hold', 'done', 'cancelled', 'open']) {
    appendStream(f.home, `works/${work.key}/events.jsonl`, {...work, status});
    const before = storageVersion(f.home);
    const row = rows(compareReport(f.home, {since: epoch}))[0];
    const closed = ['done', 'cancelled'].includes(status);
    assert.equal(row.completedSamples, closed ? 1 : 0);
    assert.equal(row.inProgress, closed ? 0 : 1);
    assert.equal(storageVersion(f.home), before);
  }
});
