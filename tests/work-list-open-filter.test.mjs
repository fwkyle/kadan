import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WorkStore} from '../src/work-store.mjs';
import {workCommand} from '../src/work-command.mjs';

const ctx = home => ({home, by: '감독'});
const make = (home, repo, id) => workCommand(['create', `${repo}/${id}`], {
  title: `업무 ${id}`, goal: '결과', scope: '범위', acceptance: '완료 조건', owner: '감독', 'repo-path': '/tmp',
}, ctx(home));
const list = (home, flags = {}) => workCommand(['list'], flags, ctx(home));
const keys = rows => rows.map(r => r.key).sort();

// open·hold·done·cancelled 업무가 하나씩 있는 격리 홈(repo-a), repo-b에 open 하나.
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-list-open-'));
  for (const id of ['open1', 'hold1', 'done1', 'cancel1']) make(home, 'repo-a', id);
  make(home, 'repo-b', 'open2');
  const store = new WorkStore(home), by = {by: '감독', note: '시험'};
  const rev = key => store.get(key).revision;
  store.change('repo-a/hold1', 'update', {status: 'hold'}, {revision: rev('repo-a/hold1'), ...by});
  store.change('repo-a/done1', 'complete', {result: '끝'}, {revision: rev('repo-a/done1'), ...by});
  store.change('repo-a/cancel1', 'cancel', {result: '취소'}, {revision: rev('repo-a/cancel1'), ...by});
  return home;
}

test('--open은 done·cancelled를 빼고 open·hold를 남긴다', () => {
  const home = fixture();
  assert.deepEqual(keys(list(home, {open: true})), ['repo-a/hold1', 'repo-a/open1', 'repo-b/open2']);
});

test('--status open은 그대로 open만 남기고 필터가 없으면 전부 나온다', () => {
  const home = fixture();
  assert.deepEqual(keys(list(home, {status: 'open'})), ['repo-a/open1', 'repo-b/open2']);
  assert.equal(list(home).length, 5);
});

test('--repo는 그대로 동작하고 --open과 함께 쓸 수 있다', () => {
  const home = fixture();
  assert.equal(list(home, {repo: 'repo-a'}).length, 4);
  assert.deepEqual(keys(list(home, {repo: 'repo-a', open: true})), ['repo-a/hold1', 'repo-a/open1']);
});

test('--open과 --status를 같이 주면 거절한다', () => {
  const home = fixture();
  assert.throws(() => list(home, {open: true, status: 'open'}), error => error.exitCode === 2 && /--open과 --status/u.test(error.message));
});

test('--open에 값이 붙으면 거절한다', () => {
  const home = fixture();
  assert.throws(() => list(home, {open: 'yes'}), /--open은 값 없이/u);
});

test('모르는 플래그는 이름을 적어 거절한다', () => {
  const home = fixture();
  assert.throws(() => list(home, {opne: true, json: true}), error => error.exitCode === 2 && /--opne, --json/u.test(error.message));
});

test('CLI: --open은 종료 0, 모르는 플래그는 종료 2와 이름, --open 뒤 --repo도 값이 밀리지 않는다', () => {
  const home = fixture();
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'work', 'list', ...args], {
    encoding: 'utf8', env: {...process.env, KADAN_HOME: home, KADAN_SOCKET: `t-${process.pid}`, KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off'},
  });
  const ok = cli('--open');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(keys(JSON.parse(ok.stdout)), ['repo-a/hold1', 'repo-a/open1', 'repo-b/open2']);
  const both = cli('--open', '--repo', 'repo-b');
  assert.equal(both.status, 0, both.stderr);
  assert.deepEqual(keys(JSON.parse(both.stdout)), ['repo-b/open2']);
  const bad = cli('--opne');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--opne/u);
});
