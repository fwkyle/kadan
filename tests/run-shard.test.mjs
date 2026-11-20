import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseShard, selectShard} from './helpers/shard.mjs';

// CI 우분투 시험을 조각으로 나누는 계산(tests/helpers/shard.mjs)과, 실행기(tests/run.mjs)가 그 조각만 도는지 본다.
const here = new URL('./', import.meta.url).pathname;
const runner = path.join(here, 'run.mjs');
const listAll = () => fs.readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort().map(f => `tests/${f}`);

test('두 조각의 합집합은 전체이고 겹치지 않는다(실제 시험 파일 목록)', () => {
  const all = listAll();
  const one = selectShard(all, {index: 1, total: 2});
  const two = selectShard(all, {index: 2, total: 2});
  assert.equal(one.length + two.length, all.length);
  assert.equal(new Set([...one, ...two]).size, all.length);
  assert.deepEqual([...one, ...two].sort(), all);
  assert.ok(one.length > 0 && two.length > 0);
});

test('같은 입력이면 같은 결과이고 전체 개수 1이면 전부다', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(selectShard(all, {index: 1, total: 2}), selectShard(all, {index: 1, total: 2}));
  assert.deepEqual(selectShard(all, {index: 1, total: 1}), all);
  assert.deepEqual(selectShard(all, {index: 1, total: 2}), ['a', 'c', 'e']);
  assert.deepEqual(selectShard(all, {index: 2, total: 2}), ['b', 'd']);
});

test('새 파일을 하나 더해도 어느 한 조각에 정확히 한 번 들어간다', () => {
  const all = listAll();
  for (const extra of ['tests/aaa-new.test.mjs', 'tests/mmm-new.test.mjs', 'tests/zzz-new.test.mjs']) {
    const grown = [...all, extra].sort();
    const hits = [1, 2].filter(index => selectShard(grown, {index, total: 2}).includes(extra));
    assert.equal(hits.length, 1, extra);
    const union = [1, 2].flatMap(index => selectShard(grown, {index, total: 2}));
    assert.equal(union.length, grown.length);
  }
});

test('조각 인자: 1/2·2/2는 받고 0/2·3/2·형식 오류는 이유를 적어 거절한다', () => {
  assert.deepEqual(parseShard('1/2'), {index: 1, total: 2});
  assert.deepEqual(parseShard('2/2'), {index: 2, total: 2});
  assert.throws(() => parseShard('0/2'), /1부터 전체 개수\(2\) 사이/);
  assert.throws(() => parseShard('3/2'), /1부터 전체 개수\(2\) 사이/);
  assert.throws(() => parseShard('1/0'), /전체 개수는 1 이상/);
  for (const bad of ['', '1', '1/', '/2', 'a/b', '1/2/3', '-1/2', '1.5/2', '1 /2']) {
    assert.throws(() => parseShard(bad), /번호\/전체/, JSON.stringify(bad));
  }
});

// 가짜 시험 파일 3개를 실행기에 직접 넘겨, 조각마다 돈 파일이 다르고 합치면 전체인지 본다.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-shard-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const log = path.join(dir, 'ran.log');
  const names = ['a', 'b', 'c'].map(n => path.join(dir, `${n}.test.mjs`));
  for (const file of names) {
    fs.writeFileSync(file, `import test from 'node:test';import fs from 'node:fs';
test('fake', () => fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(path.basename(file))} + '\\n'));`);
  }
  return {names, log};
}
const ran = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).sort() : []);
const runShard = (shard, names) => spawnSync(process.execPath, [runner, ...shard, ...names], {encoding: 'utf8', env: process.env});

test('실행기: --shard=1/2와 2/2가 서로 다른 파일을 돌고 합치면 전부이며 완료 줄이 조각 크기를 적는다', t => {
  const {names, log} = fixture(t);
  const first = runShard(['--shard=1/2'], names);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(ran(log), ['a.test.mjs', 'c.test.mjs']);
  assert.match(first.stderr, /시험 조각 1\/2: 전체 3개 중 2개/);
  assert.match(first.stderr, /시험 파일: 완료 2\/2, 실패 0/);
  const second = runShard(['--shard', '2/2'], names);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(ran(log), ['a.test.mjs', 'b.test.mjs', 'c.test.mjs']);
  assert.match(second.stderr, /시험 조각 2\/2: 전체 3개 중 1개/);
  assert.match(second.stderr, /시험 파일: 완료 1\/1, 실패 0/);
});

test('실행기: 잘못된 조각 인자는 시험을 하나도 돌리지 않고 실패한다', t => {
  const {names, log} = fixture(t);
  for (const bad of [['--shard=0/2'], ['--shard=3/2'], ['--shard=x'], ['--shard']]) {
    const result = runShard(bad, names);
    assert.notEqual(result.status, 0, bad.join(' '));
    assert.match(result.stderr, /조각/, bad.join(' '));
  }
  assert.deepEqual(ran(log), []);
});
