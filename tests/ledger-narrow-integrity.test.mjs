// Why: 우편함 명령의 좁은 읽기는 줄을 다 풀지 않는다. 그래도 전체 읽기가 막는 손상 원장에서는 똑같이 막혀야 한다
// (읽은 결과로 읽음·취소·우편 저장·최종 답장·차례 반환이 원장에 줄을 붙이고, 붙은 줄은 되돌릴 수 없다).
// 1) 작은 고정 원장에서 줄을 하나씩 빼거나, 순번을 다른 줄과 겹치거나, 이웃 줄과 순번을 맞바꾼 변형을 모두 만들어
//    "전체 읽기가 거절하면 좁은 읽기도 거절, 전체 읽기가 받으면 좁은 읽기도 같은 결과"를 확인한다.
//    줄 안의 칸을 지우고·바꾸고·붙이는 변형은 tests/ledger-narrow-integrity-fields.test.mjs에 있다.
// 2) 독립검수(exec-c5e01137)가 재현한 세 가지(완료 누락 뒤 취소, 확정 인계 누락 뒤 이전 수신자의 읽음·최종 답,
//    읽고 투영에서 빠지는 줄과의 순번 중복 뒤 읽음)를 쓰기 길에서 고정한다: 전체 읽기와 같은 거절, 새 줄 0건.
//    재현 자료의 출처는 그 검수 실행의 근거 폴더 corruption.test.mjs·ownership.test.mjs다(여기서는 한 저장소 코드만 돌린다).
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendLedger, saveMailBody, readMailboxLedger, readSendLedger,
  readMailboxLedgerNarrow, readSendLedgerNarrow, readHandoverLedger} from '../src/ledger.mjs';
import {appendStream, readStream} from '../src/storage.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {STREAMS, LEGACY, freshHome, build, message, READERS, rowVariants, compareAll, modelOf, storedAs} from './helpers/ledger-integrity-rig.mjs';

const MAIL = 'mail/events.jsonl', SYSTEM = 'system/events.jsonl';

// 고정 원장: 세대·인계·발령 짝·읽지 않는 감시 줄·넣은 알림을 담고, 마지막 두 줄이 done과 자동 결과 우편이다.
// 과거 원문 영역(순번 없음)에는 발령과 확정 인계를 두고, 새 영역에서 그 후임이 완료한다(완료 우편의 원발령이 과거 원문에 걸린다).
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

  const all = rowVariants(rows), {escapes, differs, counts} = compareAll(all);
  // 헛통과 방지: 변형이 실제로 만들어졌고 전체 읽기가 거절한 경우가 충분히 있다.
  assert.equal(all.length, rows.length + 340 + 17, '변형 수: 빼기(줄 수) + 겹치기 340 + 맞바꾸기 17');
  assert.ok(counts.rejected > 900, `전체 읽기가 거절한 경우 ${counts.rejected}`);
  assert.equal(counts.compared, all.length * READERS.length);
  assert.deepEqual(escapes, [], `전체 읽기는 거절하는데 좁은 읽기가 받은 변형 ${escapes.length}건`);
  assert.deepEqual(differs, [], `거절 문구가 다르거나 좁은 읽기만 거절하거나 받은 결과가 다른 변형 ${differs.length}건`);
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

// 줄 안의 칸을 지우고·바꾸고·붙이는 변형은 tests/ledger-narrow-integrity-fields.test.mjs가 본다.

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

