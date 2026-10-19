import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendLedger, readLedger } from '../src/ledger.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { MailWatch } from '../src/watch-mail.mjs';
import { parseHierarchy } from '../src/hierarchy.mjs';
import { peerResponsibilities } from '../src/peer-mail.mjs';
import { buildSupervisorScope } from '../src/watch-scope.mjs';
import { assessSupervisorIdle } from '../src/watch-supervisor.mjs';
import { createDatabase, writeStorageMarker } from '../src/storage.mjs';
import { WorkStore } from '../src/work-store.mjs';

const table = { 'r-super':'@user', 'r-boss':'r-super', 'r-worker':'r-boss',
  'k-super':'@user', 'k-boss':'k-super', 'k-worker':'k-boss' };
const parents = parseHierarchy(table), t = '2026-10-13T00:00:00Z';
const q = { kind:'send', mailId:'q1', by:'r-super', role:'k-super', t,
  expectReply:true, workKey:'r/w1', transport:'mailbox' };
const work = { key:'r/w1', status:'open', owner:'r-boss', executions:[], at:t };
const state = unchangedMs => ({ alive:true, digest:'same', unchangedMs });
const states = () => new Map(Object.keys(table).map(r => [`kadan-${r}`, state(40 * 60_000)]));
const idle = (entries, works = [work], cards = [], roleStates = states(), waits = []) =>
  assessSupervisorIdle([], roleStates, Date.parse(t) + 40 * 60_000, 15 * 60_000, null,
    parents, { works, cards, waits:[{ ids:['work:r/w1'], answerer:'k-super' }, ...waits], peerEntries:entries });

for (const command of ['send', 'mail']) {
test(`실제 ${command} CLI: 슈퍼끼리는 소켓 접속 없이 저장하고 최종 답장으로 질문을 끝낸다`, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-peer-mail-'));
  const file = path.join(home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify(table));
  appendLedger({ kind:'hierarchy-loaded', path:file }, home);
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const send = (by, args) => spawnSync(process.execPath, [cli, command, ...args], {
    env:{...process.env, KADAN_HOME:home, KADAN_ROLE:by, KADAN_FLOOR:'herdr',
      KADAN_HERDR_SOCKET:path.join(home, 'nonexistent.sock'), KADAN_NOTIFY:'off'}, encoding:'utf8',
  });
  const first = send('r-super', ['k-super', '--expect-reply', '카단 오류 확인 요청']);
  assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout);
  assert.equal(receipt.status, 'stored');
  assert.equal(receipt.wake, 'watch-required');
  const receiver = new Mailbox(home, 'k-super');
  receiver.acknowledge(receipt.mailId, 'k-super');
  assert.equal(receiver.read(receipt.mailId).replyStatus, 'waiting');
  const intermediate = send('k-super', ['r-super', '--reply-to', receipt.mailId, '확인 중']);
  assert.equal(intermediate.status, 0, intermediate.stderr);
  assert.equal(receiver.read(receipt.mailId).replyStatus, 'waiting');
  assert.equal(peerResponsibilities(readLedger(home), parents).length, 1);
  const reply = send('k-super', ['r-super', '--reply-to', receipt.mailId, '--reply-final', '수정 결과와 확인 근거']);
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(receiver.read(receipt.mailId).replyStatus, 'answered');
  assert.deepEqual(peerResponsibilities(readLedger(home), parents), []);
  assert.equal(readLedger(home).filter(e => e.kind === 'send').length, 3);
  assert.ok(readLedger(home).filter(e => e.kind === 'send').every(e => e.transport === 'mailbox'));
  assert.equal(send('r-super', ['k-super', '--raw', '우회']).status, 1);
});

}

