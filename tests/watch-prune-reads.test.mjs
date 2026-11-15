import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const child = fileURLToPath(new URL('./helpers/watch-prune-reads-child.mjs', import.meta.url));
const run = (scenario, mode = 'current') => spawnSync(process.execPath, [child, root, scenario, mode],
  {cwd:root, env:process.env, encoding:'utf8', timeout:30000});

for (const scenario of ['closed', 'alive', 'recent', 'open-card', 'pending', 'reopened-card',
  'work-handover', 'work-before', 'reassigned', 'reopened', 'fresh-start', 'fresh-handover',
  'preview', 'no-file', 'cli', 'missing-lists', 'broken', 'connection']) {
  test(`정리의 전체 읽기·잠금 안 최신성·백업 동등성: ${scenario}`, () => {
    const result = run(scenario);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    if (scenario === 'connection') assert.equal(value.connected, true);
    else if (!['preview', 'no-file', 'cli'].includes(scenario)) assert.equal(value.currentReads, 0);
  });
}

test('낡은 감시 목록을 고정해서 넘긴 대조는 새 start·인계 동등성 검사를 실패시킨다', () => {
  for (const scenario of ['fresh-start', 'fresh-handover']) {
    const result = run(scenario, 'stale');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fresh\/equivalent plan/);
  }
});

test('업무 이력 없는 최신 값만 주는 대조는 후임의 책임을 잃어 동등성 검사를 실패시킨다', () => {
  const result = run('work-handover', 'latest-only');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fresh\/equivalent plan/);
});
