import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {nightCommand} from '../src/commands/night.mjs';
import {nightGuard, guardedReason} from '../src/night-guard.mjs';
import {applyDutyRoute, DUTY_LINES, dutyPath} from '../src/night-duty.mjs';
import {summarizeNight} from '../src/night-summary.mjs';
import {runWatch} from '../src/watch-runner.mjs';

// 가짜 시계·가짜 우편·가짜 세션 목록·가짜 전송만 쓴다. 운영 홈·tmux·알림·디코에 닿지 않는다. 역할 이름도 시험용이다.
const T0 = Date.parse('2026-11-09T14:00:00.000Z');
const U = '@user';
const live = (...roles) => new Set(roles.map(r => `kadan-${r}`));
const night = {on: true, level: '자동', duty: 'b-슈퍼감독'};
const stall = {id: 'stall:a', kind: '정체', role: 'a-슈퍼감독', level: 'RED'};
const idle2 = {id: 'idle:a:상위', kind: '놀고 있음', role: 'a-슈퍼감독', stage: 2};
const userRoute = {recipient: U, basis: 'supervisor', skipped: []};
const L = live('b-슈퍼감독', 'a-슈퍼감독');

// ---- 1. 덮어쓰기 함수 표 ----
test('1. 모든 조건이 참이면 당번이 되고 route.basis는 당번이다', () => {
  for (const alert of [stall, idle2]) {
    const r = applyDutyRoute({route: userRoute, alert, night, liveSessions: L});
    assert.equal(r.recipient, 'b-슈퍼감독');
    assert.equal(r.basis, '당번');
  }
});

test('1. 조건을 하나씩 거짓으로 바꾸면 수신자가 사용자로 남는다', () => {
  const base = {route: userRoute, alert: stall, night, liveSessions: L};
  const cases = {
    '원래 수신자가 사용자 아님': {route: {recipient: 'x', basis: 'supervisor'}},
    '꺼짐': {night: {...night, on: false}},
    '기본 단계': {night: {...night, level: '기본'}},
    '당번 없음': {night: {...night, duty: null}},
    '나이트 상태 없음': {night: null},
    '놀고 있음 1단': {alert: {...idle2, stage: 1}},
    '죽음': {alert: {id: 'd', kind: '죽음', role: 'a-슈퍼감독'}},
    '프로세스': {alert: {id: 'p', kind: '프로세스'}},
    '한도': {alert: {id: 'l', kind: '한도', role: 'a-슈퍼감독'}},
    '당번 자신의 정체': {alert: {...stall, role: 'b-슈퍼감독'}},
    '당번 세션 없음': {liveSessions: live('a-슈퍼감독')},
    '관측 실패(null)': {liveSessions: null},
  };
  for (const [name, patch] of Object.entries(cases)) {
    const r = applyDutyRoute({...base, ...patch});
    if (name === '원래 수신자가 사용자 아님') assert.equal(r.recipient, 'x', name);
    else assert.equal(r.recipient, U, name);
    assert.notEqual(r.basis, '당번', name);
  }
});

