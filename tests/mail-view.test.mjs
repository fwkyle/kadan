import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase, writeStorageMarker, appendStream, storagePath} from '../src/storage.mjs';
import {appendLedger, readLedger, readMailboxLedger} from '../src/ledger.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';
import {createMailGenerations} from '../src/mail-generation.mjs';
import {readMailboxViewPage, withMailboxView, mailboxWaitingCount,
  mailReminderCandidates, mailWaitingLetters} from '../src/mail-view.mjs';
import {ledgerViewPath} from '../src/ledger-view-store.mjs';

const homeOf = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mail-view-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');return home;
};
const add = (home, event) => appendLedger({t:'2026-01-01T00:00:00Z', ...event}, home);
const legacy = (home, events) => events.forEach(event => appendStream(home, 'ledger.jsonl', event));
function all(home, domain = null) {
  const result = [];
  let before = null;
  do {
    const page = readMailboxViewPage(home, {before, limit:7, domain});
    result.push(...page.items);before = page.next;
    assert.ok(result.length <= page.mailCount);
  } while (before !== null);
  return result.reverse();
}
function equal(home) {
  for (const domain of [null, 'mailbox']) {
    const expected = mailboxLetters(domain ? readMailboxLedger(home) : readLedger(home));
    assert.deepEqual(all(home, domain), expected);
    withMailboxView(home, store => {
      assert.equal(mailboxWaitingCount(store), expected.filter(m => m.replyStatus === 'waiting').length);
      assert.deepEqual(mailReminderCandidates(store), expected.filter(m => m.read === false
        && !m.previousGeneration && m.notificationOnly !== true && m.systemGenerated !== 'task-completion'));
    }, {domain});
  }
}

test('읽음·최초 답장·취소·참조 모호성을 과거 원문 순서대로 보존한다', () => {
  const home = homeOf();
  legacy(home, [
    {kind:'mail-read', mailId:'future', role:'fixture-b', by:'fixture-b'},
    {kind:'send', mailId:'future', role:'fixture-b', by:'fixture-a', expectReply:true, digest:'shared'},
    {kind:'mail-read', mailId:'future', role:'fixture-b', by:'intruder'},
    {kind:'send', mailId:'collision', role:'fixture-b', by:'fixture-a', digest:'shared'},
    {kind:'send', mailId:'ambiguous', role:'fixture-a', by:'fixture-b', replyTo:'shared', replyFinal:true},
    {kind:'send', mailId:'answer', role:'fixture-a', by:'fixture-b', replyTo:'future', replyFinal:true},
    {kind:'mail-cancel', mailId:'future', role:'fixture-b', by:'fixture-a'},
    {kind:'mail-read', mailId:'future', role:'fixture-b', by:'fixture-b'},
    {kind:'send', role:'fixture-c', by:'fixture-a', digest:'without-id'},
    {kind:'send', mailId:'cancelled', role:'fixture-c', by:'fixture-a', expectReply:true, deliveredRead:true},
    {kind:'mail-cancel', mailId:'cancelled', role:'fixture-c', by:'사람'},
    {kind:'send', mailId:'late', role:'fixture-a', by:'fixture-c', replyTo:'cancelled', replyFinal:true},
  ]);
  equal(home);
  const letters = all(home), first = letters.find(m => m.mailId === 'future');
  assert.equal(first.finalReplyId, 'answer');assert.equal(first.readKind, 'recipient-ack');
  assert.equal(letters.find(m => m.mailId === 'cancelled').replyStatus, 'cancelled');
  assert.equal(letters.find(m => m.digest === 'without-id').read, null);
});

