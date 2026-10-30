// Why: 우편 한 통이 원장 전체를 여러 번 읽으면 원장이 커질수록 한 통의 비용이 그대로 커진다(CHK-PERF-002).
// 준비 단계의 파생 계산은 읽기 하나를 같이 쓰고, 전송 직전 안전 판정(소유·PID, 답장 수신 책임자)은 새로 읽는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = process.env.SEND_READS_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers/send-ledger-reads-child.mjs');

function run(scenario) {
  const out = spawnSync(process.execPath, [child, root, scenario], {encoding: 'utf8', timeout: 60_000});
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split('\n').at(-1));
}

// 경우별 전체 읽기 횟수. 보관 경우의 우편함 읽기 1회는 Mailbox가 쓰기 직전 스스로 하는 읽기다.
for (const [scenario, total] of [['plain', 2], ['store', 2], ['reply', 3], ['work', 2], ['peer', 2]]) {
  test(`우편 한 통의 원장 읽기 횟수: ${scenario}`, () => {
    const result = run(scenario);
    assert.equal(result.outcome, 'ok', result.logs.join('\n'));
    assert.equal(result.calls.length, total, JSON.stringify(result.calls));
  });
}

test('일반 우편: guardedSend가 전송 직전에 원장을 새로 한 번 읽는다', () => {
  const result = run('plain');
  assert.equal(result.floorSends, 1);
  assert.equal(result.calls.filter(c => c.site.startsWith('src/cli-guarded-send.mjs')).length, 1);
  assert.equal(result.calls.filter(c => c.site.startsWith('src/commands/send.mjs')).length, 1);
});

test('답장: 수신 책임자 재확인은 전송 직전 새 읽기를 유지한다', () => {
  const result = run('reply');
  assert.equal(result.floorSends, 1);
  assert.equal(result.calls.filter(c => c.via.startsWith('src/cli-guarded-send.mjs')).length, 1);
});

test('준비와 전송 사이에 수신자가 새로 시작되면 옛 PID로 보내지 않고 보관한다', () => {
  const result = run('generation');
  assert.equal(result.floorSends, 0);
  assert.ok(result.logs.some(line => line.includes('바로 넣지 못해 보관했습니다')), result.logs.join('\n'));
});
