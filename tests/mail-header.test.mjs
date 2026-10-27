// 우편 머리말 한 줄(`보낸 사람 → 받는 사람 · 업무`) 시험. 가짜 바닥과 격리 홈만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardedSend} from '../src/cli.mjs';
import {mailHeaderLine} from '../src/mail-header.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {appendLedger, readLedger, readMailBody} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-header-'));

function send(h, options = {}) {
  const sent = [], records = [], saved = [];
  const receipt = guardedSend({
    floor: {name: 'fake', alive: () => true, pid: () => '7', send: (name, text) => { sent.push(text); return {}; }},
    session: 'kadan-header-받는', role: 'header-받는', message: '본문입니다', recordedPid: '7',
    roleProfile: 'conductor', env: {KADAN_HOME: h, KADAN_ROLE: 'header-보내는'}, readEntries: () => [],
    record: e => records.push(e), saveBody: (d, m) => saved.push(m), ...options,
  });
  return {receipt, text: sent[0], records, saved};
}

test('형식: 업무가 있으면 · 업무키, 없으면 뺀다', () => {
  assert.equal(mailHeaderLine({by: 'a', role: 'b', workKey: 'kadan/w'}), 'a → b · kadan/w\n\n');
  assert.equal(mailHeaderLine({by: 'a', role: 'b'}), 'a → b\n\n');
});

test('일반 우편(업무 없음): 본문 맨 앞에 한 줄, 지침은 본문 뒤', () => {
  const r = send(home());
  assert.ok(r.text.startsWith('header-보내는 → header-받는\n\n본문입니다'));
  assert.ok(r.text.indexOf('kadan:receiver-instructions') > r.text.indexOf('본문입니다'));
  assert.equal(r.saved[0], r.text);
});

test('업무가 있는 우편: 업무키가 붙는다', () => {
  const r = send(home(), {mailContext: {workKey: 'kadan/work-x'}});
  assert.ok(r.text.startsWith('header-보내는 → header-받는 · kadan/work-x\n\n본문입니다'));
});

test('발령(taskId)도 머리말이 붙는다', () => {
  const h = home(), store = new CardStore(h);
  const card = store.create({repo: 'test', id: 'hd', repoPath: h, body: '# 시험'});
  store.update(card.key, {status: 'assigned', role: 'header-받는', board: 'test', scope: '시험', rallyId: 'r',
    rallyTitle: 't', rallyRound: '1', rallyStep: 'implementation'}, {revision: 1, note: '배정'});
  appendLedger({kind: 'start', role: 'header-받는', session: 'kadan-header-받는', panePid: '7', harness: 'codex',
    model: 'test', cmd: 'codex --model test', aiIdentityVerified: true}, h);
  const r = send(h, {taskId: card.id, roleProfile: 'worker', readEntries: () => readLedger(h), env: {KADAN_HOME: h, KADAN_ROLE: 'header-보내는', KADAN_NOTIFY: 'off'}});
  assert.ok(r.text.startsWith('header-보내는 → header-받는'));
});

test('감시기 알림(omitInstructions): 보낸 사람은 watch', () => {
  const r = send(home(), {omitInstructions: true, source: 'watch', notificationOnly: true});
  assert.ok(r.text.startsWith('watch → header-받는\n\n본문입니다'));
});

test('raw: 머리말 없음, 원문 그대로', () => {
  const r = send(home(), {raw: true});
  assert.equal(r.text, '본문입니다');
});

test('preview·bytes는 머리말을 뺀 본문 기준, 전문/요약 판정과 templateDigest는 머리말과 무관', () => {
  const h = home();
  const plain = send(h), work = send(h, {mailContext: {workKey: 'kadan/work-x'}});
  const entry = plain.records.find(e => e.kind === 'send') ?? plain.receipt;
  assert.equal(entry.preview, '본문입니다');
  assert.doesNotMatch(entry.preview, /→/);
  const header = mailHeaderLine({by: 'header-보내는', role: 'header-받는'});
  assert.equal(Buffer.byteLength(plain.text) - Buffer.byteLength(header), entry.bytes);
  assert.equal(plain.receipt.instructions.templateDigest, work.receipt.instructions.templateDigest);
  assert.equal(plain.receipt.instructions.mode, work.receipt.instructions.mode);
  assert.equal(send(h).receipt.instructions.reason, plain.receipt.instructions.reason);
});

test('저장 전용 우편함: 본문에 머리말, bytes는 사용자 본문 기준', () => {
  const h = home();
  const receipt = new Mailbox(h, '비서').send({by: 'header-보내는', message: '저장 본문'});
  const entry = readLedger(h).find(e => e.mailId === receipt.mailId);
  const body = readMailBody(entry.digest, h);
  assert.equal(body, 'header-보내는 → 비서\n\n저장 본문');
  assert.equal(entry.bytes, Buffer.byteLength('저장 본문'));
});
