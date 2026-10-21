// 미읽음 우편 직속 상위 1회 알림: 세 번째 단계 escalate (initial·followup과 같은 장치).
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Mailbox, inboxCommand} from '../src/mailbox.mjs';
import {appendLedger, readLedger, readMailboxLedger} from '../src/ledger.mjs';
import {MailWatch, ESCALATE_LIST_MAX, PARENT_UNAVAILABLE} from '../src/watch-mail.mjs';
import {MAIL_RULE, firstReminderSent} from '../src/mail-rule.mjs';

const T0 = Date.parse('2020-01-01T01:00:00Z');
const MIN = 60_000;
const at = ms => new Date(ms).toISOString();
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const start = (role, pid) => ({kind: 'start', role, session: `kadan-${role}`, panePid: pid, t: at(T0 - 3_600_000)});
const stored = (mailId, role = 'worker', more = {}) => ({kind: 'send', mailId, role, by: 'boss', t: at(T0),
  transport: 'mailbox', mailRule: MAIL_RULE, expectReply: true, ...more});
const unknownError = Object.assign(new Error('응답 유실'), {delivery: 'unknown'});

function fixture(mails, {roles = ['worker'], parent = 'boss', parents = null} = {}) {
  const pids = new Map([...roles, parent].map((role, i) => [role, 100 + i]));
  const f = {entries: [...pids].map(([role, pid]) => start(role, pid), ), cards: [], works: [], sent: [], records: [], now: T0,
    dead: new Set(), failFor: null, hold: null, parents: parents ?? new Map(roles.map(role => [role, parent]))};
  f.entries.push(...mails);
  f.floor = {list: () => [...pids].filter(([role]) => !f.dead.has(role)).map(([role, pid]) => ({session: `kadan-${role}`, alive: true, pid}))};
  f.record = e => { f.records.push(e); f.entries.push(e); };
  f.send = (role, message, pid) => {
    if (f.failFor) { const error = f.failFor(role); if (error) throw error; }
    f.sent.push({role, message, pid});
  };
  f.create = () => new MailWatch({record: e => f.record(e), send: (...args) => f.send(...args), hold: role => f.hold?.(role) ?? null});
  f.tick = (watch = f.create()) => watch.tick({entries: [...f.entries], cards: f.cards, works: f.works, now: f.now,
    floor: f.floor, readEntries: () => [...f.entries], readCards: () => f.cards, readWorks: () => f.works, parents: f.parents});
  f.toParent = () => f.sent.filter(s => s.role === 'boss');
  f.escalateRecords = () => f.records.filter(e => e.stage === 'escalate');
  // 수신자에게 넣고(initial) 5분 뒤 다시 알린(followup) 상태까지 진행한다. 반환: followup sent 시각.
  f.untilFollowup = (watch) => { f.tick(watch); f.now = T0 + 5 * MIN; f.tick(watch); return f.now; };
  return f;
}

test('followup sent 뒤 14분은 없음, 15분에 상위에게 1통(수신자·전체 ID·보낸이·보낸 시각·N분째·확인 명령)', () => {
  const f = fixture([stored(ID(1))]);
  const watch = f.create();
  const followupAt = f.untilFollowup(watch);
  assert.deepEqual(f.sent.map(s => s.role), ['worker', 'worker']);
  f.now = followupAt + 14 * MIN; f.tick(watch); assert.equal(f.toParent().length, 0);
  f.now = followupAt + 15 * MIN; f.tick(watch);
  assert.equal(f.toParent().length, 1);
  const [head, line] = f.toParent()[0].message.split('\n');
  assert.match(head, /^\[미읽음 우편 상위 알림\] 직속 부하 앞 우편 1건/);
  assert.equal(line, `- 우편 받는이 worker · 우편 ID ${ID(1)} · 보낸이 boss · 보낸 시각 ${at(T0)} · 상태 20분째 미읽음 · 확인: kadan inbox read ${ID(1)} --role 'worker'`);
  f.now += 60 * MIN; f.tick(watch); f.tick(f.create()); assert.equal(f.toParent().length, 1, '평생 1회, 재시작해도 0회');
});

test('followup과 15분 사이에 수신자가 ack하면 알리지 않는다', () => {
  const f = fixture([stored(ID(1))]);
  const watch = f.create();
  const followupAt = f.untilFollowup(watch);
  f.entries.push({kind: 'mail-read', role: 'worker', transport: 'mailbox', mailId: ID(1), by: 'worker', t: at(followupAt + 10 * MIN)});
  f.now = followupAt + 15 * MIN; f.tick(watch);
  assert.equal(f.toParent().length, 0);
});

