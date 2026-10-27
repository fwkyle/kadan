import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {compareFixture} from './helpers/compare-fixture.mjs';
import {setCompare} from '../src/runner-compare.mjs';
import {readSettings} from '../src/runner-settings.mjs';
import {readLedger} from '../src/ledger.mjs';
import {guardedSend} from '../src/cli-guarded-send.mjs';
import {CardStore} from '../src/card-store.mjs';

test('격리 CLI: 10회 시작·재사용·명시 명령·폴백·검수자, 발령 귀속 저장', () => {
  const f = compareFixture();
  const bin = path.join(f.home, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexec sleep 60\n', {mode: 0o755});
  const socket = `compare-test-${process.pid}`;
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: f.home,
    KADAN_SOCKET: socket, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ALT_CHECK_MS: '0'};
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const run = (...args) => {
    const p = spawnSync(process.execPath, [cli, ...args], {env, encoding: 'utf8', timeout: 15000});
    assert.equal(p.status, 0, p.stderr); return p.stdout;
  };
  const start = (role, profile, ...extra) =>
    run('start', role, '--hidden', '--no-prompt', '--profile', profile, ...extra);
  setCompare(f.home, {enabled: true, presets: 'A,B,C,D,E', ...f.meta()});
  try {
    for (let i = 0; i < 10; i++) {
      start(`test-worker-${i}`, 'worker');
      if (i === 4) {
        start(`test-worker-${i}`, 'worker');
        start('test-reviewer', 'reviewer', '--for', `test-worker-${i}`);
        const entries = readLedger(f.home);
        const worker = entries.find(e => e.kind === 'start' && e.role === `test-worker-${i}` && e.cmd);
        const reviewer = entries.find(e => e.kind === 'start' && e.role === 'test-reviewer');
        assert.equal(reviewer.settingsPreset, 'E');
        assert.equal(reviewer.compareMode, true); assert.equal(reviewer.pickId, worker.pickId);
        assert.equal(reviewer.model, 'gpt-6.1-terra');
        for (const entry of [worker, reviewer]) {
          const store = new CardStore(f.home);
          const card = store.create({repo: 'test', id: entry.role, repoPath: f.home, body: '# 시험'});
          store.update(card.key, {status: 'assigned', role: entry.role, board: 'test', scope: '시험',
            rallyId: 'test', rallyTitle: '비교 시험', rallyRound: '1',
            rallyStep: entry.roleProfile === 'worker' ? 'implementation' : 'review'},
          {revision: 1, note: '시험 배정'});
          const sent = guardedSend({floor: {name: 'fake', alive: () => true,
            pid: () => String(entry.panePid), send: () => ({})},
          session: entry.session, role: entry.role, message: '시험', taskId: card.id,
          recordedPid: String(entry.panePid), env, readEntries: () => entries,
          record: f.record, saveBody: () => {}});
          assert.equal(sent.compareMode, true); assert.equal(sent.settingsPreset, 'E');
          assert.equal(sent.pickId, worker.pickId); assert.equal(sent.runnerChoice.model, entry.model);
        }
        run('stop', 'test-reviewer');
      }
      run('stop', `test-worker-${i}`);
    }
    start('test-override', 'worker', '--cmd', 'codex --model gpt-one --effort medium', '--reason', '시험');
    run('stop', 'test-override');
    start('test-fallback', 'worker', '--fallback', '1', '--reason', '시험');
    run('stop', 'test-fallback');
    start('test-default-reviewer', 'reviewer'); run('stop', 'test-default-reviewer');
    const entries = readLedger(f.home);
    assert.equal(entries.filter(e => e.kind === 'compare-pick').length, 10);
    assert.deepEqual(entries.filter(e => e.kind === 'start' && e.compareMode && e.roleProfile === 'worker')
      .map(e => e.settingsPreset), ['A', 'B', 'C', 'D', 'E', 'A', 'B', 'C', 'D', 'E']);
    assert.equal(entries.filter(e => e.kind === 'send' && e.taskId && e.compareMode).length, 2);
    assert.equal(readSettings(f.home).activePreset, 'A');
    for (const role of ['test-override', 'test-fallback', 'test-default-reviewer']) {
      assert.equal(entries.find(e => e.kind === 'start' && e.role === role).compareMode, undefined);
    }
  } finally { spawnSync('tmux', ['-L', socket, 'kill-server'], {env}); }
});
