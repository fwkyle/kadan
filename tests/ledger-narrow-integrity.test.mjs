// Why: 우편함 명령의 좁은 읽기는 줄을 다 풀지 않는다. 그래도 전체 읽기가 막는 손상 원장에서는 똑같이 막혀야 한다
// (읽은 결과로 읽음·취소·우편 저장·최종 답장·차례 반환이 원장에 줄을 붙이고, 붙은 줄은 되돌릴 수 없다).
// 1) 작은 고정 원장에서 줄을 하나씩 빼거나, 순번을 다른 줄과 겹치거나, 이웃 줄과 순번을 맞바꾼 변형을 모두 만들어
//    "전체 읽기가 거절하면 좁은 읽기도 거절, 전체 읽기가 받으면 좁은 읽기도 같은 결과"를 확인한다.
//    줄 안의 칸도 같은 방식으로 본다: 모든 줄의 모든 칸을 지우고·틀린 값으로 바꾸고, 전체 읽기 검사가 읽는 칸을 붙인다.
// 2) 독립검수(exec-c5e01137)가 재현한 세 가지(완료 누락 뒤 취소, 확정 인계 누락 뒤 이전 수신자의 읽음·최종 답,
//    읽고 투영에서 빠지는 줄과의 순번 중복 뒤 읽음)를 쓰기 길에서 고정한다: 전체 읽기와 같은 거절, 새 줄 0건.
//    재현 자료의 출처는 그 검수 실행의 근거 폴더 corruption.test.mjs·ownership.test.mjs다(여기서는 한 저장소 코드만 돌린다).
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger, saveMailBody, readLedger, readMailboxLedger, readSendLedger,
  readMailboxLedgerNarrow, readSendLedgerNarrow, readHandoverLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker, appendStream, readStream, storageTransaction} from '../src/storage.mjs';
import {Mailbox} from '../src/mailbox.mjs';

const STREAMS = ['tasks/events.jsonl', 'mail/events.jsonl', 'system/events.jsonl'];
const MAIL = 'mail/events.jsonl', SYSTEM = 'system/events.jsonl';
const freshHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-integrity-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  return home;
};
const message = read => { try { read(); return null; } catch (error) { return error.message; } };
const handoversOf = home => readLedger(home).filter(entry => entry?.kind === 'handover');
// [이름, 좁은 읽기, 같은 결과를 내야 하는 전체 읽기]
const READERS = [
  ['우편함', readMailboxLedgerNarrow, readMailboxLedger],
  ['전송 길', readSendLedgerNarrow, readSendLedger],
  ['인계', readHandoverLedger, handoversOf],
];
// 일부러 남기는 차이: 인계 읽기는 우편·완료 줄을 풀지 않으므로 완료 우편과 done의 연결 손상은 보고하지 않는다.
// (업무 책임자 계산은 확정 인계만 본다. 순번 빠짐·중복·send/dispatch 짝은 인계 읽기도 막는다.)
const HANDOVER_SKIPS = /완료 우편|완료 사건/;
// 같은 종류의 한 경우: 전체 읽기가 완료 우편의 원발령을 다시 계산하다가 죽는 손상(완료 우편이 달린 done의 실행 주소가 글자가 아님).
// 전체 읽기는 이 오류로 멈추고, 완료 우편 연결을 계산하지 않는 인계 읽기는 멈추지 않는다. 우편함·전송 길 읽기는 같은 오류로 멈춘다.
const HANDOVER_SKIP_CRASH = /^address\?\.includes is not a function$/;

