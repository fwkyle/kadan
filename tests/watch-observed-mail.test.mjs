import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWatch} from '../src/watch-runner.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {recentLetters, waitingLetters} from '../src/mailbox-queries.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';

const at = '2026-01-01T00:00:00Z';
const first = 'fixture-observed-a', second = 'fixture-observed-b', lead = 'fixture-observed-lead';

test('정상 감시의 작업자·감독만 다음 문맥 대상으로 전달하고 읽기 실패는 빈 대상으로 바꾸지 않는다', async () => {
  let cycle = 0;
  const controller = new AbortController(), observed = [];
  const entries = [first, second].flatMap((role, i) => [
    {kind:'start', role, session:`kadan-${role}`, panePid:i + 1, t:at},
    {kind:'send', role, taskId:`task-${i}`, executionKey:`fixture/task-${i}`, by:lead, t:at},
  ]);
  await runWatch({
    floor:{list:() => [], read:() => ''},
    readEntries:() => {if (cycle === 3) throw Error('fixture ledger failure');return entries;},
    readCards:() => {
      if (cycle === 2) throw Error('fixture card failure');
      return [first, second].map((role, i) => ({id:`task-${i}`, key:`fixture/task-${i}`, role,
        workType:'execution', status:cycle === i ? 'assigned' : 'done', at}));
    },
    readWorks:() => [],
    parents:new Map([[first,lead], [second,lead], [lead,'@user'], ['fixture-old','@user']]),
    rememberObservedRoles:roles => observed.push(roles.sort()),
    record:() => {}, sendAlert:() => {}, intervalMs:1000, stallN:1, routes:new Map(), superRole:null,
    now:() => Date.parse(at) + cycle * 1000,
    spawn:() => ({status:0, stdout:String(process.pid)}), print:() => {}, signal:controller.signal,
    sleep:async () => {if (++cycle === 5) controller.abort();},
  });
  assert.deepEqual(observed, [[first,lead].sort(), [second,lead].sort(), []]);
});

test('새 역할·준비 대상 교체·나중에 붙은 우편도 같은 수집의 최근12통과 전체 대기를 유지한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-observed-mail-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  for (let i = 0; i < 16; i++) appendLedger({kind:'send', role:i % 2 ? first : second,
    by:lead, mailId:`old-${i}`, expectReply:true, t:at}, home);
  let roles = [];
  const reader = createWatchMailReader(home, null, {readRoles:() => roles});
  const expected = (entries, role) => mailboxLetters([...entries]).filter(letter =>
    letter.currentRecipient === role || letter.currentSender === role).slice(-12);
  const cold = reader.readEntries(), original = recentLetters(cold, first);
  assert.deepEqual(original, expected(cold, first));
  roles = [first];
  const prepared = reader.readEntries();assert.notStrictEqual(prepared, cold);
  assert.deepEqual(recentLetters(prepared, first), original);
  appendLedger({kind:'send', role:second, by:lead, mailId:'new', expectReply:true, t:at}, home);
  const current = reader.readEntries();
  assert.deepEqual(recentLetters(current, second), expected(current, second));
  roles = [second];
  const switched = reader.readEntries();
  assert.deepEqual(recentLetters(switched, second), expected(switched, second));
  assert.deepEqual(recentLetters(switched, first), original);
  assert.deepEqual(recentLetters(cold, first), original);
  assert.equal(waitingLetters(cold).length, 16);assert.equal(waitingLetters(switched).length, 17);
  roles = [];
  const empty = reader.readEntries();assert.deepEqual(recentLetters(empty, second), expected(empty, second));
  assert.equal(waitingLetters(empty).length, 17);
});
