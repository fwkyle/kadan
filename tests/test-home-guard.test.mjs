import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertTestHome,underTest} from '../src/test-home-guard.mjs';

const src = new URL('../src/', import.meta.url).pathname;

test('시험 가드: 시험 중 원장 위치가 없거나 실사용 경로(링크 포함)면 실패하고 격리 경로는 통과', () => {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-guard-user-'));
  const live = path.join(user, '.kadan');
  fs.mkdirSync(live);
  const link = path.join(user, 'link');
  fs.symlinkSync(live, link);
  const inTest = {env:{NODE_TEST_CONTEXT:'child-v8'},execArgv:[],userHome:user};
  assert.equal(underTest(), true);
  assert.throws(() => assertTestHome(undefined, inTest), /원장 위치 없음/);
  assert.throws(() => assertTestHome(live, inTest), /실사용 원장 사용 금지/);
  assert.throws(() => assertTestHome(link, inTest), /실사용 원장 사용 금지/);
  assert.throws(() => assertTestHome(live, {env:{},execArgv:['--test'],userHome:user}), /실사용 원장 사용 금지/);
  assert.doesNotThrow(() => assertTestHome(path.join(user, 'isolated'), inTest));
  // 시험 밖(운영)에서는 실사용 경로도 그대로 쓴다.
  assert.doesNotThrow(() => assertTestHome(live, {env:{},execArgv:[],userHome:user}));
  assert.doesNotThrow(() => assertTestHome(undefined, {env:{},execArgv:[],userHome:user}));
});

test('시험 가드: KADAN_HOME 미지정이면 원장·우편 본문·카드 쓰기가 실패하고 아무것도 남지 않는다', () => {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-guard-e2e-'));
  const live = path.join(user, '.kadan');
  const repo = path.join(user, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'card.md'), '# 가드\n');
  const script = `
    import {ledgerHome,appendLedger,saveMailBody} from '${src}ledger.mjs';
    import {CardStore} from '${src}card-store.mjs';
    const home = process.argv[1], out = {};
    const tries = {
      ledgerHome: () => ledgerHome(),
      ledger: () => appendLedger({kind:'plan',board:'guard',taskId:'guard-1',by:'시험'}, home),
      body: () => saveMailBody('guarddigest', '본문', home),
      card: () => new CardStore(home).create({repo:'guard',id:'guard-1',repoPath:'${repo}',sourcePath:'${repo}/card.md',title:'가드',body:'본문'}),
    };
    for (const [name, fn] of Object.entries(tries)) { try { fn(); out[name] = 'ok'; } catch (e) { out[name] = e.message; } }
    console.log(JSON.stringify(out));`;
  const run = (env, home) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, home],
      {env:{PATH:process.env.PATH, HOME:user, ...env}, encoding:'utf8', timeout:15000});
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').at(-1));
  };
  const blocked = run({NODE_TEST_CONTEXT:'child-v8'}, live);
  for (const name of ['ledgerHome', 'ledger', 'body', 'card']) assert.match(blocked[name], /시험 중/, name);
  assert.equal(fs.existsSync(live), false);
  const isolated = path.join(user, 'iso');
  const ok = run({NODE_TEST_CONTEXT:'child-v8', KADAN_HOME:isolated}, isolated);
  assert.deepEqual(ok, {ledgerHome:'ok', ledger:'ok', body:'ok', card:'ok'});
  assert.equal(fs.existsSync(live), false);
});