// ---- 2~5. 감시 한 주기 통합 ----
async function cycles({nightEntries, rosterLive = true, dutyRole = 'b-슈퍼감독', userNotify = true, workers = ['a-작업자'], reader = null, failDuty = false, dutyInTable = true} = {}) {
  const controller = new AbortController(), sent = [], records = [], notifications = [], snapshots = [];
  let cycle = 0;
  const t = '2026-11-09T13:00:00Z';
  // 정체를 내는 대상은 부모가 사용자인 작업자다(수신자 계산이 @user가 되는 가장 작은 모양). 덮어쓰기는 수신자만 보므로 같은 경로다.
  const worker = workers[0];
  const entries = [
    ...workers.map((w, i) => ({kind: 'start', role: w, session: `kadan-${w}`, panePid: 10 + i, t})),
    ...(rosterLive ? [{kind: 'start', role: dutyRole, session: `kadan-${dutyRole}`, panePid: 2, t, roleProfile: 'super'}] : []),
    ...workers.map((w, i) => ({kind: 'send', role: w, taskId: `c${i}`, t})),
    ...nightEntries,
  ];
  const cards = workers.map((w, i) => ({id: `c${i}`, key: `r/c${i}`, role: w, status: 'assigned', workType: 'execution', activity: 'running', activityRole: w, activityAt: t}));
  const sessions = [...workers.map((w, i) => ({session: `kadan-${w}`, pid: 10 + i})), ...(rosterLive ? [{session: `kadan-${dutyRole}`, pid: 2}] : [])];
  await runWatch({
    floor: {list: () => sessions, read: s => (workers.some(w => s === `kadan-${w}`) ? 'same screen' : 'healthy')},
    readEntries: () => entries, readCards: () => cards, readWorks: () => [], readDecisions: () => [], record: e => records.push(e),
    sendAlert: (role, message) => {
      sent.push({role, message});
      if (failDuty && role === dutyRole) throw Object.assign(new Error('가짜 전달 실패'), {delivery: 'not-sent'});
    },
    parents: new Map([...workers.map(w => [w, U]), ...(dutyInTable ? [[dutyRole, U]] : [])]), routes: new Map(), superRole: null,
    intervalMs: 60_000, stallN: 2, stallAfterMs: 0, signal: controller.signal, userNotify,
    readNightDuty: reader ?? (({entries: es, now}) => {
      const last = [...es].reverse().find(e => e.kind === 'night');
      snapshots.push(now);
      return {on: last?.phase === 'on', level: last?.level ?? '기본', duty: last?.duty ?? null};
    }),
    print: () => {}, now: () => T0 + cycle * 60_000,
    sleep: async () => { if (++cycle >= 6) controller.abort(); },
    spawn: (cmd, args) => { if (cmd === 'osascript') notifications.push(args); return {status: 0, stdout: ''}; },
  });
  return {sent, records: records.filter(r => r.kind === 'alert'), notifications, snapshots};
}
const on = (extra = {}) => ({kind: 'night', phase: 'on', by: '사람', level: '자동', duty: 'b-슈퍼감독', until: new Date(T0 + 8 * 3600_000).toISOString(), t: new Date(T0 - 60_000).toISOString(), ...extra});

test('2·3. 자동 + 당번이면 사용자로 갈 정체는 당번 창으로 가고 사용자 알림은 0통이다(RED 겹알림 줄은 건드리지 않음)', async () => {
  const r = await cycles({nightEntries: [on()]});
  const stalls = r.records.filter(x => x.alertKind === '정체' && x.role === 'a-작업자');
  assert.ok(stalls.length > 0, `정체 경보가 나와야 한다: ${JSON.stringify(r.records.map(x => [x.alertKind, x.role, x.recipient]))}`);
  assert.ok(stalls.every(x => x.recipient === 'b-슈퍼감독' && x.route.basis === '당번'));
  assert.equal(r.sent.filter(s => s.role === 'b-슈퍼감독').length, 1);
  assert.equal(r.sent.filter(s => s.role === U).length, 0);
  assert.equal(r.notifications.length, 0, 'AMBER 정체에는 겹알림이 없다(지금과 같다)');
  assert.equal(r.snapshots.length, new Set(r.snapshots).size, '주기당 스냅샷 한 번');
});

