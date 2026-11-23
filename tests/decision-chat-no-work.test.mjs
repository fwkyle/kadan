import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {readStream} from '../src/storage.mjs';
import {DecisionStore, decisionCommand, CHAT_OPTIONS} from '../src/decisions.mjs';
import {renderDecisions} from '../src/decision-wall.mjs';
import {openDecisionContext} from '../src/watch-waits.mjs';
import {mergeLineInfo, mergeContext} from '../src/dashboard/autopilot-view.mjs';
import {summarizeAutopilot} from '../src/autopilot-summary.mjs';
import {decisionsData} from '../src/dashboard/settings.mjs';
import {repoOfDecision, sidebarRepos} from '../src/dashboard/repo-view.mjs';
import {UNKNOWN_REPO} from '../src/dashboard/front.mjs';
// 업무·카드 없는 채팅 결정(`decision request --chat`, --work 없음). 동작 표 1~9 대응:
//  1·2 등록, 3 기존 경로 불변(tests/decision-chat.test.mjs 전체), 4·5 감시기(tests/chat-decision-watch.test.mjs),
//  6 reversible 거절, 7 중복 규칙, 8 표시, 9 d.work를 쓰는 곳.
process.env.KADAN_NOTIFY = 'off';
const SUPER = 'a-슈퍼감독';
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-decision-no-work-'));
  const sent = [], user = [];
  new CardStore(home).create({repo: 'repo', id: 'card-a', repoPath: home, body: '# 테스트'});
  new WorkStore(home).create({key: 'repo/w1', title: '업무', goal: '목표', scope: '범위', acceptance: '조건',
    owner: 'a-감독', repoPath: os.tmpdir()});
  const store = new DecisionStore(home, {notify: (...x) => sent.push(x), userNotify: (...x) => { user.push(x); return null; }});
  return {home, store, sent, user};
}
const events = home => readStream(home, 'decisions/events.jsonl');

test('표 1·2: --work 없음·--work 없음 낱말 모두 같은 꼴(chat:true, card:null, work:\'\')로 등록되고 알림은 없다', () => {
  const f = fixture();
  const a = f.store.request(null, {question: '합칠까요?', chat: true}, SUPER);
  assert.equal(a.chat, true); assert.equal(a.card, null); assert.equal(a.work, ''); assert.equal(a.requestedBy, SUPER);
  assert.deepEqual(a.options, [...CHAT_OPTIONS]); assert.equal(a.recommendation, '추천대로 진행');
  const b = f.store.request(null, {question: '다른 질문', work: '없음', chat: true}, SUPER);
  assert.equal(b.work, ''); assert.equal(b.card, null); assert.equal(b.chat, true);
  assert.deepEqual(f.user, []); assert.deepEqual(f.sent, []);
  assert.deepEqual(f.store.list().map(d => d.id).sort(), [a.id, b.id].sort(), '저장 뒤 목록 읽기가 손상으로 막히지 않는다');
  // 명령줄: 카드키 없이 --chat만, 닫는 명령 안내까지 기존 꼴 그대로
  const out = decisionCommand(['request'], {chat: true, question: '명령줄 질문'}, {home: f.home, by: SUPER, notify: () => {}});
  assert.equal(out.work, ''); assert.equal(out.chatCloseCommand,
    `kadan decision cancel ${out.id} --revision 1 --reason "kyle 채팅 답: <원문>"`);
  const none = decisionCommand(['request'], {chat: true, question: '명령줄 없음', work: '없음'}, {home: f.home, by: SUPER, notify: () => {}});
  assert.equal(none.work, '');
  assert.throws(() => decisionCommand(['request', 'repo/card-a'], {chat: true, question: 'x'}, {home: f.home, by: SUPER, notify: () => {}}), /카드키 없이/);
  assert.throws(() => f.store.request(null, {question: 'x', chat: true}, '작업자'), /슈퍼감독/);
});

