import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {appendLedger, readLedger, readTaskLedger, readMailLedger,
  readMailboxLedger, readSystemLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker, appendStream, storagePath, transaction} from '../src/storage.mjs';
import {ledgerStreams} from '../src/ledger-domains.mjs';
import {readLedgerViewPage, withLedgerView} from '../src/ledger-view.mjs';
import {ledgerViewPath, metaGet} from '../src/ledger-view-store.mjs';

const homeOf = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-ledger-view-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  return home;
};
const readers = new Map([[null, readLedger], ['tasks', readTaskLedger], ['mail', readMailLedger],
  ['mailbox', readMailboxLedger], ['system', readSystemLedger]]);
const add = (home, value) => appendLedger({t:'2026-01-01T00:00:00Z', ...value}, home);
function task(home, id, role = 'fixture-worker') {
  add(home, {kind:'send', role, by:'fixture-lead', taskId:id, executionKey:`test/${id}`, mailId:`mail-${id}`});
}
function completed(home, id, role = 'fixture-worker') {
  add(home, {kind:'done', role, taskId:id, executionKey:`test/${id}`, result:'ok'});
}
function allPages(home, domain, limit = 7) {
  const rows = [];
  let before = null;
  do {
    const result = readLedgerViewPage(home, {domain, before, limit});
    rows.push(...result.items);before = result.next;
    assert.ok(rows.length <= result.total);
  } while (before !== null);
  return rows;
}
function equalViews(home) {
  for (const [domain, read] of readers) assert.deepEqual(allPages(home, domain), read(home).reverse(), String(domain));
}

test('다섯 영역과 첫 완료·인계·과거 원문이 재생/증분/페이지에서도 같다', () => {
  const home = homeOf();
  appendStream(home, 'ledger.jsonl', {kind:'start', role:'fixture-worker', session:'kadan-fixture-worker', panePid:1});
  appendStream(home, 'ledger.jsonl', {kind:'send', role:'fixture-worker', by:'fixture-lead', taskId:'old',
    mailId:'old-mail', expectReply:true});
  task(home, 'first');completed(home, 'first');completed(home, 'first');
  add(home, {kind:'watch-ai-request', parents:[['long', 'relation']], routes:[['long', 'route']], timing:{a:1}});
  add(home, {kind:'watch-mail-reminder', mailId:'old-mail', role:'fixture-worker',
    action:'result', delivery:'sent', stage:'first'});
  equalViews(home);
  assert.equal(readLedgerViewPage(home).applied, 0);
  task(home, 'transfer');
  add(home, {kind:'handover', phase:'transferred', from:'fixture-worker', to:'fixture-next',
    handoverId:'h', taskIds:['test/transfer']});
  completed(home, 'transfer', 'fixture-next');
  equalViews(home);
  const page = readLedgerViewPage(home, {domain:'mail', limit:1});
  assert.equal(page.items[0].systemGenerated, 'task-completion');
  assert.equal(page.items[0].role, 'fixture-lead');
});

test('256행 경계의 send/dispatch와 done/결과 우편을 나눠 확정하지 않는다', () => {
  const home = homeOf();
  transaction(home, () => {
    for (let i = 0; i < 253; i++) add(home, {kind:'watch-cycle', by:'watch', n:i});
    task(home, 'boundary');completed(home, 'boundary');
    for (let i = 0; i < 300; i++) add(home, {kind:'watch-cycle', by:'watch', n:i});
  });
  equalViews(home);
  const info = readLedgerViewPage(home);
  assert.equal(info.position, 557);
  assert.equal(info.total, 556, '원본 dispatch는 통합 화면에서 빠진다');
});

