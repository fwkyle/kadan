// 감독 관찰AI '근거 부족(모름)' 헛경보: 일하는 화면의 첫 관찰을 멈춤으로 세지 않는다 (kadan/work-observer-spinner-frozen).
// 동작 표 1~8은 실행 카드의 '고정한 동작 표'다. 시험 이름의 '표 N'이 그 번호다.
// 사고 경로: 원장에 60분 넘은 감독 관찰AI 요청(옛 요청)이 있고, SupervisorHealth 상태가 새로 만들어지고(감시 대상에 다시 들어옴),
// 첫 순회 화면이 일하는 화면이다. 옛 요청이 없으면 lastCheck=now라 main에서도 후보가 안 나서 시험이 저절로 통과한다(헛통과).
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSupervisorScope} from '../src/watch-scope.mjs';
import * as health from '../src/watch-supervisor-health.mjs';
import {changeDigest} from '../src/watch-roles.mjs';

const {SupervisorHealth, SUPERVISOR_CHECK_MS} = health;
const STILL = 5 * 60_000; // 표의 N=5분. 상수 이름은 별도 시험에서 확인한다.
const MIN = 60_000;
const t = '2026-09-09T00:00:00.000Z', epoch = Date.parse(t);
const parents = new Map([['worker', 'boss'], ['boss', 'top'], ['top', '@user']]);
const card = {id: 'task', key: 'repo/task', role: 'worker', status: 'assigned', workType: 'execution', title: '샘플 작업',
  activity: 'running', board: 'p'};
const base = [...['worker', 'boss', 'top'].map((role, i) => ({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t})),
  {kind: 'send', role: 'worker', taskId: 'task', t}];
const seen = screen => new Map([['kadan-boss', {role: 'boss', alive: true, pid: 2, expectedPid: 2, screen, digest: screen, startedAt: t}]]);
const iso = ms => new Date(epoch + ms).toISOString();
// 옛 요청: epoch+1초에 낸 감독 관찰AI 요청. 첫 순회가 이보다 60분 넘게 뒤여야 사고 경로다.
const oldRequest = (extra = []) => [
  {kind: 'watch-ai-request', source: 'supervisor-health', role: 'boss', session: 'kadan-boss', requestId: 'r0', t: iso(1000),
    observationDigest: 'old-digest-0001'}, ...extra];
// 새 감시 상태(감시 대상에 다시 들어온 순회)로 시작한다. at(분, 화면)으로 그 시각의 순회를 부른다.
function run(ledger = oldRequest()) {
  const h = new SupervisorHealth(), scope = buildSupervisorScope([card], base, parents);
  const at = (ms, screen, extra = {}) => h.select({scope, observations: seen(screen), entries: [...base, ...ledger], cards: [card],
    now: epoch + ms, enabled: true, ...extra});
  return {h, at, state: () => h.states.get('kadan-boss')};
}
// 실측 근거 8건의 상태 구역(스피너 줄·입력창·상태 줄)만 떼어 쓴 익명 화면이다. 대화 내용·경로·역할 이름은 뜻 없는 글로 바꿨다.
const RULE = '─'.repeat(40);
const frame = ({spinner, tool = null, footer = '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← 2 agents',
  right = '✘ Auto-update failed · Run claude doctor', extra = ''}) => [
  '⏺ 샘플 답변 한 줄', ...(tool ? [`  ⎿  ${tool}`] : []), '', ...(spinner ? [spinner, ''] : []), RULE, '❯ ', RULE,
  '  ~/Dev/sample-repo[main]', '  Opus 5.5 | effort:medium | ctx:15%', `  ${footer}`, right ? `${' '.repeat(40)}${right}` : '', extra,
].join('\n') + '\n';
const NOT_WORKING = frame({spinner: null, footer: '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents', right: ''});
const WEEKLY = `${' '.repeat(20)}You've used 99% of your weekly limit · resets 4pm (Asia/Seoul) · /usage-credits to keep using Claude Code`;
// id = 근거 폴더 ID 앞 8자. clock = 그 입력의 statusLine.clockSec.
const EVIDENCE = [
  {id: '6bc647ab', clock: 55, screen: frame({tool: 'Running… (7s · timeout 4m)', spinner: '✶ Processing… (55s · ↓ 3.7k tokens)'})},
  {id: '3a7e921e', clock: 161, screen: frame({spinner: '✢ Swirling… (2m 41s · ↓ 7.5k tokens)'})},
  {id: 'b6426cb5', clock: 391, screen: frame({tool: 'Running… (32s · timeout 6m 40s)', spinner: '✳ Warping… (6m 31s · ↓ 20.0k tokens)'})},
  {id: 'e80808bd', clock: 9, screen: frame({spinner: '· Hatching… (9s · ↓ 947 tokens)'})},
  {id: '78068a3a', clock: 81, screen: frame({spinner: '✳ Wrangling… (1m 21s · ↓ 4.7k tokens)'})},
  // 412fce10: 이미 있던 상태. 직전 화면은 일하는 표시가 없고(NOT_WORKING) 이번 화면이 방금 시작한 응답이다.
  {id: '412fce10', clock: 4, before: NOT_WORKING,
    screen: frame({spinner: '✶ Newspapering… (4s · ↓ 247 tokens · thought for 1s)', right: '✘ Auto-update failed · Run claude doctor', extra: WEEKLY})},
  {id: '170277d4', clock: 213, screen: frame({spinner: '✢ Julienning… (3m 33s · ↓ 8.2k tokens)', right: '✔ Update installed · /restart to apply'})},
  {id: '708c9f2a', clock: 84, screen: frame({spinner: '✽ Noodling… (1m 24s · ↓ 3.7k tokens)', right: '✔ Update installed · /restart to apply'})},
];
const WORKING = frame({spinner: '✢ Crafting… (3m 52s · ↓ 1.2k tokens)'});
const clockScreen = clock => frame({spinner: `✢ Crafting… (${clock} · ↓ 1.2k tokens)`});

