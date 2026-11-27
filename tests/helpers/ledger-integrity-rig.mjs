// 좁은 읽기 무결성 시험(tests/ledger-narrow-integrity*.test.mjs)이 함께 쓰는 도구.
// 변형 원장을 만들고, 읽기 3종(우편함·전송 길·인계)을 전체 읽기와 대조하고, 변형이 손상 모델 안인지 가른다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readLedger, readMailboxLedger, readSendLedger,
  readMailboxLedgerNarrow, readSendLedgerNarrow, readHandoverLedger} from '../../src/ledger.mjs';
import {validateDomainEvent} from '../../src/ledger-domains.mjs';
import {createDatabase, writeStorageMarker, appendStream, storageTransaction} from '../../src/storage.mjs';

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
// 두 예외 모두 "같은 명령의 준비 읽기(전송 길 좁은 읽기)가 같은 문구로 먼저 막는다"를 변형마다 단언한 뒤에만 넘어간다(compareAll).
export const HANDOVER_SKIP_CRASH = /^address\?\.includes is not a function$/;

// 전체 읽기 검사(src/ledger-domains.mjs validateDomainEvent·createDomainValidator·createCompletionIndex·completionRequest)가 읽는 칸.
export const VALIDATOR_KEYS = ['kind', 'broken', '_ledgerOrder', 'mailId', 'dispatchId', 'taskId', 'rawTaskId', 'executionKey', 'workKey', 'board',
  't', 'role', 'by', 'transport', 'completion', 'systemGenerated', 'replyFinal', 'replyTo', 'completionMailId', 'completionTaskId', 'result',
  'phase', 'taskIds', 'handoverId', 'from', 'to'];

// 손상 모델(감독 결정): 저장 함수(appendDomainLedger)가 받아 주는 줄로만 된 원장과, 거기서 줄이 빠지거나 순번이 겹치거나
// 뒤바뀐 원장이 "모델 안"이다. 저장 함수가 거절할 줄이 직접 들어간 원장은 "모델 밖"이다.
// 칸 하나를 바꾼 줄이 모델 안인지: 저장 함수의 줄 검증과 거절 규칙(src/ledger-domains.mjs appendDomainLedger)을 그대로 적용한다.
//  - validateDomainEvent(stream, 줄)을 통과해야 한다(저장 직전에 같은 함수를 부른다).
//  - 호출자가 줄 수 없는 칸: completionMailId, systemGenerated === 'task-completion'(저장 함수가 거절), kind === 'dispatch'(직접 기록 금지).
//  - 저장 함수가 스스로 만드는 줄(dispatch, 자동 결과 우편)은 호출자가 쓸 수 없으므로 고친 꼴은 모두 모델 밖이다.
//  - 같은 우편 ID를 한 번 더 쓰는 send도 저장 함수가 거절한다.
// 과거 원문 영역(ledger.jsonl)은 저장 검증 없이 옮겨 온 줄이라 따로 센다('legacy'). 판정은 모델 안과 같이 엄격하게 한다.
export function modelOf(rows, at, mutated) {
  const {stream, value: original} = rows[at];
  if (stream === LEGACY) return 'legacy';
  const generated = value => value?.kind === 'dispatch' || value?.systemGenerated === 'task-completion';
  if (generated(original) || generated(mutated)) return 'out';
  if (message(() => validateDomainEvent(stream, mutated)) !== null) return 'out';
  if (Object.hasOwn(mutated, 'completionMailId') && mutated.completionMailId !== original.completionMailId) return 'out';
  if (mutated.kind === 'send' && mutated.mailId !== original.mailId
    && rows.some((row, k) => k !== at && row.value?.kind === 'send' && row.value.mailId === mutated.mailId)) return 'out';
  return 'in';
}

// 줄 변형(손상 모델 안): 줄 하나 빼기(과거 원문 줄 포함), 한 줄의 순번을 다른 줄과 겹치기(모든 줄 짝), 이웃한 두 줄의 순번 맞바꾸기.
export function rowVariants(rows) {
  const out = [];
  rows.forEach((row, i) => out.push({name: `빼기 ${label(row)}`, rows: rows.filter((_, k) => k !== i), model: row.stream === LEGACY ? 'legacy' : 'in'}));
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

// 변형마다 읽기 3종을 전체 읽기와 대조한다. variant.model이 'out'이면 차이를 세기만 하고, 그 밖('in'·'legacy'·없음)은 엄격하게 본다.
// escapes = 전체는 거절하는데 좁은 읽기가 받음, differs = 문구가 다르거나 좁은 읽기만 거절.
export function compareAll(all) {
  const escapes = [], differs = [], outside = [];
  const counts = {variants: {in: 0, out: 0, legacy: 0}, rejected: 0, accepted: 0, skipped: 0, crashSkipped: 0, outsideRejected: 0};
  for (const variant of all) {
    const model = variant.model ?? 'in', strict = model !== 'out';
    counts.variants[model]++;
    const home = build(variant.rows), slimErrors = {};
    for (const [name, narrow, full] of READERS) {
      const wide = outcome(() => full(home)), slim = outcome(() => narrow(home));
      slimErrors[name] = slim.error;
      const note = text => (strict ? differs : outside).push(`${variant.name} / ${name}: ${text}`);
      if (wide.error === undefined) {
        if (strict) counts.accepted++;
        if (slim.error !== undefined) note(`전체는 받고 좁은 읽기는 "${slim.error}"`);
        else if (strict) assert.deepEqual(slim.value, wide.value, `${variant.name} / ${name}`);
        continue;
      }
      if (strict) counts.rejected++; else counts.outsideRejected++;
      if (slim.error !== undefined) {
        if (slim.error !== wide.error) note(`전체 "${wide.error}" 좁은 "${slim.error}"`);
        continue;
      }
      // 인계 읽기의 예외는 "같은 명령의 준비 읽기(전송 길 좁은 읽기)가 먼저 같은 문구로 막는다"는 전제에서만 허용한다.
      const skip = name === '인계' && (HANDOVER_SKIPS.test(wide.error) ? 'skipped' : HANDOVER_SKIP_CRASH.test(wide.error) ? 'crashSkipped' : null);
      if (skip && slimErrors['전송 길'] === wide.error) { if (strict) counts[skip]++; continue; }
      (strict ? escapes : outside).push(`${variant.name} / ${name}: 전체 "${wide.error}" 좁은 읽기는 받음`
        + `${skip ? ` (전송 길 좁은 읽기는 "${slimErrors['전송 길']}")` : ''}`);
    }
    fs.rmSync(home, {recursive: true, force: true});
  }
  return {escapes, differs, outside, counts};
}
