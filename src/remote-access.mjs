// 대시보드 원격 읽기 전용: 설정 읽기와 요청 판정(로컬 / 원격 / 거부) 한 곳. 설명서는 docs/dashboard-remote.md.
// 설정 파일(KADAN_HOME/remote-access.json)이 없거나 항목이 빠졌거나 손상됐으면 원격 모드는 꺼지고 로컬 동작은 그대로다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ACCESS_JWT_HEADER, createAccessJwtVerifier} from './access-jwt.mjs';

export const REMOTE_ACCESS_FILE = 'remote-access.json';
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TEAM = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// {host, team, aud, email} 네 항목이 모두 올바를 때만 설정을 돌려준다. 아니면 null(꺼짐).
export function loadRemoteConfig(home) {
  if (!home) return null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, REMOTE_ACCESS_FILE), 'utf8'));
    const host = String(value?.host ?? '').trim().toLowerCase(), team = String(value?.team ?? '').trim().toLowerCase();
    const aud = typeof value?.aud === 'string' ? value.aud.trim() : '', email = String(value?.email ?? '').trim();
    if (!HOSTNAME.test(host) || !TEAM.test(team) || !aud || !/^[^@\s]+@[^@\s]+$/.test(email)) return null;
    return {host, team, aud, email};
  } catch { return null; }
}

// config가 null이면 게이트도 null이다(JWKS 조회·타이머 없음). certsUrl·fetchImpl·now는 시험용 주입이다.
export function createRemoteGate(config, options = {}) {
  if (!config) return null;
  const verifier = createAccessJwtVerifier({...config, ...options});
  verifier.start();
  return {host: config.host, verifier, stop: () => verifier.stop()};
}

// Cloudflare를 거쳐 온 요청의 표시 헤더(Cf-Ray·Cf-Connecting-IP·Cf-Access-* 등, CDN-Loop). 위조할 수 있으므로 원격 인증의 근거로는
// 쓰지 않고, 로컬 판정을 막는 데만 쓴다. 터널이 Host를 로컬 값으로 바꿔 보내도 이 표시는 남아 로컬로 통과하지 못한다.
const viaCloudflare = request => Object.keys(request.headers).some(name => name.startsWith('cf-') || name === 'cdn-loop');
const hostHeaderCount = request => {
  const raw = request.rawHeaders ?? [];
  let count = 0;
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === 'host') count++;
  return count;
};

// 판정 결과: {kind:'local'} | {kind:'remote'} | {kind:'deny', status, message}.
// 게이트가 없으면 예전의 Host 검사와 똑같이 동작한다.
export async function judgeRequest(request, gate) {
  const host = request.headers.host ?? '';
  // 원격이 켜진 서버만: Host가 둘 이상이면 어느 쪽을 믿을지 모호하므로 거부하고, 로컬 Host라도 Cloudflare 표시가 있으면 로컬로 보지 않는다.
  // 꺼져 있으면(gate 없음) 예전 동작 그대로다.
  if (gate && hostHeaderCount(request) > 1) return {kind: 'deny', status: 403, message: 'local host required'};
  if (LOCAL_HOST.test(host)) {
    if (gate && viaCloudflare(request)) return {kind: 'deny', status: 403, message: '원격 경유 요청은 허용 호스트로만 받습니다'};
    return {kind: 'local'};
  }
  if (!gate) return {kind: 'deny', status: 403, message: 'local host required'};
  if (host.toLowerCase().replace(/:[0-9]+$/, '') !== gate.host) return {kind: 'deny', status: 403, message: 'local host required'};
  const header = request.headers[ACCESS_JWT_HEADER];
  const result = await gate.verifier.verify(Array.isArray(header) ? undefined : header);
  return result.ok ? {kind: 'remote', claims: result.claims} : {kind: 'deny', status: 403, message: '원격 인증 확인 실패'};
}

// 같은 화면에서 온 요청인지(Origin 비교). 원격 요청이면 https 출처도 같은 출처로 본다(터널 뒤 브라우저는 https로 보낸다).
export function sameOrigin(request, origin = request.headers.origin) {
  const host = request.headers.host;
  return origin === `http://${host}` || (request.kadanRemote === true && origin === `https://${host}`);
}

// 결정 전용 token: 서버 시작 때 만든 비밀과 Access 신원(sub)·발급 시각(iat)의 HMAC이다. 상태를 저장하지 않고, 같은 신원의 JWT가 있을 때만
// 다시 계산되며 JWT가 갱신되면(iat 변경) 함께 바뀐다. 로컬 쓰기 token(무작위 값)과는 만드는 방식이 달라 서로 대신할 수 없다.
// sub·iat 가 없으면 null이라 답하기는 열리지 않는다(실패 닫힘).
export function decisionToken(secret, claims) {
  if (typeof claims?.sub !== 'string' || !claims.sub || !Number.isFinite(claims.iat)) return null;
  return crypto.createHmac('sha256', secret).update(`decision-answer\n${claims.sub}\n${claims.iat}`).digest('hex');
}

// 원격 답변 요청의 확인: Origin은 반드시 있어야 하고 https://<허용 호스트>와 정확히 같아야 한다(없음·null·http·다른 호스트는 거부).
export const remoteOriginOk = (request, host) => request.headers.origin === `https://${host}`;

// 결정 답변 기록에 남기는 원격 감사 필드. JWT 원문은 담지 않는다. Cf-Connecting-IP는 Cloudflare 표시 헤더라 믿을 수 없는 값(ipTrusted:false)이다.
export function remoteAudit(request, claims) {
  const ip = request.headers['cf-connecting-ip'];
  return {
    email: String(claims.email ?? ''), sub: String(claims.sub ?? ''), iat: claims.iat, exp: claims.exp,
    ...(typeof ip === 'string' && ip.length <= 64 ? {ip, ipTrusted: false} : {}),
  };
}

// token 비교는 길이·형식(16진수 글자)이 다르면 먼저 거부하고, 같으면 시간이 일정한 비교로 한다.
export function tokenEquals(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected || given.length !== expected.length || !/^[0-9a-f]+$/.test(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
