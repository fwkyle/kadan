import "./helpers/isolated-home.mjs";
import test from 'node:test';
import {spawn} from 'node:child_process';
import {notifyUser, resetDiscordBlock, NOTIFY_LOG_FILE} from '../src/user-notify.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {readStream} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {autopilotCommand} from '../src/commands/autopilot.mjs';
import {DecisionStore, decisionCommand} from '../src/decisions.mjs';
import {autopilotGuard} from '../src/autopilot-guard.mjs';
import {summarizeAutopilot} from '../src/autopilot-summary.mjs';
import {applyWingmanRoute} from '../src/autopilot-wingman.mjs';
import {buildAutopilotMessage, autopilotWingmanSnapshot, parseDecideAfter, storedDecideAfterMs} from '../src/autopilot.mjs';
import {proceedEligibility, gatedDecisionText, releasedFromWait} from '../src/decision-proceed.mjs';
import {atLeast, levelRank, LEVELS} from '../src/autopilot-terms.mjs';
import {autopilotStrip} from '../src/dashboard/autopilot-view.mjs';
import {itemizedAlert} from '../src/watch-alert-body.mjs';
import {holdBlocks, holdReason, mayProceed, PROHIBITED_SUMMARY} from '../src/decision-proceed.mjs';
import {CardStore} from '../src/card-store.mjs';

// 가짜 시계·가짜 우편·가짜 알림만 쓴다. 운영 홈·우편·디코·OS 알림에 닿지 않는다. 역할 이름도 시험용이다.
const H = 3_600_000, MIN = 60_000;
const SUPER = 'a-슈퍼감독', UP = 't-슈퍼감독', OTHER = 'b-슈퍼감독';
const savedNotify = process.env.KADAN_NOTIFY;
const withNotify = fn => { process.env.KADAN_NOTIFY = 'on'; try { return fn(); } finally { process.env.KADAN_NOTIFY = savedNotify; } };

function world({decideAfter, level = 'full', on = true, onAt = Date.now() - 1000} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-autopilot-full-'));
  const file = path.join(home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify({[SUPER]: UP, [UP]: '@user', [OTHER]: '@user', 'a-감독': SUPER}));
  appendLedger({kind: 'hierarchy-loaded', path: file, hash: 'x', by: 'watch'}, home);
  for (const role of [SUPER, UP, OTHER]) appendLedger({kind: 'start', role, session: `kadan-${role}`, roleProfile: 'super'}, home);
  new WorkStore(home).create({key: 'a/w1', title: '시험', goal: '목표', scope: '범위', acceptance: '조건', owner: 'a-감독', repoPath: os.tmpdir()});
  const sent = [], user = [], answers = [], hook = {impl: null};
  const notifyVia = (...x) => { user.push(x); return hook.impl ? hook.impl(...x) : null; };
  const store = new DecisionStore(home, {notify: (...x) => answers.push(x), userNotify: (...x) => notifyVia(...x)});
  const deps = (at = onAt) => ({now: () => at, sendMail: (role, message) => { sent.push({role, message}); return {ok: true, mailId: 'm'}; }, notify: () => {}});
  const turnOn = (flags = {}, by = '사람', at = onAt) => autopilotCommand(['on', '밤 위임'], {level, ...(decideAfter ? {'decide-after': decideAfter} : {}), ...flags}, {home, by, deps: deps(at)});
  if (on) turnOn();
  const events = () => readStream(home, 'decisions/events.jsonl', {optional: true});
  const request = (over = {}) => {
    const input = {chat: true, work: 'a/w1', question: '이 순서로 갈까요?', options: ['예', '아니오'],
      recommendation: '예', reason: '- 확인 경로 없음: 시험', reversible: '브랜치를 지운다', notProhibited: true, ...over};
    if (input.reversible === undefined && !('notProhibited' in over)) delete input.notProhibited;
    return store.request(null, input, SUPER);
  };
  const proceed = (id, {at, by = SUPER, revision} = {}) => {
    const rev = revision ?? store.get(id).revision;
    return decisionCommand(['proceed', id], {revision: rev}, {home, by, now: () => at, notify: (...x) => answers.push(x), userNotify: (...x) => notifyVia(...x)});
  };
  return {hook, home, store, sent, user, answers, turnOn, events, request, proceed, ledger: () => readLedger(home), t0: onAt};
}
const refusal = (fn, ...needles) => assert.throws(fn, error => error.exitCode === 2 && needles.every(n => error.message.includes(n)), needles.join(' / '));

// (1) 단계는 순서다 -----------------------------------------------------------------------------------------------
test('(1) 단계 순서: cruise < autopilot < full, 모르는 단계는 가장 낮음', () => {
  assert.deepEqual(LEVELS, ['cruise', 'autopilot', 'full']);
  assert.ok(levelRank('cruise') < levelRank('autopilot') && levelRank('autopilot') < levelRank('full'));
  for (const bad of [undefined, null, '', 'FULL', 'turbo', 7, {}]) assert.equal(levelRank(bad), 0, String(bad));
  assert.equal(atLeast('turbo', 'autopilot'), false);
  assert.equal(atLeast('full', 'autopilot') && atLeast('full', 'cruise') && atLeast('autopilot', 'cruise'), true);
  assert.equal(atLeast('cruise', 'autopilot') || atLeast('autopilot', 'full'), false);
});

test('(1) 기능별 full ⊇ autopilot ⊇ cruise: 우편 줄·Wingman 줄·Wingman 경로', () => {
  const base = {text: '밤', quote: '', viaChat: false, by: '사람', untilMs: null, decideAfterMs: 2 * H};
  const msg = (level, isWingman = false) => buildAutopilotMessage({...base, level, isWingman});
  const has = (level, re, isWingman) => re.test(msg(level, isWingman));
  // [기능, 정규식, cruise, autopilot, full]
  const table = [
    ['고정 줄 (1)~(5)', /\(5\) kyle의 직접 중지/, true, true, true],
    ['(6) 일감 고르기', /\(6\) 새 일감은/, false, true, true],
    ['(7) 완전자율', /\(7\) 완전자율:/, false, false, true],
  ];
  for (const [name, re, c, a, f] of table) assert.deepEqual([has('cruise', re), has('autopilot', re), has('full', re)], [c, a, f], name);
  assert.deepEqual([has('cruise', /Wingman: 당신이/, true), has('autopilot', /Wingman: 당신이/, true), has('full', /Wingman: 당신이/, true)], [false, true, true], 'Wingman 줄');
  assert.match(msg('full'), /단계: 완전자율/);
  assert.match(msg('full'), /대기 시간\(2시간\)/);
  assert.match(msg('turbo'), /단계: Cruise/, '모르는 단계는 Cruise로 읽는다');
  // Wingman 경로
  const route = {recipient: '@user', basis: 'x'}, alert = {kind: '정체', role: 'z'};
  const routed = level => applyWingmanRoute({route, alert, autopilot: {on: true, level, wingman: OTHER}, liveSessions: [`kadan-${OTHER}`]}).recipient;
  assert.deepEqual([routed('cruise'), routed('autopilot'), routed('full'), routed('turbo')], ['@user', OTHER, OTHER, '@user']);
  // 금지 목록 줄 (2)는 단계가 올라가도 같다
  const forbid = level => msg(level).split('\n').find(l => l.startsWith('(2) '));
  assert.equal(forbid('full'), forbid('cruise'));
  assert.equal(forbid('autopilot'), forbid('cruise'));
});

