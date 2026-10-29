import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger} from '../src/ledger.mjs';

// Why: 업무 마감(work complete)은 끝나지 않은 실행을 끝난 것으로 치면 안 된다.
// 카드 저장 상태 × 실행(원장 send/done) 조합마다 마감 허용·거절을 한 표로 고정한다.
const FUTURE = '2999-01-01T00:00:00Z';
const send = (home, role, taskId, key, t = FUTURE) => appendLedger({kind: 'send', by: '감독', role, taskId, executionKey: key, digest: `${role}-${taskId}`, t}, home);
const finish = (home, role, taskId, key, result, t = FUTURE) => appendLedger({kind: 'done', by: role, role, taskId, executionKey: key, result, t}, home);

function fixture(status, runs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-work-close-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new WorkStore(home), cards = new CardStore(home);
  const work = store.create({key: 'repo/w', title: '업무', goal: '결과', scope: '범위', acceptance: '조건', owner: '감독', repoPath: home});
  const change = (action, fields = {}) => store.change(work.key, action, fields, {revision: store.get(work.key).revision, by: '감독', note: '확인'});
  change('execute', {title: '실행', body: '본문', phase: 'implementation', round: '1'});
  const key = store.get(work.key).executions[0].key, id = key.split('/')[1];
  if (status !== 'assigned') cards.update(key, {status, scope: '범위', ...(status === 'superseded' ? {replacedByText: '후속 업무가 이어받음'} : {})}, {revision: cards.get(key).revision, note: '상태 설정', by: '감독'});
  runs({home, key, id});
  return {home, key, change};
}
const R = {
  none: () => {},
  oneOpen: ({home, key, id}) => send(home, 'A', id, key),
  allDone: ({home, key, id}) => { send(home, 'A', id, key); finish(home, 'A', id, key, 'ok'); },
  failedOnly: ({home, key, id}) => { send(home, 'A', id, key); finish(home, 'A', id, key, 'failed'); },
  failedPlusOpen: ({home, key, id}) => { send(home, 'A', id, key); finish(home, 'A', id, key, 'failed'); send(home, 'B', id, key); },
  failedPlusDone: ({home, key, id}) => { send(home, 'A', id, key); finish(home, 'A', id, key, 'failed'); send(home, 'B', id, key); finish(home, 'B', id, key, 'ok'); },
};

// [카드 저장 상태, 실행 조합, 마감 허용]
// 실행이 없으면 카드 상태가 그대로 표시 상태다. 실행이 새로 있으면 표시 상태는 실행에서 나온다.
const MATRIX = [
  ['draft', 'none', false], ['ready', 'none', false], ['hold', 'none', false], ['archived', 'none', false],
  ['assigned', 'none', false], ['done', 'none', true], ['cancelled', 'none', true], ['superseded', 'none', true],
  ['draft', 'oneOpen', false], ['archived', 'oneOpen', false], ['done', 'oneOpen', false],
  ['draft', 'allDone', true], ['archived', 'allDone', true], ['ready', 'allDone', true],
  ['archived', 'failedOnly', true], ['ready', 'failedOnly', true],
  ['archived', 'failedPlusOpen', false], ['ready', 'failedPlusOpen', false], ['hold', 'failedPlusOpen', false],
  ['ready', 'failedPlusDone', true],
];
for (const [status, runs, allowed] of MATRIX) {
  test(`마감 행렬: 카드 ${status} × 실행 ${runs} → ${allowed ? '허용' : '거절'}`, () => {
    const {change} = fixture(status, R[runs]);
    if (allowed) assert.equal(change('complete', {result: '근거'}).status, 'done');
    else assert.throws(() => change('complete', {result: '근거'}), /끝나지 않은 실행/);
  });
}

test('V2: 보류(archived) 카드만 있는 업무는 마감하지 못한다', () => {
  const {change} = fixture('archived', R.none);
  assert.throws(() => change('complete', {result: '근거'}), /끝나지 않은 실행/);
});

test('V1: failed 뒤 다른 담당으로 다시 보낸 미완료 실행이 있으면 거절하고 실행 ID·상태·다음 행동을 알린다', () => {
  const {change, key} = fixture('ready', R.failedPlusOpen);
  assert.throws(() => change('complete', {result: '근거'}), err => {
    assert.match(err.message, new RegExp(key));
    assert.match(err.message, /unconfirmed|orphaned|보류|초안|설계완료/);
    assert.match(err.message, /인계|취소|완료 확정/);
    return true;
  });
});

test('V8 회귀: 미완료 A → 담당 B 변경 → B 성공이어도 마감 거절, 명시 인계(수동 완료 확정) 뒤에는 허용', () => {
  const {home, key, change} = fixture('ready', ({home, key, id}) => { const past = '2020-01-01T00:00:00Z'; send(home, 'A', id, key, past); send(home, 'B', id, key, past); finish(home, 'B', id, key, 'ok', past); });
  assert.throws(() => change('complete', {result: '근거'}), /끝나지 않은 실행/);
  new CardStore(home).update(key, {status: 'done'}, {revision: new CardStore(home).get(key).revision, note: '인계 뒤 완료 확정', by: '감독'});
  assert.equal(change('complete', {result: '근거'}).status, 'done');
});
