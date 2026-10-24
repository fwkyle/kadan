import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {withMailboxView} from '../src/mail-view.mjs';
import {mailStateSelect, storedMailLetter} from '../src/mail-view-store.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';
import {taskIdentity, taskConnectionError} from '../src/task-identity.mjs';

const cards = [{key:'fixture/task', id:'task', repo:'fixture'}];
const homeOf = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-mail-projection-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');return home;
};
const question = {kind:'send', mailId:'q', role:'fixture-worker', by:'fixture-supervisor',
  taskId:'task', workKey:'fixture/work', expectReply:true, t:'2026-01-01T00:00:00Z'};
const answer = {kind:'send', mailId:'a', replyTo:'q', replyFinal:true, role:question.by,
  by:question.role, taskId:'task', executionKey:'fixture/task', workKey:question.workKey,
  t:'2026-01-01T00:01:00Z'};
const expected = (home, registry) => mailboxLetters(
  taskIdentity(registry).project(readLedger(home)).filter(entry => !taskConnectionError(entry)),
);
const read = (home, registry = cards) => withMailboxView(home, (store, info) => ({...info,
  letters:store.prepare(`${mailStateSelect} WHERE m.domain=? ORDER BY m.position`)
    .all(store.scope).map(row => storedMailLetter(store, row)),
}), {domain:'watch', cards:registry});
const equal = (home, registry = cards) => {
  const result = read(home, registry);
  assert.deepEqual(result.letters, expected(home, registry));return result;
};

test('원문과 다른 주소 해석 뒤 답장 판정을 별도로 유지한다', () => {
  const home = homeOf();
  for (const event of [question, answer]) appendStream(home, 'ledger.jsonl', event);
  const result = equal(home);
  assert.equal(result.letters[0].replyStatus, 'answered');
  assert.equal(mailboxLetters(readLedger(home))[0].replyStatus, 'waiting');
  const next = equal(home);
  assert.equal(next.projectionApplied, 0);assert.equal(next.mailApplied, 0);
  assert.equal(next.mailGeneration, result.mailGeneration);
});

test('동명 주소 추가·제거는 과거 사건을 다시 해석하고 metadata 변경은 재생하지 않는다', () => {
  const home = homeOf();appendStream(home, 'ledger.jsonl', question);
  const first = equal(home);assert.equal(first.letters.length, 1);
  const ambiguous = equal(home, [...cards, {key:'other/task', id:'task'}]);
  assert.equal(ambiguous.letters.length, 0);assert.equal(ambiguous.projectionRebuilt, true);
  assert.notEqual(ambiguous.mailGeneration, first.mailGeneration);
  const restored = equal(home);assert.equal(restored.letters.length, 1);
  const renamed = equal(home, cards.map(card => ({...card, title:'new title', status:'done'})));
  assert.equal(renamed.projectionRebuilt, false);assert.equal(renamed.projectionApplied, 0);
  assert.equal(renamed.mailGeneration, restored.mailGeneration);
});

test('해석 후 중복 완료·충돌 주소·인계·세대·읽음의 모든 추가 구간이 같다', () => {
  const home = homeOf();
  for (const event of [question,
    {kind:'done', role:question.role, taskId:'task', result:'failed'},
    {kind:'done', role:question.role, taskId:'fixture/task', result:'ok'},
  ]) appendStream(home, 'ledger.jsonl', event);
  equal(home);
  const events = [
    {kind:'start', role:question.role, session:'kadan-fixture-worker', panePid:31},
    {kind:'send', mailId:'new', role:question.role, by:question.by, taskId:'task',
      executionKey:'fixture/task', expectReply:true, transport:'mailbox', mailRule:1},
    {kind:'handover', phase:'transferred', from:question.role, to:'fixture-next',
      handoverId:'transfer', taskIds:['task']},
    {kind:'mail-read', mailId:'new', role:'fixture-next', by:'fixture-next'},
    {kind:'send', mailId:'new-answer', role:question.by, by:'fixture-next', replyTo:'new',
      taskId:'task', executionKey:'fixture/task', replyFinal:true},
    {kind:'send', mailId:'conflict', role:question.role, by:question.by,
      taskId:'different', executionKey:'fixture/task'},
  ];
  let generation = null;
  for (const [index, event] of events.entries()) {
    appendLedger({t:`2026-01-02T00:0${index}:00Z`, ...event}, home);
    const value = equal(home);
    if (generation) assert.equal(value.mailGeneration, generation);
    generation = value.mailGeneration;
    assert.ok(value.projectionApplied > 0);
  }
});

test('실패한 수집은 투영과 우편 적용 위치를 함께 되돌리고 다른 프로세스에서 재개한다', () => {
  const home = homeOf();appendLedger(question, home);const before = equal(home);
  appendLedger(answer, home);
  assert.throws(() => withMailboxView(home, () => {throw new Error('caller failed');},
    {domain:'watch', cards}), /caller failed/);
  const script = `import {withMailboxView} from './src/mail-view.mjs';
    import {mailStateSelect,storedMailLetter} from './src/mail-view-store.mjs';
    withMailboxView(process.argv[1],(store,info)=>console.log(JSON.stringify({...info,
      letters:store.prepare(mailStateSelect+' WHERE m.domain=? ORDER BY m.position').all(store.scope)
        .map(row=>storedMailLetter(store,row))})),{domain:'watch',cards:JSON.parse(process.argv[2])});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, home, JSON.stringify(cards)],
    {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8', timeout:10_000});
  assert.equal(child.status, 0, child.stderr);
  const after = JSON.parse(child.stdout);
  // 프로세스 간 JSON에는 undefined 속성이 없다. 같은 프로세스의 모양은 equal()이 별도로 비교한다.
  assert.deepEqual(after.letters, JSON.parse(JSON.stringify(expected(home, cards))));
  assert.equal(after.mailGeneration, before.mailGeneration);
  assert.ok(after.projectionApplied > 0);assert.ok(after.mailApplied > 0);
  appendLedger({kind:'mail-read', mailId:'q', role:question.role, by:question.role}, home);
  const crash = `import {DatabaseSync} from 'node:sqlite';
    import {withMailboxView} from './src/mail-view.mjs';
    const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){
      if(sql==='COMMIT'&&this.prepare('PRAGMA application_id').get().application_id===1262767154)
        process.kill(process.pid,'SIGKILL');return exec.call(this,sql);};
    withMailboxView(process.argv[1],()=>{}, {domain:'watch',cards:JSON.parse(process.argv[2])});`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', crash, home, JSON.stringify(cards)],
    {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8', timeout:10_000});
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const resumed = equal(home);
  assert.ok(resumed.projectionApplied > 0);assert.ok(resumed.mailApplied > 0);
  assert.equal(resumed.letters[0].read, true);
});