// (2) 켜기 -----------------------------------------------------------------------------------------------------------
test('(2) on --level full: 기본 2시간을 on 사건에 저장, status에 보임, 우편에 대기 시간', () => {
  const w = world({on: false});
  const r = w.turnOn();
  assert.equal(r.level, 'full');
  assert.equal(r.decideAfterMs, 2 * H);
  const [on] = w.ledger().filter(e => e.kind === 'autopilot');
  assert.equal(on.level, 'full');
  assert.equal(on.decideAfterMs, 2 * H);
  const status = autopilotCommand(['status'], {}, {home: w.home, by: '사람', deps: {now: () => w.t0 + 1}});
  assert.equal(status.decideAfterMs, 2 * H);
  assert.equal(status.decideAfter, '2시간');
  assert.match(w.sent[0].message, /단계: 완전자율/);
  assert.match(w.sent[0].message, /\(7\) 완전자율:/);
});

test('(2) --decide-after: 꼴·하한 30분·상한 24시간·다른 단계 거절(종료 코드 2), 값은 저장', () => {
  assert.equal(parseDecideAfter('90m'), 90 * MIN);
  assert.equal(parseDecideAfter('1h30m'), 90 * MIN);
  assert.equal(parseDecideAfter(undefined), 2 * H);
  for (const bad of ['29m', '25h', '24h1m', '', 'abc', '2', '0m', true, 120]) assert.throws(() => parseDecideAfter(bad), /--decide-after/, String(bad));
  assert.equal(parseDecideAfter('30m'), 30 * MIN);
  assert.equal(parseDecideAfter('24h'), 24 * H);
  for (const bad of ['29m', '25h', 'abc']) {
    const w = world({on: false});
    assert.throws(() => w.turnOn({'decide-after': bad}), error => error.exitCode === 2, bad);
    assert.equal(w.ledger().filter(e => e.kind === 'autopilot').length, 0);
    assert.equal(w.sent.length, 0);
  }
  for (const level of ['cruise', 'autopilot']) {
    const w = world({on: false, level});
    assert.throws(() => w.turnOn({'decide-after': '1h'}), error => error.exitCode === 2 && /--level full과 함께만/.test(error.message), level);
    assert.equal(w.ledger().filter(e => e.kind === 'autopilot').length, 0);
  }
  const w = world({on: false});
  w.turnOn({'decide-after': '90m'});
  assert.equal(w.ledger().find(e => e.kind === 'autopilot').decideAfterMs, 90 * MIN);
  // 다른 단계 on 사건에는 칸이 없다
  const c = world({level: 'autopilot'});
  assert.equal('decideAfterMs' in c.ledger().find(e => e.kind === 'autopilot'), false);
});

test('(2) 역할 세션은 --quote 없이 full을 못 켜고, 켜진 동안 역할 세션의 full 켜기 거절(가드)은 그대로', () => {
  const w = world({on: false});
  assert.throws(() => w.turnOn({}, SUPER), /kyle의 채팅 원문이 필요/);
  assert.equal(w.ledger().filter(e => e.kind === 'autopilot').length, 0);
  const r = w.turnOn({quote: '길게 자리 비울게, 알아서 해'}, SUPER);
  assert.equal(r.level, 'full');
  const on = w.ledger().find(e => e.kind === 'autopilot');
  assert.equal(on.viaChat, true);
  assert.equal(on.decideAfterMs, 2 * H);
  assert.throws(() => autopilotGuard({home: w.home, command: 'autopilot', args: ['on'], flags: {level: 'full'}, env: {KADAN_ROLE: SUPER}, now: w.t0 + 5, entries: w.ledger()}),
    error => error.exitCode === 2 && /autopilot on --level full/.test(error.message));
  // 사람이 직접 치는 길은 막지 않는다(이미 켜져 있으면 별개의 "이미 켜져 있습니다")
  autopilotGuard({home: w.home, command: 'autopilot', args: ['on'], flags: {level: 'full'}, env: {}, now: w.t0 + 5, entries: w.ledger()});
});

// (3) proceed 거절 조건 ----------------------------------------------------------------------------------------------
test('(3) proceed 거절: 꺼짐·낮은 단계·닫힌 결정·--reversible 없음·시간 전·저장 값 깨짐·남의 결정, 이유 문구, 아무것도 쓰지 않음', () => {
  const attempt = (w, d, at, by, ...needles) => {
    const before = [w.events().length, w.ledger().length, w.user.length];
    refusal(() => w.proceed(d.id, {at, by}), ...needles);
    assert.deepEqual([w.events().length, w.ledger().length, w.user.length], before, '거절은 아무것도 쓰지 않는다');
  };
  // 꺼짐
  const off = world({on: false});
  const dOff = off.request();
  attempt(off, dOff, Date.now() + 3 * H, SUPER, 'Autopilot이 꺼져 있습니다');
  // 꺼졌다가: on → off
  const w0 = world();
  const dEnd = w0.request();
  autopilotCommand(['off'], {}, {home: w0.home, by: '사람', deps: {...{now: () => Date.now(), sendMail: () => ({ok: true}), notify: () => {}}}});
  attempt(w0, dEnd, Date.now() + 3 * H, SUPER, 'Autopilot이 꺼져 있습니다');
  // 낮은 단계
  for (const level of ['cruise', 'autopilot']) {
    const w = world({level});
    const d = w.request();
    attempt(w, d, Date.now() + 3 * H, SUPER, '완전자율이 아닙니다');
  }
  // 닫힌 결정(답)
  const wc = world();
  const dc = wc.request();
  wc.store.answer(dc.id, {revision: dc.revision, choice: '예'}, '사람');
  attempt(wc, dc, Date.now() + 3 * H, SUPER, '이미 닫힌 결정');
  // 닫힌 결정(취소)
  const wx = world();
  const dx = wx.request();
  wx.store.cancel(dx.id, {revision: dx.revision, reason: '그만'}, SUPER);
  attempt(wx, dx, Date.now() + 3 * H, SUPER, '이미 닫힌 결정');
  // --reversible 없음
  const wr = world();
  const dr = wr.request({reversible: undefined});
  assert.equal('reversible' in dr, false);
  attempt(wr, dr, Date.now() + 3 * H, SUPER, '--reversible');
  // 시간 전
  const wt = world();
  const dt = wt.request();
  attempt(wt, dt, Date.parse(dt.at) + 119 * MIN, SUPER, '대기 시간 전입니다');
  // 저장 값 깨짐: 칸 없음·하한 아래·문자·무한대
  for (const broken of [undefined, 5, 'x', null, Infinity, 99 * H]) {
    const w = world({on: false});
    appendLedger({kind: 'autopilot', phase: 'on', by: '사람', text: '밤', viaChat: false, level: 'full', ...(broken === undefined ? {} : {decideAfterMs: broken}), to: [], delivered: [], t: new Date(w.t0).toISOString()}, w.home);
    const d = w.request();
    attempt(w, d, Date.now() + 99 * H, SUPER, '대기 시간을 읽을 수 없습니다');
  }
  // 남의 결정: 다른 슈퍼감독·작업자·사람 이름 아닌 것
  const wo = world();
  const dOther = wo.request();
  for (const by of [OTHER, 'a-감독', '아무개']) attempt(wo, dOther, Date.now() + 3 * H, by, '진행할 수 있습니다');
  // 이유는 모아서 낸다
  const wm = world({on: false});
  const dm = wm.request({reversible: undefined});
  attempt(wm, dm, Date.now() + 3 * H, OTHER, 'Autopilot이 꺼져 있습니다', '--reversible', '진행할 수 있습니다');
  // 손으로 고친 낡은 revision
  const wv = world();
  const dv = wv.request();
  refusal(() => { throw Object.assign(new Error('placeholder'), {exitCode: 2}); }, 'placeholder');
  assert.throws(() => wv.proceed(dv.id, {at: Date.parse(dv.at) + 3 * H, revision: dv.revision + 5}), /요청 상태\/버전 변경/);
});

