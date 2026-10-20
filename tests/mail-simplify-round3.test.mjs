// 우편 단순화 3라운드(재검수 R2-F1·R2-F2): 실패 사유는 고정 코드로 비교하고, 입력 보호 held도 같은 압축을 지나며,
// CLI 우편함도 감시기와 같은 '넣음' 근거(알림 sent 사건)로 세대를 가른다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MailWatch,FAILURE_FALLBACK} from '../src/watch-mail.mjs';
import {MAIL_RULE} from '../src/mail-rule.mjs';
import {mailboxLetters,isUnreadLetter} from '../src/mailbox-state.mjs';
import {inboxCommand} from '../src/mailbox.mjs';
import {appendLedger,readLedger,readMailboxLedger} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker} from '../src/storage.mjs';

const T0 = Date.parse('2020-01-01T01:00:00Z');
const MIN = 60_000;
const at = ms => new Date(ms).toISOString();
const start = (pid, ms = T0 - 3_600_000) => ({kind: 'start', role: 'worker', session: 'kadan-worker', panePid: pid, t: at(ms)});
const stored = mailId => ({kind: 'send', mailId, role: 'worker', by: 'boss', t: at(T0), transport: 'mailbox', mailRule: MAIL_RULE, expectReply: true});

function fixture() {
  const f = {entries: [start(1), stored('m1')], records: [], sent: [], now: T0, failWith: null,
    live: [{session: 'kadan-worker', alive: true, pid: 1}]};
  f.record = e => { f.records.push(e); f.entries.push(e); };
  f.create = () => new MailWatch({record: e => f.record(e), send: () => { if (f.failWith) throw f.failWith(); f.sent.push(1); }});
  f.tick = watch => watch.tick({entries: [...f.entries], cards: [], works: [], now: f.now, floor: {list: () => f.live},
    readEntries: () => [...f.entries], readCards: () => [], readWorks: () => []});
  return f;
}
const lines = f => f.records.filter(e => e.kind === 'watch-mail-reminder');

test('R2-F1 A: 같은 원인에 문장만 매번 달라도(tmux 버퍼 이름) 480순회 줄 수는 일정하고 사유는 고정 값이다', () => {
  const f = fixture();
  let n = 0;
  f.failWith = () => Object.assign(new Error(`tmux load-buffer -b kadan-send-21667-${n++} - 실패: 같은 원인`), {delivery: 'not-sent'});
  const watch = f.create();
  f.tick(watch);
  const after1 = lines(f).length;
  for (let i = 0; i < 480; i++) { f.now += MIN; f.tick(watch); }
  assert.equal(after1, 2);
  assert.equal(lines(f).length, after1);
  const result = lines(f).find(e => e.action === 'result');
  assert.equal(result.reason, FAILURE_FALLBACK);
  assert.ok(!JSON.stringify(lines(f)).includes('kadan-send-'), '변하는 문장은 원장에 쓰지 않는다');
  for (let i = 0; i < 20; i++) { f.now += MIN; f.tick(f.create()); }
  assert.equal(lines(f).length, after1, '재시작해도 같다');
});

test('R2-F1 A: 오류 코드가 있으면 그 코드가 비교 키이고, 코드가 바뀌면 1줄 늘어난다', () => {
  const f = fixture();
  const watch = f.create();
  f.failWith = () => Object.assign(new Error('a'), {delivery: 'not-sent', code: 'KADAN_SESSION_MISSING'});
  f.tick(watch); f.now += MIN; f.tick(watch);
  f.failWith = () => Object.assign(new Error('b'), {delivery: 'not-sent', code: 'KADAN_PID_MISMATCH'});
  f.now += MIN; f.tick(watch);
  assert.deepEqual(lines(f).filter(e => e.action === 'result').map(e => e.reason), ['KADAN_SESSION_MISSING', 'KADAN_PID_MISMATCH']);
});

test('R2-F1 B: 전송 검사에서 걸린 입력 보호(held)도 같은 고정 코드면 480순회·재시작에도 줄 수가 일정하다', () => {
  const f = fixture();
  let n = 0;
  f.failWith = () => Object.assign(new Error(`사람 입력 중 ${n++}`), {delivery: 'not-sent', code: 'KADAN_HUMAN_ACTIVE'});
  const watch = f.create();
  f.tick(watch);
  const after1 = lines(f).length;
  for (let i = 0; i < 480; i++) { f.now += MIN; f.tick(watch); }
  assert.equal(after1, 2);
  assert.equal(lines(f).length, after1);
  for (let i = 0; i < 20; i++) { f.now += MIN; f.tick(f.create()); }
  assert.equal(lines(f).length, after1, '재시작해도 같다');
  const result = lines(f).find(e => e.action === 'result');
  assert.deepEqual([result.held, result.reason, result.delivery], [true, 'KADAN_HUMAN_ACTIVE', 'not-sent']);
  assert.equal(f.sent.length, 0);
  f.failWith = null; f.now += MIN; f.tick(f.create());
  assert.equal(f.sent.length, 1, '풀리면 바로 알린다');
});