test('4·5. 당번 세션이 없으면, 꺼짐이면, 기본 단계면 지금처럼 사용자로 간다', async () => {
  for (const [name, opts] of Object.entries({
    '당번 세션 없음': {nightEntries: [on()], rosterLive: false},
    '꺼짐(off 사건)': {nightEntries: [on(), {kind: 'night', phase: 'off', by: '사람', t: new Date(T0 - 1000).toISOString()}]},
    '기본 단계': {nightEntries: [on({level: undefined, duty: undefined})]},
    '나이트런 기록 없음': {nightEntries: []},
  })) {
    const r = await cycles(opts);
    const stalls = r.records.filter(x => x.alertKind === '정체' && x.role === 'a-작업자');
    assert.ok(stalls.length > 0, name);
    assert.ok(stalls.every(x => x.route.basis !== '당번'), name);
    assert.equal(r.sent.filter(s => s.role === 'b-슈퍼감독' && /정체/.test(s.message)).length, 0, name);
  }
});

test('5. 나이트런이 꺼져 있으면 스냅샷 함수도 부르지 않아도 되는 경보 묶음(죽음·프로세스)은 수신자가 그대로다', async () => {
  const withNight = await cycles({nightEntries: [on()]});
  const without = await cycles({nightEntries: []});
  const table = r => r.records.filter(x => x.alertKind !== '정체').map(x => [x.alertKind, x.role, x.recipient, x.route?.basis]);
  assert.deepEqual(table(withNight), table(without));
});

// ---- 6. night on / night duty ----
function fixture(readWorksRoles = ['a-슈퍼감독', 'b-슈퍼감독']) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-night-duty-'));
  const file = path.join(home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify({'a-슈퍼감독': U, 'b-슈퍼감독': U, 'a-감독': 'a-슈퍼감독', 'b-감독': 'b-슈퍼감독', 'x-작업자': 'a-감독'}));
  appendLedger({kind: 'hierarchy-loaded', path: file, hash: 'x', by: 'watch'}, home);
  for (const r of ['a-슈퍼감독', 'b-슈퍼감독']) appendLedger({kind: 'start', role: r, session: `kadan-${r}`, roleProfile: 'super'}, home);
  const sent = [];
  let failFor = null;
  const works = [{key: 'a/w1', status: 'open', owner: 'a-감독', executions: []}, {key: 'b/w2', status: 'open', owner: 'b-감독', executions: []}];
  const deps = {
    now: () => T0, readWorks: () => works, notify: () => {},
    sendMail: (role, message) => { sent.push({role, message}); return failFor === role ? {ok: false, error: '실패'} : {ok: true, mailId: `m-${role}`}; },
  };
  const run = (args, flags = {}, by = '사람') => nightCommand(args, flags, {home, by, deps});
  return {home, sent, run, fail: role => { failFor = role; }, night: () => readLedger(home).filter(e => e.kind === 'night')};
}

test('6. 명시 --duty: 자동 단계에서 당번이 되고 on 사건·status·당번 우편에 보인다', () => {
  const f = fixture();
  const r = f.run(['on', '밤 위임'], {level: '자동', duty: 'b-슈퍼감독'});
  assert.equal(r.duty, 'b-슈퍼감독');
  assert.equal(r.dutySource, 'flag');
  const [ev] = f.night();
  assert.equal(ev.duty, 'b-슈퍼감독');
  assert.equal(ev.dutySource, 'flag');
  assert.equal(f.run(['status']).duty, 'b-슈퍼감독');
  const dutyMail = f.sent.find(s => s.role === 'b-슈퍼감독').message, other = f.sent.find(s => s.role === 'a-슈퍼감독').message;
  assert.match(dutyMail, /당신이 이번 나이트런의 당번/);
  assert.doesNotMatch(other, /당번/);
  assert.equal(f.sent[0].role, 'b-슈퍼감독', '당번에게 먼저 보낸다');
});

