import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRoles, screenDisconnects} from '../src/watch.mjs';
import {changeDigest} from '../src/watch-roles.mjs';
import {currentErrorBlock} from '../src/watch-stop-phrases.mjs';

// PR #200 수정 1라운드: 목록 낱말은 '현재 오류 덩어리'(마지막 빈 입력창 바로 위 오류 머리줄 덩어리)일 때만 읽는다.
// 화면은 독립검수(exec-501990fc)의 재현 화면을 옮긴 것이다.
const COMPOSER = '› Ask Codex to do anything';
const F1 = {
  quoted_reconnect: `• 정상 응답: "Reconnecting..." 문구는 재연결 표시를 뜻합니다.\n\n${COMPOSER}`,
  fenced_reconnect: `• 화면 예제:\n\`\`\`text\n• Reconnecting... 2/5 (9m 34s • esc to interrupt)\n\`\`\`\n\n${COMPOSER}`,
  recovered_reconnect: `• Reconnecting... 2/5 (9m 34s • esc to interrupt)\n• Connection restored; task continues\n• Working (1m 00s • esc to interrupt)\n\n${COMPOSER}`,
  typed_reconnect: '› Reconnecting... 문구를 검색해 주세요',
  tool_reconnect: `• Running rg -n "Reconnecting..." src/watch.mjs\n  └ Searching source files\n\n• Working (1m 00s • esc to interrupt)\n\n${COMPOSER}`,
  tool_search: `• Running rg -n "screenDisconnects|No API key|reconnect" tests/watch.mjs\n  └ Searching source files\n\n• Working (1m 00s • esc to interrupt)\n\n${COMPOSER}`,
  quoted_auth: `• 정상 응답: 인증 실패 시 "oauth/token" 또는 "401 Unauthorized"가 보일 수 있습니다.\n\n${COMPOSER}`,
  typed_auth: '› oauth/token 관련 설정을 설명해 주세요',
};
const observe = screen => new Map([['kadan-w', {role: 'w', alive: true, pid: 1, expectedPid: 1, screen, digest: changeDigest(screen)}]]);
const run = (screens, stallN = 20) => {
  let states = new Map();
  const alerts = [];
  for (const screen of screens) {
    const result = assessRoles(states, observe(screen), 60_000, 60_000, stallN);
    states = result.states;
    alerts.push(result.alerts);
  }
  return {alerts, states};
};

for (const [name, screen] of Object.entries(F1)) {
  test(`F1 ${name}: 오류 경보 0건(첫 주기·여러 주기 모두)`, () => {
    assert.equal(screenDisconnects(screen).size, 0);
    const {alerts} = run([screen, screen, screen]);
    assert.deepEqual(alerts.flat().filter(a => ['끊김', '설정', '인증', '한도'].includes(a.kind)), []);
  });
}

test('F1 10:18 운영 헛경보 유형: 검색 명령 줄 속 No API key는 설정 경보가 아니다(작업 중·회복 뒤 화면 모두)', () => {
  const tool = `• Running rg -n "No API key" src\n  └ Searching source files\n\n${COMPOSER}`;
  assert.equal(screenDisconnects(tool).size, 0);
  assert.equal(screenDisconnects(F1.tool_search).size, 0);
});

test('현재 오류 덩어리 모양: 빈 입력창 위의 오류 머리줄·재연결 상태 줄은 읽고, 그 밖은 읽지 않는다', () => {
  assert.ok(currentErrorBlock(`■ authentication failed\n\n${COMPOSER}`));
  assert.ok(currentErrorBlock(`• Reconnecting... (14h 04m 30s • esc to interrupt)\n\n\n${COMPOSER}\n`), '#187 하이브리드');
  assert.equal(currentErrorBlock(`■ authentication failed\n\n${COMPOSER}\n› 다른 글`), null, '입력창 뒤 다른 입력');
  assert.equal(currentErrorBlock(`■ authentication failed\n\n새 출력 줄\n\n${COMPOSER}`), null, '덩어리와 입력창 사이에 글');
  assert.equal(currentErrorBlock('■ authentication failed'), null, '입력창 없음');
});

test('F2-A: 감시 시작 때 이미 떠 있는 인증 오류(빈 입력창)는 첫 주기에 인증 경보 1건', () => {
  const screen = `■ authentication failed\n\n${COMPOSER}`;
  const {alerts} = run([screen, screen, screen]);
  assert.equal(alerts[0].filter(a => a.kind === '인증').length, 1);
  assert.equal(new Set(alerts.flat().filter(a => a.kind === '인증').map(a => a.id)).size, 1, '같은 경보 하나');
});

test('F2-B: 입력창이 안 보여 엄격 기준을 통과 못 한 인증 문구는 정체 경로에 남는다(막지 않는다)', () => {
  const screen = '■ authentication failed';
  const {alerts} = run([screen, screen, screen], 2);
  assert.equal(alerts.flat().some(a => a.kind === '인증'), false, '즉시 경보 아님');
  assert.equal(alerts.at(-1).some(a => a.kind === '정체'), true, '기존 정체 경로로 감');
});

test('legacy 낱말도 응답 머리표·입력 줄·도구 줄·코드 울타리 안에서는 읽지 않고, 들여쓴 오류 줄은 읽는다', () => {
  const lines = ['• No API key 설명', '› No API key', '⎿ rg No API key', '```', 'No API key', '```'];
  assert.equal(screenDisconnects(lines.join('\n')).size, 0);
  assert.equal(screenDisconnects('  └ Provider unreachable\n').size, 1);
});