test('수신·발신 인계, 늦은 답장과 같은 인계의 재등장을 보존한다', () => {
  const home = homeOf();
  add(home, {kind:'send', mailId:'question', role:'fixture-b', by:'fixture-a', expectReply:true});
  equal(home);
  for (const event of [
    {kind:'handover', phase:'transferred', from:'fixture-a', to:'fixture-next-a', handoverId:'a'},
    {kind:'handover', phase:'transferred', from:'fixture-b', to:'fixture-next-b', handoverId:'b'},
    {kind:'send', mailId:'old-name', role:'fixture-b', by:'fixture-a'},
    {kind:'handover', phase:'transferred', from:'fixture-b', to:'fixture-next-b', handoverId:'b'},
    {kind:'send', mailId:'answer', role:'fixture-a', by:'fixture-next-b', replyTo:'question', replyFinal:true},
  ]) {add(home, event);equal(home);}
  const letters = all(home);
  assert.equal(letters.find(m => m.mailId === 'old-name').currentRecipient, 'fixture-b');
  assert.equal(letters.find(m => m.mailId === 'answer').currentRecipient, 'fixture-next-a');
  assert.deepEqual(letters[0].replyRecipients, ['fixture-a', 'fixture-next-a']);
  assert.equal(letters[0].replyStatus, 'answered');
});

test('오래된 미확인·세대 이어가기·첫 sent 예외와 알림 전용 상태가 같다', () => {
  const home = homeOf(), role = 'fixture-worker', session = 'kadan-fixture-worker';
  const send = (id, fields = {}) => ({kind:'send', mailId:id, role, by:'fixture-lead', transport:'mailbox', ...fields});
  const events = [
    {kind:'start', role, session, panePid:1, t:'2026-01-01T00:00:00Z'},
    send('old'), send('stored', {mailRule:1}), send('before', {mailRule:1}),
    send('direct', {mailRule:1, keyDelivery:'sent', t:'2026-01-01T00:00:00Z'}),
    send('notice', {notificationOnly:true}),
    {kind:'watch-mail-reminder', mailId:'before', role, action:'result', delivery:'sent', t:'2026-01-01T01:00:00Z'},
    {kind:'stop', role, session},
    {kind:'start', role, session, panePid:2, t:'2026-01-02T00:00:00Z'},
    {kind:'watch-mail-reminder', mailId:'stored', role, action:'result', delivery:'sent', t:'2026-01-02T01:00:00Z'},
    {kind:'watch-mail-reminder', mailId:'before', role, action:'result', delivery:'sent', t:'2026-01-03T00:00:00Z'},
    {kind:'start', role, session, panePid:3, inheritMail:true, t:'2026-01-04T00:00:00Z'},
  ];
  for (const event of events) {add(home, event);equal(home);}
  const letters = all(home);
  assert.equal(letters.find(m => m.mailId === 'old').previousGeneration, true);
  assert.equal(letters.find(m => m.mailId === 'stored').previousGeneration, false);
  assert.equal(letters.find(m => m.mailId === 'before').previousGeneration, true);
  assert.equal(letters.find(m => m.mailId === 'direct').previousGeneration, true);
});

test('완료 우편·원발령·작업 인계를 기존 완료 검사기로 판정한다', () => {
  const home = homeOf();
  add(home, {kind:'send', mailId:'request', role:'fixture-worker', by:'fixture-lead',
    taskId:'task', executionKey:'repo/task', workKey:'work/main', expectReply:true});
  equal(home);
  add(home, {kind:'handover', phase:'transferred', from:'fixture-worker', to:'fixture-next',
    taskIds:['repo/task'], handoverId:'transfer'});
  add(home, {kind:'done', role:'fixture-next', taskId:'task', executionKey:'repo/task',
    workKey:'work/main', result:'ok'});
  equal(home);
  const letters = all(home);
  assert.equal(letters[0].replyStatus, 'answered');assert.equal(letters[1].systemGenerated, 'task-completion');
});