for (const backend of ['jsonl', 'sqlite']) {
  test(`${backend}: 기본 mail은 읽음·수신 업무 완료 뒤에도 회신 대기나 누락 경보를 만들지 않는다`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-peer-policy-'));
    if (backend === 'sqlite') {
      createDatabase(home);
      writeStorageMarker(home, 'sqlite');
    }
    const file = path.join(home, 'hierarchy.json');
    fs.writeFileSync(file, JSON.stringify(table));
    appendLedger({kind: 'hierarchy-loaded', path: file}, home);
    const store = new WorkStore(home);
    const create = (key, owner) => store.create({key, owner, repoPath: home,
      title: '격리 업무', goal: '위임한 문제 처리', scope: '우편 정책', acceptance: '처리 근거 확인'});
    const original = create('r/w1', 'r-boss');
    let linked = create('k/w2', 'k-boss');
    const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
    const call = (by, ...args) => spawnSync(process.execPath, [cli, ...args], {
      env: {...process.env, KADAN_HOME: home, KADAN_ROLE: by, KADAN_FLOOR: 'herdr',
        KADAN_HERDR_SOCKET: path.join(home, 'nonexistent.sock'), KADAN_NOTIFY: 'off'},
      encoding: 'utf8', input: '', timeout: 10000,
    });
    const result = call('r-super', 'mail', 'k-super', '--work', original.key, '문제 처리 맥락');
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'stored');
    assert.equal(receipt.wake, 'watch-required');
    const receiver = new Mailbox(home, 'k-super');
    const sender = new Mailbox(home, 'r-super');
    const check = () => {
      const letter = receiver.read(receipt.mailId);
      assert.equal(letter.expectReply, false);
      assert.equal(letter.replyStatus, 'not-requested');
      assert.deepEqual(sender.list({view: 'waiting'}), []);
      assert.deepEqual(receiver.list({view: 'to-reply'}), []);
      const entries = readLedger(home), works = store.list();
      assert.deepEqual(peerResponsibilities(entries, parents, works), []);
      assert.deepEqual([...buildSupervisorScope([], entries, parents, works).sessions], []);
      // 수신 측의 실제 열린 업무 책임과 회신 누락 책임을 구분한다.
      assert.ok(idle(entries, works).every(alert => alert.role === 'k-boss'));
      assert.deepEqual(store.get(original.key), original);
      const sent = entries.find(entry => entry.mailId === receipt.mailId);
      assert.equal(sent.transport, 'mailbox');
      assert.equal(sent.taskId, undefined);
    };
    check();
    const ack = call('k-super', 'inbox', 'ack', receipt.mailId);
    assert.equal(ack.status, 0, ack.stderr);
    assert.equal(receiver.read(receipt.mailId).read, true);
    check();
    linked = store.change(linked.key, 'mail', {mail: receipt.mailId}, {
      revision: linked.revision, by: 'k-boss', note: '수신 측 처리 업무 연결',
    });
    check();
    store.change(linked.key, 'complete', {result: '수신 감독이 처리 결과 확인'}, {
      revision: linked.revision, by: 'k-boss', note: '위임한 일 완료',
    });
    check();
    assert.deepEqual(idle(readLedger(home), store.list()), []);
    assert.equal(readLedger(home).filter(entry => entry.kind === 'send').length, 1);
  });
}

test('읽고 멈춘 동료 요청은 실행 발령 전에도 수신 슈퍼의 감시 대상이다', () => {
  const entries = [q, {kind:'mail-read', mailId:q.mailId, role:'k-super', by:'k-super', t}];
  const scope = buildSupervisorScope([], entries, parents, [work]);
  assert.ok(scope.sessions.has('kadan-k-super'));
  assert.deepEqual(idle(entries).map(a => a.role), ['k-super']);
  assert.equal(peerResponsibilities(entries, parents, [work]).length, 1);
});

test('미연결 질문도 놓치지 않으며 최종 답변·취소 뒤에는 책임이 사라진다', () => {
  const plain = {...q, workKey:undefined};
  assert.equal(peerResponsibilities([plain], parents).length, 1);
  for (const end of [
    {kind:'send', mailId:'a1', by:'k-super', role:'r-super', replyTo:'q1', replyFinal:true},
    {kind:'mail-cancel', mailId:'q1', by:'r-super', role:'k-super'},
  ]) assert.deepEqual(peerResponsibilities([plain, end], parents), []);
  assert.deepEqual(peerResponsibilities([{...q, by:'r-worker'}], parents), []);
});