// 고정 원장: 세대·인계·발령 짝·읽지 않는 감시 줄·넣은 알림을 담고, 마지막 두 줄이 done과 자동 결과 우편이다.
// 과거 원문 영역(순번 없음)에는 발령과 확정 인계를 두고, 새 영역에서 그 후임이 완료한다(완료 우편의 원발령이 과거 원문에 걸린다).
const LEGACY = 'ledger.jsonl';
function fixtureRows() {
  const home = freshHome();
  const old = '2026-08-01T00:00:00.000Z';
  appendStream(home, LEGACY, {t: old, kind: 'start', role: 'w1', session: 'kadan-w1', panePid: 1});
  appendStream(home, LEGACY, {t: old, kind: 'send', role: 'w1', by: 'a', taskId: 'L1', expectReply: true, mailId: 'legacy-question', digest: 'lq', bytes: 1});
  appendStream(home, LEGACY, {t: old, kind: 'handover', phase: 'transferred', handoverId: 'hl', from: 'w1', to: 'w2', by: 'w1', taskIds: ['L1']});
  const start = (role, extra = {}) => appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid: 11, ...extra}, home);
  start('a'); start('b');
  appendLedger({kind: 'done', role: 'w2', taskId: 'L1', result: 'ok', by: 'a'}, home);
  appendLedger({kind: 'watch-cycle', by: 'watch', cycle: 1, timing: {steps: [{name: 'x', ms: 1}]}}, home);
  appendLedger({kind: 'send', role: 'w', by: 'a', taskId: 'r/t1', executionKey: 'r/t1', digest: 'dd', bytes: 3}, home);
  const asked = new Mailbox(home, 'b').send({by: 'a', message: '질문?', expectReply: true});
  appendLedger({kind: 'watch-mail-reminder', by: 'watch', action: 'result', delivery: 'sent', mailId: asked.mailId, role: 'b'}, home);
  appendLedger({kind: 'handover', phase: 'requested', handoverId: 'h1', from: 'a', to: 'c', by: 'a'}, home);
  appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'h1', from: 'a', to: 'c', by: 'a', taskIds: ['r/t1']}, home);
  appendLedger({kind: 'stop', role: 'b', session: 'kadan-b', by: '사람'}, home);
  start('b', {conversationMode: 'new'});
  appendLedger({kind: 'alert', by: 'watch', alertKind: 'quiet', role: 'b'}, home);
  appendLedger({kind: 'plan', board: 'p', taskId: 'r/t1', by: 'a'}, home);
  new Mailbox(home, 'b').acknowledge(asked.mailId, 'b');
  appendLedger({kind: 'watch-ai-request', by: 'watch', protocol: 2, requestId: 'req-1', key: 'progress:1', parents: {b: 'a'}, routes: {b: ['a']}}, home);
  appendLedger({kind: 'done', role: 'w', taskId: 'r/t1', executionKey: 'r/t1', result: 'ok', by: 'a'}, home);
  const rows = STREAMS.flatMap(stream => readStream(home, stream, {optional: true}).map(value => ({stream, value})))
    .sort((x, y) => x.value._ledgerOrder - y.value._ledgerOrder || STREAMS.indexOf(x.stream) - STREAMS.indexOf(y.stream));
  return [...readStream(home, LEGACY).map(value => ({stream: LEGACY, value})), ...rows];
}
// 변형 하나마다 원장을 새로 만든다. 줄마다 따로 저장하면 느려서 한 번의 쓰기 트랜잭션으로 넣는다(줄 내용·순서는 같다).
function build(rows) {
  const home = freshHome();
  storageTransaction(home, () => { for (const {stream, value} of rows) appendStream(home, stream, value); });
  return home;
}
const outcome = read => { try { return {value: read()}; } catch (error) { return {error: error.message}; } };
const label = row => row.stream === LEGACY ? `과거 원문:${row.value.kind}` : `${row.stream.split('/')[0]}:${row.value.kind}#${row.value._ledgerOrder}`;

// 빼기는 과거 원문 줄까지 전부, 순번 겹치기·맞바꾸기는 순번이 있는 새 영역 줄끼리 만든다.
function variants(rows) {
  const out = [];
  rows.forEach((row, i) => out.push({name: `빼기 ${label(row)}`, rows: rows.filter((_, k) => k !== i)}));
  rows.forEach((row, i) => rows.forEach((other, j) => {
    if (i === j || row.stream === LEGACY || other.stream === LEGACY || row.value._ledgerOrder === other.value._ledgerOrder) return;
    out.push({name: `겹치기 ${label(row)} → ${other.value._ledgerOrder}`,
      rows: rows.map((r, k) => k === i ? {stream: r.stream, value: {...r.value, _ledgerOrder: other.value._ledgerOrder}} : r)});
  }));
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.stream === LEGACY || b.stream === LEGACY || a.value._ledgerOrder === b.value._ledgerOrder) continue;
    out.push({name: `맞바꾸기 ${label(a)} ↔ ${label(b)}`, rows: rows.map((r, k) =>
      k === i ? {stream: r.stream, value: {...r.value, _ledgerOrder: b.value._ledgerOrder}}
        : k === i + 1 ? {stream: r.stream, value: {...r.value, _ledgerOrder: a.value._ledgerOrder}} : r)});
  }
  return out;
}

