import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {nightCommand} from '../src/commands/night.mjs';
import {nightState, resolveEnd, watchNightExpiry, DEFAULT_MS} from '../src/night.mjs';
import {summarizeNight, NOTICE_LIMIT} from '../src/night-summary.mjs';
import {MAX_TEXT, nightOriginalText} from '../src/commands/night.mjs';
import {readLedgerIncremental} from '../src/ledger-incremental.mjs';
import {appendStream, createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {DatabaseSync} from 'node:sqlite';
import {runWatch} from './helpers/watch-runner.mjs';

// 가짜 시계·가짜 우편·가짜 알림만 쓴다. 운영 홈·우편·디코·OS 알림에 닿지 않는다.
const T0 = Date.parse('2026-10-23T14:00:00.000Z');
const HOUR = 3600_000;
const iso = ms => new Date(ms).toISOString();

function fixture({hierarchy = true} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-night-'));
  const table = {'a-슈퍼감독': '@user', 'a-감독': 'a-슈퍼감독', 'b-슈퍼감독': '@user', 'b-감독': 'b-슈퍼감독'};
  if (hierarchy) {
    const file = path.join(home, 'hierarchy.json');
    fs.writeFileSync(file, JSON.stringify(table));
    appendLedger({kind: 'hierarchy-loaded', path: file, hash: 'x', by: 'watch'}, home);
  }
  for (const role of ['a-슈퍼감독', 'b-슈퍼감독']) appendLedger({kind: 'start', role, session: `kadan-${role}`, roleProfile: 'super'}, home);
  const works = [
    {key: 'a/w1', status: 'open', owner: 'a-감독', executions: []},
    {key: 'a/w2', status: 'open', owner: 'a-감독', executions: []},
    {key: 'b/w1', status: 'open', owner: 'b-감독', executions: []},
    {key: 'b/w2', status: 'done', owner: 'b-감독', executions: []},
  ];
  const sent = [], notes = [];
  let clock = T0;
  const deps = {
    now: () => clock,
    readWorks: () => works,
    sendMail: (role, message) => { sent.push({role, message}); return {ok: true, mailId: `mail-${sent.length}`}; },
    notify: (message, opts) => notes.push({message, opts}),
  };
  const run = (args, flags = {}, by = '사람') => nightCommand(args, flags, {home, by, deps});
  return {home, works, sent, notes, deps, run, setNow: ms => { clock = ms; }, entries: () => readLedger(home).filter(e => e.kind === 'night')};
}

test('끝 시각: 기본 8시간, --for, --until(지난 시각은 다음 날), 상한 12시간', () => {
  assert.equal(resolveEnd({}, T0), iso(T0 + DEFAULT_MS));
  assert.equal(resolveEnd({for: '90m'}, T0), iso(T0 + 1.5 * HOUR));
  assert.equal(resolveEnd({for: '1h30m'}, T0), iso(T0 + 1.5 * HOUR));
  const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  assert.equal(resolveEnd({until: hhmm(T0 + 3 * HOUR)}, T0), iso(T0 + 3 * HOUR)); // 오늘 남은 시각
  assert.equal(resolveEnd({until: hhmm(T0 - 13 * HOUR)}, T0), iso(T0 + 11 * HOUR)); // 이미 지난 시각 = 다음 날
  assert.throws(() => resolveEnd({until: hhmm(T0 - HOUR)}, T0), /최대 12시간/); // 지난 시각의 다음 날은 23시간 뒤
  assert.equal(resolveEnd({for: '12h'}, T0), iso(T0 + 12 * HOUR));
  assert.throws(() => resolveEnd({for: '13h'}, T0), /최대 12시간/);
  assert.throws(() => resolveEnd({for: '0m'}, T0), /뒤여야/);
  assert.throws(() => resolveEnd({for: 'abc'}, T0), /꼴/);
  assert.throws(() => resolveEnd({until: '25:00'}, T0), /HH:MM/);
  assert.throws(() => resolveEnd({until: '07:00', for: '1h'}, T0), /함께/);
});

test('사람 명의는 바로 켠다: 원장 사건 모양, 열린 업무의 슈퍼감독에게 중복 없이 한 통씩', () => {
  const f = fixture();
  const r = f.run(['on', '알아서', '승인하고', '머지해'], {for: '6h'});
  assert.equal(r.on, true);
  assert.deepEqual(r.to, ['a-슈퍼감독', 'b-슈퍼감독']); // a/w1·a/w2가 같은 슈퍼로 모이고, 닫힌 b/w2는 보지 않는다
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.map(s => s.role), ['a-슈퍼감독', 'b-슈퍼감독']);
  for (const s of f.sent) {
    assert.match(s.message, /\[나이트 모드\] kyle이 취침 중/);
    assert.match(s.message, /새 권한이 아니라/);
    assert.match(s.message, /\(1\) 되돌리기 어려운 것\(운영 데이터 변경·삭제, push 정책, 외부 공개, 새 의존성\)/);
    assert.match(s.message, /\(2\) 보류 대상은 밤중에 decision request를 새로 올리지 말고/);
    assert.match(s.message, /\(3\) 위임 범위 안의 일은 결정 요청을 올리지 말고 스스로 처리/);
    assert.match(s.message, /kyle 추가 문구: 알아서 승인하고 머지해/);
  }
  const [on] = f.entries();
  assert.equal(on.phase, 'on');
  assert.equal(on.by, '사람');
  assert.equal(on.viaChat, false);
  assert.equal(on.text, '알아서 승인하고 머지해');
  assert.equal(on.until, iso(T0 + 6 * HOUR));
  assert.equal(on.t, iso(T0));
  assert.deepEqual(on.to, ['a-슈퍼감독', 'b-슈퍼감독']);
  assert.deepEqual(on.delivered, [{role: 'a-슈퍼감독', ok: true, mailId: 'mail-1'}, {role: 'b-슈퍼감독', ok: true, mailId: 'mail-2'}]);
  assert.equal(f.notes.length, 0); // 켤 때는 요약이 없다
});