test('고정 입력의 시계 값이 근거 입력의 statusLine과 같다(고정 입력 점검)', () => {
  for (const e of EVIDENCE) {
    const r = run();
    r.at(2 * 60 * MIN, e.screen);
    assert.equal(r.state().workClock, e.clock, e.id);
  }
});

test('표 1: 근거 8건 — 옛 요청 60분+새 상태+일하는 첫 순회는 후보가 없다', () => {
  for (const e of EVIDENCE) {
    const r = run();
    // 이미 있던 상태(412fce10)는 일 시작 전 순회가 먼저 있다. 그 순회는 아직 60분 전이라 후보가 아니다.
    const first = e.before ? 62 * MIN : 2 * 60 * MIN;
    if (e.before) assert.equal(r.at(20 * MIN, e.before).candidate, undefined, `${e.id} 일 시작 전`);
    const result = r.at(first, e.screen);
    // 헛통과 방지: 첫 순회에서 옛 요청 기준 60분이 이미 지났어야 사고 경로다.
    assert.ok(epoch + first - r.state().lastCheck >= SUPERVISOR_CHECK_MS, `${e.id} 사고 경로 전제`);
    assert.equal(result.candidate, undefined, `${e.id} 첫 순회`);
    assert.equal(r.at(first + MIN, e.screen).candidate, undefined, `${e.id} 1분 뒤 같은 화면`);
  }
});

test('표 2: 일하는 표시에 시계가 직전과 같으면 연속 N분 본 뒤에만 정기 후보를 낸다', () => {
  const r = run(), start = 2 * 60 * MIN;
  assert.equal(r.at(start, WORKING).candidate, undefined);
  for (let at = start + MIN; at < start + STILL; at += MIN) assert.equal(r.at(at, WORKING).candidate, undefined, `${at - start}ms`);
  const late = r.at(start + STILL, WORKING).candidate;
  assert.equal(late.input.check, 'hourly');
  assert.equal(late.role, 'boss');
  assert.deepEqual(late.input.statusLine, {kind: 'working', clockSec: 232, previousClockSec: 232});
});

test('표 3: 일하는 표시에 시계가 바뀌면 안 나아감 셈을 0으로 되돌린다', () => {
  const r = run(), start = 2 * 60 * MIN;
  r.at(start, clockScreen('1m 0s'));
  assert.equal(r.at(start + 3 * MIN, clockScreen('1m 0s')).candidate, undefined);
  assert.equal(r.at(start + 4 * MIN, clockScreen('2m 0s')).candidate, undefined); // 4분째에 시계가 바뀜
  // 바뀐 시각부터 다시 N분이다. 처음 시계 기준으로 N분이 지나도 후보가 아니다.
  const changedAt = start + 4 * MIN;
  assert.equal(r.at(changedAt + STILL - MIN, clockScreen('2m 0s')).candidate, undefined);
  assert.equal(r.at(changedAt + STILL, clockScreen('2m 0s')).candidate.input.check, 'hourly');
  // 계속 나아가는 감독은 몇 시간이 지나도 후보가 없다.
  const moving = run();
  for (let i = 0; i < 180; i++) {
    assert.equal(moving.at(start + i * MIN, clockScreen(`${i}m 0s`)).candidate, undefined, `${i}`);
  }
});

test('표 4: 일하는 표시인데 시계를 못 읽으면(초 없는 시계) 안 나아감으로 센다', () => {
  const r = run(), start = 2 * 60 * MIN, screen = clockScreen('2h 06m');
  assert.equal(r.at(start, screen).candidate, undefined);
  assert.equal(r.state().workClock, null);
  assert.equal(r.at(start + STILL - MIN, screen).candidate, undefined);
  const late = r.at(start + STILL, screen).candidate;
  assert.deepEqual(late.input.statusLine, {kind: 'working', clockSec: null, previousClockSec: null});
});

