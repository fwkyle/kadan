import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {DecisionStore, decisionCommand} from '../src/decisions.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {readStream, appendStream, listStreams} from '../src/storage.mjs';
import {decisionsData} from '../src/dashboard/settings.mjs';

const SUPER = 'body-test-슈퍼감독', ORIGINAL = 'body-test-원감독';
const input = {question: '여러 정책을 어떻게 정할까요?', options: ['전부 추천대로', '메모대로', '보류'],
  recommendation: '전부 추천대로', reason: '확인 경로 없음: 시험', work: '없음'};
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-body-'));
  const cards = new CardStore(home), works = new WorkStore(home), calls = [];
  cards.create({repo: 'repo', id: 'a', repoPath: home, body: '# 시험'});
  for (const role of [SUPER, ORIGINAL]) appendLedger({kind: 'stop', role, session: `kadan-${role}`}, home);
  const store = new DecisionStore(home, {notify: (role, message) => {calls.push({role, message});}});
  const body = path.join(home, 'question.md');
  fs.writeFileSync(body, '\uFEFFA1. 첫 질문\r\nB3. 두 번째 질문 <script>원문</script>\r\n');
  return {home, cards, works, store, calls, body};
}
const ask = (f, extra = {}) => f.store.request('repo/a', {...input, ...extra}, SUPER);

test('원문 BOM·CRLF 바이트와 지문을 보존하고 목록에는 표시, show·단건에는 원문을 돌려준다', () => {
  const f = fixture(), bytes = fs.readFileSync(f.body);
  const d = ask(f, {bodyFile: f.body, replyTo: ORIGINAL});
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(d.body, {bytes: bytes.length, sha256: hash});
  assert.equal(d.replyTo, ORIGINAL);
  assert.equal(Object.hasOwn(d, 'bodyText'), false);
  const stored = readStream(f.home, `decisions/${d.id}/body.jsonl`);
  assert.equal(stored.length, 1);
  assert.deepEqual(Buffer.from(stored[0].text, 'utf8'), bytes);
  const show = decisionCommand(['show', d.id], {}, {home: f.home, by: '사람'});
  assert.deepEqual(Buffer.from(show.bodyText, 'utf8'), bytes);
  const snapshot = {home: f.home, decisions: f.store.list()};
  const base = 'http://127.0.0.1/api/dashboard/decisions';
  assert.equal(Object.hasOwn(decisionsData(snapshot, new URL(base), {}).items[0], 'bodyText'), false);
  assert.equal(decisionsData(snapshot, new URL(`${base}?id=${d.id}`), {}).item.bodyText, stored[0].text);
  assert.equal(ask(f, {bodyFile: f.body, replyTo: ORIGINAL}).id, d.id);
  assert.equal(readStream(f.home, `decisions/${d.id}/body.jsonl`).length, 1);
});

test('파일 오류·UTF-8 아님·128KiB 초과·모르는 역할은 등록을 남기지 않는다', () => {
  for (const kind of ['missing', 'relative', 'utf8', 'large', 'unknown']) {
    const f = fixture();
    const extra = {bodyFile: f.body};
    if (kind === 'missing') extra.bodyFile += '.missing';
    if (kind === 'relative') extra.bodyFile = 'question.md';
    if (kind === 'utf8') fs.writeFileSync(f.body, Buffer.from([0xc3, 0x28]));
    if (kind === 'large') fs.writeFileSync(f.body, Buffer.alloc(128 * 1024 + 1, 65));
    if (kind === 'unknown') extra.replyTo = 'body-test-오타';
    assert.throws(() => ask(f, extra), undefined, kind);
    assert.deepEqual(f.store.list(), []);
    assert.deepEqual(listStreams(f.home, 'decisions/'), []);
  }
});

test('원문 128KiB 경계와 파일 확인 경로를 받고 등록 중 실패면 두 stream 모두 되돌린다', () => {
  const f = fixture();
  fs.writeFileSync(f.body, Buffer.alloc(128 * 1024, 65));
  const d = ask(f, {bodyFile: f.body, reason: '긴 질문의 이유'});
  assert.equal(d.body.bytes, 128 * 1024);
  assert.match(d.reason, new RegExp('확인 경로: '));
  assert.ok(d.reason.endsWith(f.body));
  const g = fixture(), locked = g.store.locked.bind(g.store);
  g.store.locked = fn => locked(() => {fn(); throw new Error('등록 뒤 실패 주입');});
  assert.throws(() => ask(g, {bodyFile: g.body}), /실패 주입/);
  assert.deepEqual(listStreams(g.home, 'decisions/'), []);
  assert.equal(g.calls.length, 0);
});

test('같은 질문은 원문 지문·회신 대상이 다르면 기존 내용을 성공으로 돌려주지 않는다', () => {
  const f = fixture();
  ask(f);
  assert.throws(() => ask(f, {bodyFile: f.body}), /같은 질문의 다른 내용/);
  assert.throws(() => ask(f, {replyTo: ORIGINAL}), /같은 질문의 다른 내용/);
  const g = fixture();
  ask(g, {bodyFile: g.body, replyTo: ORIGINAL});
  fs.appendFileSync(g.body, '추가');
  assert.throws(() => ask(g, {bodyFile: g.body, replyTo: ORIGINAL}), /같은 질문의 다른 내용/);
  assert.throws(() => ask(g, {replyTo: SUPER}), /같은 질문의 다른 내용/);
});

