import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collectRoles} from '../src/watch-roles.mjs';
import {buildWatchScope} from '../src/watch-scope.mjs';
import {assessMissingStartReports} from '../src/watch-start-report.mjs';
import {assessIdleStop, readStatusLine} from '../src/watch-status-line.mjs';
import {startDigest} from '../src/secretary-resume.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {readLedgerIncremental} from '../src/ledger-incremental.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {taskIdentity, taskConnectionError} from '../src/task-identity.mjs';
import {watchRoleState} from '../src/watch-role-facts.mjs';
import {ownerGenerations, isPreviousOwner} from '../src/owner-generation.mjs';

// kadan reopen으로 다시 연 역할은 같은 대화를 이어 연 같은 정체다. 끄기 전에 받고 끝내지 않은 카드의 발령을
// kadan restart처럼 이어받아, 감시 대상(buildWatchScope)과 완료 판정용 발령(collectRoles)이 갈라지지 않아야 한다.
// 이어받는 것은 reopen의 start가 "바로 앞에 꺼진 그 세대"를 가리킬 때뿐이다: 지금 세대가 꺼져 있고,
// reopenOf가 그 세션의 마지막 start 사건의 지문과 같아야 한다. 저장 상태·옛 프로그램 혼용은 watch-reopen-state.test.mjs.
const ID = '0197aaaa-1111-4222-8333-444455556666';
const role = 'watchproof', session = `kadan-${role}`;
const card = {key: 'probe/c1', id: 'c1', repo: 'probe', status: 'assigned', role};
const start = {kind: 'start', role, session, floor: 'tmux', panePid: '100', cmd: 'codex --model test-model', t: '2026-11-10T00:00:00Z'};
const send = {kind: 'send', role, session, taskId: 'c1', executionKey: card.key, t: '2026-11-10T00:01:00Z'};
const stop = {kind: 'stop', role, session, conversation: ID, conversationStart: startDigest(start), t: '2026-11-10T00:02:00Z'};
const reopened = (extra = {}) => ({...start, panePid: '200', cmd: `codex --model test-model resume ${ID}`,
  conversationMode: 'resume', conversationRef: ID, reopenOf: startDigest(start), reopenStopAt: stop.t, reopenConversation: ID,
  t: '2026-11-10T00:03:00Z', ...extra});
const screen = '• KADAN:DONE c1 ok\n›\n  gpt-test · 100% left';
const now = Date.parse('2026-11-10T00:10:00Z');

// 검수 재현(watch-reopen-probe)과 같은 조건: 착수 보고 없는 assigned 카드, 화면에는 완료 문구와 빈 입력창.
function judge(entries, pid) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-reopen-'));
  const floor = {list: () => [{session, pid, alive: true}], read: () => screen};
  const scope = buildWatchScope([card], entries);
  const observations = collectRoles(floor, entries, scope.sessions, [card], {hookHome: root}).observations;
  const observation = observations.get(session);
  const alerts = assessMissingStartReports([card], entries, observations, now, 5 * 60000,
    {states: new Map([[session, {unchangedMs: 5 * 60000}]]), hookHome: root});
  const idle = assessIdleStop(new Map([[session, {digest: observation.digest, idleMs: 15 * 60000}]]), observations,
    {elapsedMs: 1000, intervalMs: 1000, afterMs: 15 * 60000, tasks: scope.entries, entries});
  return {scopeTasks: scope.entries.length, dispatches: [...observation.completionDispatches.keys()], doneMarker: observation.doneMarker,
    status: readStatusLine(screen).kind, missingStart: alerts.map(a => a.kind), idle: idle.alerts.map(a => a.kind)};
}

test('reopen 전후로 감시 판정이 같다: 감시 대상·완료 판정용 발령·완료 후보·시작보고누락·멈춤', () => {
  const before = judge([start, send], '100');
  const after = judge([start, send, stop, reopened()], '200');
  assert.deepEqual(before, {scopeTasks: 1, dispatches: ['probe/c1'], doneMarker: {taskId: 'c1', result: 'ok'},
    status: 'idle', missingStart: [], idle: []});
  assert.deepEqual(after, before, '다시 연 뒤에도 같은 카드의 완료 문구를 알아보고 경보가 없다');
  // 놀고 있음(감독의 할 일 계산, watch-supervisor.mjs)과 대시보드 상태는 발령 상태가 아니라 책임 세대를 본다.
  // reopen의 start는 같은 대화 resume이라 그 세대 경계가 생기지 않는다: 끄기 전에 붙은 책임이 전후로 같은 세대다.
  for (const entries of [[start, send], [start, send, stop, reopened()]])
    assert.equal(isPreviousOwner(ownerGenerations(entries), role, send.t), false);
});

