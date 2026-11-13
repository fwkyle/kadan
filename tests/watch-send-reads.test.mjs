// Why: 감시기 전송의 전체 읽기를 0으로 줄여도 전송 직전 세대·PID 보호는 같아야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = process.env.WATCH_SEND_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
const child = fileURLToPath(new URL('./helpers/watch-send-reads-child.mjs', import.meta.url));
const cache = new Map();
function run(scenario, mode = 'current') {
  const key = `${scenario}:${mode}`;
  if (!cache.has(key)) {
    const out = spawnSync(process.execPath, [child, root, scenario, mode],
      {encoding:'utf8', timeout:60_000});
    assert.equal(out.status, 0, out.stderr || out.stdout);
    cache.set(key, JSON.parse(out.stdout.trim().split('\n').at(-1)).output);
  }
  return cache.get(key);
}
const oldCounts = {sendAlert:2, sendMailReminder:2, resume429:2, sendQueueEnter:1,
  sendNudge:2, mailHold:1, user:0};
test('실제 cmdWatch 연결: 네 전송 길·유휴 알림·사전 보류의 전체 읽기 횟수 전→후', () => {
  const previous = run('plain', 'legacy'), current = run('plain');
  for (const [kind, before] of Object.entries(oldCounts)) {
    assert.equal(previous[kind].calls.filter(c => c === 'full').length, before, `${kind} 기준`);
    const expected = process.env.WATCH_SEND_BASELINE === '1' ? before : 0;
    assert.equal(current[kind].calls.filter(c => c === 'full').length, expected, `${kind} 변경 뒤`);
    assert.equal(current[kind].error, null, `${kind} 경로가 실제 실행됨`);
  }
  assert.equal(current.sendAlert.deliveries.length, 1);
  assert.equal(current.resume429.deliveries.length, 1);
  assert.equal(current.sendQueueEnter.deliveries.length, 1);
  assert.equal(current.user.notifications.length, 1);
});
function comparable(output) {
  return Object.fromEntries(Object.entries(output).map(([kind, {calls, ...result}]) => [kind, result]));
}
for (const scenario of ['plain','reuse','reopen','restart','old','no-start','stopped',
  'missing-session','held','fresh','pid-mismatch','broken','between']) {
  test(`옛 전체 읽기와 새 연결의 start·PID·전달·오류·기록·경보 동등: ${scenario}`, () => {
    assert.deepEqual(comparable(run(scenario)), comparable(run(scenario, 'legacy')));
  });
}
test('전송 직전 새 start: 새 PID·입력 보호를 쓰고 옛 PID 재알림·재개를 거절한다', () => {
  const current = run('fresh');
  assert.equal(current.sendAlert.deliveries[0].options.expectedPid, '22');
  assert.equal(current.sendAlert.deliveries[0].options.notificationGuard.humanIdleMs, 120_000);
  assert.equal(current.sendMailReminder.error.delivery, 'not-sent');
  assert.equal(current.resume429.error.message, '429 재개 세대 변경');
  assert.equal(current.sendQueueEnter.error.message, '입력 큐 재개 세대 변경');
});
test('일부러 낡은 주기 목록을 주면 최신성 검사가 차이를 잡는다', () => {
  const stale = run('fresh', 'stale'), current = run('fresh');
  assert.equal(stale.sendAlert.error.code, 'KADAN_PID_MISMATCH');
  assert.equal(stale.sendAlert.deliveries.length, 0);
  assert.equal(current.sendAlert.error, null);
  assert.notDeepEqual(comparable(stale), comparable(current));
});
test('start 선택과 guardedSend 사이에 새 start가 생기면 새 읽기가 옛 PID 전송을 막는다', () => {
  const current = run('between');
  assert.equal(current.sendAlert.error.code, 'KADAN_PID_MISMATCH');
  assert.equal(current.sendAlert.deliveries.length, 0);
});
test('원장 start와 살아 있는 바닥 PID가 다르면 두 경로 모두 거절한다', () => {
  const current = run('pid-mismatch');
  assert.equal(current.sendAlert.error.code, 'KADAN_PID_MISMATCH');
  assert.equal(current.sendAlert.deliveries.length, 0);
  assert.equal(current.resume429.error.code, 'KADAN_PID_MISMATCH');
});

// 전송 소비자는 감시 배열에서 줄인 두 종류와 roleInstructions를 읽지 않아야 한다.
// #401의 목록에서 cmdMail 전용의 실행 뒤 안내 두 모듈은 감시기가 호출하지 않는다.
test('감시 배열에서 줄인 필드를 전송 길의 소비 모듈이 읽지 않는다', () => {
  const narrowTest = fs.readFileSync(new URL('./send-ledger-narrow.test.mjs', import.meta.url), 'utf8');
  const declaration = narrowTest.match(/const SEND_PATH_CONSUMERS = (\[[\s\S]*?\]);/);
  assert.ok(declaration, '기준 소비 모듈 목록을 찾지 못하면 실패');
  const consumers = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(consumers.length >= 24);
  for (const file of consumers.filter(file =>
    !['commands/send.mjs','conductor-load-hint.mjs'].includes(file))) {
    const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    assert.ok(!/['"`]watch-(?:cycle|scope)['"`]/.test(source), file);
    assert.ok(!/\be(?:ntry)?\??\.roleInstructions\b|\[['"]roleInstructions['"]\]/.test(source), file);
  }
});
