import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {CardStore} from '../src/card-store.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {ExplainAI} from '../src/explain-ai.mjs';
import {UNCONFIRMED_GRACE_MS} from '../src/explain-events.mjs';
import {taskIdentity, taskConnectionError} from '../src/task-identity.mjs';
import {appendLedger, readSystemLedger, readSessionLifecycleLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker, appendRow, transaction} from '../src/storage.mjs';
import {attachHiddenSecretary, openSecretaryTab} from '../src/secretary-tab.mjs';
import {idleWorkEntries, endedExecutionKeys, assessSupervisorIdle} from '../src/watch-supervisor.mjs';
import {runWatch} from '../src/watch-runner.mjs';

const BRIEF_OK = JSON.stringify({response: JSON.stringify({title: '제목', workstream: '묶음', stage: '구현'})});

function explainWorld() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-explain-cache-'));
  const writeSettings = roles => fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({
    version: 1, revision: 1, activePreset: 'B',
    presets: {B: {roles: roles ?? {}}},
    runners: {fake: {spawn: 'fake {model}', exec: 'fake {model}', execField: 'response', models: []}},
    families: {}, blocked: [],
  }));
  writeSettings({explain: {runner: 'fake', model: 'ok'}});
  // CardStore.create가 실제 시각으로 card.at을 찍으므로 enable 시점을 10분 전으로 둬 모든 생성 카드가 enabledAt 이후가 되게 한다.
  const clock = {t: Date.now() - 10 * 60_000};
  let spawned = 0;
  const ai = new ExplainAI({
    home,
    now: () => clock.t,
    maxPerCycle: 10,
    spawn: async () => { spawned++; return {status: 0, stdout: BRIEF_OK, stderr: ''}; },
  });
  const store = new CardStore(home);
  const raw = [];
  const iso = offset => new Date(clock.t + offset).toISOString();
  const makeCard = id => store.create({repo: 'r', id, repoPath: home, title: `${id} 제목`, body: `# ${id}\n본문`});
  const dispatch = (card, offset = 0, role = 'worker') => raw.push({
    kind: 'send', role, taskId: card.id, executionKey: card.key, t: iso(offset),
  });
  const finish = (card, offset = 1000, role = 'worker') => raw.push({
    kind: 'done', role, taskId: card.id, executionKey: card.key, result: 'ok', t: iso(offset),
  });
  const run = (extra = {}) => {
    const cards = store.listSummaries();
    const entries = taskIdentity(cards).project(raw);
    const result = ai.tick({cards, entries, readEntries: () => raw, now: clock.t, ...extra});
    return {result, done: ai.drain()};
  };
  return {home, ai, store, raw, clock, spawned: () => spawned, writeSettings, makeCard, dispatch, finish, run};
}