test('이미 켜져 있으면 덮어쓰지 않고 거절, status는 끝 시각·받은 슈퍼를 보인다', () => {
  const f = fixture();
  f.run(['on', '첫 문구'], {for: '8h'});
  assert.throws(() => f.run(['on', '다른 문구'], {}), /이미 켜져 있습니다/);
  assert.equal(f.entries().length, 1);
  const s = f.run(['status']);
  assert.equal(s.on, true);
  assert.equal(s.text, '첫 문구');
  assert.equal(s.remainingMinutes, 480);
  assert.deepEqual(s.to, ['a-슈퍼감독', 'b-슈퍼감독']);
  assert.deepEqual(s.missing, []);
});

test('슈퍼감독은 --quote가 필수이고 viaChat으로 남는다. 일반감독·작업자는 거절', () => {
  const f = fixture();
  assert.throws(() => f.run(['on', '위임'], {}, 'a-슈퍼감독'), /채팅 원문/);
  assert.throws(() => f.run(['on', '위임'], {quote: '  '}, 'a-슈퍼감독'), /채팅 원문/);
  for (const by of ['a-감독', 'a-작업자', 'a-검수자']) assert.throws(() => f.run(['on', '위임'], {quote: 'q'}, by), /사람 또는 슈퍼감독만/);
  assert.equal(f.entries().length, 0);
  assert.equal(f.sent.length, 0);
  const r = f.run(['on', '승인 위임'], {quote: '알아서 다 승인해 줘', 'discord-message': '123456'}, 'a-슈퍼감독');
  assert.deepEqual(r.to, ['b-슈퍼감독']); // 켠 슈퍼 자신은 다시 받지 않는다
  const [on] = f.entries();
  assert.equal(on.by, 'a-슈퍼감독');
  assert.equal(on.viaChat, true);
  assert.equal(on.quote, '알아서 다 승인해 줘');
  assert.equal(on.discordMessageId, '123456');
  assert.match(f.sent[0].message, /kyle 채팅 원문\(a-슈퍼감독이\(가\) 옮겨 적음\): 알아서 다 승인해 줘/);
});

test('배포 대상: 관계표를 못 읽으면 아무것도 보내지 않고 실패, 슈퍼가 없는 업무는 따로 적는다', () => {
  const none = fixture({hierarchy: false});
  assert.throws(() => none.run(['on', '문구']), /관계표를 읽지 못해/);
  assert.equal(none.sent.length, 0);
  assert.equal(none.entries().length, 0);

  const f = fixture();
  f.works.push({key: 'z/w1', status: 'open', owner: 'z-감독', executions: []}); // 관계표에 없는 감독
  const r = f.run(['on', '문구']);
  assert.deepEqual(r.unreachable, ['z/w1']);
  assert.deepEqual(r.to, ['a-슈퍼감독', 'b-슈퍼감독']);
  assert.deepEqual(f.entries()[0].unreachable, ['z/w1']);

  const empty = fixture();
  empty.works.length = 0;
  assert.deepEqual(empty.run(['on', '문구']).to, []); // 열린 업무가 없으면 받을 슈퍼도 없다
});

