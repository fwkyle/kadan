import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSweepDiagnostics, createSweepPolicy, createFullSchedule} from '../src/watch-sweep-policy.mjs';

const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-policy-'));
const diff = (key = 'ledger-array', fingerprint = 'f1') => ({key, fingerprint, detail: '배열 지문 불일치'});
const policyOf = (dir, extra = {}) => createSweepPolicy({diagnostics: createSweepDiagnostics(dir, extra), now: () => Date.parse('2026-10-25T00:00:00Z')});

test('차이는 진단 파일에 남기고 보류·경보를 만들며, 같은 항목이 일치하면 해제를 기록한다', () => {
  const dir = dirOf(), policy = policyOf(dir);
  assert.equal(policy.holding(), false);
  const first = policy.record({status: 'diff', diffs: [diff()]});
  assert.equal(first.replace, true);            // 원본 검증 성공·위치 불변이므로 교체 허용
  assert.equal(policy.holding(), true);
  assert.equal(policy.alerts()[0].id, 'sweep-hold:ledger-array');
  policy.record({status: 'match', diffs: []});
  assert.equal(policy.holding(), false);
  assert.deepEqual(policy.alerts(), []);
  const kinds = createSweepDiagnostics(dir).rows().map(row => row.kind);
  assert.deepEqual(kinds, ['pass', 'hold', 'pass', 'released']);
});

test('구분 불가(error)는 교체하지 않고 보류하며 일치 전까지 풀지 않는다, 비교 중 위치 변화(moved)는 차이로 세지 않는다', () => {
  const dir = dirOf(), policy = policyOf(dir);
  assert.equal(policy.record({status: 'moved', position: 9}).replace, false);
  assert.equal(policy.holding(), false);
  assert.equal(policy.record({status: 'error', error: '원본 검증 실패', errorKey: 'ledger-source'}).replace, false);
  assert.equal(policy.holding(), true);
  policy.record({status: 'moved'});
  assert.equal(policy.holding(), true);        // moved는 보류를 풀지 않는다
  policy.record({status: 'match', diffs: []});
  assert.equal(policy.holding(), false);
});

test('같은 키·같은 차이가 전체 대조 3번 이어지면 kyle 알림은 한 번만 나가고 재시작해도 다시 나가지 않는다', () => {
  const dir = dirOf();
  let policy = policyOf(dir);
  assert.deepEqual(policy.record({status: 'diff', diffs: [diff()]}).escalate, []);
  assert.deepEqual(policy.record({status: 'diff', diffs: [diff()]}).escalate, []);
  assert.deepEqual(policy.record({status: 'diff', diffs: [diff()]}).escalate, ['ledger-array']);
  assert.deepEqual(policy.record({status: 'diff', diffs: [diff()]}).escalate, []);
  policy = policyOf(dir);                       // 재시작
  assert.equal(policy.holding(), true);         // 보류도 진단 파일에서 복원된다
  assert.deepEqual(policy.record({status: 'diff', diffs: [diff()]}).escalate, []);
  // 차이 지문이 바뀌면 새로 센다.
  for (let n = 0; n < 2; n++) assert.deepEqual(policy.record({status: 'diff', diffs: [diff('ledger-array', 'f2')]}).escalate, []);
  assert.deepEqual(policy.record({status: 'diff', diffs: [diff('ledger-array', 'f2')]}).escalate, ['ledger-array']);
});

test('진단 파일은 상한을 넘으면 다음 순번 파일로 넘어가고 옛 파일을 지우지 않는다', () => {
  const dir = dirOf(), diagnostics = createSweepDiagnostics(dir, {maxBytes: 200});
  for (let n = 0; n < 12; n++) diagnostics.append({kind: 'pass', n, pad: 'x'.repeat(60)});
  const sequences = diagnostics.sequences();
  assert.ok(sequences.length >= 3);
  assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
  assert.equal(diagnostics.rows().length, 12);   // 옛 파일의 행이 그대로 남아 있다
  assert.ok(fs.readdirSync(dir).every(name => /^watch-sweep-diagnostics-\d{4}\.jsonl$/u.test(name)));
});

test('가벼운 대조 불일치로 즉시 전체 대조를 돌린 뒤 쿨다운 안에서는 다시 돌리지 않는다', () => {
  const schedule = createFullSchedule({intervalMs: 6 * 3600_000, cooldownMs: 600_000});
  assert.equal(schedule.due({now: 0}), 'start');
  schedule.ran(0);
  assert.equal(schedule.due({now: 1000}), null);
  assert.equal(schedule.due({now: 1000, reason: 'light-mismatch'}), null);       // 쿨다운
  assert.equal(schedule.due({now: 700_000, reason: 'light-mismatch'}), 'light-mismatch');
  schedule.ran(700_000);
  assert.equal(schedule.due({now: 700_000 + 6 * 3600_000}), 'periodic');
});
