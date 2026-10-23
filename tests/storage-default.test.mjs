import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {CardStore} from '../src/card-store.mjs';
import {readLedger} from '../src/ledger.mjs';
import {ensureStorage, storageMode, storageVersion, storageSnapshot, readStream, appendStream, createDatabase, writeStorageMarker, transaction} from '../src/storage.mjs';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-default-'));
const put = (home, rel, text = '') => { fs.mkdirSync(path.dirname(path.join(home, rel)), {recursive: true}); fs.writeFileSync(path.join(home, rel), text); };
const marker = (home, backend) => put(home, 'storage.json', JSON.stringify({version: 1, backend}));
const child = (code, args = []) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', err = '';
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  p.on('error', reject); p.on('close', status => resolve({status, out, err}));
});

test('새 홈은 첫 쓰기에서 SQLite로 시작하고 사건이 DB에 들어간다', () => {
  const home = root();
  assert.deepEqual(fs.readdirSync(home), []);
  const card = new CardStore(home).create({repo: 'r', id: 'a', repoPath: home, body: '# a'});
  assert.equal(storageMode(home), 'sqlite');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'storage.json'), 'utf8')), {version: 1, backend: 'sqlite'});
  assert.ok(fs.existsSync(path.join(home, 'kadan.sqlite')));
  assert.equal(readStream(home, 'cards/r/a/events.jsonl')[0].revision, 1);
  assert.ok(!fs.existsSync(path.join(home, 'cards/r/a/events.jsonl')));
  assert.equal(new CardStore(home).get(card.key).key, 'r/a');
});

test('표시 파일이 있으면 ensureStorage는 아무것도 하지 않는다(backend:jsonl 포함)', () => {
  const home = root();
  marker(home, 'jsonl');
  ensureStorage(home);
  assert.equal(storageMode(home), 'jsonl');
  assert.deepEqual(fs.readdirSync(home).sort(), ['storage.json']);
});

const traces = {
  'ledger.jsonl': 'ledger.jsonl',
  'decisions/events.jsonl': 'decisions/events.jsonl',
  'cards 사건': 'cards/r/a/events.jsonl',
  'cards 보고': 'cards/r/a/briefs.jsonl',
  'cards card.md만': 'cards/r/a/card.md',
  'works 사건': 'works/r/w/events.jsonl',
  'tasks 사건': 'tasks/events.jsonl',
  'mail 사건': 'mail/events.jsonl',
  'system 사건': 'system/events.jsonl',
  'explain-ai.jsonl': 'explain-ai.jsonl',
  'storage-import.json': 'storage-import.json',
};
for (const [name, rel] of Object.entries(traces)) {
  test(`옛 흔적(${name})이 있고 표시 파일이 없으면 쓰기가 오류로 멈추고 아무것도 만들지 않는다`, () => {
    const home = root();
    put(home, rel, '{}\n');
    assert.throws(() => appendStream(home, 'mail/events.jsonl', {a: 1}), /옛 저장소 흔적이 있습니다.*jsonl-last/s);
    assert.ok(!fs.existsSync(path.join(home, 'kadan.sqlite')));
    assert.ok(!fs.existsSync(path.join(home, 'storage.json')));
    });
}

test('끊어진 링크 흔적도 오류다', () => {
  const home = root();
  fs.symlinkSync(path.join(home, 'nowhere'), path.join(home, 'ledger.jsonl'));
  assert.throws(() => ensureStorage(home), /옛 저장소 흔적/);
});

test('card.md만 남은 홈(DB만 사라진 사고)에 CardStore 쓰기는 오류다', () => {
  const home = root();
  put(home, 'cards/r/a/card.md', '# 옛');
  assert.throws(() => new CardStore(home).create({repo: 'r', id: 'b', repoPath: home, body: '# b'}), /옛 저장소 흔적/);
});

test('카단 표식이 있는 DB만 있고 표시 파일이 없으면 읽기는 sqlite, 쓰기는 표시 파일을 마저 쓴다', () => {
  const home = root();
  createDatabase(home);
  assert.equal(storageMode(home), 'sqlite'); // 읽기는 아무것도 쓰지 않는다
  assert.ok(!fs.existsSync(path.join(home, 'storage.json')));
  ensureStorage(home);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'storage.json'), 'utf8')), {version: 1, backend: 'sqlite'});
});

test('표시만 있음 / 미완성 스키마 / -wal만 있음은 오류다', () => {
  const walOnly = root();
  put(walOnly, 'kadan.sqlite-wal');
  assert.throws(() => ensureStorage(walOnly), /저장소 선택 기록 없음/);
  assert.throws(() => storageMode(walOnly), /저장소 선택 기록 없음/);
  const markerOnly = root();
  marker(markerOnly, 'sqlite');
  assert.throws(() => transaction(markerOnly, () => 1), /SQLite 원본 없음/);
  const partial = root();
  marker(partial, 'sqlite');
  put(partial, 'kadan.sqlite');
  assert.throws(() => transaction(partial, () => 1), /지원하지 않는 SQLite/);
});

test('동시에 첫 쓰기를 하는 두 프로세스: 한쪽만 만들고 둘 다 같은 DB에 사건을 남긴다', async () => {
  const home = root();
  const code = `import {appendStream} from ${JSON.stringify(new URL('../src/storage.mjs', import.meta.url).href)};
const [home,start,n]=process.argv.slice(1);
while(Date.now()<Number(start));
appendStream(home,'mail/events.jsonl',{n:Number(n)});`;
  const start = String(Date.now() + 600);
  const [a, b] = await Promise.all([child(code, [home, start, '1']), child(code, [home, start, '2'])]);
  assert.equal(a.status, 0, a.err);
  assert.equal(b.status, 0, b.err);
  assert.equal(storageMode(home), 'sqlite');
  assert.deepEqual(readStream(home, 'mail/events.jsonl').map(x => x.n).sort(), [1, 2]);
});

test('초기화 창(커밋 뒤 표시 파일 전)의 읽기는 기다리지 않고 sqlite를 본다', async () => {
  const home = root();
  createDatabase(home);
  const code = `import {storageMode} from ${JSON.stringify(new URL('../src/storage.mjs', import.meta.url).href)};
console.log(storageMode(process.argv[1]));`;
  const t = Date.now();
  const r = await child(code, [home]);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.trim(), 'sqlite');
  assert.ok(Date.now() - t < 3000);
});

test('빈 홈 읽기는 홈에 아무것도 만들지 않는다', () => {
  const home = root();
  assert.equal(storageMode(home), 'jsonl');
  assert.equal(storageVersion(home), null);
  assert.equal(storageSnapshot(home, () => 'ok'), 'ok');
  assert.deepEqual(new CardStore(home).list(), []);
  assert.deepEqual(readLedger(home), []);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('쓰기 일시정지는 ensureStorage보다 먼저 적용되어 홈을 만들지 않는다', () => {
  const home = root();
  put(home, 'storage-paused.json', '{}');
  assert.throws(() => ensureStorage(home), /저장 전환 중/);
  assert.ok(!fs.existsSync(path.join(home, 'kadan.sqlite')));
});

test('시험 격리 검사(실사용 홈 거부)도 ensureStorage보다 먼저다', () => {
  const live = path.join(os.homedir(), '.kadan');
  assert.throws(() => ensureStorage(live), /실사용 원장 사용 금지/);
});
