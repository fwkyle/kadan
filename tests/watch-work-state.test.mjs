import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {readLedgerIncremental} from '../src/ledger-incremental.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {taskIdentity, taskConnectionError} from '../src/task-identity.mjs';
import {workEntries, withEffectiveOwner} from '../src/handover-state.mjs';
import {buildWatchScope, buildSupervisorScope, previousGenerationExecutions} from '../src/watch-scope.mjs';
import {watchScopeFacts} from '../src/watch-scope-facts.mjs';
import {ledgerViewPath} from '../src/ledger-view-store.mjs';

const at = n => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const a = 'fixture-state-a', b = 'fixture-state-b', lead = 'fixture-state-lead';
const parents = new Map([[a, lead], [b, lead], [lead, '@user']]);
const card = {key:'fixture/task', id:'task', role:a, status:'assigned', at:at(0)};
const work = {key:'fixture/work', owner:lead, status:'open', at:at(0),
  history:[{action:'create', owner:lead, at:at(0)}], executions:[{key:card.key}]};
const send = (role, n, extra = {}) => ({kind:'send', role, by:lead, taskId:'task',
  mailId:`q-${n}`, t:at(n), ...extra});
const done = (role, n) => ({kind:'done', role, taskId:'task', result:'ok', t:at(n)});
const transfer = (from, to, n, extra = {}) => ({kind:'handover', phase:'transferred',
  from, to, taskIds:['task'], handoverId:`${from}-${to}`, t:at(n), ...extra});
const scopes = (cards, entries, works) => ({
  worker:buildWatchScope(cards, entries, parents, works),
  supervisor:buildSupervisorScope(cards, entries, parents, works),
  previous:previousGenerationExecutions(cards, entries, parents, works),
});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-work-state-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  const state = {home, cards:[{...card}], works:[work], saved:[]};
  state.reader = createWatchMailReader(home, null,
    {readCards:() => state.cards, readWorks:() => state.works});
  state.append = event => appendLedger(event, home);
  state.check = () => {
    const raw = state.reader.readEntries(), entries = state.reader.project(raw, state.cards);
    const expected = taskIdentity(state.cards).project(readLedgerIncremental(home))
      .filter(entry => !taskConnectionError(entry));
    const works = state.works.map(value => withEffectiveOwner(value, raw));
    assert.deepEqual(entries, expected);
    const result = scopes(state.cards, entries, works);
    // 새 조회가 등록되지 않은 별도 배열로 기존 계산을 실행한다.
    assert.deepEqual(result, scopes(state.cards, [...expected], works));
    const facts = watchScopeFacts(entries, state.cards);
    assert.ok(facts);
    for (const [current, value] of facts.cards) {
      const pending = workEntries(expected, state.cards).filter(e => e.role === value.role &&
        e.taskId === taskIdentity(state.cards).taskIdFor(current) && e.transport !== 'mailbox' &&
        ['send','done'].includes(e.kind)).at(-1);
      assert.deepEqual(value.sent, pending?.kind === 'send' ? pending : null);
    }
    for (const saved of state.saved) {
      assert.deepEqual(scopes(saved.cards, saved.entries, saved.works), saved.result);
    }
    state.saved.push({cards:state.cards, entries, works, result});
    return {raw, entries, result};
  };
  return state;
}

test('양쪽 발령·완료 순서와 같은 인계 ID 재등장이 모든 prefix에서 기존 책임과 같다', () => {
  for (const events of [
    [send(b, 1), done(a, 2), transfer(a, b, 3), send(a, 4), transfer(a, b, 5),
      transfer(b, a, 6, {handoverId:undefined, t:undefined}), send(b, 7), transfer(a, b, 8)],
    [done(b, 1), send(a, 2), transfer(a, b, 3), send(a, 4, {notificationOnly:true}),
      transfer(a, b, 5), done(b, 6), send(a, 7, {transport:'mailbox'})],
  ]) {
    const state = fixture();
    for (const event of events) {state.append(event);state.check();}
  }
});