test('창에 넣은 알림의 작업 주소가 완료 우편의 짧은 원발령 주소와 겹치는 원장: 읽음을 막고 새 줄 0건(겹치지 않으면 읽음 1건)', () => {
  // 재현 자료의 출처: 재검수 3(exec-4b999f69) 근거 폴더 reminder-task-address.test.mjs(두 저장소를 번갈아 돌리는 부분만 뺐다).
  // 이 줄들은 모두 저장 함수(appendLedger)가 받아 준 줄이다. 우편함 출력에서는 알림의 작업 주소가 빠지지만 검사는 원본 줄로 한다.
  const id = '00000000-0000-4000-8000-000000000444';
  for (const taskId of ['other/unrelated', 'other/short']) {
    const home = freshHome();
    saveMailBody('fixture-body', '격리 시험 질문', home);
    appendLedger({kind: 'send', t: T, role: 'fixture-worker', by: 'fixture-owner', taskId: 'short', expectReply: true, mailId: id,
      digest: 'fixture-body', bytes: 10}, home);
    appendLedger({kind: 'watch-mail-reminder', t: T, action: 'result', delivery: 'sent', mailId: id, role: 'fixture-worker',
      by: 'fixture-watch', taskId}, home);
    appendLedger({kind: 'done', t: T, role: 'fixture-worker', taskId: 'short', executionKey: 'fixture/short', result: 'ok'}, home);
    assert.equal(readStream(home, MAIL).at(-1).systemGenerated, 'task-completion');
    const conflict = taskId === 'other/short', expected = message(() => readMailboxLedger(home));
    assert.equal(expected, conflict ? '도메인 원장 완료 우편 연결 손상' : null);
    for (const read of [readSendLedger, readMailboxLedgerNarrow, readSendLedgerNarrow]) assert.equal(message(() => read(home)), expected, read.name);
    const observed = attempt(home, () => new Mailbox(home, 'fixture-worker').acknowledge(id, 'fixture-worker'));
    if (conflict) {
      assert.equal(observed.error, expected);
      assert.equal(observed.appended, 0);
    } else {
      assert.equal(observed.value.read, true);
      assert.equal(observed.appended, 1);
      // 우편함 출력의 알림 줄에는 작업 주소가 없다(출력용 다듬기는 그대로다).
      const reminder = readMailboxLedgerNarrow(home).find(entry => entry.kind === 'watch-mail-reminder');
      assert.deepEqual(Object.keys(reminder).sort(), ['action', 'delivery', 'kind', 'mailId', 'role', 't']);
    }
  }
});

// ── 변형의 손상 모델 분류: 바꾸기 전 줄의 출처가 아니라 "바뀐 줄을 저장 함수가 그대로 기록하는가"로 가른다 ──
test('모델 분류는 저장 함수의 실제 수용·거절과 같다: 바꾸지 않은 줄, 호출자가 줄 수 없는 꼴, 우편 ID 중복, 순번', () => {
  const rows = fixtureRows();
  const generated = value => value.kind === 'dispatch' || value.systemGenerated === 'task-completion';
  for (const [at, row] of rows.entries()) {
    // 호출자가 준 줄은 저장 함수가 그대로 다시 기록한다(모델 안). 저장 함수가 스스로 만든 발령 짝·자동 결과 우편은 호출자가 넣을 수 없다(모델 밖).
    const expected = row.stream === LEGACY ? 'legacy' : generated(row.value) ? 'out' : 'in';
    assert.equal(modelOf(rows, at, row.value), expected, `바꾸지 않은 줄 ${row.stream}:${row.value.kind}`);
  }
  const at = kind => rows.findIndex(row => row.stream !== LEGACY && row.value.kind === kind);
  const reminder = at('watch-mail-reminder'), done = rows.findIndex(row => row.value.completionMailId);
  const plain = rows.findIndex(row => row.stream === MAIL && row.value.kind === 'send' && !row.value.taskId && !row.value.systemGenerated);
  const other = rows.find((row, k) => k !== plain && row.stream === MAIL && row.value.kind === 'send');
  assert.ok(reminder >= 0 && done >= 0 && plain >= 0 && other);
  const change = (index, extra) => storedAs(rows, index, {...rows[index].value, ...extra});
  // 어느 줄에든 작업 주소를 적을 수 있다(재검수 3의 줄).
  assert.ok(change(reminder, {taskId: 'other/short'}).stored);
  // 호출자가 줄 수 없는 꼴은 저장 함수의 거절 문구 그대로 모델 밖이다.
  assert.equal(change(reminder, {systemGenerated: 'task-completion'}).error, '완료 우편 연결은 done 저장이 생성합니다');
  assert.equal(change(reminder, {completionMailId: 'x'}).error, '완료 우편 연결은 done 저장이 생성합니다');
  assert.equal(change(done, {completionMailId: 'x'}).error, '완료 우편 연결은 done 저장이 생성합니다');
  assert.match(change(reminder, {kind: 'dispatch'}).error, /^dispatch 직접 기록 금지/);
  assert.equal(change(plain, {mailId: other.value.mailId}).error, '도메인 원장 중복 mailId');
  // 순번은 저장 함수가 매긴다: 다른 줄과 겹치는 정수는 모델 안(줄 변형), 정수가 아니면 모델 밖.
  assert.ok(change(reminder, {_ledgerOrder: rows[done].value._ledgerOrder}).stored);
  assert.equal(change(reminder, {_ledgerOrder: 'x'}).error, `도메인 원장 순번 손상: ${SYSTEM}`);
  // 시각(t)이 없는 줄도 저장 함수가 기록한다(호출자가 t를 비워 주면 기본값을 채우지 않는다). 모델 안이다.
  const {t, ...timeless} = rows[reminder].value;
  assert.ok(storedAs(rows, reminder, timeless).stored);
  // 저장 함수가 채우거나 달아 주는 칸은 다르게 둘 수 없다: 우편 ID가 없는 send, 완료 우편을 만들 수 없는 done에 달린 completionMailId.
  const {mailId, ...unnamed} = rows[plain].value;
  assert.equal(storedAs(rows, plain, unnamed).error, '저장 함수가 기록한 줄이 바뀐 줄과 다름');
  assert.equal(change(done, {result: 'unknown'}).error, '저장 함수가 기록한 줄이 바뀐 줄과 다름');
});

