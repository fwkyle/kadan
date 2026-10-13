import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Mailbox,inboxCommand,mailboxLetters} from '../src/mailbox.mjs';
import {isUnreadLetter} from '../src/mailbox-state.mjs';
import {isPreviousGenerationUnread} from '../src/mail-generation.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {MailWatch} from '../src/watch-mail.mjs';
import {filterMail,mailStatus} from '../src/dashboard-inbox.mjs';
import {repoNameFor,roleNameWarning} from '../src/role-name.mjs';

const at = n => new Date(n).toISOString();
const start = (pid, more = {}) => ({kind:'start',role:'R',session:'kadan-R',panePid:pid,t:at(0),...more});
const stop = {kind:'stop',role:'R',session:'kadan-R'};
const letter = (mailId, more = {}) => ({kind:'send',mailId,role:'R',by:'boss',t:at(0),...more});
const unreadFor = (entries, role = 'R') => mailboxLetters(entries, role).filter(isUnreadLetter).map(e => e.mailId);
const previousFor = (entries, role = 'R') => mailboxLetters(entries, role).filter(isPreviousGenerationUnread).map(e => e.mailId);
const threeLetters = () => [start(1), letter('a'), letter('b'), letter('c'), stop];

test('같은 이름으로 새 세대가 시작되면 이전 세대 미확인은 현재 미확인·재알림에서 빠지고 따로 보인다', () => {
  const entries = [...threeLetters(), start(2)];
  assert.deepEqual(unreadFor(entries), []);
  assert.deepEqual(previousFor(entries), ['a', 'b', 'c']);
  assert.equal(entries.length, 6, '원장은 바꾸지 않는다');
  const sent = [], records = [];
  const watch = new MailWatch({record: e => records.push(e), send: (...args) => sent.push(args)});
  watch.tick({entries, cards: [], works: [], now: 600000, floor: {list: () => [{session: 'kadan-R', alive: true, pid: 2}]},
    readEntries: () => entries, readCards: () => [], readWorks: () => []});
  assert.equal(sent.length, 0);
  assert.equal(records.length, 0);
  // 새 세대가 시작되기 전이면 같은 편지가 재알림 대상이다.
  const before = threeLetters().slice(0, 4), sentBefore = [];
  new MailWatch({record: () => {}, send: (...args) => sentBefore.push(args)}).tick({entries: before, cards: [], works: [], now: 600000,
    floor: {list: () => [{session: 'kadan-R', alive: true, pid: 1}]}, readEntries: () => before, readCards: () => [], readWorks: () => []});
  assert.equal(sentBefore.length, 1);
});

test('--inherit-mail start는 이전 세대 미확인을 이어받고 이전 세대 경계를 지운다', () => {
  const entries = [...threeLetters(), start(2), stop, start(3, {inheritMail: true, inheritedUnread: 3})];
  assert.deepEqual(unreadFor(entries), ['a', 'b', 'c']);
  assert.deepEqual(previousFor(entries), []);
  // 이어받은 뒤 다시 새 세대가 시작되면 다시 이전 세대가 된다.
  assert.deepEqual(unreadFor([...entries, stop, start(4)]), []);
});

test('같은 정체로 이어가는 start(복원·살아 있는 세션 재사용·비서 복원)는 우편을 유지한다', () => {
  for (const next of [start(1), start(2, {restoredFrom: 'terminal-1'}), start(2, {secretaryResumeSource: 'digest'})]) {
    const entries = [start(1), letter('a'), next];
    assert.deepEqual(unreadFor(entries), ['a'], JSON.stringify(next));
  }
  // 재사용은 stop 사이에 없을 때만이다. 같은 PID라도 stop 뒤의 start는 새 세대다.
  assert.deepEqual(unreadFor([start(1), letter('a'), stop, start(1)]), []);
});

test('세션이 없는 동안 저장된 우편은 직전 세대 몫이고, 새 세대 start 뒤 우편은 현재 몫이다', () => {
  const entries = [letter('first'), start(1), letter('mine'), stop, letter('offline'), start(2), letter('fresh')];
  assert.deepEqual(unreadFor(entries), ['fresh']);
  assert.deepEqual(previousFor(entries), ['first', 'mine', 'offline']);
  assert.deepEqual(unreadFor([letter('first'), start(1)]), ['first'], '첫 start 전 우편은 첫 세대 몫이다');
  // 복원이면 offline 우편을 그대로 잇는다.
  assert.deepEqual(unreadFor([start(1), stop, letter('offline'), start(2, {restoredFrom: 't'})]), ['offline']);
});

