import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWallServer} from '../src/wall.mjs';
import {startSecretaryDefault} from '../src/center-wall.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';

test('요약의 비서 상태: 살아 있으면 true, 없으면 false, 세션 상태를 모르면 null', () => {
  const f = dashboardFixture({count:2}), snapshot = f.snapshot(), url = new URL('http://local/api/dashboard/summary');
  const withRoles = (runtimeKnown, roles) => ({...snapshot, center:{...snapshot.center, runtimeKnown, roles}});
  const alive = role => ({role, life:{state:'alive', pidState:'match'}});
  assert.equal(dashboardData(withRoles(true, [alive('비서'), alive('감독')]), url).secretary, true);
  assert.equal(dashboardData(withRoles(true, [alive('감독'), {role:'비서', life:{state:'dead'}}]), url).secretary, false);
  assert.equal(dashboardData(withRoles(false, []), url).secretary, null, '모르는 것을 꺼짐으로 꾸미지 않는다');
});

test('비서 켜기: 화면 표·같은 사이트일 때만, 정해진 한 명령만 부른다', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-secretary-start-'));
  let calls = 0;
  const server = createWallServer(() => ({center:null, entries:[], tree:[], ledgerLines:0, collectedAt:new Date()}),
    {home, cacheSec:0, startSecretary:() => { calls++; return {output:'비서 시작'}; }});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = (fields, origin = base) => fetch(base + '/secretary/start', {method:'POST', redirect:'manual',
      headers:{'content-type':'application/x-www-form-urlencoded', accept:'application/json', origin}, body:new URLSearchParams(fields)});
    assert.equal((await post({token:''})).status, 403);
    assert.equal((await post({token}, 'http://evil.example')).status, 403);
    assert.equal(calls, 0, '거부된 요청은 아무것도 실행하지 않는다');
    const ok = await post({token, cmd:'echo hacked'});
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {location:'/#status', result:{output:'비서 시작'}});
    assert.equal(calls, 1, '요청의 다른 값은 쓰지 않고 정해진 함수만 부른다');
  } finally { server.close(); }
});

test('기본 켜기는 kadan up --hidden을 사람 명의(KADAN_ROLE 비움)로 실행하고 실패를 숨기지 않는다', () => {
  const seen = [];
  const spawn = (cmd, args, opts) => { seen.push({cmd, args, role:opts.env.KADAN_ROLE}); return {status:0, stdout:'비서 이미 살아 있음\n대시보드 이미 살아 있음'}; };
  assert.equal(startSecretaryDefault({cli:'/repo/src/cli.mjs', env:{KADAN_ROLE:'대시보드', KADAN_WINDOW:'none'}, spawn}).output, '비서 이미 살아 있음\n대시보드 이미 살아 있음');
  assert.deepEqual(seen, [{cmd:process.execPath, args:['/repo/src/cli.mjs', 'up', '--hidden'], role:''}]);
  assert.throws(() => startSecretaryDefault({cli:'/x', env:{}, spawn:() => ({status:1, stderr:'tmux 없음'})}), /비서를 켜지 못했다: tmux 없음/);
});
