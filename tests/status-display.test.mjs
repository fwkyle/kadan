import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {buildCardCenter} from '../src/card-center.mjs';
import {workDashboardModel} from '../src/work-dashboard.mjs';
import {buildWorkStatus} from '../src/work-status-message.mjs';

// Why: 업무 마감 판정(closableExecution)은 failed 뒤 다른 담당에게 다시 보낸 미완료 실행을 '열린 실행'으로 본다.
// 대시보드 종료 수·차례와 업무 상태 글의 '실패로 끝난' 수도 같은 기준으로 보여야 사람이 잘못 읽지 않는다.
const FUTURE = '2999-01-01T00:00:00Z';
const send = (home, role, taskId, key) => appendLedger({kind: 'send', by: '감독', role, taskId, executionKey: key, digest: `${role}-${taskId}`, t: FUTURE}, home);
const finish = (home, role, taskId, key, result) => appendLedger({kind: 'done', by: role, role, taskId, executionKey: key, result, t: FUTURE}, home);

function fixture(runs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-status-display-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new WorkStore(home), cards = new CardStore(home);
  const work = store.create({key: 'repo/w', title: '업무', goal: '결과', scope: '범위', acceptance: '조건', owner: '감독', repoPath: home});
  store.change(work.key, 'execute', {title: '실행', body: '본문', phase: 'implementation', round: '1'},
    {revision: store.get(work.key).revision, by: '감독', note: '확인'});
  const key = store.get(work.key).executions[0].key, id = key.split('/')[1];
  cards.update(key, {status: 'ready', scope: '범위'}, {revision: cards.get(key).revision, note: '상태 설정', by: '감독'});
  runs({home, key, id});
  const center = buildCardCenter({cards: cards.list(), entries: readLedger(home), tree: []});
  return {home, work, store, center};
}
const failedPlusOpen = ({home, key, id}) => { send(home, 'A', id, key); finish(home, 'A', id, key, 'failed'); send(home, 'B', id, key); };
const ambiguousFailed = ({home, key, id}) => {
  new CardStore(home).create({repo: 'other', id, repoPath: home, title: '동일 짧은 ID', body: '본문'});
  send(home, 'A', id, key); finish(home, 'A', id, key, 'failed');
  appendLedger({kind: 'send', by: '감독', role: 'C', taskId: id, digest: 'C', t: FUTURE}, home);
};
const failedOnly = ({home, key, id}) => { send(home, 'A', id, key); finish(home, 'A', id, key, 'failed'); };

test('R1: failed 뒤 미완료 실행이 남은 업무는 종료 수에 안 들어가고 차례 계산에 남는다', () => {
  const {home, store, center} = fixture(failedPlusOpen);
  const model = workDashboardModel(store.list(), center, readLedger(home))[0];
  assert.equal(center.cards[0].displayState, 'failed');
  assert.equal(model.ended.length, 0);
  assert.equal(model.active.length, 1);
  assert.match(model.flowPhase, /실행 0\/1건 종료 · 남은 실행 1건/);
  assert.notEqual(model.turnLabel, '종료');
});

test('R1: 끝난 실패(열린 실행 없음)는 그대로 종료로 센다', () => {
  const {home, store, center} = fixture(failedOnly);
  const model = workDashboardModel(store.list(), center, readLedger(home))[0];
  assert.equal(model.ended.length, 1);
  assert.equal(model.active.length, 0);
});

test('R2: 열린 실패 실행은 열린 목록에만 있고 "실패로 끝난 실행"에는 안 센다', () => {
  const {home} = fixture(failedPlusOpen);
  const text = buildWorkStatus(home, 'repo/w').content;
  assert.match(text, /열린 실행 1건/);
  assert.doesNotMatch(text, /실패로 끝난 실행/);
});

test('R2: 끝난 실패는 "실패로 끝난 실행"에 센다', () => {
  const {home} = fixture(failedOnly);
  const text = buildWorkStatus(home, 'repo/w').content;
  assert.match(text, /실패로 끝난 실행: 1건/);
  assert.match(text, /열린 실행: 없음/);
});

test('R1·R2: 실행 연결이 모호한 failed 카드는 열린 쪽 한 곳에만 센다(마감 판정과 같은 기준)', () => {
  const {home, store, center} = fixture(ambiguousFailed);
  const card = center.cards.find(c => c.key === store.list()[0].executions[0].key);
  assert.equal(card.ambiguous, true);
  assert.equal(card.displayState, 'failed');
  const model = workDashboardModel(store.list(), center, readLedger(home))[0];
  assert.equal(model.ended.length, 0);
  assert.equal(model.active.length, 1);
  const text = buildWorkStatus(home, 'repo/w').content;
  assert.match(text, /열린 실행 1건/);
  assert.doesNotMatch(text, /실패로 끝난 실행/);
});

// --- W1: kadan wait 출력은 카드마다 최종 결과 하나를 보이고, 원장 기록은 그대로다 ---
const {runWaitLoop, waitMarkerLines} = await import('../src/cli-wait-done.mjs');
test('W1: 같은 카드 ok→failed 마커는 출력에 최종 failed 하나와 바뀜 표시만 보이고 원장 기록은 하나다', () => {
  const recorded = [];
  const text = 'KADAN:DONE a ok\nKADAN:DONE a failed\n';
  const floor = {name: 'fake', read: () => ({text, cursor: 'c', incremental: false}), waitForChange() {}};
  const result = runWaitLoop({floor, session: 'kadan-w', role: 'w', intervalMs: 1, timeoutMs: 1000, quietMs: 500,
    baselineMarkers: [], cards: [{key: 'repo/a', id: 'a'}], record: e => recorded.push(e)});
  assert.equal(result.markers.length, 2, '반환 markers는 그대로');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].result, 'failed');
  const lines = waitMarkerLines(result.final);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /결과=failed/);
  assert.match(lines[0], /앞선 결과 ok는 나중 결과로 바뀜/);
  assert.doesNotMatch(lines[0], /결과=ok/);
});

test('W1: 마커가 하나면 출력 줄은 전과 같다', () => {
  assert.deepEqual(waitMarkerLines([{taskId: 'a', result: 'ok', earlier: []}]), ['완료 마커: taskId=a 결과=ok']);
});

test('W1: 같은 결과가 반복되면 바뀜 문구를 붙이지 않고 결과가 다른 앞 결과만 밝힌다', () => {
  assert.deepEqual(waitMarkerLines([{taskId: 'a', result: 'ok', earlier: ['ok']}]), ['완료 마커: taskId=a 결과=ok']);
  assert.deepEqual(waitMarkerLines([{taskId: 'a', result: 'failed', earlier: ['ok', 'ok', 'failed']}]),
    ['완료 마커: taskId=a 결과=failed (앞선 결과 ok는 나중 결과로 바뀜)']);
});
