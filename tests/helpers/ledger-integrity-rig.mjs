// 좁은 읽기 무결성 시험(tests/ledger-narrow-integrity*.test.mjs)이 함께 쓰는 도구.
// 변형 원장을 만들고, 읽기 3종(우편함·전송 길·인계)을 전체 읽기와 대조하고, 변형이 손상 모델 안인지 가른다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {appendLedger, readLedger, readMailboxLedger, readSendLedger,
  readMailboxLedgerNarrow, readSendLedgerNarrow, readHandoverLedger} from '../../src/ledger.mjs';
import {validateDomainEvent} from '../../src/ledger-domains.mjs';
import {createDatabase, writeStorageMarker, appendStream, readStream, storageTransaction} from '../../src/storage.mjs';

export const STREAMS = ['tasks/events.jsonl', 'mail/events.jsonl', 'system/events.jsonl'];
export const LEGACY = 'ledger.jsonl';
export const freshHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-integrity-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  return home;
};
// 변형 하나마다 원장을 새로 만든다. 줄마다 따로 저장하면 느려서 한 번의 쓰기 트랜잭션으로 넣는다(줄 내용·순서는 같다).
export function build(rows) {
  const home = freshHome();
  storageTransaction(home, () => { for (const {stream, value} of rows) appendStream(home, stream, value); });
  return home;
}
export const outcome = read => { try { return {value: read()}; } catch (error) { return {error: error.message}; } };
export const message = read => outcome(read).error ?? null;
export const label = row => row.stream === LEGACY ? `과거 원문:${row.value.kind}` : `${row.stream.split('/')[0]}:${row.value.kind}#${row.value._ledgerOrder}`;

const handoversOf = home => readLedger(home).filter(entry => entry?.kind === 'handover');
// [이름, 좁은 읽기, 같은 결과를 내야 하는 전체 읽기]
export const READERS = [
  ['우편함', readMailboxLedgerNarrow, readMailboxLedger],
  ['전송 길', readSendLedgerNarrow, readSendLedger],
  ['인계', readHandoverLedger, handoversOf],
];
// 일부러 남기는 차이: 인계 읽기는 우편·완료 줄을 풀지 않으므로 완료 우편과 done의 연결 손상은 보고하지 않는다.
// (업무 책임자 계산은 확정 인계만 본다. 순번 빠짐·중복·send/dispatch 짝은 인계 읽기도 막는다.)
export const HANDOVER_SKIPS = /완료 우편|완료 사건/;
// 같은 종류의 한 경우: 전체 읽기가 완료 우편의 원발령을 다시 계산하다가 죽는 손상(실행 주소·작업 ID가 글자가 아닌 줄).
// 전체 읽기는 이 오류로 멈추고, 완료 우편 연결을 계산하지 않는 인계 읽기는 멈추지 않는다. 우편함·전송 길 읽기는 같은 오류로 멈춘다.
// 칸 변형의 큰 고정 원장에서는 이 경우가 2건이다(완료 우편이 달린 done의 실행 주소·작업 ID를 글자가 아닌 값으로 바꾼 변형).
// 이 2건의 모델 표지는 '밖'이다(저장 함수도 그런 done을 완료 우편과 함께 기록하지 못한다). 표지와 무관하게 예외로 센다.
// 두 예외 모두 "같은 명령의 준비 읽기(전송 길 좁은 읽기)가 같은 문구로 먼저 막는다"를 변형마다 단언한 뒤에만 넘어간다(compareAll).
export const HANDOVER_SKIP_CRASH = /^address\?\.includes is not a function$/;

// 전체 읽기 검사(src/ledger-domains.mjs validateDomainEvent·createDomainValidator·createCompletionIndex·completionRequest)가 읽는 칸.
export const VALIDATOR_KEYS = ['kind', 'broken', '_ledgerOrder', 'mailId', 'dispatchId', 'taskId', 'rawTaskId', 'executionKey', 'workKey', 'board',
  't', 'role', 'by', 'transport', 'completion', 'systemGenerated', 'replyFinal', 'replyTo', 'completionMailId', 'completionTaskId', 'result',
  'phase', 'taskIds', 'handoverId', 'from', 'to'];