test('두 통지는 같은 답 본문과 원 질문을 보내고 마지막 사건 하나에 결과를 기록한다', () => {
  const f = fixture(), d = ask(f, {bodyFile: f.body, replyTo: ORIGINAL});
  const answer = f.store.answer(d.id, {revision: 1, choice: '전부 추천대로', text: '전부 추천대로, B3만 2번'}, '사람');
  assert.equal(answer.revision, 3);
  assert.equal(readStream(f.home, 'decisions/events.jsonl').length, 3);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].message, `${f.calls[0].message}\n원 질문: ${d.question}`);
  assert.deepEqual(answer.delivery, {status: 'sent', role: SUPER});
  assert.deepEqual(answer.replyDelivery, {status: 'sent', role: ORIGINAL});
  f.store.answer(d.id, {revision: 1, choice: '전부 추천대로', text: '전부 추천대로, B3만 2번'}, '사람');
  assert.equal(f.calls.length, 2);
});

test('각 통지 실패는 다른 통지를 막지 않으며 실제 인계 수신자가 같으면 한 통만 보낸다', () => {
  for (const failed of [SUPER, ORIGINAL]) {
    const f = fixture(), d = ask(f, {replyTo: ORIGINAL});
    f.store.notify = (role, message) => {
      f.calls.push({role, message});
      if (role === failed) throw new Error('가짜 통지 실패');
      return {status: 'stored'};
    };
    const saved = f.store.answer(d.id, {revision: 1, text: '메모 원문'}, '사람');
    assert.equal(f.calls.length, 2);
    assert.equal(saved.status, 'answered');
    const failure = failed === SUPER ? saved.delivery : saved.replyDelivery;
    assert.deepEqual(failure, {status: 'failed', role: failed, error: '가짜 통지 실패'});
    assert.equal((failed === SUPER ? saved.replyDelivery : saved.delivery).status,
      failed === SUPER ? 'stored' : 'sent');
  }
  for (const handover of [false, true]) {
    const f = fixture(), replyTo = handover ? ORIGINAL : SUPER;
    const d = ask(f, {replyTo});
    if (handover) appendLedger({kind: 'handover', phase: 'transferred', from: SUPER,
      to: ORIGINAL, taskIds: ['repo/a'], t: new Date(Date.parse(d.at) + 1).toISOString()}, f.home);
    const saved = f.store.answer(d.id, {revision: 1, text: '답'}, '사람');
    assert.equal(f.calls.length, 1);
    assert.equal(saved.delivery.role, replyTo);
    assert.equal(saved.replyDelivery.role, replyTo);
  }
});

test('chat만 done 업무를 받고 cancelled와 카드 결정은 거절하며 업무 없는 경우 기존 길을 안내한다', () => {
  const f = fixture();
  for (const [key, action] of [['repo/done', 'complete'], ['repo/cancelled', 'cancel']]) {
    f.works.create({key, title: key, goal: '목표', scope: '범위', acceptance: '조건', owner: ORIGINAL, repoPath: f.home});
    f.works.change(key, action, {result: '완료 근거'}, {revision: 1, by: '사람', note: '상태 준비'});
  }
  const d = f.store.request(null, {chat: true, question: '끝난 업무 질문', work: 'repo/done', bodyFile: f.body}, SUPER);
  assert.equal(d.chat, true);
  assert.ok(d.reason.endsWith(f.body));
  assert.throws(() => f.store.request(null, {chat: true, question: 'x', work: 'repo/cancelled'}, SUPER), /열린 업무만/);
  assert.throws(() => ask(f, {work: 'repo/done'}), /열린 업무만/);
  for (const work of [undefined, '없음']) assert.throws(() => f.store.request(null,
    {chat: true, question: 'x', work}, SUPER), /업무와 무관한 결정은 관련 카드 키 \+ --work 없음으로 등록/);
});

test('원문 누락/지문 불일치는 show와 단건에 표시하고 답과 기존 결정 조회는 유지한다', () => {
  for (const sha256 of ['0'.repeat(64), undefined]) {
    const f = fixture(), d = ask(f, sha256 ? {bodyFile: f.body} : {});
    appendStream(f.home, 'decisions/events.jsonl', {...d, revision: 2,
      body: {bytes: 1, sha256: sha256 ?? '0'.repeat(64)}});
    const show = decisionCommand(['show', d.id], {}, {home: f.home, by: '사람'});
    assert.equal(show.question, d.question);
    assert.match(show.bodyError, /원문을 읽지 못했습니다/);
    assert.equal(f.store.answer(d.id, {revision: 2, text: '기존 질문으로 답'}, '사람').status, 'answered');
  }
});