test('12시간 초과는 거절하고 아무것도 보내지 않는다', () => {
  const f = fixture();
  assert.throws(() => f.run(['on', '문구'], {for: '13h'}), /최대 12시간/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.entries().length, 0);
});

test('off: 끝 사건과 요약을 한 번 쓰고 받은 슈퍼에게 종료 우편, 두 번째 off는 거절', () => {
  const f = fixture();
  f.run(['on', '문구'], {});
  f.sent.length = 0;
  f.setNow(T0 + 2 * HOUR);
  const r = f.run(['off'], {reason: '일어남'});
  assert.equal(r.on, false);
  assert.equal(r.phase, 'off');
  assert.match(r.summary, /kyle 위임: "문구"/);
  assert.match(r.summary, /night off로 껐음/);
  const events = f.entries();
  assert.deepEqual(events.map(e => e.phase), ['on', 'off']);
  assert.equal(events[1].reason, '일어남');
  assert.equal(events[1].startedAt, iso(T0));
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0].opts.kind, 'night-summary');
  assert.deepEqual(f.sent.map(s => s.role), ['a-슈퍼감독', 'b-슈퍼감독']);
  assert.match(f.sent[0].message, /\[나이트 모드 종료\] kyle이 껐음/);
  assert.throws(() => f.run(['off']), /이미 꺼져 있습니다/);
  assert.equal(f.entries().length, 2);
  assert.equal(f.run(['status']).on, false);
});

test('끝 시각 만료: 감시기 한 주기에 expired 한 번, 두 번째 주기에는 없고 요약도 한 번', () => {
  const f = fixture();
  f.run(['on', '문구'], {for: '1h'});
  f.sent.length = 0;
  const cycle = now => { f.setNow(now); return watchNightExpiry({entries: readLedger(f.home), now, home: f.home, deps: f.deps}); };
  assert.equal(cycle(T0 + 30 * 60_000), null); // 아직 켜짐
  assert.equal(f.entries().length, 1);
  const done = cycle(T0 + 61 * 60_000);
  assert.equal(done.phase, 'expired');
  assert.equal(done.by, 'watch');
  assert.equal(done.endedAt, iso(T0 + HOUR)); // 요약 구간의 끝은 끝 시각이다
  assert.equal(cycle(T0 + 62 * 60_000), null);
  assert.equal(cycle(T0 + 10 * HOUR), null);
  assert.deepEqual(f.entries().map(e => e.phase), ['on', 'expired']);
  assert.equal(f.notes.length, 1);
  assert.equal(f.sent.length, 2); // 종료 우편도 슈퍼마다 한 번
  // 켠 적이 없는 홈에서는 원장을 더 읽지도 않는다
  assert.equal(watchNightExpiry({entries: [], now: T0, home: f.home, deps: {readEntries: () => { throw new Error('읽으면 안 됨'); }}}), null);
});

test('만료된 켜짐이 마무리되지 않은 채 night on을 치면 먼저 expired를 쓰고 새로 켠다', () => {
  const f = fixture();
  f.run(['on', '옛 문구'], {for: '1h'});
  f.setNow(T0 + 3 * HOUR);
  assert.equal(f.run(['status']).on, false);
  assert.equal(f.run(['status']).pendingEnd, 'expired'); // status는 읽기만 한다
  assert.equal(f.entries().length, 1);
  const r = f.run(['on', '새 문구'], {});
  assert.equal(r.previousEnded, 'expired');
  assert.deepEqual(f.entries().map(e => e.phase), ['on', 'expired', 'on']);
  assert.equal(f.notes.length, 1);
});

