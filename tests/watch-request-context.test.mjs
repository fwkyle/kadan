import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {appendLedger, readLedger, readWatchRequest} from '../src/ledger.mjs';
import {appendStream, readStream, storageSnapshot, transaction} from '../src/storage.mjs';
import {verifyStorage} from '../src/storage-migration.mjs';

// Why: 신규 참조가 과거 원본과 같은 관계표를 돌려주고, 중단·동시 쓰기에도 요청과 함께 저장되어야 한다.
const makeHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-context-'));
const request = id => ({kind: 'watch-ai-request', requestId: id, t: '2026-01-01T00:00:00Z',
  role: 'qa-worker', parents: [['qa-worker', 'qa-lead'], ['qa-lead', '@user']], routes: [['qa', 'qa-lead']]});
const contexts = home => storageSnapshot(home, db => db.prepare(
  "SELECT stream,seq,payload FROM events WHERE stream GLOB 'watch-context/*' ORDER BY stream,seq").all());
const moduleUrl = name => new URL(`../src/${name}.mjs`, import.meta.url).href;

test('같은 내용은 한 번 저장하고 신규/옛 요청은 원래 관계표·순서로 읽는다', () => {
  const home = makeHome(), first = request('first'), original = JSON.stringify(first);
  const returned = JSON.parse(appendLedger(first, home));
  appendLedger(request('second'), home);
  assert.deepEqual(returned, first);
  assert.equal(JSON.stringify(first), original, '입력 객체를 바꾸지 않는다');
  assert.equal(contexts(home).length, 1);
  const stored = readStream(home, 'system/events.jsonl');
  assert.equal(stored[0].contextRef, stored[1].contextRef);
  assert.equal(stored[0].parents, undefined);
  const {contextRef, _ledgerOrder, ...full} = readWatchRequest(home, 'first');
  assert.deepEqual(full, first);
  assert.match(contextRef, /^[a-f0-9]{64}$/);
  assert.equal(readLedger(home).find(e => e.requestId === 'first').parents, undefined);
  const old = {...request('old'), _ledgerOrder: 3};
  appendStream(home, 'system/events.jsonl', old);
  const oldPayload = storageSnapshot(home, db => db.prepare(
    "SELECT payload FROM events WHERE stream='system/events.jsonl' AND seq=3").get().payload);
  const changed = request('changed');changed.parents.reverse();
  appendLedger(changed, home);
  assert.equal(contexts(home).length, 2, '배열 순서도 내용의 일부다');
  assert.deepEqual(readWatchRequest(home, 'old'), old);
  assert.equal(storageSnapshot(home, db => db.prepare(
    "SELECT payload FROM events WHERE stream='system/events.jsonl' AND seq=3").get().payload), oldPayload);
  assert.equal(verifyStorage(home).integrity, 'ok');
});

test('요청 저장 실패는 새 관계표도 되돌리고, 원본 수정·삭제는 거절한다', () => {
  const home = makeHome();appendLedger({kind: 'watch-cycle'}, home);
  transaction(home, db => db.exec(`CREATE TRIGGER reject_request BEFORE INSERT ON events
    WHEN json_extract(NEW.payload,'$.kind')='watch-ai-request'
    BEGIN SELECT RAISE(ABORT,'injected failure'); END;`));
  assert.throws(() => appendLedger(request('rolled-back'), home), /injected failure/);
  assert.deepEqual(contexts(home), []);
  assert.equal(readWatchRequest(home, 'rolled-back'), null);
  transaction(home, db => db.exec('DROP TRIGGER reject_request'));
  appendLedger(request('saved'), home);
  for (const sql of ["UPDATE events SET payload='{}' WHERE stream GLOB 'watch-context/*'",
    "DELETE FROM events WHERE stream GLOB 'watch-context/*'"])
    assert.throws(() => transaction(home, db => db.exec(sql)), /이력.*금지/);
});

test('없는·깨진 참조와 중복 맥락 행은 빈 경로로 읽지 않고 실패한다', () => {
  for (const bad of [null, 'bad', 'a'.repeat(64)]) {
    const home = makeHome();
    appendStream(home, 'system/events.jsonl', {kind: 'watch-ai-request', requestId: 'bad',
      contextRef: bad, _ledgerOrder: 1});
    assert.throws(() => readWatchRequest(home, 'bad'), /관계표 참조 손상/);
    assert.throws(() => verifyStorage(home), /관계표 참조 손상/);
  }
  const corrupt = makeHome();
  appendStream(corrupt, `watch-context/${'b'.repeat(64)}.jsonl`,
    {kind: 'watch-ai-context', version: 1, parents: [], routes: []});
  appendStream(corrupt, 'system/events.jsonl', {kind: 'watch-ai-request', requestId: 'wrong-hash',
    contextRef: 'b'.repeat(64), _ledgerOrder: 1});
  assert.throws(() => readWatchRequest(corrupt, 'wrong-hash'), /관계표 참조 손상/);
  assert.throws(() => verifyStorage(corrupt), /관계표 참조 손상/);
  const home = makeHome();appendLedger(request('good'), home);
  const row = contexts(home)[0];appendStream(home, row.stream, JSON.parse(row.payload));
  assert.throws(() => readWatchRequest(home, 'good'), /관계표 참조 손상/);
  assert.throws(() => appendLedger(request('again'), home), /관계표 참조 손상/);
  assert.equal(readWatchRequest(home, 'again'), null);
  assert.throws(() => appendLedger({...request('injected'), contextRef: 'a'.repeat(64)}, home), /저장 모듈/);
});

test('다른 프로세스의 동시 요청도 관계표 한 줄을 공유한다', async () => {
  const home = makeHome();appendLedger({kind: 'watch-cycle'}, home);
  await Promise.all(Array.from({length: 4}, (_, i) => new Promise((resolve, reject) => {
    const code = `import {appendLedger} from ${JSON.stringify(moduleUrl('ledger'))};
      appendLedger(${JSON.stringify(request(`concurrent-${i}`))},${JSON.stringify(home)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code],
      {env: {...process.env, KADAN_HOME: home}, stdio: ['ignore', 'ignore', 'pipe']});
    let error = '';child.stderr.on('data', text => { error += text; });
    child.on('error', reject);
    child.on('exit', status => status === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.equal(contexts(home).length, 1);
  assert.equal(readLedger(home).filter(e => e.kind === 'watch-ai-request').length, 4);
  assert.equal(verifyStorage(home).integrity, 'ok');
});

test('요청+맥락을 쓴 뒤 커밋 전에 강제 종료해도 둘 다 남지 않는다', () => {
  const home = makeHome();appendLedger({kind: 'watch-cycle'}, home);
  const code = `import {appendLedger} from ${JSON.stringify(moduleUrl('ledger'))};
    import {transaction} from ${JSON.stringify(moduleUrl('storage'))};
    transaction(${JSON.stringify(home)},()=>{
      appendLedger(${JSON.stringify(request('killed'))},${JSON.stringify(home)});
      process.kill(process.pid,'SIGKILL');
    });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8', timeout: 15000});
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(readWatchRequest(home, 'killed'), null);
  assert.deepEqual(contexts(home), []);
  appendLedger(request('recovered'), home);
  assert.equal(contexts(home).length, 1);
  assert.equal(verifyStorage(home).integrity, 'ok');
});
