import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {compareFixture, choice} from './helpers/compare-fixture.mjs';
import {compareCounts, compareState, pickCompareLaunch, setCompare} from '../src/runner-compare.mjs';
import {addPreset, blockModel, launchFor, readSettings, removePreset, renamePreset,
  setActivePreset, setRole} from '../src/runner-settings.mjs';
import {exportPreset, importPreset} from '../src/runner-export.mjs';
import {readLedger} from '../src/ledger.mjs';
import {reviewerLaunch} from '../src/reviewer-launch.mjs';
import {inspectDispatchRunnerGuard} from '../src/dispatch-runner-guard.mjs';
import {runnersCommand} from '../src/runners-command.mjs';

const enable = f => setCompare(f.home, {enabled: true, presets: 'A,B,C,D,E', ...f.meta()});

test('옛 파일 호환, CLI on/off/show, revision·이유·목록 전체 검증', () => {
  const f = compareFixture();
  assert.equal(readSettings(f.home).compare, undefined);
  const run = (argv, flags = {}) => runnersCommand(argv, flags, {home: f.home, by: 'test', record: f.record});
  assert.equal(run(['compare', 'show']).enabled, false);
  assert.throws(() => run(['compare', 'on'], {presets: 'A,B', revision: 1}), /이유/);
  assert.throws(() => run(['compare', 'on'], {presets: 'A,B', revision: 0, reason: '시험'}), /revision/);
  for (const presets of ['', 'A,A', 'A,missing']) {
    assert.throws(() => setCompare(f.home, {enabled: true, presets, ...f.meta()}), /비교/);
  }
  for (const corrupt of [s => delete s.presets.B.roles.reviewer,
    s => s.presets.B.roles.reviewer = choice('gpt-two'),
    s => s.blocked = [{model: 'gpt-two'}],
    s => s.presets.B.roles.worker = choice('missing'),
    s => s.presets.B.roles.worker.effort = 'unsupported']) {
    const s = structuredClone(f.settings); corrupt(s); f.save(s);
    assert.throws(() => enable(f), /비교 프리셋 B/);
  }
  f.save(f.settings);
  run(['compare', 'on'], {presets: 'A,B', revision: 1, reason: '시험'});
  assert.deepEqual(run(['compare', 'show']).presets, ['A', 'B']);
  assert.equal(run(['compare', 'show']).revision, 2);
  run(['compare', 'off'], {revision: 2, reason: '시험'});
  assert.equal(compareState(f.home).enabled, false);
});

test('켜진 프리셋 rename/remove/set/import/block 거절, 목록 밖 변경·끄고 수정 허용', () => {
  const f = compareFixture();
  const exported = exportPreset(f.home, {name: 'B'});
  addPreset(f.home, {name: 'other', ...f.meta()});
  enable(f);
  const unchanged = fs.readFileSync(f.file, 'utf8');
  for (const action of [
    () => renamePreset(f.home, {from: 'B', to: 'renamed', ...f.meta()}),
    () => removePreset(f.home, {name: 'B', ...f.meta()}),
    () => setRole(f.home, {role: 'worker', preset: 'B', ...choice('gpt-one'), ...f.meta()}),
    () => importPreset(f.home, {data: exported, as: 'B', replace: true, ...f.meta()}),
    () => blockModel(f.home, {model: 'gpt-two', ...f.meta()}),
  ]) {
    assert.throws(action, /먼저 `kadan runners compare off`/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), unchanged);
  }
  setRole(f.home, {role: 'worker', preset: 'other', ...choice('gpt-two'), ...f.meta()});
  setActivePreset(f.home, {preset: 'other', ...f.meta()});
  assert.equal(readSettings(f.home).compare.enabled, true);
  setCompare(f.home, {enabled: false, ...f.meta()});
  renamePreset(f.home, {from: 'B', to: 'renamed', ...f.meta()});
});