test('(3) 추천안 없음·머지/관문 결정은 자격이 없고, 요청할 때 --reversible을 줄 수 없다', () => {
  const ap = {on: true, level: 'full', startedAt: '2026-11-02T00:00:00.000Z', decideAfterMs: 30 * MIN};
  const base = {status: 'open', at: '2026-11-02T01:00:00.000Z', reversible: '되돌린다', notProhibited: {by: SUPER, at: '2026-11-02T00:30:00.000Z'}, recommendation: '예', question: '순서?', reason: 'r', options: ['예', '아니오']};
  const now = Date.parse('2026-11-02T05:00:00.000Z');
  assert.equal(proceedEligibility(base, ap, now).ok, true);
  assert.match(proceedEligibility({...base, recommendation: ''}, ap, now).reasons.join(), /추천안이 없었습니다/);
  assert.match(proceedEligibility({...base, recommendation: undefined}, ap, now).reasons.join(), /추천안이 없었습니다/);
  for (const text of ['https://github.com/o/r/pull/12 머지할까요?', 'merge-gate 거절', '관문 통과 후', '이 저장소 night-merge 허용?', '금지 목록에 걸림', '--allow 줄까요']) {
    assert.equal(gatedDecisionText({question: text}), true, text);
    assert.match(proceedEligibility({...base, question: text}, ap, now).reasons.join(), /넘어가지 않습니다/, text);
  }
  assert.equal(gatedDecisionText({question: '순서?', reason: '- 확인 경로 없음: 시험', options: ['예', '아니오'], recommendation: '예'}), false);
  const w = world();
  assert.throws(() => w.request({question: 'https://github.com/o/r/pull/9 머지할까요?'}), /--reversible을 받지 않았습니다/);
  assert.throws(() => w.request({reversible: ' '}), /--reversible/);
  assert.throws(() => w.request({reversible: true}), /--reversible/);
  // 같은 질문을 다른 --reversible로 다시 올리면 기존 요청 취소를 요구한다
  const d = w.request();
  assert.equal(w.request().id, d.id);
  assert.throws(() => w.request({reversible: '다른 방법'}), /같은 질문의 다른 내용/);
  // 요청 뒤에 표시를 더하는 길은 없다: proceed 입력으로 reversible을 넘겨도 쓰이지 않는다(저장된 것만 본다)
  const wn = world();
  const dn = wn.request({question: '표시 없는 질문', reversible: undefined});
  refusal(() => wn.proceed(dn.id, {at: Date.now() + 3 * H}), '--reversible');
});

// (4) 시계 -------------------------------------------------------------------------------------------------------------
test('(4) 완전자율을 켜기 전부터 있던 결정은 켠 시각부터 센다', () => {
  const t = Date.now();
  const w = world({on: false});
  const d = w.request();                               // 지금 요청(켜기 전)
  const onAt = t + 5 * H;                              // 5시간 뒤에 완전자율을 켠다
  w.turnOn({}, '사람', onAt);
  const attempt = (at, ok) => ok ? w.proceed(d.id, {at}) : refusal(() => w.proceed(d.id, {at}), '대기 시간 전입니다');
  attempt(onAt + 1 * MIN, false);                      // 요청은 5시간 묵었지만 켠 지 1분
  attempt(onAt + 119 * MIN, false);
  attempt(onAt + 120 * MIN, true);
  // 켠 뒤 요청한 결정은 요청 시각부터 센다
  const w2 = world({on: false});
  w2.turnOn({}, '사람', t - 10 * H);
  const d2 = w2.request();
  refusal(() => w2.proceed(d2.id, {at: Date.parse(d2.at) + 119 * MIN}), '대기 시간 전입니다');
  w2.proceed(d2.id, {at: Date.parse(d2.at) + 120 * MIN});
  // 꺼졌다 다시 켜면 새 구간의 시작부터 센다
  const w3 = world({on: false});
  w3.turnOn({}, '사람', t - 10 * H);
  const d3 = w3.request();
  autopilotCommand(['off'], {}, {home: w3.home, by: '사람', deps: {now: () => t + 1 * H, sendMail: () => ({ok: true}), notify: () => {}}});
  w3.turnOn({}, '사람', t + 2 * H);
  refusal(() => w3.proceed(d3.id, {at: t + 2 * H + 119 * MIN}), '대기 시간 전입니다');
  w3.proceed(d3.id, {at: t + 2 * H + 120 * MIN});
});

