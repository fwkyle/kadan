import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessJwtVerifier} from '../src/access-jwt.mjs';
import {TEAM, AUD, EMAIL, makeKey, sign, fakeCerts} from './helpers/access-jwt-fixture.mjs';

async function setup(extra = {}) {
  const key = makeKey(), certs = fakeCerts([key]);
  const verifier = createAccessJwtVerifier({team: TEAM, aud: AUD, email: EMAIL, fetchImpl: certs.fetchImpl, ...extra});
  await verifier.refresh();
  return {key, certs, verifier};
}
const reason = async (verifier, token) => (await verifier.verify(token)).reason;

test('정상 토큰은 통과하고 aud가 문자열이어도 받는다', async () => {
  const {key, verifier} = await setup();
  assert.equal((await verifier.verify(sign(key))).ok, true);
  assert.equal((await verifier.verify(sign(key, {claims: {aud: AUD}}))).ok, true);
  assert.equal((await verifier.verify(sign(key, {claims: {email: 'USER@Example.com'}}))).ok, true, '이메일 대소문자는 가리지 않는다');
});

test('본문 변조·서명 변조는 거부한다', async () => {
  const {key, verifier} = await setup();
  const [head, , sig] = sign(key).split('.');
  const forged = Buffer.from(JSON.stringify({iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: EMAIL, exp: 9e9})).toString('base64url');
  assert.equal(await reason(verifier, `${head}.${forged}.${sig}`), 'signature');
  const good = sign(key), tail = good.slice(-4);
  assert.equal(await reason(verifier, good.slice(0, -4) + (tail === 'AAAA' ? 'BBBB' : 'AAAA')), 'signature');
});

test('만료·nbf 미래·aud·iss·이메일 불일치는 거부한다', async () => {
  const {key, verifier} = await setup();
  const now = Date.now() / 1000;
  assert.equal(await reason(verifier, sign(key, {claims: {exp: Math.floor(now) - 5}})), 'expired');
  assert.equal(await reason(verifier, sign(key, {claims: {nbf: Math.floor(now) + 600}})), 'not-before');
  assert.equal(await reason(verifier, sign(key, {claims: {aud: ['other-aud']}})), 'aud');
  assert.equal(await reason(verifier, sign(key, {claims: {iss: 'https://other.cloudflareaccess.com'}})), 'iss');
  assert.equal(await reason(verifier, sign(key, {claims: {email: 'other@example.com'}})), 'email');
  assert.equal(await reason(verifier, sign(key, {claims: {email: undefined}})), 'email', '이메일 클레임이 없으면 거부');
  assert.equal(await reason(verifier, sign(key, {claims: {exp: undefined}})), 'expired', 'exp가 없으면 거부');
});

test('alg none·HS256 등 RS256이 아닌 토큰과 깨진 형식은 거부한다', async () => {
  const {key, verifier} = await setup();
  assert.equal(await reason(verifier, sign(key, {header: {alg: 'none'}})), 'alg');
  assert.equal(await reason(verifier, sign(key, {header: {alg: 'HS256'}})), 'alg');
  assert.equal(await reason(verifier, undefined), 'missing');
  assert.equal(await reason(verifier, 'a.b'), 'format');
  assert.equal(await reason(verifier, 'a..c'), 'format');
  assert.equal(await reason(verifier, 'x.y.z'), 'format');
});

test('모르는 kid는 열쇠를 다시 받아 보고, 1분에 한 번만 받는다', async () => {
  let clock = 1_000_000;
  const {key, certs, verifier} = await setup({now: () => clock});
  const rotated = makeKey('kid-2');
  assert.equal(certs.state.calls, 1);
  clock += 61_000;
  certs.state.keys = [key, rotated];
  assert.equal((await verifier.verify(sign(rotated, {now: clock}))).ok, true, '새 kid가 오면 다시 받아 통과');
  assert.equal(certs.state.calls, 2);
  const stranger = makeKey('kid-3');
  assert.equal(await reason(verifier, sign(stranger, {now: clock})), 'kid');
  assert.equal(certs.state.calls, 2, '방금 받았으면 1분 안에는 다시 받지 않는다');
  clock += 61_000;
  assert.equal(await reason(verifier, sign(stranger, {now: clock})), 'kid');
  assert.equal(certs.state.calls, 3);
  assert.equal(await reason(verifier, sign(stranger, {now: clock})), 'kid');
  assert.equal(certs.state.calls, 3, '1분 안에는 다시 받지 않는다');
});

test('열쇠가 없으면 모두 거부하고(실패 닫힘), 받기가 실패해도 가진 열쇠로 계속한다', async () => {
  const key = makeKey(), certs = fakeCerts([key]);
  certs.state.fail = true;
  const verifier = createAccessJwtVerifier({team: TEAM, aud: AUD, email: EMAIL, fetchImpl: certs.fetchImpl});
  assert.equal(await verifier.refresh(), false);
  assert.equal(await reason(verifier, sign(key)), 'no-keys');
  certs.state.fail = false;
  assert.equal(await verifier.refresh(), true);
  assert.equal((await verifier.verify(sign(key))).ok, true);
  certs.state.fail = true;
  assert.equal(await verifier.refresh(), false, '조회 실패');
  assert.equal((await verifier.verify(sign(key))).ok, true, '가진 열쇠로 계속');
});

test('빈 열쇠 응답이나 HTTP 오류는 가진 열쇠를 지우지 않는다', async () => {
  const {key, certs, verifier} = await setup();
  certs.state.keys = [];
  assert.equal(await verifier.refresh(), false);
  assert.equal((await verifier.verify(sign(key))).ok, true);
  const bad = createAccessJwtVerifier({team: TEAM, aud: AUD, email: EMAIL, fetchImpl: async () => ({ok: false, json: async () => ({})})});
  assert.equal(await bad.refresh(), false);
  assert.equal(bad.keyCount(), 0);
});
