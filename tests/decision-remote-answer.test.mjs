import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createWallServer} from '../src/wall.mjs';
import {CardStore} from '../src/card-store.mjs';
import {DecisionStore, decisionLink} from '../src/decisions.mjs';
import {REMOTE_ACCESS_FILE} from '../src/remote-access.mjs';
import {TEAM, AUD, EMAIL, HOST, makeKey, sign} from './helpers/access-jwt-fixture.mjs';

// 폰에서 결정 답하기 종단 시험(2026-10-18): 가짜 열쇠 서버 + 임시 키. 주소·이메일은 모두 example 자리표시다.
const config = {host: HOST, team: TEAM, aud: AUD, email: EMAIL};
const key = makeKey();
const loader = () => ({center: null, entries: [], tree: [], ledgerLines: 0, collectedAt: new Date()});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

function certsServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({keys: [key.jwk]}));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({server, url: `http://127.0.0.1:${server.address().port}/cdn-cgi/access/certs`})));
}

async function start() {
  const certs = await certsServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-remote-answer-'));
  new CardStore(home).create({repo: 'repo', id: 'card-a', repoPath: home, body: '# 테스트'});
  const sent = [];
  const notify = (role, message) => { sent.push({role, message}); };
  const store = new DecisionStore(home, {notify});
  const decision = store.request('repo/card-a', {question: '분리할까요?', options: ['분리', '유지'], recommendation: '분리',
    reason: '이유\n- 결과 파일: /repo/card-a/result.md'}, '시험-슈퍼감독');
  const server = createWallServer(loader, {home, cacheSec: 0, notify, remote: config, remoteOptions: {certsUrl: certs.url}});
  await listen(server);
  const port = server.address().port;
  const call = (method, url, {host = `127.0.0.1:${port}`, headers = {}, body} = {}) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path: url, headers: {host, ...(body ? {'content-length': Buffer.byteLength(body)} : {}), ...headers}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, text: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end(body);
  });
  // iat는 초 단위라 시험 중 초가 넘어가면 token이 달라진다. 같은 신원의 JWT는 iat를 고정해 같은 token이 나오게 한다.
  const jwtFor = (claims = {}) => sign(key, {claims: {sub: 'sub-a', iat: 1_700_000_000, ...claims}});
  const remote = (method, url, {jwt = jwtFor(), origin = `https://${HOST}`, body, headers = {}} = {}) =>
    call(method, url, {host: HOST, body, headers: {'cf-access-jwt-assertion': jwt, ...(origin === null ? {} : {origin}), ...(body ? {'content-type': 'application/x-www-form-urlencoded'} : {}), ...headers}});
  const sessionOf = async jwt => JSON.parse((await remote('GET', '/api/dashboard/session', {jwt})).text);
  const answerBody = (token, extra = {}) => new URLSearchParams({token, id: decision.id, revision: '1', choice: '분리', text: '분리하세요', ...extra}).toString();
  const fresh = () => new DecisionStore(home, {notify}).get(decision.id);
  return {home, store, decision, sent, call, remote, sessionOf, answerBody, fresh, jwtFor,
    close: () => { server.close(); certs.server.close(); }};
}