// (5) 통과 -------------------------------------------------------------------------------------------------------------
test('(5) 통과: 결정은 열린 채 진행 기록이 덧붙고, 알림 1회·요약 기록, 두 번째 호출은 기록 없음', () => {
  const w = world({decideAfter: '30m'});
  const d = w.request();
  const at = Date.parse(d.at) + 31 * MIN;
  const r = withNotify(() => w.proceed(d.id, {at}));
  assert.equal(r.already, false);
  const now = w.store.get(d.id);
  assert.equal(now.status, 'open', '결정을 닫지 않는다');
  assert.equal(now.revision, d.revision + 1);
  assert.deepEqual(now.proceeded, {by: SUPER, at: new Date(at).toISOString(), recommendation: '예', reversible: '브랜치를 지운다', notProhibited: d.notProhibited});
  assert.equal(w.events().length, 2, '새 사건 하나만 덧붙는다');
  assert.equal(w.user.length, 1, '사용자 알림 1회');
  assert.match(w.user[0][0], /추천대로 진행함/);
  assert.equal(w.user[0][1].kind, 'decision-proceed');
  const notes = w.ledger().filter(e => e.kind === 'autopilot-note');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].noteKind, 'decision');
  assert.equal(notes[0].by, SUPER);
  assert.match(notes[0].text, /추천대로 진행함/);
  assert.equal(w.answers.length, 0, '결정을 답 처리하지 않는다(요청자 통지 없음)');
  // 두 번째 호출: 종료 코드 0(던지지 않음), 기록 없음
  const eventsBefore = w.events().length, ledgerBefore = w.ledger().length;
  const again = withNotify(() => w.proceed(d.id, {at: at + MIN, revision: d.revision}));
  assert.equal(again.already, true);
  assert.deepEqual([w.events().length, w.ledger().length, w.user.length], [eventsBefore, ledgerBefore, 1]);
  // 요청자가 슈퍼감독이면 본인만 진행한다(위쪽 슈퍼감독은 거절: 아래 R2-F2 시험)
  const w2 = world({decideAfter: '30m'});
  const d2 = w2.request();
  const r2 = w2.proceed(d2.id, {at: Date.parse(d2.at) + 31 * MIN, by: SUPER});
  assert.equal(r2.decision.proceeded.by, SUPER, '진행한 역할이 by다(사용자 행위자 아님)');
  // 알림 실패는 경고로 드러내고 진행 기록은 남는다
  const w3 = world({decideAfter: '30m'});
  w3.hook.impl = () => { throw new Error('디코 죽음'); };
  const d3 = w3.request();
  const r3 = withNotify(() => w3.proceed(d3.id, {at: Date.parse(d3.at) + 31 * MIN}));
  assert.match(r3.warnings.join(), /알림을 보내지 못했습니다/);
  assert.ok(w3.store.get(d3.id).proceeded);
  const w4 = world({decideAfter: '30m'});
  w4.hook.impl = () => ({error: '전달 실패'});
  const d4 = w4.request();
  assert.match(withNotify(() => w4.proceed(d4.id, {at: Date.parse(d4.at) + 31 * MIN})).warnings.join(), /알림을 보내지 못했습니다: 전달 실패/);
});

// 갈아 끼운 알림 함수가 아니라 실제 notifyUser → 게시 정책(postPolicy)을 지나 '보냄'에 이르는지 본다. 디코는 따로 띄운 가짜 웹훅이다.
test('(5b) 진행 알림은 실제 게시 정책을 지나 새 글로 나가고, 정책이 건너뛰면 경고가 난다', async () => {
  resetDiscordBlock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-autopilot-full-hook-'));
  const logFile = path.join(dir, 'requests.jsonl');
  const helper = new URL('./helpers/fake-webhook.mjs', import.meta.url).pathname;
  const child = spawn(process.execPath, [helper, logFile, JSON.stringify([{status: 200, body: {id: 'D1', channel_id: 'C1'}}])], {stdio: ['ignore', 'pipe', 'inherit']});
  try {
    const port = await new Promise(resolve => child.stdout.once('data', d => resolve(Number(String(d).match(/PORT (\d+)/)[1]))));
    const envFile = path.join(dir, 'secret.env');
    fs.writeFileSync(envFile, `DISCORD_WEBHOOK_URL=http://127.0.0.1:${port}/api/webhooks/111/FAKETOKEN-abc123\nDISCORD_USER_ID="424242424242"\n`);
    const env = {KADAN_NOTIFY: '', KADAN_NOTIFY_ENV_FILE: envFile};
    const w = world({decideAfter: '30m'});
    w.hook.impl = (m, o) => notifyUser(m, () => ({status: 0}), {...o, home: w.home, env});
    const d = w.request();
    const r = withNotify(() => w.proceed(d.id, {at: Date.parse(d.at) + 31 * MIN}));
    assert.equal(r.warnings, undefined, `경고 없음: ${r.warnings}`);
    const sent = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(sent.length, 1, '디코 요청 1회');
    assert.match(JSON.parse(sent[0].body).content, /추천대로 진행함/);
    assert.deepEqual(JSON.parse(sent[0].body).allowed_mentions, {parse: []}, '조용히(멘션 없음)');
    const log = fs.readFileSync(path.join(w.home, NOTIFY_LOG_FILE), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.ok(log.some(e => e.kind === 'decision-proceed' && e.outcome === 'sent'), JSON.stringify(log));
    // 정책이 모르는 종류로 건너뛰는 경우는 경고로 드러난다(진행 기록은 남는다).
    const w2 = world({decideAfter: '30m'});
    w2.hook.impl = (m, o) => notifyUser(m, () => ({status: 0}), {...o, kind: 'decision-unknown', home: w2.home, env});
    const d2 = w2.request();
    const r2 = withNotify(() => w2.proceed(d2.id, {at: Date.parse(d2.at) + 31 * MIN}));
    assert.match(r2.warnings.join(), /나갔다는 표시가 없습니다/);
    assert.ok(w2.store.get(d2.id).proceeded);
    // KADAN_NOTIFY=off는 경고 없이 넘어간다.
    const w3 = world({decideAfter: '30m'});
    const d3 = w3.request();
    const prev = process.env.KADAN_NOTIFY; process.env.KADAN_NOTIFY = 'off';
    try { assert.equal(w3.proceed(d3.id, {at: Date.parse(d3.at) + 31 * MIN}).warnings, undefined); } finally { process.env.KADAN_NOTIFY = prev; }
  } finally { child.kill('SIGTERM'); }
});

// (6) 진행 뒤 사람 답 --------------------------------------------------------------------------------------------------
test('(6) 진행 뒤 사람 답은 정상 답으로 기록되고, 추천과 다르면 알림 문구에 이미 진행됨과 되돌리는 방법이 붙는다', () => {
  const w = world({decideAfter: '30m'});
  const d = w.request();
  w.proceed(d.id, {at: Date.parse(d.at) + 31 * MIN});
  const cur = w.store.get(d.id);
  const answered = w.store.answer(d.id, {revision: cur.revision, choice: '아니오'}, '사람');
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer.choice, '아니오');
  assert.ok(answered.proceeded, '진행 기록은 그대로 이어진다');
  assert.equal(w.answers.length, 1);
  assert.match(w.answers[0][1], /추천대로 이미 진행됨 — 되돌리는 방법: 브랜치를 지운다/);
  // 추천과 같으면 붙이지 않는다
  const w2 = world({decideAfter: '30m'});
  const d2 = w2.request();
  w2.proceed(d2.id, {at: Date.parse(d2.at) + 31 * MIN});
  w2.store.answer(d2.id, {revision: w2.store.get(d2.id).revision, choice: '예'}, '사람');
  assert.doesNotMatch(w2.answers[0][1], /이미 진행됨/);
  // 진행 기록이 없는 보통 답은 문구가 그대로다
  const w3 = world();
  const d3 = w3.request();
  w3.store.answer(d3.id, {revision: d3.revision, choice: '아니오'}, '사람');
  assert.doesNotMatch(w3.answers[0][1], /이미 진행됨/);
  // 낡은 revision(진행 전 화면)으로 낸 답은 다시 확인을 요구한다
  const w4 = world({decideAfter: '30m'});
  const d4 = w4.request();
  w4.proceed(d4.id, {at: Date.parse(d4.at) + 31 * MIN});
  assert.throws(() => w4.store.answer(d4.id, {revision: d4.revision, choice: '아니오'}, '사람'), /요청 상태\/버전 변경/);
  // 진행 뒤 요청자가 취소할 수도 있다(결정은 닫히지 않았다)
  const c = w4.store.cancel(d4.id, {revision: w4.store.get(d4.id).revision, reason: '정리'}, SUPER);
  assert.equal(c.status, 'cancelled');
  assert.ok(c.proceeded);
});

