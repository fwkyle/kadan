import './helpers/isolated-home.mjs';
// 새 홈 초기화는 SQLite 자체 잠금(BEGIN IMMEDIATE + 멱등 스키마 + application_id)으로 한다.
// 폴더 잠금·주인 기록·회수·.trash 이동이 없으므로, 재검수가 재현한 옛 경쟁(race-steal / race-dataloss / race-loop /
// race-unknown)의 멈춤 지점 — 잠금 폴더를 확인한 뒤 옮기는 rename — 은 더는 존재하지 않는다.
// 같은 목적(동시에 몰린 첫 쓰기가 서로 배타적이고, 커밋된 기록이 사라지지 않는다)은 아래 경쟁 시험이 대신한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {ensureStorage, storageMode, appendStream, readStream, createDatabase, openDatabase, appendRow, transaction} from '../src/storage.mjs';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-initrace-'));
const storageUrl = JSON.stringify(new URL('../src/storage.mjs', import.meta.url).href);
const timed = fn => { const t = Date.now(); let error = null; let value; try { value = fn(); } catch (e) { error = e; } return {ms: Date.now() - t, error, value}; };
const ALLOWED = new Set(['kadan.sqlite', 'kadan.sqlite-wal', 'kadan.sqlite-shm', 'storage.json']);
const strays = home => fs.readdirSync(home).filter(n => !ALLOWED.has(n));
const dbFiles = home => fs.readdirSync(home).filter(n => n.startsWith('kadan.sqlite'));
// 지정한 지점에서 SIGKILL로 죽는 초기화 자식(시험 전용 고리 KADAN_TEST_INIT_KILL).
const killedInit = (home, point) => {
  const code = `import {ensureStorage} from ${storageUrl}; ensureStorage(process.argv[1]);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, home], {env: {...process.env, KADAN_TEST_INIT_KILL: point}, encoding: 'utf8'});
  assert.equal(r.signal, 'SIGKILL', r.stderr);
};
// 시작 시각까지 잠들어 있다가 동시에 첫 쓰기를 하는 자식 3개(바쁜 대기 없음).
async function race(home, label) {
  const code = `import {appendStream} from ${storageUrl};
const [home,start,n]=process.argv.slice(1);
const wait=Number(start)-Date.now(); if(wait>0)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,wait);
appendStream(home,'mail/events.jsonl',{n:Number(n),label:process.argv[4]});
console.log('ok');`;
  const start = String(Date.now() + 400);
  const run = n => new Promise(resolve => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, home, start, String(n), label], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', status => resolve({status, out: out.trim(), err}));
  });
  return Promise.all([run(1), run(2), run(3)]);
}
function assertRaceOutcome(home, results, round) {
  for (const r of results) { assert.equal(r.status, 0, `라운드 ${round}: ${r.err}`); assert.equal(r.out, 'ok'); }
  assert.equal(storageMode(home), 'sqlite');
  assert.deepEqual(readStream(home, 'mail/events.jsonl').map(x => x.n).sort(), [1, 2, 3], `라운드 ${round}: 커밋한 모든 행이 있어야 한다`);
  assert.deepEqual(dbFiles(home).filter(n => n === 'kadan.sqlite'), ['kadan.sqlite'], '본 DB 파일은 하나뿐');
  assert.deepEqual(strays(home), [], `라운드 ${round}: 허용 밖 파일이 없어야 한다`);
}
const ROUNDS = 10;

test(`경쟁 (a) 빈 홈: 동시 첫 쓰기 3개 × ${ROUNDS}회, 전부 ok·모든 행이 하나의 DB에·다른 파일 0개`, async () => {
  for (let i = 0; i < ROUNDS; i++) { const home = root(); assertRaceOutcome(home, await race(home, 'a'), i); }
});

test(`경쟁 (b) 스키마 도중 SIGKILL로 남은 반쯤 된 홈: 동시 첫 쓰기 3개 × ${ROUNDS}회, 같은 결과`, async () => {
  for (let i = 0; i < ROUNDS; i++) { const home = root(); killedInit(home, 'schema'); assertRaceOutcome(home, await race(home, 'b'), i); }
});

test('SIGKILL (가) 스키마 전: 다음 쓰기는 대기 없이 성공하고, 읽기도 대기·오류 없이 돌려준다', () => {
  const home = root();
  killedInit(home, 'schema');
  const read = timed(() => storageMode(home));
  assert.equal(read.error, null, read.error?.message);
  assert.ok(['jsonl', 'sqlite'].includes(read.value)); // 빈 DB는 초기화 전과 같다(새 홈 읽기 = 빈 결과)
  assert.ok(read.ms < 1000, `읽기 ${read.ms}ms`);
  const write = timed(() => appendStream(home, 'mail/events.jsonl', {n: 1}));
  assert.equal(write.error, null, write.error?.message);
  assert.ok(write.ms < 2000, `쓰기 ${write.ms}ms`);
  assert.equal(storageMode(home), 'sqlite');
  assert.deepEqual(readStream(home, 'mail/events.jsonl'), [{n: 1}]);
  assert.deepEqual(strays(home), []);
});

test('SIGKILL (나) 커밋 뒤 표시 파일 전: 읽기는 대기 없이 sqlite, 다음 쓰기는 표시 파일을 마저 쓴다', () => {
  const home = root();
  killedInit(home, 'commit');
  assert.ok(!fs.existsSync(path.join(home, 'storage.json')));
  const read = timed(() => storageMode(home));
  assert.equal(read.value, 'sqlite');
  assert.ok(read.ms < 1000, `읽기 ${read.ms}ms`);
  assert.ok(!fs.existsSync(path.join(home, 'storage.json')), '읽기는 파일을 쓰지 않는다');
  const write = timed(() => appendStream(home, 'mail/events.jsonl', {n: 2}));
  assert.equal(write.error, null, write.error?.message);
  assert.ok(write.ms < 2000, `쓰기 ${write.ms}ms`);
  assert.deepEqual(readStream(home, 'mail/events.jsonl'), [{n: 2}]);
  assert.deepEqual(strays(home), []);
});

test('이미 커밋된 기록이 든 DB는 표시 파일이 없어도 그대로 열린다(기록이 사라지지 않는다)', () => {
  const home = root();
  createDatabase(home);
  const db = openDatabase(home); try { appendRow(db, 'mail/events.jsonl', {n: 7}); } finally { db.close(); }
  ensureStorage(home);
  assert.deepEqual(readStream(home, 'mail/events.jsonl'), [{n: 7}]);
  appendStream(home, 'mail/events.jsonl', {n: 8});
  assert.deepEqual(readStream(home, 'mail/events.jsonl').map(x => x.n), [7, 8]);
});

test('application_id가 다른 DB는 기존 오류이고 아무것도 옮기거나 바꾸지 않는다', () => {
  const home = root(), file = path.join(home, 'kadan.sqlite');
  const other = new DatabaseSync(file); other.exec('PRAGMA application_id=12345; CREATE TABLE t(x); INSERT INTO t VALUES (1);'); other.close();
  const before = fs.readFileSync(file);
  assert.throws(() => ensureStorage(home), /저장소 선택 기록 없음/);
  assert.throws(() => storageMode(home), /저장소 선택 기록 없음/);
  assert.ok(before.equals(fs.readFileSync(file)));
  assert.deepEqual(fs.readdirSync(home).sort(), ['kadan.sqlite']);
});

test('application_id는 카단 값이지만 user_version이 다른 DB는 남의 DB와 같게 오류이고 WAL 전환도 표시 파일 쓰기도 없다', () => {
  const home = root(), file = path.join(home, 'kadan.sqlite');
  const other = new DatabaseSync(file); other.exec('PRAGMA application_id=1262767153; PRAGMA user_version=2; CREATE TABLE t(x)'); other.close();
  const before = fs.readFileSync(file);
  assert.throws(() => storageMode(home), /저장소 선택 기록 없음/);
  assert.throws(() => ensureStorage(home), /저장소 선택 기록 없음/);
  assert.ok(before.equals(fs.readFileSync(file)), '파일 바이트가 그대로여야 한다');
  const check = new DatabaseSync(file, {readOnly: true});
  try { assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); } finally { check.close(); }
  assert.ok(!fs.existsSync(path.join(home, 'storage.json')));
  assert.deepEqual(fs.readdirSync(home).sort(), ['kadan.sqlite']);
});

test('표식은 없지만 테이블이 있는 DB도 건드리지 않는다', () => {
  const home = root(), file = path.join(home, 'kadan.sqlite');
  const other = new DatabaseSync(file); other.exec('CREATE TABLE events(x)'); other.close();
  const before = fs.readFileSync(file);
  assert.throws(() => ensureStorage(home), /저장소 선택 기록 없음/);
  assert.ok(before.equals(fs.readFileSync(file)));
});

test('0바이트가 아닌 깨진 DB는 기존 오류이고 아무것도 옮기지 않는다', () => {
  const home = root(), file = path.join(home, 'kadan.sqlite');
  fs.writeFileSync(file, 'garbage, not a database, definitely longer than a header ........................................');
  const before = fs.readFileSync(file);
  assert.throws(() => ensureStorage(home), /저장소 선택 기록 없음/);
  assert.throws(() => storageMode(home), /저장소 선택 기록 없음/);
  assert.ok(before.equals(fs.readFileSync(file)));
  assert.deepEqual(fs.readdirSync(home).sort(), ['kadan.sqlite']);
});

test('0바이트 DB 파일은 초기화 전으로 보고 다음 쓰기가 마저 만든다', () => {
  const home = root();
  fs.writeFileSync(path.join(home, 'kadan.sqlite'), '');
  assert.equal(storageMode(home), 'jsonl');
  appendStream(home, 'mail/events.jsonl', {n: 1});
  assert.equal(storageMode(home), 'sqlite');
  assert.deepEqual(readStream(home, 'mail/events.jsonl'), [{n: 1}]);
});

test('심볼릭 링크 DB와 본 파일 없이 -wal만 남은 홈은 오류다', () => {
  const link = root();
  fs.writeFileSync(path.join(link, 'real.sqlite'), '');
  fs.symlinkSync(path.join(link, 'real.sqlite'), path.join(link, 'kadan.sqlite'));
  assert.throws(() => ensureStorage(link), /저장소 선택 기록 없음/);
  const wal = root();
  fs.writeFileSync(path.join(wal, 'kadan.sqlite-wal'), '');
  assert.throws(() => ensureStorage(wal), /저장소 선택 기록 없음/);
  assert.deepEqual(fs.readdirSync(wal), ['kadan.sqlite-wal']);
});

test('코드가 DB 파일을 옮기거나 지우지 않는다: 어떤 시험 홈에도 .trash와 잠금 폴더가 생기지 않는다', () => {
  const home = root();
  killedInit(home, 'schema');
  appendStream(home, 'mail/events.jsonl', {n: 1});
  assert.ok(!fs.existsSync(path.join(home, '.trash')));
  assert.ok(!fs.readdirSync(home).some(n => n.startsWith('.storage-init')));
});

test('정상 경로(표시 파일 있음)는 DB를 열지 않고 바로 돌아온다', () => {
  const home = root();
  ensureStorage(home);
  const t = timed(() => { for (let i = 0; i < 200; i++) ensureStorage(home); });
  assert.equal(t.error, null);
  assert.ok(t.ms < 500, `${t.ms}ms`);
  assert.equal(transaction(home, db => db.prepare('PRAGMA application_id').get().application_id, {readOnly: true}), 1262767153);
});