test('6. 명시 --duty 오류: --level 없음, 대상 밖, 슈퍼감독 아님, 값 없음, 두 개, 우편 실패', () => {
  const f = fixture();
  assert.throws(() => f.run(['on', '밤'], {duty: 'b-슈퍼감독'}), /--level 자동과 함께/);
  assert.throws(() => f.run(['on', '밤'], {level: '자동', duty: 'z-슈퍼감독'}), /쓸 수 없습니다/);
  assert.throws(() => f.run(['on', '밤'], {level: '자동', duty: 'a-감독'}), /슈퍼감독 이름이 아님/);
  assert.throws(() => f.run(['on', '밤'], {level: '자동', duty: true}), /--duty에는/);
  assert.throws(() => f.run(['on', '밤'], {level: '자동', duty: ['a-슈퍼감독', 'b-슈퍼감독']}), /--duty에는/);
  assert.equal(f.sent.length, 0, '오류에서는 아무에게도 보내지 않는다');
  f.fail('b-슈퍼감독');
  assert.throws(() => f.run(['on', '밤'], {level: '자동', duty: 'b-슈퍼감독'}), /우편이 가지 않아 켜지 않았습니다/);
  assert.equal(f.sent.length, 1, '실패한 당번 우편 하나뿐');
  assert.equal(f.night().length, 0);
});

test('6. 기본 당번: 자동 단계에서 쓰고(default), 기본 단계·--duty 없음에서는 쓰지 않는다', () => {
  const f = fixture();
  assert.match(f.run(['duty', 'b-슈퍼감독']), /기본 당번 저장: b-슈퍼감독/);
  assert.equal(fs.statSync(dutyPath(f.home)).mode & 0o777, 0o600);
  assert.match(f.run(['duty']), /기본 당번: b-슈퍼감독/);
  const r = f.run(['on', '밤'], {level: '자동'});
  assert.equal(r.duty, 'b-슈퍼감독');
  assert.equal(r.dutySource, 'default');
  assert.equal(f.night()[0].dutySource, 'default');
  f.run(['off']);
  const basic = f.run(['on', '밤'], {});
  assert.equal(basic.duty, null);
  assert.equal(f.night().at(-1).duty, null);
  f.run(['off']);
  const none = f.run(['on', '밤'], {level: '자동', duty: '없음'});
  assert.equal(none.duty, null);
  assert.equal(none.dutySource, 'none');
});

test('6. 기본 당번이 대상 밖이거나 우편이 실패하면 켜지되 당번은 없고 사유가 보인다', () => {
  const f = fixture();
  f.run(['duty', 'z-슈퍼감독']);
  const r = f.run(['on', '밤'], {level: '자동'});
  assert.equal(r.duty, null);
  assert.match(r.dutyNote, /기본 당번 z-슈퍼감독 못 씀\(.*\) — 당번 없음/);
  assert.equal(f.run(['status']).dutyNote, r.dutyNote);
  f.run(['off']);
  f.run(['duty', 'b-슈퍼감독']);
  f.fail('b-슈퍼감독');
  const r2 = f.run(['on', '밤'], {level: '자동'});
  assert.equal(r2.duty, null);
  assert.match(r2.dutyNote, /우편 전달 실패/);
  assert.ok(r2.delivered.some(d => d.role === 'a-슈퍼감독' && d.ok), '다른 슈퍼감독에게는 간다');
});

test('6. night duty: 보기·저장·지우기, 슈퍼감독 이름 꼴만, 두 이름·--clear와 이름은 오류', () => {
  const f = fixture();
  assert.match(f.run(['duty']), /기본 당번: 없음/);
  assert.throws(() => f.run(['duty', 'a-감독']), /슈퍼감독 역할 이름/);
  assert.throws(() => f.run(['duty', 'a-슈퍼감독', 'b-슈퍼감독']), /하나만/);
  assert.throws(() => f.run(['duty', 'a-슈퍼감독'], {clear: true}), /혼자 씁니다/);
  f.run(['duty', 'a-슈퍼감독']);
  assert.match(f.run(['duty'], {clear: true}), /기본 당번 지움 \(이전 a-슈퍼감독\)/);
  assert.match(f.run(['duty']), /기본 당번: 없음/);
});

