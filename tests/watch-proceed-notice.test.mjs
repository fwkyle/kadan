import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runWatch} from './helpers/watch-runner.mjs';
import {runProceedNotices, proceedNoticedKeys, PROCEED_NOTICE_KIND} from '../src/watch-proceed-notice.mjs';

// 자격이 생긴 순간의 본인 안내: 실제 감시 주기(runWatch)를 가짜 시계·가짜 전달로 돈다. 운영 홈·tmux·디코에 닿지 않는다.
const MIN = 60_000;
const REQ = 'a-감독', UP = 'a-슈퍼감독';
const T0 = Date.parse('2026-11-11T00:00:00.000Z');
const parents = new Map([[REQ, UP], [UP, '@user']]);
const startOf = (role, i = 1) => ({kind: 'start', role, session: `kadan-${role}`, panePid: i, t: '2026-11-10T00:00:00.000Z'});
const baseStarts = [startOf(REQ, 1), startOf(UP, 2)];
const decision = (over = {}) => ({id: 'dec-1', status: 'open', revision: 1, requestedBy: REQ, chat: true, work: 'a/w1',
  question: '이 순서로 갈까요?', recommendation: '예', reversible: '브랜치를 지운다', notProhibited: {by: REQ, at: new Date(T0).toISOString()},
  at: new Date(T0).toISOString(), ...over});
const apOf = (over = {}) => ({on: true, level: 'full', startedAt: new Date(T0).toISOString(), decideAfterMs: 30 * MIN, ...over});

// 가짜 시계: 첫 주기는 `startAt`, 이후 1초씩. 화면은 매 주기 바뀐다(일하는 중). 'sleep'이 cycles번 불리면 끝낸다.
async function cycles({cycles: n = 3, startAt, decisions, ap = apOf(), entries = baseStarts, records = [], sent = [], sendNudge, works = [], liveRoles, parentMap = parents}) {
  let cycle = 0;
  const stop = Error('end');
  const sessions = (liveRoles ?? [REQ, UP]).map(role => `kadan-${role}`);
  await assert.rejects(() => runWatch({
    floor: {list: () => sessions.map((session, i) => ({session, pid: i + 1})), read: () => `일하는 중 ${'ghijklmnop'[cycle % 10]}${cycle}`},
    readEntries: () => [...entries, ...records], readCards: () => [], readWorks: () => works, parents: parentMap,
    readDecisions: () => decisions, readAutopilotWingman: () => ap,
    intervalMs: 1000, stallN: 2, routes: {a: REQ}, superRole: UP, processEveryMs: 0,
    now: () => startAt + cycle * 1000, record: e => records.push(e), print: () => {},
    sendAlert: (role, message) => sent.push({role, message}), ...(sendNudge ? {sendNudge} : {}),
    spawn: command => {
      if (command === 'sleep') { if (++cycle === n) throw stop; return {status: 0, stdout: ''}; }
      if (command === 'tmux') return {status: 0, stdout: sessions.map((s, i) => `${i + 100} ${s} ${i + 200}`).join('\n') + '\n'};
      return {status: 0, stdout: ''};
    },
  }), error => error === stop);
  return {sent, records};
}
const notices = sent => sent.filter(m => /추천대로 진행할 수 있습니다/.test(m.message));
const noticeRecords = records => records.filter(r => r.alertKind === PROCEED_NOTICE_KIND);
// 업무 차례 칸이 사용자인 업무(답 대기로 가려지는 경우): 안내는 이것과 무관하게 나간다.
const userTurnWork = {key: 'a/w1', status: 'open', executions: [], owner: REQ, turnOwner: '사람', turnAt: new Date(T0).toISOString(), at: new Date(T0).toISOString()};

test('자격 시각 직후(15분 전)·화면이 계속 변해도·업무 차례가 사용자여도, 요청한 역할에게 정확히 1회 간다', async () => {
  const d = decision();
  const r = await cycles({startAt: T0 + 30 * MIN + 5000, decisions: [d], works: [userTurnWork]});
  const got = notices(r.sent);
  assert.equal(got.length, 1, JSON.stringify(r.sent.map(m => m.message)));
  assert.equal(got[0].role, REQ);
  assert.match(got[0].message, /질문: 이 순서로 갈까요\?/);
  assert.match(got[0].message, /추천: 예/);
  assert.match(got[0].message, /kadan decision proceed dec-1 --revision 1/);
  assert.ok(!/KADAN:DONE/.test(got[0].message));
  const rec = noticeRecords(r.records);
  assert.deepEqual(rec.map(x => [x.attempt === true, x.delivered]), [[true, false], [false, true]], '시도 → 전달 기록');
  assert.ok(rec.every(x => x.resolved === true && x.recipient === REQ));
});

