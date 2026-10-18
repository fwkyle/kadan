// Access 토큰 시험용 임시 키·서명 도구. 값은 모두 자리표시(example.com, team-name)다.
import crypto from 'node:crypto';

export const TEAM = 'team-name', AUD = 'aud-tag-0001', EMAIL = 'user@example.com', HOST = 'kadan.example.com';

export function makeKey(kid = 'kid-1') {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
  return {kid, privateKey, jwk: {...publicKey.export({format: 'jwk'}), kid, alg: 'RS256', use: 'sig'}};
}

const enc = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export function sign(key, {header = {}, claims = {}, now = Date.now()} = {}) {
  const seconds = Math.floor(now / 1000);
  const head = {alg: 'RS256', kid: key.kid, typ: 'JWT', ...header};
  const body = {iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: EMAIL, exp: seconds + 3600, iat: seconds, ...claims};
  const data = `${enc(head)}.${enc(body)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key.privateKey).toString('base64url')}`;
}

// 가짜 열쇠 모음 응답. calls로 조회 횟수를 센다.
export function fakeCerts(keys) {
  const state = {calls: 0, fail: false, keys};
  const fetchImpl = async () => {
    state.calls++;
    if (state.fail) throw new Error('network down');
    return {ok: true, json: async () => ({keys: state.keys.map(k => k.jwk)})};
  };
  return {state, fetchImpl};
}