test('결함 1: 처리 완료된 카드 120장은 변동 없는 다음 tick에서 center/CardStore.get 호출 0건이고, 1장 변경 시 그 1장만 넘긴다', async t => {
  const w = explainWorld();
  t.after(() => w.ai.stop());
  await w.run().done; // enabled 기록 (t = now - 10m)
  w.clock.t = Date.now() + 1000;
  const cards = Array.from({length: 120}, (_, i) => w.makeCard(`c-${String(i).padStart(3, '0')}`));
  // 3장은 실제 발령·완료·설명 처리 완료 상태로, 나머지 117장은 enabledAt 이후 생성(새 이벤트 없음) 상태로 둔다.
  for (const c of cards.slice(0, 3)) { w.dispatch(c, 0); w.finish(c, 1000); }
  await w.run().done;
  assert.equal(w.spawned(), 3);

  const centerCalls = [];
  const origCenter = w.ai.center.bind(w.ai);
  w.ai.center = (keys, now) => { centerCalls.push([...keys]); return origCenter(keys, now); };
  let storeGets = 0;
  const origGet = CardStore.prototype.get;
  CardStore.prototype.get = function (...args) { storeGets++; return origGet.apply(this, args); };
  t.after(() => { CardStore.prototype.get = origGet; });

  const resetSpies = () => { centerCalls.length = 0; storeGets = 0; };

  // 변동 없는 2차 tick: center·CardStore.get 모두 0건
  w.clock.t += 60_000;
  await w.run().done;
  assert.deepEqual(centerCalls, []);
  assert.equal(storeGets, 0);

  // (a0) 1장의 revision만 변경(진행 메모, 새 AI 호출 없음) -> tick()의 center 1회·CardStore.get 1회
  const noteCard = cards[5];
  w.store.update(noteCard.key, {}, {revision: noteCard.revision, by: 'sup', note: '메모', noteKind: 'progress'});
  resetSpies();
  w.clock.t += 60_000;
  await w.run().done;
  assert.deepEqual(centerCalls, [[noteCard.key]]);
  assert.equal(storeGets, 1);

  // (a) 1장의 revision 변경(hold 진입 -> AI 호출 1회) -> tick·freshQueuedJob 모두 해당 1장만 center에 전달
  const revCard = cards[10];
  w.store.update(revCard.key, {status: 'hold'}, {revision: revCard.revision, by: 'sup', note: '보류', noteKind: 'decision'});
  resetSpies();
  w.clock.t += 60_000;
  await w.run().done;
  assert.ok(centerCalls.length >= 1);
  assert.deepEqual([...new Set(centerCalls.flat())], [revCard.key]);
  assert.equal(centerCalls[0].length, 1);

  resetSpies();
  w.clock.t += 60_000;
  await w.run().done;
  assert.deepEqual(centerCalls, []);
  assert.equal(storeGets, 0);

  // (b) 1장의 결정 생성·답변 -> 정확히 그 1장만 center에 전달
  const decisions = new DecisionStore(w.home, {notify: () => {}, userNotify: () => null});
  const decCard = cards[20];
  const asked = decisions.request(decCard.key, {
    question: '진행할까요? 확인 경로 없음: 시험', options: ['진행', '보류'], recommendation: '진행',
    reason: '확인 경로 없음: 시험', work: '없음',
  }, '시험-슈퍼감독');
  resetSpies();
  w.clock.t += 60_000;
  await w.run({decisions: decisions.list()}).done;
  assert.deepEqual([...new Set(centerCalls.flat())], [decCard.key]);
  assert.equal(centerCalls[0].length, 1);

  decisions.answer(asked.id, {revision: asked.revision, choice: '진행'}, '사용자');
  resetSpies();
  w.clock.t += 60_000;
  await w.run({decisions: decisions.list()}).done;
  assert.deepEqual([...new Set(centerCalls.flat())], [decCard.key]);
  assert.equal(centerCalls[0].length, 1);

  resetSpies();
  w.clock.t += 60_000;
  await w.run({decisions: decisions.list()}).done;
  assert.deepEqual(centerCalls, []);
  assert.equal(storeGets, 0);

  // (c) 1장의 send -> 그 1장만, 이어서 done -> 그 1장만
  const runCard = cards[30];
  w.clock.t += 60_000;
  w.dispatch(runCard, 0);
  resetSpies();
  await w.run({decisions: decisions.list()}).done;
  assert.deepEqual([...new Set(centerCalls.flat())], [runCard.key]);
  assert.equal(centerCalls[0].length, 1);

  resetSpies();
  w.clock.t += 60_000;
  await w.run({decisions: decisions.list()}).done;
  assert.deepEqual(centerCalls, []);
  assert.equal(storeGets, 0);

  w.clock.t += 60_000;
  w.finish(runCard, 0);
  resetSpies();
  await w.run({decisions: decisions.list()}).done;
  assert.deepEqual([...new Set(centerCalls.flat())], [runCard.key]);
  assert.equal(centerCalls[0].length, 1);

  resetSpies();
  w.clock.t += 60_000;
  await w.run({decisions: decisions.list()}).done;
  assert.deepEqual(centerCalls, []);
  assert.equal(storeGets, 0);
});