test('kyle 새 입력: 켜진 뒤 사람 명의 결정 답이 있으면 ended-by-input, 역할 명의·켜기 전 답은 아니다', () => {
  const on = {kind: 'night', phase: 'on', t: iso(T0), until: iso(T0 + 8 * HOUR), by: '사람', text: 't', to: []};
  const answer = (by, at) => ({id: 'd1', status: 'answered', answer: {by, at: iso(at), text: 'ok'}});
  const state = events => nightState([on], events, T0 + HOUR);
  assert.equal(state([]).on, true);
  assert.equal(state([answer('a-감독', T0 + 1000)]).on, true);
  assert.equal(state([answer('사람', T0 - 1000)]).on, true); // 켜기 전의 답
  const ended = state([answer('사람', T0 + 1000)]);
  assert.equal(ended.on, false);
  assert.deepEqual(ended.pending, {phase: 'ended-by-input', endedAt: T0 + 1000});
  // 끝 시각 뒤의 답은 만료가 먼저다
  const late = nightState([on], [answer('사람', T0 + 9 * HOUR)], T0 + 10 * HOUR);
  assert.equal(late.pending.phase, 'expired');
});

test('실제 결정 답(DecisionStore.answer)이 켜진 나이트 모드를 끄고 요약을 한 번 보낸다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-night-decision-'));
  new CardStore(home).create({repo: 'repo', id: 'card-a', repoPath: home, body: '# 시험'});
  const store = new DecisionStore(home, {notify: () => {}, userNotify: () => null});
  const d = store.request('repo/card-a', {question: '합칠까요?', options: ['합침', '보류'], recommendation: '합침',
    reason: '확인\n- PR: https://github.com/o/r/pull/7'}, 'a-슈퍼감독');
  const start = Date.now() - 60_000;
  appendLedger({kind: 'night', phase: 'on', t: iso(start), until: iso(start + 8 * HOUR), by: '사람', text: '자러 감', to: [], delivered: []}, home);
  assert.throws(() => store.answer(d.id, {revision: 1, text: '합침'}, 'a-감독'), /사람 명의/); // 거절된 답은 켜짐을 건드리지 않는다
  assert.deepEqual(readLedger(home).filter(e => e.kind === 'night').map(e => e.phase), ['on']);
  store.answer(d.id, {revision: 1, text: '합침', choice: '합침'}, '사람');
  const events = readLedger(home).filter(e => e.kind === 'night');
  assert.deepEqual(events.map(e => e.phase), ['on', 'ended-by-input']);
  assert.equal(events[1].summary.counts.answered, 1);
  assert.equal(events[1].summary.counts.mergeAnswered, 1);
  assert.match(events[1].summary.text, /kyle의 새 입력으로 꺼짐/);
  store.answer(d.id, {revision: 1, text: '합침', choice: '합침'}, '사람'); // 같은 답을 다시 해도 끝 사건은 늘지 않는다
  assert.equal(readLedger(home).filter(e => e.kind === 'night').length, 2);
});

const baseOn = (extra = {}) => ({kind: 'night', phase: 'on', t: iso(T0), until: iso(T0 + 8 * HOUR), by: '사람', text: '자러 감', to: ['a-슈퍼감독'], delivered: [], ...extra});
const decision = (id, status, extra) => ({id, card: 'r/c', requestedBy: 'a-슈퍼감독', question: '질문', options: ['a', 'b'], recommendation: 'a', reason: 'r', status, ...extra});
const summarize = ({start = baseOn(), phase = 'off', end = T0 + 4 * HOUR, entries = [], decisionEvents = [], bodies = {}} = {}) =>
  summarizeNight({start, phase, endedAt: end, entries, decisionEvents, readBody: d => bodies[d] ?? null});

test('요약 집계: 답과 취소를 나누고, 같은 결정의 후속 기록·구간 밖은 세지 않는다', () => {
  const at = ms => iso(T0 + ms);
  const answered = (id, ms) => decision(id, 'answered', {answer: {by: '사람', text: 'ok', at: at(ms)}});
  const events = [
    decision('d1', 'open'),
    answered('d1', HOUR),
    {...answered('d1', HOUR), delivery: {status: 'sent'}}, // 통지 결과를 덧쓴 후속 기록
    answered('d2', 2 * HOUR),
    answered('d3', -HOUR), // 켜지기 전
    answered('d4', 5 * HOUR), // 꺼진 뒤
    decision('d5', 'cancelled', {cancelledBy: '사람', cancelledAt: at(3 * HOUR), cancelReason: 'x'}),
    decision('d6', 'cancelled', {cancelledBy: 'a-슈퍼감독', cancelledAt: at(3 * HOUR), cancelReason: 'kyle 채팅 승인: ok'}),
  ];
  const s = summarize({decisionEvents: events});
  assert.equal(s.counts.answered, 2);
  assert.equal(s.counts.cancelledByHuman, 1);
  assert.equal(s.counts.cancelledBySuper, 1);
  assert.match(s.text, /결정 답 2건 · 사람이 취소한 결정 1건/);
  assert.match(s.text, /위임으로 대신 처리한 일\n- 슈퍼감독이 대신 닫은 결정 1건/);
  assert.ok(!/머지/.test(s.text)); // PR 주소가 든 결정이 없으면 머지 줄도 없다
});