test('고정 원장의 변형 전부: 전체 읽기가 거절하면 좁은 읽기도 거절하고, 받으면 결과가 같다', () => {
  const rows = fixtureRows();
  // 자료가 겨냥한 줄을 담았는지: 발령 짝, 마지막 두 줄이 done과 자동 결과 우편, 확정·요청 인계, 읽지 않는 감시 줄.
  assert.equal(rows.at(-1).value.systemGenerated, 'task-completion');
  assert.equal(rows.at(-2).value.kind, 'done');
  for (const kind of ['dispatch', 'watch-cycle', 'watch-ai-request', 'plan', 'alert', 'mail-read', 'watch-mail-reminder']) {
    assert.ok(rows.some(row => row.value.kind === kind), kind);
  }
  assert.deepEqual(rows.filter(row => row.value.kind === 'handover').map(row => `${row.stream === LEGACY ? '과거 ' : ''}${row.value.phase}`),
    ['과거 transferred', 'requested', 'transferred']);
  assert.equal(rows.filter(row => row.value.systemGenerated === 'task-completion').length, 2, '자동 결과 우편 둘(하나는 원발령이 과거 원문)');
  // 대조군: 고치지 않은 원장은 모두 받고 결과가 같다.
  const control = build(rows);
  for (const [name, narrow, full] of READERS) assert.deepEqual(narrow(control), full(control), `대조군 ${name}`);

  const all = variants(rows), {escapes, differs, counts} = compareAll(all);
  // 헛통과 방지: 변형이 실제로 만들어졌고 전체 읽기가 거절한 경우가 충분히 있다.
  assert.equal(all.length, rows.length + 340 + 17, '변형 수: 빼기(줄 수) + 겹치기 340 + 맞바꾸기 17');
  assert.ok(counts.rejected > 900, `전체 읽기가 거절한 경우 ${counts.rejected}`);
  assert.deepEqual(escapes, [], `전체 읽기는 거절하는데 좁은 읽기가 받은 변형 ${escapes.length}건`);
  assert.deepEqual(differs, [], `거절 문구가 다르거나 좁은 읽기만 거절한 변형 ${differs.length}건`);
  // 일부러 남긴 차이는 인계 읽기의 완료 우편 연결뿐이고, 실제로 그 경우가 변형에 들어 있다.
  assert.ok(counts.skipped > 0, '인계 읽기의 예외 경우가 변형에 있다');
});

// ── 쓰기 길 회귀: 손상 원장에서는 전체 읽기와 같은 문구로 막히고 원장에 새 줄이 붙지 않는다 ──
const T = '2026-01-01T00:00:00.000Z';
const QUESTION = '00000000-0000-4000-8000-000000000111';
function questionHome({dispatch = true} = {}) {
  const home = freshHome();
  saveMailBody('fixture-body', '격리 시험 질문', home);
  appendLedger({kind: 'send', t: T, role: 'fixture-worker', by: 'fixture-owner', ...(dispatch ? {taskId: 'fixture-task'} : {}),
    expectReply: true, mailId: QUESTION, digest: 'fixture-body', bytes: 10}, home);
  return home;
}
const mailRows = home => readStream(home, MAIL).length;
function attempt(home, operate) {
  const before = mailRows(home);
  let result;
  try { result = {value: operate()}; } catch (error) { result = {error: error.message}; }
  return {...result, appended: mailRows(home) - before};
}

