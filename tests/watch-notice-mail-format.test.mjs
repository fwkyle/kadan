// 감시기 알림 본문 형식(kyle이 글자로 정함): 미확인 우편 1통·6통, 상위 알림, 놀고 있음·경보. '보낸이'는 원래 우편 발신자다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Mailbox, inboxCommand} from '../src/mailbox.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {MailWatch} from '../src/watch-mail.mjs';
import {MAIL_RULE} from '../src/mail-rule.mjs';
import {kstTime, firstLine, unreadMailMessage, escalationNotice, WATCH_ALERT_FOOTER} from '../src/watch-notice-format.mjs';
import {itemizedAlert, formatAlertBody} from '../src/watch-alert-body.mjs';
import {idleRegisterHint, idleOwnText} from '../src/watch-supervisor.mjs';

const T0 = Date.parse('2020-01-01T01:00:00Z'); // KST 2020-01-01 10:00
const MIN = 60_000;
const at = ms => new Date(ms).toISOString();
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const letter = (n, more = {}) => ({kind: 'send', mailId: ID(n), role: 'worker', by: 'boss', t: at(T0), transport: 'mailbox',
  mailRule: MAIL_RULE, preview: `본문 ${n}`, ...more});

test('kstTime: UTC를 KST YYYY-MM-DD HH:MM으로', () => {
  assert.equal(kstTime('2020-01-01T01:00:00Z'), '2020-01-01 10:00');
  assert.equal(kstTime('2020-12-31T15:30:00Z'), '2021-01-01 00:30');
  assert.equal(kstTime('나쁨'), '시각 모름');
});

test('firstLine: 지침 블록을 걷고 비밀을 가리고 80자 이내로 자른다', () => {
  assert.equal(firstLine('안녕\n둘째 줄'), '안녕');
  assert.equal(firstLine('질문 <!-- kadan:receiver-instructions --> 지침 본문 <!-- /kadan:receiver-instructions --> 끝'), '질문 끝');
  assert.equal(firstLine('<!-- kadan:receiver-instructions -->\n지침만'), '(본문 미리보기 없음)');
  assert.equal(firstLine('토큰 Bearer abcdefghijklmnopqrstuvwxyz0123 이다'), '토큰 [가림] 이다');
  const long = firstLine('가'.repeat(200));
  assert.equal([...long].length, 80);
  assert.ok(long.endsWith('…'));
  assert.equal(firstLine('나'.repeat(80)), '나'.repeat(80));
  assert.equal(firstLine(undefined), '(본문 미리보기 없음)');
});

test('미확인 우편 1통 본문이 kyle 형식과 글자 단위로 같다 (보낸이는 원래 발신자)', () => {
  const m = letter(1, {preview: '배포 전에 확인 부탁'});
  assert.equal(unreadMailMessage([m], 'worker'), [
    '미확인 우편 1건',
    '보낸이: boss',
    '받는이: worker',
    '보낸 시각: 2020-01-01 10:00',
    '첫 줄: 배포 전에 확인 부탁',
    `확인: kadan inbox read ${ID(1)} --role 'worker'`,
    `읽음 기록: kadan inbox ack ${ID(1)} --role 'worker'`,
    '',
    '읽은 우편만 직접 ack하세요. 최종 답변은 읽음 확인과 별개입니다.'].join('\n'));
});

test('currentSender·currentRecipient(인계 뒤)를 따른다', () => {
  const m = letter(1, {currentSender: 'boss2', currentRecipient: 'worker2'});
  const text = unreadMailMessage([m], 'worker2');
  assert.match(text, /보낸이: boss2\n받는이: worker2\n/);
  assert.match(text, /--role 'worker2'/);
});

test('미확인 우편 6통: 블록 5개 + 외 1건', () => {
  const mails = [1, 2, 3, 4, 5, 6].map(n => letter(n, {by: `b${n}`}));
  const text = unreadMailMessage(mails, 'worker');
  assert.ok(text.startsWith('미확인 우편 6건\n보낸이: b1\n'));
  assert.equal(text.split('\n\n').length, 5 + 1 + 1, '블록 5 + 외 N건 + 안내');
  assert.equal([...text.matchAll(/^보낸이: /gmu)].length, 5);
  assert.ok(text.includes(`읽음 기록: kadan inbox ack ${ID(5)} --role 'worker'`));
  assert.ok(!text.includes(ID(6)));
  assert.ok(text.includes("\n\n외 1건 — kadan inbox --role 'worker' --unread\n\n"));
  assert.ok(text.endsWith('읽은 우편만 직접 ack하세요. 최종 답변은 읽음 확인과 별개입니다.'));
});

