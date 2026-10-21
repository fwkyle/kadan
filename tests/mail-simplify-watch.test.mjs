// 우편 단순화 1단계: 감시기 상태표(한 번도 못 넣음 / 넣음)와 함정 A(세대 필터)·B(우편 표지로 새 규칙을 가른다).
import test from 'node:test';
import assert from 'node:assert/strict';
import {MailWatch} from '../src/watch-mail.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';
import {MAIL_RULE} from '../src/mail-rule.mjs';

// 시각은 새 규칙과 무관하다(날짜 기준이 아니라 우편마다 mailRule 표지로 가른다). 일부러 아주 먼 과거 날짜를 쓴다.
const T0 = Date.parse('2020-01-01T01:00:00Z');
const MIN = 60_000;
const at = ms => new Date(ms).toISOString();
const start = (pid, ms = T0 - 3_600_000) => ({kind: 'start', role: 'worker', session: 'kadan-worker', panePid: pid, t: at(ms)});
const stored = (mailId, more = {}) => ({kind: 'send', mailId, role: 'worker', by: 'boss', t: at(T0),
  transport: 'mailbox', mailRule: MAIL_RULE, expectReply: true, ...more});
// 표지가 없는 옛 우편(이 코드 이전에 쓴 기록).
const legacy = (mail) => { delete mail.mailRule; return mail; };
const keyed = (mailId, more = {}) => ({kind: 'send', mailId, role: 'worker', by: 'boss', t: at(T0),
  keyDelivery: 'sent', mailRule: MAIL_RULE, expectReply: true, ...more});

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
  assert.equal(f.records.filter(e => e.action === 'result' && e.delivery === 'not-sent').length, 1, '같은 사유 재시도는 원장에 쓰지 않는다');
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

