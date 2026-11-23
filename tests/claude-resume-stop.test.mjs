import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRoles, screenDisconnects, disconnectKind} from '../src/watch.mjs';
import {changeDigest} from '../src/watch-roles.mjs';
import {assessWaitingStops} from '../src/watch-waiting-stop.mjs';
import {formatAlertBody} from '../src/watch-alert-body.mjs';
import {STOP_PHRASES, WORKER_PHRASES, SUPERVISOR_ERROR_PATTERN, phraseOfLine, anyStopWordInBottom} from '../src/watch-stop-phrases.mjs';
import {buildPreview, previewRow} from '../src/claude-refresh.mjs';
import {runNudge} from '../src/claude-nudge.mjs';

// "기대 결과 표"를 한 줄씩 고정한다(발령 카드의 표 11행). 화면은 모두 합성이다: 문구와 줄 순서는 실측 화면에서 가져오고
// 바닥글·경로·역할 이름은 가짜 값이다. 실측 화면: `⏺ Automatic continue stopped · your login changed or ended · send a prompt to continue`
// 가 `⏺ Usage limit reached · set to continue automatically at 2:30pm` 배너·턴 끝 줄 아래, 빈 입력창(`❯` + U+00A0) 위에 남았다.
// 로그인 시간 초과 화면은 실측 화면을 찾지 못해 재구성했다: 문구는 TODO 원문(`Login reached its time limit · Please run /login` +
// `Once fixed, resend your message`)이고 줄 모양은 같은 계열의 실측 `⏺ Login expired · Please run /login`(응답 줄 + 턴 끝 줄 + 빈 입력창)을 따랐다.
const RULE = '─'.repeat(40);
const FOOTER = [
  "  ⚠ Usage limit reached · limit resets 2:30pm · clau.de/wrap-up · /usage-credits to keep using Claude Code",
  '  ~/Dev/demo[main]', '  Opus 5.5 | effort:high | 3h 6m left | ctx:25%', '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');
const composer = (typed = ' ') => `${RULE}\n❯${typed}\n${RULE}\n${FOOTER}\n`;
const BANNER = '⏺ Usage limit reached · set to continue automatically at 2:30pm';
const BANNER_CONTINUING = '⏺ Usage limit reached · continuing automatically at 2:30pm';
const DONE = '✻ Cogitated for 25m 25s · done 11:37 AM';
const STOP_AUTO = '⏺ Automatic continue stopped · your login changed or ended · send a prompt to continue';
const STOP_LOGIN = '⏺ Login reached its time limit · Please run /login\n  Once fixed, resend your message';
const TOOL = '⏺ Bash(npm test)\n  ⎿  12 passed\n';
const screen = (...parts) => `${parts.join('\n')}\n`;

const INCIDENT = screen(TOOL, BANNER, '', DONE, '', STOP_AUTO, '', composer());
const LOGIN = screen(TOOL, '', STOP_LOGIN, '', '✻ Churned for 1m 41s · done 12:07 AM', '', composer());
const BANNER_ONLY = screen(TOOL, BANNER, '', composer());
const BANNER_CONTINUING_ONLY = screen(TOOL, BANNER_CONTINUING, '', composer());
const BANNER_THEN_STOP = screen(TOOL, BANNER, '', STOP_AUTO, '', composer());
const STOP_SCREENS = {incident: INCIDENT, login: LOGIN, 'banner-then-stop': BANNER_THEN_STOP};

const ROLE = 'qa-worker', SESSION = `kadan-${ROLE}`;
const observe = text => new Map([[SESSION, {role: ROLE, alive: true, pid: 1, expectedPid: 1, screen: text, digest: changeDigest(text)}]]);
const alertsOf = text => assessRoles(new Map(), observe(text), 60_000, 60_000, 20).alerts;
const stopAlerts = text => alertsOf(text).filter(a => a.kind === '끊김');