test('완료 기록(done)이 빠진 원장: 이미 답이 온 질문의 취소를 막고 새 줄 0건', () => {
  const healthy = questionHome();
  appendLedger({kind: 'done', t: T, role: 'fixture-worker', taskId: 'fixture-task', result: 'ok'}, healthy);
  const completion = readStream(healthy, MAIL).find(row => row.systemGenerated === 'task-completion');
  assert.ok(completion);
  const control = attempt(healthy, () => new Mailbox(healthy, 'fixture-owner').cancel(QUESTION, 'fixture-owner'));
  assert.match(control.error, /이미 최종 답변/);
  assert.equal(control.appended, 0);
  // 발령과 자동 결과 우편은 그대로 두고 그 사이의 done만 없는 원장.
  const broken = questionHome();
  appendStream(broken, MAIL, completion);
  const expected = message(() => readMailboxLedger(broken));
  assert.equal(expected, '도메인 원장 순번 누락');
  const observed = attempt(broken, () => new Mailbox(broken, 'fixture-owner').cancel(QUESTION, 'fixture-owner'));
  assert.equal(observed.error, expected);
  assert.equal(observed.appended, 0);
  assert.equal(message(() => new Mailbox(broken, 'fixture-owner').list({view: 'sent'})), expected, '조회도 같은 경계에서 막힌다');
});

test('확정 인계가 빠진 원장: 이전 수신자의 읽음과 최종 답을 막고 새 줄 0건', () => {
  const [before, after, sender] = ['fixture-predecessor', 'fixture-successor', 'fixture-sender'];
  const fixture = withHandover => {
    const home = freshHome();
    const {mailId} = new Mailbox(home, before).send({by: sender, message: '격리 시험 질문', expectReply: true});
    const marker = {kind: 'alert', t: T, by: 'fixture-monitor'};
    if (withHandover) {
      appendLedger({kind: 'handover', t: T, phase: 'transferred', from: before, to: after}, home);
      appendLedger(marker, home);
    } else appendStream(home, SYSTEM, {...marker, _ledgerOrder: 3});
    return {home, mailId};
  };
  const healthy = fixture(true);
  assert.equal(new Mailbox(healthy.home, after).list()[0].currentRecipient, after);
  assert.throws(() => new Mailbox(healthy.home, before).acknowledge(healthy.mailId, before), /우편 없음/);
  assert.throws(() => new Mailbox(healthy.home, sender).send({by: before, message: '잘못된 최종 답', replyTo: healthy.mailId, replyFinal: true}),
    /현재 책임자/);
  const {home, mailId} = fixture(false);
  const expected = message(() => readMailboxLedger(home));
  assert.equal(expected, '도메인 원장 순번 누락');
  const ack = attempt(home, () => new Mailbox(home, before).acknowledge(mailId, before));
  const answer = attempt(home, () => new Mailbox(home, sender).send({by: before, message: '잘못된 최종 답', replyTo: mailId, replyFinal: true}));
  assert.equal(ack.error, expected);
  assert.equal(answer.error, expected);
  assert.equal(ack.appended + answer.appended, 0);
  assert.equal(message(() => readHandoverLedger(home)), expected, '차례 반환이 쓰는 인계 읽기도 막힌다');
});

test('읽고 투영에서 빠지는 줄과 순번이 겹친 원장: 읽음을 막고 새 줄 0건', () => {
  const home = questionHome({dispatch: false});
  appendStream(home, SYSTEM, {t: T, kind: 'handover', phase: 'requested', from: 'fixture-worker', to: 'fixture-successor', _ledgerOrder: 1});
  const expected = message(() => readMailboxLedger(home));
  assert.equal(expected, '도메인 원장 순번 중복');
  const observed = attempt(home, () => new Mailbox(home, 'fixture-worker').acknowledge(QUESTION, 'fixture-worker'));
  assert.equal(observed.error, expected);
  assert.equal(observed.appended, 0);
});

