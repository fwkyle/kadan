import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {waitingLetters} from '../src/mailbox-queries.mjs';
import {runWatch} from '../src/watch-runner.mjs';
import {WAITING_CAP_MS} from '../src/watch-waiting-stop.mjs';

// 대기 시간 상한의 "실행 일치" 기준(2026-11-20 재검수 3): 공용 주소 해석기가 붙인 정식 실행 키가 현재 실행의 정식 키와 같은 것.
// 정식 키가 우편에 원래 저장돼 있었는지, 해석기가 짧은 ID에서 보충했는지는 묻지 않는다. 모호하거나 해석되지 않은 ID는 일치하지 않는다.
// 실제 감시기와 같은 우편 읽기 경로(createWatchMailReader → project → waitingLetters)를 격리 홈에서 쓴다. 가짜 시계·가짜 바닥만 쓴다.
const CAP = WAITING_CAP_MS / 60_000;
const epoch = Date.parse('2026-11-18T06:54:00Z');
const stamp = minute => new Date(epoch + minute * 60_000).toISOString();
const WORKER = 'qa-reviewer', BOSS = 'qa-boss', TOP = 'qa-top';
const parents = new Map([[WORKER, BOSS], [BOSS, TOP], [TOP, '@user']]);
const starts = [WORKER, BOSS, TOP].map((role, index) => ({kind: 'start', t: stamp(-12), role, session: `kadan-${role}`, panePid: index + 1}));
const ID = 'current', KEY = 'qa/current';
const card = {id: ID, key: KEY, role: WORKER, status: 'assigned', workType: 'execution',
  activity: 'waiting', activityRole: WORKER, activityAt: stamp(0), at: stamp(0)};
// 정식 주소가 다르고 짧은 ID만 같은 끝난 카드. 목록에 함께 있으면 짧은 ID `current`는 모호하다.
const sameIdCard = {id: ID, key: 'other/current', role: WORKER, status: 'done', workType: 'execution'};
const dispatch = {kind: 'send', role: WORKER, session: `kadan-${WORKER}`, by: BOSS, taskId: ID, executionKey: KEY, t: stamp(-1)};
// 감독이 현재 발령 전에 상위에게 보낸 미답 질문. 옛 호환 형식은 정식 실행 키 없이 짧은 taskId만 저장한다.
const question = link => ({kind: 'send', transport: 'mailbox', mailId: 'legacy-question', by: BOSS, role: TOP, session: `kadan-${TOP}`,
  expectReply: true, keyDelivery: 'sent', t: stamp(-5), ...link});

async function watch(name, {mail = null, cards = [card]} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `kadan-cap-legacy-${name}-`));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  for (const event of starts) appendLedger(event, home);
  // 옛 우편은 원장 줄 그대로 넣는다(지금의 기록 명령은 정식 키를 함께 적는다).
  if (mail) appendStream(home, 'ledger.jsonl', mail);
  appendLedger(dispatch, home);
  const works = [{key: 'qa/work', status: 'open', owner: BOSS, executions: cards.map(c => ({key: c.key})), history: [{action: 'create', at: stamp(-10)}]}];
  const reader = createWatchMailReader(home, null, {readCards: () => cards, readWorks: () => works, readRoles: () => [WORKER, BOSS, TOP]});
  const linkOf = letters => letters.filter(l => l.mailId === mail?.mailId).map(l => [l.taskId ?? null, l.executionKey ?? null]);
  const raw = reader.readEntries();
  const stored = linkOf(waitingLetters(raw)), resolved = linkOf(waitingLetters(reader.project(raw, cards)));
  const notices = [], workerInputs = [];
  let minute = 0;
  const controller = new AbortController();
  await runWatch({signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000,
    parents, routes: new Map(), superRole: TOP, now: () => epoch + minute * 60_000,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})), alive: () => true,
      read: () => '확인을 기다립니다.\n\n› Ask Codex to do anything\n'},
    readEntries: reader.readEntries, projectEntries: reader.project, readCards: () => cards, readWorks: () => works, readDecisions: () => [],
    sendAlert: (role, message) => {
      if (role === WORKER) workerInputs.push('alert');
      if (/화면이 오래 그대로/u.test(message)) notices.push([minute, role]);
    },
    sendNudge: role => { if (role === WORKER) workerInputs.push('nudge'); },
    resume429: () => workerInputs.push('429'), sendQueueEnter: () => workerInputs.push('queue'),
    spawn: () => ({status: 0, stdout: ''}), print: () => {},
    sleep: async () => { await setImmediate(); if (++minute >= CAP + 25) controller.abort(); }});
  return {stored, resolved, notices, workerInputs};
}
const ONCE = [[CAP, BOSS]];

test('양성 대조: 질문이 없으면 60분에 1회이고, 처음부터 현재 정식 키로 저장된 질문은 0회', async () => {
  assert.deepEqual((await watch('none')).notices, ONCE);
  const canonical = await watch('canonical', {mail: question({executionKey: KEY})});
  assert.deepEqual([canonical.stored, canonical.resolved, canonical.notices], [[[null, KEY]], [[null, KEY]], []]);
});

test('정식 키 없이 짧은 taskId만 저장된 옛 질문: 짧은 ID가 현재 실행 하나로 해석되면 현재 실행의 질문이다(0회)', async () => {
  const r = await watch('unique', {mail: question({taskId: ID})});
  assert.deepEqual(r.stored, [[ID, null]], '저장된 우편에는 정식 키가 없다');
  assert.deepEqual(r.resolved, [[ID, KEY]], '감시기의 주소 해석기가 현재 실행의 정식 키를 붙인다');
  assert.deepEqual([r.notices, r.workerInputs], [[], []], '처음부터 정식 키로 저장된 질문과 같은 결과다');
});

test('같은 옛 질문인데 같은 짧은 ID의 카드가 둘이라 모호하면 실행 일치가 아니다(60분에 1회)', async () => {
  const r = await watch('ambiguous', {mail: question({taskId: ID}), cards: [card, sameIdCard]});
  assert.deepEqual(r.stored, [[ID, null]]);
  assert.deepEqual(r.resolved, [], '모호한 참조는 해석되지 않아 답 대기 목록에 들지 않는다');
  assert.deepEqual([r.notices, r.workerInputs], [ONCE, []]);
  // 정식 주소가 다른 카드에 직접 연결한 질문도 가리지 않는다.
  const other = await watch('other', {mail: question({executionKey: sameIdCard.key}), cards: [card, sameIdCard]});
  assert.deepEqual([other.resolved, other.notices], [[[null, sameIdCard.key]], ONCE]);
});