test('옛 판독기 호환(머지 막음): 저장 줄은 origin/main latestDecisions가 요구하는 꼴(chat:true, card:null, work 문자열)이다', () => {
  const f = fixture();
  f.store.request(null, {question: '합칠까요?', chat: true}, SUPER);
  const [row] = events(f.home);
  // origin/main 74c4a186 decisions.mjs:61의 chat 검사 그대로: (chat===true ? (card!==null || typeof work!=='string') : ...)이면 손상.
  const oldReaderRejects = e => e.chat === true && (e.card !== null || typeof e.work !== 'string');
  assert.equal(oldReaderRejects(row), false);
  assert.equal(row.work, '', 'work 칸을 비우지 않고 빈 문자열로 쓴다(칸이 없으면 옛 코드가 목록 전체를 손상으로 버린다)');
  // work 칸이 없는 chat 행은 옛 판독기가 목록 전체를 손상으로 버리는 꼴이다: 이 꼴은 쓰지 않는다
  const withoutWork = {...row};delete withoutWork.work;
  assert.equal(oldReaderRejects(withoutWork), true);
});

test('표 3: 업무가 있는 채팅·카드 결정은 지금 그대로(work 문자열 저장, 닫힌 업무·없는 업무 거절)', () => {
  const f = fixture();
  const withWork = f.store.request(null, {question: '업무 질문', work: 'repo/w1', chat: true}, SUPER);
  assert.equal(withWork.work, 'repo/w1');
  assert.throws(() => f.store.request(null, {question: 'x', work: 'repo/없는업무', chat: true}, SUPER));
  const card = f.store.request('repo/card-a', {question: '카드?', options: ['예', '아니오'], recommendation: '예',
    reason: '이유\n- 확인 경로 없음: 시험'}, SUPER);
  assert.equal(card.card, 'repo/card-a'); assert.equal(card.chat, undefined); assert.equal('work' in card, false);
});

test('표 6: 무업무 + --reversible는 지금처럼 거절한다', () => {
  const f = fixture();
  assert.throws(() => f.store.request(null, {question: '되돌릴 수 있나', chat: true, reversible: '되돌리기', notProhibited: true}, SUPER),
    /업무가 없는 결정은/);
  assert.deepEqual(f.store.list(), [], '거절하면 아무것도 쓰지 않는다');
});

test('표 7: 같은 역할·같은 질문 재요청은 기존 채팅 중복 규칙 그대로(같은 내용이면 기존 것, 다르면 거절). 다른 역할·업무 있는 같은 질문은 따로다', () => {
  const f = fixture();
  const a = f.store.request(null, {question: '합칠까요?', chat: true}, SUPER);
  assert.equal(f.store.request(null, {question: '합칠까요?', chat: true}, SUPER).id, a.id, '--work 없음 낱말로 다시 불러도 같은 결정');
  assert.equal(f.store.request(null, {question: '합칠까요?', work: '없음', chat: true}, SUPER).id, a.id);
  assert.throws(() => f.store.request(null, {question: '합칠까요?', reason: '다른 이유', chat: true}, SUPER), /같은 질문의 다른 내용/);
  assert.notEqual(f.store.request(null, {question: '합칠까요?', chat: true}, 'b-슈퍼감독').id, a.id, '다른 역할은 따로');
  assert.notEqual(f.store.request(null, {question: '합칠까요?', work: 'repo/w1', chat: true}, SUPER).id, a.id, '업무가 있으면 따로');
});

test('표 5: 취소와 답변으로 닫힌다. 답변 통지 문구에 업무 undefined·빈 칸이 없다', () => {
  const f = fixture();
  const a = f.store.request(null, {question: '취소할 질문', chat: true}, SUPER);
  const cancelled = f.store.cancel(a.id, {revision: 1, reason: 'kyle 채팅 답: 승인'}, SUPER);
  assert.equal(cancelled.status, 'cancelled');
  const b = f.store.request(null, {question: '답할 질문', chat: true}, SUPER);
  const answered = f.store.answer(b.id, {revision: 1, text: '진행', choice: '추천대로 진행'}, '사람');
  assert.equal(answered.status, 'answered');
  const message = f.sent.at(-1)[1];
  assert.match(message, /결정 답변 .* \/ 업무 없음: 진행/); assert.doesNotMatch(message, /undefined|업무 :|업무  /);
  assert.equal(f.sent.at(-1)[0], SUPER, '답은 요청 역할에게 간다');
  assert.deepEqual(f.user, [], '채팅 결정은 등록·닫힘 알림을 보내지 않는다');
});