test('과거 원문의 확정 인계가 빠진 원장(순번 빠짐이 없다): 후임의 완료로 답이 온 질문의 취소를 막고 새 줄 0건', () => {
  const id = '00000000-0000-4000-8000-000000000222';
  const question = {t: T, kind: 'send', role: 'fixture-w1', by: 'fixture-owner', taskId: 'fixture-T', expectReply: true, mailId: id,
    digest: 'fixture-body', bytes: 10};
  const handover = {t: T, kind: 'handover', phase: 'transferred', handoverId: 'fixture-h', from: 'fixture-w1', to: 'fixture-w2',
    by: 'fixture-w1', taskIds: ['fixture-T']};
  const legacyHome = rows => {
    const home = freshHome();
    saveMailBody('fixture-body', '격리 시험 질문', home);
    for (const row of rows) appendStream(home, LEGACY, row);
    return home;
  };
  const healthy = legacyHome([question, handover]);
  appendLedger({kind: 'done', t: T, role: 'fixture-w2', taskId: 'fixture-T', result: 'ok'}, healthy);
  const done = readStream(healthy, 'tasks/events.jsonl').at(-1), completion = readStream(healthy, MAIL).at(-1);
  assert.equal(completion.systemGenerated, 'task-completion');
  assert.deepEqual(readMailboxLedgerNarrow(healthy), readMailboxLedger(healthy));
  const control = attempt(healthy, () => new Mailbox(healthy, 'fixture-owner').cancel(id, 'fixture-owner'));
  assert.match(control.error, /이미 최종 답변/);
  // 새 영역의 줄(순번 1·2)은 그대로 두고 과거 원문의 확정 인계만 없는 원장.
  const broken = legacyHome([question]);
  appendStream(broken, 'tasks/events.jsonl', done);
  appendStream(broken, MAIL, completion);
  const expected = message(() => readMailboxLedger(broken));
  assert.equal(expected, '도메인 원장 완료 우편 연결 손상');
  assert.equal(message(() => readSendLedgerNarrow(broken)), expected);
  const observed = attempt(broken, () => new Mailbox(broken, 'fixture-owner').cancel(id, 'fixture-owner'));
  assert.equal(observed.error, expected);
  assert.equal(observed.appended, 0);
});

// ── 칸 변형: 줄 안의 칸을 기계적으로 지우고·바꾸고·붙인다 ──
// Why: 좁은 읽기는 본문을 풀지 않는 줄에서 SQL로 꺼낸 칸만 본다. 전체 읽기가 줄마다 보는 칸을 하나라도 빠뜨리면
// 그 칸이 손상된 원장에서 쓰기가 진행된다(재검수 exec-905156f4: 감시 줄에 붙은 완료 우편 표지).
// 어떤 칸을 보는지의 목록에 기대지 않고, 모든 줄의 모든 칸을 지우고·틀린 값으로 바꾸고, 전체 읽기 검사가 읽는 칸을
// 그 칸이 없는 줄 종류마다 붙여서 "전체 읽기가 거절하면 좁은 읽기도 거절"을 확인한다.
// 전체 읽기 검사(src/ledger-domains.mjs validateDomainEvent·createDomainValidator·createCompletionIndex·completionRequest)가 읽는 칸.
const VALIDATOR_KEYS = ['kind', 'broken', '_ledgerOrder', 'mailId', 'dispatchId', 'taskId', 'rawTaskId', 'executionKey', 'workKey', 'board',
  't', 'role', 'by', 'transport', 'completion', 'systemGenerated', 'replyFinal', 'replyTo', 'completionMailId', 'completionTaskId', 'result',
  'phase', 'taskIds', 'handoverId', 'from', 'to'];
