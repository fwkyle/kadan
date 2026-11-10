import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {autopilotCommand} from '../src/commands/autopilot.mjs';
import {autopilotGuard, guardedReason} from '../src/autopilot-guard.mjs';
import {applyWingmanRoute, WINGMAN_LINES, wingmanPath} from '../src/autopilot-wingman.mjs';
import {summarizeAutopilot} from '../src/autopilot-summary.mjs';
import {runWatch} from '../src/watch-runner.mjs';

// 가짜 시계·가짜 우편·가짜 세션 목록·가짜 전송만 쓴다. 운영 홈·tmux·알림·디코에 닿지 않는다. 역할 이름도 시험용이다.
const T0 = Date.parse('2026-11-09T14:00:00.000Z');
const U = '@user';
const live = (...roles) => new Set(roles.map(r => `kadan-${r}`));
const autopilot = {on: true, level: 'autopilot', wingman: 'b-슈퍼감독'};
const stall = {id: 'stall:a', kind: '정체', role: 'a-슈퍼감독', level: 'RED'};
const idle2 = {id: 'idle:a:상위', kind: '놀고 있음', role: 'a-슈퍼감독', stage: 2};
const userRoute = {recipient: U, basis: 'supervisor', skipped: []};
const L = live('b-슈퍼감독', 'a-슈퍼감독');

// ---- 1. 덮어쓰기 함수 표 ----
test('1. 모든 조건이 참이면 Wingman이 되고 route.basis는 Wingman이다', () => {
  for (const alert of [stall, idle2]) {
    const r = applyWingmanRoute({route: userRoute, alert, autopilot, liveSessions: L});
    assert.equal(r.recipient, 'b-슈퍼감독');
    assert.equal(r.basis, 'wingman');
  }
});

test('1. 조건을 하나씩 거짓으로 바꾸면 수신자가 사용자로 남는다', () => {
  const base = {route: userRoute, alert: stall, autopilot, liveSessions: L};
  const cases = {
    '원래 수신자가 사용자 아님': {route: {recipient: 'x', basis: 'supervisor'}},
    '꺼짐': {autopilot: {...autopilot, on: false}},
    'cruise 단계': {autopilot: {...autopilot, level: 'cruise'}},
    'Wingman 없음': {autopilot: {...autopilot, wingman: null}},
    'Autopilot 상태 없음': {autopilot: null},
    '놀고 있음 1단': {alert: {...idle2, stage: 1}},
    '죽음': {alert: {id: 'd', kind: '죽음', role: 'a-슈퍼감독'}},
    '프로세스': {alert: {id: 'p', kind: '프로세스'}},
    '한도': {alert: {id: 'l', kind: '한도', role: 'a-슈퍼감독'}},
    'Wingman 자신의 정체': {alert: {...stall, role: 'b-슈퍼감독'}},
    'Wingman 세션 없음': {liveSessions: live('a-슈퍼감독')},
    '관측 실패(null)': {liveSessions: null},
  };
  for (const [name, patch] of Object.entries(cases)) {
    const r = applyWingmanRoute({...base, ...patch});
    if (name === '원래 수신자가 사용자 아님') assert.equal(r.recipient, 'x', name);
    else assert.equal(r.recipient, U, name);
    assert.notEqual(r.basis, 'Wingman', name);
  }
});