test('요약 머지: PR 주소가 든 결정의 답·취소 건수만 세고 실제 머지는 GitHub에서 확인이라고 적는다', () => {
  const pr = {reason: '확인\n- PR: https://github.com/o/r/pull/12'};
  const events = [
    decision('m1', 'answered', {...pr, answer: {by: '사람', text: 'ok', at: iso(T0 + HOUR)}}),
    decision('m2', 'cancelled', {...pr, cancelledBy: 'a-슈퍼감독', cancelledAt: iso(T0 + 2 * HOUR), cancelReason: 'x'}),
    decision('n1', 'answered', {answer: {by: '사람', text: 'ok', at: iso(T0 + HOUR)}}),
  ];
  const s = summarize({decisionEvents: events});
  assert.equal(s.counts.mergeAnswered, 1);
  assert.equal(s.counts.mergeCancelled, 1);
  assert.match(s.text, /머지 관련 결정 답 1건·취소 1건 — 실제 머지는 GitHub에서 확인/);
  assert.ok(!/머지했/.test(s.text) && !/머지 완료/.test(s.text));
});

test('요약: 재시작·우편·보류 집계, 대리 위임 원문이 첫 줄, 켠 우편 자신은 제외, 빈 밤은 빈 밤이라고 적는다', () => {
  const t = ms => iso(T0 + ms);
  const entries = [
    {kind: 'stop', restart: true, t: t(HOUR)},
    {kind: 'stop', restart: true, t: t(10 * HOUR)}, // 구간 밖
    {kind: 'stop', t: t(HOUR)}, // 재시작이 아닌 종료
    {kind: 'send', mailId: 'night-1', role: 'a-슈퍼감독', t: t(1)}, // 나이트 모드가 보낸 우편
    {kind: 'send', mailId: 'm2', role: 'a-감독', t: t(HOUR)},
    {kind: 'send', mailId: 'm3', role: '사람', digest: 'held1', t: t(2 * HOUR)},
    {kind: 'send', mailId: 'm4', role: '사람', digest: 'plain', t: t(2 * HOUR)},
  ];
  const start = baseOn({viaChat: true, by: 'a-슈퍼감독', quote: '다 알아서 승인해', delivered: [{role: 'a-슈퍼감독', mailId: 'night-1'}]});
  const s = summarize({start, entries, bodies: {held1: '[나이트 보류] 운영 DB 마이그레이션\n자세히', plain: '안녕'}});
  assert.equal(s.text.split('\n')[0], '대리 위임: a-슈퍼감독이(가) kyle의 채팅 말을 옮겨 적었습니다 — "다 알아서 승인해" (전체 원문: kadan night status, 원장)');
  assert.equal(s.counts.restarts, 1);
  assert.equal(s.counts.mails, 3);
  assert.equal(s.counts.held, 1);
  assert.deepEqual(s.held, ['운영 DB 마이그레이션']);
  assert.match(s.text, /재시작 1건 · 우편 3건 · 보류로 남긴 것 1건/);
  assert.match(s.text, /· 보류: 운영 DB 마이그레이션/);

  const empty = summarize({});
  assert.match(empty.text, /밤사이 처리한 일 없음/);
  assert.equal(empty.text.split('\n')[0], 'kyle 위임: "자러 감" (전체: kadan night status, 원장)');
});

test('CLI: 일반감독의 night on은 거절되고, status는 읽기만 한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-night-cli-'));
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const run = (args, role) => spawnSync(process.execPath, [cli, 'night', ...args],
    {env: {...process.env, KADAN_HOME: home, KADAN_ROLE: role, KADAN_NOTIFY: 'off', KADAN_WINDOW: 'none'}, encoding: 'utf8'});
  const denied = run(['on', '문구'], 'a-감독');
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /사람 또는 슈퍼감독만/);
  const status = run(['status'], '사람');
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {on: false, last: null});
  const noQuote = run(['on', '문구'], 'a-슈퍼감독');
  assert.notEqual(noQuote.status, 0);
  assert.match(noQuote.stderr, /채팅 원문/);
  assert.equal(readLedger(home).filter(e => e.kind === 'night').length, 0);
});