test('섞인 우편에서는 일반 위임·종료한 질문을 빼고 waiting 질문만 책임으로 계산한다', () => {
  const entries = [
    {...q, mailId: 'plain', expectReply: false, workKey: undefined},
    {...q, mailId: 'answered', workKey: undefined},
    {kind: 'send', mailId: 'final', by: 'k-super', role: 'r-super',
      replyTo: 'answered', replyFinal: true},
    {...q, mailId: 'cancelled', workKey: undefined},
    {kind: 'mail-cancel', mailId: 'cancelled', by: 'r-super', role: 'k-super'},
    {...q, mailId: 'waiting', workKey: undefined},
  ];
  assert.deepEqual(peerResponsibilities(entries, parents).map(request => request.mailId), ['waiting']);
});

test('수신 업무를 연결하면 하위 진행과 답변 대기를 존중하고 결과 후 회신 누락은 잡는다', () => {
  const card = {key:'k/c1', id:'c1', status:'assigned', role:'k-worker'};
  const linked = {key:'k/w2', owner:'k-boss', status:'open', at:t,
    mailRefs:['q1'], executions:[{key:'k/c1'}]};
  const moving = states(); moving.set('kadan-k-worker', state(0));
  assert.equal(idle([q], [work, linked], [card], moving).length, 0);
  const waits = [{ids:['work:k/w2'], answerer:'@user'}];
  assert.equal(idle([q], [work, linked], [card], states(), waits).length, 0);
  const after = idle([q], [work, {...linked, status:'done'}], [{...card, status:'done'}]);
  assert.ok(after.some(a => a.role === 'k-super'));
  assert.equal(peerResponsibilities([q], parents, [work, {...linked, status:'hold'}]).length, 0);
});

test('보관한 슈퍼 우편은 5분을 더 기다리지 않되 입력 보호를 통과한 뒤 한 번 알린다', () => {
  const entries = [{kind:'start', role:'k-super', session:'kadan-k-super', panePid:1, t}, q];
  let held = true; const sent = [];
  const watcher = new MailWatch({record:e => entries.push(e), send:(...args) => sent.push(args),
    hold:() => held ? {code:'KADAN_HUMAN_ACTIVE', message:'입력 중'} : null});
  const tick = () => watcher.tick({entries:[...entries], cards:[], works:[work], now:Date.parse(t) + 1000,
    parents, floor:{list:() => [{session:'kadan-k-super', pid:1}]}, readEntries:() => [...entries],
    readCards:() => [], readWorks:() => [work]});
  tick(); assert.equal(sent.length, 0);
  held = false; tick(); tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /inbox/);
});

import { isStorableMailHold } from '../src/notification-guard.mjs';

test('일반 mail 보관 조건: 사람 입력·복사 모드 보류(붙이기 전)만 해당', () => {
  const hold = (code, delivery = 'not-sent') => Object.assign(new Error('x'), { code, delivery });
  assert.equal(isStorableMailHold(hold('KADAN_HUMAN_ACTIVE')), true);
  assert.equal(isStorableMailHold(hold('KADAN_PANE_IN_MODE')), true);
  for (const code of ['KADAN_MAIL_RECIPIENT_CHANGED', 'KADAN_HUMAN_ACTIVITY_UNKNOWN', 'KADAN_PANE_STATE_UNKNOWN', undefined])
    assert.equal(isStorableMailHold(hold(code)), false, String(code));
  for (const delivery of ['sent', 'unknown', null])
    assert.equal(isStorableMailHold(hold('KADAN_HUMAN_ACTIVE', delivery)), false, String(delivery));
});

test('일반 mail은 세션 없음·--raw·발령이면 보관하지 않고 그대로 실패한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mail-nostore-'));
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const run = args => spawnSync(process.execPath, [cli, ...args], {
    env:{...process.env, KADAN_HOME:home, KADAN_ROLE:'r-boss', KADAN_FLOOR:'herdr',
      KADAN_HERDR_SOCKET:path.join(home, 'nonexistent.sock'), KADAN_NOTIFY:'off'}, encoding:'utf8',
  });
  for (const args of [['mail', 'r-worker', '세션 없음'], ['mail', 'r-worker', '--raw', '원문'],
    ['send', 'r-worker', '세션 없음'], ['dispatch', 'r-worker', '--task', 'x', '발령']])
    assert.notEqual(run(args).status, 0, args.join(' '));
  assert.equal(readLedger(home).filter(e => e.kind === 'send').length, 0);
});
