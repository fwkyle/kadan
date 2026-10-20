import test from 'node:test';
import assert from 'node:assert/strict';
import {storedMailLiveWarning} from '../src/commands/send.mjs';

const live = () => true;

test('--mailbox인데 받는 세션이 살아 있으면 경고 문구를 돌려준다',()=>{
  const text=storedMailLiveWarning('worker',{mailbox:true},live);
  assert.match(text,/worker/);assert.match(text,/--mailbox 없이/);
});

test('세션이 없거나 --mailbox가 아니면 경고하지 않는다',()=>{
  assert.equal(storedMailLiveWarning('worker',{mailbox:true},()=>false),null);
  assert.equal(storedMailLiveWarning('worker',{},live),null);
});

test('비서·사람 수신과 세션 조회 실패는 경고하지 않는다',()=>{
  assert.equal(storedMailLiveWarning('비서',{mailbox:true},live),null);
  assert.equal(storedMailLiveWarning('사람',{mailbox:true},live),null);
  assert.equal(storedMailLiveWarning('worker',{mailbox:true},()=>{throw new Error('조회 실패')}),null);
});
