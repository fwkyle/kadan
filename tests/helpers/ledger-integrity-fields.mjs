// 칸 변형 시험의 고정 원장과 변형 만들기(tests/ledger-narrow-integrity-fields*.test.mjs가 갈래별로 나눠 돌린다).
// Why: 좁은 읽기는 본문을 풀지 않는 줄에서 SQL로 꺼낸 칸만 보고, 출력용으로 다듬은 줄에서는 칸이 빠진다.
// 전체 읽기가 줄마다 보는 칸을 하나라도 놓치면 그 칸이 걸린 원장에서 쓰기가 진행된다
// (재검수 exec-905156f4: 감시 줄에 붙은 완료 우편 표지, exec-4b999f69: 넣은 알림의 작업 주소).
// 어떤 칸을 보는지의 목록이나 손으로 고른 값에 기대지 않는다: 모든 줄의 모든 칸을 지우고, 틀린 값으로 바꾸고,
// 같은 칸의 "다른 모든 줄의 값"으로 바꾸고, 전체 읽기 검사가 읽는 칸을 그 칸이 없는 줄에 원장의 모든 값으로 붙인다.
import assert from 'node:assert/strict';
import {appendLedger} from '../../src/ledger.mjs';
import {appendStream, readStream} from '../../src/storage.mjs';
import {Mailbox} from '../../src/mailbox.mjs';
import {STREAMS, LEGACY, freshHome, build, label, READERS, VALIDATOR_KEYS, rowVariants, compareAll} from './ledger-integrity-rig.mjs';

// 제품이 원장에 쓰는 사건 종류. 모은 방법: (1) 운영 원장의 새 영역 세 곳에 실제로 적힌 종류 전부(2026-11-27 조사, 37종),
// (2) src의 `kind: '…'` 리터럴 가운데 원장 기록 호출(appendLedger·record)에 쓰이는데 (1)에 없던 것(watch-judgment 등).
// 우편 영역의 그 밖의 종류(ledgerDomain이 mail로 보내는 reply-*·cancel-*)는 제품이 쓰지 않지만 저장 함수가 받으므로 하나 넣는다.
export const PRODUCT_KINDS = ['adopt', 'advice', 'alert', 'alert-resolved', 'alert-update', 'autopilot', 'autopilot-delivery', 'autopilot-note',
  'autopilot-repo-policy', 'autopilot-summary', 'compare-pick', 'decision-proceed', 'dispatch', 'done', 'handover', 'hierarchy-loaded',
  'hierarchy-prune', 'mail-cancel', 'mail-read', 'ocx-refresh', 'plan', 'progress-judgment', 'queue-resume', 'rate-limit-retry', 'revive',
  'runner-settings', 'send', 'send-failed', 'start', 'stop', 'trust', 'watch-ai-call', 'watch-ai-delivery', 'watch-ai-report', 'watch-ai-request',
  'watch-ai-retired', 'watch-cycle', 'watch-judgment', 'watch-mail-held', 'watch-mail-reminder', 'watch-notify-forced', 'watch-scope', 'window'];