// ---- 2~5. 감시 한 주기 통합 ----
async function cycles({autopilotEntries, rosterLive = true, wingmanRole = 'b-슈퍼감독', userNotify = true, workers = ['a-작업자'], reader = null, failWingman = false, wingmanInTable = true} = {}) {
  const controller = new AbortController(), sent = [], records = [], notifications = [], snapshots = [];
  let cycle = 0;
  const t = '2026-11-09T13:00:00Z';
  // 정체를 내는 대상은 부모가 사용자인 작업자다(수신자 계산이 @user가 되는 가장 작은 모양). 덮어쓰기는 수신자만 보므로 같은 경로다.
  const worker = workers[0];
  const entries = [
    ...workers.map((w, i) => ({kind: 'start', role: w, session: `kadan-${w}`, panePid: 10 + i, t})),
    ...(rosterLive ? [{kind: 'start', role: wingmanRole, session: `kadan-${wingmanRole}`, panePid: 2, t, roleProfile: 'super'}] : []),
    ...workers.map((w, i) => ({kind: 'send', role: w, taskId: `c${i}`, t})),
    ...autopilotEntries,
  ];
  const cards = workers.map((w, i) => ({id: `c${i}`, key: `r/c${i}`, role: w, status: 'assigned', workType: 'execution', activity: 'running', activityRole: w, activityAt: t}));
  const sessions = [...workers.map((w, i) => ({session: `kadan-${w}`, pid: 10 + i})), ...(rosterLive ? [{session: `kadan-${wingmanRole}`, pid: 2}] : [])];
  await runWatch({
    floor: {list: () => sessions, read: s => (workers.some(w => s === `kadan-${w}`) ? 'same screen' : 'healthy')},
    readEntries: () => entries, readCards: () => cards, readWorks: () => [], readDecisions: () => [], record: e => records.push(e),
    sendAlert: (role, message) => {
      sent.push({role, message});
      if (failWingman && role === wingmanRole) throw Object.assign(new Error('가짜 전달 실패'), {delivery: 'not-sent'});
    },
    parents: new Map([...workers.map(w => [w, U]), ...(wingmanInTable ? [[wingmanRole, U]] : [])]), routes: new Map(), superRole: null,
    intervalMs: 60_000, stallN: 2, stallAfterMs: 0, signal: controller.signal, userNotify,
    readAutopilotWingman: reader ?? (({entries: es, now}) => {
      const last = [...es].reverse().find(e => e.kind === 'autopilot');
      snapshots.push(now);
      return {on: last?.phase === 'on', level: last?.level ?? 'cruise', wingman: last?.wingman ?? null};
    }),
    print: () => {}, now: () => T0 + cycle * 60_000,
    sleep: async () => { if (++cycle >= 6) controller.abort(); },
    spawn: (cmd, args) => { if (cmd === 'osascript') notifications.push(args); return {status: 0, stdout: ''}; },
  });
  return {sent, records: records.filter(r => r.kind === 'alert'), notifications, snapshots};
}
const on = (extra = {}) => ({kind: 'autopilot', phase: 'on', by: '사람', level: 'autopilot', wingman: 'b-슈퍼감독', until: new Date(T0 + 8 * 3600_000).toISOString(), t: new Date(T0 - 60_000).toISOString(), ...extra});

test('2·3. 자동 + Wingman이면 사용자로 갈 정체는 Wingman 창으로 가고 사용자 알림은 0통이다(RED 겹알림 줄은 건드리지 않음)', async () => {
  const r = await cycles({autopilotEntries: [on()]});
  const stalls = r.records.filter(x => x.alertKind === '정체' && x.role === 'a-작업자');
  assert.ok(stalls.length > 0, `정체 경보가 나와야 한다: ${JSON.stringify(r.records.map(x => [x.alertKind, x.role, x.recipient]))}`);
  assert.ok(stalls.every(x => x.recipient === 'b-슈퍼감독' && x.route.basis === 'wingman'));
  assert.equal(r.sent.filter(s => s.role === 'b-슈퍼감독').length, 1);
  assert.equal(r.sent.filter(s => s.role === U).length, 0);
  assert.equal(r.notifications.length, 0, 'AMBER 정체에는 겹알림이 없다(지금과 같다)');
  assert.equal(r.snapshots.length, new Set(r.snapshots).size, '주기당 스냅샷 한 번');
});

test('4·5. Wingman 세션이 없으면, 꺼짐이면, 기본 단계면 지금처럼 사용자로 간다', async () => {
  for (const [name, opts] of Object.entries({
    'Wingman 세션 없음': {autopilotEntries: [on()], rosterLive: false},
    '꺼짐(off 사건)': {autopilotEntries: [on(), {kind: 'autopilot', phase: 'off', by: '사람', t: new Date(T0 - 1000).toISOString()}]},
    'cruise 단계': {autopilotEntries: [on({level: undefined, wingman: undefined})]},
    'Autopilot 기록 없음': {autopilotEntries: []},
  })) {
    const r = await cycles(opts);
    const stalls = r.records.filter(x => x.alertKind === '정체' && x.role === 'a-작업자');
    assert.ok(stalls.length > 0, name);
    assert.ok(stalls.every(x => x.route.basis !== 'wingman'), name);
    assert.equal(r.sent.filter(s => s.role === 'b-슈퍼감독' && /정체/.test(s.message)).length, 0, name);
  }
});