// 칸 변형용 고정 원장: 세 좁은 읽기가 본문을 풀지 않는 줄 종류(감시 여섯 종류·그 밖의 시스템 줄·작업 주소가 적힌 감시 줄·
// 일반 우편·읽음·취소)와 본문을 푸는 줄 종류를 모두 담는다.
function fieldFixtureRows() {
  const home = freshHome();
  const old = '2026-08-01T00:00:00.000Z';
  appendStream(home, LEGACY, {t: old, kind: 'send', role: 'w1', by: 'a', taskId: 'L1', expectReply: true, mailId: 'legacy-question', digest: 'lq', bytes: 1});
  appendStream(home, LEGACY, {t: old, kind: 'handover', phase: 'transferred', handoverId: 'hl', from: 'w1', to: 'w2', by: 'w1', taskIds: ['L1']});
  const start = (role, extra = {}) => appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid: 11, ...extra}, home);
  start('a'); start('b');
  appendLedger({kind: 'hierarchy-loaded', by: 'watch', path: '/nonexistent/hierarchy.json'}, home);
  appendLedger({kind: 'plan', board: 'p', taskId: 'r/t1', by: 'a'}, home);
  appendLedger({kind: 'send', role: 'w', by: 'a', taskId: 'r/t1', executionKey: 'r/t1', workKey: 'r/w1', digest: 'dd', bytes: 3}, home);
  appendLedger({kind: 'done', role: 'w2', taskId: 'L1', result: 'ok', by: 'a'}, home);
  const asked = new Mailbox(home, 'b').send({by: 'a', message: '질문?', expectReply: true});
  const second = new Mailbox(home, 'b').send({by: 'a', message: '취소할 질문?', expectReply: true});
  appendLedger({kind: 'watch-cycle', by: 'watch', cycle: 1, timing: {steps: [{name: 'x', ms: 1}]}}, home);
  appendLedger({kind: 'watch-scope', by: 'watch', scope: {roles: ['a', 'b']}}, home);
  appendLedger({kind: 'watch-ai-request', by: 'watch', protocol: 2, requestId: 'req-1', key: 'progress:1', taskId: 'r/t1', executionKey: 'r/t1',
    role: 'w', parents: {b: 'a'}, routes: {b: ['a']}}, home);
  appendLedger({kind: 'watch-ai-call', by: 'watch', requestId: 'req-1', taskId: 'r/t1', executionKey: 'r/t1', reason: 'report-missing'}, home);
  appendLedger({kind: 'watch-ai-report', by: 'watch-ai', requestId: 'req-1', taskId: 'r/t1', executionKey: 'r/t1', verdict: 'normal'}, home);
  appendLedger({kind: 'watch-ai-retired', by: 'watch', requestId: 'req-1', key: 'progress:1'}, home);
  appendLedger({kind: 'watch-mail-reminder', by: 'watch', action: 'result', delivery: 'sent', mailId: asked.mailId, role: 'b'}, home);
  appendLedger({kind: 'watch-mail-held', by: 'watch', role: 'b', reason: 'busy'}, home);
  appendLedger({kind: 'handover', phase: 'requested', handoverId: 'h1', from: 'a', to: 'c', by: 'a'}, home);
  appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'h1', from: 'a', to: 'c', by: 'a', taskIds: ['r/t1']}, home);
  appendLedger({kind: 'stop', role: 'b', session: 'kadan-b', by: '사람'}, home);
  start('b', {conversationMode: 'new'});
  appendLedger({kind: 'alert', by: 'watch', alertKind: 'quiet', role: 'w', taskId: 'r/t1'}, home);
  appendLedger({kind: 'window', role: 'b', session: 'kadan-b', window: 'none'}, home);
  appendLedger({kind: 'send-failed', role: 'b', session: 'kadan-b', keyDelivery: 'unknown', floor: 'tmux'}, home);
  new Mailbox(home, 'b').acknowledge(asked.mailId, 'b');
  new Mailbox(home, 'c').cancel(second.mailId, 'c'); // 보낸 쪽 a의 책임은 위 확정 인계로 c에게 갔다
  appendLedger({kind: 'done', role: 'w', taskId: 'r/t1', executionKey: 'r/t1', result: 'ok', by: 'a'}, home);
  const rows = STREAMS.flatMap(stream => readStream(home, stream, {optional: true}).map(value => ({stream, value})))
    .sort((x, y) => x.value._ledgerOrder - y.value._ledgerOrder || STREAMS.indexOf(x.stream) - STREAMS.indexOf(y.stream));
  return [...readStream(home, LEGACY).map(value => ({stream: LEGACY, value})), ...rows];
}
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
// 한 칸의 틀린 값들: 다른 형, 빈 값, 같은 칸의 다른 줄 값. 원래 값과 같은 것은 뺀다.
function wrongValues(rows, at, key) {
  const value = rows[at].value[key], type = typeOf(value);
  const other = rows.find((row, k) => k !== at && Object.hasOwn(row.value, key) && JSON.stringify(row.value[key]) !== JSON.stringify(value));
  const candidates = [
    ['다른 형', type === 'string' ? 7 : 'x'],
    ['빈 값', type === 'string' ? '' : type === 'number' ? 0 : type === 'boolean' ? !value : type === 'array' ? [] : type === 'object' ? {} : ''],
    ['null', null],
    ...(other ? [['다른 줄 값', other.value[key]]] : []),
  ];
  return candidates.filter(([, next]) => JSON.stringify(next) !== JSON.stringify(value));
}
const withValue = (rows, at, value) => rows.map((row, k) => k === at ? {stream: row.stream, value} : row);
function fieldVariants(rows) {
  const out = [];
  // 붙일 값: 그 칸이 실제로 뜻을 갖는 값(같은 원장의 다른 줄에서 가져온다). 없으면 그럴듯한 고정값.
  const sample = key => rows.find(row => Object.hasOwn(row.value, key) && row.value[key])?.value[key];
  const attachValue = {broken: true, systemGenerated: 'task-completion', completion: true, replyFinal: true, transport: 'mailbox',
    phase: 'transferred', dispatchId: 'attached-dispatch', rawTaskId: 'attached-raw', board: 'attached-board', completionTaskId: 'r/t1'};
  rows.forEach((row, at) => {
    for (const key of Object.keys(row.value)) {
      const {[key]: removed, ...rest} = row.value;
      out.push({name: `지우기 ${label(row)}.${key}`, rows: withValue(rows, at, rest)});
      for (const [how, next] of wrongValues(rows, at, key)) {
        out.push({name: `바꾸기(${how}) ${label(row)}.${key}`, rows: withValue(rows, at, {...row.value, [key]: next})});
      }
    }
  });
  // 붙이기: 줄 종류(영역+종류+인계 단계)마다 첫 줄에, 그 줄에 없는 검사 칸을 하나씩 붙인다.
  const seen = new Set();
  rows.forEach((row, at) => {
    const kind = `${row.stream}:${row.value.kind}:${row.value.phase ?? ''}:${row.value.systemGenerated ?? ''}:${row.value.taskId ? 'task' : ''}`;
    if (seen.has(kind)) return;
    seen.add(kind);
    for (const key of VALIDATOR_KEYS) {
      if (Object.hasOwn(row.value, key)) continue;
      const next = attachValue[key] ?? sample(key);
      if (next === undefined) continue;
      out.push({name: `붙이기 ${label(row)}.${key}`, rows: withValue(rows, at, {...row.value, [key]: next})});
    }
  });
  return {variants: out, kinds: seen};
}
// 변형마다 읽기 3종을 전체 읽기와 대조한다. escapes = 전체는 거절하는데 좁은 읽기가 받음, differs = 문구가 다르거나 좁은 읽기만 거절.
function compareAll(all) {
  const escapes = [], differs = [], counts = {rejected: 0, accepted: 0, skipped: 0, crashSkipped: 0};
  for (const variant of all) {
    const home = build(variant.rows), slimErrors = {};
    for (const [name, narrow, full] of READERS) {
      const wide = outcome(() => full(home)), slim = outcome(() => narrow(home));
      slimErrors[name] = slim.error;
      if (wide.error === undefined) {
        counts.accepted++;
        if (slim.error !== undefined) differs.push(`${variant.name} / ${name}: 전체는 받고 좁은 읽기는 "${slim.error}"`);
        else assert.deepEqual(slim.value, wide.value, `${variant.name} / ${name}`);
        continue;
      }
      counts.rejected++;
      if (slim.error !== undefined) {
        if (slim.error !== wide.error) differs.push(`${variant.name} / ${name}: 전체 "${wide.error}" 좁은 "${slim.error}"`);
        continue;
      }
      // 인계 읽기의 예외는 "같은 명령의 준비 읽기(전송 길 좁은 읽기)가 먼저 같은 문구로 막는다"는 전제에서만 허용한다.
      const skip = name === '인계' && (HANDOVER_SKIPS.test(wide.error) ? 'skipped' : HANDOVER_SKIP_CRASH.test(wide.error) ? 'crashSkipped' : null);
      if (skip && slimErrors['전송 길'] === wide.error) { counts[skip]++; continue; }
      escapes.push(`${variant.name} / ${name}: 전체 "${wide.error}"${skip ? ` (전송 길 좁은 읽기는 "${slimErrors['전송 길']}")` : ''}`);
    }
    fs.rmSync(home, {recursive: true, force: true});
  }
  return {escapes, differs, counts};
}

