// 우편함 명령의 좁은 읽기(readMailboxLedgerNarrow·readSendLedgerNarrow)가 전체 읽기(readMailboxLedger·readSendLedger)와
// 같은 줄·같은 순서를 내는지 지문으로 맞춘다. 세대(같은 이름 새 대화·resume·inherit-mail)·인계·답장·중복 거르기·발령 검사를 포함한다.
// 전체 검증을 건너뛰어 잃는 손상 감지와 남기는 손상 감지도 여기서 고정한다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {appendLedger, readLedger, readMailboxLedger, readSendLedger,
  readMailboxLedgerNarrow, readSendLedgerNarrow} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {Mailbox, mailboxLetters} from '../src/mailbox.mjs';
import {CardStore} from '../src/card-store.mjs';
import {inferDispatchTask, resolveWorkMail} from '../src/work-mail.mjs';
import {effectiveCardRole} from '../src/handover-state.mjs';
import {composeRoleInstructions} from '../src/role-instructions.mjs';

const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-narrow-'));
// 지문: 줄의 내용·순서·칸 순서까지 같아야 같다(deepEqual은 칸 순서를 보지 않는다).
const print = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const start = (home, role, panePid, extra = {}) =>
  appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid, ...extra}, home);
const stop = (home, role) => appendLedger({kind: 'stop', role, session: `kadan-${role}`, by: '사람'}, home);
const rally = {rallyId: 'rally', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'implementation'};

// 과거 원문 영역(ledger.jsonl)은 appendLedger로 만들 수 없어 직접 넣는다. 순번(_ledgerOrder) 없는 옛 모양이다.
function insertLegacy(home, rows) {
  const db = new DatabaseSync(path.join(home, 'kadan.sqlite'));
  try {
    const add = db.prepare('INSERT INTO events(stream, seq, payload) VALUES (?,?,?)');
    rows.forEach((row, i) => add.run('ledger.jsonl', i + 1, JSON.stringify(row)));
  } finally { db.close(); }
}
function insertRow(home, stream, value) {
  const db = new DatabaseSync(path.join(home, 'kadan.sqlite'));
  try {
    const seq = db.prepare('SELECT max(seq) AS seq FROM events WHERE stream=?').get(stream).seq ?? 0;
    db.prepare('INSERT INTO events(stream, seq, payload) VALUES (?,?,?)').run(stream, seq + 1, JSON.stringify(value));
  } finally { db.close(); }
}
const lastOrder = home => {
  const db = new DatabaseSync(path.join(home, 'kadan.sqlite'));
  try { return db.prepare("SELECT max(json_extract(payload,'$._ledgerOrder')) AS o FROM events").get().o; }
  finally { db.close(); }
};

function seedWatch(home, tag, mailId, role = 'b') {
  appendLedger({kind: 'watch-cycle', by: 'watch', cycle: tag, timing: {steps: [{name: 'a', ms: 1}]}}, home);
  appendLedger({kind: 'watch-scope', by: 'watch', scope: {roles: ['a', 'b']}}, home);
  appendLedger({kind: 'watch-ai-request', by: 'watch', protocol: 2, requestId: `req-${tag}`, key: `progress:${tag}`,
    parents: {b: 'a'}, routes: {b: ['a']}}, home);
  appendLedger({kind: 'watch-ai-call', by: 'watch', requestId: `req-${tag}`, reason: 'report-missing'}, home);
  appendLedger({kind: 'watch-ai-report', by: 'watch-ai', requestId: `req-${tag}`, key: `progress:${tag}`, verdict: 'normal'}, home);
  appendLedger({kind: 'watch-ai-retired', by: 'watch', requestId: `req-${tag}`, key: `progress:${tag}`}, home);
  appendLedger({kind: 'watch-mail-held', by: 'watch', role, reason: 'busy', timing: {waitedMs: 5}}, home);
  if (mailId) {
    appendLedger({kind: 'watch-mail-reminder', by: 'watch', action: 'result', delivery: 'sent', mailId, role,
      timing: {ms: 3}, extra: '투영에서 빠지는 칸'}, home);
    appendLedger({kind: 'watch-mail-reminder', by: 'watch', action: 'result', delivery: 'not-sent', mailId, role}, home);
    appendLedger({kind: 'watch-mail-reminder', by: 'watch', action: 'result', delivery: 'sent', stage: 'escalate', mailId, role}, home);
    appendLedger({kind: 'watch-mail-reminder', by: 'watch', action: 'result', delivery: 'sent', held: true, mailId, role}, home);
  }
}