test('감시기는 주기마다 끝 시각 확인을 한 번 부르고, 그 확인이 던져도 감시는 계속된다', async () => {
  const times = [T0, T0 + 60_000, T0 + 120_000];
  let cycle = 0;
  const end = new Error('end'), calls = [], errors = [];
  const clock = () => times[Math.min(cycle, times.length - 1)];
  const realError = console.error;
  console.error = (...x) => errors.push(x.join(' '));
  try {
    await assert.rejects(() => runWatch({
      floor: {list: () => [], read: () => ''}, readEntries: () => [{kind: 'night', phase: 'on'}], readCards: () => [],
      intervalMs: 60_000, stallN: 100, parents: new Map(), routes: new Map(), superRole: null,
      checkNightExpiry: ({entries, now}) => { calls.push({n: entries.length, now}); if (calls.length === 2) throw new Error('잠금'); },
      now: clock, record: () => {}, sendAlert: () => {}, print: () => {},
      spawn: cmd => {
        if (cmd === 'sleep' && ++cycle === times.length) throw end;
        if (cmd === 'memory_pressure') return {status: 0, stdout: 'System-wide memory free percentage: 80%'};
        if (cmd === 'sysctl') return {status: 0, stdout: 'used = 0M'};
        return {status: 0, stdout: ''};
      },
    }), e => e === end);
  } finally { console.error = realError; }
  assert.deepEqual(calls.map(c => c.now), times);
  assert.equal(calls[0].n, 1);
  assert.equal(errors.filter(e => e.includes('나이트 모드 끝 시각 확인 실패')).length, 1);
});

test('F1: 미만료 주기는 추가 원장·결정 이력 읽기가 0회이고, 꺼짐·켠 적 없음도 0회', () => {
  const f = fixture();
  f.run(['on', '문구'], {for: '8h'});
  let reads = 0;
  const counting = {...f.deps, readEntries: () => { reads++; return []; }, readDecisions: () => { reads++; return []; }};
  const entries = readLedger(f.home);
  for (const ms of [HOUR, 2 * HOUR, 3 * HOUR]) assert.equal(watchNightExpiry({entries, now: T0 + ms, home: f.home, deps: counting}), null);
  assert.equal(reads, 0);
  // 마지막 night 사건이 끝 사건이면(꺼짐) 만료 시각이 지나도 읽지 않는다
  f.run(['off']);
  const after = readLedger(f.home);
  assert.equal(watchNightExpiry({entries: after, now: T0 + 20 * HOUR, home: f.home, deps: counting}), null);
  assert.equal(watchNightExpiry({entries: [], now: T0, home: f.home, deps: counting}), null);
  assert.equal(reads, 0);
  // 배열을 복사하지 않고 인덱스 역순으로 훑는다(코드 대조)
  const src = fs.readFileSync(new URL('../src/night.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function watchNightExpiry'));
  assert.ok(!/\.reverse\(\)|\[\.\.\.entries\]|\.slice\(|\.filter\(/.test(body), '감시기 확인에서 배열 복사 금지');
});

test('F1: 실제 저장 계층(JSONL·SQLite)에서 미만료 주기의 추가 읽기가 0회', () => {
  for (const backend of ['jsonl', 'sqlite']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `kadan-night-${backend}-`));
    if (backend === 'sqlite') { createDatabase(home); writeStorageMarker(home, 'sqlite'); }
    appendLedger({kind: 'night', phase: 'on', by: '사람', text: '위임', t: iso(T0), until: iso(T0 + 8 * HOUR), to: []}, home);
    appendStream(home, 'decisions/events.jsonl', {id: 'x', status: 'open'});
    const entries = readLedger(home);
    const files = [], queries = [];
    const readFile = fs.readFileSync, prepare = DatabaseSync.prototype.prepare;
    fs.readFileSync = function (file, ...rest) { if (String(file).startsWith(home) && String(file).endsWith('events.jsonl')) files.push(String(file)); return readFile.call(this, file, ...rest); };
    DatabaseSync.prototype.prepare = function (sql, ...rest) { if (/FROM events WHERE stream=\?/s.test(sql)) queries.push(sql); return prepare.call(this, sql, ...rest); };
    try { for (const ms of [HOUR, 2 * HOUR, 3 * HOUR]) assert.equal(watchNightExpiry({entries, now: T0 + ms, home}), null); }
    finally { fs.readFileSync = readFile; DatabaseSync.prototype.prepare = prepare; }
    assert.equal(files.length + queries.length, 0, `${backend}: 추가 읽기 ${files.length + queries.length}회`);
  }
});