test('새 프로세스에서도 이전 검증 위치 뒤만 적용하고 원본 사건은 바뀌지 않는다', () => {
  const home = homeOf();task(home, 'restart');
  const before = readLedgerViewPage(home);
  completed(home, 'restart');
  const script = `import {readLedgerViewPage} from './src/ledger-view.mjs';
    console.log(JSON.stringify(readLedgerViewPage(process.argv[1])));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, home],
    {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8'});
  assert.equal(child.status, 0, child.stderr);
  const after = JSON.parse(child.stdout);
  assert.equal(after.generation, before.generation);
  assert.equal(after.applied, 2);
  assert.equal(after.rebuilt, false);
  equalViews(home);
});

test('검증 실패는 조회 상태와 cursor를 모두 되돌리고 손상을 빈 목록으로 숨기지 않는다', () => {
  const home = homeOf();task(home, 'failure');
  const previous = readLedgerViewPage(home);
  appendStream(home, ledgerStreams.tasks, {kind:'done', role:'fixture-worker', taskId:'failure',
    executionKey:'test/failure', result:'ok', completionMailId:'missing', _ledgerOrder:2});
  assert.throws(() => readLedgerViewPage(home), /완료 우편 연결 손상/);
  const db = new DatabaseSync(ledgerViewPath(home), {readOnly:true});
  try {
    assert.equal(Number(metaGet(db, 'position')), previous.position);
    assert.equal(metaGet(db, 'generation'), previous.generation);
    assert.equal(db.prepare('SELECT seq FROM cursors WHERE stream=?').get(ledgerStreams.tasks).seq, 1);
  } finally {db.close();}
  assert.throws(() => readLedgerViewPage(home), /완료 우편 연결 손상/);
});

test('원본 파일 교체와 옛 스트림 추가는 새 세대로 재생한다', () => {
  const home = homeOf();task(home, 'replace');
  const first = readLedgerViewPage(home);
  appendStream(home, 'ledger.jsonl', {kind:'send', role:'fixture-old', by:'fixture-lead'});
  const changed = readLedgerViewPage(home);
  assert.equal(changed.rebuilt, true);
  assert.notEqual(changed.generation, first.generation);
  equalViews(home);
  const replacement = homeOf();task(replacement, 'different');
  fs.renameSync(storagePath(home), path.join(home, 'preserved.sqlite'));
  fs.copyFileSync(storagePath(replacement), storagePath(home));
  const restored = readLedgerViewPage(home);
  assert.equal(restored.rebuilt, true);
  assert.notEqual(restored.generation, changed.generation);
  equalViews(home);
});

test('과거 중복 우편·인계 충돌과 모르는 영역은 기존처럼 실패한다', () => {
  const home = homeOf();
  appendStream(home, 'ledger.jsonl', {kind:'send', mailId:'duplicate'});
  appendStream(home, 'ledger.jsonl', {kind:'send', mailId:'duplicate'});
  assert.throws(() => readLedgerViewPage(home, {domain:'mailbox'}), /중복 mailId/);
  assert.throws(() => readLedgerViewPage(home, {domain:'other'}), /지원하지 않는/);
  const second = homeOf();
  for (const to of ['b', 'c']) add(second, {kind:'handover', phase:'transferred', from:'a', to, handoverId:'dup'});
  assert.throws(() => readLedgerViewPage(second, {domain:'mailbox'}), /인계 책임 충돌/);
});

test('없는 홈 조회는 캐시도 만들지 않고 빈 결과, cursor와 제한값은 검사한다', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-view-empty-')), 'absent');
  assert.deepEqual(readLedgerViewPage(home).items, []);
  assert.equal(fs.existsSync(home), false);
  assert.throws(() => readLedgerViewPage(home, {limit:0}), /1~200/);
  assert.throws(() => readLedgerViewPage(home, {before:NaN}), /위치/);
});

test('읽기 중 예외도 원자적이고 다음 조회는 원본에서 다시 적용한다', () => {
  const home = homeOf();task(home, 'retry');
  assert.throws(() => withLedgerView(home, () => {throw new Error('render failed');}), /render failed/);
  const result = readLedgerViewPage(home);
  assert.equal(result.rebuilt, true);
  assert.equal(result.applied, 2);
  equalViews(home);
});

test('조회 상태 commit 직전 강제 종료 뒤 이전 cursor에서 다시 적용한다', () => {
  const home = homeOf();task(home, 'crash');
  const before = readLedgerViewPage(home);
  completed(home, 'crash');
  const script = `import {DatabaseSync} from 'node:sqlite';
    import {readLedgerViewPage} from './src/ledger-view.mjs';
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'COMMIT' && this.prepare('PRAGMA application_id').get().application_id === 1262767154)
        process.kill(process.pid, 'SIGKILL');
      return exec.call(this, sql);
    };
    readLedgerViewPage(process.argv[1]);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, home],
    {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8', timeout:10000});
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const after = readLedgerViewPage(home);
  assert.equal(after.generation, before.generation);
  assert.equal(after.applied, 2);
  equalViews(home);
});