// (7) 감시기 재료 -------------------------------------------------------------------------------------------------------
test('(7) 자격 판정 한 함수: 시간 전은 대기, 지나면 풀림, 진행 기록은 풀림, 읽기 실패·--reversible 없음은 대기 유지', () => {
  const ap = {on: true, level: 'full', startedAt: '2026-11-02T00:00:00.000Z', decideAfterMs: 2 * H};
  const d = {id: 'd1', revision: 3, status: 'open', at: '2026-11-02T01:00:00.000Z', recommendation: '예', reversible: '되돌림', notProhibited: {by: SUPER, at: '2026-11-02T00:30:00.000Z'}, question: 'q', reason: 'r', options: ['예', '아니오']};
  const at = ms => Date.parse(d.at) + ms;
  assert.equal(releasedFromWait(d, ap, at(119 * MIN)), false);
  assert.equal(releasedFromWait(d, ap, at(120 * MIN)), true);
  assert.equal(releasedFromWait({...d, proceeded: {by: SUPER}}, null, at(0)), true, '진행 기록이 붙으면 스냅샷 없이도 더 세지 않는다');
  assert.equal(releasedFromWait(d, null, at(5 * H)), false, '스냅샷을 못 읽으면 대기 유지');
  assert.equal(releasedFromWait(d, {...ap, decideAfterMs: null}, at(5 * H)), false);
  assert.equal(releasedFromWait(d, {...ap, level: 'autopilot'}, at(5 * H)), false);
  assert.equal(releasedFromWait(d, {...ap, on: false}, at(5 * H)), false);
  assert.equal(releasedFromWait({...d, reversible: undefined}, ap, at(5 * H)), false, '--reversible 없는 결정은 지나도 대기 유지');
  assert.equal(releasedFromWait({...d, status: 'answered'}, ap, at(5 * H)), false);
  assert.equal(releasedFromWait(d, ap, NaN), false);
  assert.equal(releasedFromWait({...d, at: 'not-a-date'}, ap, at(5 * H)), false);
  assert.equal(releasedFromWait(d, {...ap, startedAt: undefined}, at(5 * H)), false);
});

test('(7) 본인 창 안내: 진행할 수 있는 결정의 명령 한 줄이 놀고 있음 안내에 붙고, 없으면 붙지 않는다', () => {
  const alert = {id: 'a1', kind: '놀고 있음', stage: 1, role: SUPER, session: `kadan-${SUPER}`, idleMinutes: 15, counts: {}};
  const d = {id: 'dec-1234', revision: 4};
  const withHint = itemizedAlert(alert, '10:00', {proceedable: [d]});
  assert.match(withHint, /대기 시간이 지났습니다. 진행할 수 있는지 확인: `kadan decision proceed dec-1234 --revision 4`/);
  assert.doesNotMatch(itemizedAlert(alert, '10:00', {}), /decision proceed/);
  assert.doesNotMatch(itemizedAlert(alert, '10:00', {proceedable: []}), /decision proceed/);
});

test('(7) 감시기 스냅샷: 켜짐일 때만 시작 시각·대기 시간을 싣고, 깨진 값은 null', () => {
  const w = world({decideAfter: '90m'});
  const snap = autopilotWingmanSnapshot(w.ledger(), w.t0 + 1);
  assert.deepEqual([snap.on, snap.level, snap.decideAfterMs], [true, 'full', 90 * MIN]);
  assert.equal(snap.startedAt, new Date(w.t0).toISOString());
  assert.equal(autopilotWingmanSnapshot([], 0).decideAfterMs, null);
  assert.equal(storedDecideAfterMs({decideAfterMs: 'x'}), null);
  assert.equal(storedDecideAfterMs({decideAfterMs: 10 * MIN}), null);
  assert.equal(storedDecideAfterMs({decideAfterMs: 31 * MIN}), 31 * MIN);
});

// (8) 낮은 단계·꺼짐에서는 평소와 같다 ---------------------------------------------------------------------------------
test('(8) 꺼짐·낮은 단계에서 --reversible 결정은 평소 결정과 똑같이 동작한다(요청·답·취소, 자동 진행 없음)', () => {
  for (const opts of [{on: false}, {level: 'cruise'}, {level: 'autopilot'}]) {
    const w = world(opts);
    const d = w.request();
    assert.equal(d.status, 'open');
    assert.equal(d.reversible, '브랜치를 지운다');
    const far = Date.now() + 30 * 24 * H;
    refusal(() => w.proceed(d.id, {at: far}), '진행할 수 없습니다');
    assert.equal(w.store.get(d.id).status, 'open');
    assert.equal('proceeded' in w.store.get(d.id), false);
    const a = w.store.answer(d.id, {revision: d.revision, choice: '예'}, '사람');
    assert.equal(a.status, 'answered');
    assert.doesNotMatch(w.answers[0][1], /이미 진행됨/);
    assert.equal(w.ledger().filter(e => e.kind === 'autopilot-note').length, 0);
  }
  // --reversible 없는 평소 결정은 이 PR 전과 같은 모양이다
  const w = world({on: false});
  const plain = w.request({reversible: undefined});
  assert.equal('reversible' in plain, false);
  assert.equal('proceeded' in plain, false);
});

// (9) 표시 -------------------------------------------------------------------------------------------------------------
test('(9) 표시: decision list/show·대시보드 띠·status·요약에 추천대로 진행함이 보인다', () => {
  const w = world({decideAfter: '30m'});
  const d = w.request();
  const at = Date.parse(d.at) + 31 * MIN;
  w.proceed(d.id, {at});
  const ctx = {home: w.home, by: '사람'};
  const shown = decisionCommand(['show', d.id], {}, ctx);
  assert.equal(shown.proceeded.by, SUPER);
  assert.equal(shown.proceeded.reversible, '브랜치를 지운다');
  const listed = decisionCommand(['list'], {status: 'open'}, ctx);
  assert.equal(listed.find(x => x.id === d.id).proceeded.at, new Date(at).toISOString());
  const strip = autopilotStrip({ledgerLines: 1, entries: w.ledger()}, w.t0 + 5);
  assert.equal(strip.on, true);
  assert.equal(strip.level, 'full');
  assert.equal(strip.decideAfterMs, 30 * MIN);
  const cruise = world({level: 'cruise'});
  assert.equal('decideAfterMs' in autopilotStrip({ledgerLines: 1, entries: cruise.ledger()}, cruise.t0 + 5), false);
  // 요약: 구간 안에 진행 기록이 붙은 결정을 id당 한 번 센다(답을 받아도 한 번)
  w.store.answer(d.id, {revision: w.store.get(d.id).revision, choice: '아니오'}, '사람');
  const start = w.ledger().find(e => e.kind === 'autopilot');
  const summary = summarizeAutopilot({start, phase: 'off', endedAt: at + H, entries: w.ledger(), decisionEvents: w.events(), readBody: () => null});
  assert.equal(summary.counts.proceeded, 1);
  assert.match(summary.text, /추천대로 진행한 결정 1건/);
  assert.match(summary.text, /대신 정한 결정 1건/, 'autopilot note decision 기록도 끌 때의 요약에 모인다');
  const none = summarizeAutopilot({start, phase: 'off', endedAt: at - H, entries: w.ledger(), decisionEvents: w.events(), readBody: () => null});
  assert.equal(none.counts.proceeded, 0);
  assert.doesNotMatch(none.text, /추천대로 진행한 결정/);
});