test('칸 변형 전부(지우기·바꾸기·붙이기): 전체 읽기가 거절하면 좁은 읽기도 거절하고, 받으면 결과가 같다', t => {
  const rows = fieldFixtureRows();
  // 세 좁은 읽기가 본문을 풀지 않는 줄 종류가 자료에 모두 있다.
  for (const kind of ['watch-cycle', 'watch-scope', 'watch-ai-request', 'watch-ai-call', 'watch-ai-report', 'watch-ai-retired',
    'watch-mail-held', 'alert', 'window', 'send-failed', 'hierarchy-loaded', 'plan', 'mail-read', 'mail-cancel']) {
    assert.ok(rows.some(row => row.stream !== LEGACY && row.value.kind === kind), `${kind} 줄이 있다`);
  }
  assert.ok(rows.some(row => row.value.kind === 'send' && row.value.transport === 'mailbox' && !row.value.systemGenerated), '일반 우편');
  assert.ok(rows.some(row => row.value.kind?.startsWith('watch-ai') && row.value.taskId), '작업 주소가 적힌 감시 줄');
  const control = build(rows);
  for (const [name, narrow, full] of READERS) assert.deepEqual(narrow(control), full(control), `대조군 ${name}`);
  const {variants: all} = fieldVariants(rows);
  const {escapes, differs, counts} = compareAll(all);
  t.diagnostic(`칸 변형 ${all.length}개 × 읽기 3종: 전체 읽기 거절 ${counts.rejected}건, 수용 ${counts.accepted}건, 인계 읽기 예외 ${counts.skipped}건·계산 중 죽음 ${counts.crashSkipped}건`);
  assert.ok(all.length > 1000, `변형 수 ${all.length}`);
  assert.ok(counts.rejected > 500, `전체 읽기가 거절한 경우 ${counts.rejected}`);
  assert.deepEqual(escapes, [], `전체 읽기는 거절하는데 좁은 읽기가 받은 변형 ${escapes.length}건`);
  assert.deepEqual(differs, [], `거절 문구가 다르거나 좁은 읽기만 거절한 변형 ${differs.length}건`);
  assert.ok(counts.skipped > 0, '인계 읽기의 예외 경우가 변형에 있다');
  assert.equal(counts.crashSkipped, 1, '전체 읽기가 원발령 계산 중 죽는 경우는 done의 실행 주소 한 가지뿐이다');
});

