// 우편 단순화 1단계: 감시기 상태표(한 번도 못 넣음 / 넣음)와 함정 A(세대 필터)·B(배포 기준 시각).
import test from 'node:test';
import assert from 'node:assert/strict';
import {MailWatch} from '../src/watch-mail.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';
import {MAIL_SIMPLIFY_SINCE} from '../src/mail-since.mjs';

const T0 = Date.parse(MAIL_SIMPLIFY_SINCE) + 3_600_000; // 기준 시각 1시간 뒤
const MIN = 60_000;
const at = ms => new Date(ms).toISOString();
const start = (pid, ms = T0 - 3_600_000) => ({kind: 'start', role: 'worker', session: 'kadan-worker', panePid: pid, t: at(ms)});
const stored = (mailId, more = {}) => ({kind: 'send', mailId, role: 'worker', by: 'boss', t: at(T0),
  transport: 'mailbox', expectReply: true, ...more});
const keyed = (mailId, more = {}) => ({kind: 'send', mailId, role: 'worker', by: 'boss', t: at(T0),
  keyDelivery: 'sent', expectReply: true, ...more});

function fixture(mails, {startPid = 1} = {}) {
  const f = {entries: [start(startPid), ...mails], cards: [], works: [], sent: [], records: [], now: T0,
    live: [{session: 'kadan-worker', alive: true, pid: startPid}], failWith: null, hold: null};
  f.floor = {list: () => f.live};
  f.record = e => { f.records.push(e); f.entries.push(e); };
  f.send = (...args) => { if (f.failWith) throw f.failWith; f.sent.push(args); };
  f.create = () => new MailWatch({record: e => f.record(e), send: (...args) => f.send(...args), hold: () => f.hold});
  f.tick = (watch = f.create()) => watch.tick({entries: [...f.entries], cards: f.cards, works: f.works, now: f.now,
    floor: f.floor, readEntries: () => [...f.entries], readCards: () => f.cards, readWorks: () => f.works});
  return f;
}
const notSent = message => Object.assign(new Error(message), {delivery: 'not-sent'});

test('못 넣은 우편: 유예 없이 매 순회 재시도하고, 보낸 뒤 5분에 한 번만 다시 알린다', () => {
  const f = fixture([stored('m1')]);
  f.failWith = notSent('세션 입력 거절');
  f.tick(); f.now += 1000; f.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.records.filter(e => e.action === 'result' && e.delivery === 'not-sent').length, 2);
  f.failWith = null; f.now += 1000;
  const sentAt = f.now;
  f.tick();
  assert.equal(f.sent.length, 1);
  f.now = sentAt + 4 * MIN; f.tick(); assert.equal(f.sent.length, 1, '5분 전에는 다시 알리지 않는다');
  f.now = sentAt + 5 * MIN; f.tick(); assert.equal(f.sent.length, 2, '넣은 뒤 5분에 1회');
  f.now = sentAt + 30 * MIN; f.tick(f.create()); assert.equal(f.sent.length, 2, '그 뒤 영구 예약, 재시작해도 중복 없음');
  assert.deepEqual(f.records.filter(e => e.action === 'reserved').map(e => e.stage).slice(-2), ['initial', 'followup']);
});

test('5분 시계는 우편을 보낸 시각이 아니라 알림이 sent된 시각부터 잰다', () => {
  const f = fixture([stored('m1')]);
  f.now = T0 + 10 * MIN; f.tick(); assert.equal(f.sent.length, 1);
  f.now = T0 + 14 * MIN; f.tick(); assert.equal(f.sent.length, 1, 'mail.t로부터 5분이 지났어도 아직 아니다');
  f.now = T0 + 15 * MIN; f.tick(); assert.equal(f.sent.length, 2);
});

test('키로 넣은 새 우편은 넣은 시각 + 5분에 1회만 알린다', () => {
  const f = fixture([keyed('m1')]);
  f.now = T0 + 5 * MIN - 1; f.tick(); assert.equal(f.sent.length, 0);
  f.now = T0 + 5 * MIN; f.tick(); f.tick(f.create()); assert.equal(f.sent.length, 1);
});