test('상위 알림: 같은 블록 + 상태, 읽음 기록 명령은 없다', () => {
  const items = [{mail: letter(1), kind: 'unread', minutes: 20}, {mail: letter(2, {role: 'w2'}), kind: 'unknown', minutes: 0}];
  assert.equal(escalationNotice(items), [
    '[감시기] 하위 역할의 미읽음 우편 2건',
    '보낸이: boss', '받는이: worker', '보낸 시각: 2020-01-01 10:00', '첫 줄: 본문 1', '상태: 20분째 미읽음',
    `확인: kadan inbox read ${ID(1)} --role 'worker'`,
    '',
    '보낸이: boss', '받는이: w2', '보낸 시각: 2020-01-01 10:00', '첫 줄: 본문 2', '상태: 결과 불명',
    `확인: kadan inbox read ${ID(2)} --role 'w2'`,
    '',
    '읽음 확인은 수신자 몫이니 대신 ack하지 마세요.'].join('\n'));
  assert.doesNotMatch(escalationNotice(items), /읽음 기록/);
  const many = Array.from({length: 7}, (_, i) => ({mail: letter(i + 1), kind: 'unread', minutes: 20}));
  assert.match(escalationNotice(many), /\n\n외 2건\n\n/);
});

test('MailWatch가 실제로 새 형식을 보내고, 같은 우편은 순회가 돌아도 다시 보내지 않는다', () => {
  const sent = [], records = [], entries = [
    {kind: 'start', role: 'worker', session: 'kadan-worker', panePid: 100, t: at(T0 - 3_600_000)},
    letter(1, {preview: '첫째'}), letter(2, {preview: '둘째'})];
  const floor = {list: () => [{session: 'kadan-worker', alive: true, pid: 100}]};
  const watch = new MailWatch({record: e => { records.push(e); entries.push(e); }, send: (role, message) => sent.push({role, message}), hold: () => null});
  const tick = now => watch.tick({entries: [...entries], cards: [], works: [], now, floor, readEntries: () => [...entries],
    readCards: () => [], readWorks: () => [], parents: new Map()});
  tick(T0 + MIN);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /^미확인 우편 2건\n보낸이: boss\n받는이: worker\n보낸 시각: 2020-01-01 10:00\n첫 줄: 첫째\n/);
  assert.match(sent[0].message, /\n\n보낸이: boss\n받는이: worker\n보낸 시각: 2020-01-01 10:00\n첫 줄: 둘째\n/);
  tick(T0 + 2 * MIN); tick(T0 + 3 * MIN);
  assert.equal(sent.length, 1, '본문이 우편별 블록이어도 순회마다 새 알림을 만들지 않는다(우편 ID·단계 예약)');
});

test('우편함 우편(preview 없음)은 본문 파일 첫 줄을 쓰고, 안내한 확인·읽음 명령이 실제 CLI에서 동작한다', () => {
  const home = process.env.KADAN_HOME;
  appendLedger({kind: 'start', role: 'worker', session: 'kadan-notice-worker', panePid: 1, t: at(T0)}, home);
  const {mailId} = new Mailbox(home, 'worker').send({by: 'boss', message: '첫 줄 내용\n둘째 줄', expectReply: true});
  const sent = [], entries = () => readLedger(home);
  const floor = {list: () => [{session: 'kadan-worker', alive: true, pid: 1}]};
  const watch = new MailWatch({record: e => appendLedger(e, home), send: (role, message) => sent.push({role, message}), hold: () => null});
  watch.tick({entries: entries(), cards: [], works: [], now: Date.now() + 10 * MIN, floor, readEntries: entries,
    readCards: () => [], readWorks: () => [], parents: new Map()});
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /첫 줄: 첫 줄 내용\n확인: kadan inbox read /);
  const read = inboxCommand(['read', mailId], {role: 'worker'}, {home, by: 'worker'});
  assert.equal(read.read, false);
  assert.equal(entries().filter(e => e.kind === 'mail-read').length, 0, 'read는 ack를 만들지 않는다');
  inboxCommand(['ack', mailId], {role: 'worker'}, {home, by: 'worker'});
  assert.equal(entries().filter(e => e.kind === 'mail-read').length, 1);
});

