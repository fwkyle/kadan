import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createWallServer} from '../src/wall.mjs';
import {loadRemoteConfig, REMOTE_ACCESS_FILE} from '../src/remote-access.mjs';
import {TEAM, AUD, EMAIL, HOST, makeKey, sign} from './helpers/access-jwt-fixture.mjs';

// 대시보드 원격 읽기 전용 종단 시험(2026-10-18): 가짜 열쇠 서버(로컬 http) + 임시 키로 판정·405·토큰 비움·캐시 분리를 확인한다.
const config = {host: HOST, team: TEAM, aud: AUD, email: EMAIL};
const key = makeKey();

function certsServer() {
  const state = {hits: 0};
  const server = http.createServer((request, response) => {
    state.hits++;
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({keys: [key.jwk]}));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({state, server, url: `http://127.0.0.1:${server.address().port}/cdn-cgi/access/certs`})));
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const loader = () => ({center: null, entries: [], tree: [], ledgerLines: 0, collectedAt: new Date()});

async function start({remote, certs, cacheSec = 0} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-remote-'));
  const server = createWallServer(loader, {home, cacheSec, remote, remoteOptions: certs ? {certsUrl: certs.url} : undefined});
  await listen(server);
  const port = server.address().port;
  // fetch는 Host를 못 바꾸므로 http.request로 직접 보낸다.
  const call = (method, url, {host = `127.0.0.1:${port}`, headers = {}, body} = {}) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path: url, headers: {host, ...(body ? {'content-length': Buffer.byteLength(body)} : {}), ...headers}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end(body);
  });
  const remoteCall = (method, url, {jwt = sign(key), ...rest} = {}) =>
    call(method, url, {host: HOST, ...rest, headers: {...(jwt ? {'cf-access-jwt-assertion': jwt} : {}), ...rest.headers}});
  return {home, server, call, remoteCall, close: () => server.close()};
}
const tokenIn = html => html.match(/name="token" value="([a-f0-9]*)"/)?.[1];

test('원격 설정이 꺼져 있으면 열쇠 조회가 0번이고 외부 Host는 예전처럼 403이다', async () => {
  const certs = await certsServer();
  const app = await start({remote: null, certs});
  try {
    const denied = await app.call('GET', '/api/dashboard/session', {host: HOST});
    assert.equal(denied.status, 403);
    assert.equal(denied.text, 'local host required');
    const withJwt = await app.remoteCall('GET', '/api/dashboard/session');
    assert.equal(withJwt.status, 403, '토큰이 있어도 설정이 꺼져 있으면 거부');
    assert.equal(withJwt.text, 'local host required');
    const local = await app.call('GET', '/api/dashboard/session');
    assert.equal(local.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(local.text)), ['token'], '로컬 session 응답은 예전과 같다');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(certs.state.hits, 0, '네트워크 호출 0번');
  } finally { app.close(); certs.server.close(); }
});

