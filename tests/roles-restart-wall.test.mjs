import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWallServer} from '../src/wall.mjs';
import {restartRoleDefault} from '../src/center-wall.mjs';
import {appendLedger} from '../src/ledger.mjs';

// 대시보드 '다시 띄우기'(POST /roles/restart)의 서버 경계 시험(2026-10-15 [kyle]).
// 실행 자체는 CLI 자식 프로세스가 맡고, 실제 왕복은 격리 소켓 시험(restart-tmux.test.mjs)과 화면 확인이 맡는다.
function serve(restart) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-roles-restart-'));
  // 핸들러는 최근 start가 기록한 정확한 역할 이름과 대조한다(2라운드) — 시험 역할 w의 시작 기록을 둔다.
  appendLedger({kind: 'start', floor: 'tmux', role: 'w', session: 'kadan-w', panePid: '100', cwd: home, cmd: 'codex --model m', by: 'test'}, home);
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
    seen.push({cmd, args, role: opts.env.KADAN_ROLE, window: opts.env.KADAN_WINDOW, timeout: opts.timeout,
      reason: opts.env.KADAN_RESTART_REASON, pid: opts.env.KADAN_RESTART_EXPECT_PID});
    return {stdout: '다시 띄움: kadan-w (claude test-model, 대화 abc-123, pane PID 200, 창: none)'};
  };
  const result = await restartRoleDefault({role: 'w', reason: '느려짐', expectPid: '100', cli: '/repo/src/cli.mjs',
    env: {KADAN_ROLE: '대시보드', KADAN_WINDOW: 'rottie'}, run});
  assert.equal(result.output, '다시 띄움: kadan-w (claude test-model, 대화 abc-123, pane PID 200, 창: none)');
  assert.deepEqual(seen, [{cmd: process.execPath, args: ['/repo/src/cli.mjs', 'restart', 'w'],
    role: '', window: 'rottie', timeout: 120_000, reason: '느려짐', pid: '100'}],
    '화면이 창 선택을 바꾸지 않고 --force를 보내지 않는다. 값은 환경변수로만 전달한다');

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
    /최종 상한 120초/);

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

// 2라운드(2026-10-15, 검수 중요 1): 화면에서 온 값이 CLI 옵션으로 재해석되면 안 된다.
// 이유가 '--force'·'--'·'--help'·'-x'·'--expect-pid=1'·줄바꿈이 든 글이어도 인자로 싣지 않고 환경변수로만 전달한다.
// 2라운드(검수 중요 2): 앞뒤 하이픈 별칭은 같은 세션을 가리켜도 거절한다 — 최근 start의 정확한 이름만 받는다.
test('별칭 역할(앞뒤 하이픈)·시작 기록 없는 역할은 실행하지 않고 거절한다', async () => {
  let calls = 0;
  const server = serve(() => { calls++; return Promise.resolve({output: 'x'}); });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = await tokenOf(base);
    for (const alias of ['-w', 'w-', '--w']) {
      const rejected = await post(base, {token, role: alias, reason: 'r', expectPid: '100'});
      assert.equal(rejected.status, 409, alias);
      assert.match(await rejected.text(), /최근 시작 기록/, alias);
    }
    const unknown = await post(base, {token, role: 'ghost', reason: 'r', expectPid: '100'});
    assert.equal(unknown.status, 409, '시작 기록이 없는 역할');
    assert.match(await unknown.text(), /최근 시작 기록/);
    assert.equal(calls, 0, '별칭·무기록은 아무것도 실행하지 않는다');
  } finally { server.close(); }
});

test('화면 값(이유·세대 표시)은 CLI 인자가 아니라 환경변수로만 전달된다', async () => {
  const seen = [];
  const run = async (cmd, args, opts) => {
    seen.push({args: [...args], reason: opts.env.KADAN_RESTART_REASON, pid: opts.env.KADAN_RESTART_EXPECT_PID, timeout: opts.timeout});
    return {stdout: 'ok'};
  };
  const cases = ['--force', '--', '--help', '-x', '--expect-pid=1', '줄바꿈\n포함'];
  for (const reason of cases)
    await restartRoleDefault({role: 'w', reason, expectPid: '100', cli: '/c.mjs', env: {}, run});
  assert.equal(seen.length, cases.length);
  for (const [i, call] of seen.entries()) {
    assert.deepEqual(call.args, ['/c.mjs', 'restart', 'w'], '값을 인자로 싣지 않는다: ' + cases[i]);
    assert.equal(call.reason, cases[i], '이유 원문 그대로: ' + cases[i]);
    assert.equal(call.pid, '100');
  }
  assert.equal(seen[0].timeout, 120_000, '자식 최종 상한은 120초(화면 응답 상한과 분리)');
});

// 2라운드(검수 실측): 28초에 자식을 끊으면 stop만 남는 반쯤 끝난 상태가 생긴다.
// 화면은 28초에 '진행 중'으로 답하고, 자식은 끊지 않고 끝까지(최종 상한 120초) 돌게 한다.
test('화면 응답 상한을 넘기면 진행 중 안내로 답하고 자식은 끊지 않는다', async () => {
  let finish, fail;
  const child = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const result = await restartRoleDefault({role: 'w', reason: 'r', expectPid: '1', cli: '/c.mjs', env: {},
    run: () => child, responseTimeout: 30});
  assert.equal(result.pending, true);
  assert.match(result.output, /아직.*진행|확인/, '28초 안에 끝나지 않으면 확인 안내로 답한다');
  finish({stdout: '늦게 완료'});
  await child;
  // 응답 뒤에 자식이 실패해도 서버가 죽지 않는다(거절은 삼킨다 — 상태는 원장·역할로 확인하게 했다).
  const late = restartRoleDefault({role: 'w', reason: 'r', expectPid: '1', cli: '/c.mjs', env: {},
    run: () => new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error('늦은 실패'), {stderr: '늦은 실패 사유'})), 20);
    }),
    responseTimeout: 10});
  assert.equal((await late).pending, true);
  await new Promise(resolve => setTimeout(resolve, 60));
});

test('최종 상한(120초)으로 끊긴 경우의 사유를 보인다', async () => {
  await assert.rejects(
    restartRoleDefault({role: 'w', reason: 'r', expectPid: '1', cli: '/c.mjs', env: {}, responseTimeout: 60_000,
      run: async () => { throw Object.assign(new Error('timed out'), {killed: true}); }}),
    /120초.*최종 상한|최종 상한/, '최종 상한에서 끊겼다는 사유');
});
