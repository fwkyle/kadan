import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendStream, readStream} from '../src/storage.mjs';
import {DecisionStore, decisionCommand} from '../src/decisions.mjs';
import {readDecisionDetail} from '../src/decision-detail.mjs';
import {verifyStorage} from '../src/storage-migration.mjs';
import {proceedEligibility, releasedFromWait} from '../src/decision-proceed.mjs';
import {bundleRow, bodyRow, partialRow, fullRow, submission, bundleHome, at} from './helpers/decision-bundle.mjs';

test('묶음 고정 자료: 등록·일부 답·전체 답·취소·업무 유무를 목록과 상세에서 읽는다', () => {
  for (const work of [undefined, 'repo/work-a']) for (const phase of ['new', 'partial', 'full', 'cancel']) {
    const first = bundleRow(work ? {work} : {}), partial = partialRow(first);
    const history = [first], detail = [bodyRow(first)];
    if (phase !== 'new') {history.push(partial); detail.push(submission());}
    if (phase === 'full') {
      history.push(fullRow(first));
      detail.push(submission(3, {A2: {choice: null, note: '보류합니다'}}));
    }
    if (phase === 'cancel') history.push({...partial, revision: 3, status: 'cancelled', cancelReason: '취소'});
    const {home} = bundleHome({row: first, history, detail});
    const store = new DecisionStore(home);
    assert.deepEqual(store.get(first.id), history.at(-1));
    assert.deepEqual(store.list({dashboard: true}), [history.at(-1)]);
    const read = readDecisionDetail(home, first.id);
    assert.deepEqual(read.answered, history.at(-1).answered);
    assert.equal(read.status, history.at(-1).status);
    assert.equal(JSON.stringify(read).includes('audit@example.invalid'), false);
    assert.equal(verifyStorage(home).integrity, 'ok');
  }
});

test('묶음 목록 줄: 잘못된 모양을 기존 손상 오류로 드러낸다', () => {
  const malformed = [
    {itemKeys: ['A1', 'A1']}, {itemKeys: []}, {itemKeys: ['@memo']}, {bundle: false},
    {status: 'answered', answer: {text: '완료', at, by: '사람'}}, {work: null}, {repo: null},
    {answered: {unknown: 'keep'}}, {answered: {A1: 'bad choice'}}, {options: ['a', 'b']},
    {chat: true}, {recommendation: 'keep'}, {context: {work: null}}, {question: 'a'.repeat(301)},
    {reason: 'a'.repeat(1001)}, {id: 'a'.repeat(9000)}, {itemKeys: Array(21).fill('a')},
    {status: 'cancelled', cancelReason: {}}, {at: 'not-a-time'},
  ];
  for (const over of malformed) {
    const {home} = bundleHome({row: bundleRow(over)});
    assert.throws(() => new DecisionStore(home).list(), /결정 이력 손상/, JSON.stringify(over).slice(0, 100));
  }
});

test('목록 줄 전체의 UTF-8 8KiB 경계를 검사하며 단일 결정 검증과 섞지 않는다', () => {
  const row = bundleRow({replyTo: 'x'});
  row.replyTo = 'x'.repeat(8192 - Buffer.byteLength(JSON.stringify(row)) + 1);
  assert.equal(Buffer.byteLength(JSON.stringify(row)), 8192);
  const exact = bundleHome({row});
  assert.equal(new DecisionStore(exact.home).list().length, 1);
  const over = bundleHome({row: {...row, replyTo: row.replyTo + 'x'}});
  assert.throws(() => new DecisionStore(over.home).list(), /결정 이력 손상/);
});

test('묶음의 단일 답·추천대로 진행·채팅 자동 닫힘은 기록을 바꾸지 않는다', () => {
  const first = bundleRow({work: 'repo/work-a'}), {home} = bundleHome({row: first});
  const store = new DecisionStore(home);
  for (const flags of [{text: '승인'}, {choice: 'keep'}]) {
    assert.throws(() => decisionCommand(['answer', first.id], {revision: 1, ...flags},
      {home, by: '사람'}), /항목별 답/);
  }
  assert.throws(() => store.proceed(first.id, {revision: 1}, first.requestedBy, {now: Date.now}), /항목별 답/);
  assert.throws(() => store.cancel(first.id, {revision: 1, reason: '취소'}, first.requestedBy), /이 버전/);
  assert.equal(proceedEligibility(first, null, Date.now()).ok, false);
  assert.equal(releasedFromWait({...first, proceeded: {at}}, null, Date.now()), false);
  assert.deepEqual(store.closeChatForWork(first.work, '시험', 'execute'), {closed: [], kept: []});
  assert.equal(readStream(home, 'decisions/events.jsonl').length, 1);
});

test('상세: 전달만 추가되면 같은 목록 revision에서도 새 전달을 읽는다. 빠진 전달은 모름', () => {
  const first = bundleRow(), {home} = bundleHome({row: first,
    history: [first, partialRow(first)], detail: [bodyRow(first), submission()]});
  const before = readDecisionDetail(home, first.id);
  assert.deepEqual(before.delivery.map(row => row.status), ['unknown', 'unknown']);
  appendStream(home, `decisions/${first.id}/detail.jsonl`,
    {type: 'delivery', revision: 2, to: first.replyTo, status: 'stored', mailId: 'mail-1', at});
  const after = readDecisionDetail(home, first.id);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.delivery.map(row => row.status), ['stored', 'unknown']);
});

test('상세: 두 stream 어긋남·본문 누락/중복·잘못된 선택·없는 제출을 손상으로 거절', () => {
  const first = bundleRow(), partial = partialRow(first), body = bodyRow(first), answer = submission();
  const cases = [
    [[first], []], [[first], [body, body]], [[first, partial], [body]], [[first], [body, answer]],
    [[first, partial], [body, answer, answer]],
    [[first, partial], [body, submission(3)]],
    [[first, partial], [body, submission(2, {A1: {choice: 'change', note: ''}})]],
    [[first, {...partial, answered: {A1: 'missing'}}], [body, submission(2, {A1: {choice: 'missing', note: ''}})]],
    [[first, partial], [{...body, items: body.items.slice(1)}, answer]],
    [[first], [body, {type: 'delivery', revision: 2, to: first.replyTo, status: 'sent', at}]],
    [[first, partial], [body, answer, {type: 'delivery', revision: 2, to: 'other', status: 'sent', at}]],
    [[first, partial, {...partial, revision: 3, answered: {A1: 'change'}}], [body, answer]],
  ];
  for (const [history, detail] of cases) {
    const {home} = bundleHome({row: first, history, detail});
    assert.throws(() => readDecisionDetail(home, first.id), /손상/);
    assert.throws(() => verifyStorage(home), /손상/);
  }
});