test('R2-F1 B: held 코드가 바뀌면 1줄 쓰고, held에서 일반 실패로 바뀌어도 1줄 쓴다', () => {
  const f = fixture();
  const watch = f.create();
  f.failWith = () => Object.assign(new Error('x'), {delivery: 'not-sent', code: 'KADAN_HUMAN_ACTIVE'});
  f.tick(watch);
  f.failWith = () => Object.assign(new Error('y'), {delivery: 'not-sent', code: 'KADAN_HUMAN_ACTIVITY_UNKNOWN'});
  f.now += MIN; f.tick(watch);
  f.failWith = () => Object.assign(new Error('z'), {delivery: 'not-sent'});
  f.now += MIN; f.tick(watch);
  assert.deepEqual(lines(f).filter(e => e.action === 'result').map(e => [e.reason, e.held === true]),
    [['KADAN_HUMAN_ACTIVE', true], ['KADAN_HUMAN_ACTIVITY_UNKNOWN', true], [FAILURE_FALLBACK, false]]);
});

// CLI 우편함: 알림이 이미 간 보관 우편은 새 대화에서 '이전 세대'로 가른다(대시보드·감시기와 같다).
function cliScenario(home) {
  const letter = {kind: 'send', mailId: 'prev-1', role: 'R', by: 'boss', t: at(0), transport: 'mailbox', mailRule: MAIL_RULE,
    mailKind: 'report', digest: 'd'.repeat(64), bytes: 1};
  appendLedger({kind: 'start', role: 'R', session: 'kadan-R', panePid: 1, t: at(0)}, home);
  appendLedger(letter, home);
  appendLedger({kind: 'watch-mail-reminder', by: 'watch', role: 'R', mailId: 'prev-1', expectedPid: 1, action: 'result',
    delivery: 'sent', reason: null, t: at(1000), stage: 'initial'}, home);
  // 같은 사건이어도 held는 넣은 것이 아니고, 예약만 있는 사건도 근거가 아니다.
  appendLedger({kind: 'watch-mail-reminder', by: 'watch', role: 'R', mailId: 'prev-1', expectedPid: 1, action: 'reserved', t: at(900)}, home);
  appendLedger({kind: 'stop', role: 'R', session: 'kadan-R'}, home);
  appendLedger({kind: 'start', role: 'R', session: 'kadan-R', panePid: 2, t: at(2000)}, home);
  const list = flags => inboxCommand(['list'], {role: 'R', ...flags}, {home, by: 'R'}).map(e => e.mailId);
  const full = mailboxLetters(readLedger(home), 'R');
  assert.equal(full[0].previousGeneration, true, '전체 원장 기준(대시보드·감시기)');
  assert.deepEqual(list({unread: true}), [], '현재 미확인 0');
  assert.deepEqual(list({'previous-generations': true}), ['prev-1'], '이전 세대 1');
  assert.deepEqual(mailboxLetters(readMailboxLedger(home), 'R').filter(isUnreadLetter), []);
  // 읽는 양: 우편함 조회에 더해지는 것은 sent 결과 사건의 최소 필드뿐이다(예약·held·not-sent는 들어오지 않는다).
  const extra = readMailboxLedger(home).filter(e => e.kind === 'watch-mail-reminder');
  assert.equal(extra.length, 1);
  assert.deepEqual(Object.keys(extra[0]).sort(), ['action', 'delivery', 'kind', 'mailId', 'role', 't']);
}

test('R2-F2: CLI 우편함도 알림 sent 근거로 세대를 가른다(JSONL 원장)', () => {
  cliScenario(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-r3-')));
});

test('R2-F2: CLI 우편함도 알림 sent 근거로 세대를 가른다(SQLite 원장)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-r3-sql-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  cliScenario(home);
});

test('R2-F2: 알림 근거가 없으면(한 번도 못 넣음) 새 대화의 현재 미확인으로 남는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-r3-none-'));
  appendLedger({kind: 'start', role: 'R', session: 'kadan-R', panePid: 1, t: at(0)}, home);
  appendLedger({kind: 'send', mailId: 'never', role: 'R', by: 'boss', t: at(0), transport: 'mailbox', mailRule: MAIL_RULE,
    mailKind: 'report', digest: 'e'.repeat(64), bytes: 1}, home);
  appendLedger({kind: 'start', role: 'R', session: 'kadan-R', panePid: 2, t: at(2000)}, home);
  assert.deepEqual(inboxCommand(['list'], {role: 'R', unread: true}, {home, by: 'R'}).map(e => e.mailId), ['never']);
});