test('확정 인계 이후 현재 담당 이름의 새 세대만 기준이다', () => {
  const handover = {kind: 'handover', phase: 'transferred', handoverId: 'h', from: 'A', to: 'B'};
  const a = (pid, more = {}) => ({kind: 'start', role: 'A', session: 'kadan-A', panePid: pid, ...more});
  const b = (pid) => ({kind: 'start', role: 'B', session: 'kadan-B', panePid: pid});
  const mail = {kind: 'send', mailId: 'x', role: 'A', by: 'boss', t: at(0)};
  assert.deepEqual(unreadFor([a(1), b(2), mail, {kind: 'stop', role: 'B', session: 'kadan-B'}, b(3), handover], 'B'), ['x'],
    '인계가 B의 새 세대 뒤에 확정되면 B가 받는다');
  assert.deepEqual(unreadFor([a(1), b(2), mail, handover, {kind: 'stop', role: 'B', session: 'kadan-B'}, b(3)], 'B'), [],
    '인계 뒤 B의 새 세대가 시작되면 이전 세대다');
});

test('inbox: 기본 목록에서 빠지고 --previous-generations에서 보이며 ack된다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-gen-'));
  appendLedger(start(1), home);
  const mailbox = new Mailbox(home, 'R');
  const ids = ['a', 'b', 'c'].map(message => mailbox.send({by: 'boss', message}).mailId);
  appendLedger(stop, home);
  appendLedger(start(2), home);
  const list = flags => inboxCommand(['list'], flags, {home, by: 'R'}).map(e => e.mailId);
  assert.deepEqual(list({role: 'R'}), []);
  assert.deepEqual(list({role: 'R', unread: true}), []);
  assert.deepEqual(list({role: 'R', 'previous-generations': true}).sort(), [...ids].sort());
  assert.equal(list({role: 'R', all: true}).length, 3, '--all 기록 조회에는 남아 있다');
  inboxCommand(['ack', ids[0]], {role: 'R'}, {home, by: 'R'});
  assert.deepEqual(list({role: 'R', 'previous-generations': true}).sort(), ids.slice(1).sort());
  assert.equal(inboxCommand(['read', ids[1]], {role: 'R'}, {home, by: 'R'}).read, false, '이전 세대 편지도 본문을 읽을 수 있다');
});

test('대시보드 거르기와 상태 표기', () => {
  const entries = [...threeLetters(), start(2), letter('new', {t: at(1)})];
  const letters = mailboxLetters(entries);
  const ids = query => filterMail(letters, new URL('http://x/?' + query)).map(e => e.mailId);
  assert.deepEqual(ids('mailUnread=1'), ['new']);
  assert.deepEqual(ids('mailUnread=previous'), ['a', 'b', 'c']);
  assert.match(mailStatus(letters[0]), /이전 세대 미확인/);
  assert.doesNotMatch(mailStatus(letters[3]), /이전 세대/);
});

test('이름 규칙 경고: 레포 접두 없음만 한 번, 있으면·git 밖이면·비서면 없음', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-name-'));
  const repo = path.join(root, 'myrepo'), tree = path.join(root, 'myrepo-feature'), outside = path.join(root, 'plain');
  fs.mkdirSync(repo); fs.mkdirSync(outside);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd: repo, stdio: 'ignore'});
  git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'init'); git('worktree', 'add', '-q', '-b', 'feature', tree);
  const real = p => fs.realpathSync(p);
  assert.equal(repoNameFor(real(repo)), 'myrepo');
  assert.equal(repoNameFor(real(tree)), 'myrepo', 'worktree는 주 저장소 이름');
  assert.equal(repoNameFor(real(outside)), null);
  assert.match(roleNameWarning({role: '슈퍼감독', cwd: real(tree)}), /'myrepo-'로 시작하지 않는다/);
  assert.equal(roleNameWarning({role: 'myrepo-슈퍼감독', cwd: real(tree)}), null);
  assert.equal(roleNameWarning({role: 'myrepo-주제-작업자', cwd: real(repo)}), null);
  assert.equal(roleNameWarning({role: '슈퍼감독', cwd: real(outside)}), null);
  assert.equal(roleNameWarning({role: '비서', profile: 'secretary', cwd: real(repo)}), null);
});
