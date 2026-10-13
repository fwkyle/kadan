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

test('실제 send CLI: 슈퍼끼리는 소켓 접속 없이 저장하고 최종 답장으로 질문을 끝낸다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-peer-mail-'));
  const file = path.join(home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify(table));
  appendLedger({ kind:'hierarchy-loaded', path:file }, home);
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const send = (by, args) => spawnSync(process.execPath, [cli, 'send', ...args], {
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
  const reply = send('k-super', ['r-super', '--reply-to', receipt.mailId, '--reply-final', '수정 결과와 확인 근거']);
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(receiver.read(receipt.mailId).replyStatus, 'answered');
  assert.equal(readLedger(home).filter(e => e.kind === 'send').length, 2);
  assert.ok(readLedger(home).filter(e => e.kind === 'send').every(e => e.transport === 'mailbox'));
  assert.equal(send('r-super', ['k-super', '--raw', '우회']).status, 1);
});

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