test('설정 파일이 없는 홈(기본값)도 꺼짐이라 열쇠 조회가 없다', async () => {
  const certs = await certsServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-remote-'));
  assert.equal(loadRemoteConfig(home), null);
  const server = createWallServer(loader, {home, cacheSec: 0, remoteOptions: {certsUrl: certs.url}});
  await listen(server);
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard/session`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(certs.state.hits, 0);
  } finally { server.close(); certs.server.close(); }
});

test('설정 파일은 네 항목이 모두 올바를 때만 켜지고, 빠지거나 손상되면 꺼진다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-remote-'));
  const write = text => fs.writeFileSync(path.join(home, REMOTE_ACCESS_FILE), text);
  write(JSON.stringify({host: 'Kadan.Example.com', team: 'Team-Name', aud: ' tag ', email: EMAIL}));
  assert.deepEqual(loadRemoteConfig(home), {host: 'kadan.example.com', team: 'team-name', aud: 'tag', email: EMAIL});
  for (const missing of ['host', 'team', 'aud', 'email']) {
    write(JSON.stringify({...config, [missing]: undefined}));
    assert.equal(loadRemoteConfig(home), null, `${missing} 빠짐`);
  }
  write(JSON.stringify({...config, host: 'localhost'}));
  assert.equal(loadRemoteConfig(home), null, '점 없는 호스트');
  write('{broken');
  assert.equal(loadRemoteConfig(home), null, '손상');
  write('[]');
  assert.equal(loadRemoteConfig(home), null, '객체가 아님');
});

test('원격: 토큰 없음·틀림·다른 호스트는 403, 올바른 토큰의 GET은 200', async () => {
  const certs = await certsServer();
  const app = await start({remote: config, certs});
  try {
    assert.equal((await app.remoteCall('GET', '/api/dashboard/session', {jwt: null})).status, 403, '토큰 없음');
    const none = await app.remoteCall('GET', '/api/dashboard/session', {jwt: null});
    assert.equal(none.text, '원격 인증 확인 실패');
    const other = makeKey('other');
    assert.equal((await app.remoteCall('GET', '/api/dashboard/session', {jwt: sign({...other, kid: key.kid})})).status, 403, '서명 틀림');
    assert.equal((await app.remoteCall('GET', '/api/dashboard/session', {jwt: sign(key, {claims: {aud: ['x']}})})).status, 403, 'aud 틀림');
    const wrongHost = await app.call('GET', '/api/dashboard/session', {host: 'other.example.com', headers: {'cf-access-jwt-assertion': sign(key)}});
    assert.equal(wrongHost.status, 403, '허용 목록에 없는 호스트');
    assert.equal(wrongHost.text, 'local host required');
    assert.equal((await app.remoteCall('GET', '/api/dashboard/session')).status, 200);
    assert.equal(certs.state.hits, 1, '시작할 때 한 번만 받는다');
  } finally { app.close(); certs.server.close(); }
});

test('원격 session은 token이 비고 readOnly:true, 로컬은 token을 그대로 준다', async () => {
  const certs = await certsServer();
  const app = await start({remote: config, certs});
  try {
    const remote = JSON.parse((await app.remoteCall('GET', '/api/dashboard/session')).text);
    assert.deepEqual(remote, {token: '', readOnly: true});
    const local = JSON.parse((await app.call('GET', '/api/dashboard/session')).text);
    assert.match(local.token, /^[a-f0-9]{48}$/);
    assert.equal(local.readOnly, undefined);
  } finally { app.close(); certs.server.close(); }
});

test('원격 화면(서버가 그리는 중앙 화면)은 token을 비우고, 로컬 캐시가 원격으로 새지 않는다', async () => {
  const certs = await certsServer();
  const app = await start({remote: config, certs, cacheSec: 30});
  try {
    const local = await app.call('GET', '/');
    const token = tokenIn(local.text);
    assert.match(token, /^[a-f0-9]{48}$/, '로컬 화면에는 토큰이 있다');
    const remote = await app.remoteCall('GET', '/');
    assert.equal(remote.status, 200);
    assert.equal(tokenIn(remote.text), '', '원격 화면 토큰은 빈 값');
    assert.ok(!remote.text.includes(token), '로컬 토큰이 원격 응답에 없다');
    const again = await app.call('GET', '/');
    assert.equal(tokenIn(again.text), token, '원격 응답이 로컬 캐시를 오염시키지 않는다');
    const remoteAgain = await app.remoteCall('GET', '/?fresh=1');
    assert.ok(!remoteAgain.text.includes(token));
  } finally { app.close(); certs.server.close(); }
});

// 설계 2-1 쓰기 경로 전수 목록(center-wall.mjs의 POST 허용 목록과 같다).
const WRITE_PATHS = ['/ask', '/secretary/start', '/roles/restart', '/cards/update', '/cards/create', '/decisions/answer',
  '/runners/set', '/runners/preset-save', '/runners/preset', '/runners/fallback', '/runners/favorite',
  '/runners/runner', '/runners/model-add',
  '/runners/model-remove', '/runners/models-list',
  ...['create', 'update', 'link', 'unlink', 'execute', 'mail', 'complete', 'cancel', 'reopen'].map(x => '/works/' + x)];

test('쓰기 경로 목록이 서버의 POST 허용 목록과 같다', () => {
  const source = fs.readFileSync(new URL('../src/center-wall.mjs', import.meta.url), 'utf8');
  const listed = source.match(/\[\s*'\/ask'[^\]]*\]/)[0];
  for (const p of WRITE_PATHS.filter(p => !p.startsWith('/works/'))) assert.ok(listed.includes(`'${p}'`), p);
  assert.match(listed, /\['create','update','link','unlink','execute','mail','complete','cancel','reopen'\]/);
  assert.equal(WRITE_PATHS.length, 24);
});

test('원격은 쓰기 경로 23개 모두 405이고(POST /decisions/answer 하나만 예외) 어느 것도 처리기까지 가지 않는다', async () => {
  const certs = await certsServer();
  const app = await start({remote: config, certs});
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const p of WRITE_PATHS) {
        // POST /decisions/answer는 2단계에서 열린 유일한 길이다(결정 token 없이는 403). 종단 시험은 tests/decision-remote-answer.test.mjs.
        if (method === 'POST' && p === '/decisions/answer') {
          const open = await app.remoteCall(method, p, {headers: {'content-type': 'application/x-www-form-urlencoded', origin: `https://${HOST}`}, body: 'token=x'});
          assert.equal(open.status, 403, 'token 없이는 거부');
          continue;
        }
        const res = await app.remoteCall(method, p, {headers: {'content-type': 'application/x-www-form-urlencoded', origin: `https://${HOST}`}, body: 'token=x'});
        assert.equal(res.status, 405, `${method} ${p}`);
        assert.equal(res.text, '원격은 조회만 지원합니다');
      }
    }
    // 로컬은 같은 경로가 예전처럼 처리기까지 간다(토큰이 틀려 403).
    const local = await app.call('POST', '/ask', {headers: {'content-type': 'application/x-www-form-urlencoded'}, body: 'token=x'});
    assert.equal(local.status, 403);
    assert.match(local.text, /화면을 새로 읽은 뒤/);
  } finally { app.close(); certs.server.close(); }
});

