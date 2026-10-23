import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {CardStore} from '../src/card-store.mjs';
import {markJsonl} from './helpers/legacy-jsonl.mjs';
import {ensureStorage, storageMode, appendStream, readStream, createDatabase, openDatabase, appendRow} from '../src/storage.mjs';
import {acquireInitLock, inspectInitLock} from '../src/storage-init-lock.mjs';
import {importStorage} from '../src/storage-migration.mjs';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-initlock-'));
const LOCK = '.storage-init.lock';
const storageUrl = JSON.stringify(new URL('../src/storage.mjs', import.meta.url).href);
const timed = fn => { const t = Date.now(); let error = null; try { fn(); } catch (e) { error = e; } return {ms: Date.now() - t, error}; };
const trashed = home => { try { return fs.readdirSync(path.join(home, '.trash')).filter(n => n.startsWith('storage-init-')); } catch { return []; } };
// 이미 끝난(=죽은) 프로세스의 pid. 시험이 끝나기 전에 같은 번호가 다시 쓰일 가능성은 무시할 만큼 작다.
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const writeOwner = (home, owner) => { const lock = path.join(home, LOCK); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner)); return lock; };
// 지정한 지점에서 SIGKILL로 죽는 초기화 자식(시험 전용 고리 KADAN_TEST_INIT_KILL).
const killedInit = (home, point) => {
  const code = `import {ensureStorage} from ${storageUrl}; ensureStorage(process.argv[1]);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, home], {env: {...process.env, KADAN_TEST_INIT_KILL: point}, encoding: 'utf8'});
  assert.equal(r.signal, 'SIGKILL', r.stderr);
  return r.pid;
};

test('정상 초기화 뒤 잠금·임시 폴더가 남지 않는다', () => {
  const home = root();
  ensureStorage(home);
  assert.equal(storageMode(home), 'sqlite');
  assert.deepEqual(fs.readdirSync(home).filter(n => n.startsWith('.storage-init')), []);
  assert.ok(!fs.existsSync(path.join(home, '.trash')));
});

test('rename 성질: owner.json이 있는 대상 잠금 위로는 실패하고, 빈 대상은 덮어쓴다', () => {
  const home = root(), tmp = () => { const d = fs.mkdtempSync(path.join(home, 'tmp-')); fs.writeFileSync(path.join(d, 'owner.json'), '{}'); return d; };
  const full = path.join(home, 'full'); fs.mkdirSync(full); fs.writeFileSync(path.join(full, 'owner.json'), '{}');
  assert.throws(() => fs.renameSync(tmp(), full), e => ['ENOTEMPTY', 'EEXIST'].includes(e.code));
  const empty = path.join(home, 'empty'); fs.mkdirSync(empty);
  fs.renameSync(tmp(), empty); // 빈 대상은 성공해서 덮어쓴다: 그래서 rename 전에 owner.json 없는 잠금을 먼저 막는다
  assert.ok(fs.existsSync(path.join(empty, 'owner.json')));
});

test('(가) 잠금 직후·DB 전에 죽은 초기화: 다음 쓰기가 기다리지 않고 성공하고 옛 잠금은 .trash에 남는다', () => {
  const home = root();
  const pid = killedInit(home, 'lock');
  assert.equal(inspectInitLock(home).state, 'dead');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, LOCK, 'owner.json'), 'utf8')).pid, pid);
  const {ms, error} = timed(() => appendStream(home, 'mail/events.jsonl', {n: 1}));
  assert.equal(error, null);
  assert.ok(ms < 2000, `기다리지 않아야 한다: ${ms}ms`);
  assert.equal(storageMode(home), 'sqlite');
  assert.deepEqual(readStream(home, 'mail/events.jsonl'), [{n: 1}]);
  const kept = trashed(home);
  assert.equal(kept.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.trash', kept[0], 'owner.json'), 'utf8')).pid, pid);
  assert.ok(!fs.existsSync(path.join(home, LOCK)));
});

test('(나) DB·스키마 뒤 표시 파일 전에 죽은 초기화: 읽기는 기다리지 않고, 다음 쓰기가 빈 DB를 .trash로 옮기고 새로 만든다', () => {
  const home = root();
  killedInit(home, 'db');
  assert.ok(fs.existsSync(path.join(home, 'kadan.sqlite')));
  assert.ok(!fs.existsSync(path.join(home, 'storage.json')));
  const read = timed(() => storageMode(home));
  assert.match(read.error.message, /저장소 선택 기록 없음/);
  assert.ok(read.ms < 1000, `죽은 주인이면 읽기는 기다리지 않는다: ${read.ms}ms`);
  assert.ok(fs.existsSync(path.join(home, LOCK)), '읽기는 회수하지 않는다');
  const write = timed(() => appendStream(home, 'mail/events.jsonl', {n: 2}));
  assert.equal(write.error, null);
  assert.ok(write.ms < 2000, `${write.ms}ms`);
  assert.deepEqual(readStream(home, 'mail/events.jsonl'), [{n: 2}]);
  const kept = trashed(home);
  assert.equal(kept.length, 1);
  assert.ok(fs.existsSync(path.join(home, '.trash', kept[0], 'kadan.sqlite')));
  assert.ok(fs.existsSync(path.join(home, '.trash', kept[0], 'owner.json')));
});

test('주인이 살아 있으면 회수하지 않고 기다리다 오류를 낸다', () => {
  const home = root();
  const lock = writeOwner(home, {pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname()});
  const {ms, error} = timed(() => acquireInitLock(home, {waitMs: 300}));
  assert.match(error.message, /초기화하고 있습니다/);
  assert.ok(ms >= 250 && ms < 3000, `${ms}ms`);
  assert.ok(fs.existsSync(lock));
  assert.deepEqual(trashed(home), []);
});

test('읽기 쪽 대기: 주인이 살아 있을 때만 DB만 있는 홈에서 기다린다', () => {
  const home = root();
  createDatabase(home);
  writeOwner(home, {pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname()});
  const live = timed(() => storageMode(home));
  assert.match(live.error.message, /저장소 선택 기록 없음/);
  assert.ok(live.ms >= 2500, `살아 있는 주인이면 기다린다: ${live.ms}ms`);
});

test('주인 없는 옛 빈 잠금: 기다리지 않고 정확한 오류, 회수 없음', () => {
  const home = root();
  const lock = path.join(home, LOCK); fs.mkdirSync(lock);
  const {ms, error} = timed(() => ensureStorage(home));
  assert.ok(error.message.startsWith(`초기화 잠금이 남아 있고 주인을 알 수 없습니다: ${lock}.`), error.message);
  assert.match(error.message, /\.trash\/로 옮긴 뒤 다시 실행하세요\.$/);
  assert.ok(!error.message.includes('잠시 뒤'));
  assert.ok(ms < 1000, `${ms}ms`);
  assert.ok(fs.existsSync(lock));
  assert.deepEqual(fs.readdirSync(lock), []);
  assert.ok(!fs.existsSync(path.join(home, '.trash')));
  assert.ok(!fs.existsSync(path.join(home, 'storage.json')));
});

test('owner.json이 깨졌거나 pid가 없으면 회수하지 않는다', () => {
  for (const owner of ['{not json', '{}', JSON.stringify({pid: 'x'}), JSON.stringify({pid: -1})]) {
    const home = root(), lock = writeOwner(home, owner);
    const {ms, error} = timed(() => ensureStorage(home));
    assert.match(error.message, /주인을 알 수 없습니다/, owner);
    assert.ok(ms < 1000);
    assert.ok(fs.existsSync(path.join(lock, 'owner.json')));
    assert.deepEqual(trashed(home), []);
  }
});

test('host가 달라도 죽은 pid면 회수한다(host는 기록만)', () => {
  const home = root();
  writeOwner(home, {pid: deadPid(), startedAt: '2026-01-01T00:00:00.000Z', host: 'some-other-machine'});
  ensureStorage(home);
  assert.equal(storageMode(home), 'sqlite');
  assert.equal(trashed(home).length, 1);
});

test('죽은 주인을 두 프로세스가 동시에 회수해도 오류 없이 둘 다 성공한다', async () => {
  const home = root();
  writeOwner(home, {pid: deadPid(), startedAt: '2026-01-01T00:00:00.000Z', host: os.hostname()});
  const code = `import {appendStream} from ${storageUrl};
const [home,start,n]=process.argv.slice(1);
while(Date.now()<Number(start));
appendStream(home,'mail/events.jsonl',{n:Number(n)});`;
  const start = String(Date.now() + 600);
  const run = n => new Promise(resolve => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, home, start, String(n)], {stdio: ['ignore', 'pipe', 'pipe']});
    let err = ''; p.stderr.on('data', d => err += d); p.on('close', status => resolve({status, err}));
  });
  const [a, b] = await Promise.all([run(1), run(2)]);
  assert.equal(a.status, 0, a.err);
  assert.equal(b.status, 0, b.err);
  assert.deepEqual(readStream(home, 'mail/events.jsonl').map(x => x.n).sort(), [1, 2]);
  assert.equal(trashed(home).length, 1, '옛 잠금은 한 번만 옮겨진다');
  assert.ok(!fs.existsSync(path.join(home, LOCK)));
});

test('반쯤 된 DB 파일이 0바이트거나 손상이면 아무것도 옮기지 않고 오류를 낸다', () => {
  for (const bytes of ['', 'garbage, not a database']) {
    const home = root();
    writeOwner(home, {pid: deadPid(), startedAt: '2026-01-01T00:00:00.000Z', host: os.hostname()});
    fs.writeFileSync(path.join(home, 'kadan.sqlite'), bytes);
    assert.throws(() => ensureStorage(home), /저장소 선택 기록 없음.*직접 확인하세요/s);
    assert.equal(fs.readFileSync(path.join(home, 'kadan.sqlite'), 'utf8'), bytes);
    assert.ok(!fs.existsSync(path.join(home, 'storage.json')));
    assert.ok(trashed(home).every(n => !fs.existsSync(path.join(home, '.trash', n, 'kadan.sqlite'))));
  }
});

test('DB에 행이 있는데 주인이 죽었으면 아무것도 옮기지 않고 오류를 낸다', () => {
  const home = root();
  createDatabase(home);
  const db = openDatabase(home); try { appendRow(db, 'mail/events.jsonl', {n: 1}); } finally { db.close(); }
  writeOwner(home, {pid: deadPid(), startedAt: '2026-01-01T00:00:00.000Z', host: os.hostname()});
  assert.throws(() => ensureStorage(home), /저장소 선택 기록 없음.*직접 확인하세요/s);
  assert.ok(fs.existsSync(path.join(home, 'kadan.sqlite')));
  assert.ok(trashed(home).every(n => !fs.existsSync(path.join(home, '.trash', n, 'kadan.sqlite'))));
});

test('잠금 없이 DB만 있는 홈은 자동 복구하지 않고 오류다', () => {
  const home = root();
  createDatabase(home);
  assert.throws(() => ensureStorage(home), /저장소 선택 기록 없음/);
  assert.ok(fs.existsSync(path.join(home, 'kadan.sqlite')));
  assert.ok(!fs.existsSync(path.join(home, '.trash')));
});

test('.trash가 있는 새 홈은 옛 흔적으로 보지 않는다', () => {
  const home = root();
  fs.mkdirSync(path.join(home, '.trash', 'storage-init-x'), {recursive: true});
  fs.writeFileSync(path.join(home, '.trash', 'storage-init-x', 'owner.json'), '{}');
  ensureStorage(home);
  assert.equal(storageMode(home), 'sqlite');
});

test('JSONL 이전은 .trash와 초기화 잠금 잔여물을 복사·목록에서 뺀다', () => {
  const source = markJsonl(root());
  new CardStore(source).create({repo: 'r', id: 'a', repoPath: source, body: '# a'});
  fs.mkdirSync(path.join(source, '.trash', 'storage-init-x'), {recursive: true});
  fs.writeFileSync(path.join(source, '.trash', 'storage-init-x', 'owner.json'), '{}');
  fs.mkdirSync(path.join(source, `${LOCK}.tmp-1-abcd`));
  fs.writeFileSync(path.join(source, `${LOCK}.tmp-1-abcd`, 'owner.json'), '{}');
  const target = source + '-sqlite';
  importStorage(source, target);
  assert.ok(!fs.existsSync(path.join(target, '.trash')));
  assert.ok(!fs.existsSync(path.join(target, `${LOCK}.tmp-1-abcd`)));
});