test('동시 첫 조회는 같은 확정 상태를 읽고 중복 적용하지 않는다', async () => {
  const home = homeOf();task(home, 'concurrent');completed(home, 'concurrent');
  const run = () => new Promise((resolve, reject) => {
    const script = `import {readLedgerViewPage} from './src/ledger-view.mjs';
      console.log(JSON.stringify(readLedgerViewPage(process.argv[1])));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, home],
      {cwd:path.resolve(import.meta.dirname, '..'), stdio:['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', value => {stdout += value;});
    child.stderr.on('data', value => {stderr += value;});
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results[0].generation, results[1].generation);
  assert.equal(results[0].applied + results[1].applied, 4);
  assert.deepEqual(results[0].items, results[1].items);
});

test('조회 cursor 메타 손상은 원본에서 새 세대로 재생하며 원본은 불변이다', () => {
  const home = homeOf();task(home, 'damaged-cache');completed(home, 'damaged-cache');
  const before = readLedgerViewPage(home), original = JSON.stringify(readLedger(home));
  const db = new DatabaseSync(ledgerViewPath(home));
  try {db.prepare("UPDATE meta SET value='999999' WHERE key='position'").run();} finally {db.close();}
  const after = readLedgerViewPage(home);
  assert.equal(after.rebuilt, true);assert.notEqual(after.generation, before.generation);
  assert.deepEqual(after.items, before.items);
  assert.equal(JSON.stringify(readLedger(home)), original);
});

test('재시작은 원본 중간 행과 조회 행 누락도 대조한다', () => {
  const home = homeOf();
  add(home, {kind:'watch-cycle', by:'watch', note:'old'});
  add(home, {kind:'alert', role:'fixture-worker'});
  const before = readLedgerViewPage(home);
  const script = `import {readLedgerViewPage} from './src/ledger-view.mjs';
    console.log(JSON.stringify(readLedgerViewPage(process.argv[1])));`;
  const child = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, home],
      {cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);return JSON.parse(result.stdout);
  };
  transaction(home, db => {
    db.exec('DROP TRIGGER events_no_update');
    db.prepare("UPDATE events SET payload=json_set(payload,'$.note','changed') WHERE stream=? AND seq=1")
      .run(ledgerStreams.system);
  });
  const changed = child();
  assert.equal(changed.rebuilt, true);assert.notEqual(changed.generation, before.generation);
  assert.equal(changed.items.find(row => row.kind === 'watch-cycle').note, 'changed');
  const cache = new DatabaseSync(ledgerViewPath(home));
  try {cache.prepare("DELETE FROM views WHERE domain='' AND position=1").run();} finally {cache.close();}
  const repaired = child();
  assert.equal(repaired.rebuilt, true);assert.deepEqual(repaired.items, changed.items);
});

test('끊어진 캐시 링크는 대상 파일을 생성하지 않는다', () => {
  const home = homeOf(), file = ledgerViewPath(home), target = path.join(home, 'must-not-create.sqlite');
  fs.mkdirSync(path.dirname(file));fs.symlinkSync(target, file);
  assert.throws(() => readLedgerViewPage(home), /조회 캐시 링크/);
  assert.equal(fs.existsSync(target), false);
});

test('결과 우편 없는 완료 연속 기록은 묶음을 무제한 키우지 않고 거부한다', () => {
  const home = homeOf();
  transaction(home, () => {
    for (let i = 0; i < 1000; i++) appendStream(home, ledgerStreams.tasks, {kind:'done',
      role:'fixture-worker', taskId:'bad-chain', completionMailId:`missing-${i}`, _ledgerOrder:i + 1});
  });
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = function(value, ...rest) {
    if (typeof value === 'string' && value.includes('bad-chain')) parsed++;
    return parse(value, ...rest);
  };
  try {assert.throws(() => readLedgerViewPage(home), /완료 우편 연결 손상/);} finally {JSON.parse = parse;}
  assert.ok(parsed < 10, String(parsed));
});

test('물리적으로 읽을 수 없는 조회 DB는 실패하고 보존 후 원본에서 재생할 수 있다', () => {
  const home = homeOf();task(home, 'repair');completed(home, 'repair');
  const before = readLedgerViewPage(home), original = JSON.stringify(readLedger(home));
  const file = ledgerViewPath(home);
  fs.renameSync(file, path.join(home, 'valid-cache-evidence.sqlite'));
  fs.writeFileSync(file, 'broken sqlite fixture', {mode:0o600});
  assert.throws(() => readLedgerViewPage(home), /database|SQLite|캐시/);
  fs.renameSync(file, path.join(home, 'broken-cache-evidence.sqlite'));
  const after = readLedgerViewPage(home);
  assert.equal(after.rebuilt, true);assert.notEqual(after.generation, before.generation);
  assert.deepEqual(after.items, before.items);
  assert.equal(JSON.stringify(readLedger(home)), original);
});
