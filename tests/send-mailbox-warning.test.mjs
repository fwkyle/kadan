import test from 'node:test';
import assert from 'node:assert/strict';
import {mailboxFlagWarning,isKnownRole,isStoreOnlyRecipient} from '../src/commands/send.mjs';

test('--mailbox는 거절하지 않고 무시하며 바로 넣기 후 자동 보관이라고 알린다',()=>{
  const text=mailboxFlagWarning('worker',{mailbox:true});
  assert.match(text,/--mailbox는 더 이상 쓰지 않습니다/);assert.match(text,/자동으로 보관/);
});

test('--mailbox가 없거나 비서·사람 앞(원래 저장 전용)이면 알리지 않는다',()=>{
  assert.equal(mailboxFlagWarning('worker',{}),null);
  assert.equal(mailboxFlagWarning('비서',{mailbox:true}),null);
  assert.equal(mailboxFlagWarning('사람',{mailbox:true}),null);
  assert.equal(isStoreOnlyRecipient('비서'),true);assert.equal(isStoreOnlyRecipient('사람'),true);
  assert.equal(isStoreOnlyRecipient('worker'),false);
});

test('아는 역할은 시작·종료 기록이 한 번이라도 있거나 계층표에 있는 역할이다',()=>{
  const entries=[{kind:'start',role:'worker',session:'kadan-worker'},{kind:'stop',session:'kadan-gone'}];
  assert.equal(isKnownRole(entries,null,'worker'),true);
  assert.equal(isKnownRole(entries,null,'gone'),true);
  assert.equal(isKnownRole(entries,{boss:'@user',kid:'boss'},'kid'),true);
  assert.equal(isKnownRole(entries,{boss:'@user',kid:'boss'},'boss'),true);
  assert.equal(isKnownRole(entries,{boss:'@user'},'오타'),false);
  assert.equal(isKnownRole(entries,null,'오타'),false);
});