// 과거 원문 + 새 영역에 걸친 자료. 반환값의 id들은 아래 시험이 사례를 짚는 데 쓴다.
function fixture() {
  const home = freshHome();
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  insertLegacy(home, [
    {t: '2026-08-01T00:00:00.000Z', kind: 'start', role: 'old', session: 'kadan-old', panePid: 1},
    {t: '2026-08-01T00:01:00.000Z', kind: 'send', role: 'old', by: 'a', mailId: 'legacy-mail-1', digest: 'd1', transport: 'mailbox'},
    {t: '2026-08-01T00:02:00.000Z', kind: 'send', role: 'old', by: 'a', taskId: 'legacy-task', digest: 'd2'},
    {t: '2026-08-01T00:03:00.000Z', kind: 'mail-read', role: 'old', mailId: 'legacy-mail-1', by: 'old'},
    {t: '2026-08-01T00:04:00.000Z', kind: 'done', role: 'old', taskId: 'legacy-task', result: 'ok'},
    {t: '2026-08-01T00:05:00.000Z', kind: 'watch-cycle', by: 'watch', timing: {a: 1}},
    {t: '2026-08-01T00:06:00.000Z', kind: 'watch-mail-reminder', by: 'watch', action: 'result', delivery: 'sent',
      mailId: 'legacy-mail-1', role: 'old', other: 1},
    {t: '2026-08-01T00:07:00.000Z', kind: 'handover', phase: 'transferred', handoverId: 'h-legacy', from: 'old', to: 'a', by: 'old'},
    {t: '2026-08-01T00:08:00.000Z', kind: 'stop', role: 'old', session: 'kadan-old', by: '사람'},
    {t: '2026-08-01T00:09:00.000Z', kind: 'alert', by: 'watch', alertKind: 'quiet', role: 'old'},
  ]);
  for (const role of ['a', 'b', 'w', 'r', 'i']) start(home, role, 1000 + role.charCodeAt(0));
  seedWatch(home, '1');
  appendLedger({kind: 'plan', board: 'p', taskId: 'card-x', by: 'a'}, home);
  // 답장을 기다리는 보관 우편 → 넣은 알림 → 같은 이름 새 대화(세대 경계).
  const asked = new Mailbox(home, 'b').send({by: 'a', message: '보관될 질문?', category: 'request', expectReply: true});
  seedWatch(home, '2', asked.mailId);
  stop(home, 'b');
  start(home, 'b', 2002, {conversationMode: 'new'});
  // --resume로 이어 연 역할: 경계가 아니다.
  const toResume = new Mailbox(home, 'r').send({by: 'a', message: 'resume 앞 우편'});
  stop(home, 'r');
  start(home, 'r', 2003, {cmd: 'claude --resume abc', conversationMode: 'resume'});
  // --inherit-mail로 이어받은 역할: 바로 앞 세대 하나만 잇는다.
  const toInherit = new Mailbox(home, 'i').send({by: 'a', message: 'inherit 앞 우편'});
  stop(home, 'i');
  start(home, 'i', 2004, {conversationMode: 'new', inheritMail: true, inheritedUnread: 1});
  // 발령(send+dispatch 짝) → 완료(done + 자동 결과 우편) → 중복 done.
  appendLedger({kind: 'send', role: 'w', by: 'a', taskId: 'r/card-x', executionKey: 'r/card-x', digest: 'dd', bytes: 3}, home);
  appendLedger({kind: 'done', role: 'w', taskId: 'r/card-x', executionKey: 'r/card-x', result: 'ok', by: 'a'}, home);
  appendLedger({kind: 'done', role: 'w', taskId: 'r/card-x', executionKey: 'r/card-x', result: 'ok', by: 'a'}, home);
  // 확정 인계(taskIds 포함): a의 우편 책임이 c로 넘어간다.
  appendLedger({kind: 'handover', phase: 'requested', handoverId: 'h1', from: 'a', to: 'c', by: 'a'}, home);
  appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'h1', from: 'a', to: 'c', by: 'a', taskIds: ['r/card-x']}, home);
  start(home, 'c', 3001);
  seedWatch(home, '3');
  // 인계 뒤 답장(일반·최종), 읽음, 취소, sourceKey 중복 거르기.
  new Mailbox(home, 'c').send({by: 'b', message: '검토 중', replyTo: asked.mailId});
  const final = new Mailbox(home, 'c').send({by: 'b', message: '답', replyTo: asked.mailId, replyFinal: true});
  new Mailbox(home, 'r').acknowledge(toResume.mailId, 'r');
  const cancelled = new Mailbox(home, 'w').send({by: 'b', message: '취소할 질문', expectReply: true});
  new Mailbox(home, 'b').cancel(cancelled.mailId, 'b');
  const keyed = new Mailbox(home, 'b').send({by: 'discord', message: '디코 글', sourceKey: 'discord:1'});
  const again = new Mailbox(home, 'b').send({by: 'discord', message: '디코 글', sourceKey: 'discord:1'});
  appendLedger({kind: 'window', role: 'b', session: 'kadan-b', window: 'none'}, home);
  appendLedger({kind: 'alert', by: 'watch', alertKind: 'quiet', role: 'b'}, home);
  appendLedger({kind: 'send-failed', role: 'b', session: 'kadan-b', keyDelivery: 'unknown', floor: 'tmux'}, home);
  return {home, asked, final, toResume, toInherit, cancelled, keyed, again};
}

