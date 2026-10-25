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
import {collectRoles} from '../src/watch-roles.mjs';
import {watchRoleState} from '../src/watch-role-facts.mjs';
import {ledgerViewPath} from '../src/ledger-view-store.mjs';
import {appendSpool} from '../src/stop-hook-spool.mjs';

const at = n => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const a = 'fixture-role-a', b = 'fixture-role-b';
const session = role => `kadan-${role}`;
const start = (role, n, extra = {}) => ({kind:'start', role, session:session(role),
  panePid:role === a ? 11 : 12, t:at(n), ...extra});
const send = (role, n, extra = {}) => ({kind:'send', role, session:session(role), taskId:'task',
  mailId:`fixture-q-${n}`, baselineMarkers:[], t:at(n), ...extra});
const done = (role, n, extra = {}) => ({kind:'done', role, taskId:'task', result:'ok', t:at(n), ...extra});
const stop = (role, n) => ({kind:'stop', role, session:session(role), t:at(n)});
const transfer = (from, to, n, extra = {}) => ({kind:'handover', phase:'transferred',
  from, to, taskIds:['task'], handoverId:`fixture-${from}-${to}`, t:at(n), ...extra});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-role-state-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  const state = {home, cards:[{id:'task', key:'fixture/task', role:a, status:'assigned', at:at(0)}], saved:[]};
  const floor = {list:() => [{session:session(a), pid:11}, {session:session(b), pid:12}],
    read:() => 'KADAN:DONE task ok\nKADAN:DONE task failed\n'};
  state.reader = createWatchMailReader(home, null, {readCards:() => state.cards});
  state.append = event => appendLedger(event, home);
  state.observe = (entries, cards = state.cards) => collectRoles(floor, entries, null, cards, {hookHome:home});
  state.check = () => {
    const raw = state.reader.readEntries(), entries = state.reader.project(raw, state.cards);
    const old = taskIdentity(state.cards).project(readLedgerIncremental(home)).filter(e => !taskConnectionError(e));
    assert.deepEqual(entries, old);
    assert.ok(watchRoleState(entries, state.cards));
    const value = state.observe(entries);
    assert.deepEqual(value, state.observe(old));
    for (const saved of state.saved) assert.deepEqual(state.observe(saved.entries, saved.cards), saved.value);
    state.saved.push({entries, cards:state.cards, value});
    return {entries, value};
  };
  return state;
}

test('모든 prefix에서 세대 재사용·교체·재시작과 원래 발령/완료 화면 판정이 같다', () => {
  const state = fixture();
  const events = [start(a, 0), send(a, 1), done(a, 2), start(a, 3, {panePid:'11'}),
    send(a, 4, {baselineMarkers:[{taskId:'fixture/task', result:'failed'}]}),
    stop(a, 5), start(a, 6, {restartOf:session(a)}), start(a, 7, {panePid:31}),
    send(a, 8), start(a, 9, {panePid:null}), send(a, 10),
    start(a, 11, {floor:'rottie', rottieTerminalId:'one'}), send(a, 12),
    start(a, 13, {floor:'rottie', rottieTerminalId:'two'}), send(a, 14),
    send(a, 15, {notificationOnly:true}), send(a, 16, {transport:'mailbox'}),
    done(a, 17, {t:'invalid'}), start(a, 18, {panePid:0}), send(a, 19),
    start(a, 20, {panePid:'0'}), stop(a, 21), start(a, 22, {panePid:0})];
  for (const entry of events) {state.append(entry);state.check();}
});