test('감시기를 다시 켜도(원장 복원) 같은 구간이면 0회, 껐다 켜서 구간 시작이 달라지면 다시 1회', async () => {
  const d = decision();
  const first = await cycles({startAt: T0 + 31 * MIN, decisions: [d]});
  assert.equal(notices(first.sent).length, 1);
  const restarted = await cycles({startAt: T0 + 32 * MIN, decisions: [d], records: [...first.records], sent: []});
  assert.equal(notices(restarted.sent).length, 0, '재시작 뒤 같은 키는 다시 보내지 않는다');
  const newStart = new Date(T0 + 20 * MIN).toISOString();
  const again = await cycles({startAt: T0 + 60 * MIN, decisions: [d], ap: apOf({startedAt: newStart}), records: [...first.records], sent: []});
  assert.equal(notices(again.sent).length, 1, '새 켜짐 구간은 새 키');
});

test('보내지 않는 경우: 대기 시간 전·진행 기록 있음·닫힌 결정·꺼짐·단계 내려감·관계표에 없는 요청자·세션 없음', async () => {
  const cases = {
    '대기 시간 전': {startAt: T0 + 29 * MIN, decisions: [decision()]},
    '진행 기록 있음': {startAt: T0 + 31 * MIN, decisions: [decision({proceeded: {by: UP, at: new Date(T0 + 30 * MIN).toISOString()}})]},
    '이미 답함': {startAt: T0 + 31 * MIN, decisions: [decision({status: 'answered'})]},
    '취소됨': {startAt: T0 + 31 * MIN, decisions: [decision({status: 'cancelled'})]},
    '꺼짐': {startAt: T0 + 31 * MIN, decisions: [decision()], ap: apOf({on: false})},
    '단계 내려감': {startAt: T0 + 31 * MIN, decisions: [decision()], ap: apOf({level: 'autopilot'})},
    '요청자가 관계표에 없음': {startAt: T0 + 31 * MIN, decisions: [decision({requestedBy: '모르는-감독'})]},
    '요청자 세션 없음': {startAt: T0 + 31 * MIN, decisions: [decision()], liveRoles: [UP]},
  };
  for (const [name, input] of Object.entries(cases)) {
    const r = await cycles(input);
    assert.equal(notices(r.sent).length, 0, name);
    assert.equal(noticeRecords(r.records).length, 0, `${name}: 보냈다는 기록도 남기지 않는다`);
  }
});

test('세션이 죽어 있다가 살아나면 그때 1회 간다(죽어 있는 동안은 기록 없이 다음 주기에 다시 본다)', async () => {
  const d = decision(), sent = [], records = [];
  await cycles({startAt: T0 + 31 * MIN, decisions: [d], liveRoles: [UP], sent, records});
  assert.equal(notices(sent).length, 0);
  await cycles({startAt: T0 + 32 * MIN, decisions: [d], sent, records});
  assert.equal(notices(sent).length, 1);
});

test('최상위 슈퍼감독이 요청자인 결정도 간다', async () => {
  const r = await cycles({startAt: T0 + 31 * MIN, decisions: [decision({requestedBy: UP})]});
  const got = notices(r.sent);
  assert.equal(got.length, 1);
  assert.equal(got[0].role, UP);
});

test('사람이 그 창에서 입력 중이라 미룬 안내는 기록으로 거두고 다음 주기에 다시 보낸다', async () => {
  const hold = Object.assign(new Error('입력 중'), {delivery: 'not-sent', code: 'KADAN_HUMAN_ACTIVE'});
  const d = decision(), sent = [];
  let blocked = true;
  const sendNudge = (role, message) => { if (blocked) throw hold; sent.push({role, message}); };
  const records = [];
  await cycles({startAt: T0 + 31 * MIN, decisions: [d], sendNudge, records, cycles: 2});
  assert.equal(notices(sent).length, 0);
  assert.equal(proceedNoticedKeys(records).size, 0, '미룬 시도는 이미 안내한 것으로 세지 않는다');
  blocked = false;
  await cycles({startAt: T0 + 33 * MIN, decisions: [d], sendNudge, records, cycles: 2});
  assert.equal(notices(sent).length, 1);
});

test('후보가 없는 주기는 원장 대조도 하지 않는다(열린 결정이 있어도 자격 전이면 entries를 읽지 않는다)', () => {
  let touched = 0;
  const entries = new Proxy([], {get(target, prop) { if (prop === Symbol.iterator) touched++; return Reflect.get(target, prop); }});
  const state = {seeded: false, keys: new Set()};
  const out = runProceedNotices({proceedable: [], ap: apOf(), parents, liveSessions: new Set(), entries, state, send() {}, record() {}, clock: '00:00'});
  assert.deepEqual(out, {sent: 0, held: 0, failed: 0, skipped: 0});
  assert.equal(touched, 0);
  assert.equal(state.seeded, false);
});