test('표 5: 일하는 표시가 아닌 화면(빈 입력창)은 첫 순회부터 지금처럼 시간당 후보다', () => {
  const r = run();
  assert.equal(r.at(2 * 60 * MIN, NOT_WORKING).candidate.input.check, 'hourly');
});

test('표 6: 오류 화면은 early·hourly가 지금 그대로다', () => {
  const error = 'Reconnecting... 1/2\n✢ Crafting… (3m 52s · ↓ 1k tokens)\n❯ \n';
  // hourly: 옛 요청 60분+새 상태+오류 화면은 첫 순회에 바로 후보다.
  assert.equal(run().at(2 * 60 * MIN, error).candidate.input.check, 'hourly');
  // early: 오류가 5분 이어지면 정기 후보와 별개로 먼저 나간다(옛 요청이 없어 hourly가 아닌 경우).
  const fresh = run([]);
  assert.equal(fresh.at(0, error).candidate, undefined);
  assert.equal(fresh.at(5 * MIN - 1, error).candidate, undefined);
  assert.equal(fresh.at(5 * MIN, error).candidate.input.check, 'persistent-error');
});

test('표 7: 도구 줄 timeout(#463)·같은 화면 재사용(quiet)은 지금 그대로다', () => {
  const tool = frame({tool: 'Running… (7s · timeout 8m)', spinner: '✶ Processing… (55s · ↓ 3.7k tokens)'});
  const r = run(), start = 2 * 60 * MIN;
  r.at(start, tool);
  // 도구 줄 T(8분)+1분 안에는 N(5분)이 지나도 후보가 없다.
  assert.equal(r.at(start + 6 * MIN, tool).candidate, undefined);
  assert.equal(r.at(start + 9 * MIN - 1, tool).candidate, undefined);
  assert.equal(r.at(start + 9 * MIN, tool).candidate.input.check, 'hourly');
  // 같은 화면 재사용: 직전 판정이 정상이고 지문이 같으면 N분이 지나도 후보가 없다.
  const ledger = [...oldRequest().map(e => ({...e, observationDigest: changeDigest(WORKING)})),
    {kind: 'watch-ai-report', source: 'supervisor-health', role: 'boss', requestId: 'r0', verdict: '입력대기', accepted: true, t: iso(2000)}];
  const q = run(ledger);
  assert.equal(q.at(start, WORKING, {ownTurn: new Set()}).candidate, undefined);
  assert.equal(q.at(start + 10 * MIN, WORKING, {ownTurn: new Set()}).candidate, undefined);
});

test('표 8: 미루는 동안 lastCheck를 갱신하지 않아 N분 뒤에 후보가 나고 다시 60분을 기다리지 않는다', () => {
  const r = run(), start = 2 * 60 * MIN;
  r.at(start, WORKING);
  const before = r.state().lastCheck;
  for (let at = start + MIN; at < start + STILL; at += MIN) r.at(at, WORKING);
  assert.equal(r.state().lastCheck, before);
  assert.equal(before, epoch + 1000);
  assert.ok(r.at(start + STILL, WORKING).candidate);
});

test('진짜 멈춤을 늦게 보는 최대 시간: 시계가 멈춘 감독은 N분 + 한 순회 안에 후보가 된다(재시작 1회당 최대 N분 추가)', () => {
  const cycle = MIN; // 감시 순회 약 60초
  // 이미 있던 상태에서 시계가 멈춘다: 마지막으로 시계가 바뀐 순회부터 N분.
  const r = run(), start = 2 * 60 * MIN;
  r.at(start, clockScreen('1m 0s'));
  r.at(start + cycle, clockScreen('2m 0s')); // 마지막 변화
  let first = null;
  for (let at = start + 2 * cycle; at <= start + 20 * cycle && first == null; at += cycle) {
    if (r.at(at, clockScreen('2m 0s')).candidate) first = at;
  }
  assert.equal(first - (start + cycle), STILL);
  // 재시작·감시 대상 재진입(새 상태): 기준선은 최초 관찰 시각이라 그 뒤 N분이다.
  const restarted = run();
  restarted.at(start + 30 * cycle, clockScreen('2m 0s'));
  assert.equal(restarted.at(start + 30 * cycle + STILL - cycle, clockScreen('2m 0s')).candidate, undefined);
  assert.ok(restarted.at(start + 30 * cycle + STILL, clockScreen('2m 0s')).candidate);
});

test('N은 감독 점검의 5분 상수로 내보낸다', () => {
  assert.equal(health.SUPERVISOR_STILL_MS, STILL);
});
