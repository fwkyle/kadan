import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {peerResponsibilities, isPeerSuperMail} from '../src/peer-mail.mjs';
import {rememberMailboxQueries} from '../src/mailbox-queries.mjs';

const parents = new Map([['fixture-peer-a','@user'], ['fixture-peer-b','@user']]);
const question = n => ({mailId:`q-${n}`, currentSender:'fixture-peer-a',
  currentRecipient:'fixture-peer-b', replyRecipients:[], t:'2026-01-01T00:00:00Z'});

test('같은 수집의 많은 질문도 프로필은 한 번 읽고 다음 호출은 바뀐 입력을 읽는다', () => {
  let reads = 0;
  const profile = {kind:'start', role:'fixture-peer-b', roleProfile:'super'};
  const entries = [{get kind() {reads++;return 'fixture-noise';}}, profile];
  const waiting = Array.from({length:100}, (_, n) => question(n));
  rememberMailboxQueries(entries, {waiting, recent:new Map()});
  assert.deepEqual(peerResponsibilities(entries, parents), waiting.map(q => ({
    kind:'send', role:q.currentRecipient, taskId:`mail:${q.mailId}`, t:q.t, peerRequest:true,
    mailId:q.mailId, asker:q.currentSender, activityRoles:[], linkedWorkIds:[],
  })));
  assert.equal(reads, 1);
  profile.roleProfile = 'worker';
  assert.deepEqual(peerResponsibilities(entries, parents), []);assert.equal(reads, 2);
  assert.equal(isPeerSuperMail(entries, parents, 'fixture-peer-a', 'fixture-peer-b'), false);
  assert.equal(reads, 3);
});

test('거르는 우편과 특별 역할은 프로필을 읽지 않으며 필요한 읽기의 오류는 그대로 낸다', () => {
  const entries = [{get kind() {throw new Error('fixture profile read failed');}}];
  const waiting = [
    {...question(1), notificationOnly:true}, {...question(2), systemGenerated:'task-completion'},
    {...question(3), mailId:null}, {...question(4), currentSender:'@user'},
    {...question(5), currentSender:'fixture-peer-b'},
  ];
  rememberMailboxQueries(entries, {waiting, recent:new Map()});
  assert.deepEqual(peerResponsibilities(entries, parents), []);
  assert.equal(isPeerSuperMail(entries, parents, 'watch', 'fixture-peer-b'), false);
  waiting.push(question(6));
  assert.throws(() => peerResponsibilities(entries, parents), /fixture profile read failed/);
  assert.throws(() => isPeerSuperMail(entries, parents, 'fixture-peer-a', 'fixture-peer-b'),
    /fixture profile read failed/);
});