test('놀고 있음 1단·2단·경보: 대상·상태·근거·본인 차례·할 일 항목', () => {
  const idle = {kind: '놀고 있음', session: 'kadan-x', role: 'kadan-x-감독', openCards: 2, lower: {}, idleMinutes: 15, stage: 1};
  assert.equal(itemizedAlert(idle, '12:30'), [
    '[watch 12:30] 놀고 있음 kadan-x (본인 차례 2건, 15분간 화면 변화 없음) — 판을 확인하고 다음 행동을 정하라. 이대로 15분 더 멈추면 상위에게 알린다.',
    '대상: kadan-x', '상태: 놀고 있음', '근거: 본인 차례 2건, 15분간 화면 변화 없음',
    '할 일: 판을 확인하고 다음 행동을 정하라. 이대로 15분 더 멈추면 상위에게 알린다.'].join('\n'));
  const own = {...idle, idleItems: {ownWhy: [{id: 'c1', reason: '답 필요'}]}};
  assert.match(itemizedAlert(own, '12:30'), /\n본인 차례: c1 \(답 필요\) 외 1건\.\n할 일: /);
  const second = itemizedAlert({...idle, stage: 2, idleMinutes: 30}, '12:45');
  assert.match(second, /\n근거: 본인 차례 2건, 30분간 화면 변화 없음; 15분 전에 본인에게 알렸으나 그대로\n할 일: /);
  assert.ok(second.endsWith(`할 일: ${WATCH_ALERT_FOOTER}`));
  assert.ok(!/보낸이/.test(second));

  const stall = {kind: '정체', session: 'kadan-x', count: 3};
  assert.equal(itemizedAlert(stall, '12:30'), [`[watch 12:30] ${formatAlertBody(stall)}`, '대상: kadan-x', '상태: 화면이 멈춤',
    '근거: 지문 무변화 3회', `할 일: ${WATCH_ALERT_FOOTER}`].join('\n'));
  assert.match(itemizedAlert({kind: '멈춤', session: 's', idleMs: 600000}, 'c'), /\n상태: 일하는 표시 없이 입력을 기다리며 멈춤\n근거: 빈 입력창 10분째/);
  assert.match(itemizedAlert({kind: '죽음', session: 's'}, 'c'), /\n상태: 세션 종료 의심\n근거: 세션 없음 또는 PID 불일치\n/);
  assert.equal(itemizedAlert({kind: '큐대기', session: 's', queuedMs: 0, line: 'x'}, 'c').split('\n').filter(l => l.startsWith('근거')).length, 0, '근거를 모르는 종류는 근거 줄이 없다');
});

test('놀고 있음 1단: 답할 쪽에 맞는 등록 명령 꼴(2단·한 줄 글은 그대로)', () => {
  const base = {kind: '놀고 있음', session: 'kadan-x', role: 'x-감독', openCards: 1, lower: {}, idleMinutes: 15, stage: 1};
  const withItem = (id, reason = '내 차례') => ({...base, idleItems: {ownWhy: [{id, reason}]}});
  const plain = itemizedAlert(withItem('work:r/w'), '12:30');
  const user = itemizedAlert(withItem('work:r/w'), '12:30', new Map([['x-감독', '@user']]));
  assert.ok(user.includes("kadan decision request <카드키> --work r/w --question '<질문>'"));
  assert.ok(user.includes('실제로 기다리는 중일 때만') && user.includes('멈춘 것이면 등록하지 말고 다음 행동'));
  assert.equal(user.split('\n').length, plain.split('\n').length + 1, '한 줄만 더해진다');
  const mail = itemizedAlert(withItem('work:r/w'), '12:30', new Map([['x-감독', '상위']]));
  assert.ok(mail.includes("kadan mail 상위 --work r/w --expect-reply '<질문>'"));
  assert.ok(itemizedAlert(withItem('r/card1'), '12:30', new Map([['x-감독', '@user']])).includes('decision request r/card1 --work <업무주소>'));
  assert.equal(idleRegisterHint(withItem('work:r/w'), new Map()), '', '상위를 모르면 없다');
  assert.equal(idleRegisterHint(withItem('work:r/w', '답할 질문'), new Map([['x-감독', '@user']])), '', '답할 질문이면 없다');
  const second = {...withItem('work:r/w'), stage: 2, idleMinutes: 30};
  const parents = new Map([['x-감독', '@user']]);
  assert.equal(itemizedAlert(second, '12:45', parents), itemizedAlert(second, '12:45'));
  assert.ok(!formatAlertBody(withItem('work:r/w')).includes('decision request'));
  assert.ok(!idleOwnText(withItem('work:r/w')).includes('decision request'));
});
