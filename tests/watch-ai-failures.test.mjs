import test from 'node:test';
import assert from 'node:assert/strict';
import {aiFailureRuns, targetFailureDue, allFailureDue, aiTargetKey,
  TARGET_FAILS, TARGET_SPAN_MS, ALL_FAILS, ALL_TARGETS, ALL_SPAN_MS, LOOKBACK_MS} from '../src/watch-ai-failures.mjs';

// 원장의 점검 호출 기록에서 연속 실패를 세는 순수 함수. 역할 이름은 가짜다.
const epoch = Date.parse('2026-09-09T00:00:00Z'), MIN = 60_000;
const at = minute => new Date(epoch + minute * MIN).toISOString();
let seq = 0;
const call = (minute, role, reason, over = {}) => ({kind: 'watch-ai-call', source: 'supervisor-health', role, taskId: null, reason,
  requestId: `r${++seq}`, t: at(minute), ...over});
const key = role => aiTargetKey({source: 'supervisor-health', role, taskId: null});

test('같은 대상의 끝에서부터 연속 실패만 센다: 성공이 끼면 다시 센다', () => {
  const entries = [call(0, 'a', 'timeout'), call(60, 'a', 'reported'), call(120, 'a', 'report-missing'), call(180, 'a', 'call-failed')];
  const run = aiFailureRuns(entries, epoch + 180 * MIN).target(key('a'));
  assert.deepEqual(run, {count: 2, since: epoch + 120 * MIN});
  assert.equal(aiFailureRuns([...entries, call(240, 'a', 'reported')], epoch + 240 * MIN).target(key('a')).count, 0);
  assert.deepEqual(aiFailureRuns(entries, epoch + 180 * MIN).target(key('없는 대상')), {count: 0, since: null});
});

test('대체 후보 시도는 점검 한 번으로 센다: 앞 시도는 세지 않고 마지막 시도의 결과가 점검의 결과다', () => {
  const first = call(0, 'a', 'timeout'), second = call(5, 'a', 'timeout', {previousRequestId: first.requestId});
  const third = call(10, 'a', 'call-failed', {previousRequestId: second.requestId});
  assert.equal(aiFailureRuns([first, second, third], epoch + 10 * MIN).target(key('a')).count, 1);
  // 마지막 시도가 성공이면 그 점검은 성공이다.
  const ok = call(10, 'a', 'reported', {previousRequestId: second.requestId});
  assert.equal(aiFailureRuns([first, second, ok], epoch + 10 * MIN).target(key('a')).count, 0);
});

test('취소·잠자기·인터넷 없음은 실패로도 성공으로도 세지 않는다', () => {
  const entries = [call(0, 'a', 'timeout'), call(10, 'a', 'cancelled'), call(20, 'a', 'slept'), call(30, 'a', 'network'), call(60, 'a', 'report-missing')];
  const runs = aiFailureRuns(entries, epoch + 60 * MIN);
  assert.deepEqual(runs.target(key('a')), {count: 2, since: epoch});
  assert.equal(runs.all.count, 2);
});

test('대상 무관 연속 실패: 어느 대상이든 성공이 끼면 끊긴다', () => {
  const entries = [call(0, 'a', 'timeout'), call(1, 'b', 'reported'), call(2, 'b', 'timeout'), call(3, 'c', 'report-missing'), call(20, 'a', 'timeout')];
  const {all, target} = aiFailureRuns(entries, epoch + 20 * MIN);
  assert.equal(all.count, 3); assert.equal(all.targets.size, 3); assert.equal(all.since, epoch + 2 * MIN);
  // 대상 a는 다른 대상의 성공과 상관없이 자기 기록만 본다.
  assert.deepEqual(target(key('a')), {count: 2, since: epoch});
});

test('아직 원장 배열에 없는 이번 호출 기록을 맨 뒤에 붙여 센다', () => {
  const entries = [call(0, 'a', 'timeout')];
  const extra = [{kind: 'watch-ai-call', source: 'supervisor-health', role: 'a', taskId: null, reason: 'report-error', requestId: null, t: at(60)}];
  assert.deepEqual(aiFailureRuns(entries, epoch + 60 * MIN, extra).target(key('a')), {count: 2, since: epoch});
});

test('하루보다 오래된 호출 기록은 보지 않는다. 다른 사건의 옛 시각은 구간을 끊지 않는다', () => {
  const old = call(0, 'a', 'timeout'), now = epoch + LOOKBACK_MS + 10 * MIN;
  const recent = call((LOOKBACK_MS + 10 * MIN) / MIN, 'a', 'timeout');
  assert.equal(aiFailureRuns([old, {kind: 'watch-cycle', t: at(1)}, recent], now).target(key('a')).count, 1);
  // 뒤쪽에 옛 시각을 단 다른 사건이 섞여 있어도 그 앞의 최근 호출 기록까지 센다.
  const first = call(60, 'b', 'timeout'), second = call(120, 'b', 'timeout');
  const stale = {kind: 'start', role: 'b', t: '2000-01-01T00:00:00.000Z'};
  assert.equal(aiFailureRuns([first, stale, second, stale], epoch + 120 * MIN).target(key('b')).count, 2);
});

test('올릴 기준: 같은 대상은 연속 2번이면서 30분, 전체는 연속 3번·대상 2개·15분', () => {
  assert.deepEqual([TARGET_FAILS, TARGET_SPAN_MS, ALL_FAILS, ALL_TARGETS, ALL_SPAN_MS], [2, 30 * MIN, 3, 2, 15 * MIN]);
  const now = epoch + 60 * MIN;
  assert.equal(targetFailureDue({count: 1, since: epoch}, now), false, '한 번은 올리지 않는다');
  assert.equal(targetFailureDue({count: 2, since: now - 29 * MIN}, now), false, '짧은 시간 안의 두 번은 올리지 않는다');
  assert.equal(targetFailureDue({count: 2, since: now - 30 * MIN}, now), true);
  assert.equal(targetFailureDue({count: 5, since: null}, now), false, '시각을 모르면 시간 조건을 채우지 못한 것이다');
  const all = (count, targets, minutes) => ({count, targets: new Set(Array.from({length: targets}, (_, i) => i)), since: now - minutes * MIN});
  assert.equal(allFailureDue(all(3, 1, 60), now), false, '한 대상만 실패하면 전체 장애가 아니다');
  assert.equal(allFailureDue(all(2, 2, 60), now), false);
  assert.equal(allFailureDue(all(3, 2, 14), now), false);
  assert.equal(allFailureDue(all(3, 2, 15), now), true);
});
