// Why: 비서가 감독에게 --expect-reply로 물은 질문은 기존 답 대기 감시에 잡히고, 최종 답변으로만 닫힌다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {waitingLetters} from '../src/mailbox-queries.mjs';
import {composeMailInstructions} from '../src/mail-instructions.mjs';

const at = '2026-01-01T00:00:00Z';
const question = {kind: 'send', role: 'fixture-lead', by: '비서', mailId: 'secretary-question',
  expectReply: true, t: at};
const plain = {kind: 'send', role: '비서', by: 'fixture-lead', mailId: 'plain-reply',
  replyTo: question.mailId, t: at};
const final = {kind: 'send', role: '비서', by: 'fixture-lead', mailId: 'final-reply',
  replyTo: question.mailId, replyFinal: true, t: at};

test('비서가 보낸 --expect-reply 질문은 감독 앞 답 대기로 잡힌다', () => {
  const waits = waitingLetters([question]);
  assert.equal(waits.length, 1);
  assert.equal(waits[0].mailId, question.mailId);
  assert.equal(waits[0].currentRecipient, 'fixture-lead');
  assert.equal(waits[0].currentSender, '비서');
  assert.equal(waits[0].replyStatus, 'waiting');
});

test('일반 답장은 대기를 닫지 않고 최종 답변만 닫는다', () => {
  assert.equal(waitingLetters([question, plain]).length, 1);
  assert.equal(waitingLetters([question, final]).length, 0);
});

test('--expect-reply 없는 맥락 우편은 답 대기가 아니다', () => {
  assert.equal(waitingLetters([{...question, expectReply: undefined}]).length, 0);
});

test('받는 감독의 우편에 질문ID와 최종 답변 명령이 자동으로 붙는다', () => {
  const text = composeMailInstructions({mailId: question.mailId, recipient: 'fixture-lead',
    expectReply: true, sender: '비서', env: {}});
  assert.match(text, /질문ID: secretary-question/);
  assert.match(text, /kadan send .*--reply-to .*secretary-question.* --reply-final/);
});

test('비서 지침에 --expect-reply 질문 규칙이 있다', () => {
  const text = fs.readFileSync(new URL('../skills/kadan-conductor/references/role-templates/secretary.md',
    import.meta.url), 'utf8');
  assert.match(text, /--expect-reply < 파일/);
  assert.match(text, /--reply-final/);
});