test('인계는 후임의 더 늦은 발령을 덮어쓰고 Map 순서·확정 결과·undefined 속성을 보존한다', () => {
  const state = fixture();
  const events = [start(a, 0), send(a, 1), done(a, 2), start(b, 3),
    send(b, 4, {taskId:'second'}), send(b, 5, {baselineMarkers:[{taskId:'task', result:'failed'}]}),
    stop(a, 6), transfer(a, b, 7, {handoverId:undefined, t:undefined}),
    start(a, 8), send(a, 9), transfer(a, b, 10), send(a, 11), transfer(a, b, 12),
    stop(b, 13), send(a, 14), transfer(a, b, 15), start(b, 16, {restartOf:session(b)})];
  for (const entry of events) {state.append(entry);state.check();}
  const inherited = state.saved[7].value.observations.get(session(b));
  assert.deepEqual([...inherited.completionDispatches.keys()], ['second', 'fixture/task']);
  assert.equal(inherited.completionDispatches.get('fixture/task').confirmedResult, 'ok');
  assert.equal(Object.hasOwn(inherited.completionDispatches.get('fixture/task'), 'handoverId'), true);
  assert.equal(inherited.doneMarker.result, 'failed');
});

test('주소 집합 변경·같은 카드 객체 변경·다른 배열·반환 Map 변경은 다음 조회를 오염시키지 않는다', () => {
  const state = fixture();
  for (const entry of [start(a, 0), send(a, 1), start(b, 2), transfer(a, b, 3)]) state.append(entry);
  const first = state.check();
  first.value.observations.get(session(b)).completionDispatches.clear();
  // 비교용 저장 결과만 보정한다. 다음 호출은 독립적인 Map을 만들어야 한다.
  state.saved.pop();assert.equal(state.observe(first.entries).observations.get(session(b)).completionDispatches.size, 1);
  assert.equal(watchRoleState([...first.entries], state.cards), null);
  assert.equal(watchRoleState(first.entries, state.cards.map(card => ({...card}))), null);
  state.cards[0].key = 'changed/task';
  assert.equal(watchRoleState(first.entries, state.cards), null);
  assert.deepEqual(state.observe(first.entries), state.observe([...first.entries]));
  state.check();
  state.cards = [...state.cards, {id:'task', key:'other/task'}];state.check();
  state.cards = [{id:'task', key:'fixture/task'}];state.check();
});

test('잘못된 옛 인계 목록은 기존 계산의 정상/오류 경계를 그대로 사용한다', () => {
  for (const taskIds of ['task', '', 42, false, {}, null, undefined]) {
    const state = fixture();
    for (const entry of [start(a, 0), send(a, 1), start(b, 2), transfer(a, b, 3, {taskIds})]) state.append(entry);
    const raw = state.reader.readEntries(), entries = state.reader.project(raw, state.cards);
    const outcome = values => {
      try {return {value:state.observe(values)};} catch (error) {return {error:error.name, message:error.message};}
    };
    assert.deepEqual(outcome(entries), outcome([...entries]));
  }
});

test('commit 실패는 원본에서 재개하며 이전 snapshot과 증분 위치를 유지한다', () => {
  const state = fixture();state.append(start(a, 0));state.append(send(a, 1));state.check();
  state.append(start(b, 2));state.append(transfer(a, b, 3));
  const exec = DatabaseSync.prototype.exec;let failed = false;
  DatabaseSync.prototype.exec = function(sql) {
    if (!failed && sql === 'COMMIT' &&
        this.prepare('PRAGMA application_id').get().application_id === 1262767154) {
      failed = true;throw new Error('fixture role commit failure');
    }
    return exec.call(this, sql);
  };
  try {assert.throws(() => state.reader.readEntries(), /fixture role commit failure/);}
  finally {DatabaseSync.prototype.exec = exec;}
  assert.equal(failed, true);state.check();
});

