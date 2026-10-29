// 우편 머리말 한 줄(`보낸 사람 → 받는 사람 · 업무`) 시험. 가짜 바닥과 격리 홈만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as awaitedCrypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {guardedSend} from '../src/cli.mjs';
import {mailHeaderLine, stripStoredHeader} from '../src/mail-header.mjs';
import {summarizeNight} from '../src/night-summary.mjs';
import {escalationMessage} from '../src/watch-mail.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {appendLedger, readLedger, readMailBody} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-header-'));

function send(h, options = {}) {
  const sent = [], records = [], saved = [];
  const receipt = guardedSend({
    floor: {name: 'fake', alive: () => true, pid: () => '7', send: (name, text) => { sent.push(text); return {}; }},
    session: 'kadan-header-받는', role: 'header-받는', message: '본문입니다', recordedPid: '7',
    roleProfile: 'conductor', env: {KADAN_HOME: h, KADAN_ROLE: 'header-보내는'},
    readEntries: () => [{kind:'start',role:'header-받는',session:'kadan-header-받는',panePid:'7'}],
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

const nightStart = {t: '2026-10-27T00:00:00Z', by: 'qa-night-super'};
const nightArgs = (h, entries) => ({start: nightStart, phase: 'off', endedAt: Date.parse('2026-10-27T08:00:00Z'), entries,
  decisionEvents: [], readBody: d => readMailBody(d, h)});

test('F1: 실제 Mailbox.send로 저장한 보류(머리말 있음)와 머리말 없는 옛 보류가 모두 아침 요약에 남는다', () => {
  const h = home();
  new Mailbox(h, '사람').send({by: 'qa-night-super', message: '[나이트 보류] 운영 DB 마이그레이션'});
  const entries = readLedger(h).map(e => ({...e, t: '2026-10-27T03:00:00Z'}));
  assert.equal(entries[0].header, true);
  // 머리말 표지가 없는 옛 보류 우편: 본문 그대로 저장
  const {createHash} = awaitedCrypto;
  const old = '[나이트 보류] 옛 편지', digest = createHash('sha256').update(old).digest('hex');
  fs.mkdirSync(path.join(h, 'mail'), {recursive: true});
  fs.writeFileSync(path.join(h, 'mail', `${digest}.txt`), old);
  entries.push({kind: 'send', mailId: 'old', role: '사람', by: 'x', digest, t: '2026-10-27T02:00:00Z'});
  const summary = summarizeNight(nightArgs(h, entries));
  assert.equal(summary.counts.held, 2);
});

test('F3: 머리말 제거는 저장 당시 값 기준 — 인계 뒤 currentRecipient가 달라도 같은 미리보기, 표지 없는 손머리말은 보존', t => {
  const h = home(), prior = process.env.KADAN_HOME;
  process.env.KADAN_HOME = h;
  t.after(() => { if (prior === undefined) delete process.env.KADAN_HOME; else process.env.KADAN_HOME = prior; });
  new Mailbox(h, 'f3-old').send({by: 'f3-from', message: '확인할 질문'});
  const [letter] = mailboxLetters(readLedger(h), 'f3-old', {all: true});
  const item = mail => ({mail: {...mail, preview: undefined}, kind: 'unread', minutes: 10});
  const before = escalationMessage([item(letter)]);
  const after = escalationMessage([item({...letter, currentRecipient: 'f3-new'})]);
  assert.match(before, /확인할 질문/); assert.doesNotMatch(before, /f3-from → f3-old/);
  const firstLine = text => text.match(/첫 줄: .*/)[0];
  assert.equal(firstLine(after), firstLine(before)); // 받는이 표시는 인계 뒤 바뀌어도 첫 줄 미리보기는 같다
  const hand = 'a → b\n\n손으로 쓴 머리말';
  assert.equal(stripStoredHeader(hand, {by: 'a', role: 'b'}), hand); // 표지 없음
  assert.equal(stripStoredHeader(hand, {header: true, by: 'a', role: 'b'}), '손으로 쓴 머리말');
  assert.equal(stripStoredHeader(hand, {header: true, by: 'a', role: 'other'}), hand);
});

test('F5: 대시보드 목록 검색용 미리보기는 머리말을 뗀 본문이고 상세 원문(readMailBody)은 그대로다', () => {
  const h = home();
  new Mailbox(h, 'f5-받는').send({by: 'f5-보낸', message: '대시보드 본문'});
  const entry = readLedger(h).find(e => e.kind === 'send');
  const full = readMailBody(entry.digest, h);
  assert.match(full, /^f5-보낸 → f5-받는\n\n대시보드 본문$/);
  assert.equal(stripStoredHeader(full, entry), '대시보드 본문');
});
