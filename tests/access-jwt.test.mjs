import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessJwtVerifier} from '../src/access-jwt.mjs';
import {TEAM, AUD, EMAIL, makeKey, sign, signRaw, fakeCerts} from './helpers/access-jwt-fixture.mjs';

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

test('F3: 세 부분은 엄격한 base64url만 받는다(패딩·표준 base64 글자·공백 거부)', async () => {
  const {key, verifier} = await setup();
  const [head, body, sig] = sign(key).split('.');
  assert.equal((await verifier.verify(`${head}.${body}.${sig}`)).ok, true);
  assert.equal(await reason(verifier, `${head}.${body}.${sig}=`), 'format', '서명 패딩');
  assert.equal(await reason(verifier, `${head}=.${body}.${sig}`), 'format', '헤더 패딩');
  assert.equal(await reason(verifier, `${head}.${body}+.${sig}`), 'format', '+ 글자');
  assert.equal(await reason(verifier, `${head}.${body}/.${sig}`), 'format', '/ 글자');
  assert.equal(await reason(verifier, `${head}.${body}. ${sig}`), 'format', '공백');
  assert.equal(await reason(verifier, `${head}.${body}.${sig}\n`), 'format', '줄바꿈');
});

test('F4: exp·nbf가 유한 숫자가 아니면 거부한다(1e400 → Infinity)', async () => {
  const {key, verifier} = await setup();
  const base = `"iss":"https://${TEAM}.cloudflareaccess.com","aud":["${AUD}"],"email":"${EMAIL}"`;
  const head = `{"alg":"RS256","kid":"${key.kid}"}`;
  assert.equal(await reason(verifier, signRaw(key, head, `{${base},"exp":1e400}`)), 'expired');
  assert.equal(await reason(verifier, signRaw(key, head, `{${base},"exp":${Math.floor(Date.now() / 1000) + 600},"nbf":-1e400}`)), 'not-before');
  assert.equal((await verifier.verify(signRaw(key, head, `{${base},"exp":${Math.floor(Date.now() / 1000) + 600}}`))).ok, true);
});

test('F4: 헤더·본문 JSON의 중복 키는 거부한다', async () => {
  const {key, verifier} = await setup();
  const body = `"iss":"https://${TEAM}.cloudflareaccess.com","aud":["${AUD}"],"email":"${EMAIL}","exp":${Math.floor(Date.now() / 1000) + 600}`;
  const head = `"alg":"RS256","kid":"${key.kid}"`;
  assert.equal(await reason(verifier, signRaw(key, `{${head},"alg":"none"}`, `{${body}}`)), 'format', '헤더 중복');
  assert.equal(await reason(verifier, signRaw(key, `{${head}}`, `{${body},"email":"other@example.com"}`)), 'format', '본문 중복');
  assert.equal((await verifier.verify(signRaw(key, `{${head}}`, `{${body},"extra":{"email":"x","email2":1}}`))).ok, true, '중첩 객체는 다른 키');
});

test('F4: JWK는 use가 sig, alg가 RS256일 때만 받고(둘 다 없으면 허용), 같은 kid가 둘이면 그 kid를 쓰지 않는다', async () => {
  const mk = (kid, patch = {}) => { const k = makeKey(kid); k.jwk = {...k.jwk, ...patch}; for (const [n, v] of Object.entries(patch)) if (v === undefined) delete k.jwk[n]; return k; };
  const enc = mk('enc', {use: 'enc'}), hs = mk('hs', {alg: 'HS256'}), bare = mk('bare', {use: undefined, alg: undefined});
  const dupA = makeKey('dup'), dupB = makeKey('dup'), ok = makeKey('ok');
  const certs = fakeCerts([enc, hs, bare, dupA, dupB, ok]);
  const verifier = createAccessJwtVerifier({team: TEAM, aud: AUD, email: EMAIL, fetchImpl: certs.fetchImpl, reloadGapMs: 1e12});
  await verifier.refresh();
  assert.equal(await reason(verifier, sign(enc)), 'kid', 'use=enc');
  assert.equal(await reason(verifier, sign(hs)), 'kid', 'alg=HS256');
  assert.equal((await verifier.verify(sign(bare))).ok, true, 'use·alg 없는 키는 허용');
  assert.equal(await reason(verifier, sign(dupA)), 'kid', '중복 kid');
  assert.equal(await reason(verifier, sign(dupB)), 'kid', '중복 kid');
  assert.equal((await verifier.verify(sign(ok))).ok, true);
});