test('원격: 유효 JWT + 맞는 Origin + 결정 token이면 답이 기록되고 감사 필드가 남는다', async () => {
  const app = await start();
  try {
    const session = await app.sessionOf(app.jwtFor({iat: 1_700_000_000}));
    assert.equal(session.token, '');
    assert.equal(session.readOnly, true);
    assert.match(session.decisionToken, /^[a-f0-9]{64}$/);
    const jwt = app.jwtFor({iat: 1_700_000_000});
    const response = await app.remote('POST', '/decisions/answer', {jwt, body: app.answerBody(session.decisionToken), headers: {accept: 'application/json', 'cf-connecting-ip': '203.0.113.7'}});
    assert.equal(response.status, 200, response.text);
    const saved = app.fresh();
    assert.equal(saved.status, 'answered');
    assert.equal(saved.answer.by, '사람');
    assert.equal(saved.answer.choice, '분리');
    assert.equal(saved.answer.source, undefined, 'source 값 목록은 넓히지 않는다');
    assert.deepEqual({email: saved.answer.remote.email, sub: saved.answer.remote.sub, iat: saved.answer.remote.iat, ip: saved.answer.remote.ip, ipTrusted: saved.answer.remote.ipTrusted},
      {email: EMAIL, sub: 'sub-a', iat: 1_700_000_000, ip: '203.0.113.7', ipTrusted: false});
    assert.ok(Number.isFinite(saved.answer.remote.exp));
    assert.ok(saved.answer.at, '시각');
    assert.ok(saved.revision > 1 && saved.id === app.decision.id);
    assert.equal(app.sent.length, 1, '요청자에게 한 번 알린다');
    const raw = fs.readFileSync(path.join(app.home, 'decisions/events.jsonl'), 'utf8');
    assert.ok(!raw.includes(jwt) && !raw.includes('eyJ'), 'JWT 원문은 기록에 없다');
  } finally { app.close(); }
});

test('원격: Origin이 없거나 null·http·다른 호스트면 403이고 답은 기록되지 않는다', async () => {
  const app = await start();
  try {
    const token = (await app.sessionOf(app.jwtFor())).decisionToken;
    for (const origin of [null, 'null', `http://${HOST}`, 'https://other.example.com', `https://${HOST}:8443`, `https://${HOST}/`]) {
      const response = await app.remote('POST', '/decisions/answer', {origin, body: app.answerBody(token)});
      assert.equal(response.status, 403, `origin=${origin}`);
    }
    assert.equal(app.fresh().status, 'open');
  } finally { app.close(); }
});

test('원격: 만료 JWT·신원 불일치·token 없음/틀림·로컬 token은 403, revision 틀림은 기존 오류 경로', async () => {
  const app = await start();
  try {
    const token = (await app.sessionOf(app.jwtFor())).decisionToken;
    const post = (body, jwt) => app.remote('POST', '/decisions/answer', {body, ...(jwt ? {jwt} : {})});
    const expired = sign(key, {claims: {sub: 'sub-a'}, now: Date.now() - 2 * 3600 * 1000});
    assert.equal((await post(app.answerBody(token), expired)).status, 403, '만료');
    assert.equal((await post(app.answerBody(token), app.jwtFor({sub: 'sub-b'}))).status, 403, '신원 A의 token + 신원 B의 JWT');
    assert.equal((await post(app.answerBody(token), app.jwtFor({iat: Math.floor(Date.now() / 1000) + 5}))).status, 403, '다른 iat');
    assert.equal((await post(app.answerBody(''))).status, 403, 'token 없음');
    assert.equal((await post(app.answerBody('0'.repeat(64)))).status, 403, 'token 틀림');
    const localToken = JSON.parse((await app.call('GET', '/api/dashboard/session')).text).token;
    assert.equal((await post(app.answerBody(localToken))).status, 403, '로컬 token을 원격에서 사용');
    assert.equal((await post(app.answerBody(token, {revision: '99'}))).status, 409, 'revision 틀림');
    assert.equal(app.fresh().status, 'open');
    const noSub = sign(key);
    assert.equal((await app.sessionOf(noSub)).decisionToken, undefined, 'sub가 없으면 결정 token도 없다');
    assert.equal((await post(app.answerBody(token), noSub)).status, 403);
  } finally { app.close(); }
});

test('로컬에서 낸 결정 token은 로컬 요청에서 거부되고 session에도 결정 token이 없다', async () => {
  const app = await start();
  try {
    const decisionToken = (await app.sessionOf(app.jwtFor())).decisionToken;
    const local = JSON.parse((await app.call('GET', '/api/dashboard/session')).text);
    assert.deepEqual(Object.keys(local), ['token']);
    const response = await app.call('POST', '/decisions/answer', {headers: {'content-type': 'application/x-www-form-urlencoded'}, body: app.answerBody(decisionToken)});
    assert.equal(response.status, 403);
    assert.equal(app.fresh().status, 'open');
  } finally { app.close(); }
});

