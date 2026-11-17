import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendLedger } from '../src/ledger.mjs';
import { floor } from '../src/floor.mjs';
import { centerSummary } from '../src/center-summary.mjs';
import { createWallSnapshotLoader } from '../src/commands/tree-wall.mjs';
import { wallCache } from '../src/wall-snapshot-cache.mjs';
import { startDigest } from '../src/secretary-resume.mjs';

const first = {
  t: '2036-11-02T00:01:00Z',
  kind: 'start', role: '시각-통합', session: 'kadan-시각-통합', panePid: 101,
  roleProfile: 'worker', rottieTerminalId: 'first-tab',
};
const entries = [first, {
  ...first, panePid: 102, rottieTerminalId: 'next-tab', roleProfile: 'reviewer',
  t: '2036-11-02T00:02:00Z', restartOf: startDigest(first),
}];
const sessions = [
  { session: first.session, pid: 102, alive: true },
  { session: 'kadan-시각-기록없음', pid: 103, alive: true },
];

function fixture(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-first-started-'));
  const originalHome = process.env.KADAN_HOME;
  const originalList = floor.list;
  process.env.KADAN_HOME = home;
  floor.list = () => sessions;
  wallCache.clear();
  try {
    for (const entry of entries) appendLedger(entry, home);
    return fn(home);
  } finally {
    floor.list = originalList;
    process.env.KADAN_HOME = originalHome;
    wallCache.clear();
  }
}

test('tree 요약: 처음 시각을 내보내고 기존 프로필·실행 종류·교체 목록은 그대로다', () => fixture(() => {
  const loader = createWallSnapshotLoader(null, { listOnly: true, summaryBodies: true });
  const snapshot = loader.build(loader.read());
  assert.equal(snapshot.centerError, null);
  const live = centerSummary(snapshot.center).liveRoles;
  const role = live.find(r => r.role === first.role);
  assert.equal(role.firstStartedAt, first.t);
  assert.equal(role.roleProfile, 'reviewer');
  assert.equal(role.executionKind, null);
  assert.deepEqual(role.supersedes, [{
    source: 'restart', rottieTerminalId: 'first-tab', panePid: '101', conversation: null,
  }]);
  assert.equal(live.find(r => r.role === '시각-기록없음').firstStartedAt, null);
  assert.ok(live.every(r => r.life.state === 'alive'));
}));

test('tree 기억: 같은 사건의 두 번째 요약과 무관한 사건 추가는 계보를 다시 만들지 않는다', () => fixture(home => {
  const loader = createWallSnapshotLoader(null, { listOnly: true });
  const initialMisses = wallCache.stats().lineage?.miss ?? 0;
  const firstSummary = centerSummary(loader.build(loader.read()).center);
  const before = wallCache.stats().lineage;
  assert.equal(before.miss, initialMisses + 1);
  const secondSummary = centerSummary(loader.build(loader.read()).center);
  assert.deepEqual(secondSummary.liveRoles, firstSummary.liveRoles);
  assert.deepEqual(wallCache.stats().lineage, { miss: before.miss, hit: before.hit + 1 });
  appendLedger({ kind: 'note', text: '트리와 무관한 사건', t: '2036-11-02T00:03:00Z' }, home);
  assert.deepEqual(centerSummary(loader.build(loader.read()).center).liveRoles, firstSummary.liveRoles);
  assert.equal(wallCache.stats().lineage.miss, before.miss);
  appendLedger({ ...first, t: '2036-11-02T00:04:00Z', panePid: 102 }, home);
  const updated = centerSummary(loader.build(loader.read()).center).liveRoles.find(r => r.role === first.role);
  assert.equal(updated.firstStartedAt, first.t);
  assert.equal(wallCache.stats().lineage.miss, before.miss + 1);
}));

test('가짜 홈의 실제 kadan tree 명령: 값과 null을 모두 내보낸다(서버·tmux 호출 없음)', () => fixture(home => {
  const preload = path.join(home, 'fake-floor.mjs');
  const cli = new URL('../src/cli.mjs', import.meta.url);
  const floorModule = new URL('../src/floor.mjs', import.meta.url);
  fs.writeFileSync(preload,
    `import childProcess from 'node:child_process';\n` +
    `import { syncBuiltinESMExports } from 'node:module';\n` +
    `import { floor } from ${JSON.stringify(floorModule.href)};\n` +
    `const spawn = childProcess.spawnSync;\n` +
    `childProcess.spawnSync = (cmd, ...args) => cmd === 'tmux'\n` +
    `  ? { status: 1, stdout: '', stderr: 'fixture: tmux disabled' } : spawn(cmd, ...args);\n` +
    `syncBuiltinESMExports();\n` +
    `floor.list = () => ${JSON.stringify(sessions)};\n`);
  const result = spawnSync(process.execPath, ['--import', preload, cli.pathname, 'tree'], {
    env: { ...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off' },
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const live = JSON.parse(result.stdout).liveRoles;
  assert.equal(live.find(r => r.role === first.role).firstStartedAt, first.t);
  assert.equal(live.find(r => r.role === '시각-기록없음').firstStartedAt, null);
  console.log(`가짜 KADAN_HOME: ${home}`);
  console.log(`kadan tree liveRoles 원문: ${JSON.stringify(live)}`);
}));