test('결함 1: unconfirmed 유예 만료·liveSessions 변화·off→on 재활성에서 누락 없이 재검사한다', async t => {
  const w = explainWorld();
  t.after(() => w.ai.stop());
  await w.run().done;
  w.clock.t = Date.now() + 1000;
  const openCard = w.makeCard('c-open');
  const doneCard = w.makeCard('c-done');
  const sentIso = new Date(w.clock.t).toISOString();
  w.dispatch(openCard, 0, 'w-open');
  w.dispatch(doneCard, 0, 'w-done');
  w.finish(doneCard, 100, 'w-done');
  const alive = new Set(['kadan-w-open', 'kadan-w-done']);
  await w.run({liveSessions: alive}).done;
  assert.equal(w.spawned(), 2);

  const centerCalls = [];
  const origCenter = w.ai.center.bind(w.ai);
  w.ai.center = (keys, now) => { centerCalls.push([...keys]); return origCenter(keys, now); };

  // 유예(10분) 전: 0건
  w.clock.t += 5 * 60_000;
  await w.run({liveSessions: alive}).done;
  assert.deepEqual(centerCalls, []);

  // 유예(10분) 도달: openCard만 unconfirmed 막힘 검사를 위해 깨어나고 handled에 기록된다
  w.clock.t += UNCONFIRMED_GRACE_MS;
  await w.run({liveSessions: alive}).done;
  assert.deepEqual(centerCalls, [[openCard.key]]);
  assert.equal(w.ai.handled.has(`${openCard.key}|blocked:unconfirmed:w-open:${sentIso}`), true);

  // 세션 소실: openCard만 orphaned 재검사(displayState 변경으로 새 AI 호출), 이미 done인 doneCard는 재검사하지 않는다
  centerCalls.length = 0;
  w.clock.t += 60_000;
  await w.run({liveSessions: new Set()}).done;
  assert.deepEqual([...new Set(centerCalls.flat())], [openCard.key]);
  assert.equal(centerCalls[0].length, 1);
  assert.equal(w.spawned(), 3);

  // off → on 전환 시 캐시가 비워져 다시 평가한다
  w.writeSettings({});
  w.clock.t += 60_000;
  assert.equal((await w.run({liveSessions: new Set()}).result).state, 'off');
  assert.equal(w.ai.settled.size, 0);
  w.writeSettings({explain: {runner: 'fake', model: 'ok'}});
  centerCalls.length = 0;
  w.clock.t += 60_000;
  const fresh = w.makeCard('c-after-reopen');
  w.dispatch(fresh, 0, 'w-open');
  await w.run({liveSessions: new Set(['kadan-w-open'])}).done;
  assert.ok(centerCalls.flat().includes(fresh.key));
  assert.equal(w.spawned(), 4);
});

function sqliteHome(prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.KADAN_HOME, prefix));
  createDatabase(dir);
  writeStorageMarker(dir, 'sqlite');
  return dir;
}

const legacyInsert = (home, rows) => transaction(home, db => {
  for (const row of rows) appendRow(db, 'ledger.jsonl', row);
});

function seedNoise(home, count = 600) {
  for (let i = 0; i < count; i++) {
    appendLedger({
      kind: i % 5 === 0 ? 'watch-ai-request' : i % 3 === 0 ? 'start' : 'alert',
      session: `kadan-other-${i % 10}`,
      role: `other-${i % 10}`,
      note: i === 7 ? '"broken" in text' : `noise-${i}`,
      ...(i % 5 === 0 ? {requestId: `req-${i}`, parents: 'p'.repeat(4000), routes: 'r'.repeat(4000)} : {}),
    }, home);
  }
}