// refresh 미리보기용 가짜 바닥(읽기만 한다).
function floorOf(text, role = 'qa-target') {
  const entries = [{kind: 'start', floor: 'tmux', role, session: `kadan-${role}`, cmd: 'claude --model claude-haiku-5-5', panePid: '100', roleProfile: 'worker'}];
  const floor = {name: 'tmux', list: () => [{session: `kadan-${role}`, alive: true}], alive: () => true, pid: () => '100', read: () => text};
  return {entries, floor, role};
}
const previewOf = text => { const w = floorOf(text); return buildPreview({entries: w.entries, floor: w.floor, pendingCards: () => [], self: 'me', select: 'limit'})[0]; };

// 대기 표시 실행 한 건.
const waitingEntry = {session: SESSION, role: ROLE, taskId: 'qa-task', executionKey: 'qa/qa-task', by: 'qa-boss',
  card: {activity: 'waiting', activityAt: '2026-11-23T01:00:00Z', at: '2026-11-23T01:00:00Z', noteKind: 'progress', note: '한도 풀리기 대기'}};
const waitingAlerts = text => assessWaitingStops([waitingEntry], observe(text));

test('표 1행: 자동 계속 멈춤 화면(❯ 뒤 U+00A0)은 작업자 정지 경보(끊김, 직속 감독 행동)이고 refresh 미리보기 대상이다', () => {
  const found = screenDisconnects(INCIDENT);
  assert.equal(found.size, 1);
  const line = [...found.values()][0];
  assert.equal(line, STOP_AUTO);
  assert.equal(disconnectKind(line), '끊김');
  const phrase = phraseOfLine(line);
  assert.deepEqual({kind: phrase.kind, action: phrase.action, scope: phrase.scope}, {kind: '끊김', action: 'alert-supervisor', scope: ['worker']});
  const alerts = stopAlerts(INCIDENT);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].role, ROLE);
  assert.equal(alerts[0].line, STOP_AUTO);
  const row = previewOf(INCIDENT);
  assert.equal(row.verdict, 'target');
  assert.match(row.screenTail.join('\n'), /Automatic continue stopped/u);
});

test('표 1행: 경보 본문은 입력 한 번이면 이어간다고 안내하고 한도 교대 안내는 붙이지 않는다(자동 전송 없음)', () => {
  const [alert] = stopAlerts(INCIDENT);
  const body = formatAlertBody(alert);
  assert.match(body, /끊김 kadan-qa-worker \(⏺ Automatic continue stopped/u);
  assert.match(body, /kadan claude refresh --nudge --role qa-worker/u);
  assert.doesNotMatch(body, /교대|fallback|실행기 교체/u);
  assert.equal(alert.fallbackLine, undefined);
});

test('표 2행: 같은 화면에서 작업자 카드가 waiting이면 대기중정지 경보', () => {
  const alerts = waitingAlerts(INCIDENT);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, '대기중정지');
  assert.equal(alerts[0].line, STOP_AUTO);
  assert.match(formatAlertBody(alerts[0]), /kadan claude refresh --nudge --role qa-worker/u);
  // 같은 화면이면 같은 경보 id라 기존 중복 막기가 한 번만 알린다.
  assert.equal(waitingAlerts(INCIDENT)[0].id, alerts[0].id);
});

test('표 3행: 로그인 시간 초과 화면은 위 두 줄(작업자 경보·대기중정지·refresh 대상)과 같다', () => {
  const found = screenDisconnects(LOGIN);
  assert.equal(found.size, 1);
  assert.equal(disconnectKind([...found.values()][0]), '끊김');
  assert.equal(stopAlerts(LOGIN).length, 1);
  assert.match(stopAlerts(LOGIN)[0].line, /^⏺ Login reached its time limit · Please run \/login$/u);
  assert.equal(waitingAlerts(LOGIN).length, 1);
  assert.equal(waitingAlerts(LOGIN)[0].kind, '대기중정지');
  assert.equal(previewOf(LOGIN).verdict, 'target');
});