test('함정 B: 표지 없는 옛 우편은 시각과 상관없이 옛 규칙 그대로 — 새 세대에게 알리지 않고 매 순회 재시도하지 않는다', () => {
  const f = fixture([legacy(stored('old-prev')), start(2, T0 + MIN)]);
  f.live = [{session: 'kadan-worker', alive: true, pid: 2}];
  f.now = T0 + 2 * MIN; f.tick();
  assert.equal(f.sent.length, 0, '이전 세대 옛 우편은 쏟아지지 않는다');
  const g = fixture([legacy(stored('old'))]);
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

const reminderLines = (f, mailId = 'm1') => f.records.filter(e => e.kind === 'watch-mail-reminder' && e.mailId === mailId);

test('같은 사유 not-sent를 480순회 돌려도 reminder 원장 줄 수는 일정하다(예약 1 + 첫 실패 1)', () => {
  const f = fixture([stored('m1')]);
  f.failWith = notSent('세션 입력 거절');
  const watch = f.create();
  f.tick(watch);
  const after1 = reminderLines(f).length;
  for (let i = 0; i < 480; i++) { f.now += MIN; f.tick(watch); }
  assert.equal(after1, 2);
  assert.equal(reminderLines(f).length, after1);
  assert.equal(watch.suppressed.size, 1, '쓰지 않은 재시도는 메모리로 센다');
  assert.equal([...watch.suppressed.values()][0], 480);
});

test('사유가 바뀌면 1줄 늘고(센 횟수 포함), sent·unknown은 그대로 기록하며 unknown은 영구 예약이다', () => {
  const f = fixture([stored('m1')]);
  const watch = f.create();
  f.failWith = Object.assign(notSent('세션 입력 거절'), {code: 'KADAN_SESSION_MISSING'});
  f.tick(watch); f.now += MIN; f.tick(watch);
  f.failWith = Object.assign(notSent('다른 사유'), {code: 'KADAN_PID_MISMATCH'}); f.now += MIN; f.tick(watch); f.now += MIN; f.tick(watch);
  const results = reminderLines(f).filter(e => e.action === 'result');
  assert.deepEqual(results.map(e => e.reason), ['KADAN_SESSION_MISSING', 'KADAN_PID_MISMATCH']);
  assert.equal(results[1].suppressedRetries, 1);
  f.failWith = Object.assign(new Error('응답 유실'), {delivery: 'unknown'}); f.now += MIN; f.tick(watch);
  assert.equal(reminderLines(f).filter(e => e.action === 'result').at(-1).delivery, 'unknown');
  const lines = reminderLines(f).length;
  f.failWith = null;
  for (let i = 0; i < 5; i++) { f.now += MIN; f.tick(watch); f.tick(f.create()); }
  assert.equal(f.sent.length, 0, 'unknown은 영구 예약이라 다시 보내지 않는다');
  assert.equal(reminderLines(f).length, lines);
});

test('재시작해도 원장의 첫 실패 기록과 미전달 판정만으로 재시도가 이어지고 같은 사유는 다시 쓰지 않는다', () => {
  const f = fixture([stored('m1')]);
  f.failWith = notSent('세션 입력 거절');
  f.tick(f.create());
  const lines = reminderLines(f).length;
  for (let i = 0; i < 20; i++) { f.now += MIN; f.tick(f.create()); }
  assert.equal(reminderLines(f).length, lines, '새 프로세스(빈 메모리)도 같은 사유는 쓰지 않는다');
  f.failWith = null; f.now += MIN;
  const sentAt = f.now;
  f.tick(f.create());
  assert.equal(f.sent.length, 1, '재시작 뒤 첫 성공 시도');
  f.now = sentAt + 5 * MIN; f.tick(f.create()); f.tick(f.create());
  assert.equal(f.sent.length, 2, 'sent 뒤 5분 알림도 재시작과 상관없이 1회');
});

test('결과 없이 죽은 예약(reserved만 남음)은 다음 순회에 다시 시도하고 예약을 또 쓰지 않는다', () => {
  const f = fixture([stored('m1'),
    {kind: 'watch-mail-reminder', mailId: 'm1', role: 'worker', action: 'reserved', stage: 'initial', t: at(T0)}]);
  f.failWith = notSent('세션 입력 거절');
  f.tick(f.create());
  assert.equal(reminderLines(f).filter(e => e.action === 'reserved').length, 0);
  assert.equal(reminderLines(f).filter(e => e.action === 'result').length, 1);
});

test('옛 규칙(표지 없는 우편)은 그대로 한 번 예약하면 재시도하지 않는다', () => {
  const f = fixture([legacy(stored('old'))]);
  f.failWith = notSent('세션 입력 거절');
  f.tick(); f.now += MIN; f.tick();
  assert.equal(reminderLines(f, 'old').filter(e => e.action === 'reserved').length, 1);
  assert.equal(f.sent.length, 0);
});

test('F2: 보관 우편이 PID 1에 첫 알림 sent된 뒤 새 start(PID 2)가 뜨면 이전 세대라 5분 알림을 새 대화에 보내지 않는다', () => {
  const f = fixture([stored('m1')]);
  f.tick();
  assert.equal(f.sent.length, 1);
  f.entries.push(start(2, f.now + MIN));
  f.live = [{session: 'kadan-worker', alive: true, pid: 2}];
  f.now += 5 * MIN;
  const letter = mailboxLetters(f.entries).find(e => e.mailId === 'm1');
  assert.equal(letter.previousGeneration, true);
  f.tick(f.create());
  assert.equal(f.sent.length, 1, 'PID 2에는 알림이 나가지 않는다');
});

test('F2 대조: 세대 변화가 없으면 PID 1에 5분 알림이 1회 나간다', () => {
  const f = fixture([stored('m1')]);
  f.tick();
  f.now += 5 * MIN; f.tick(f.create());
  assert.equal(f.sent.length, 2);
});

test('새 대화가 뜬 뒤에 처음 넣은 보관 우편은 그 대화의 우편으로 남아 5분 알림까지 간다', () => {
  const f = fixture([stored('m1'), start(2, T0 + MIN)]);
  f.live = [{session: 'kadan-worker', alive: true, pid: 2}];
  f.now = T0 + 2 * MIN; f.tick();
  assert.equal(f.sent.length, 1);
  const sentAt = f.now;
  assert.equal(mailboxLetters(f.entries).find(e => e.mailId === 'm1').previousGeneration, false);
  f.now = sentAt + 5 * MIN; f.tick(f.create());
  assert.equal(f.sent.length, 2);
});