test('5. Autopilot이 꺼져 있으면 스냅샷 함수도 부르지 않아도 되는 경보 묶음(죽음·프로세스)은 수신자가 그대로다', async () => {
  const withAutopilot = await cycles({autopilotEntries: [on()]});
  const without = await cycles({autopilotEntries: []});
  const table = r => r.records.filter(x => x.alertKind !== '정체').map(x => [x.alertKind, x.role, x.recipient, x.route?.basis]);
  assert.deepEqual(table(withAutopilot), table(without));
});

// ---- 6. autopilot on / autopilot wingman ----
function fixture(readWorksRoles = ['a-슈퍼감독', 'b-슈퍼감독']) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-autopilot-wingman-'));
  const file = path.join(home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify({'a-슈퍼감독': U, 'b-슈퍼감독': U, 'a-감독': 'a-슈퍼감독', 'b-감독': 'b-슈퍼감독', 'x-작업자': 'a-감독'}));
  appendLedger({kind: 'hierarchy-loaded', path: file, hash: 'x', by: 'watch'}, home);
  for (const r of ['a-슈퍼감독', 'b-슈퍼감독']) appendLedger({kind: 'start', role: r, session: `kadan-${r}`, roleProfile: 'super'}, home);
  const sent = [];
  let failFor = null, failDelivery = 'not-sent';
  const works = [{key: 'a/w1', status: 'open', owner: 'a-감독', executions: []}, {key: 'b/w2', status: 'open', owner: 'b-감독', executions: []}];
  const deps = {
    now: () => T0, readWorks: () => works, notify: () => {},
    sendMail: (role, message) => { sent.push({role, message}); return failFor === role ? {ok: false, error: '실패', ...(failDelivery ? {delivery: failDelivery} : {})} : {ok: true, mailId: `m-${role}`}; },
  };
  const run = (args, flags = {}, by = '사람') => autopilotCommand(args, flags, {home, by, deps});
  return {home, sent, run, fail: (role, ...delivery) => { failFor = role; failDelivery = delivery.length ? delivery[0] : 'not-sent'; }, autopilot: () => readLedger(home).filter(e => e.kind === 'autopilot')};
}

test('6. 명시 --wingman: Autopilot 단계에서 Wingman이 되고 on 사건·status·Wingman 우편에 보인다', () => {
  const f = fixture();
  const r = f.run(['on', '밤 위임'], {level: 'autopilot', wingman: 'b-슈퍼감독'});
  assert.equal(r.wingman, 'b-슈퍼감독');
  assert.equal(r.wingmanSource, 'flag');
  const [ev] = f.autopilot();
  assert.equal(ev.wingman, 'b-슈퍼감독');
  assert.equal(ev.wingmanSource, 'flag');
  assert.equal(f.run(['status']).wingman, 'b-슈퍼감독');
  const wingmanMail = f.sent.find(s => s.role === 'b-슈퍼감독').message, other = f.sent.find(s => s.role === 'a-슈퍼감독').message;
  assert.match(wingmanMail, /당신이 이번 Autopilot의 Wingman/);
  assert.doesNotMatch(other, /Wingman/);
  assert.equal(f.sent[0].role, 'b-슈퍼감독', 'Wingman에게 먼저 보낸다');
});

test('6. 명시 --wingman 오류: --level 없음, 대상 밖, 슈퍼감독 아님, 값 없음, 두 개, 우편 실패', () => {
  const f = fixture();
  assert.throws(() => f.run(['on', '밤'], {wingman: 'b-슈퍼감독'}), /--level autopilot과 함께/);
  assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', wingman: 'z-슈퍼감독'}), /쓸 수 없습니다/);
  assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', wingman: 'a-감독'}), /슈퍼감독 이름이 아님/);
  assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', wingman: true}), /--wingman에는/);
  assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', wingman: ['a-슈퍼감독', 'b-슈퍼감독']}), /--wingman에는/);
  assert.equal(f.sent.length, 0, '오류에서는 아무에게도 보내지 않는다');
  f.fail('b-슈퍼감독');
  assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', wingman: 'b-슈퍼감독'}), /우편이 가지 않아 켜지 않았습니다/);
  assert.equal(f.sent.length, 1, '실패한 Wingman 우편 하나뿐');
  assert.equal(f.autopilot().length, 0);
});