test('우편함 읽기: 좁은 읽기와 전체 읽기가 같은 줄·같은 순서·같은 칸 순서다', () => {
  const {home} = fixture();
  const full = readMailboxLedger(home), narrow = readMailboxLedgerNarrow(home);
  assert.deepEqual(narrow, full);
  assert.equal(print(narrow), print(full));
  // 자료가 사례를 실제로 담았는지: 과거 원문·세대·인계·완료 근거·넣은 알림.
  for (const kind of ['send', 'mail-read', 'mail-cancel', 'start', 'stop', 'handover', 'done', 'watch-mail-reminder']) {
    assert.ok(narrow.some(entry => entry.kind === kind), `${kind} 줄이 있다`);
  }
  assert.equal(narrow.filter(entry => entry.kind === 'done').length, 1, '완료 우편이 달린 done 한 줄(중복 done은 완료 우편이 없다)');
  assert.equal(narrow.filter(entry => entry.kind === 'watch-mail-reminder').length, 2, '넣은 알림만(과거 원문 1 + 새 영역 1)');
  assert.ok(narrow.every(entry => !Object.hasOwn(entry, '_ledgerOrder')), '저장 순번은 밖으로 내지 않는다');
  assert.ok(!narrow.some(entry => ['watch-cycle', 'alert', 'plan', 'dispatch', 'window'].includes(entry.kind)));
});

test('전송 길 읽기: 좁은 읽기와 전체 읽기가 같은 줄·같은 순서·같은 칸 순서다', () => {
  const {home} = fixture();
  const full = readSendLedger(home), narrow = readSendLedgerNarrow(home);
  assert.deepEqual(narrow, full);
  assert.equal(print(narrow), print(full));
  for (const kind of ['plan', 'done', 'send', 'send-failed', 'start', 'stop', 'handover', 'alert', 'window',
    'watch-mail-reminder', 'watch-mail-held']) {
    assert.ok(narrow.some(entry => entry.kind === kind), `${kind} 줄이 있다`);
  }
  assert.equal(narrow.filter(entry => entry.kind === 'done' && entry.role === 'w').length, 1, '중복 done은 첫 줄만');
  const held = narrow.find(entry => entry.kind === 'watch-mail-held');
  assert.ok(!Object.hasOwn(held, 'timing'), '남는 감시 줄의 큰 본문은 전체 읽기처럼 빠진다');
});