test('카드 metadata·별칭 집합 변경과 유효하지 않은 시각도 기존 해석을 유지한다', () => {
  const state = fixture();
  for (const event of [send(a, 1), transfer(a, b, 2), transfer(b, a, 3, {t:'invalid'}),
    transfer(a, b, 4, {t:undefined}), transfer(b, a, 5)]) state.append(event);
  for (const change of [
    [{...card}], [{...card, at:at(4)}], [{...card, at:'invalid'}], [{...card, at:null}],
    [{...card}, {...card, key:'other/task'}], [{...card, status:'hold'}],
    [{...card, role:b, at:at(6)}], [{...card, activity:'waiting', activityRole:a, activityAt:at(8)}],
    [{...card}],
  ]) {state.cards = change;state.check();}
  state.works = [{...work, status:'closed'}];state.check();
  state.works = [work];state.check();
});

test('세대·재시작·열린 업무의 발령 이력과 준비되지 않은 업무/카드는 같은 수집으로 계산한다', () => {
  const state = fixture();
  for (const event of [
    {kind:'start', role:a, session:`kadan-${a}`, panePid:31, t:at(0)}, send(a, 1),
    {kind:'start', role:a, session:`kadan-${a}`, panePid:31, t:at(2)},
    {kind:'stop', role:a, session:`kadan-${a}`, t:at(3)},
    {kind:'start', role:a, session:`kadan-${a}`, panePid:32, t:at(4)},
    transfer(a, b, 5), done(b, 6),
    {kind:'start', role:lead, session:`kadan-${lead}`, panePid:41, t:at(7)},
    {kind:'start', role:lead, session:`kadan-${lead}`, panePid:42, conversationMode:'resume', t:at(8)},
    {kind:'start', role:lead, session:`kadan-${lead}`, panePid:43, inheritMail:true, t:at(9)},
  ]) {state.append(event);state.check();}
  const {entries} = state.check();
  const newWorks = [{...work, executions:[{key:'fixture/other'}], owner:b}];
  assert.deepEqual(scopes(state.cards, entries, newWorks), scopes(state.cards, [...entries], newWorks));
  const newCards = state.cards.map(value => ({...value, at:at(10)}));
  assert.equal(watchScopeFacts(entries, newCards), null);
  assert.deepEqual(scopes(newCards, entries, state.works), scopes(newCards, [...entries], state.works));
  const custom = createWatchMailReader(state.home, () => [], {readCards:() => state.cards});
  const customEntries = custom.project(custom.readEntries(), state.cards);
  assert.equal(watchScopeFacts(customEntries, state.cards), null);
});

test('캐시 commit 실패 뒤에 새 사실을 내주지 않고 원본에서 재개한다', () => {
  const state = fixture();state.append(send(a, 1));const first = state.check();
  state.append(transfer(a, b, 2));
  const exec = DatabaseSync.prototype.exec;let failed = false;
  DatabaseSync.prototype.exec = function(sql) {
    if (!failed && sql === 'COMMIT' &&
        this.prepare('PRAGMA application_id').get().application_id === 1262767154) {
      failed = true;throw new Error('fixture work commit failure');
    }
    return exec.call(this, sql);
  };
  try {assert.throws(() => state.reader.readEntries(), /fixture work commit failure/);}
  finally {DatabaseSync.prototype.exec = exec;}
  assert.equal(failed, true);
  const next = state.check();
  assert.deepEqual([...first.result.worker.sessions], [`kadan-${a}`]);
  assert.deepEqual([...next.result.worker.sessions], [`kadan-${b}`]);
});

const childRead = `import {createWatchMailReader} from './src/watch-mail-reader.mjs';
  import {buildWatchScope} from './src/watch-scope.mjs';
  const cards=JSON.parse(process.argv[2]);
  const reader=createWatchMailReader(process.argv[1],null,{readCards:()=>cards});
  const entries=reader.project(reader.readEntries(),cards);
  console.log(JSON.stringify(buildWatchScope(cards,entries).entries));`;