test('자동 결과 우편이 빠지고 표지 없는 일반 보관 우편이 저장된 원장: 모델 안이고, 읽음을 막고 새 줄 0건', () => {
  // 재현 자료의 출처: 재검수 4(exec-f499dedf) 근거 폴더 model-samples.test.mjs.
  // 발령과 완료를 저장 함수로 기록하고, 자동 결과 우편 한 줄만 뺀 원장에 같은 우편에서 표지(systemGenerated)만 뺀 줄을 저장 함수로 넣는다.
  const pristine = freshHome();
  saveMailBody('fixture-body', '격리 시험 질문', pristine);
  appendLedger({kind: 'send', t: T, role: 'fixture-worker', by: 'fixture-owner', taskId: 'fixture-1', expectReply: true,
    mailId: QUESTION, digest: 'fixture-body', bytes: 10}, pristine);
  appendLedger({kind: 'done', t: T, role: 'fixture-worker', taskId: 'fixture-1', result: 'ok'}, pristine);
  assert.equal(message(() => readMailboxLedger(pristine)), null);
  const rows = STREAMS.flatMap(stream => readStream(pristine, stream, {optional: true}).map(value => ({stream, value})));
  const at = rows.findIndex(row => row.value.systemGenerated === 'task-completion');
  assert.ok(at >= 0);
  const {systemGenerated, ...replacement} = rows[at].value;
  const home = build(rows.filter((_, k) => k !== at));
  const {_ledgerOrder, ...input} = replacement;
  appendLedger(input, home);
  // 저장 함수가 칸·값·순번까지 같은 줄을 기록했다. 그래서 이 변형은 모델 안이다(바꾸기 전 줄이 자동 결과 우편이었어도).
  assert.deepEqual(readStream(home, MAIL).at(-1), replacement);
  assert.equal(modelOf(rows, at, replacement), 'in');
  const expected = '도메인 원장 완료 우편 연결 손상';
  for (const read of [readMailboxLedger, readSendLedger, readMailboxLedgerNarrow, readSendLedgerNarrow]) assert.equal(message(() => read(home)), expected, read.name);
  // 그 우편을 받은 쪽의 읽음도 같은 문구로 막히고 원장에 줄이 붙지 않는다.
  const observed = attempt(home, () => new Mailbox(home, replacement.role).acknowledge(replacement.mailId, replacement.role));
  assert.equal(observed.error, expected);
  assert.equal(observed.appended, 0);
});