test('결함 2: readSessionLifecycleLedger·attachHiddenSecretary는 타 사건 600건 이상을 파싱하지 않고 readSystemLedger와 동일한 판정을 낸다', () => {
  const SETTING = {version: 1, window: 'rottie', rottieBin: '/fixture/rottie'};
  const sec = 'kadan-비서';
  const compare = (home, floorPid, openFn) => {
    const narrow = attachHiddenSecretary({
      home, floor: {pid: () => floorPid}, session: sec,
      record: () => {}, readSetting: () => SETTING, open: openFn,
    });
    const full = attachHiddenSecretary({
      home, floor: {pid: () => floorPid}, session: sec,
      readEntries: () => readSystemLedger(home),
      record: () => {}, readSetting: () => SETTING, open: openFn,
    });
    assert.deepEqual(narrow, full);
    return narrow;
  };
  const openOk = () => ({window: 'rottie', rottieTerminalId: 'new-tab', restoredFrom: 'old-tab', oldState: 'exited'});

  // (a) 숨김 시작(탭 없음) -> opened
  const h1 = sqliteHome('sec-opened-');
  legacyInsert(h1, [
    {t: '2026-01-01T00:00:00.000Z', kind: 'start', role: '비서', session: sec, panePid: '10', window: 'rottie', rottieTerminalId: 'leg-1'},
    {kind: 'stop', role: '비서', session: sec, t: 'short'}, // 비표준 키 순서
    {t: '2026-01-01T00:00:02.000Z', kind: 'start', role: 'other', session: 'kadan-other', panePid: '11'},
  ]);
  seedNoise(h1, 600);
  appendLedger({kind: 'start', role: '비서', session: sec, panePid: '30', window: 'hidden', cwd: '/tmp'}, h1);
  // 원장 비교 및 JSON.parse 건수 비교(전수 파싱 금지 검증)
  const expected = readSystemLedger(h1).filter(e => ['start', 'stop', 'window'].includes(e.kind) && e.session === sec);
  let narrowParses = 0, fullParses = 0;
  const origParse = JSON.parse;
  JSON.parse = (...args) => { narrowParses++; return origParse(...args); };
  let narrowRows;
  try { narrowRows = readSessionLifecycleLedger(h1, sec); } finally { JSON.parse = origParse; }
  JSON.parse = (...args) => { fullParses++; return origParse(...args); };
  try { readSystemLedger(h1); } finally { JSON.parse = origParse; }
  assert.deepEqual(narrowRows, expected);
  assert.equal(narrowRows.length, 3);
  assert.ok(narrowParses <= 5, `좁은 읽기는 대상 수명 행만 파싱해야 함(실제 ${narrowParses}건)`);
  assert.ok(fullParses >= 600, `전체 읽기는 600건 이상 파싱(실제 ${fullParses}건)`);
  assert.equal(compare(h1, '30', () => ({window: 'rottie', rottieTerminalId: 'T1'})).attached, true);

  // (b) window 기록 후 -> has-tab
  appendLedger({kind: 'window', role: '비서', session: sec, panePid: '30', rottieTerminalId: 'T1', by: 'autostart'}, h1);
  assert.equal(compare(h1, '30', () => { throw new Error('열면 안 됨'); }).reason, 'has-tab');

  // (c) inheritsOnlyOldTab -> 교체 열기(opened) 후 다음 주기 has-tab
  const h2 = sqliteHome('sec-inherit-');
  seedNoise(h2, 550);
  appendLedger({kind: 'start', role: '비서', session: sec, panePid: '40', window: 'hidden', rottieTerminalId: 'old-tab', cwd: '/tmp'}, h2);
  const swapped = compare(h2, '40', openOk);
  assert.deepEqual([swapped.attached, swapped.rottieTerminalId, swapped.restoredFrom], [true, 'new-tab', 'old-tab']);

  // (d) stop 후 및 PID 불일치 -> generation-unclear
  assert.equal(compare(h2, '99', openOk).reason, 'generation-unclear');
  appendLedger({kind: 'stop', role: '비서', session: sec}, h2);
  assert.equal(compare(h2, '40', openOk).reason, 'generation-unclear');
});

test('결함 2: readSessionLifecycleLedger는 storageMode none, 주입 readEntries, broken 손상 감지를 기존 계약대로 지킨다', () => {
  const noneHome = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'sec-none-'));
  assert.deepEqual(readSessionLifecycleLedger(noneHome, 'kadan-비서'), []);

  // 주입 readEntries는 SQLite 경로를 우회해 그대로 동작
  let injectedCalled = 0;
  const injected = attachHiddenSecretary({
    home: noneHome, floor: {pid: () => '30'}, session: 'kadan-비서',
    readSetting: () => ({version: 1, window: 'rottie', rottieBin: '/fixture/rottie'}),
    readEntries: () => { injectedCalled++; return [{kind: 'start', role: '비서', session: 'kadan-비서', panePid: '30', window: 'rottie', rottieTerminalId: 'T'}]; },
    record: () => {},
  });
  assert.equal(injectedCalled, 1);
  assert.equal(injected.reason, 'has-tab');

  // legacy 손상 감지
  const brokenLegacy = sqliteHome('sec-broken-leg-');
  legacyInsert(brokenLegacy, [{t: null, broken: 'broken'}]);
  assert.throws(() => readSystemLedger(brokenLegacy), /과거 원장 손상/);
  assert.throws(() => readSessionLifecycleLedger(brokenLegacy, 'kadan-비서'), /과거 원장 손상/);

  // system 스트림 broken 손상 감지(타 세션·타 종류 행이어도 감지)
  const brokenSys = sqliteHome('sec-broken-sys-');
  appendLedger({kind: 'start', role: '비서', session: 'kadan-비서', panePid: '30'}, brokenSys);
  transaction(brokenSys, db => {
    appendRow(db, 'system/events.jsonl', {t: '2026-11-24T00:00:00.000Z', kind: 'alert', broken: true, _ledgerOrder: 2});
  });
  assert.throws(() => readSystemLedger(brokenSys), /도메인 원장 종류 손상/);
  assert.throws(() => readSessionLifecycleLedger(brokenSys, 'kadan-비서'), /도메인 원장 종류 손상/);
  assert.equal(typeof openSecretaryTab, 'function');
});

