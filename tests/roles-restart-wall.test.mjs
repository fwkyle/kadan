import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWallServer} from '../src/wall.mjs';
import {restartRoleDefault} from '../src/center-wall.mjs';

// 대시보드 '다시 띄우기'(POST /roles/restart)의 서버 경계 시험(2026-10-15 [kyle]).
// 실행 자체는 CLI 자식 프로세스가 맡고, 실제 왕복은 격리 소켓 시험(restart-tmux.test.mjs)과 화면 확인이 맡는다.
function serve(restart) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-roles-restart-'));
  return createWallServer(() => ({center: null, entries: [], tree: [], ledgerLines: 0, collectedAt: new Date()}),
    {home, cacheSec: 0, restart});
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const tokenOf = async base => (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
const post = (base, fields, headers = {}) => fetch(base + '/roles/restart', {method: 'POST', redirect: 'manual',
  headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base, ...headers},
  body: new URLSearchParams(fields)});

test('토큰 없음·다른 출처·GET·폼 아닌 요청은 restart를 0회 실행한다', async () => {
  let calls = 0;
  const server = serve(() => { calls++; return Promise.resolve({output: 'x'}); });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = await tokenOf(base);
    assert.equal((await post(base, {reason: 'r', expectPid: '1'})).status, 403, '토큰 없음');
    assert.equal((await post(base, {token, reason: 'r', expectPid: '1'}, {origin: 'http://evil.example'})).status, 403, '다른 출처');
    assert.equal((await fetch(base + '/roles/restart', {method: 'POST', headers: {origin: base, 'content-type': 'application/json'}, body: '{}'})).status, 415, '폼 아님');
    await fetch(base + '/roles/restart', {headers: {origin: base}}); // GET은 저장 경로가 아니라 렌더로 흘러간다
    assert.equal(calls, 0, '거부된 요청은 아무것도 실행하지 않는다');
  } finally { server.close(); }
});

test('이유·세대 표시·역할 이름이 비거나 잘못되면 실행하지 않고 거절한다', async () => {
  let calls = 0;
  const server = serve(() => { calls++; return Promise.resolve({output: 'x'}); });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = await tokenOf(base);
    const noReason = await post(base, {token, role: 'w', expectPid: '100'});
    assert.equal(noReason.status, 409); assert.match(await noReason.text(), /이유/);
    assert.equal((await post(base, {token, role: 'w', reason: '   ', expectPid: '100'})).status, 409, '공백뿐인 이유');
    const noGeneration = await post(base, {token, role: 'w', reason: 'r'});
    assert.equal(noGeneration.status, 409); assert.match(await noGeneration.text(), /세대/);
    assert.equal((await post(base, {token, role: 'a;rm -rf', reason: 'r', expectPid: '1'})).status, 409, '역할 이름');
    assert.equal(calls, 0);
  } finally { server.close(); }
});

test('정상 요청은 정해진 CLI 한 개를 사람 명의·--force 없이 부르고 출력을 돌려준다', async () => {
  const seen = [];
  const run = async (cmd, args, opts) => {
    seen.push({cmd, args, role: opts.env.KADAN_ROLE, window: opts.env.KADAN_WINDOW, timeout: opts.timeout});
    return {stdout: '다시 띄움: kadan-w (claude test-model, 대화 abc-123, pane PID 200, 창: none)'};
  };
  const result = await restartRoleDefault({role: 'w', reason: '느려짐', expectPid: '100', cli: '/repo/src/cli.mjs',
    env: {KADAN_ROLE: '대시보드', KADAN_WINDOW: 'rottie'}, run});
  assert.equal(result.output, '다시 띄움: kadan-w (claude test-model, 대화 abc-123, pane PID 200, 창: none)');
  assert.deepEqual(seen, [{cmd: process.execPath, args: ['/repo/src/cli.mjs', 'restart', 'w', '--reason', '느려짐', '--expect-pid', '100'],
    role: '', window: 'rottie', timeout: 28_000}], '화면이 창 선택을 바꾸지 않고 --force를 보내지 않는다');

  const fields = [];
  const server = serve(args => { fields.push(args); return Promise.resolve({output: '다시 띄움: kadan-w (…)'}); });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = await tokenOf(base);
    const ok = await post(base, {token, role: 'w', reason: '느려짐', expectPid: '100'});
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {location: '/#runner-settings', result: {output: '다시 띄움: kadan-w (…)'}});
    assert.deepEqual(fields, [{role: 'w', reason: '느려짐', expectPid: '100'}]);
  } finally { server.close(); }
});

test('CLI 거절 메시지는 그대로 화면에 나오고, 상한 초과는 중단 사유를 보인다', async () => {
  const cliRefusal = 'w에 끝나지 않은 카드 2건이 있다: a, b — 사람이 확인했으면 --force로 다시 실행한다';
  await assert.rejects(
    restartRoleDefault({role: 'w', reason: 'r', expectPid: '1', run: async () => { throw Object.assign(new Error('exit 1'), {stderr: cliRefusal + '\n'}); }}),
    error => error.message === cliRefusal, 'stderr의 CLI 메시지를 그대로 보인다');
  await assert.rejects(
    restartRoleDefault({role: 'w', reason: 'r', expectPid: '1', run: async () => { throw Object.assign(new Error('timed out'), {killed: true}); }}),
    /28초 안에 끝나지 않아 중단/);

  const server = serve(() => Promise.reject(new Error(cliRefusal)));
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = await tokenOf(base);
    const rejected = await post(base, {token, role: 'w', reason: 'r', expectPid: '100'});
    assert.equal(rejected.status, 409);
    assert.equal(await rejected.text(), cliRefusal, '서버 응답도 CLI 메시지 그대로다');
  } finally { server.close(); }
});

test('자식 프로세스를 기다리는 동안 대시보드의 다른 요청은 응답한다', async () => {
  let release;
  const server = serve(() => new Promise(resolve => { release = () => resolve({output: '늦게 끝남'}); }));
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = await tokenOf(base);
    const pending = post(base, {token, role: 'w', reason: 'r', expectPid: '1'});
    // 서버가 restart(자식 프로세스 호출)에 들어갈 때까지 짧게 기다린 뒤, 그 사이 다른 요청이 응답하는지 본다.
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(release, 'restart가 불렸다');
    const other = await fetch(base + '/api/dashboard/session');
    assert.equal(other.status, 200, 'restart를 기다리는 동안 세션 조회가 응답한다');
    assert.ok((await other.json()).token);
    release();
    assert.equal((await pending).status, 200);
  } finally { server.closeAllConnections?.(); server.close(); }
});