test('우편함 결과(목록·세대·인계·답장 대기)가 두 읽기에서 같다', () => {
  const {home, asked, final, toResume, toInherit, cancelled} = fixture();
  const full = readMailboxLedger(home), narrow = readMailboxLedgerNarrow(home);
  assert.deepEqual(mailboxLetters(narrow), mailboxLetters(full));
  for (const role of ['a', 'b', 'c', 'w', 'r', 'i', 'old']) {
    for (const view of ['received', 'sent', 'to-reply', 'waiting']) {
      for (const options of [{all: true}, {all: false}, {unread: true}, {previousGenerations: 'exclude'}, {previousGenerations: 'only'}]) {
        assert.deepEqual(mailboxLetters(narrow, role, {view, ...options}), mailboxLetters(full, role, {view, ...options}),
          `${role} ${view} ${JSON.stringify(options)}`);
      }
    }
  }
  const letter = id => mailboxLetters(narrow).find(item => item.mailId === id);
  // 세대가 갈리는 사례가 실제로 갈렸는지(같은 이름 새 대화는 이전 세대, resume·inherit-mail은 아니다).
  assert.equal(letter(asked.mailId).currentRecipient, 'b');
  assert.equal(letter(asked.mailId).previousGeneration, true, '넣은 알림 뒤 같은 이름 새 대화');
  assert.equal(letter(toResume.mailId).previousGeneration, false, '--resume');
  assert.equal(letter(toInherit.mailId).previousGeneration, false, '--inherit-mail');
  // 인계·답장·취소.
  assert.equal(letter(asked.mailId).currentSender, 'c', '인계 뒤 답장 받을 쪽');
  assert.equal(letter(asked.mailId).replyStatus, 'answered');
  assert.equal(letter(asked.mailId).finalReplyId, final.mailId);
  assert.equal(letter(cancelled.mailId).replyStatus, 'cancelled');
  assert.equal(letter(toResume.mailId).read, true);
  // 자동 결과 우편은 원발령의 답으로 인정된다(완료 근거 done이 같은 순서로 들어 있어야 한다).
  const completion = mailboxLetters(narrow).find(item => item.systemGenerated === 'task-completion');
  assert.ok(completion, '자동 결과 우편');
  assert.equal(mailboxLetters(full).find(item => item.systemGenerated === 'task-completion').mailId, completion.mailId);
});

test('Mailbox(실제 명령 길)의 목록·읽기 결과가 전체 읽기로 계산한 값과 같다', () => {
  const {home, asked, keyed, again} = fixture();
  const full = readMailboxLedger(home);
  for (const role of ['a', 'b', 'c', 'w', 'r', 'i']) {
    const box = new Mailbox(home, role);
    assert.deepEqual(box.list(), mailboxLetters(full, role, {all: false, view: 'received', previousGenerations: 'exclude'}).reverse(), role);
    assert.deepEqual(box.list({all: true}), mailboxLetters(full, role, {all: true, view: 'received'}).reverse(), role);
    assert.deepEqual(box.list({view: 'sent'}), mailboxLetters(full, role, {all: true, view: 'sent'}).reverse(), role);
    assert.deepEqual(box.list({previousGenerations: true}),
      mailboxLetters(full, role, {all: false, view: 'received', previousGenerations: 'only'}).reverse(), role);
  }
  // 중복 거르기: 같은 sourceKey는 새 우편을 만들지 않는다.
  assert.equal(again.duplicate, true);
  assert.equal(again.mailId, keyed.mailId);
  assert.equal(full.filter(entry => entry.sourceKey === 'discord:1').length, 1);
  // inbox read: 우편 상태와 역할 지침이 전체 읽기(readLedger)로 조립한 값과 같다.
  const read = new Mailbox(home, 'b').read(asked.mailId);
  const expectedLetter = [...mailboxLetters(full, 'b', {all: true, view: 'received'}).reverse(),
    ...mailboxLetters(full, 'b', {all: true, view: 'sent'}).reverse()].find(item => item.mailId === asked.mailId);
  const expected = composeRoleInstructions({home, role: 'b', mailContext: expectedLetter, entries: readLedger(home)});
  assert.deepEqual(read.roleInstructions, expected.metadata);
  assert.ok(read.receiverInstructions.startsWith(expected.instructions ?? ''), '역할 지침 본문');
  for (const key of Object.keys(expectedLetter)) assert.deepEqual(read[key], expectedLetter[key], key);
});