// 손상 모델(감독 결정): 저장 함수(appendLedger)가 받아 주는 줄로만 된 원장과, 거기서 줄이 빠지거나 순번이 겹치거나
// 뒤바뀐 원장이 "모델 안"이다. 저장 함수가 거절할 줄이 직접 들어간 원장은 "모델 밖"이다.
// **이 분류는 결과에 붙이는 표지다. 판정(compareAll)은 분류를 보지 않고 모든 변형을 엄격하게 대조한다.**
// 표지의 한계: "그 줄만 뺀 지금 원장"에 넣어 보므로, 지금은 빠진 다른 줄이 있었을 때만 만들어지는 줄은 '밖'으로 적힌다
// (예: 앞선 발령 우편이 빠진 뒤의 done — 재검수 exec-7145e9ed). 그래서 표지에 기대어 변형을 빼지 않는다.
// 칸 하나를 바꾼 줄이 모델 안인지는 **바뀐 줄을 제품 저장 함수에 실제로 넣어 보고** 정한다(따로 짠 규칙을 두지 않는다).
// 바꾸기 전 줄이 어떻게 생긴 줄이었는지(호출자가 준 줄인지, 저장 함수가 스스로 만든 발령 짝·자동 결과 우편인지)는 보지 않는다.
//  1) 그 줄만 뺀 나머지 줄로 원장을 만든다(우편 ID 중복 검사와 완료 우편 계산이 실제 원장을 보게).
//  2) 바뀐 줄을 appendLedger에 넣는다. 저장 함수가 스스로 매기는 칸은 빼고 넣는다: 순번(_ledgerOrder — 호출자가 주면 거절),
//     그리고 바꾸기 전 줄에 달려 있던 값 그대로인 completionMailId(저장 함수가 done에 달아 주는 값 — 호출자가 주면 거절).
//  3) 저장 함수가 거절하면 모델 밖. 받았더라도 그 영역에 기록된 줄이 바뀐 줄과 다르면(저장 함수가 우편 ID를 채우거나 발령 ID를
//     덮어쓰거나 완료 우편 ID를 달지 않거나, 다른 영역에 기록하면) 저장 함수가 만들 수 없는 줄이므로 모델 밖. 칸·값이 그대로 기록되면 모델 안이다.
//  4) 순번은 저장 함수가 매기므로 2)에서 뺐다. 바뀐 줄의 순번 값 자체는 저장 함수가 저장 직전에 부르는 줄 검증
//     (validateDomainEvent — 양의 정수)에 바뀐 줄을 그대로 넣어 본다. 순번이 다른 줄과 겹치거나 뒤바뀐 것은 모델 안이다(줄 변형).
// 그래서 호출자가 줄 수 없는 꼴(kind가 dispatch, systemGenerated가 task-completion, 새로 달거나 바꾼 completionMailId)은
// 저장 함수가 거절하는 대로 모델 밖이 되고, 자동 결과 우편에서 그 표지만 지운 줄(일반 보관 우편)은 저장 함수가 받는 대로 모델 안이 된다.
// 과거 원문 영역(ledger.jsonl)은 저장 함수를 거치지 않고 옮겨 온 줄이라 따로 센다('legacy'). 판정은 모델 안과 같이 엄격하게 한다.
const ASSIGNED = ['_ledgerOrder'];
export function storedAs(rows, at, mutated) {
  const {stream, value: original} = rows[at];
  if (!mutated || typeof mutated !== 'object' || Array.isArray(mutated)) return {error: '줄이 객체가 아님'};
  const carried = Object.hasOwn(mutated, 'completionMailId') && Object.hasOwn(original, 'completionMailId')
    && isDeepStrictEqual(mutated.completionMailId, original.completionMailId);
  const assigned = carried ? [...ASSIGNED, 'completionMailId'] : ASSIGNED;
  const strip = value => Object.fromEntries(Object.entries(value).filter(([key]) => !assigned.includes(key)));
  const home = build(rows.filter((_, k) => k !== at));
  try {
    const before = readStream(home, stream, {optional: true}).length;
    // 시각(t)은 저장 함수가 기본값으로 채우지만 호출자가 비워 주면(t: undefined) 채우지 않는다. 바뀐 줄에 t가 없으면 그렇게 넣는다.
    appendLedger({t: undefined, ...strip(mutated)}, home);
    const fresh = readStream(home, stream, {optional: true}).slice(before);
    const stored = fresh.find(row => isDeepStrictEqual(strip(row), strip(mutated))
      && assigned.every(key => Object.hasOwn(row, key) === Object.hasOwn(mutated, key)));
    if (!stored) return {error: '저장 함수가 기록한 줄이 바뀐 줄과 다름', fresh};
    validateDomainEvent(stream, mutated);
    return {stored};
  } catch (error) {
    return {error: error.message};
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
}
export function modelOf(rows, at, mutated) {
  if (rows[at].stream === LEGACY) return 'legacy';
  return storedAs(rows, at, mutated).stored ? 'in' : 'out';
}

// 줄 변형(손상 모델 안): 줄 하나 빼기(과거 원문 줄 포함), 한 줄의 순번을 다른 줄과 겹치기(모든 줄 짝), 이웃한 두 줄의 순번 맞바꾸기.
// 줄의 내용은 그대로이고(저장 함수가 기록한 줄), 모델이 허용하는 "빠짐·겹침·뒤바뀜"만 만든다. 그래서 만들 때 모델 안으로 정한다.
export function rowVariants(rows) {
  const out = [];
  rows.forEach((row, i) => out.push({name: `빼기 ${label(row)}`, rows: rows.filter((_, k) => k !== i), model: row.stream === LEGACY ? 'legacy' : 'in'}));
  rows.forEach((row, i) => rows.forEach((other, j) => {
    if (i === j || row.stream === LEGACY || other.stream === LEGACY || row.value._ledgerOrder === other.value._ledgerOrder) return;
    out.push({name: `겹치기 ${label(row)} → ${other.value._ledgerOrder}`,
      rows: rows.map((r, k) => k === i ? {stream: r.stream, value: {...r.value, _ledgerOrder: other.value._ledgerOrder}} : r), model: 'in'});
  }));
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.stream === LEGACY || b.stream === LEGACY || a.value._ledgerOrder === b.value._ledgerOrder) continue;
    out.push({name: `맞바꾸기 ${label(a)} ↔ ${label(b)}`, rows: rows.map((r, k) =>
      k === i ? {stream: r.stream, value: {...r.value, _ledgerOrder: b.value._ledgerOrder}}
        : k === i + 1 ? {stream: r.stream, value: {...r.value, _ledgerOrder: a.value._ledgerOrder}} : r), model: 'in'});
  }
  return out;
}