test('F1: 결정 답 경로의 마무리가 실패했어도 끝 시각에 감시기가 ended-by-input으로 한 번만 끝낸다', () => {
  const f = fixture();
  f.run(['on', '문구'], {for: '2h'});
  // kyle의 답이 있었지만 settleNight가 실패해 끝 사건이 없는 상태
  const decisions = [{id: 'd1', status: 'answered', answer: {by: '사람', at: iso(T0 + HOUR), text: 'ok'}}];
  const deps = {...f.deps, readDecisions: () => decisions};
  f.setNow(T0 + 90 * 60_000);
  assert.equal(watchNightExpiry({entries: readLedger(f.home), now: T0 + 90 * 60_000, home: f.home, deps}), null); // 아직 끝 시각 전: 감시기는 결정 이력을 보지 않는다
  const done = watchNightExpiry({entries: readLedger(f.home), now: T0 + 2 * HOUR, home: f.home, deps});
  assert.equal(done.phase, 'ended-by-input');
  assert.equal(done.endedAt, iso(T0 + HOUR));
  assert.equal(watchNightExpiry({entries: readLedger(f.home), now: T0 + 3 * HOUR, home: f.home, deps}), null);
  assert.deepEqual(f.entries().map(e => e.phase), ['on', 'ended-by-input']);
  assert.equal(f.notes.length, 1);
});