test('전달 불명확(unknown)은 영구 예약이라 다시 보내지 않고 확인 필요로 남긴다', () => {
  const f = fixture([stored('m1')]);
  f.failWith = Object.assign(new Error('응답 유실'), {delivery: 'unknown'});
  f.tick();
  f.failWith = null; f.now += 10 * MIN;
  f.tick(); f.tick(f.create());
  assert.equal(f.sent.length, 0);
  const result = f.records.find(e => e.action === 'result');
  assert.equal(result.delivery, 'unknown'); assert.equal(result.needsCheck, true);
});

test('result 없이 reserved만 남은 예약은 예약으로 보지 않고 다시 시도한다', () => {
  const f = fixture([stored('m1'),
    {kind: 'watch-mail-reminder', mailId: 'm1', role: 'worker', action: 'reserved', stage: 'initial', t: at(T0)}]);
  f.tick(f.create());
  assert.equal(f.sent.length, 1);
});

test('함정 A: 받는 쪽이 꺼진 동안 저장된 새 우편은 그 역할의 다음 start 뒤에도 알린다', () => {
  const f = fixture([stored('off'), start(2, T0 + MIN)], {startPid: 1});
  f.live = [{session: 'kadan-worker', alive: true, pid: 2}];
  f.now = T0 + 2 * MIN;
  const letter = mailboxLetters(f.entries).find(e => e.mailId === 'off');
  assert.equal(letter.previousGeneration, false);
  f.tick();
  assert.equal(f.sent.length, 1);
});

test('함정 A 대조: 키로 넣었는데 미확인인 우편은 새 세대에게 다시 알리지 않는다', () => {
  const f = fixture([keyed('delivered'), start(2, T0 + MIN)]);
  f.live = [{session: 'kadan-worker', alive: true, pid: 2}];
  f.now = T0 + 10 * MIN; f.tick();
  assert.equal(f.sent.length, 0);
});

test('함정 B: 기준 시각 이전 우편은 옛 규칙 그대로 — 새 세대에게 알리지 않고 매 순회 재시도하지 않는다', () => {
  const before = at(Date.parse(MAIL_SIMPLIFY_SINCE) - 3_600_000);
  const f = fixture([stored('old-prev', {t: before}), start(2, T0 + MIN)]);
  f.live = [{session: 'kadan-worker', alive: true, pid: 2}];
  f.now = T0 + 2 * MIN; f.tick();
  assert.equal(f.sent.length, 0, '이전 세대 옛 우편은 쏟아지지 않는다');
  const g = fixture([stored('old', {t: before})]);
  g.failWith = notSent('입력 거절'); g.tick();
  g.failWith = null; g.now += 1000; g.tick();
  assert.equal(g.sent.length, 0, '옛 우편은 못 넣어도 예약이 풀리지 않아 재시도하지 않는다');
});

test('닫힌 업무: 첫 알림은 내고 5분 알림은 생략하며, 일시정지(hold)는 제외한다', () => {
  const f = fixture([stored('m1', {workKey: 'r/w'})]);
  f.works = [{key: 'r/w', status: 'done', executions: []}];
  f.tick(); assert.equal(f.sent.length, 1, 'done이어도 첫 알림');
  f.now += 5 * MIN; f.tick(); assert.equal(f.sent.length, 1, '두 번째 알림은 닫힌 업무라 생략');
  const g = fixture([stored('m2', {workKey: 'r/w'})]);
  g.works = [{key: 'r/w', status: 'hold', executions: []}];
  g.tick(); assert.equal(g.sent.length, 0);
});

test('디코 우편은 키 전달 기록 없이 저장되어 다음 순회에 바로 알린다', () => {
  const f = fixture([stored('d1', {by: '디코', sourceKey: 'discord:1'})]);
  f.tick(); assert.equal(f.sent.length, 1);
});

test('비서 앞 우편은 새 규칙에서 빠져 옛 5분 유예를 그대로 쓴다', () => {
  const f = fixture([stored('s1', {role: '비서'})]);
  f.entries.unshift({kind: 'start', role: '비서', session: 'kadan-비서', panePid: 7, t: at(T0 - 3_600_000)});
  f.live.push({session: 'kadan-비서', alive: true, pid: 7});
  f.now = T0 + 4 * MIN; f.tick(); assert.equal(f.sent.length, 0);
});