test('initial unknown과 followup unknown은 각각 다음 순회에 escalate("결과 불명")', () => {
  const a = fixture([stored(ID(1))]);
  a.failFor = role => role === 'worker' ? unknownError : null;
  a.tick(); a.failFor = null; a.now += 1000; a.tick();
  assert.equal(a.toParent().length, 1);
  assert.match(a.toParent()[0].message, /결과 불명 · 확인: kadan inbox read/);
  assert.equal(a.sent.filter(s => s.role === 'worker').length, 0, '넣지 못한 우편이 상위 알림으로 넣은 것이 되지 않는다');
  a.now += 60 * MIN; a.tick(); assert.equal(a.sent.filter(s => s.role === 'worker').length, 0, 'escalate sent가 followup 시계를 켜지 않는다');
  assert.equal(firstReminderSent(a.entries).size, 0);

  const b = fixture([stored(ID(2))]);
  const watch = b.create();
  b.tick(watch); b.now = T0 + 5 * MIN;
  b.failFor = role => role === 'worker' ? unknownError : null;
  b.tick(watch); b.failFor = null; b.now += 1000; b.tick(watch);
  assert.equal(b.toParent().length, 1);
  assert.match(b.toParent()[0].message, /결과 불명/);
});

test('상위 없음·@user·비서·사람이면 보내지 않는다', () => {
  for (const parent of [undefined, '@user', '비서', '사람']) {
    const f = fixture([stored(ID(1))], {parents: new Map(parent ? [['worker', parent]] : [])});
    const watch = f.create();
    f.untilFollowup(watch);
    f.now += 60 * MIN; f.tick(watch);
    assert.equal(f.sent.filter(s => s.role !== 'worker').length, 0, `상위 ${parent}`);
    assert.equal(f.escalateRecords().length, 0);
  }
});

test('연결 업무가 done·cancelled·hold면 제외하고, 없으면 알린다', () => {
  for (const status of ['done', 'cancelled', 'hold']) {
    const f = fixture([stored(ID(1), 'worker', {workKey: 'kadan/w'})]);
    f.works = [{key: 'kadan/w', status: 'open', executions: []}];
    const watch = f.create();
    const followupAt = f.untilFollowup(watch);
    f.works = [{key: 'kadan/w', status, executions: []}];
    f.now = followupAt + 20 * MIN; f.tick(watch);
    assert.equal(f.toParent().length, 0, status);
  }
  const open = fixture([stored(ID(1), 'worker', {workKey: 'kadan/w'})]);
  open.works = [{key: 'kadan/w', status: 'open', executions: []}];
  const watch = open.create();
  const followupAt = open.untilFollowup(watch);
  open.now = followupAt + 15 * MIN; open.tick(watch);
  assert.equal(open.toParent().length, 1);
});

test('같은 상위 아래 수신자 둘의 우편은 한 순회에 1통, 6건 이상이면 5건 + 외 N건', () => {
  const f = fixture([stored(ID(1), 'a'), stored(ID(2), 'b')], {roles: ['a', 'b']});
  const watch = f.create();
  const followupAt = f.untilFollowup(watch);
  f.now = followupAt + 15 * MIN; f.tick(watch);
  assert.equal(f.toParent().length, 1);
  assert.equal(f.toParent()[0].message.split('\n').length, 3, '머리 1줄 + 우편 2줄');

  const many = fixture(Array.from({length: 7}, (_, i) => stored(ID(10 + i))));
  const w = many.create();
  const at2 = many.untilFollowup(w);
  many.now = at2 + 15 * MIN; many.tick(w);
  const lines = many.toParent()[0].message.split('\n');
  assert.equal(many.toParent().length, 1);
  assert.equal(lines.length, 1 + ESCALATE_LIST_MAX + 1);
  assert.equal(lines.at(-1), '- 외 2건');
  assert.match(lines[0], /우편 7건/);
  assert.equal(many.escalateRecords().filter(e => e.action === 'result' && e.delivery === 'sent').length, 7, '묶어도 기록은 우편마다');
});

test('상위가 죽어 있으면 not-sent(고정 코드)로 한 번만 쓰고 480순회에도 줄 수가 일정하며, 살아나면 1통', () => {
  const f = fixture([stored(ID(1))]);
  const watch = f.create();
  const followupAt = f.untilFollowup(watch);
  f.dead.add('boss');
  f.now = followupAt + 15 * MIN; f.tick(watch);
  const first = f.escalateRecords().length;
  for (let i = 0; i < 480; i++) { f.now += 1000; f.tick(watch); }
  assert.equal(f.escalateRecords().length, first);
  const result = f.escalateRecords().find(e => e.action === 'result');
  assert.equal(result.delivery, 'not-sent'); assert.equal(result.reason, PARENT_UNAVAILABLE); assert.equal(result.to, 'boss');
  assert.equal(f.toParent().length, 0);
  f.dead.delete('boss'); f.now += 1000; f.tick(watch);
  assert.equal(f.toParent().length, 1);
  assert.equal(f.escalateRecords().at(-1).suppressedRetries, 480);
});