test('원격 GET은 https 출처를 같은 출처로 보고, 다른 출처·cross-site는 거부한다 (H2·H4)', async () => {
  const certs = await certsServer();
  const app = await start({remote: config, certs});
  try {
    for (const url of ['/api/dashboard/session', '/api/operations-flow']) {
      const ok = await app.remoteCall('GET', url, {headers: {origin: `https://${HOST}`}});
      assert.equal(ok.status, 200, url);
      assert.equal((await app.remoteCall('GET', url, {headers: {origin: 'https://evil.example'}})).status, 403, url + ' 다른 출처');
      assert.equal((await app.remoteCall('GET', url, {headers: {'sec-fetch-site': 'cross-site'}})).status, 403, url + ' cross-site');
    }
    // 로컬 요청에서는 https 출처를 받아 주지 않는다(예전 동작 유지).
    const local = await app.call('GET', '/api/dashboard/session', {headers: {origin: `https://127.0.0.1`}});
    assert.equal(local.status, 403);
  } finally { app.close(); certs.server.close(); }
});

test('F1: 캐시 구분은 URL로 조작할 수 없다 — 로컬→원격, 원격→로컬 양방향 (gui:true, cacheSec>0)', async () => {
  const certs = await certsServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-remote-'));
  const server = createWallServer(loader, {home, cacheSec: 30, gui: true, warmAfterMs: 3_600_000, remote: config, remoteOptions: {certsUrl: certs.url}});
  await listen(server);
  const port = server.address().port;
  const call = (url, {host = `127.0.0.1:${port}`, jwt} = {}) => new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: url, headers: {host, ...(jwt ? {'cf-access-jwt-assertion': jwt} : {})}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
  const remote = url => call(url, {host: HOST, jwt: sign(key)});
  try {
    const secret = JSON.parse(await call('/api/dashboard/session')).token;
    // 로컬 → 원격: 로컬이 `__remote=1`을 붙여 token 든 화면을 캐시에 넣어도 원격 같은 주소는 그걸 받지 않는다.
    assert.ok((await call('/center?view=a&__remote=1')).includes(secret), '로컬 화면에는 토큰이 있다');
    assert.ok(!(await remote('/center?view=a')).includes(secret), '로컬→원격 누출 없음');
    assert.ok(!(await remote('/center?view=a&__remote=1')).includes(secret), '원격이 같은 표시를 붙여도 누출 없음');
    // 원격 → 로컬: 원격이 먼저 읽은 token 없는 화면을 로컬이 받지 않는다.
    await remote('/center?view=b');
    await remote('/center?view=b&__remote=1');
    assert.ok((await call('/center?view=b&__remote=1')).includes(secret), '원격→로컬 오염 없음');
    assert.ok((await call('/center?view=b')).includes(secret), '원격→로컬 오염 없음(표시 없음)');
  } finally { server.close(); certs.server.close(); }
});

test('F2: 원격이 켜지면 Cloudflare 표시 헤더가 있는 로컬 Host는 거부하고 Host가 둘이어도 거부한다', async () => {
  const certs = await certsServer();
  const app = await start({remote: config, certs});
  try {
    for (const headers of [{'cf-ray': 'x'}, {'cf-connecting-ip': '203.0.113.1'}, {'cf-access-jwt-assertion': 'fake'}, {'cdn-loop': 'cloudflare'}]) {
      const res = await app.call('GET', '/api/dashboard/session', {headers});
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.ok(!res.text.includes('token'));
    }
    assert.equal((await app.call('GET', '/api/dashboard/session')).status, 200, '표시 없는 로컬은 그대로');
    // Host가 둘: 어느 순서든 거부.
    for (const hosts of [['127.0.0.1', HOST], [HOST, '127.0.0.1']]) {
      const raw = await new Promise((resolve, reject) => {
        const socket = net.connect(app.server.address().port, '127.0.0.1');
        let text = '';
        socket.on('connect', () => socket.end('GET /api/dashboard/session HTTP/1.1\r\n' + hosts.map(h => `Host: ${h}\r\n`).join('')
          + `cf-access-jwt-assertion: ${sign(key)}\r\nConnection: close\r\n\r\n`));
        socket.on('data', b => { text += b; });
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
      });
      assert.doesNotMatch(raw, /"token":"[a-f0-9]{48}"/, hosts.join(','));
      assert.doesNotMatch(raw.split('\r\n')[0], / 200 /, hosts.join(','));
    }
  } finally { app.close(); certs.server.close(); }
});

test('F2: 원격이 꺼져 있으면 Cloudflare 표시 헤더가 있어도 지금 동작 그대로(로컬 Host는 로컬)', async () => {
  const app = await start({remote: null});
  try {
    const res = await app.call('GET', '/api/dashboard/session', {headers: {'cf-ray': 'x', 'cf-connecting-ip': '203.0.113.1'}});
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.text).token, /^[a-f0-9]{48}$/);
  } finally { app.close(); }
});
