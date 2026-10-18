import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRoles} from '../src/watch.mjs';
import {changeDigest, shortDigest} from '../src/watch-roles.mjs';
import {terminal429} from '../src/watch-rate-limit.mjs';
import {findDoneMarkers} from '../src/done-marker.mjs';

// 2026-10-17 codex 0.163 429 방치 사고의 실제 화면(감독 사본 내용). 글자는 그대로 둔다.
const screenAt = clock => [
  '  <!-- /kadan:receiver-instructions -->',
  '',
  '',
  `• Reconnecting... 1/5 (${clock} • esc to interrupt)`,
  '  └ Exceeded retry limit, last status: 429 Too Many Requests',
  '  └ Tip: Use /skills to list available skills or ask Codex to use one.',
  '',
  '',
  '› Ask Codex to do anything',
  '',
  '  GPT-6.1-Sol high · ~/Dev/kadan · main · Context 0% used · weekly 97% left',
  '  ? for shortcuts                                                       ⚠ 2 warnings · f2 to view',
].join('\n');

const quiet = screen => screen.replace('Exceeded retry limit, last status: 429 Too Many Requests', 'Working on it');
const observe = (screen, over = {}) => new Map([['kadan-worker', {
  role: 'worker', alive: true, pid: 1, expectedPid: 1, screen, digest: changeDigest(screen), ...over,
}]]);
const run = (screens, stallN = 3) => {
  let states = new Map();
  const alerts = [];
  for (const screen of screens) {
    const result = assessRoles(states, observe(screen), 60_000, 60_000, stallN);
    states = result.states;
    alerts.push(result.alerts);
  }
  return {states, alerts};
};

test('(a) 시계만 다른 장면은 같은 지문이고 평소 정체 횟수에서 정체가 난다', () => {
  const clocks = ['14h 03m 22s', '14h 04m 30s', '14h 05m 40s', '14h 06m 50s'];
  assert.equal(changeDigest(screenAt(clocks[0])), changeDigest(screenAt(clocks[1])));
  assert.notEqual(shortDigest(screenAt(clocks[0])), shortDigest(screenAt(clocks[1])));
  const {alerts} = run(clocks.map(screenAt));
  assert.equal(alerts.at(-1).some(a => a.id === 'stall:kadan-worker' || a.kind === '정체'), false,
    '한도 경보가 먼저 나므로 정체는 끊김이 없는 화면에서만 본다');
  assert.equal(run(clocks.map(c => quiet(screenAt(c)))).alerts.at(-1).some(a => a.id === 'stall:kadan-worker'), true);
});

test('(b) 같은 장면에서 한도 끊김 경보가 난다', () => {
  const {alerts} = run([
    quiet(screenAt('1h 00m 00s')),
    screenAt('1h 01m 00s'),
  ]);
  const limit = alerts.at(-1).find(a => a.kind === '한도');
  assert.ok(limit, '한도 경보가 있어야 한다');
  assert.match(limit.line, /429 Too Many Requests/);
});

test('(c) 실제 글이 바뀐 장면은 계속 진행으로 센다', () => {
  const a = quiet(screenAt('14h 03m 22s'));
  const b = a.replace('<!-- /kadan:receiver-instructions -->', 'new output line');
  assert.notEqual(changeDigest(a), changeDigest(b));
  const {states} = run([a, a.replace('14h 03m', '14h 04m'), b, b.replace('14h 03m', '14h 05m')]);
  assert.equal(states.get('kadan-worker').stallCount, 1, '새 글 뒤 횟수가 다시 센다');
});

test('(d) terminal429는 재시도 중 표시가 섞인 이번 장면에서 null이다', () => {
  // 실행기가 아직 차례 중일 수 있어 붙여 넣은 재개 글이 큐에 쌓인다. 경보만 내고 자동 재개는 넓히지 않는다.
  assert.equal(terminal429(screenAt('14h 04m 30s'), 0), null);
});

test('(e) DONE 마커는 숫자만 다른 줄에서도 원래 화면으로 찾는다', () => {
  const screen = 'KADAN:DONE exec-0123abcd-0000-0000-0000-000000000001 ok';
  assert.equal(findDoneMarkers(screen).length, 1);
  assert.equal(changeDigest(screen), changeDigest(screen.replace('0123', '9999')));
  assert.equal(findDoneMarkers(screen.replace('0123', '9999')).length, 1);
});