test('6. 기본 Wingman: Autopilot 단계에서 쓰고(default), 기본 단계·--wingman 없음에서는 쓰지 않는다', () => {
  const f = fixture();
  assert.match(f.run(['wingman', 'b-슈퍼감독']), /기본 Wingman 저장: b-슈퍼감독/);
  assert.equal(fs.statSync(wingmanPath(f.home)).mode & 0o777, 0o600);
  assert.match(f.run(['wingman']), /기본 Wingman: b-슈퍼감독/);
  const r = f.run(['on', '밤'], {level: 'autopilot'});
  assert.equal(r.wingman, 'b-슈퍼감독');
  assert.equal(r.wingmanSource, 'default');
  assert.equal(f.autopilot()[0].wingmanSource, 'default');
  f.run(['off']);
  const basic = f.run(['on', '밤'], {});
  assert.equal(basic.wingman, null);
  assert.equal(f.autopilot().at(-1).wingman, null);
  f.run(['off']);
  const none = f.run(['on', '밤'], {level: 'autopilot', wingman: '없음'});
  assert.equal(none.wingman, null);
  assert.equal(none.wingmanSource, 'none');
});

test('6. 기본 Wingman이 대상 밖이거나 우편이 실패하면 켜지되 Wingman은 없고 사유가 보인다', () => {
  const f = fixture();
  f.run(['wingman', 'z-슈퍼감독']);
  const r = f.run(['on', '밤'], {level: 'autopilot'});
  assert.equal(r.wingman, null);
  assert.match(r.wingmanNote, /기본 Wingman z-슈퍼감독 못 씀\(.*\) — Wingman 없음/);
  assert.equal(f.run(['status']).wingmanNote, r.wingmanNote);
  f.run(['off']);
  f.run(['wingman', 'b-슈퍼감독']);
  f.fail('b-슈퍼감독');
  const r2 = f.run(['on', '밤'], {level: 'autopilot'});
  assert.equal(r2.wingman, null);
  assert.match(r2.wingmanNote, /우편 전달 실패/);
  assert.ok(r2.delivered.some(d => d.role === 'a-슈퍼감독' && d.ok), '다른 슈퍼감독에게는 간다');
});

// 불변식(2026-11-10): 감독이 켜짐 우편을 받았을 수 있으면 원장은 켜짐이다. 확실히 안 간 경우(not-sent)만 멈춘다.
test('6. 명시 --wingman 우편 결과: 전달됨·기록 실패와 불명확은 켜짐(Wingman 유지·전달 불명확), 확실히 안 감은 멈춤', () => {
  for (const [delivery, on] of [['sent', true], ['unknown', true], [undefined, true], ['not-sent', false]]) {
    const f = fixture();
    f.fail('b-슈퍼감독', delivery);
    if (!on) {
      assert.throws(() => f.run(['on', '밤'], {level: 'autopilot', wingman: 'b-슈퍼감독'}), /우편이 가지 않아 켜지 않았습니다/, String(delivery));
      assert.equal(f.autopilot().length, 0);
      assert.equal(f.sent.length, 1, '다른 슈퍼감독에게 보내지 않는다');
      continue;
    }
    const r = f.run(['on', '밤'], {level: 'autopilot', wingman: 'b-슈퍼감독'});
    assert.equal(r.wingman, 'b-슈퍼감독', String(delivery));
    assert.equal(r.wingmanSource, 'flag');
    assert.match(r.wingmanNote, /전달 불명확/);
    const [ev] = f.autopilot();
    assert.equal(ev.phase, 'on');
    assert.equal(ev.wingman, 'b-슈퍼감독');
    assert.match(ev.wingmanNote, /전달 불명확/);
    assert.ok(f.sent.some(s => s.role === 'a-슈퍼감독'), '다른 슈퍼감독에게도 간다');
    assert.equal(f.run(['status']).on, true);
  }
});

test('6. 기본 Wingman 우편 결과도 같은 규칙: 전달됨·기록 실패와 불명확은 Wingman 유지, 확실히 안 감은 Wingman 없음', () => {
  for (const [delivery, kept] of [['sent', true], ['unknown', true], ['not-sent', false]]) {
    const f = fixture();
    f.run(['wingman', 'b-슈퍼감독']);
    f.fail('b-슈퍼감독', delivery);
    const r = f.run(['on', '밤'], {level: 'autopilot'});
    assert.equal(f.autopilot().length, 1, delivery);
    assert.equal(r.wingman, kept ? 'b-슈퍼감독' : null, delivery);
    assert.equal(r.wingmanSource, kept ? 'default' : 'none');
    assert.match(r.wingmanNote, kept ? /전달 불명확/ : /우편 전달 실패/);
  }
});

