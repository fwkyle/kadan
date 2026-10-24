import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {readLedgerIncremental} from '../src/ledger-incremental.mjs';
import {ledgerViewPath} from '../src/ledger-view-store.mjs';
import {createWatchStoreReaders} from '../src/watch-store-cache.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {mailboxLetters} from '../src/mailbox-state.mjs';
import {waitingLetters, recentLetters} from '../src/mailbox-queries.mjs';
import {taskIdentity, taskConnectionError} from '../src/task-identity.mjs';
import {peerResponsibilities} from '../src/peer-mail.mjs';
import {buildSupervisorScope} from '../src/watch-scope.mjs';
import {waitingWithoutAsking} from '../src/watch-report.mjs';
import {hasOpenQuestion} from '../src/watch-status-line.mjs';
import {observationContext} from '../src/watch-supervisor-health.mjs';

const at = '2026-01-01T00:00:00Z';
const card = {key:'fixture/task', id:'task', role:'fixture-worker', status:'assigned', revision:1, at};
const parents = new Map([['fixture-lead', '@user'], ['fixture-peer', '@user'],
  ['fixture-worker', 'fixture-lead']]);
const roles = [...parents.keys()];
const homeOf = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-mail-queries-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');return home;
};
const question = {kind:'send', role:'fixture-peer', by:'fixture-lead', mailId:'q',
  expectReply:true, taskId:'task', t:at};
const answer = {kind:'send', role:question.by, by:question.role, mailId:'a', replyTo:'q',
  replyFinal:true, taskId:'task', executionKey:card.key, t:at};
const project = (entries, cards) => taskIdentity(cards).project(entries).filter(e => !taskConnectionError(e));
const legacyRecent = (entries, role) => mailboxLetters(entries).filter(letter =>
  (letter.currentRecipient || letter.role) === role || (letter.currentSender || letter.by) === role).slice(-12);

function equalQueries(entries) {
  const plain = [...entries];
  assert.deepEqual(waitingLetters(entries), mailboxLetters(plain, undefined, {view:'waiting'}));
  for (const role of [...roles, 'fixture-missing']) {
    assert.deepEqual(waitingLetters(entries, role), mailboxLetters(plain, role, {view:'waiting'}));
    assert.deepEqual(recentLetters(entries, role), legacyRecent(plain, role));
  }
  assert.deepEqual(peerResponsibilities(entries, parents), peerResponsibilities(plain, parents));
  assert.deepEqual(buildSupervisorScope([card], entries, parents), buildSupervisorScope([card], plain, parents));
  assert.equal(hasOpenQuestion(entries, question.by, at), hasOpenQuestion(plain, question.by, at));
  assert.equal(waitingWithoutAsking(entries, {role:card.role, taskId:card.id}, [card]),
    waitingWithoutAsking(plain, {role:card.role, taskId:card.id}, [card]));
  const seen = {alive:true, pid:1, expectedPid:1};
  assert.deepEqual(observationContext(question.by, seen, entries, [card], []),
    observationContext(question.by, seen, plain, [card], []));
}

test('원문/해석 후의 기다림·책임·최근 문맥을 구분하고 이미 내준 수집을 바꾸지 않는다', () => {
  const home = homeOf();let cards = [card], visibleRoles = roles;
  const reader = createWatchMailReader(home, () => readLedgerIncremental(home),
    {readCards:() => cards, readRoles:() => visibleRoles});
  for (const event of [question, answer]) appendLedger(event, home);
  const raw = reader.readEntries(), projected = reader.project(raw, cards);
  equalQueries(raw);equalQueries(projected);
  assert.equal(waitingLetters(raw).length, 1);assert.equal(waitingLetters(projected).length, 0);
  assert.strictEqual(reader.readEntries(), raw);assert.strictEqual(reader.project(raw, cards), projected);
  const changed = waitingLetters(raw);changed[0].replyRecipients.push('mutation');changed[0].role = 'mutation';
  equalQueries(raw);
  cards = [...cards, {...card, key:'other/task'}];
  equalQueries(reader.project(raw, cards)); // 다른 시점 카드에는 저장된 해석을 강제로 쓰지 않는다.
  const ambiguous = reader.readEntries();
  assert.notStrictEqual(ambiguous, raw);
  assert.deepEqual(reader.project(ambiguous, cards).map(entry => entry.mailId), ['a']);
  equalQueries(raw);equalQueries(projected);
  visibleRoles = [];const otherRoles = reader.readEntries();equalQueries(otherRoles);
  assert.notStrictEqual(otherRoles, ambiguous);
});

test('인계·읽음·세대·취소·최근 12통이 원래 저장 순서와 같고 미답변을 자르지 않는다', () => {
  const home = homeOf(), cards = [card];
  const reader = createWatchMailReader(home, () => readLedgerIncremental(home),
    {readCards:() => cards, readRoles:() => roles});
  appendLedger({kind:'send', role:card.role, taskId:card.id, executionKey:card.key, t:at}, home);
  for (let n = 0; n < 30; n++) appendLedger({...question, mailId:`q${n}`, t:n % 2 ? at : 'invalid'}, home);
  const original = reader.readEntries();equalQueries(original);
  assert.equal(waitingLetters(original).length, 30);
  assert.equal(recentLetters(original, question.by).length, 12);
  for (const event of [
    {kind:'mail-read', mailId:'q0', role:question.role, by:question.role, t:at},
    {kind:'handover', phase:'transferred', from:question.role, to:card.role, handoverId:'transfer', t:at},
    {kind:'start', role:card.role, session:`kadan-${card.role}`, panePid:5, t:at},
    {kind:'mail-cancel', mailId:'q1', role:card.role, by:question.by, t:at},
    {...answer, mailId:'late', replyTo:'q2', by:card.role, executionKey:undefined},
  ]) {
    appendLedger(event, home);const entries = reader.readEntries();
    equalQueries(entries);equalQueries(reader.project(entries, cards));
  }
  assert.equal(waitingLetters(original).length, 30);
});

