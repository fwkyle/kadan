// Cloudflare Access 토큰(Cf-Access-Jwt-Assertion, RS256 JWT) 검증. 의존성 없이 node:crypto만 쓴다.
// 공식 문서 대조(2026-10-18): 헤더 이름, certs 주소 `https://<팀>.cloudflareaccess.com/cdn-cgi/access/certs`,
// 응답의 `keys`(JWK 배열, kid·kty·alg·use·e·n), `iss`=`https://<팀>.cloudflareaccess.com`, 서명 RS256.
// 문서는 aud가 문자열인지 배열인지 밝히지 않아 둘 다 받는다(배열이면 포함 여부). email 클레임도 문서에 정의가 없다.
// 열쇠 모음(JWKS)은 메모리에만 둔다. 받기가 실패하면 가진 열쇠로 계속하고, 하나도 없으면 모두 거부한다(실패 닫힘).
import crypto from 'node:crypto';

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
const b64 = text => Buffer.from(text, 'base64url');
const B64URL = /^[A-Za-z0-9_-]+$/; // 패딩(=)·표준 base64 글자(+ /)·공백은 받지 않는다
// 같은 키가 두 번 나오는 JSON은 어느 값을 쓸지 모호하므로 거부한다. 최상위 키만 훑는다(문자열 안의 따옴표는 건너뛴다).
const hasDuplicateKey = text => {
  const seen = new Set();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && /^\s*:/.test(text.slice(j + 1, j + 40))) { const key = text.slice(i, j + 1); if (seen.has(key)) return true; seen.add(key); }
      i = j;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return false;
};
const json = text => { try { const raw = b64(text).toString('utf8'); if (hasDuplicateKey(raw)) return null; const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };

export const accessIssuer = team => `https://${team}.cloudflareaccess.com`;
export const accessCertsUrl = team => `${accessIssuer(team)}/cdn-cgi/access/certs`;

export function createAccessJwtVerifier({
  team, aud, email, certsUrl = accessCertsUrl(team), fetchImpl = fetch, now = Date.now,
  refreshMs = 3_600_000, reloadGapMs = 60_000, timeoutMs = 5000,
} = {}) {
  const issuer = accessIssuer(team), wantedEmail = String(email).trim().toLowerCase();
  let keys = new Map(), lastTry = -Infinity, pending = null, timer = null;

  // 받기는 한 번에 하나만 돈다. 성공해 열쇠가 하나 이상일 때만 통째로 바꾼다.
  const refresh = () => pending ??= (async () => {
    lastTry = now();
    try {
      const response = await fetchImpl(certsUrl, {signal: AbortSignal.timeout(timeoutMs), headers: {accept: 'application/json'}});
      if (!response.ok) return false;
      const body = await response.json(), next = new Map(), duplicated = new Set();
      for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
        // use가 있으면 sig만, alg가 있으면 RS256만 받는다. 문서 응답의 키는 둘 다 적혀 있어(alg RS256, use sig) 없을 때만 느슨하다.
        if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.alg !== undefined && jwk.alg !== 'RS256')
          || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
        if (next.has(jwk.kid) || duplicated.has(jwk.kid)) { next.delete(jwk.kid); duplicated.add(jwk.kid); continue; } // 같은 kid가 둘이면 그 kid는 쓰지 않는다
        try { next.set(jwk.kid, crypto.createPublicKey({key: jwk, format: 'jwk'})); } catch { /* 깨진 열쇠는 건너뛴다 */ }
      }
      if (!next.size) return false;
      keys = next;
      return true;
    } catch { return false; }
    finally { pending = null; }
  })();

  async function verify(token) {
    if (typeof token !== 'string') return {ok: false, reason: 'missing'};
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !B64URL.test(part))) return {ok: false, reason: 'format'};
    const header = json(parts[0]), claims = json(parts[1]);
    if (!header || !claims) return {ok: false, reason: 'format'};
    if (header.alg !== 'RS256') return {ok: false, reason: 'alg'};
    if (typeof header.kid !== 'string') return {ok: false, reason: 'kid'};
    let key = keys.get(header.kid);
    // 모르는 kid는 열쇠가 돌았을 수 있어 다시 받는다. 1분에 한 번만(공격 요청이 조회를 쏟아내지 못하게).
    if (!key && now() - lastTry >= reloadGapMs) { await refresh(); key = keys.get(header.kid); }
    else if (!key && pending) { await pending; key = keys.get(header.kid); }
    if (!key) return {ok: false, reason: keys.size ? 'kid' : 'no-keys'};
    let signed = false;
    try { signed = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64(parts[2])); } catch { signed = false; }
    if (!signed) return {ok: false, reason: 'signature'};
    const seconds = now() / 1000;
    if (!Number.isFinite(claims.exp) || claims.exp <= seconds) return {ok: false, reason: 'expired'};
    if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds)) return {ok: false, reason: 'not-before'};
    if (claims.iss !== issuer) return {ok: false, reason: 'iss'};
    if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(aud)) return {ok: false, reason: 'aud'};
    if (typeof claims.email !== 'string' || claims.email.trim().toLowerCase() !== wantedEmail) return {ok: false, reason: 'email'};
    return {ok: true, claims};
  }

  // 시작할 때 한 번 받고 정기적으로 갱신한다. 타이머는 프로세스 종료를 막지 않는다.
  const start = () => { void refresh(); timer ??= setInterval(() => void refresh(), refreshMs); timer.unref?.(); };
  const stop = () => { clearInterval(timer); timer = null; };
  return {verify, refresh, start, stop, keyCount: () => keys.size};
}