test('발령 검사·답장 연결 결과가 두 읽기에서 같다', () => {
  const {home, asked} = fixture();
  const store = new CardStore(home);
  const card = store.create({repo: 'r', id: 'card-x', repoPath: home,
    body: `# 지시\n\n## 읽고 시작할 것\n- ${path.join(home, 'AGENTS.md')} — 규칙\n`});
  store.update(card.key, {status: 'assigned', role: 'a', board: 'p', scope: '시험 범위', ...rally}, {revision: 1, note: '배정'});
  // 담당 계산은 카드 배정 뒤의 인계만 따른다. 배정 뒤에 확정 인계를 한 번 더 적는다.
  appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'h2', from: 'a', to: 'c', by: 'a', taskIds: [card.key]}, home);
  const cards = store.listSummaries();
  const full = readSendLedger(home), narrow = readSendLedgerNarrow(home);
  const outcome = fn => { try { return {value: fn()}; } catch (error) { return {error: error.message}; } };
  // 인계(a → c, taskIds에 이 카드)가 반영된 실제 담당.
  assert.equal(effectiveCardRole(store.get(card.key), narrow, cards), effectiveCardRole(store.get(card.key), full, cards));
  assert.equal(effectiveCardRole(store.get(card.key), narrow, cards), 'c');
  for (const role of ['a', 'c', 'w']) {
    assert.deepEqual(outcome(() => store.checkSend('card-x', role, cards, narrow)?.role),
      outcome(() => store.checkSend('card-x', role, cards, full)?.role), `checkSend ${role}`);
    assert.equal(inferDispatchTask(home, {executionKey: card.key, role, entries: narrow}),
      inferDispatchTask(home, {executionKey: card.key, role, entries: full}), `inferDispatchTask ${role}`);
  }
  assert.equal(store.checkSend('card-x', 'c', cards, narrow).role, 'c');
  assert.throws(() => store.checkSend('card-x', 'a', cards, narrow), /중앙 카드 발령 불가/);
  // 답장 연결: 기본값(좁은 우편함 읽기)과 전체 읽기를 넘긴 결과가 같다. 이미 최종 답변이 온 질문은 둘 다 막는다.
  const input = {replyTo: asked.mailId, by: 'b', role: 'c'};
  assert.deepEqual(outcome(() => resolveWorkMail(home, input)),
    outcome(() => resolveWorkMail(home, input, {entries: readMailboxLedger(home)})));
  assert.deepEqual(outcome(() => resolveWorkMail(home, {...input, replyFinal: true})),
    outcome(() => resolveWorkMail(home, {...input, replyFinal: true}, {entries: readMailboxLedger(home)})));
  assert.match(outcome(() => resolveWorkMail(home, {...input, replyFinal: true})).error, /이미 최종 답변/);
});

test('빈 저장소·사건 없는 저장소: 두 읽기 모두 빈 목록', () => {
  const none = freshHome();
  assert.deepEqual(readMailboxLedgerNarrow(none), readMailboxLedger(none));
  assert.deepEqual(readSendLedgerNarrow(none), readSendLedger(none));
  assert.deepEqual(readMailboxLedgerNarrow(none), []);
  const empty = freshHome();
  createDatabase(empty); writeStorageMarker(empty, 'sqlite');
  assert.deepEqual(readMailboxLedgerNarrow(empty), []);
  assert.deepEqual(readSendLedgerNarrow(empty), []);
  assert.deepEqual(readMailboxLedger(empty), []);
});

const message = (read, home) => { try { read(home); return null; } catch (error) { return error.message; } };