test('6. autopilot wingman: 보기·저장·지우기, 슈퍼감독 이름 꼴만, 두 이름·--clear와 이름은 오류', () => {
  const f = fixture();
  assert.match(f.run(['wingman']), /기본 Wingman: 없음/);
  assert.throws(() => f.run(['wingman', 'a-감독']), /슈퍼감독 역할 이름/);
  assert.throws(() => f.run(['wingman', 'a-슈퍼감독', 'b-슈퍼감독']), /하나만/);
  assert.throws(() => f.run(['wingman', 'a-슈퍼감독'], {clear: true}), /혼자 씁니다/);
  f.run(['wingman', 'a-슈퍼감독']);
  assert.match(f.run(['wingman'], {clear: true}), /기본 Wingman 지움 \(이전 a-슈퍼감독\)/);
  assert.match(f.run(['wingman']), /기본 Wingman: 없음/);
});

test('6. autopilot-guard: Autopilot 중 역할 세션의 wingman 저장·지우기는 거절, 보기와 사람·꺼짐은 통과', () => {
  assert.equal(guardedReason('autopilot', ['wingman'], {}), null);
  assert.equal(guardedReason('autopilot', ['wingman', 'a-슈퍼감독'], {}), 'autopilot wingman 저장');
  assert.equal(guardedReason('autopilot', ['wingman'], {clear: true}), 'autopilot wingman 저장');
  const entries = [on()], home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-autopilot-wingman-guard-'));
  const call = (env, args = ['wingman', 'a-슈퍼감독'], flags = {}) => autopilotGuard({command: 'autopilot', args, flags, home, env, now: T0, entries, decisionEvents: []});
  assert.throws(() => call({KADAN_ROLE: 'a-슈퍼감독'}), /Autopilot이 켜져 있어/);
  assert.doesNotThrow(() => call({}));
  assert.doesNotThrow(() => call({KADAN_ROLE: 'a-슈퍼감독'}, ['wingman']));
  assert.doesNotThrow(() => autopilotGuard({command: 'autopilot', args: ['wingman', 'a-슈퍼감독'], flags: {}, home, env: {KADAN_ROLE: 'a-슈퍼감독'}, now: T0 + 9 * 3600_000, entries, decisionEvents: []}));
});

// ---- 7. 요약 ----
function summary(entries, start = on()) {
  return summarizeAutopilot({start, phase: 'expired', endedAt: T0 + 3600_000, entries, decisionEvents: [], readBody: () => null});
}
const wingmanAlert = (id, extra = {}) => ({kind: 'alert', id, alertKind: '정체', role: 'a-슈퍼감독', recipient: 'b-슈퍼감독', route: {recipient: 'b-슈퍼감독', basis: 'wingman'}, delivered: true, by: 'watch', t: new Date(T0 + 60_000).toISOString(), ...extra});

test('7. 요약 제목 줄 끝에 Wingman 이름, Wingman이 받은 경보 N건(0건이면 줄 없음), 상한 안', () => {
  const two = summary([wingmanAlert('s1'), wingmanAlert('s2'), wingmanAlert('s1')]);
  assert.match(two.text.split('\n')[1], /^Autopilot 요약 \(.*\) · Wingman b-슈퍼감독$/, '제목 줄 끝');
  assert.match(two.text, /Wingman이 받은 경보 2건/);
  assert.equal(two.counts.wingmanAlerts, 2);
  const zero = summary([]);
  assert.doesNotMatch(zero.text, /Wingman이 받은 경보/);
  assert.match(summary([], on({wingman: undefined})).text.split('\n')[1], / · Wingman 없음$/);
  assert.ok(two.text.length <= 1800);
  const longQuote = 'x'.repeat(4000);
  assert.ok(summary([wingmanAlert('s1')], on({text: longQuote, quote: longQuote, viaChat: true, by: 'c-슈퍼감독'})).text.length <= 1800);
  const outside = summary([wingmanAlert('s9', {t: new Date(T0 + 10 * 3600_000).toISOString()})]);
  assert.doesNotMatch(outside.text, /Wingman이 받은 경보/);
});

// ---- 8. 지침 ----
test('8. Wingman 우편의 지침: 15분·[Autopilot 보류]·restart는 본인 판단·--force 금지, --wingman 없으면 그 줄 없음', () => {
  const f = fixture();
  f.run(['on', '밤'], {level: 'autopilot', wingman: 'b-슈퍼감독'});
  const text = f.sent.find(s => s.role === 'b-슈퍼감독').message;
  assert.match(text, /15분 뒤에도 그대로면/);
  assert.match(text, /\[Autopilot 보류\]/);
  assert.match(text, /재시작\(`kadan restart`\)은 그 슈퍼감독 본인의 판단/);
  assert.match(text, /`--force`는 쓰지 않고/);
  const g = fixture();
  g.run(['on', '밤'], {level: 'autopilot'});
  for (const s of g.sent) for (const line of WINGMAN_LINES) assert.ok(!s.message.includes(line.slice(0, 20)));
});