test('다른 프로세스에서 새 부분만 적용하고 실패/강제 종료는 위치와 상태를 되돌린다', () => {
  const home = homeOf();
  add(home, {kind:'send', mailId:'request', role:'fixture-b', by:'fixture-a', expectReply:true});
  const before = readMailboxViewPage(home);
  add(home, {kind:'mail-read', mailId:'request', role:'fixture-b', by:'fixture-b'});
  assert.throws(() => withMailboxView(home, () => {throw new Error('caller failed');}), /caller failed/);
  const script = `import {readMailboxViewPage} from './src/mail-view.mjs';
    console.log(JSON.stringify(readMailboxViewPage(process.argv[1])));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, home],
    {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8'});
  assert.equal(child.status, 0, child.stderr);
  const after = JSON.parse(child.stdout);
  assert.equal(after.mailGeneration, before.mailGeneration);assert.equal(after.mailApplied, 1);
  assert.equal(after.items[0].read, true);
  add(home, {kind:'mail-cancel', mailId:'request', role:'fixture-b', by:'fixture-a'});
  const crash = `import {DatabaseSync} from 'node:sqlite';import {readMailboxViewPage} from './src/mail-view.mjs';
    const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){
      if(sql==='COMMIT'&&this.prepare('PRAGMA application_id').get().application_id===1262767154)
        process.kill(process.pid,'SIGKILL');return exec.call(this,sql);};readMailboxViewPage(process.argv[1]);`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', crash, home],
    {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8', timeout:10000});
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const resumed = readMailboxViewPage(home);
  assert.equal(resumed.mailApplied, 1);assert.equal(resumed.items[0].replyStatus, 'cancelled');equal(home);
});

test('원본 교체·캐시 행 누락·사용자 이름 설정 변경은 재생하고 원본은 보존한다', () => {
  const home = homeOf();
  add(home, {kind:'send', mailId:'request', role:'fixture-b', by:'fixture-a'});
  add(home, {kind:'mail-read', mailId:'request', role:'fixture-b', by:'fixture-user'});
  const original = process.env.KADAN_USER_NAMES;
  try {
    process.env.KADAN_USER_NAMES = '';
    const before = readMailboxViewPage(home);assert.equal(before.items[0].read, false);
    process.env.KADAN_USER_NAMES = 'fixture-user';
    const after = readMailboxViewPage(home);assert.equal(after.items[0].read, true);
    assert.notEqual(before.mailGeneration, after.mailGeneration);
  } finally {
    if (original === undefined) delete process.env.KADAN_USER_NAMES;else process.env.KADAN_USER_NAMES = original;
  }
  const db = new DatabaseSync(ledgerViewPath(home));
  db.exec('DELETE FROM mail_current');db.close();
  const script = `import {readMailboxViewPage} from './src/mail-view.mjs';
    console.log(JSON.stringify(readMailboxViewPage(process.argv[1])));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, home],
    {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8'});
  assert.equal(child.status, 0, child.stderr);assert.equal(JSON.parse(child.stdout).mailRebuilt, true);
  const other = homeOf();add(other, {kind:'send', mailId:'other', role:'fixture-c', by:'fixture-a'});
  fs.renameSync(storagePath(home), path.join(home, 'preserved.sqlite'));
  fs.copyFileSync(storagePath(other), storagePath(home));
  assert.equal(readMailboxViewPage(home).items[0].mailId, 'other');equal(home);
});

test('없는 홈·중복 우편·손상된 인계는 기존처럼 빈 상태 또는 오류다', () => {
  const absent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mail-empty-')), 'absent');
  assert.deepEqual(readMailboxViewPage(absent).items, []);assert.equal(fs.existsSync(absent), false);
  const home = homeOf();legacy(home, [{kind:'send', mailId:'dup'}, {kind:'send', mailId:'dup'}]);
  assert.throws(() => readMailboxViewPage(home), /중복 mailId/);
  const other = homeOf();
  for (const to of ['fixture-b', 'fixture-c']) add(other,
    {kind:'handover', phase:'transferred', from:'fixture-a', to, handoverId:'dup'});
  assert.throws(() => readMailboxViewPage(other), /인계 책임 충돌/);
});

