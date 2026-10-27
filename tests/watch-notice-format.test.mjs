// 감시기 알림: 역할 지침을 붙이지 않고 항목 이름을 붙인 본문으로 가며, 이 알림이 일반 우편의 지침 전문·요약 판정을 흐트러뜨리지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardedSend} from '../src/cli.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {sendWatchMessage, sendWatchNudge, sendWatchMailReminder, WATCH_ALERT_FOOTER} from '../src/commands/watch.mjs';

const ROLE = 'kadan-시험판-감독', SESSION = `kadan-${ROLE}`;
const MARK = 'kadan:receiver-instructions';

function fixture() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-notice-'));
  appendLedger({kind: 'start', role: ROLE, session: SESSION, panePid: '100', cmd: 'x', cwd: '/x/Dev/kadan'}, h);
  const state = {messages: [], fail: null};
  const floor = {name: 'fake', alive: () => true, pid: () => '100', send: (_s, m) => {
    state.messages.push(m);
    if (state.fail) { const e = new Error('바닥 전달 실패'); e.delivery = state.fail; throw e; }
    return {keyDelivery: 'sent', inputAcceptance: 'accepted'};
  }};
  const base = {floor, session: SESSION, role: ROLE, recordedPid: '100', env: {KADAN_HOME: h},
    readEntries: () => readLedger(h), record: e => appendLedger(e, h), saveBody: () => {}};
  const mail = (extra = {}) => guardedSend({...base, message: '본문', roleProfile: 'conductor', ...extra});
  const notice = (extra = {}) => guardedSend({...base, message: '알림 본문', source: 'watch',
    notificationOnly: true, omitInstructions: true, ...extra});
  return {h, state, mail, notice};
}

test('omitInstructions: 본문에 역할 지침이 없고 원장에 지침 기록(instructions)이 남지 않는다', () => {
  const t = fixture();
  const entry = t.notice();
  assert.ok(!t.state.messages[0].includes(MARK));
  assert.equal(t.state.messages[0], '알림 본문');
  assert.equal(entry.instructions, undefined);
  assert.equal(entry.roleInstructions.status, 'not-applied');
  assert.equal(entry.roleInstructions.reason, 'watch-notice');
});

test('알림만 있던 역할의 첫 일반 우편은 전문(generation-first)이다 — 알림이 전문을 보낸 것으로 세어지지 않는다', () => {
  const t = fixture();
  t.notice(); t.notice();
  const first = t.mail();
  assert.equal(first.instructions.mode, 'full');
  assert.equal(first.instructions.reason, 'generation-first');
  assert.ok(t.state.messages.at(-1).includes(MARK));
});

test('일반 전문 뒤 알림이 여러 번 가도 다음 일반 우편은 요약(within-interval)이다', () => {
  const t = fixture();
  assert.equal(t.mail().instructions.mode, 'full');
  t.notice(); t.notice(); t.notice();
  const next = t.mail();
  assert.deepEqual([next.instructions.mode, next.instructions.reason], ['summary', 'within-interval']);
});

test('알림 전달이 실패해도 send-failed(전문 시도)를 남기지 않아 다음 일반 우편이 delivery-unclear가 되지 않는다', () => {
  for (const delivery of ['not-sent', 'unknown']) {
    const t = fixture();
    assert.equal(t.mail().instructions.mode, 'full');
    t.state.fail = delivery;
    assert.throws(() => t.notice(), e => e.delivery === delivery);
    t.state.fail = null;
    assert.equal(readLedger(t.h).filter(e => e.kind === 'send-failed').length, 0);
    const next = t.mail();
    assert.deepEqual([next.instructions.mode, next.instructions.reason], ['summary', 'within-interval']);
  }
});

test('감시기 세 전송 길(경보·놀고 있음 본인 알림·미확인 우편)은 지침을 빼고 감시기 보낸이 줄을 붙이지 않는다', () => {
  const calls = [];
  const send = args => { calls.push(args); return {}; };
  const start = () => ({role: ROLE, session: SESSION, panePid: '100'});
  const opts = {send, readStart: start, selectedFloor: {}};
  sendWatchMessage(ROLE, '[감시sh 12:00] 화면이 멈춤 x', opts);
  sendWatchNudge(ROLE, '[감시sh 12:00] 놀고 있음 x', opts);
  sendWatchMailReminder(ROLE, '미확인 우편 1건', '100', opts);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.omitInstructions, true);
    assert.equal(c.notificationOnly, true);
    assert.doesNotMatch(c.message, /보낸이: 감시기/);
  }
  // 이미 할 일 줄이 있으면 덧붙이지 않고, 없으면 경보 안내 한 줄을 덧붙인다.
  assert.equal(calls[0].message, `[감시sh 12:00] 화면이 멈춤 x\n할 일: ${WATCH_ALERT_FOOTER}`);
  assert.equal(calls[1].message, '[감시sh 12:00] 놀고 있음 x');
  sendWatchMessage(ROLE, '[감시sh 12:00] 요약\n할 일: 직접', opts);
  assert.equal(calls[3].message, '[감시sh 12:00] 요약\n할 일: 직접');
});