test('6. night-guard: 나이트런 중 역할 세션의 duty 저장·지우기는 거절, 보기와 사람·꺼짐은 통과', () => {
  assert.equal(guardedReason('night', ['duty'], {}), null);
  assert.equal(guardedReason('night', ['duty', 'a-슈퍼감독'], {}), 'night duty 저장');
  assert.equal(guardedReason('night', ['duty'], {clear: true}), 'night duty 저장');
  const entries = [on()], home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-night-duty-guard-'));
  const call = (env, args = ['duty', 'a-슈퍼감독'], flags = {}) => nightGuard({command: 'night', args, flags, home, env, now: T0, entries, decisionEvents: []});
  assert.throws(() => call({KADAN_ROLE: 'a-슈퍼감독'}), /나이트 모드가 켜져 있어/);
  assert.doesNotThrow(() => call({}));
  assert.doesNotThrow(() => call({KADAN_ROLE: 'a-슈퍼감독'}, ['duty']));
  assert.doesNotThrow(() => nightGuard({command: 'night', args: ['duty', 'a-슈퍼감독'], flags: {}, home, env: {KADAN_ROLE: 'a-슈퍼감독'}, now: T0 + 9 * 3600_000, entries, decisionEvents: []}));
});

// ---- 7. 요약 ----
function summary(entries, start = on()) {
  return summarizeNight({start, phase: 'expired', endedAt: T0 + 3600_000, entries, decisionEvents: [], readBody: () => null});
}
const dutyAlert = (id, extra = {}) => ({kind: 'alert', id, alertKind: '정체', role: 'a-슈퍼감독', recipient: 'b-슈퍼감독', route: {recipient: 'b-슈퍼감독', basis: '당번'}, delivered: true, by: 'watch', t: new Date(T0 + 60_000).toISOString(), ...extra});

test('7. 요약 제목 줄 끝에 당번 이름, 당번이 받은 경보 N건(0건이면 줄 없음), 상한 안', () => {
  const two = summary([dutyAlert('s1'), dutyAlert('s2'), dutyAlert('s1')]);
  assert.match(two.text.split('\n')[1], /^나이트 모드 요약 \(.*\) · 당번 b-슈퍼감독$/, '제목 줄 끝');
  assert.match(two.text, /당번이 받은 경보 2건/);
  assert.equal(two.counts.dutyAlerts, 2);
  const zero = summary([]);
  assert.doesNotMatch(zero.text, /당번이 받은 경보/);
  assert.match(summary([], on({duty: undefined})).text.split('\n')[1], / · 당번 없음$/);
  assert.ok(two.text.length <= 1800);
  const longQuote = 'x'.repeat(4000);
  assert.ok(summary([dutyAlert('s1')], on({text: longQuote, quote: longQuote, viaChat: true, by: 'c-슈퍼감독'})).text.length <= 1800);
  const outside = summary([dutyAlert('s9', {t: new Date(T0 + 10 * 3600_000).toISOString()})]);
  assert.doesNotMatch(outside.text, /당번이 받은 경보/);
});

// ---- 8. 지침 ----
test('8. 당번 우편의 지침: 15분·[나이트 보류]·restart는 본인 판단·--force 금지, --duty 없으면 그 줄 없음', () => {
  const f = fixture();
  f.run(['on', '밤'], {level: '자동', duty: 'b-슈퍼감독'});
  const text = f.sent.find(s => s.role === 'b-슈퍼감독').message;
  assert.match(text, /15분 뒤에도 그대로면/);
  assert.match(text, /\[나이트 보류\]/);
  assert.match(text, /재시작\(`kadan restart`\)은 그 슈퍼감독 본인의 판단/);
  assert.match(text, /`--force`는 쓰지 않고/);
  const g = fixture();
  g.run(['on', '밤'], {level: '자동'});
  for (const s of g.sent) for (const line of DUTY_LINES) assert.ok(!s.message.includes(line.slice(0, 20)));
});