test('표 4·5행: 자동 재개 배너만 있는 화면은 main과 같다(경보 없음, refresh는 배너를 한도로 보는 기존 판정)', () => {
  for (const [name, text] of Object.entries({banner: BANNER_ONLY, continuing: BANNER_CONTINUING_ONLY})) {
    assert.equal(screenDisconnects(text).size, 0, name);
    assert.equal(stopAlerts(text).length, 0, name);
    assert.equal(waitingAlerts(text).length, 0, name);
    assert.equal(previewOf(text).verdict, 'target', name);
    assert.equal(previewOf(text).reason, '한도로 보임(규칙)', name);
    assert.equal(anyStopWordInBottom(text), false, name);
  }
});

test('표 6행: 배너 + 그 아래 새 정지 줄 + 빈 입력창은 새 줄이 이겨 경보(턴 끝 줄이 끼어도 같다)', () => {
  for (const [name, text] of Object.entries(STOP_SCREENS)) {
    assert.equal(screenDisconnects(text).size, 1, name);
    assert.equal(stopAlerts(text).length, 1, name);
    assert.equal(waitingAlerts(text).length, 1, name);
    assert.equal(previewOf(text).verdict, 'target', name);
  }
  // 배너 줄이 한도 줄로 읽히는 refresh에서도 대상 줄은 입력창 바로 위의 새 줄이다.
  assert.match(previewOf(BANNER_THEN_STOP).screenTail.at(-1), /Automatic continue stopped/u);
});

test('표 7행: 응답 문장 중간·`>` 인용·우편 본문·지난 도구 출력·코드 울타리·뒤에 이어진 응답 속 새 문구는 경보 없음', () => {
  const MAIL = ['[감시sh] 미확인 우편 1건 (작업자에게)', `  미리보기: ${STOP_AUTO.slice(2)}`, '이 안내는 새 지시가 아니며 우편 내용과 별개입니다.'].join('\n');
  const negatives = {
    prose_mid: screen('⏺ 로그에 "Automatic continue stopped · your login changed or ended" 가 찍혔습니다.', '', DONE, '', composer()),
    prose_login: screen('⏺ 오류 줄은 Login reached its time limit · Please run /login 입니다.', '', composer()),
    quote: screen(TOOL, '⏺ 우편 인용:', '  > Automatic continue stopped · your login changed or ended · send a prompt to continue', '', composer()),
    tool_output: screen('⏺ Bash(rg "Automatic continue stopped" docs)', `  ⎿  ${STOP_AUTO.slice(2)}`, '', composer()),
    tool_output_old: screen('⏺ Bash(rg "Automatic continue stopped" docs)', `  ⎿  ${STOP_AUTO.slice(2)}`, '', '⏺ 문서에 있습니다.', '', DONE, '', composer()),
    mail_notice: screen(TOOL, MAIL, '', composer()),
    fenced: screen('⏺ 예:', '```text', STOP_AUTO, '```', '', composer()),
    later_response: screen(STOP_AUTO, '', DONE, '', '⏺ 이어서 하겠습니다.', '', composer()),
    no_symbol: screen(DONE, '', STOP_AUTO.slice(2), '', composer()),
  };
  for (const [name, text] of Object.entries(negatives)) {
    assert.equal(screenDisconnects(text).size, 0, name);
    assert.equal(stopAlerts(text).length, 0, name);
    assert.equal(waitingAlerts(text).length, 0, name);
  }
});

