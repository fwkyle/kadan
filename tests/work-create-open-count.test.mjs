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

const make = (home, id, owner) => workCommand(['create', `repo/${id}`], {
  title: `업무 ${id}`, goal: '결과', scope: '범위', acceptance: '완료 조건', owner, 'repo-path': '/tmp',
}, {home, by: '감독'});

test('열린 업무 수: 첫 업무 1, 같은 감독 여럿이면 누적, 다른 감독·닫힌 업무는 세지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-open-count-'));
  const a1 = make(home, 'a1', 'repo-a-감독');
  assert.equal(a1.ownerOpenWorks, 1, '방금 만든 업무를 포함');
  assert.equal(a1.key, 'repo/a1', '기존 필드는 그대로');
  const other = make(home, 'b1', 'repo-b-감독');
  assert.equal(other.ownerOpenWorks, 1);
  assert.equal(make(home, 'a2', 'repo-a-감독').ownerOpenWorks, 2);
  assert.equal(make(home, 'a3', 'repo-a-감독').ownerOpenWorks, 3);
  const store = new WorkStore(home);
  store.change('repo/a1', 'cancel', {result: '취소'}, {revision: store.get('repo/a1').revision, by: 'repo-a-감독', note: '닫음'});
  assert.equal(make(home, 'a4', 'repo-a-감독').ownerOpenWorks, 3, '취소한 a1은 빠진다');
});

test('다른 명령(list)에는 필드가 붙지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-open-count-'));
  make(home, 'a1', 'repo-a-감독');
  const rows = workCommand(['list'], {}, {home, by: '감독'});
  assert.ok(rows.every(row => !('ownerOpenWorks' in row)));
});

test('CLI: stdout은 JSON 그대로, 사람용 한 줄은 stderr에만', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-open-count-cli-'));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'work', 'create', 'repo/c1', '--title', 't', '--goal', 'g',
    '--scope', 's', '--acceptance', 'a', '--owner', 'repo-c-감독', '--repo-path', '/tmp'],
  {encoding: 'utf8', env: {...process.env, KADAN_HOME: home, KADAN_SOCKET: `t-${process.pid}`, KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off'}});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ownerOpenWorks, 1);
  assert.match(run.stderr, /책임 감독 repo-c-감독의 열린 업무 1건 \(이 업무 포함\)/u);
});