test('본문을 풀지 않는 감시 줄에 완료 우편 표지가 잘못 붙은 원장: 읽음을 막고 새 줄 0건(표지가 없으면 읽음 1건)', () => {
  // 재현 자료의 출처: 재검수(exec-905156f4) 근거 폴더 projection-boundary.test.mjs(두 저장소를 번갈아 돌리는 부분만 뺐다).
  const id = '00000000-0000-4000-8000-000000000333';
  for (const marker of [false, true]) {
    const home = freshHome();
    saveMailBody('fixture-body', '격리 시험 우편', home);
    appendLedger({kind: 'send', t: T, by: 'fixture-sender', role: 'fixture-receiver', mailId: id, digest: 'fixture-body', bytes: 10}, home);
    // 종류·영역·순번은 그대로이고, 손상 쪽에서만 완료 우편 전용 표지 하나가 감시 줄에 붙어 있다.
    appendStream(home, SYSTEM, {t: T, kind: 'watch-cycle', by: 'fixture-monitor', _ledgerOrder: 2,
      ...(marker ? {systemGenerated: 'task-completion'} : {})});
    const expected = message(() => readMailboxLedger(home));
    assert.equal(expected, marker ? '도메인 원장 완료 사건 없는 우편' : null);
    for (const read of [readSendLedger, readMailboxLedgerNarrow, readSendLedgerNarrow]) assert.equal(message(() => read(home)), expected, read.name);
    const observed = attempt(home, () => new Mailbox(home, 'fixture-receiver').acknowledge(id, 'fixture-receiver'));
    if (marker) {
      assert.equal(observed.error, expected);
      assert.equal(observed.appended, 0);
    } else {
      assert.equal(observed.value.read, true);
      assert.equal(observed.appended, 1);
      assert.equal(readStream(home, MAIL).at(-1).kind, 'mail-read');
    }
  }
});