test('결함 6a: 닫힌 업무·완료 카드 다수, 짧은 id 별칭 충돌, 인계 세션 생존에서 idleWorkEntries 축소 전달이 전체 전달과 100% 같다', () => {
  const parents = new Map(Object.entries({
    'r-슈퍼': '@user', 'r-감독': 'r-슈퍼',
    'r-작업1': 'r-감독', 'r-작업2': 'r-감독', 'r-작업3': 'r-감독', 'r-작업4': 'r-감독', 'r-작업5': 'r-감독',
  }));
  const T = m => new Date(Date.UTC(2026, 10, 24, 1, m)).toISOString();
  const NOW = Date.parse(T(300));
  const cards = [];
  const works = [];
  const entries = [];

  // 닫힌 업무 200건 + 완료 카드 400장 + 관련 원장 800건
  for (let i = 0; i < 200; i++) {
    const key1 = `r/closed-a-${i}`, key2 = `r/closed-b-${i}`;
    cards.push(
      {key: key1, id: `closed-a-${i}`, title: '끝1', status: 'done', workType: 'execution', role: 'r-작업1', revision: 2, at: T(1), history: []},
      {key: key2, id: `closed-b-${i}`, title: '끝2', status: 'done', workType: 'execution', role: 'r-작업5', revision: 2, at: T(1), history: []},
    );
    works.push({key: `r/w-closed-${i}`, status: 'done', owner: 'r-감독', ownedAt: T(0), at: T(2), revision: 2, executions: [{key: key1}, {key: key2}]});
    entries.push(
      {kind: 'send', role: 'r-작업1', taskId: `closed-a-${i}`, executionKey: key1, by: 'r-감독', t: T(2)},
      {kind: 'done', role: 'r-작업1', taskId: `closed-a-${i}`, executionKey: key1, by: 'r-감독', result: 'ok', t: T(3)},
    );
  }
  // 열린 업무에 속하지 않은 고아 assigned 카드(열린 업무 대상 밖)
  cards.push({key: 'r/unlinked-assigned', id: 'unlinked-assigned', title: '무소속', status: 'assigned', workType: 'execution', role: 'r-작업1', revision: 2, at: T(1), history: []});

  // 열린 업무 5건: doneButOpen, orphaned, 진행중, 짧은 id 별칭 충돌, 인계 뒤 생존
  cards.push(
    {key: 'r/e-done', id: 'e-done', title: '완료미확정', status: 'assigned', workType: 'execution', role: 'r-작업1', revision: 2, at: T(1), history: []},
    {key: 'r/e-orphan', id: 'e-orphan', title: '세션소실', status: 'assigned', workType: 'execution', role: 'r-작업2', revision: 2, at: T(1), history: []},
    {key: 'r/e-active', id: 'e-active', title: '진행중', status: 'assigned', workType: 'execution', role: 'r-작업3', revision: 2, at: T(1), history: []},
    {key: 'repoA/dup-id', id: 'dup-id', title: '별칭충돌A', status: 'assigned', workType: 'execution', role: 'r-작업3', revision: 2, at: T(1), history: []},
    {key: 'repoB/dup-id', id: 'dup-id', title: '별칭충돌B', status: 'done', workType: 'execution', role: 'r-작업3', revision: 2, at: T(1), history: []},
    {key: 'r/e-ho', id: 'e-ho', title: '인계진행', status: 'assigned', workType: 'execution', role: 'r-작업4', revision: 2, at: T(1), history: []},
  );
  works.push(
    {key: 'r/w-done', status: 'open', owner: 'r-감독', ownedAt: T(0), at: T(2), revision: 2, executions: [{key: 'r/e-done'}]},
    {key: 'r/w-orphan', status: 'open', owner: 'r-감독', ownedAt: T(0), at: T(2), revision: 2, executions: [{key: 'r/e-orphan'}]},
    {key: 'r/w-active', status: 'open', owner: 'r-감독', ownedAt: T(0), at: T(2), revision: 2, executions: [{key: 'r/e-active'}]},
    {key: 'r/w-alias', status: 'open', owner: 'r-감독', ownedAt: T(0), at: T(2), revision: 2, executions: [{key: 'repoA/dup-id'}]},
    {key: 'r/w-ho', status: 'open', owner: 'r-감독', ownedAt: T(0), at: T(2), revision: 2, executions: [{key: 'r/e-ho'}]},
  );
  entries.push(
    {kind: 'send', role: 'r-작업1', taskId: 'e-done', executionKey: 'r/e-done', by: 'r-감독', t: T(3)},
    {kind: 'done', role: 'r-작업1', taskId: 'e-done', executionKey: 'r/e-done', by: 'r-감독', result: 'ok', t: T(10)},
    {kind: 'send', role: 'r-작업2', taskId: 'e-orphan', executionKey: 'r/e-orphan', by: 'r-감독', t: T(3)},
    {kind: 'send', role: 'r-작업3', taskId: 'e-active', executionKey: 'r/e-active', by: 'r-감독', t: T(3)},
    // executionKey 없는 짧은 id 완료 -> repoB/dup-id와 충돌해 ambiguous여야 하므로 repoA/dup-id는 진행 중으로 유지돼야 한다
    {kind: 'send', role: 'r-작업3', taskId: 'dup-id', by: 'r-감독', t: T(3)},
    {kind: 'done', role: 'r-작업3', taskId: 'dup-id', by: 'r-감독', result: 'ok', t: T(10)},
    // r-작업4 -> r-작업5 인계: r-작업4는 죽었지만 r-작업5가 살아 있으므로 orphaned가 아니어야 한다
    {kind: 'send', role: 'r-작업4', taskId: 'e-ho', executionKey: 'r/e-ho', by: 'r-감독', t: T(3)},
    {kind: 'handover', phase: 'transferred', handoverId: 'ho-1', from: 'r-작업4', to: 'r-작업5', taskIds: ['r/e-ho'], t: T(5)},
  );
  const liveSessions = new Set(['kadan-r-슈퍼', 'kadan-r-감독', 'kadan-r-작업1', 'kadan-r-작업3', 'kadan-r-작업5']);

  let seenTargetCards = null;
  const narrowed = idleWorkEntries(works, cards, parents, targetCards => {
    seenTargetCards = targetCards;
    return endedExecutionKeys({cards: targetCards, entries, liveSessions, now: NOW});
  }, NOW);
  const full = idleWorkEntries(works, cards, parents,
    () => endedExecutionKeys({cards, entries, liveSessions, now: NOW}), NOW);

  // 전체 407장 중 열린 업무 assigned 5장 + 별칭 충돌 보존 1장(repoB/dup-id) = 6장만 전달됨
  assert.equal(cards.length, 407);
  assert.equal(seenTargetCards.length, 6);
  assert.deepEqual(
    seenTargetCards.map(c => c.key).sort(),
    ['r/e-active', 'r/e-done', 'r/e-ho', 'r/e-orphan', 'repoA/dup-id', 'repoB/dup-id'],
  );
  assert.deepEqual(narrowed, full);
  assert.deepEqual(narrowed.map(e => e.taskId).sort(), ['work:r/w-done', 'work:r/w-orphan']);

  // assessSupervisorIdle 전체 경로도 동일하게 w-done·w-orphan만 본인 차례로 잡는다
  const states = new Map(['r-슈퍼', 'r-감독', 'r-작업1', 'r-작업3', 'r-작업5']
    .map(r => [`kadan-${r}`, {alive: true, digest: 'same', unchangedMs: 3600e3}]));
  const alerts = assessSupervisorIdle(entries, states, NOW, 60e3, null, parents, {
    works, cards, waits: [], peerEntries: entries, executionEntries: entries, liveRoleSessions: liveSessions,
  }).filter(a => a.kind === '놀고 있음' && a.role === 'r-감독');
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].idleItems.own.includes('work:r/w-done'));
  assert.ok(alerts[0].idleItems.own.includes('work:r/w-orphan'));
  assert.ok(!alerts[0].idleItems.own.includes('work:r/w-active'));
  assert.ok(!alerts[0].idleItems.own.includes('work:r/w-alias'));
  assert.ok(!alerts[0].idleItems.own.includes('work:r/w-ho'));
});