test('결정 이력 검증: 모양이 틀린 reversible·proceeded는 손상으로 거절한다', () => {
  const w = world();
  const d = w.request();
  w.store.write({...d, revision: d.revision + 1, proceeded: {by: SUPER}});
  assert.throws(() => w.store.list(), /결정 이력 손상/);
  const w2 = world();
  const d2 = w2.request();
  w2.store.write({...d2, revision: d2.revision + 1, reversible: 7});
  assert.throws(() => w2.store.list(), /결정 이력 손상/);
});

// ===== 2라운드(검수 지적 F1~F3) =====
const hold = (w, over = {}) => appendLedger({kind: 'autopilot-note', noteKind: 'hold', holdKind: 'gate', work: 'a/w1', text: '확인 필요', by: SUPER, t: new Date().toISOString(), ...over}, w.home);
const code2 = (fn, re) => assert.throws(fn, error => error.exitCode === 2 && re.test(error.message));

test('R2-F1 검수의 네 재현: 요청 단계에서 모두 거절된다(보류 기록이 없어도 낱말이, 있으면 기록이)', () => {
  const questions = ['#123 넣을까요?', '운영 서버에 새 버전을 배포할까요?', '운영 DB의 고객 테이블을 백업 없이 영구 삭제할까요?', '정책 보류 항목을 진행할까요?'];
  for (const question of questions) {
    const w = world();
    code2(() => w.request({question}), /--reversible을 받지 않았습니다.*낱말 때문에 막혔으면 kyle 답을 기다립니다/);
    hold(w);                                       // 검수 재현과 같이 업무에 보류 기록이 걸린 상태
    code2(() => w.request({question}), /--reversible을 받지 않았습니다/);
    assert.equal(w.events().length, 0, '거절된 요청은 아무것도 저장하지 않는다');
  }
});

test('R2-F1 진행 단계: 보류·관문 거절 기록이 걸린 업무의 결정과 낱말이 든 결정은 자격이 없다(요청 단계를 우회한 이력 포함)', () => {
  // 요청은 깨끗했는데 그 뒤에 업무에 보류 기록이 생긴 경우
  const w = world();
  const d = w.request();
  hold(w, {holdKind: 'deploy-repo', pr: 'o/r#9'});
  refusal(() => w.proceed(d.id, {at: Date.parse(d.at) + 3 * H}), '풀리지 않은 보류·관문 거절 기록');
  assert.equal('proceeded' in w.store.get(d.id), false);
  // 요청 단계를 거치지 않고 쓴 이력(예전 코드·손으로 쓴 이력)이라도 진행 단계가 낱말로 거절한다
  for (const question of ['#123 넣을까요?', '운영 서버에 새 버전을 배포할까요?', '운영 DB의 고객 테이블을 백업 없이 영구 삭제할까요?', '정책 보류 항목을 진행할까요?']) {
    const x = world();
    const base = x.request();
    x.store.write({...base, id: `legacy-${question.length}`, revision: 1, question});
    refusal(() => x.proceed(`legacy-${question.length}`, {at: Date.parse(base.at) + 3 * H, revision: 1}), '낱말 때문에 막혔으면 kyle 답을 기다립니다');
  }
});

test('R2-F1 (가) 기록 대조: 같은 업무·같은 PR의 관문 통과나 머지로만 풀리고, 다른 업무·다른 PR은 영향이 없다', () => {
  const w = world();
  const ok = () => w.request({question: `질문 ${Math.random()}`});
  hold(w, {pr: 'o/r#1'});
  code2(() => ok(), /보류·관문 거절 기록이 1건/);
  appendLedger({kind: 'autopilot-note', noteKind: 'gate', verdict: 'pass', work: 'a/w1', pr: 'o/r#2', text: 'x', by: SUPER, t: new Date().toISOString()}, w.home);
  code2(() => ok(), /보류·관문 거절 기록/);               // 다른 PR의 통과로는 안 풀린다
  appendLedger({kind: 'autopilot-note', noteKind: 'merge', work: 'work:a/w1', pr: 'O/R#1', text: 'x', by: SUPER, t: new Date().toISOString()}, w.home);
  ok();                                                       // 같은 PR의 머지(대소문자·work: 접두 정규화)로 풀림
  hold(w, {noteKind: 'gate', verdict: 'reject', holdKind: undefined, pr: 'o/r#3'});
  code2(() => ok(), /보류·관문 거절 기록/);
  appendLedger({kind: 'autopilot-note', noteKind: 'gate', verdict: 'pass', work: 'a/w1', pr: 'o/r#3', text: 'x', by: SUPER, t: new Date().toISOString()}, w.home);
  ok();
  hold(w, {holdKind: 'decision'});                           // PR 없는 결정 보류는 PR 없는 통과·머지로만 풀린다
  code2(() => ok(), /보류·관문 거절 기록/);
  hold(w, {work: 'other/w9', holdKind: 'gate'});            // 다른 업무의 보류는 이 업무에 영향이 없다 → 위 결정 보류만 남아 있음
  assert.equal(holdBlocks(w.ledger(), 'other/w9').length, 1);
  assert.equal(holdBlocks(w.ledger(), 'a/w1').length, 1);
  assert.equal(holdBlocks(null, 'a/w1'), null);
  assert.equal(holdBlocks(w.ledger(), undefined), null);
  assert.match(holdReason(null), /대조할 수 없습니다/);
  assert.equal(holdReason([]), null);
});

test('R2-F1 업무가 없는 결정은 --reversible을 받지 않는다', () => {
  const w = world();
  new CardStore(w.home).create({repo: 'repo', id: 'card-a', repoPath: w.home, body: '# 시험'});
  code2(() => w.store.request('repo/card-a', {question: '순서?', options: ['예', '아니오'], recommendation: '예', reason: '- 확인 경로 없음: 시험', work: '없음', reversible: '되돌린다', notProhibited: true}, SUPER), /업무가 없는 결정은 보류·관문 거절 기록을 대조할 수 없습니다/);
  // 표시 없는 평소 카드 결정은 그대로 올라간다
  const plain = w.store.request('repo/card-a', {question: '순서?', options: ['예', '아니오'], recommendation: '예', reason: '- 확인 경로 없음: 시험', work: '없음'}, SUPER);
  assert.equal(plain.status, 'open');
});