test('결정 token을 붙여도 나머지 쓰기 22개는 모두 405다', async () => {
  const app = await start();
  try {
    const token = (await app.sessionOf(app.jwtFor())).decisionToken;
    const paths = ['/ask', '/secretary/start', '/roles/restart', '/cards/update', '/cards/create', '/runners/set', '/runners/preset', '/runners/fallback',
      '/runners/favorite', '/runners/runner', '/runners/model-add', '/runners/model-remove', '/runners/models-list',
      ...['create', 'update', 'link', 'unlink', 'execute', 'mail', 'complete', 'cancel', 'reopen'].map(x => '/works/' + x)];
    assert.equal(paths.length, 22);
    for (const url of paths) {
      const response = await app.remote('POST', url, {body: new URLSearchParams({token, id: app.decision.id}).toString()});
      assert.equal(response.status, 405, url);
    }
    for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await app.remote(method, '/decisions/answer')).status, 405, method);
    assert.equal(app.fresh().status, 'open');
  } finally { app.close(); }
});

test('옛 화면(?legacy=1)에는 token이 없어 답하지 못한다', async () => {
  const app = await start();
  try {
    const html = (await app.remote('GET', '/?legacy=1')).text;
    assert.ok(!/name="token" value="[a-f0-9]+"/.test(html));
    const response = await app.remote('POST', '/decisions/answer?legacy=1', {body: app.answerBody('')});
    assert.equal(response.status, 403);
  } finally { app.close(); }
});

test('원격 응답에는 답변 감사 필드(이메일·sub)가 실리지 않고, ?id=로 결정 하나를 조회한다', async () => {
  const app = await start();
  try {
    const token = (await app.sessionOf(app.jwtFor())).decisionToken;
    const open = JSON.parse((await app.remote('GET', `/api/dashboard/decisions?id=${app.decision.id}`)).text);
    assert.equal(open.item.status, 'open');
    assert.equal((await app.remote('POST', '/decisions/answer', {body: app.answerBody(token)})).status, 303);
    const done = await app.remote('GET', `/api/dashboard/decisions?id=${app.decision.id}`);
    assert.equal(JSON.parse(done.text).item.status, 'answered');
    assert.ok(!done.text.includes('sub-a') && !done.text.includes(EMAIL), '감사 필드는 응답에 없다');
    const unknown = JSON.parse((await app.remote('GET', '/api/dashboard/decisions?id=nope')).text);
    assert.equal(unknown.item, null);
    const past = await app.remote('GET', '/api/dashboard/decisions?past=1');
    assert.ok(!past.text.includes('sub-a') && !past.text.includes(EMAIL));
  } finally { app.close(); }
});

// main의 decisions.mjs list() 검증 중 answer를 보는 부분(옛 검증기). 새 코드가 쓴 원격 답변을 이 규칙이 그대로 읽어야 한다.
const oldValidator = (e, old) => !(!Array.isArray(e.options) || e.options.length < 2 || !e.options.every(x => typeof x === 'string') || typeof e.question !== 'string'
  || typeof e.reason !== 'string' || typeof e.card !== 'string' || (e.work !== undefined && typeof e.work !== 'string')
  || (e.status === 'answered' && typeof e.answer?.text !== 'string') || (e.answer?.source !== undefined && e.answer.source !== 'discord')
  || (e.answer?.messageId !== undefined && typeof e.answer.messageId !== 'string') || !e.id || e.to !== '@user'
  || e.revision !== (old?.revision ?? 0) + 1 || !['open', 'answered', 'cancelled'].includes(e.status));

