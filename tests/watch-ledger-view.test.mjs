import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {readLedgerIncremental} from '../src/ledger-incremental.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {createWatchStoreReaders} from '../src/watch-store-cache.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';
import {waitingLetters} from '../src/mailbox-queries.mjs';
import {taskIdentity, taskConnectionError} from '../src/task-identity.mjs';
import {ledgerViewPath} from '../src/ledger-view-store.mjs';

const homeOf = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-ledger-view-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');return home;
};
const at = '2026-01-01T00:00:00Z';
const role = 'fixture-ledger-worker', by = 'fixture-ledger-lead';
const card = {key:'fixture/task', id:'task', role, revision:1, status:'assigned', at};
const expected = home => readLedgerIncremental(home, {log:() => {}});
const project = (entries, cards) => taskIdentity(cards).project(entries).filter(e => !taskConnectionError(e));

test('옛 원문·새 영역·최초 완료·큰 문맥 제외가 기존 통합 배열과 같고 이전 수집은 유지된다', () => {
  const home = homeOf(), reader = createWatchMailReader(home);
  const legacy = [
    {kind:'watch-ai-request', requestId:'old', parents:{kept:'old'}, routes:{kept:'old'}, t:at},
    {kind:'send', role, by, taskId:'task', mailId:'old-request', digest:'old-digest', t:at},
    {kind:'done', role, taskId:'task', result:'ok', t:at},
    {kind:'done', role, taskId:'task', result:'failed', t:at},
  ];
  for (const event of legacy) appendStream(home, 'ledger.jsonl', event);
  const first = reader.readEntries();assert.deepEqual(first, expected(home));
  assert.strictEqual(reader.readEntries(), first);assert.equal(first.length, 3);
  for (const event of [
    {kind:'start', role, session:`kadan-${role}`, panePid:1, t:at},
    {kind:'send', role, by, taskId:'new-task', executionKey:'fixture/new-task', mailId:'new-request',
      expectReply:true, digest:'new-digest', t:at},
    {kind:'watch-ai-request', requestId:'new', parents:{omitted:'new'}, routes:{omitted:'new'}, t:at},
    {kind:'done', role, taskId:'new-task', executionKey:'fixture/new-task', result:'ok', t:at},
  ]) {
    appendLedger(event, home);const entries = reader.readEntries();
    assert.deepEqual(entries, expected(home));
    assert.deepEqual(waitingLetters(entries), mailboxLetters([...entries], undefined, {view:'waiting'}));
  }
  const current = reader.readEntries();
  assert.equal(current.find(e => e.requestId === 'new').parents, undefined);
  assert.deepEqual(current.find(e => e.requestId === 'old').parents, {kept:'old'});
  assert.equal(current.some(e => e.kind === 'dispatch'), false);
  assert.equal(current.filter(e => e.systemGenerated === 'task-completion').length, 1);
  assert.equal(first.length, 3);assert.equal(first.at(-1).result, 'ok');
  // legacy가 나중에 늘어나는 복원은 이어 붙이지 않고 전체 순서를 다시 얻는다.
  appendStream(home, 'ledger.jsonl', {kind:'plan', taskId:'restored-old-plan', t:at});
  const rebuilt = reader.readEntries();assert.deepEqual(rebuilt, expected(home));
  assert.equal(rebuilt[3].taskId, 'restored-old-plan');assert.notStrictEqual(rebuilt, current);
});

test('카드만 바뀌어도 원문 사건은 유지하고 우편 주소를 다시 해석한다', () => {
  const home = homeOf();appendStream(home, 'cards/fixture/task/events.jsonl', card);
  appendLedger({kind:'send', role, by, taskId:'task', mailId:'q', expectReply:true, t:at}, home);
  const stores = createWatchStoreReaders(home);
  const reader = createWatchMailReader(home, null, {readCards:stores.cards.read});
  const raw = reader.readEntries(), original = reader.project(raw, stores.cards.read());
  assert.deepEqual(original, project(expected(home), stores.cards.read()));
  appendStream(home, 'cards/other/task/events.jsonl', {...card, key:'other/task'});
  const next = reader.readEntries();assert.deepEqual(next, expected(home));
  assert.equal(reader.project(next, stores.cards.read()).length, 0);
  assert.equal(waitingLetters(original).length, 1);
});

test('캐시 commit 실패 뒤 검증된 원본 prefix로 재개하며 실패한 수집을 내주지 않는다', () => {
  const home = homeOf(), reader = createWatchMailReader(home);
  appendLedger({kind:'start', role, session:`kadan-${role}`, panePid:1, t:at}, home);
  const old = reader.readEntries();
  appendLedger({kind:'send', role, by, mailId:'q', expectReply:true, t:at}, home);
  const exec = DatabaseSync.prototype.exec;let failed = false;
  DatabaseSync.prototype.exec = function(sql) {
    if (!failed && sql === 'COMMIT' &&
        this.prepare('PRAGMA application_id').get().application_id === 1262767154) {
      failed = true;throw Error('fixture cache commit failure');
    }
    return exec.call(this, sql);
  };
  try {assert.throws(() => reader.readEntries(), /fixture cache commit failure/);}
  finally {DatabaseSync.prototype.exec = exec;}
  assert.equal(failed, true);
  const next = reader.readEntries();assert.deepEqual(next, expected(home));
  assert.equal(waitingLetters(next).length, 1);assert.equal(waitingLetters(old).length, 0);
});

test('새 사건 조회 위치가 빠지면 빈 성공 대신 개수 불일치로 멈춘다', () => {
  const home = homeOf(), reader = createWatchMailReader(home);
  appendLedger({kind:'start', role, session:`kadan-${role}`, panePid:1, t:at}, home);
  const old = reader.readEntries();
  appendLedger({kind:'send', role, by, mailId:'q', t:at}, home);
  // 별도 소비자가 새 prefix를 정상 적용한 뒤 조회 위치 하나만 유실된 경우를 만든다.
  createWatchMailReader(home).readEntries();
  const db = new DatabaseSync(ledgerViewPath(home));
  try {db.exec("DELETE FROM views WHERE domain='' AND position=(SELECT max(position) FROM views WHERE domain='')");}
  finally {db.close();}
  assert.throws(() => reader.readEntries(), /조회 개수 불일치/);
  assert.equal(old.length, 1);
});

test('저장소 없는 읽기는 폴더를 만들지 않고 빈 배열을 재사용한다', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-no-ledger-view-')), 'absent');
  const reader = createWatchMailReader(home), entries = reader.readEntries();
  assert.deepEqual(entries, []);assert.strictEqual(reader.readEntries(), entries);
  assert.equal(fs.existsSync(home), false);
});