test('표 8: 대시보드 결정 화면(열린 목록·지난 결정)은 "채팅 · 업무 없음"으로 보이고 undefined·빈 업무 칸이 없다', () => {
  const f = fixture();
  const open = f.store.request(null, {question: '열린 질문', chat: true}, SUPER);
  const closed = f.store.request(null, {question: '닫힌 질문', chat: true}, SUPER);
  f.store.cancel(closed.id, {revision: 1, reason: 'kyle 채팅 답'}, SUPER);
  const html = renderDecisions(f.store.list(), null, 'tok');
  assert.match(html, /<span class="dc-chat">채팅<\/span><span class="dc-key">업무 없음<\/span>/);
  assert.match(html, /<span class="dc-chat">채팅<\/span> <span>업무 없음<\/span>/, '지난 결정 서랍');
  assert.ok(html.includes(`id="decision-${open.id}"`));
  assert.doesNotMatch(html, /undefined|\?card=null|업무 <\/span>/);
  // 내 결정 화면의 응답 함수(decisionsData): 업무·저장소·판으로 거르지 않는다. 열린 건과 지난 건 모두 나온다.
  const snapshot = {decisions: f.store.list(), home: f.home}, stamp = {};
  assert.deepEqual(decisionsData(snapshot, new URL('http://x/decisions'), stamp).items.map(d => d.id), [open.id]);
  assert.deepEqual(decisionsData(snapshot, new URL('http://x/decisions?past=1'), stamp).items.map(d => d.id), [closed.id]);
  assert.equal(decisionsData(snapshot, new URL(`http://x/decisions?id=${open.id}`), stamp).item.id, open.id);
  // 감독 화면(status.mjs 126~128행)은 요청 역할으로 고르고 저장소로 거르지 않는다. 저장소 탭에서는 '저장소 모름'으로 모인다.
  assert.deepEqual(f.store.list().filter(d => d.status === 'open' && d.requestedBy === SUPER).map(d => d.id), [open.id]);
  assert.equal(repoOfDecision(open), UNKNOWN_REPO);
  assert.equal(sidebarRepos({rows: [], decisions: [open], supervisors: null}).find(r => r.repo === UNKNOWN_REPO).decisions, 1);
});

test('표 9: d.work를 쓰는 곳 — 업무 닫힘 자동 정리, 감시 문맥, 머지 요약, 자율 요약이 업무 없는 결정에서 깨지거나 빈 업무를 찍지 않는다', () => {
  const f = fixture();
  const d = f.store.request(null, {question: '합칠까요?', chat: true}, SUPER);
  // decisions.mjs closeChatForWork: 업무 닫힘이 업무 없는 결정을 닫지 않는다
  const {closed, kept} = f.store.closeChatForWork('repo/w1', '업무 완료로 자동 닫힘', 'work complete', {rule: 'all'});
  assert.deepEqual([closed.length, kept.length], [0, 0]); assert.equal(f.store.get(d.id).status, 'open');
  // watch-waits.mjs openDecisionContext: 감독 정기 확인 입력에 work:null
  assert.deepEqual(openDecisionContext(f.store.list(), SUPER).map(x => x.work), [null]);
  // dashboard/autopilot-view.mjs mergeLineInfo: 빈 문자열 대신 null, 연결 업무를 못 찾았다고 한다
  const info = mergeLineInfo({center: null}, d, mergeContext({}));
  assert.equal(info.work, null);
  // autopilot-summary.mjs: 채팅 등록 건수만 센다
  const T0 = Date.parse('2026-11-23T00:00:00Z');
  const start = {kind: 'autopilot', phase: 'on', t: new Date(T0).toISOString(), until: new Date(T0 + 8 * 3600_000).toISOString(), by: '사람', text: 'x', to: [], delivered: []};
  const s = summarizeAutopilot({start, phase: 'off', endedAt: T0 + 3600_000, entries: [],
    decisionEvents: [{...events(f.home)[0], at: new Date(T0 + 60_000).toISOString()}], readBody: () => null});
  assert.equal(s.counts.chatRegistered, 1); assert.doesNotMatch(s.text, /undefined/);
});