const child = (state, script = childRead) => spawnSync(process.execPath,
  ['--input-type=module', '-e', script, state.home, JSON.stringify(state.cards)],
  {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8', timeout:10_000});

test('현재 상태 유실은 새 프로세스에서 재생하고 적용 중 강제 종료도 확정 전 상태를 유지한다', () => {
  const state = fixture();state.append(send(a, 1));state.check();
  const db = new DatabaseSync(ledgerViewPath(state.home));
  try {db.exec('DELETE FROM watch_work_last');} finally {db.close();}
  const rebuilt = child(state);assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(JSON.parse(rebuilt.stdout)[0].role, a);
  state.append(transfer(a, b, 2));
  const crash = `import {DatabaseSync} from 'node:sqlite';
    const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){
      if(sql==='COMMIT'&&this.prepare('PRAGMA application_id').get().application_id===1262767154)
        process.kill(process.pid,'SIGKILL');return exec.call(this,sql);};\n${childRead}`;
  const killed = child(state, crash);assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const resumed = child(state);assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout)[0].role, b);
  state.check();
});

test('정상 추가는 같은 적용 세대를 잇고 옛 원문 추가는 순서대로 재생한다', () => {
  const state = fixture();state.append(send(a, 1));const first = state.check();
  const metadata = () => {
    const db = new DatabaseSync(ledgerViewPath(state.home), {readOnly:true});
    try {return JSON.parse(db.prepare('SELECT value FROM watch_work_meta WHERE id=1').get().value);}
    finally {db.close();}
  };
  const before = metadata();state.append(transfer(a, b, 2));state.check();
  const added = metadata();assert.equal(added.revision, before.revision);
  assert.ok(added.position > before.position);
  appendStream(state.home, 'ledger.jsonl', send(b, 0));state.check();
  assert.notEqual(metadata().revision, before.revision);
  assert.deepEqual([...first.result.worker.sessions], [`kadan-${a}`]);
});

test('수집 중 다른 writer의 추가는 다음 수집부터 보이고 업무 읽기 실패를 빈 업무로 확정하지 않는다', () => {
  const state = fixture();state.append(send(a, 1));
  let inject = true, failWorks = false;
  const reader = createWatchMailReader(state.home, null, {readCards:() => state.cards, readWorks:() => {
    if (failWorks) throw new Error('fixture work read failure');
    if (inject) {
      inject = false;
      const result = child(state, `import {appendLedger} from './src/ledger.mjs';
        appendLedger(${JSON.stringify(transfer(a, b, 2))},process.argv[1]);`);
      assert.equal(result.status, 0, result.stderr);
    }
    return state.works;
  }});
  const read = () => reader.project(reader.readEntries(), state.cards);
  const first = read();assert.deepEqual([...buildWatchScope(state.cards, first).sessions], [`kadan-${a}`]);
  const next = read();assert.deepEqual([...buildWatchScope(state.cards, next).sessions], [`kadan-${b}`]);
  failWorks = true;
  const failed = read(), works = state.works.map(value => withEffectiveOwner(value, failed));
  assert.deepEqual(scopes(state.cards, failed, works), scopes(state.cards, [...failed], works));
  assert.notStrictEqual(failed, next);
  failWorks = false;assert.deepEqual(scopes(state.cards, read(), works), scopes(state.cards, [...failed], works));
});

test('같은 카드 배열 안에서 metadata나 카드가 바뀌면 준비한 사실을 재사용하지 않는다', () => {
  const state = fixture();state.append(send(a, 1));state.append(transfer(a, b, 2));
  const {entries} = state.check();
  state.cards[0].at = at(4);
  assert.equal(watchScopeFacts(entries, state.cards), null);
  assert.deepEqual(scopes(state.cards, entries, state.works), scopes(state.cards, [...entries], state.works));
  const current = state.reader.project(state.reader.readEntries(), state.cards);
  assert.notStrictEqual(current, entries);assert.ok(watchScopeFacts(current, state.cards));
  state.cards.push({...card, key:'other/task'});
  assert.equal(watchScopeFacts(current, state.cards), null);
  assert.deepEqual(scopes(state.cards, current, state.works), scopes(state.cards, [...current], state.works));
});