test('결함 6b: watch-runner 중복 투영 제거 후에도 인계된 카드의 waitingCardKeys가 동일하게 progress AI를 걸러낸다', async () => {
  const epoch = Date.parse('2026-11-24T00:00:00Z');
  const stamp = m => new Date(epoch + m * 60_000).toISOString();
  const parents = new Map([['p-구작업', 'p-감독'], ['p-신작업', 'p-감독'], ['p-다른작업', 'p-감독'], ['p-감독', '@user']]);
  const starts = ['p-신작업', 'p-다른작업', 'p-감독'].map((role, i) => ({
    kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t: stamp(0),
  }));
  const cards = [
    {id: 't-wait', key: 'r/t-wait', title: '인계대기', role: 'p-구작업', board: 'p', status: 'assigned', activity: 'running', workType: 'execution', at: stamp(0)},
    {id: 't-free', key: 'r/t-free', title: '진행', role: 'p-다른작업', board: 'p', status: 'assigned', activity: 'running', workType: 'execution', at: stamp(0)},
  ];
  const rawEntries = [
    ...starts,
    {kind: 'send', role: 'p-구작업', taskId: 't-wait', executionKey: 'r/t-wait', by: 'p-감독', t: stamp(0)},
    {kind: 'handover', phase: 'transferred', handoverId: 'h-wait', from: 'p-구작업', to: 'p-신작업', taskIds: ['t-wait'], t: stamp(1)},
    // 인계받은 신작업자가 실행에 연결된 질문 우편을 보내 답을 기다리는 중 -> waitingCardKeys에 들어 progress에서 빠져야 한다
    {kind: 'send', transport: 'mailbox', mailId: 'm-q1', by: 'p-신작업', role: 'p-감독', expectReply: true, executionKey: 'r/t-wait', t: stamp(2)},
    {kind: 'send', role: 'p-다른작업', taskId: 't-free', executionKey: 'r/t-free', by: 'p-감독', t: stamp(0)},
    // taskConnectionError 항목이 섞여 있어도 369행 projectEntries가 걸러낸 뒤 handover·waitingCardKeys에 영향 없음
    {kind: 'send', role: 'p-다른작업', taskId: 'r/missing-card', by: 'p-감독', t: stamp(0)},
  ];
  let minute = 0, projectCalls = 0;
  const progressCalls = [];
  const controller = new AbortController();
  await runWatch({
    signal: controller.signal,
    intervalMs: 60_000,
    stallN: 99,
    stallAfterMs: 999 * 60_000,
    idleMs: 999 * 60_000,
    parents,
    routes: new Map(),
    superRole: 'p-감독',
    now: () => epoch + minute * 60_000,
    floor: {
      list: () => starts.map(s => ({session: s.session, pid: s.panePid})),
      read: () => `작업 중 화면 ${String.fromCharCode(97 + (minute % 26))}`,
      alive: () => true,
    },
    readEntries: () => rawEntries,
    projectEntries: (entries, list) => {
      projectCalls++;
      return taskIdentity(list).project(entries).filter(e => !taskConnectionError(e));
    },
    readCards: () => cards,
    readWorks: () => [],
    readDecisions: () => [],
    judgeCmd: 'fake',
    judgeCooldownMs: 60_000,
    ai: {
      reports: {retire: () => {}},
      run: args => { if (args.source === 'progress') progressCalls.push({minute, role: args.role, taskId: args.taskId}); return {ok: true}; },
    },
    sendAlert: () => {},
    sendNudge: () => {},
    record: () => {},
    print: () => {},
    spawn: () => ({status: 0, stdout: ''}),
    sleep: async () => { await setImmediate(); if (++minute >= 35) controller.abort(); },
  });
  assert.equal(projectCalls, 35, '주기당 projectEntries 1회만 호출');
  assert.ok(progressCalls.some(c => c.role === 'p-다른작업'), '답 대기 없는 실행은 progress 점검 대상');
  assert.equal(progressCalls.some(c => c.role === 'p-신작업'), false, '인계 후 답 대기 걸린 실행은 waitingCardKeys로 제외');
});
