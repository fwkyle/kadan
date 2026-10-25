import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {taskIdentity, taskConnectionError} from '../src/task-identity.mjs';

const at = '2026-01-01T00:00:00Z';
const old = (entries, cards) => taskIdentity(cards).project(entries).filter(e => !taskConnectionError(e));

// 사건이 하나씩 이어 붙을 때마다 증분 해석이 처음부터 다시 해석한 결과와 같아야 한다.
test('증분 해석은 모든 prefix에서 전체 재해석과 같다(별칭 뒤 최초 완료·카드 주소 변화·연결 오류 포함)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-projection-memo-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  let cards = [{key:'a/t1', id:'t1', role:'w', status:'assigned', revision:1, at}];
  const reader = createWatchMailReader(home, null, {readCards:() => cards, readRoles:() => ['w']});
  const events = [
    {kind:'start', role:'w', session:'kadan-w', panePid:1, t:at},
    {kind:'send', role:'w', by:'lead', mailId:'m1', taskId:'t1', t:at},
    {kind:'done', role:'w', taskId:'t1', result:'ok', t:at},
    {kind:'done', role:'w', taskId:'a/t1', executionKey:'a/t1', result:'failed', t:at}, // 같은 카드 별칭 중복 완료
    {kind:'send', role:'w', by:'lead', mailId:'m2', taskId:'t9', t:at}, // 미등록
    {kind:'send', role:'w', by:'lead', mailId:'m3', taskId:'t1', executionKey:'zz/none', t:at}, // 연결 오류
    {kind:'done', role:'w', taskId:'t2', result:'ok', t:at},
  ];
  for (const [index, event] of events.entries()) {
    appendLedger(event, home);
    const raw = reader.readEntries();
    assert.deepEqual(reader.project(raw, cards), old(raw, cards), `prefix ${index + 1}`);
    if (index === 3) cards = [...cards, {key:'a/t2', id:'t2', role:'w', status:'assigned', revision:1, at}];
  }
  // 새 카드 주소로 앞 해석이 바뀌어도(미등록 → 등록) 같다.
  const raw = reader.readEntries();
  assert.deepEqual(reader.project(raw, cards), old(raw, cards));
  // 같은 수집을 다시 받아도 이미 내준 배열을 재사용하지 않는다.
  const first = reader.project(raw, cards);
  assert.notStrictEqual(reader.project(raw.slice(), cards), first);
  assert.deepEqual(reader.project(raw.slice(), cards), first);
});