test('R2-F1 (나) 선언: --not-prohibited 없이는 --reversible을 받지 않고 요지를 보이며, 저장 모양과 알림에 요청자 선언이 남는다', () => {
  const w = world({decideAfter: '30m'});
  code2(() => w.request({notProhibited: undefined}), new RegExp(`--not-prohibited.*${PROHIBITED_SUMMARY}`));
  code2(() => w.request({reversible: undefined, notProhibited: true}), /--reversible과 함께만/);
  code2(() => w.request({notProhibited: 'yes'}), /값 없는 옵션/);
  assert.equal(w.events().length, 0);
  const d = w.request();
  assert.equal(d.notProhibited.by, SUPER);
  assert.ok(Number.isFinite(Date.parse(d.notProhibited.at)));
  // 선언이 없던 이력(예전 형식)은 지나도 진행하지 않는다
  const legacy = {...d, id: 'legacy-decl', revision: 1}; delete legacy.notProhibited;
  w.store.write(legacy);
  refusal(() => w.proceed('legacy-decl', {at: Date.parse(d.at) + 3 * H, revision: 1}), '--not-prohibited');
  // 진행 알림·요약 기록에 요청자 선언이 보인다
  withNotify(() => w.proceed(d.id, {at: Date.parse(d.at) + 31 * MIN}));
  assert.match(w.user[0][0], /요청자 선언: a-슈퍼감독 금지 목록에 닿지 않음/);
  assert.match(w.ledger().find(e => e.kind === 'autopilot-note').text, /요청자 선언/);
  assert.deepEqual(decisionCommand(['show', d.id], {}, {home: w.home, by: '사람'}).proceeded.notProhibited, d.notProhibited);
});

test('R2-F1 평소 결정(--reversible·선언 없음)은 기준과 같고, CLI 입구가 --not-prohibited를 값 없는 옵션으로 읽는다', async () => {
  const w = world({on: false});
  const plain = w.request({reversible: undefined, question: '표시 없는 질문입니다'});
  assert.equal('reversible' in plain || 'notProhibited' in plain, false);
  const { spawnSync } = await import('node:child_process');
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const env = {...process.env, KADAN_HOME: w.home, KADAN_NOTIFY: 'off', KADAN_ROLE: SUPER};
  const run = extra => spawnSync(process.execPath, [cli, 'decision', 'request', '--chat', '--work', 'a/w1', '--question', '이 순서로 갈까요?', '--option', '예', '--option', '아니오', '--recommend', '예', '--reason', '- 확인 경로 없음: 시험', '--reversible', '브랜치를 지운다', ...extra], {env, encoding: 'utf8'});
  const refused = run([]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--not-prohibited/);
  const ok = run(['--not-prohibited']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).notProhibited.by, SUPER);
});

test('R2-F2 직속 한정: 요청자가 슈퍼감독이면 본인뿐이고, 위쪽·옆 슈퍼감독·사용자 행위자는 거절', () => {
  const w = world({decideAfter: '30m'});
  const d = w.request();
  const at = Date.parse(d.at) + 31 * MIN;
  for (const by of [UP, OTHER, '사람', 'a-감독']) {
    refusal(() => w.proceed(d.id, {at, by}), '가장 가까운 슈퍼감독만 진행할 수 있습니다');
  }
  assert.equal('proceeded' in w.store.get(d.id), false);
  // 일반 단위: 요청자가 슈퍼감독이 아니면 관계표에서 가장 가까운 슈퍼감독 하나만(그 위는 거절), 관계표를 못 읽으면 본인만
  const parents = new Map([['a-감독', 'a-슈퍼감독'], ['a-슈퍼감독', 't-슈퍼감독'], ['t-슈퍼감독', '@user']]);
  const dd = {requestedBy: 'a-감독'};
  assert.equal(mayProceed('a-감독', dd, parents), true);
  assert.equal(mayProceed('a-슈퍼감독', dd, parents), true);
  assert.equal(mayProceed('t-슈퍼감독', dd, parents), false);
  assert.equal(mayProceed('a-슈퍼감독', dd, null), false);
  assert.equal(mayProceed('a-감독', dd, null), true);
  assert.equal(mayProceed('', dd, parents), false);
  // 추가 사용자 이름에 요청 역할을 등록해도 사용자 행위자는 진행하지 못한다(검수 조건부 관찰)
  const saved = process.env.KADAN_USER_NAMES;
  process.env.KADAN_USER_NAMES = SUPER;
  try { assert.equal(mayProceed(SUPER, {requestedBy: SUPER}, parents), false); } finally { if (saved === undefined) delete process.env.KADAN_USER_NAMES; else process.env.KADAN_USER_NAMES = saved; }
});

test('R2-F3 잠금 안에서 다시 확인: 잠금을 기다리는 사이 꺼졌거나 다시 켜지면 거절하고 아무것도 쓰지 않는다', () => {
  const asOf = (w, d) => Date.parse(d.at) + 31 * MIN;
  const prepare = () => {
    const w = world({decideAfter: '30m'});
    const d = w.request();
    const at = asOf(w, d);
    const first = autopilotWingmanSnapshot(w.ledger(), at);       // 명령이 잠금 밖에서 먼저 읽은 상태: 켜짐
    assert.equal(first.on, true);
    return {w, d, at, first};
  };
  const waitInLock = (w, between) => {                            // 잠금을 얻기 직전 다른 쓰기가 끼어든다(검수의 경합 재현과 같은 순서)
    const real = w.store.locked.bind(w.store);
    w.store.locked = fn => { between(); return real(fn); };
  };
  const tryProceed = ({w, d, at, first}) => () => w.store.proceed(d.id, {revision: d.revision}, SUPER, {now: () => at, expectStartedAt: first.startedAt});
  // (1) 잠금 대기 중 off
  const a = prepare();
  waitInLock(a.w, () => autopilotCommand(['off'], {}, {home: a.w.home, by: '사람', deps: {now: () => a.at - 1, sendMail: () => ({ok: true}), notify: () => {}}}));
  refusal(tryProceed(a), 'Autopilot이 꺼져 있습니다');
  assert.equal('proceeded' in a.w.store.get(a.d.id), false);
  assert.equal(a.w.ledger().filter(e => e.kind === 'autopilot-note').length, 0);
  // (2) 잠금 대기 중 off 뒤 재켜기(켜짐 구간이 바뀜) — 새 구간 시작부터 세므로 시간 전이기도 하지만 구간 변경이 이유에 들어간다
  const b = prepare();
  waitInLock(b.w, () => {
    const deps = {now: () => b.at - 2, sendMail: () => ({ok: true}), notify: () => {}};
    autopilotCommand(['off'], {}, {home: b.w.home, by: '사람', deps});
    autopilotCommand(['on', '다시'], {level: 'full', 'decide-after': '30m'}, {home: b.w.home, by: '사람', deps: {...deps, now: () => b.at - 1}});
  });
  refusal(tryProceed(b), '켜짐 구간이 바뀌었습니다');
  // (3) 잠금 대기 중 단계가 낮아진 재켜기
  const c = prepare();
  waitInLock(c.w, () => {
    const deps = {now: () => c.at - 2, sendMail: () => ({ok: true}), notify: () => {}};
    autopilotCommand(['off'], {}, {home: c.w.home, by: '사람', deps});
    autopilotCommand(['on', '낮게'], {level: 'cruise'}, {home: c.w.home, by: '사람', deps: {...deps, now: () => c.at - 1}});
  });
  refusal(tryProceed(c), '완전자율이 아닙니다');
  // (4) 대조: 끼어드는 일이 없으면 같은 호출이 통과한다
  const ok = prepare();
  assert.equal(tryProceed(ok)().already, false);
  // (5) 시계도 잠금 안에서 읽는다: 명령을 받은 뒤 잠금 안에서 읽은 시각이 대기 시간 전이면 거절
  const t = prepare();
  let clock = t.at;
  waitInLock(t.w, () => { clock = Date.parse(t.d.at) + 5 * MIN; });
  refusal(() => t.w.store.proceed(t.d.id, {revision: t.d.revision}, SUPER, {now: () => clock, expectStartedAt: t.first.startedAt}), '대기 시간 전입니다');
});