test('표 8행: 새 문구가 위에 있어도 그 아래에 일하는 표시(스피너·Running…)가 있으면 경보 없음', () => {
  const working = {
    spinner: screen(STOP_AUTO, '', '✻ Cogitating… (12s · esc to interrupt)', '', composer()),
    running: screen(STOP_AUTO, '', '⏺ Bash(sleep 60)', '  ⎿  Running… (12s)', '', composer()),
    // 2라운드(검수 changes): 정지 줄 아래에 호출 머리줄 없이 들여쓴 `⎿  Running…` 줄만 있고 빈 입력창이 오는 화면.
    // 훑기가 들여쓴 줄을 이어진 본문처럼 건너뛰어 예전 정지 줄을 현재 경보로 읽던 헛경보. main은 경보 0건이다.
    running_indented: screen(STOP_AUTO, '', '  ⎿  Running… (12s)', '', composer()),
    running_indented_tight: screen(STOP_AUTO, '  ⎿  Running… (12s)', '', composer()),
    running_indented_after_banner: screen(BANNER, '', DONE, '', STOP_AUTO, '', '  ⎿  Running… (12s)', '', composer()),
    running_indented_login: screen(STOP_LOGIN, '', '  ⎿  Running… (12s)', '', composer()),
  };
  for (const [name, text] of Object.entries(working)) {
    assert.equal(screenDisconnects(text).size, 0, name);
    assert.equal(stopAlerts(text).length, 0, name);
    assert.equal(waitingAlerts(text).length, 0, name);
    assert.notEqual(previewOf(text).verdict, 'target', name);
  }
});

test('표 9행: 입력창에 보내지 않은 글자가 있으면 --nudge는 보내지 않고, 빈 입력창이면 한 번만 보내고 화면이 그대로여도 다시 보내지 않는다', () => {
  const run = text => {
    const w = floorOf(text);
    const sends = [];
    w.floor.send = (session, message) => { sends.push({session, message}); return {keyDelivery: 'sent', inputAcceptance: 'unconfirmed'}; };
    let clock = 0;
    const results = runNudge({entriesOf: () => w.entries, floor: w.floor, pendingCards: () => [], self: 'me', intervalSec: 2,
      sleep: ms => { clock += ms; }, now: () => clock, pressKey: () => assert.fail('Escape는 메뉴가 있을 때만'),
      send: ({floor, session, message}) => floor.send(session, message)});
    return {results, sends};
  };
  for (const [name, text] of Object.entries(STOP_SCREENS)) {
    const typed = text.replace('❯ ', '❯ 이 줄을 설명해 줘');
    const blocked = run(typed);
    assert.equal(blocked.sends.length, 0, name);
    assert.notEqual(blocked.results[0].outcome, 'nudged', name);
    const sent = run(text);
    assert.equal(sent.sends.length, 1, name);
    assert.equal(sent.results[0].sent, true, name);
    // 보낸 뒤 같은 화면이 그대로면 재시도하지 않고 그대로 한도(정지) 상태로 보고한다.
    assert.equal(sent.results[0].outcome, 'limited', name);
  }
});

test('표 10행: 감독 화면에 새 문구가 보여도 main과 같다(감독 오류 패턴에 들어가지 않는다)', () => {
  for (const text of Object.values(STOP_SCREENS)) assert.equal(SUPERVISOR_ERROR_PATTERN.test(text.split('\n').slice(-20).join('\n')), false);
  for (const id of ['claude-auto-continue-stopped', 'claude-login-timeout']) {
    const entry = STOP_PHRASES.find(p => p.id === id);
    assert.deepEqual([entry.kind, entry.action, entry.scope], ['끊김', 'alert-supervisor', ['worker']], id);
    assert.ok(WORKER_PHRASES.includes(entry), id);
  }
  assert.notEqual(phraseOfLine(STOP_AUTO)?.id, 'usage-limit');
});

test('표 11행: 표에 없는 문구로 waiting 중이면 main과 같다(대기중정지 없음)', () => {
  const unknown = screen(TOOL, BANNER, '', DONE, '', '⏺ Automatic continue paused · something else entirely', '', composer());
  assert.equal(waitingAlerts(unknown).length, 0);
  assert.equal(stopAlerts(unknown).length, 0);
});

test('새 정지 줄은 일하는 중 거부(넓은 검사)에 들어가지 않는다: 화면 아래에 보여도 정체 경로로 새지 않는다', () => {
  for (const text of Object.values(STOP_SCREENS)) assert.equal(anyStopWordInBottom(text), false);
  assert.equal(previewRow({...floorOf(INCIDENT), pendingCards: () => [], session: 'kadan-qa-target', self: 'me', select: 'limit'}).verdict, 'target');
});