const child = (state, prefix = '') => spawnSync(process.execPath, ['--input-type=module', '-e', `${prefix}
  import {createWatchMailReader} from './src/watch-mail-reader.mjs';
  import {collectRoles} from './src/watch-roles.mjs';
  const cards=JSON.parse(process.argv[2]);
  const reader=createWatchMailReader(process.argv[1],null,{readCards:()=>cards});
  const entries=reader.project(reader.readEntries(),cards);
  const value=collectRoles({list:()=>[],read:()=>''},entries,null,cards,{hookHome:process.argv[1]});
  console.log(JSON.stringify([...value.observations].map(([session,v])=>[session,[...v.completionDispatches]])));`,
  state.home, JSON.stringify(state.cards)], {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8', timeout:10000});

test('현재 상태 유실·강제 종료·옛 원장 추가 뒤 재생도 같은 발령을 복원한다', () => {
  const state = fixture();state.append(start(a, 0));state.append(send(a, 1));state.check();
  const db = new DatabaseSync(ledgerViewPath(state.home));
  try {db.exec('DELETE FROM watch_role_dispatches');} finally {db.close();}
  const rebuilt = child(state);assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(JSON.parse(rebuilt.stdout)[0][1][0][0], 'fixture/task');
  state.append(start(b, 2));state.append(transfer(a, b, 3));
  const killed = child(state, `import {DatabaseSync} from 'node:sqlite';
    const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){
      if(sql==='COMMIT'&&this.prepare('PRAGMA application_id').get().application_id===1262767154)
        process.kill(process.pid,'SIGKILL');return exec.call(this,sql);};`);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const resumed = child(state);assert.equal(resumed.status, 0, resumed.stderr);state.check();
  appendStream(state.home, 'ledger.jsonl', start(a, -1));state.check();
});

test('원장이 같아도 새 훅·화면·PID는 매번 읽고 결과가 반대인 완료후보를 남긴다', () => {
  const state = fixture();
  for (const entry of [start(a, 0), send(a, 1), done(a, 2)]) state.append(entry);
  const {entries} = state.check();
  let pid = 11, text = 'quiet', reads = 0, lists = 0;
  const floor = {list:() => {lists++;return [{session:session(a), pid}];}, read:() => {reads++;return text;}};
  const read = values => collectRoles(floor, values, null, state.cards, {hookHome:state.home});
  assert.equal(read(entries).observations.get(session(a)).doneMarker, null);
  appendSpool(state.home, {role:a, at:at(3), taskId:'task', result:'ok'});
  assert.equal(read(entries).observations.get(session(a)).doneMarker, null);
  appendSpool(state.home, {role:a, at:at(4), taskId:'task', result:'failed'});
  const next = read(entries).observations.get(session(a));
  assert.deepEqual(next.doneMarker, {taskId:'task', result:'failed'});assert.equal(next.doneSource, 'hook');
  pid = 99;text = 'new screen';
  assert.deepEqual(read(entries), read([...entries]));assert.equal(reads, 5);assert.equal(lists, 5);
});

test('수집 중 writer는 다음 snapshot부터 반영하고 관련 없는 사건은 역할 상태를 바꾸지 않는다', () => {
  const state = fixture();state.append(start(a, 0));state.append(send(a, 1));
  let inject = true;
  const reader = createWatchMailReader(state.home, null, {readCards:() => {
    if (inject) {
      inject = false;
      const writer = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import {appendLedger} from './src/ledger.mjs';
          for(const entry of JSON.parse(process.argv[2]))appendLedger(entry,process.argv[1]);`,
        state.home, JSON.stringify([start(b, 2), transfer(a, b, 3)])],
      {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8', timeout:10000});
      assert.equal(writer.status, 0, writer.stderr);
    }
    return state.cards;
  }});
  const read = () => reader.project(reader.readEntries(), state.cards);
  const first = read(), second = read();
  assert.equal(state.observe(first).observations.get(session(a)).completionDispatches.size, 1);
  assert.equal(state.observe(second).observations.get(session(b)).completionDispatches.size, 1);
  for (const entries of [first, second]) assert.deepEqual(state.observe(entries), state.observe([...entries]));
  const metadata = () => {
    const db = new DatabaseSync(ledgerViewPath(state.home), {readOnly:true});
    try {return JSON.parse(db.prepare('SELECT value FROM watch_role_meta WHERE id=1').get().value);}
    finally {db.close();}
  };
  const before = metadata();state.append({kind:'send', role:b, mailId:'ordinary', transport:'mailbox'});
  read();const after = metadata();
  assert.ok(after.position > before.position);assert.equal(after.revision, before.revision);
  assert.equal(after.stateVersion, before.stateVersion);
});
