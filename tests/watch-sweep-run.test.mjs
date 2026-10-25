import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSweepDiagnostics, createSweepPolicy} from '../src/watch-sweep-policy.mjs';
import {createSweepRunner} from '../src/watch-sweep-run.mjs';

const setup = (results, {light = () => ({items: [], mismatches: []}), intervalMs = 1000} = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-run-'));
  let clock = 0, resets = 0, fulls = 0;
  const policy = createSweepPolicy({diagnostics: createSweepDiagnostics(dir), now: () => clock, userRecipient: '@user'});
  const engine = {light, full: async () => { fulls++;return results.shift() ?? {status: 'match', diffs: []}; }};
  const runner = createSweepRunner({engine, policy, reset: () => { resets++; }, now: () => clock, intervalMs, lightEvery: 1});
  return {runner, policy, dir, fulls: () => fulls, resets: () => resets, at: value => { clock = value; }};
};

test('시작 때 한 번 돌고, 정기 간격 전에는 다시 돌지 않는다', async () => {
  const s = setup([]);
  s.runner.tick();await s.runner.idle();
  assert.equal(s.fulls(), 1);
  s.at(500);s.runner.tick();await s.runner.idle();
  assert.equal(s.fulls(), 1);
  s.at(1000);s.runner.tick();await s.runner.idle();
  assert.equal(s.fulls(), 2);
});

test('차이가 나면 교체하고 보류·경보를 알리며, 다음 대조가 일치하면 풀린다', async () => {
  const s = setup([{status: 'diff', diffs: [{key: 'ledger-array', fingerprint: 'f', detail: 'd'}]}]);
  s.runner.tick();await s.runner.idle();
  assert.equal(s.resets(), 1);
  const held = s.runner.tick();
  assert.equal(held.holding, true);
  assert.equal(held.alerts[0].id, 'sweep-hold:ledger-array');
  s.at(1000);s.runner.tick();await s.runner.idle();
  const after = s.runner.tick();
  assert.equal(after.holding, false);
  assert.deepEqual(after.alerts, []);
});

test('F1: 가벼운 대조 불일치는 쿨다운 안에서도 바로 보류하고, 검증된 전체 대조 일치로만 풀린다', async () => {
  const bad = {items: [{name: '커서 대 최대 순번 mail', incremental: 1, sql: 2}], mismatches: [{name: '커서 대 최대 순번 mail', incremental: 1, sql: 2}]};
  let mismatch = {items: [], mismatches: []};
  const s = setup([], {light: () => mismatch, intervalMs: 10 ** 12});
  s.runner.tick();await s.runner.idle();
  assert.equal(s.fulls(), 1);                  // 시작(일치)
  assert.equal(s.runner.tick().holding, false);
  s.at(1000);mismatch = bad;
  const held = s.runner.tick();await s.runner.idle();
  assert.equal(s.fulls(), 1);                  // 쿨다운(10분) 안이라 전체 대조는 다시 돌지 않는다
  assert.equal(held.holding, true);            // 그래도 자동 행동은 바로 보류
  assert.match(held.alerts[0].id, /^sweep-hold:light:/u);
  s.at(2000);mismatch = {items: [], mismatches: []};
  assert.equal(s.runner.tick().holding, true); // 불일치가 사라져도 검증된 전체 대조 일치 전에는 풀리지 않는다
  s.at(700_000);mismatch = bad;
  s.runner.tick();await s.runner.idle();       // 쿨다운 뒤 불일치 → 전체 대조(일치) → 해제
  assert.equal(s.fulls(), 2);
  mismatch = {items: [], mismatches: []};
  assert.equal(s.runner.tick().holding, false);
  assert.ok(createSweepDiagnostics(s.dir).rows().some(row => row.kind === 'light-mismatch'));
});

test('F4: 대조 중 예외와 진단 기록 실패는 자동 행동 허용으로 이어지지 않는다(예전 기대 holding=false를 정책에 맞게 바꿈)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-run-'));
  const errors = [];
  const runner = createSweepRunner({engine: {light: () => ({items: [], mismatches: []}), full: async () => { throw new Error('boom'); }},
    policy: createSweepPolicy({diagnostics: createSweepDiagnostics(dir)}), reset() {}, onError: error => errors.push(error.message)});
  runner.tick();await runner.idle();
  assert.deepEqual(errors, ['boom']);
  const state = runner.tick();
  assert.equal(state.holding, true);                     // 예외도 안전한 쪽(보류)이다
  assert.ok(state.alerts.some(alert => alert.id === 'sweep-hold:sweep-engine'));
  // 진단 파일을 쓸 수 없어도 같다.
  const broken = createSweepPolicy({diagnostics: {rows: () => [], append() { throw new Error('EACCES'); }}});
  const runner2 = createSweepRunner({engine: {light: () => ({items: [], mismatches: []}),
    full: async () => ({status: 'error', error: '원본 조회 실패', errorKey: 'ledger-source', diffs: []})}, policy: broken, reset() {}});
  runner2.tick();await runner2.idle();
  assert.equal(runner2.tick().holding, true);
  assert.ok(runner2.tick().alerts.some(alert => alert.id === 'sweep-hold:ledger-source'));
});