// ---- 검수 반영(exec-30008157) ----
test('P1-F 일반 반복문: 당번이 관계표에 없어도 당번 전달이 확실히 실패하면 사용자가 전달실패를 받는다', async () => {
  const r = await cycles({nightEntries: [on()], failDuty: true, dutyInTable: false});
  assert.ok(r.sent.some(x => x.role === 'b-슈퍼감독'), '당번에게 먼저 시도');
  // 사용자 알림은 sendAlert 콜백이 아니라 사용자 알림 경로(notifyUser)로 나가므로 원장 전달 기록으로 본다.
  const failure = r.records.filter(x => x.alertKind === '전달실패');
  assert.ok(failure.length > 0 && failure.every(x => x.recipient === U && x.delivered === true), JSON.stringify(r.records.map(x => [x.alertKind, x.recipient, x.delivered])));
  assert.ok(r.records.some(x => x.alertKind === '정체' && x.recipient === 'b-슈퍼감독' && x.delivered === false));
});

test('P2-C 읽기가 던져도 같은 주기에 경보가 여러 건이면 읽기 호출은 1회, 경보는 사용자로', async () => {
  const calls = [];
  const r = await cycles({nightEntries: [on()], workers: ['a-작업자', 'c-작업자'], reader: ({now}) => { calls.push(now); throw new Error('읽기 실패'); }});
  const stalls = r.records.filter(x => x.alertKind === '정체');
  assert.ok(stalls.length >= 2);
  assert.ok(stalls.every(x => x.route.basis !== '당번'));
  assert.equal(calls.length, new Set(calls).size, '주기당 최대 1회');
});

test('P2-D 결정 저장소 읽기: 엄격한 읽기는 던지고 기존 읽기는 [] 그대로', async () => {
  const {readDecisionEvents, readDecisionEventsStrict} = await import('../src/night.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-night-duty-corrupt-'));
  fs.writeFileSync(path.join(home, 'kadan.sqlite'), 'not a database');
  fs.writeFileSync(path.join(home, 'storage.json'), JSON.stringify({version: 1, backend: 'sqlite'}));
  assert.deepEqual(readDecisionEvents(home), []);
  assert.throws(() => readDecisionEventsStrict(home));
});

test('P2-I 기본 당번 쓰기는 사람만: 역할 행위자는 꺼져 있어도 거절, 파일 그대로, 보기는 성공', () => {
  const f = fixture();
  f.run(['duty', 'b-슈퍼감독']);
  const before = fs.readFileSync(dutyPath(f.home), 'utf8');
  assert.throws(() => f.run(['duty', 'a-슈퍼감독'], {}, 'a-슈퍼감독'), /사람만/);
  assert.throws(() => f.run(['duty'], {clear: true}, 'a-슈퍼감독'), /사람만/);
  assert.equal(fs.readFileSync(dutyPath(f.home), 'utf8'), before);
  assert.match(f.run(['duty'], {}, 'a-슈퍼감독'), /기본 당번: b-슈퍼감독/);
});

test('6가. 기본 단계 on 사건에도 duty null·dutySource none', () => {
  const f = fixture();
  f.run(['on', '밤'], {});
  const [ev] = f.night();
  assert.equal(ev.duty, null);
  assert.equal(ev.dutySource, 'none');
});

test('8. 요약: 감시 AI 경로의 당번 경보(id 없이 requestId)도 센다', () => {
  const ai = rid => ({kind: 'alert', by: 'watch', source: 'watch-ai', requestId: rid, alertKind: '정체', role: 'a-슈퍼감독', recipient: 'b-슈퍼감독',
    route: {recipient: 'b-슈퍼감독', basis: '당번'}, delivered: true, t: new Date(T0 + 60_000).toISOString()});
  const r = summary([ai('r1'), ai('r1'), ai('r2'), dutyAlert('s1')]);
  assert.match(r.text, /당번이 받은 경보 3건/);
});