// 변형마다 읽기 3종을 전체 읽기와 대조한다. **모델 분류와 무관하게 모든 변형을 엄격하게 본다**:
// 전체 읽기가 거절하면 좁은 읽기도 같은 문구로 거절해야 하고, 전체 읽기가 받으면 좁은 읽기도 받고 결과가 같아야 한다.
// 분류(modelOf)는 결과를 읽을 때 쓰는 표지일 뿐 판정에 쓰지 않는다(분류가 틀려도 반례를 놓치지 않게 — 재검수 exec-f499dedf·exec-7145e9ed).
// 분류가 아직 없는 칸 변형(variant.at·variant.value가 있다)은 여기서 modelOf로 표지를 단다. 줄 변형은 만들 때 모델 안으로 적혀 있다.
// 허용하는 예외는 인계 읽기의 둘뿐이다(HANDOVER_SKIPS·HANDOVER_SKIP_CRASH, 전송 길 좁은 읽기가 같은 문구로 먼저 막는 경우만).
// escapes = 전체는 거절하는데 좁은 읽기가 받음, differs = 문구가 다르거나 좁은 읽기만 거절하거나 받은 결과가 다름.
export function compareAll(all) {
  const escapes = [], differs = [];
  const tally = () => ({in: 0, out: 0, legacy: 0});
  const counts = {variants: tally(), compared: 0, rejected: 0, rejectedBy: tally(), accepted: 0, skipped: 0, crashSkipped: 0};
  for (const variant of all) {
    const model = variant.model ?? modelOf(variant.source, variant.at, variant.value);
    counts.variants[model]++;
    const home = build(variant.rows), slimErrors = {};
    for (const [name, narrow, full] of READERS) {
      const wide = outcome(() => full(home)), slim = outcome(() => narrow(home));
      slimErrors[name] = slim.error;
      counts.compared++;
      const where = `${variant.name} / ${name} [표지 ${model}]`;
      if (wide.error === undefined) {
        counts.accepted++;
        if (slim.error !== undefined) differs.push(`${where}: 전체는 받고 좁은 읽기는 "${slim.error}"`);
        else if (!isDeepStrictEqual(slim.value, wide.value)) differs.push(`${where}: 둘 다 받았지만 결과가 다름`);
        continue;
      }
      counts.rejected++; counts.rejectedBy[model]++;
      if (slim.error !== undefined) {
        if (slim.error !== wide.error) differs.push(`${where}: 전체 "${wide.error}" 좁은 "${slim.error}"`);
        continue;
      }
      // 인계 읽기의 예외는 "같은 명령의 준비 읽기(전송 길 좁은 읽기)가 먼저 같은 문구로 막는다"는 전제에서만 허용한다.
      const skip = name === '인계' && (HANDOVER_SKIPS.test(wide.error) ? 'skipped' : HANDOVER_SKIP_CRASH.test(wide.error) ? 'crashSkipped' : null);
      if (skip && slimErrors['전송 길'] === wide.error) { counts[skip]++; continue; }
      escapes.push(`${where}: 전체 "${wide.error}" 좁은 읽기는 받음${skip ? ` (전송 길 좁은 읽기는 "${slimErrors['전송 길']}")` : ''}`);
    }
    fs.rmSync(home, {recursive: true, force: true});
  }
  return {escapes, differs, counts};
}