test('상위의 입력 보호는 상위 것으로 검사한다(수신자 보호는 상위 알림을 막지 않는다)', () => {
  const f = fixture([stored(ID(1))]);
  const watch = f.create();
  const followupAt = f.untilFollowup(watch);
  f.hold = role => role === 'boss' ? {code: 'KADAN_HUMAN_ACTIVE', message: '입력 중'} : null;
  f.now = followupAt + 15 * MIN; f.tick(watch); f.tick(watch);
  assert.equal(f.toParent().length, 0);
  assert.equal(f.records.filter(e => e.kind === 'watch-mail-held' && e.role === 'boss').length, 1, '같은 보류는 1회만 기록');
  f.hold = role => role === 'worker' ? {code: 'KADAN_HUMAN_ACTIVE', message: '입력 중'} : null;
  f.tick(watch);
  assert.equal(f.toParent().length, 1);
});

test('escalate unknown은 영구 예약이라 다시 보내지 않는다', () => {
  const f = fixture([stored(ID(1))]);
  const watch = f.create();
  const followupAt = f.untilFollowup(watch);
  f.failFor = role => role === 'boss' ? unknownError : null;
  f.now = followupAt + 15 * MIN; f.tick(watch);
  f.failFor = null; f.now += 60 * MIN; f.tick(watch); f.tick(f.create());
  assert.equal(f.toParent().length, 0);
  const result = f.escalateRecords().find(e => e.action === 'result');
  assert.equal(result.delivery, 'unknown'); assert.equal(result.needsCheck, true);
});

test('표지 없는 옛 우편은 상위 알림이 없고, 옛 규칙 동작은 그대로다', () => {
  const mail = stored(ID(1)); delete mail.mailRule;
  const f = fixture([mail]);
  f.now = T0 + 60 * MIN;
  const watch = f.create();
  f.tick(watch); f.now += 60 * MIN; f.tick(watch);
  assert.equal(f.toParent().length, 0);
  assert.equal(f.records.filter(e => e.stage != null).length, 0, '옛 규칙 기록에는 단계 칸이 없다');
  assert.equal(f.sent.filter(s => s.role === 'worker').length, 1);
});

test('escalate 기록은 고정 키뿐이고 안내 글자·본문·미리보기가 없으며 종류는 watch-mail-reminder다', () => {
  const f = fixture([stored(ID(1))]);
  const watch = f.create();
  const followupAt = f.untilFollowup(watch);
  f.now = followupAt + 15 * MIN; f.tick(watch);
  const [reserved, result] = f.escalateRecords();
  assert.deepEqual(Object.keys(reserved).sort(), ['action', 'by', 'expectedPid', 'kind', 'mailId', 'role', 'stage', 't', 'to']);
  assert.deepEqual(Object.keys(result).sort(), ['action', 'by', 'delivery', 'expectedPid', 'kind', 'mailId', 'reason', 'role', 'stage', 't', 'to']);
  assert.equal(result.kind, 'watch-mail-reminder'); assert.equal(result.role, 'worker'); assert.equal(result.to, 'boss');
  assert.equal(result.expectedPid, 101);
  assert.doesNotMatch(JSON.stringify(f.escalateRecords()), /미읽음|kadan inbox|preview|body/);
  assert.equal(firstReminderSent(f.entries).get(JSON.stringify([ID(1), 'worker'])), T0, 'escalate sent는 넣은 시각에 끼지 않는다');
});

test('안내하는 확인 명령: 상위가 남의 우편을 읽을 수 있고 읽음(ack)은 생기지 않으며 대신 ack는 거절된다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-esc-'));
  for (const role of ['worker', 'boss']) appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid: 1, t: at(T0)}, home);
  const {mailId} = new Mailbox(home, 'worker').send({by: 'boss', message: '본문', expectReply: true});
  const unread = () => inboxCommand(['list'], {role: 'worker', unread: true}, {home, by: 'worker'}).map(e => e.mailId);
  assert.deepEqual(unread(), [mailId]);
  const letter = inboxCommand(['read', mailId], {role: 'worker'}, {home, by: 'boss'});
  assert.equal(letter.body, '본문'); assert.equal(letter.read, false);
  assert.deepEqual(unread(), [mailId], '확인 뒤에도 미읽음');
  assert.equal(readLedger(home).filter(e => e.kind === 'mail-read').length, 0);
  assert.throws(() => inboxCommand(['ack', mailId], {role: 'worker'}, {home, by: 'boss'}), /수신자|읽음 기록 가능/);
  assert.equal(readLedger(home).filter(e => e.kind === 'mail-read').length, 0);
});

test('우편함 조회(readMailboxLedger)에는 escalate sent가 들어가지 않고 initial·followup sent만 들어간다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-esc-proj-'));
  const base = {kind: 'watch-mail-reminder', by: 'watch', role: 'worker', mailId: ID(1), expectedPid: 1, action: 'result', delivery: 'sent', reason: null};
  appendLedger({...base, stage: 'followup', t: at(T0)}, home);
  appendLedger({...base, stage: 'escalate', to: 'boss', t: at(T0 + MIN)}, home);
  const rows = readMailboxLedger(home).filter(e => e.kind === 'watch-mail-reminder');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].t, at(T0));
});