test('발령을 이어받는 것은 reopenOf가 바로 앞에 꺼진 세대의 start를 가리킬 때뿐이다', () => {
  const dispatches = entries => judge(entries, '200').dispatches;
  // 지문이 다른(다른 세대를 가리키는) reopenOf.
  assert.deepEqual(dispatches([start, send, stop, reopened({reopenOf: 'f'.repeat(64)})]), []);
  // reopenOf 없이 같은 resume 명령으로 사람이 직접 연 start(kadan start --cmd)는 예전 그대로 새로 센다.
  assert.deepEqual(dispatches([start, send, stop, reopened({reopenOf: undefined, reopenStopAt: undefined, reopenConversation: undefined})]), []);
  // 사이에 다른 세대(B)가 떴다 꺼졌으면, A를 가리키는 reopen은 B의 발령도 A의 발령도 이어받지 않는다.
  const b = {...start, panePid: '150', cmd: 'codex --model test-model', t: '2026-11-10T00:02:10Z'};
  const sendB = {...send, taskId: 'c2', executionKey: 'probe/c2', t: '2026-11-10T00:02:20Z'};
  const stopB = {kind: 'stop', role, session, conversationMissing: 'undetermined', t: '2026-11-10T00:02:30Z'};
  assert.deepEqual(dispatches([start, send, stop, b, sendB, stopB, reopened()]), []);
  // 살아 있는 세션을 다시 연 start(같은 pane PID, 명령 없음)가 그 세션의 마지막 start이면, reopen은 그 사건의 지문을 적고
  // 감시기는 그것으로 잇는다. 세대를 띄운 start의 지문을 적은 start는 마지막 start와 달라 잇지 않는다(틀려도 안 잇는 쪽).
  const reuse = {kind: 'start', role, session, floor: 'tmux', panePid: '100', t: '2026-11-10T00:00:30Z'};
  assert.deepEqual(dispatches([start, reuse, send, stop, reopened({reopenOf: startDigest(reuse)})]), ['probe/c1']);
  assert.deepEqual(dispatches([start, reuse, send, stop, reopened()]), []);
  // 꺼진 적이 없는데(같은 이름의 살아 있는 세대를 덮어쓴 start) reopenOf만 맞는 경우는 이어받지 않는다.
  assert.deepEqual(dispatches([start, send, reopened()]), []);
  // 인계로 넘어간 발령은 후임 것이다: 선임을 가리키는 reopen start가 와도 선임 자리에 발령이 되살아나지 않는다.
  const heir = {...start, role: 'heir', session: 'kadan-heir', panePid: '300', t: '2026-11-10T00:01:10Z'};
  const handover = {kind: 'handover', phase: 'transferred', from: role, to: 'heir', taskIds: ['c1'], handoverId: 'h1', t: '2026-11-10T00:01:30Z'};
  assert.deepEqual(dispatches([start, send, heir, handover, {...stop, handoverId: 'h1'}, reopened()]), []);
});

test('감시기의 저장 상태(새 사건만 적용하는 경로)도 같은 판정을 낸다 — 실제 원장에 적힌 start의 지문으로 대조한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-reopen-state-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const cards = [{id: 'c1', key: 'probe/c1', role, status: 'assigned', at: '2026-11-10T00:00:00Z'}];
  const reader = createWatchMailReader(home, null, {readCards: () => cards});
  const floor = {list: () => [{session, pid: 200}], read: () => screen};
  const observe = entries => collectRoles(floor, entries, null, cards, {hookHome: home}).observations.get(session);
  // 두 경로를 사건 하나마다 대조한다: 저장 상태(captured)로 본 것과 원장 전체를 다시 훑어 본 것.
  const check = () => {
    const entries = reader.project(reader.readEntries(), cards);
    const full = taskIdentity(cards).project(readLedgerIncremental(home)).filter(e => !taskConnectionError(e));
    assert.ok(watchRoleState(entries, cards), '저장 상태 경로가 쓰였다');
    const [stored, replayed] = [observe(entries), observe(full)];
    assert.deepEqual([...stored.completionDispatches.keys()], [...replayed.completionDispatches.keys()]);
    return [...stored.completionDispatches.keys()];
  };
  const add = entry => { appendLedger(entry, home); return check(); };
  const {t: _t, ...firstStart} = start;
  add(firstStart);
  const {t: _s, ...firstSend} = send;
  assert.deepEqual(add(firstSend), ['probe/c1']);
  // reopen이 하는 것처럼 원장에서 읽은 start로 지문을 만든다.
  const recorded = readLedger(home).find(e => e.kind === 'start' && e.session === session);
  assert.deepEqual(add({kind: 'stop', role, session, conversation: ID, conversationStart: startDigest(recorded)}), ['probe/c1']);
  const {t: _r, ...again} = reopened({reopenOf: startDigest(recorded)});
  assert.deepEqual(add(again), ['probe/c1'], 'reopen의 start가 그 세대의 발령을 이어받는다');
  // 다시 끄고, 이번에는 틀린 지문으로 연 start: 이어받지 않는다.
  const second = readLedger(home).findLast(e => e.kind === 'start' && e.session === session);
  add({kind: 'stop', role, session, conversation: ID, conversationStart: startDigest(second)});
  assert.deepEqual(add({...again, panePid: '300', reopenOf: startDigest(recorded)}), [], '바로 앞 세대가 아닌 지문은 이어받지 않는다');
  // 새 세대에 새로 발령하고 끈 뒤 맞는 지문으로 열면 그 발령만 이어받는다.
  add({...firstSend, taskId: 'c1', mailId: 'again'});
  const third = readLedger(home).findLast(e => e.kind === 'start' && e.session === session);
  add({kind: 'stop', role, session, conversation: ID, conversationStart: startDigest(third)});
  assert.deepEqual(add({...again, panePid: '400', reopenOf: startDigest(third)}), ['probe/c1']);
});