test('10번 예약은 5군에 2씩, 목록 동률 순서·새 회차·설정 손상 실패 닫힘', () => {
  const f = compareFixture(); enable(f);
  const picks = Array.from({length: 10}, (_, i) => pickCompareLaunch(f.home, `test-${i}`));
  assert.deepEqual(picks.map(p => p.preset), ['A', 'B', 'C', 'D', 'E', 'A', 'B', 'C', 'D', 'E']);
  assert.equal(new Set(picks.map(p => p.pickId)).size, 10);
  assert.deepEqual(compareCounts(f.home, readSettings(f.home).compare), {A: 2, B: 2, C: 2, D: 2, E: 2});
  assert.equal(readSettings(f.home).activePreset, 'A');
  assert.equal(readSettings(f.home).revision, 2, '예약은 설정을 저장하지 않음');
  const oldEpoch = readSettings(f.home).compare.enabledAt;
  enable(f);
  assert.notEqual(readSettings(f.home).compare.enabledAt, oldEpoch);
  assert.equal(pickCompareLaunch(f.home, 'test-next').preset, 'A');
  const s = readSettings(f.home); delete s.presets.B; f.save(s);
  assert.throws(() => pickCompareLaunch(f.home, 'test-broken'), /비교 프리셋 B/);
  assert.equal(readLedger(f.home).filter(e => e.kind === 'compare-pick').length, 11);
});

test('고정된 두 동시 예약은 같은 군을 고르지 않는다', async () => {
  const f = compareFixture(); enable(f);
  const barrier = new SharedArrayBuffer(4);
  const code = `const {parentPort, workerData} = require('node:worker_threads');
    import(workerData.module).then(({pickCompareLaunch}) => {
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      parentPort.postMessage(pickCompareLaunch(workerData.home, workerData.role).preset);
    });`;
  const workers = [0, 1].map(i => new Worker(code, {eval: true,
    workerData: {home: f.home, role: `test-race-${i}`, barrier,
      module: new URL('../src/runner-compare.mjs', import.meta.url).href}}));
  let ready = 0;
  const picked = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', value => {
      if (value !== 'ready') return resolve(value);
      if (++ready === 2) { Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0); }
    });
  })));
  assert.deepEqual(picked.sort(), ['A', 'B']);
});

test('검수자와 발령 검사는 활성값 대신 비교 start 프리셋 사용, 수정 후 거절', () => {
  const f = compareFixture(); enable(f);
  const launch = launchFor(readSettings(f.home), 'worker', 'E');
  const entry = {kind: 'start', session: 'kadan-test-worker', panePid: '41', cmd: launch.cmd,
    compareMode: true, settingsPreset: 'E', pickId: 'pick-e'};
  const selected = reviewerLaunch({settings: readSettings(f.home), entries: [entry],
    workerRole: 'test-worker', workerSession: entry.session, currentPid: '41'});
  assert.equal(selected.model, 'gpt-6.1-terra');
  assert.equal(selected.preset, 'E'); assert.equal(selected.compareMode, true);
  assert.equal(selected.pickId, 'pick-e');
  const inspect = (profile, cmd, model) => inspectDispatchRunnerGuard({home: f.home,
    role: 'test-role', session: 'kadan-test-role', profile,
    identity: {harness: 'codex', model, launch: {...entry, cmd}}});
  assert.equal(inspect('worker', launch.cmd, launch.model).result, 'pass');
  assert.equal(inspect('reviewer', selected.cmd, selected.model).result, 'pass');
  const s = readSettings(f.home); s.presets.E.roles.worker = choice('claude-two'); f.save(s);
  assert.equal(inspect('worker', launch.cmd, launch.model).result, 'reject');
  s.presets.E.roles.worker = choice(launch.model, 'high'); f.save(s);
  assert.equal(inspect('worker', launch.cmd, launch.model).code, 'compare-choice-changed');
  delete s.presets.E; f.save(s);
  assert.equal(inspect('worker', launch.cmd, launch.model).result, 'reject');
});