test('저장 형식 호환: 새 코드가 쓴 원격 답변 이력을 옛 검증 규칙이 그대로 읽는다', async () => {
  const app = await start();
  try {
    const token = (await app.sessionOf(app.jwtFor())).decisionToken;
    assert.equal((await app.remote('POST', '/decisions/answer', {body: app.answerBody(token)})).status, 303);
    const rows = fs.readFileSync(path.join(app.home, 'decisions/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.length >= 3, '요청·답변·전달 기록');
    assert.ok(rows.some(row => row.answer?.remote), '원격 표시가 있는 답변');
    let old;
    for (const row of rows) { assert.ok(oldValidator(row, old), `옛 검증기 거부: revision ${row.revision}`); old = row; }
    assert.ok(rows.every(row => row.answer?.source === undefined), 'source 값은 그대로');
  } finally { app.close(); }
});

test('알림 링크 도우미: 원격 설정에 호스트가 있으면 공개 주소, 없으면 로컬 주소', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-link-'));
  assert.match(decisionLink(home, 'abc'), /^http:\/\/127\.0\.0\.1:\d+\/#decision-abc$/);
  fs.writeFileSync(path.join(home, REMOTE_ACCESS_FILE), JSON.stringify(config));
  assert.equal(decisionLink(home, 'abc'), `https://${HOST}/#decision-abc`);
  fs.writeFileSync(path.join(home, REMOTE_ACCESS_FILE), '{broken');
  assert.match(decisionLink(home, 'abc'), /^http:\/\/127\.0\.0\.1/);
});

// 검수 F1: POST 응답(JSON·최초 답변·같은 답 반복)에 이메일·sub·IP가 실리지 않는다. 저장 기록에는 그대로 있다.
test('원격 답변 POST 응답에는 감사 필드가 없다(최초 답변, 다른 신원의 같은 답 반복 모두)', async () => {
  const app = await start();
  try {
    const first = app.jwtFor({sub: 'sub-a'}), tokenA = (await app.sessionOf(first)).decisionToken;
    const headers = {accept: 'application/json', 'cf-connecting-ip': '203.0.113.7'};
    const one = await app.remote('POST', '/decisions/answer', {jwt: first, body: app.answerBody(tokenA, {revision: '1'}), headers});
    assert.equal(one.status, 200);
    for (const secret of ['sub-a', EMAIL, '203.0.113.7', '"remote"']) assert.ok(!one.text.includes(secret), `최초 응답에 ${secret} 없음`);
    const other = app.jwtFor({sub: 'sub-b'}), tokenB = (await app.sessionOf(other)).decisionToken;
    const again = await app.remote('POST', '/decisions/answer', {jwt: other, body: app.answerBody(tokenB, {revision: '1'}), headers: {...headers, 'cf-connecting-ip': '203.0.113.8'}});
    assert.equal(again.status, 200);
    for (const secret of ['sub-a', 'sub-b', EMAIL, '203.0.113.7', '203.0.113.8', '"remote"']) assert.ok(!again.text.includes(secret), `반복 응답에 ${secret} 없음`);
    assert.equal(app.fresh().answer.remote.sub, 'sub-a', '저장 기록에는 최초 감사 필드가 그대로 있다');
  } finally { app.close(); }
});

// 검수 F3: token 비교는 길이·형식이 다르면 먼저 거부하고 같은 길이일 때만 timingSafeEqual로 본다.
test('tokenEquals: 길이·형식이 다르면 거부, 같으면 일치만 통과', async () => {
  const {tokenEquals} = await import('../src/remote-access.mjs');
  const t = 'a'.repeat(64);
  assert.equal(tokenEquals(t, t), true);
  assert.equal(tokenEquals('a'.repeat(63), t), false);
  assert.equal(tokenEquals('A'.repeat(64), t), false, '대문자는 형식이 다르다');
  assert.equal(tokenEquals('b'.repeat(64), t), false);
  for (const bad of [undefined, null, 5, '']) assert.equal(tokenEquals(bad, t), false);
  assert.equal(tokenEquals(t, null), false);
});
