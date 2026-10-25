import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSweepDiagnostics, createSweepPolicy} from '../src/watch-sweep-policy.mjs';
import {createSweepRunner} from '../src/watch-sweep-run.mjs';

const setup = (results, {light = () => ({items: [], mismatches: []})} = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-run-'));
  let clock = 0, resets = 0, fulls = 0;
  const policy = createSweepPolicy({diagnostics: createSweepDiagnostics(dir), now: () => clock, userRecipient: '@user'});
  const engine = {light, full: async () => { fulls++;return results.shift() ?? {status: 'match', diffs: []}; }};
  const runner = createSweepRunner({engine, policy, reset: () => { resets++; }, now: () => clock, intervalMs: 1000, lightEvery: 1});
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

test('가벼운 대조 불일치는 즉시 전체 대조를 부르되 쿨다운 안에서는 다시 부르지 않고 불일치를 기록한다', async () => {
  const mismatch = {items: [{name: 'x', incremental: 1, sql: 2}], mismatches: [{name: 'x', incremental: 1, sql: 2}]};
  const s = setup([], {light: () => mismatch});
  s.runner.tick();await s.runner.idle();
  assert.equal(s.fulls(), 1);                 // 시작
  s.at(100);s.runner.tick();await s.runner.idle();
  assert.equal(s.fulls(), 1);                 // 쿨다운(10분) 안
  s.at(700_000);s.runner.tick();await s.runner.idle();
  assert.equal(s.fulls(), 2);
  const rows = createSweepDiagnostics(s.dir).rows().filter(row => row.kind === 'light-mismatch');
  assert.ok(rows.length >= 2);
});

test('대조 중 예외는 감시를 멈추지 않고 onError로 알린다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-sweep-run-'));
  const errors = [];
  const runner = createSweepRunner({engine: {light: () => ({items: [], mismatches: []}), full: async () => { throw new Error('boom'); }},
    policy: createSweepPolicy({diagnostics: createSweepDiagnostics(dir)}), reset() {}, onError: error => errors.push(error.message)});
  runner.tick();await runner.idle();
  assert.deepEqual(errors, ['boom']);
  assert.equal(runner.tick().holding, false);
});