const T1 = '2026-01-01T00:00:00.000Z', T2 = '2026-01-02T00:00:00.000Z';
// 고정 원장. 작업 주소는 네 꼴을 담는다: 정식 주소(r/t1), 짧은 주소(short)와 그 정식 주소(fixture/short),
// 겹치지 않는 다른 저장소 주소(other/unrelated), 짧은 주소와 겹치는 다른 저장소 주소(other/short — 완료 뒤 줄에만 있어 원장은 정상이다).
export function fieldFixtureRows() {
  const home = freshHome();
  const add = (entry, t = T1) => appendLedger({t, ...entry}, home);
  appendStream(home, LEGACY, {t: T1, kind: 'send', role: 'w1', by: 'a', taskId: 'L1', expectReply: true, mailId: 'legacy-question', digest: 'lq', bytes: 1});
  appendStream(home, LEGACY, {t: T1, kind: 'handover', phase: 'transferred', handoverId: 'hl', from: 'w1', to: 'w2', by: 'w1', taskIds: ['L1']});
  const start = (role, extra = {}) => add({kind: 'start', role, session: `kadan-${role}`, panePid: 11, ...extra});
  start('a'); start('b'); start('w');
  add({kind: 'hierarchy-loaded', by: 'watch', path: '/nonexistent/hierarchy.json'});
  add({kind: 'plan', board: 'p', taskId: 'r/t1', by: 'a'});
  add({kind: 'send', role: 'w', by: 'a', taskId: 'r/t1', executionKey: 'r/t1', workKey: 'r/w1', digest: 'dd', bytes: 3});
  add({kind: 'send', role: 'w', by: 'a', taskId: 'short', expectReply: true, digest: 'ds', bytes: 3});
  const asked = new Mailbox(home, 'b').send({by: 'a', message: '질문?', expectReply: true});
  const second = new Mailbox(home, 'b').send({by: 'a', message: '취소할 질문?', expectReply: true});
  add({kind: 'watch-cycle', by: 'watch', cycle: 1, timing: {steps: [{name: 'x', ms: 1}]}});
  add({kind: 'watch-scope', by: 'watch', scope: {roles: ['a', 'b']}});
  add({kind: 'watch-ai-request', by: 'watch', protocol: 2, requestId: 'req-1', key: 'progress:1', taskId: 'r/t1', executionKey: 'r/t1',
    role: 'w', parents: {b: 'a'}, routes: {b: ['a']}});
  add({kind: 'watch-ai-call', by: 'watch', requestId: 'req-1', taskId: 'r/t1', executionKey: 'r/t1', reason: 'report-missing'});
  add({kind: 'watch-ai-report', by: 'watch-ai', requestId: 'req-1', taskId: 'r/t1', executionKey: 'r/t1', verdict: 'normal'});
  add({kind: 'watch-ai-retired', by: 'watch', requestId: 'req-1', key: 'progress:1'});
  add({kind: 'watch-ai-delivery', by: 'watch', requestId: 'req-1', role: 'a', delivery: 'sent'});
  add({kind: 'watch-judgment', by: 'watch', role: 'w', verdict: 'normal'});
  add({kind: 'progress-judgment', by: 'watch', role: 'w', taskId: 'r/t1', verdict: 'progress'});
  add({kind: 'watch-notify-forced', by: 'watch', role: 'a'});
  // 창에 넣은 알림(우편함 출력에서는 작업 주소가 빠진다)과 못 넣은 알림.
  add({kind: 'watch-mail-reminder', by: 'watch', action: 'result', delivery: 'sent', mailId: asked.mailId, role: 'b', taskId: 'other/unrelated'});
  add({kind: 'watch-mail-reminder', by: 'watch', action: 'result', delivery: 'not-sent', mailId: second.mailId, role: 'b'});
  add({kind: 'watch-mail-held', by: 'watch', role: 'b', reason: 'busy'});
  add({kind: 'handover', phase: 'requested', handoverId: 'h1', from: 'a', to: 'c', by: 'a'});
  add({kind: 'handover', phase: 'transferred', handoverId: 'h1', from: 'a', to: 'c', by: 'a', taskIds: ['r/t1']});
  add({kind: 'stop', role: 'b', session: 'kadan-b', by: '사람'});
  start('b', {conversationMode: 'new'});
  add({kind: 'alert', by: 'watch', alertKind: 'quiet', role: 'w', taskId: 'r/t1'});
  add({kind: 'alert-update', by: 'watch', alertKind: 'quiet', role: 'w'});
  add({kind: 'alert-resolved', by: 'watch', alertKind: 'quiet', role: 'w'});
  add({kind: 'window', role: 'b', session: 'kadan-b', window: 'none'});
  add({kind: 'send-failed', role: 'b', session: 'kadan-b', keyDelivery: 'unknown', floor: 'tmux'});
  add({kind: 'revive', target: '비서', reason: 'restart', result: 'started', by: 'autostart'});
  add({kind: 'adopt', phase: 'accepted', adoptionId: 'ad-1', role: 'b', session: 'kadan-b', by: 'a'});
  add({kind: 'trust', role: 'b', session: 'kadan-b', result: 'accepted', by: 'a'});
  add({kind: 'compare-pick', pickId: 'pick-1', epoch: T1, preset: 'default', by: 'a'});
  add({kind: 'ocx-refresh', by: 'watch', provider: 'openai', outcome: 'refreshed'});
  add({kind: 'runner-settings', action: 'set', by: 'a', revision: 2});
  add({kind: 'hierarchy-prune', by: 'watch', removed: ['x']});
  add({kind: 'queue-resume', by: 'watch', role: 'w', taskId: 'r/t1'});
  add({kind: 'rate-limit-retry', by: 'watch', role: 'w', taskId: 'r/t1', attempt: 1});
  add({kind: 'advice', by: 'a', adviceId: 'adv-1'});
  add({kind: 'autopilot', phase: 'on', by: 'a'});
  add({kind: 'autopilot-note', by: 'a', note: 'x'});
  add({kind: 'autopilot-repo-policy', by: 'a', repo: 'r'});
  add({kind: 'autopilot-delivery', by: 'a', role: 'a'});
  add({kind: 'autopilot-summary', by: 'a'});
  add({kind: 'decision-proceed', by: 'a', role: 'a'});
  add({kind: 'reply-note', by: 'a', role: 'b', mailId: asked.mailId});
  new Mailbox(home, 'b').acknowledge(asked.mailId, 'b');
  new Mailbox(home, 'c').cancel(second.mailId, 'c'); // 보낸 쪽 a의 책임은 위 확정 인계로 c에게 갔다
  add({kind: 'done', role: 'w2', taskId: 'L1', result: 'ok', by: 'a'}, T2);
  add({kind: 'done', role: 'w', taskId: 'short', executionKey: 'fixture/short', result: 'ok', by: 'a'}, T2);
  add({kind: 'done', role: 'w', taskId: 'r/t1', executionKey: 'r/t1', result: 'failed', by: 'a'}, T2);
  // 완료 뒤에 적힌 줄의 주소는 앞선 완료 판정에 끼지 않는다. 변형이 이 값을 앞 줄에 붙이면 짧은 주소 short와 겹친다.
  add({kind: 'alert', by: 'watch', alertKind: 'quiet', role: 'w', taskId: 'other/short', executionKey: 'other/short'}, T2);
  const rows = STREAMS.flatMap(stream => readStream(home, stream, {optional: true}).map(value => ({stream, value})))
    .sort((x, y) => x.value._ledgerOrder - y.value._ledgerOrder || STREAMS.indexOf(x.stream) - STREAMS.indexOf(y.stream));
  return [...readStream(home, LEGACY).map(value => ({stream: LEGACY, value})), ...rows];
}

