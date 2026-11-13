// 우편 전송 길 전용 원장 읽기(readSendLedger)와 업무 최신 판 목록(listLatest)이 기존 읽기와 같은 판정 재료를 내는지.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {appendLedger, readLedger, readSendLedger, SEND_UNUSED_KINDS} from '../src/ledger.mjs';
import {SLIM_DROPPABLE} from '../src/ledger-domains.mjs';
import {Mailbox, mailboxLetters} from '../src/mailbox.mjs';
import {WorkStore} from '../src/work-store.mjs';

const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-send-read-'));
const start = (home, role, panePid, extra = {}) => appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid, ...extra}, home);
// 전송 길이 읽지 않는 감시 사건 여섯 종류와, 읽는 감시 사건(우편 재알림·보류)을 섞어 넣는다. 큰 본문 필드도 채운다.
function seedWatch(home, tag, mailId) {
  appendLedger({kind: 'watch-cycle', by: 'watch', cycle: tag, timing: {steps: [{name: 'a', ms: 1}, {name: 'b', ms: 2}]}}, home);
  appendLedger({kind: 'watch-scope', by: 'watch', scope: {roles: ['a', 'b']}}, home);
  appendLedger({kind: 'watch-ai-request', by: 'watch', protocol: 2, requestId: `req-${tag}`, key: `progress:${tag}`,
    parents: {b: 'a'}, routes: {b: ['a']}}, home);
  appendLedger({kind: 'watch-ai-call', by: 'watch', requestId: `req-${tag}`, reason: 'report-missing'}, home);
  appendLedger({kind: 'watch-ai-report', by: 'watch-ai', requestId: `req-${tag}`, key: `progress:${tag}`, verdict: 'normal', accepted: true}, home);
  appendLedger({kind: 'watch-ai-retired', by: 'watch', requestId: `req-${tag}`, key: `progress:${tag}`}, home);
  appendLedger({kind: 'watch-mail-held', by: 'watch', role: 'b', reason: 'busy', timing: {waitedMs: 5}}, home);
  if (mailId) appendLedger({kind: 'watch-mail-reminder', by: 'watch', action: 'result', delivery: 'sent', mailId, role: 'b'}, home);
}
function fixture() {
  const home = freshHome();
  start(home, 'a', 1001); start(home, 'b', 1002);
  seedWatch(home, '1');
  const asked = new Mailbox(home, 'b').send({by: 'a', message: '보관될 질문?', category: 'request', expectReply: true});
  seedWatch(home, '2', asked.mailId);
  appendLedger({kind: 'stop', role: 'b', session: 'kadan-b', by: '사람'}, home);
  start(home, 'b', 2002, {conversationMode: 'new'});
  appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'h1', from: 'a', to: 'c', by: 'a'}, home);
  seedWatch(home, '3');
  new Mailbox(home, 'c').send({by: 'b', message: '답', category: 'report', replyTo: asked.mailId});
  appendLedger({kind: 'alert', by: 'watch', alertKind: 'quiet', role: 'b'}, home);
  return {home, asked};
}

test('readSendLedger: 감시 사건 여섯 종류만 빠지고 나머지 줄은 readLedger와 같은 내용·같은 순서다', () => {
  const {home} = fixture();
  const full = readLedger(home), narrow = readSendLedger(home);
  const dropped = full.filter(entry => SEND_UNUSED_KINDS.includes(entry.kind));
  assert.deepEqual([...new Set(dropped.map(entry => entry.kind))].sort(), [...SEND_UNUSED_KINDS].sort(), '고정 자료에 여섯 종류가 모두 있다');
  assert.equal(narrow.length, full.length - dropped.length);
  // 남은 감시 사건은 큰 본문 필드(허용 목록)만 없고 나머지 값은 같다. 감시 사건이 아닌 줄은 완전히 같다.
  const expected = full.filter(entry => !SEND_UNUSED_KINDS.includes(entry.kind)).map(entry => {
    if (!entry.kind?.startsWith('watch-')) return entry;
    const slim = {...entry};
    for (const key of SLIM_DROPPABLE) delete slim[key];
    return slim;
  });
  assert.deepEqual(narrow, expected);
  for (const kind of ['watch-mail-reminder', 'watch-mail-held', 'start', 'stop', 'send', 'handover', 'alert']) {
    assert.ok(narrow.some(entry => entry.kind === kind), `${kind} 줄이 남는다`);
  }
});

test('우편함 계산은 두 읽기에서 같은 결과를 낸다(재알림 뒤 재시작·인계가 섞인 자료)', () => {
  const {home, asked} = fixture();
  const full = readLedger(home), narrow = readSendLedger(home);
  assert.deepEqual(mailboxLetters(narrow), mailboxLetters(full));
  for (const role of ['a', 'b', 'c']) assert.deepEqual(mailboxLetters(narrow, role), mailboxLetters(full, role), role);
  const letter = mailboxLetters(narrow).find(item => item.mailId === asked.mailId);
  assert.equal(letter.currentSender, 'c', '인계 뒤 답장 받을 쪽');
});