test('세대는 저장 순번·가장 늦은 경계 시각·전체 횟수를 별개로 보존한다', () => {
  const generations = createMailGenerations(), role = 'fixture-worker', session = 'kadan-fixture-worker';
  assert.equal(generations.isPrevious(role, -100), false);
  assert.equal(generations.resumedAfter(role, -100), false);
  generations.apply({kind:'start', role, session, panePid:1, t:'2026-01-01'}, 0);
  generations.apply({kind:'start', role, session, panePid:2, t:'2026-01-05'}, 1);
  generations.apply({kind:'start', role, session, panePid:3, t:'invalid'}, 2);
  generations.apply({kind:'start', role, session, panePid:4, t:'2026-01-02'}, 3);
  assert.equal(generations.generationOf(role), 3);
  assert.equal(generations.isPrevious(role, 2), true);
  assert.equal(generations.isPreviousAt(role, '2026-01-04'), true);
  assert.equal(generations.isPreviousAt(role, '2026-01-06'), false);
});

test('아직 없는 우편의 읽음과 자기 답장 참조 충돌은 상태를 바꾸지 않는다', () => {
  const home = homeOf();
  legacy(home, [
    false, 0,
    {kind:'mail-read', mailId:'future', role:'fixture-b', by:'fixture-b'},
    {kind:'send', mailId:'future', role:'fixture-b', by:'fixture-a', expectReply:true},
    {kind:'send', mailId:'answer', digest:'future', role:'fixture-a', by:'fixture-b',
      replyTo:'future', replyFinal:true},
  ]);
  assert.deepEqual(all(home), mailboxLetters(readLedger(home)));
  assert.equal(all(home)[0].read, false);assert.equal(all(home)[0].replyStatus, 'waiting');
  assert.throws(() => readMailboxViewPage(home, {domain:'mailbox'}), /과거 원장 손상/);
});

test('동시 첫 우편 조회도 한 번만 적용하고 같은 상태를 반환한다', async () => {
  const home = homeOf();
  add(home, {kind:'send', mailId:'request', role:'fixture-b', by:'fixture-a', expectReply:true});
  add(home, {kind:'mail-read', mailId:'request', role:'fixture-b', by:'fixture-b'});
  const run = () => new Promise((resolve, reject) => {
    const script = `import {readMailboxViewPage} from './src/mail-view.mjs';
      console.log(JSON.stringify(readMailboxViewPage(process.argv[1])));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, home],
      {cwd:path.resolve(import.meta.dirname, '..'), stdio:['ignore', 'pipe', 'pipe']});
    let output = '', error = '';
    child.stdout.on('data', data => output += data);child.stderr.on('data', data => error += data);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  });
  const results = await Promise.all([run(), run(), run()]);
  assert.equal(new Set(results.map(result => result.mailGeneration)).size, 1);
  assert.equal(results.reduce((sum, result) => sum + result.mailApplied, 0), 2);
  assert.ok(results.every(result => result.items[0].read));equal(home);
});

test('답변 대기·미확인 재알림 조회는 영역 전체가 아니라 색인으로 읽는다', () => {
  const home = homeOf();
  for (let n = 0; n < 20; n++) add(home, {kind:'send', mailId:`old-${n}`, role:'r', by:'lead', expectReply:true, deliveredRead:true});
  add(home, {kind:'send', mailId:'open', role:'r', by:'lead', expectReply:true});
  withMailboxView(home, store => {
    const plans = [];
    const original = store.prepare.bind(store);
    store.prepare = sql => {
      if (/FROM mail_current m/u.test(sql)) plans.push(original(`EXPLAIN QUERY PLAN ${sql}`).all(store.scope).map(row => row.detail).join(' '));
      return original(sql);
    };
    assert.equal(mailWaitingLetters(store).length, 21);
    assert.ok(mailReminderCandidates(store).length >= 1);
    assert.equal(plans.length, 2);
    assert.match(plans[0] + plans[1], /INDEX mail_read/u);
    assert.match(plans[0] + plans[1], /INDEX mail_reply/u);
    for (const plan of plans) assert.doesNotMatch(plan, /SEARCH m USING PRIMARY KEY/u);
  });
});