const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const withValue = (rows, at, value) => rows.map((row, k) => k === at ? {stream: row.stream, value} : row);
// 원장에 있는 한 칸의 서로 다른 값 전부.
function valuesOf(rows, key) {
  const seen = new Map();
  for (const row of rows) if (row.value && Object.hasOwn(row.value, key)) seen.set(JSON.stringify(row.value[key]), row.value[key]);
  return [...seen.values()];
}
// 값이 원장에 한 번도 없는 검사 칸에 붙일 값(그 칸이 뜻을 갖는 값).
const ATTACH_ONLY = {broken: [true], rawTaskId: ['attached-raw'], board: ['attached-board']};

// 변형 갈래: 지우기 / 틀린 값(다른 형·빈 값·null) / 다른 줄 값(kind 칸) / 다른 줄 값(그 밖의 칸) / 붙이기.
export function fieldVariants(rows) {
  const out = [];
  // 모델 분류(modelOf)는 변형마다 저장 함수를 실제로 부르므로, 고른 갈래를 대조할 때(compareAll) 한다. 여기서는 바꾼 자리와 값만 남긴다.
  const push = (family, name, at, value) => out.push({family, name, rows: withValue(rows, at, value), source: rows, at, value});
  rows.forEach((row, at) => {
    for (const key of Object.keys(row.value)) {
      const value = row.value[key], type = typeOf(value), {[key]: removed, ...rest} = row.value;
      push('delete', `지우기 ${label(row)}.${key}`, at, rest);
      const wrong = [['다른 형', type === 'string' ? 7 : 'x'],
        ['빈 값', type === 'string' ? '' : type === 'number' ? 0 : type === 'boolean' ? !value : type === 'array' ? [] : type === 'object' ? {} : ''],
        ['null', null]];
      for (const [how, next] of wrong) {
        if (!same(next, value)) push('wrong', `바꾸기(${how}) ${label(row)}.${key}`, at, {...row.value, [key]: next});
      }
      // 같은 칸의 다른 모든 줄 값. 검사가 읽는 칸만(그 밖의 칸은 값이 무엇이든 판정에 쓰이지 않는다 — 위의 지우기·틀린 값이 확인한다).
      if (!VALIDATOR_KEYS.includes(key)) continue;
      for (const next of valuesOf(rows, key)) {
        if (!same(next, value)) push(key === 'kind' ? 'kinds' : 'values', `바꾸기(다른 줄 값 ${JSON.stringify(next)}) ${label(row)}.${key}`, at, {...row.value, [key]: next});
      }
    }
    // 붙이기: 그 줄에 없는 검사 칸마다, 원장에 있는 그 칸의 모든 값을 붙인다.
    for (const key of VALIDATOR_KEYS) {
      if (Object.hasOwn(row.value, key)) continue;
      for (const next of [...valuesOf(rows, key), ...(ATTACH_ONLY[key] ?? [])]) {
        push('attach', `붙이기 ${label(row)}.${key}=${JSON.stringify(next)}`, at, {...row.value, [key]: next});
      }
    }
  });
  return out;
}