test('F2: 2,200자 원문은 켜지고, 끝날 때 알림이 1,800자 이하에 제목·기간·집계를 모두 담는다', () => {
  const f = fixture();
  const quote = '알아서 다 승인해 줘. '.repeat(200).slice(0, 2200);
  f.run(['on', '위임'], {quote, for: '6h'}, 'a-슈퍼감독');
  assert.equal(f.entries()[0].quote.length, 2200); // 원장에는 원문 그대로
  f.setNow(T0 + HOUR);
  f.run(['off'], {}, '사람');
  const message = f.notes[0].message;
  assert.ok(message.length <= NOTICE_LIMIT, `알림 ${message.length}자`);
  assert.match(message, /나이트 모드 요약 \(/);
  assert.match(message, /밤사이 생긴 일/);
  assert.match(message, /위임으로 대신 처리한 일/);
  assert.match(message, /kadan night status/);
  assert.equal(message.split('\n')[0].startsWith('대리 위임: '), true);
});

test('F2: 4,001자는 거절하고 원장에 쓰지 않는다', () => {
  const f = fixture();
  assert.equal(MAX_TEXT, 4000);
  assert.throws(() => f.run(['on', '위임'], {quote: 'ㄱ'.repeat(4001)}, 'a-슈퍼감독'), /4000자를 넘습니다/);
  assert.throws(() => f.run(['on', 'ㄱ'.repeat(4001)], {}), /4000자를 넘습니다/);
  assert.equal(f.entries().length, 0);
  assert.equal(f.sent.length, 0);
  f.run(['on', 'ㄱ'.repeat(4000)], {}); // 경계값은 켜진다
  assert.equal(f.entries().length, 1);
});

test('F2: 줄바꿈 원문도 대리 위임 표시는 한 줄이고, 보류가 많아도 집계는 잘리지 않는다', () => {
  const start = {kind: 'night', phase: 'on', t: iso(T0), until: iso(T0 + 8 * HOUR), by: 'a-슈퍼감독', viaChat: true,
    quote: '첫 줄\n둘째 줄\n\n셋째 줄', text: 't', to: [], delivered: []};
  const s = summarizeNight({start, phase: 'off', endedAt: T0 + HOUR, entries: [], decisionEvents: [], readBody: () => null});
  const lines = s.text.split('\n');
  assert.match(lines[0], /^대리 위임: .*"첫 줄 둘째 줄 셋째 줄"/);
  assert.match(lines[1], /^나이트 모드 요약 \(/);
  // 보류 200건(각 100자) + 긴 원문: 상한 안에서 제목·집계는 남고 보류 상세만 줄어든다
  const entries = Array.from({length: 200}, (_, i) => ({kind: 'send', mailId: `m${i}`, role: '사람', digest: `h${i}`, t: iso(T0 + 1000 + i)}));
  const big = summarizeNight({start: {...start, quote: 'ㄱ'.repeat(4000)}, phase: 'off', endedAt: T0 + HOUR, entries, decisionEvents: [],
    readBody: () => `[나이트 보류] ${'ㅂ'.repeat(120)}`});
  assert.ok(big.text.length <= NOTICE_LIMIT, `${big.text.length}자`);
  assert.match(big.text, /보류로 남긴 것 200건/);
  assert.match(big.text, /위임으로 대신 처리한 일\n- 없음$/);
});

test('F3: 꺼진 뒤 status가 마지막 켜짐의 원문을 보인다(줄바꿈 유지), 사람 명의·켠 적 없음도 확인', () => {
  const f = fixture();
  assert.deepEqual(f.run(['status']), {on: false, last: null}); // 켠 적 없음
  assert.equal(nightOriginalText(f.run(['status'])), null);
  const quote = '첫 줄\n둘째 줄';
  f.run(['on', '대리', '위임'], {quote, for: '6h'}, 'a-슈퍼감독');
  const on = f.run(['status']);
  assert.equal(nightOriginalText(on).includes('첫 줄\n둘째 줄'), true);
  f.setNow(T0 + HOUR);
  f.run(['off'], {}, '사람');
  const off = f.run(['status']);
  assert.equal(off.on, false);
  assert.deepEqual(off.last, {phase: 'off', t: iso(T0 + HOUR), startedAt: iso(T0), endedAt: iso(T0 + HOUR), by: 'a-슈퍼감독', viaChat: true, text: '대리 위임', quote});
  const shown = nightOriginalText(off);
  assert.match(shown, /마지막 위임 원문 \(a-슈퍼감독, kyle 채팅을 옮겨 적음\)/);
  assert.ok(shown.includes('대리 위임') && shown.includes('첫 줄\n둘째 줄'));
  // 사람 명의(원문 quote 없음): 문구만, quote 칸 없음. 새로 켜면 마지막 켜짐이 바뀐다
  f.setNow(T0 + 2 * HOUR);
  f.run(['on', '사람 문구'], {for: '1h'}, '사람');
  f.setNow(T0 + 3 * HOUR);
  f.run(['off'], {}, '사람');
  const human = f.run(['status']).last;
  assert.equal(human.text, '사람 문구');
  assert.equal(human.viaChat, false);
  assert.ok(!('quote' in human));
  assert.ok(!nightOriginalText(f.run(['status'])).includes('kyle 채팅 원문'));
  // 만료 뒤 마무리 전: 끝 시각이 보인다
  f.setNow(T0 + 4 * HOUR);
  f.run(['on', '만료 문구'], {for: '1h'}, '사람');
  f.setNow(T0 + 6 * HOUR);
  const pending = f.run(['status']);
  assert.equal(pending.last.phase, 'expired');
  assert.equal(pending.last.endedAt, iso(T0 + 5 * HOUR));
  assert.equal(pending.last.text, '만료 문구');
});

test('#247 뒤: 증분 읽기(SQLite) entries에도 night 사건이 그대로 있고, 미만료·꺼짐 주기는 추가 읽기 0회', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-night-incr-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  appendLedger({kind: 'night', phase: 'on', by: '사람', text: '위임', t: iso(T0), until: iso(T0 + 8 * HOUR), to: []}, home);
  appendStream(home, 'decisions/events.jsonl', {id: 'x', status: 'open'});
  const entries = readLedgerIncremental(home); // 감시기의 cycleReads가 쓰는 읽기
  assert.ok(entries.some(e => e.kind === 'night' && e.phase === 'on'), '증분 entries에 night 사건이 있어야 한다');
  const queries = [];
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...rest) { queries.push(sql); return prepare.call(this, sql, ...rest); };
  try {
    for (const ms of [HOUR, 2 * HOUR, 3 * HOUR]) assert.equal(watchNightExpiry({entries, now: T0 + ms, home}), null);
    assert.equal(watchNightExpiry({entries: [], now: T0, home}), null);
  } finally { DatabaseSync.prototype.prepare = prepare; }
  assert.equal(queries.length, 0, `추가 SQL ${queries.length}회`);
});