test('원장 손상은 두 읽기가 똑같이 막는다 — 버리는 종류의 줄이 손상돼도', () => {
  const {home} = fixture();
  const db = new DatabaseSync(path.join(home, 'kadan.sqlite'));
  try {
    const seq = db.prepare("SELECT max(seq) AS seq FROM events WHERE stream='system/events.jsonl'").get().seq;
    const order = db.prepare("SELECT max(json_extract(payload,'$._ledgerOrder')) AS o FROM events").get().o;
    db.prepare('INSERT INTO events(stream, seq, payload) VALUES (?,?,?)').run('system/events.jsonl', seq + 1,
      JSON.stringify({t: new Date().toISOString(), kind: 'watch-cycle', by: 'watch', _ledgerOrder: order + 5}));
  } finally { db.close(); }
  const message = read => { try { read(home); return null; } catch (error) { return error.message; } };
  assert.equal(message(readLedger), '도메인 원장 순번 누락');
  assert.equal(message(readSendLedger), '도메인 원장 순번 누락');
});

// 전송 길에서 원장 줄을 넘겨받는 모듈들. 여기서 뺀 종류를 읽기 시작하면 readSendLedger가 조용히 틀린 판정 재료를 준다.
const SEND_PATH_CONSUMERS = ['commands/send.mjs', 'cli-guarded-send.mjs', 'work-mail.mjs', 'mailbox.mjs', 'mailbox-state.mjs',
  'mail-generation.mjs', 'mail-rule.mjs', 'mail-routing.mjs', 'handover-state.mjs', 'card-store.mjs', 'session-ownership.mjs',
  'reopen.mjs', 'conductor-load-hint.mjs', 'peer-mail.mjs', 'hierarchy-register.mjs', 'cli-basics.mjs', 'cli-start-support.mjs',
  'task-identity.mjs', 'role-instructions.mjs', 'cli-family.mjs', 'ai-identity.mjs', 'dispatch-runner-guard.mjs', 'super-role.mjs',
  'mail-turn-return.mjs'];
test('전송 길의 소비 모듈은 뺀 감시 사건 종류를 읽지 않는다', () => {
  const src = new URL('../src/', import.meta.url);
  for (const file of SEND_PATH_CONSUMERS) {
    const text = fs.readFileSync(new URL(file, src), 'utf8');
    for (const kind of SEND_UNUSED_KINDS) {
      assert.ok(!new RegExp(`['"\`]${kind}['"\`]`).test(text),
        `${file}가 ${kind}를 읽는다 — src/ledger.mjs의 SEND_UNUSED_KINDS에서 빼거나 이 모듈이 readLedger를 쓰게 하세요`);
    }
    assert.ok(!/startsWith\(\s*['"]watch-/.test(text), `${file}가 감시 사건을 앞머리로 고른다 — SEND_UNUSED_KINDS와 겹치는지 확인하세요`);
  }
});

test('WorkStore.listLatest: list와 같은 업무·같은 순서이고 history만 없다. 이력 손상은 똑같이 막는다', () => {
  const home = freshHome(), repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-send-read-repo-'));
  const store = new WorkStore(home);
  for (const id of ['w2', 'w1']) {
    store.create({key: `demo/${id}`, title: `업무 ${id}`, goal: '결과', scope: '범위', acceptance: '조건', owner: 'a', repoPath});
  }
  const first = store.get('demo/w1');
  store.change('demo/w1', 'update', {progress: '진행 1'}, {revision: first.revision, by: 'a', note: '메모'});
  const full = store.list(), latest = store.listLatest();
  assert.ok(full.find(work => work.key === 'demo/w1').history.length >= 2);
  assert.deepEqual(latest, full.map(({history, ...work}) => work));
  assert.ok(latest.every(work => !Object.hasOwn(work, 'history')));
  // 이력의 revision이 어긋난 줄을 넣으면 두 목록 모두 같은 오류로 멈춘다.
  const db = new DatabaseSync(path.join(home, 'kadan.sqlite'));
  try {
    const stream = 'works/demo/w2/events.jsonl';
    const row = db.prepare('SELECT max(seq) AS seq, payload FROM events WHERE stream=?').get(stream);
    db.prepare('INSERT INTO events(stream, seq, payload) VALUES (?,?,?)').run(stream, row.seq + 1,
      JSON.stringify({...JSON.parse(row.payload), revision: 9}));
  } finally { db.close(); }
  assert.throws(() => store.list(), /업무 이력 손상/);
  assert.throws(() => store.listLatest(), /업무 이력 손상/);
});