test('남기는 손상 감지: 읽는 줄의 손상은 좁은 읽기도 막는다', () => {
  // 과거 원문 손상: 우편함은 막고(같은 문구), 전송 길은 broken 줄을 그대로 낸다(전체 읽기와 같다).
  {
    const {home} = fixture();
    insertRow(home, 'ledger.jsonl', {broken: '깨진 줄'});
    assert.equal(message(readMailboxLedgerNarrow, home), '과거 원장 손상: 도메인 조회 불가');
    assert.equal(message(readMailboxLedger, home), '과거 원장 손상: 도메인 조회 불가');
    assert.deepEqual(readSendLedgerNarrow(home), readSendLedger(home));
    assert.ok(readSendLedgerNarrow(home).some(entry => entry.broken));
  }
  // 우편 영역 줄 모양 손상(우편 ID 없는 send).
  {
    const {home} = fixture();
    insertRow(home, 'mail/events.jsonl', {t: new Date().toISOString(), kind: 'send', role: 'b', by: 'a', _ledgerOrder: lastOrder(home) + 1});
    for (const read of [readMailboxLedgerNarrow, readSendLedgerNarrow, readMailboxLedger, readSendLedger]) {
      assert.equal(message(read, home), '도메인 원장 mailId 손상: mail/events.jsonl');
    }
  }
  // 우편 ID 중복.
  {
    const {home, asked} = fixture();
    insertRow(home, 'mail/events.jsonl', {t: new Date().toISOString(), kind: 'send', role: 'b', by: 'a', transport: 'mailbox',
      mailId: asked.mailId, _ledgerOrder: lastOrder(home) + 1});
    for (const read of [readMailboxLedgerNarrow, readSendLedgerNarrow, readMailboxLedger, readSendLedger]) {
      assert.equal(message(read, home), '도메인 원장 중복 mailId');
    }
  }
  // 영역 안 순번 역전.
  {
    const {home} = fixture();
    insertRow(home, 'mail/events.jsonl', {t: new Date().toISOString(), kind: 'mail-read', role: 'b', mailId: 'x', by: 'b', _ledgerOrder: 1});
    for (const read of [readMailboxLedgerNarrow, readSendLedgerNarrow, readMailboxLedger, readSendLedger]) {
      assert.equal(message(read, home), '도메인 원장 순서 손상: mail/events.jsonl');
    }
  }
  // 읽은 줄끼리 순번 중복(우편 영역과 시스템 영역의 start가 같은 순번).
  {
    const {home} = fixture();
    const order = lastOrder(home) + 1;
    insertRow(home, 'mail/events.jsonl', {t: new Date().toISOString(), kind: 'mail-read', role: 'b', mailId: 'x', by: 'b', _ledgerOrder: order});
    insertRow(home, 'system/events.jsonl', {t: new Date().toISOString(), kind: 'start', role: 'z', session: 'kadan-z', _ledgerOrder: order});
    for (const read of [readMailboxLedgerNarrow, readSendLedgerNarrow, readMailboxLedger, readSendLedger]) {
      assert.equal(message(read, home), '도메인 원장 순번 중복');
    }
  }
});

test('포기하는 손상 감지: 읽지 않는 줄의 손상과 순번 빠짐은 전체 읽기만 잡는다', () => {
  // 읽지 않는 감시 줄 뒤의 순번 빠짐.
  {
    const {home} = fixture();
    insertRow(home, 'system/events.jsonl', {t: new Date().toISOString(), kind: 'watch-cycle', by: 'watch', _ledgerOrder: lastOrder(home) + 5});
    assert.equal(message(readMailboxLedger, home), '도메인 원장 순번 누락');
    assert.equal(message(readSendLedger, home), '도메인 원장 순번 누락');
    assert.equal(message(readMailboxLedgerNarrow, home), null);
    assert.equal(message(readSendLedgerNarrow, home), null);
  }
  // 읽는 줄 사이의 순번 빠짐도 영역을 다 읽지 않아 알 수 없다.
  {
    const {home} = fixture();
    insertRow(home, 'mail/events.jsonl', {t: new Date().toISOString(), kind: 'mail-read', role: 'b', mailId: 'x', by: 'b',
      _ledgerOrder: lastOrder(home) + 5});
    assert.equal(message(readMailboxLedger, home), '도메인 원장 순번 누락');
    assert.equal(message(readMailboxLedgerNarrow, home), null);
    assert.equal(message(readSendLedgerNarrow, home), null);
  }
  // 짝 없는 dispatch(send/dispatch 연결 손상): 좁은 읽기는 dispatch 줄을 읽지 않는다.
  {
    const {home} = fixture();
    insertRow(home, 'tasks/events.jsonl', {t: new Date().toISOString(), kind: 'dispatch', role: 'w', taskId: 'r/none', mailId: 'm-none',
      dispatchId: 'm-none', _ledgerOrder: lastOrder(home) + 1});
    assert.equal(message(readSendLedger, home), '도메인 원장 send/dispatch 연결 손상');
    assert.equal(message(readMailboxLedgerNarrow, home), null);
    assert.equal(message(readSendLedgerNarrow, home), null);
  }
});