test('카드 읽기 실패 뒤 원문 수집은 유지하고 회복 후 새 해석을 연결한다', () => {
  const home = homeOf();let fail = true;const cards = [card];
  appendLedger(question, home);appendLedger(answer, home);
  const readCards = () => {if (fail) throw Error('fixture cards unreadable');return cards;};
  const reader = createWatchMailReader(home, () => readLedgerIncremental(home), {readCards});
  const raw = reader.readEntries();assert.throws(readCards, /cards unreadable/);equalQueries(raw);
  assert.deepEqual(reader.project(raw, cards), project(raw, cards));
  fail = false;const next = reader.readEntries();equalQueries(reader.project(next, cards));
  assert.notStrictEqual(next, raw);
});

test('동시 쓰기가 끼어도 카드 주소·원장·우편은 하나의 원본 시점이다', () => {
  const home = homeOf();appendStream(home, 'cards/fixture/task/events.jsonl', card);
  appendLedger(question, home);
  const stores = createWatchStoreReaders(home);let injected = false;
  const readCards = () => {
    if (!injected) {
      injected = true;
      const code = `import {appendStream} from './src/storage.mjs';import {appendLedger} from './src/ledger.mjs';
        appendStream(process.argv[1],'cards/other/task/events.jsonl',JSON.parse(process.argv[2]));
        appendLedger(JSON.parse(process.argv[3]),process.argv[1]);`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, home,
        JSON.stringify({...card, key:'other/task'}), JSON.stringify(answer)],
      {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8', timeout:10_000});
      assert.equal(child.status, 0, child.stderr);
    }
    return stores.cards.read();
  };
  const reader = createWatchMailReader(home, () => readLedgerIncremental(home), {readCards});
  const old = reader.readEntries();assert.equal(old.length, 1);assert.equal(waitingLetters(old).length, 1);
  const next = reader.readEntries(), cards = stores.cards.read();
  assert.equal(next.length, 2);assert.equal(cards.length, 2);
  assert.deepEqual(reader.project(next, cards).map(entry => entry.mailId), ['a']);equalQueries(old);
});

test('재시작 때 누락된 해석 위치나 완료 중복 키를 복구하고 원본 사건을 보존한다', () => {
  for (const damaged of ['views', 'watch_mail_completions']) {
    const home = homeOf(), cards = [card];
    for (const event of [question, {kind:'done', role:card.role, taskId:card.id, result:'ok', t:at}]) {
      appendStream(home, 'ledger.jsonl', event);
    }
    const reader = createWatchMailReader(home, () => readLedgerIncremental(home), {readCards:() => cards});
    reader.readEntries();const original = readLedger(home);
    const db = new DatabaseSync(ledgerViewPath(home));
    try {db.exec(damaged === 'views' ? "DELETE FROM views WHERE domain='watch'" :
      'DELETE FROM watch_mail_completions');} finally {db.close();}
    const code = `import {withMailboxView,mailWaitingLetters} from './src/mail-view.mjs';
      const result=withMailboxView(process.argv[1],(store,info)=>({...info,letters:mailWaitingLetters(store)}),
        {domain:'watch',cards:JSON.parse(process.argv[2])});console.log(JSON.stringify(result));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, home, JSON.stringify(cards)],
      {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8', timeout:10_000});
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);assert.equal(result.projectionRebuilt, true);
    assert.deepEqual(result.letters, JSON.parse(JSON.stringify(mailboxLetters(project(original, cards),
      undefined, {view:'waiting'}))));
    assert.deepEqual(readLedger(home), original);
  }
});

test('같은 홈의 원본 파일이 교체되면 이전 해석 상태를 새 원본에서 다시 만든다', () => {
  const home = homeOf(), replacement = homeOf(), cards = [card];
  appendLedger(question, home);appendLedger(answer, home);
  appendLedger({...question, mailId:'replacement-q'}, replacement);
  appendLedger({...answer, mailId:'replacement-a', replyTo:'unknown'}, replacement);
  const reader = createWatchMailReader(home, () => readLedgerIncremental(home, {log:() => {}}),
    {readCards:() => cards, readRoles:() => roles});
  const old = reader.readEntries(), oldProjected = reader.project(old, cards);
  assert.equal(waitingLetters(oldProjected).length, 0);
  // 원본을 보존한 채 격리 홈의 DB만 교체한다. 열려 있는 transaction은 없다.
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path.join(home, `kadan.sqlite${suffix}`);
    if (fs.existsSync(file)) fs.renameSync(file, path.join(home, `original.sqlite${suffix}`));
  }
  fs.copyFileSync(path.join(replacement, 'kadan.sqlite'), path.join(home, 'kadan.sqlite'));
  const next = reader.readEntries(), projected = reader.project(next, cards);
  assert.deepEqual(waitingLetters(projected).map(letter => letter.mailId), ['replacement-q']);
  equalQueries(next);equalQueries(projected);equalQueries(old);equalQueries(oldProjected);
});