// ---- 검수 반영(exec-30008157) ----
test('P1-F 일반 반복문: Wingman이 관계표에 없어도 Wingman 전달이 확실히 실패하면 사용자가 전달실패를 받는다', async () => {
  const r = await cycles({autopilotEntries: [on()], failWingman: true, wingmanInTable: false});
  assert.ok(r.sent.some(x => x.role === 'b-슈퍼감독'), 'Wingman에게 먼저 시도');
  // 사용자 알림은 sendAlert 콜백이 아니라 사용자 알림 경로(notifyUser)로 나가므로 원장 전달 기록으로 본다.
  const failure = r.records.filter(x => x.alertKind === '전달실패');
  assert.ok(failure.length > 0 && failure.every(x => x.recipient === U && x.delivered === true), JSON.stringify(r.records.map(x => [x.alertKind, x.recipient, x.delivered])));
  assert.ok(r.records.some(x => x.alertKind === '정체' && x.recipient === 'b-슈퍼감독' && x.delivered === false));
});

test('P2-C 읽기가 던져도 같은 주기에 경보가 여러 건이면 읽기 호출은 1회, 경보는 사용자로', async () => {
  const calls = [];
  const r = await cycles({autopilotEntries: [on()], workers: ['a-작업자', 'c-작업자'], reader: ({now}) => { calls.push(now); throw new Error('읽기 실패'); }});
  const stalls = r.records.filter(x => x.alertKind === '정체');
  assert.ok(stalls.length >= 2);
  assert.ok(stalls.every(x => x.route.basis !== 'wingman'));
  assert.equal(calls.length, new Set(calls).size, '주기당 최대 1회');
});

test('P2-D 결정 저장소 읽기: 엄격한 읽기는 던지고 기존 읽기는 [] 그대로', async () => {
  const {readDecisionEvents, readDecisionEventsStrict} = await import('../src/autopilot.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-autopilot-wingman-corrupt-'));
  fs.writeFileSync(path.join(home, 'kadan.sqlite'), 'not a database');
  fs.writeFileSync(path.join(home, 'storage.json'), JSON.stringify({version: 1, backend: 'sqlite'}));
  assert.deepEqual(readDecisionEvents(home), []);
  assert.throws(() => readDecisionEventsStrict(home));
});

test('P2-I 기본 Wingman 쓰기는 사람만: 역할 행위자는 꺼져 있어도 거절, 파일 그대로, 보기는 성공', () => {
  const f = fixture();
  f.run(['wingman', 'b-슈퍼감독']);
  const before = fs.readFileSync(wingmanPath(f.home), 'utf8');
  assert.throws(() => f.run(['wingman', 'a-슈퍼감독'], {}, 'a-슈퍼감독'), /사람만/);
  assert.throws(() => f.run(['wingman'], {clear: true}, 'a-슈퍼감독'), /사람만/);
  assert.equal(fs.readFileSync(wingmanPath(f.home), 'utf8'), before);
  assert.match(f.run(['wingman'], {}, 'a-슈퍼감독'), /기본 Wingman: b-슈퍼감독/);
});

test('6가. 기본 단계 on 사건에도 wingman null·wingmanSource none', () => {
  const f = fixture();
  f.run(['on', '밤'], {});
  const [ev] = f.autopilot();
  assert.equal(ev.wingman, null);
  assert.equal(ev.wingmanSource, 'none');
});

test('8. 요약: 감시 AI 경로의 Wingman 경보(id 없이 requestId)도 센다', () => {
  const ai = rid => ({kind: 'alert', by: 'watch', source: 'watch-ai', requestId: rid, alertKind: '정체', role: 'a-슈퍼감독', recipient: 'b-슈퍼감독',
    route: {recipient: 'b-슈퍼감독', basis: 'wingman'}, delivered: true, t: new Date(T0 + 60_000).toISOString()});
  const r = summary([ai('r1'), ai('r1'), ai('r2'), wingmanAlert('s1')]);
  assert.match(r.text, /Wingman이 받은 경보 3건/);
});
