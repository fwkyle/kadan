import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {storageMode, storageVersion, storageSnapshot, readStream, listStreams, streamHeads, streamRowPayload,
  ensureStorage} from '../src/storage.mjs';
import {readLedger, appendLedger, findMailBySourceKey, findMailBySourceKeyAny, readWatchRequest, ledgerPath} from '../src/ledger.mjs';
import {readLedgerState} from '../src/ledger-domains.mjs';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {DecisionStore} from '../src/decisions.mjs';

// Why: 'jsonl'이 겸하던 '아직 저장소 없음'(빈 홈)은 'none'이 맡는다. 빈 홈 읽기는 DB를 열지 않고 빈 결과를 주며 파일을 만들지 않는다.
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-storage-none-'));
const cli = (args, home) => spawnSync(process.execPath, ['src/cli.mjs', ...args], {
  cwd: process.cwd(), encoding: 'utf8',
  env: {...process.env, KADAN_HOME: home, KADAN_SOCKET: `t-none-${process.pid}`, KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_ROLE: ''},
});

test("빈 홈은 'none'이고 저수준 읽기는 DB를 열지 않고 빈 결과를 준다(listStreams·streamHeads는 오류가 아니다)", () => {
  const home = root();
  assert.equal(storageMode(home), 'none');
  assert.equal(storageVersion(home), null);
  assert.equal(storageSnapshot(home, (...args) => args.length), 0, "'none'은 db 인자 없이 fn()만 부른다");
  assert.deepEqual(readStream(home, 'ledger.jsonl', {optional: true}), []);
  assert.deepEqual(readStream(home, 'mail/events.jsonl', {optional: true, after: 3}), []);
  assert.throws(() => readStream(home, 'mail/events.jsonl'), /기록 없음/);
  assert.deepEqual(listStreams(home), []);
  assert.deepEqual(listStreams(home, 'cards/'), []);
  assert.equal(streamHeads(home, ['ledger.jsonl', 'mail/events.jsonl']).size, 0);
  assert.equal(streamRowPayload(home, 'ledger.jsonl', 1), null);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("빈 홈의 원장·카드·좁은 조회는 빈 결과이고 홈에 아무것도 만들지 않는다", () => {
  const home = root();
  assert.deepEqual(readLedger(home), []);
  const state = readLedgerState(home);
  assert.deepEqual([state.legacy, state.ordered], [[], []]);
  assert.equal(findMailBySourceKey(home, 'worker', 'k1'), null);
  assert.equal(findMailBySourceKeyAny(home, 'k1'), null);
  assert.equal(readWatchRequest(home, 'req-1'), null);
  assert.deepEqual(new CardStore(home).list(), []);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("ledgerPath는 저장소 경로(kadan.sqlite)이고 빈 홈에서도 파일을 만들지 않는다", () => {
  const home = root();
  const before = process.env.KADAN_HOME;
  process.env.KADAN_HOME = home;
  try {
    assert.equal(ledgerPath(), path.join(home, 'kadan.sqlite'));
  } finally { process.env.KADAN_HOME = before; }
  assert.deepEqual(fs.readdirSync(home), []);
});

test("빈 홈: kadan status는 종료 0이고 파일을 만들지 않는다", () => {
  const home = root();
  const r = cli(['status'], home);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("빈 홈: kadan doctor는 저장소 항목을 '해당 없음'으로 알리고 오류 없이 파일을 만들지 않는다", () => {
  const home = root();
  const r = cli(['doctor', '--json'], home);
  const report = JSON.parse(r.stdout); // gui/dist·기반 프로세스가 없는 환경에서는 종료 1일 수 있다: 저장소 항목만 본다
  const storage = report.checks.find(check => check.id === 'storage');
  assert.equal(storage.state, 'na', JSON.stringify(storage));
  assert.deepEqual(fs.readdirSync(home), []);
});

test("빈 홈: 대시보드 요약 읽기는 오류 없이 빈 결과이고 파일을 만들지 않는다", () => {
  const home = root();
  const code = "const {loadWallSnapshot}=await import('./src/commands/tree-wall.mjs');const s=loadWallSnapshot();"
    + "console.log(JSON.stringify({entries:s.entries.length,ledgerLines:s.ledgerLines,error:s.error??null}));";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(), encoding: 'utf8',
    env: {...process.env, KADAN_HOME: home, KADAN_SOCKET: `t-none-${process.pid}`, KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_ROLE: ''},
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {entries: 0, ledgerLines: 0, error: null});
  assert.deepEqual(fs.readdirSync(home), []);
});

test("첫 쓰기가 SQLite를 만들면 같은 홈이 'sqlite'로 바뀌고 이전 빈 읽기와 어긋나지 않는다", () => {
  const home = root();
  assert.equal(storageMode(home), 'none');
  appendLedger({kind: 'start', role: 'a', session: 's'}, home);
  assert.equal(storageMode(home), 'sqlite');
  assert.deepEqual(readLedger(home).map(row => row.kind), ['start']);
  assert.equal(typeof storageVersion(home), 'number');
});

test("표시 파일이 backend:jsonl인 옛 저장소는 읽기·쓰기 모두 jsonl-last 변환 안내 오류이고 홈을 바꾸지 않는다", () => {
  const home = root();
  fs.writeFileSync(path.join(home, 'storage.json'), JSON.stringify({version: 1, backend: 'jsonl'}) + '\n');
  for (const [name, run] of Object.entries({
    storageMode: () => storageMode(home),
    ensureStorage: () => ensureStorage(home),
    readLedger: () => readLedger(home),
    appendLedger: () => appendLedger({kind: 'test'}, home),
    cards: () => new CardStore(home).list(),
  })) assert.throws(run, /jsonl-last/, name);
  assert.deepEqual(fs.readdirSync(home), ['storage.json']);
});

test("알 수 없는 backend 값은 JSONL 안내가 아니라 잘못된 저장소 설정 오류다", () => {
  const home = root();
  fs.writeFileSync(path.join(home, 'storage.json'), JSON.stringify({version: 1, backend: 'mystery'}) + '\n');
  assert.throws(() => storageMode(home), /잘못된 저장소 설정/);
});

// Why: 쓰기 경로는 모드를 보지 않고 항상 transaction이다. 'none' 홈의 첫 쓰기가 조용히 아무 일도 안 하면 안 된다.
const workArgs = (home, key = 'repo/w1') => ['work', 'create', key, '--title', '제목', '--goal', '결과', '--scope', '범위',
  '--acceptance', '조건', '--owner', '감독', '--repo-path', home];

test("빈 홈: kadan work create는 SQLite를 만들고 바로 뒤 work list에 보인다", () => {
  const home = root();
  assert.equal(storageMode(home), 'none');
  const made = cli(workArgs(home), home);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(storageMode(home), 'sqlite');
  assert.ok(fs.existsSync(path.join(home, 'kadan.sqlite')));
  const listed = cli(['work', 'list'], home);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /repo\/w1/);
});

test("빈 홈: kadan card create는 SQLite를 만들고 바로 뒤 card list에 보인다", () => {
  const home = root(), source = path.join(root(), 'card.md');
  fs.writeFileSync(source, '# 새 카드\n\n본문\n');
  const made = cli(['card', 'create', 'repo/c1', '--repo-path', home, '--source', source], home);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(storageMode(home), 'sqlite');
  const store = new CardStore(home);
  assert.deepEqual(store.list().map(card => card.key), ['repo/c1']);
  assert.deepEqual(store.listSummaries().map(card => card.key), ['repo/c1']);
  assert.deepEqual(store.listWatch().map(card => card.key), ['repo/c1']);
  assert.equal(store.get('repo/c1').revision, 1);
  assert.match(cli(['card', 'list'], home).stdout, /repo\/c1/);
});

test("빈 홈: 결정 한 건을 쓰면 SQLite가 생기고 같은 홈 목록에 보인다", () => {
  const home = root();
  const store = new DecisionStore(home);
  assert.deepEqual(store.list(), []);
  const saved = store.locked(() => store.write({id: 'd1', revision: 1, card: null, chat: true, work: 'repo/w1', to: '@user',
    requestedBy: 'a-슈퍼감독', question: '질문?', options: ['예', '아니오'], recommendation: '예', reason: '이유', status: 'open',
    at: new Date().toISOString()}));
  assert.equal(storageMode(home), 'sqlite');
  assert.deepEqual(store.list().map(d => d.id), [saved.id]);
});

test("빈 홈: 카드·업무·결정 읽기와 card list·work list·tree는 종료 0이고 파일을 만들지 않는다", () => {
  const home = root();
  assert.deepEqual(new CardStore(home).listSummaries(), []);
  assert.deepEqual(new CardStore(home).listWatch(), []);
  assert.deepEqual(new WorkStore(home).list(), []);
  assert.deepEqual(new DecisionStore(home).list(), []);
  for (const args of [['card', 'list'], ['work', 'list'], ['tree'], ['status']]) {
    const r = cli(args, home);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.deepEqual(fs.readdirSync(home), [], args.join(' '));
  }
});