// ===== 4라운드: 자동 닫힘과의 접점 =====
test('R4 자동 닫힘: 진행 기록이 붙은 채팅 결정은 요청자 본인의 work execute로 취소되지 않고, 완료·취소(rule all)는 그대로 닫는다', () => {
  const w = world({decideAfter: '30m'});
  const d = w.request();
  const plain = w.request({question: '진행 기록이 없는 다른 질문입니다', reversible: undefined});
  w.proceed(d.id, {at: Date.parse(d.at) + 31 * MIN});
  // 요청자 본인의 execute(rule requester): 진행 기록이 있는 결정은 남기고, 없는 결정은 평소처럼 닫는다
  const r1 = w.store.closeChatForWork('a/w1', '업무 execute', 'work execute', {rule: 'requester', by: SUPER});
  assert.deepEqual(r1.kept.map(x => x.id), [d.id]);
  assert.deepEqual(r1.closed.map(x => x.id), [plain.id]);
  assert.equal(w.store.get(d.id).status, 'open');
  // 다른 역할의 execute는 원래부터 닫지 않는다
  assert.equal(w.store.closeChatForWork('a/w1', 'x', 'work execute', {rule: 'requester', by: OTHER}).closed.length, 0);
  // 완료·취소(rule all)는 진행 기록이 있어도 닫는다
  const r2 = w.store.closeChatForWork('a/w1', '업무 완료', 'work complete', {rule: 'all'});
  assert.deepEqual(r2.closed.map(x => x.id), [d.id]);
  assert.equal(w.store.get(d.id).status, 'cancelled');
  assert.ok(w.store.get(d.id).proceeded, '진행 기록은 취소된 이력에도 남는다');
});

test('R4 채팅 결정(--chat)도 --reversible·--not-prohibited를 받고 같은 기록 대조·낱말 거름이 걸린다', () => {
  const w = world();
  const d = w.request();                     // world.request는 chat:true
  assert.equal(d.chat, true);
  assert.ok(d.reversible && d.notProhibited);
  hold(w);
  code2(() => w.request({question: '다른 질문입니다'}), /보류·관문 거절 기록/);
  code2(() => w.request({question: '운영 배포를 할까요?'}), /낱말 때문에 막혔으면 kyle 답을 기다립니다|보류·관문 거절 기록/);
});

// (C) 확인 경로 줄의 PR 주소만 낱말 거름에서 뺀다. 그 밖은 전부 그대로 거른다.
test('(C) 낱말 거름: 이유의 `- 라벨: PR 주소` 줄은 풀리고, 그 밖의 모든 자리는 계속 막힌다', () => {
  const PR = 'https://github.com/o/r/pull/12';
  const ok = {question: '이 순서로 갈까요?', options: ['예', '아니오'], recommendation: '예'};
  const gated = reason => gatedDecisionText({...ok, reason});
  // 풀리는 꼴: 줄 전체가 `- 라벨: 주소 하나`
  assert.equal(gated(`- PR: ${PR}`), false);
  assert.equal(gated(`- 확인 경로: ${PR}`), false);
  assert.equal(gated(`요약 한 줄\n- PR: ${PR}\n- 확인 경로 없음: 시험`), false);
  // 여전히 막히는 꼴
  assert.equal(gated(`- PR: ${PR} 머지 가능`), true, '주소 뒤에 글이 더 있음');
  assert.equal(gated(`- 머지할 PR: ${PR}`), true, '라벨의 낱말');
  assert.equal(gated(`- PR: ${PR}\n머지해도 될까요`), true, '이유의 다른 줄');
  assert.equal(gated(`PR ${PR}`), true, '라벨 없는 줄');
  assert.equal(gated(`- 두 PR: ${PR} ${PR}`), true, '주소가 둘');
  assert.equal(gated(`- PR: ${PR}/files`), true, '다른 모양의 주소');
  assert.equal(gated(`- 설명 (${PR}): ${PR}`), true, '라벨 안의 주소');
  assert.equal(gated(`- PR: #12`), true, '#숫자는 풀지 않음');
  assert.equal(gated(`- PR: https://github.com/o/r/pull/12 #12`), true);
  assert.equal(gatedDecisionText({...ok, question: `${PR} 볼까요?`, reason: '- 확인 경로 없음: 시험'}), true, '질문의 주소');
  assert.equal(gatedDecisionText({...ok, recommendation: PR, reason: '- 확인 경로 없음: 시험'}), true, '추천의 주소');
  assert.equal(gatedDecisionText({...ok, options: [PR, '아니오'], reason: '- 확인 경로 없음: 시험'}), true, '선택지의 주소');
  assert.equal(gated(`- PR: https://example.com/o/r/pull/12 배포`), true, '다른 낱말은 그대로');
  // 낱말 목록은 하나도 빼지 않았다
  for (const word of ['관문', '머지', '배포', '운영', '삭제', 'merge-gate', 'night-merge', 'force', 'DB']) assert.equal(gated(`- ${word}: ${PR}`), true, word);
});

test('(C) PR을 확인 경로로 적은 결정이 요청되고 자격 시각에 진행된다', () => {
  const w = world({decideAfter: '30m'});
  const d = w.request({reason: '- PR: https://github.com/o/r/pull/12'});
  const r = w.proceed(d.id, {at: Date.parse(d.at) + 31 * MIN});
  assert.equal(r.already, false);
  assert.ok(w.store.get(d.id).proceeded);
});