// 고정 원장이 겨냥한 줄을 담았는지 확인하고, 고른 갈래의 변형을 전부 대조한다.
// part/of: 변형이 많은 갈래를 여러 시험 파일이 나눠 돌린다(차례 번호를 of로 나눈 나머지가 part인 변형만).
export function runFieldFamily(t, families, {part = 0, of = 1} = {}) {
  const rows = fieldFixtureRows();
  const kinds = new Set(rows.filter(row => row.stream !== LEGACY).map(row => row.value.kind));
  for (const kind of PRODUCT_KINDS) assert.ok(kinds.has(kind), `${kind} 줄이 고정 원장에 있다`);
  const addresses = new Set(rows.map(row => row.value.taskId).filter(Boolean));
  for (const address of ['r/t1', 'short', 'other/unrelated', 'other/short', 'L1']) assert.ok(addresses.has(address), `작업 주소 ${address}`);
  assert.ok(rows.some(row => row.value.executionKey === 'fixture/short'), '짧은 주소의 정식 주소');
  assert.equal(rows.filter(row => row.value.systemGenerated === 'task-completion').length, 3, '자동 결과 우편 셋');
  const control = build(rows);
  for (const [name, narrow, full] of READERS) assert.deepEqual(narrow(control), full(control), `대조군 ${name}`);
  // 'rows' 갈래는 칸이 아니라 줄 변형(빼기·순번 겹치기·이웃 맞바꾸기)을 이 큰 고정 원장에 돌린다.
  const pool = families.includes('rows') ? rowVariants(rows).map(variant => ({family: 'rows', ...variant})) : fieldVariants(rows);
  const all = pool.filter(variant => families.includes(variant.family)).filter((_, index) => index % of === part);
  // 판정은 모델 표지와 무관하다: 모든 변형에서 전체 읽기가 거절하면 좁은 읽기도 같은 문구로 거절해야 한다(예외는 인계 읽기의 둘뿐).
  const {escapes, differs, counts} = compareAll(all);
  t.diagnostic(`${families.join('·')}${of > 1 ? ` ${part + 1}/${of}` : ''}: 변형 ${all.length}개 × 읽기 3종 = 비교 ${counts.compared}번`
    + `(표지: 모델 안 ${counts.variants.in}, 모델 밖 ${counts.variants.out}, 과거 원문 ${counts.variants.legacy}).`
    + ` 전체 읽기 거절 ${counts.rejected}건(표지별 안 ${counts.rejectedBy.in}·밖 ${counts.rejectedBy.out}·과거 원문 ${counts.rejectedBy.legacy}), 수용 ${counts.accepted}건,`
    + ` 허용 예외: 인계 읽기 ${counts.skipped}건·계산 중 죽음 ${counts.crashSkipped}건. 차이 ${escapes.length + differs.length}건`);
  assert.ok(all.length > 0 && counts.rejected > 0, `변형 ${all.length}개, 전체 읽기 거절 ${counts.rejected}건`);
  assert.equal(counts.compared, all.length * READERS.length);
  assert.deepEqual(escapes, [], `전체 읽기는 거절하고 좁은 읽기가 받은 경우 ${escapes.length}건`);
  assert.deepEqual(differs, [], `거절 문구가 다르거나 좁은 읽기만 거절하거나 받은 결과가 다른 경우 ${differs.length}건`);
  return {all, counts};
}