test('앞선 발령 우편이 빠진 원장의 done(저장 함수가 기록한 줄, 모델 표지는 밖): 읽기 3종이 전체 읽기와 같은 문구로 막고 새 줄 0건', () => {
  // 재현 자료의 출처: 재검수 5(exec-7145e9ed) 근거 폴더 classification-samples.test.mjs의 두 건(역할 a의 done, 작업 주소 r/t1의 done).
  // 발령과 done을 모두 저장 함수로 기록한 정상 원장에서 앞선 발령 우편 한 줄만 뺀다(손상 모델이 허용하는 줄 유실).
  // modelOf는 "그 줄만 뺀 지금 원장"에 넣어 보므로 이 done에 '밖' 표지를 단다. 그래도 대조는 엄격해야 한다.
  for (const [role, taskId] of [['a', 'L1'], ['w2', 'r/t1']]) {
    const pristine = freshHome();
    saveMailBody('fixture-body', '격리 시험 질문', pristine);
    appendLedger({kind: 'send', t: T, role, by: 'fixture-owner', taskId, expectReply: true, mailId: QUESTION, digest: 'fixture-body', bytes: 10}, pristine);
    appendLedger({kind: 'done', t: T, role, taskId, result: 'ok', by: 'a'}, pristine);
    for (const [name, narrow, full] of READERS) assert.deepEqual(narrow(pristine), full(pristine), `정상 원장 ${name}`);
    const rows = STREAMS.flatMap(stream => readStream(pristine, stream, {optional: true}).map(value => ({stream, value})));
    const done = rows.findIndex(row => row.value.kind === 'done');
    assert.ok(rows[done].value.completionMailId, '저장 함수가 done에 완료 우편을 달았다');
    const lost = rows.filter(row => !(row.stream === MAIL && row.value.mailId === QUESTION));
    assert.equal(rows.length - lost.length, 1);
    assert.equal(modelOf(lost, lost.findIndex(row => row.value.kind === 'done'), rows[done].value), 'out');
    // 표지가 '밖'이어도 compareAll은 이 원장을 엄격하게 대조한다(빠져나감·차이 0, 전체 읽기 거절 3건).
    const {escapes, differs, counts} = compareAll([{name: `발령 우편 유실 ${role}/${taskId}`, rows: lost, model: 'out'}]);
    assert.deepEqual([escapes, differs, counts.rejected, counts.skipped + counts.crashSkipped], [[], [], 3, 0]);
    const home = build(lost), expected = '도메인 원장 send/dispatch 연결 손상';
    for (const read of [readMailboxLedger, readSendLedger, readMailboxLedgerNarrow, readSendLedgerNarrow, readHandoverLedger]) {
      assert.equal(message(() => read(home)), expected, read.name);
    }
    // 완료 우편을 받은 쪽의 읽음도 같은 문구로 막히고 원장에 줄이 붙지 않는다.
    const mail = lost.find(row => row.value.systemGenerated === 'task-completion').value;
    const observed = attempt(home, () => new Mailbox(home, mail.role).acknowledge(mail.mailId, mail.role));
    assert.equal(observed.error, expected);
    assert.equal(observed.appended, 0);
  }
});

test('대조는 모델 표지에 기대지 않는다: 표지가 밖인 변형에서 좁은 읽기만 받으면 빠져나감으로 잡힌다', () => {
  // 헛통과 방지: 전체 읽기는 거절하고 좁은 읽기는 받는 가짜 읽기 쌍을 끼워, 표지가 '밖'이어도 compareAll이 빠져나감으로 세는지 본다.
  const rows = fixtureRows();
  const lost = rows.filter((_, k) => k !== rows.length - 2); // 마지막 done을 뺀다(전체 읽기가 거절한다)
  const saved = READERS[0];
  READERS[0] = ['우편함', () => [], saved[2]];
  try {
    const {escapes, counts} = compareAll([{name: '가짜 좁은 읽기', rows: lost, model: 'out'}]);
    assert.equal(counts.variants.out, 1);
    assert.equal(escapes.length, 1);
    assert.match(escapes[0], /가짜 좁은 읽기 \/ 우편함 \[표지 out\]: 전체 ".+" 좁은 읽기는 받음/);
  } finally {
    READERS[0] = saved;
  }
});
