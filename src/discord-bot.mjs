// 디스코드 봇 REST 클라이언트 — 3단계(#비서 대화)의 받기·보내기가 함께 쓴다. node 내장 fetch만 쓴다(의존성 0).
// 게이트웨이(WebSocket)는 쓰지 않는다. 주기 조회라 연결 유지·재연결을 직접 만들 일이 없다.
// 재시도(잠긴 규칙 3: 원인이 식별된 실패만, 같은 지점에서 3회면 멈춤):
//   - 연결 단계 실패(연결 거부·DNS 등): 읽기·쓰기 모두 재시도 — 요청이 서버에 닿지 않았음이 확실하다.
//   - 연결 뒤 끊김·시간 초과·5xx: 읽기(GET/PUT 반응/PATCH 같은 값 덮어쓰기)만 재시도. 새 글(POST)은 "불확실"로 멈춘다(중복 글 방지).
//   - 429: retry_after를 지켜 기다린 뒤 재시도(최대 30초까지만 기다린다). 4xx는 재시도 없음.
//   - 요청 하나의 시도는 최대 3회, 총 시간 예산(기본 30초) 안에서 끝난다. 3회 소진은 exhausted로 표시해 호출 쪽이 멈춘다.
// 오류 문구에는 상태 코드·오류 코드만 담는다. 토큰·주소는 넣지 않고, 호출 쪽이 한 번 더 scrubSecrets를 건다.
import {scrubSecrets} from './user-notify.mjs';

export const DISCORD_LIMIT = 2000;
export const DEFAULT_API = 'https://discord.com/api/v10';
export const API_BASE_ENV = 'KADAN_DISCORD_API_BASE';
const USER_AGENT = 'DiscordBot (https://github.com/fwkyle/kadan, 0.1.0)';
const ATTEMPT_MS = 10000;
const MAX_ATTEMPTS = 3;
const MAX_RATE_WAIT_MS = 30000;
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

export class DiscordError extends Error {
  constructor(message, {kind, status = null, code = null, exhausted = false} = {}) {
    super(message);
    this.kind = kind; this.status = status; this.code = code; this.exhausted = exhausted;
  }
}

// 요청이 나갈 기본 주소. 시험은 KADAN_DISCORD_API_BASE로 가짜 서버(루프백 http)를 가리킨다.
// 값이 없고 KADAN_NOTIFY=off(시험·격리 환경)이면 실제 디스코드로 나가지 않도록 거절한다.
export function apiBase(env = process.env) {
  const raw = env[API_BASE_ENV];
  if (raw) {
    let url;
    try { url = new URL(raw); } catch { throw new Error(`${API_BASE_ENV} 형식이 잘못됐다`); }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new Error(`${API_BASE_ENV}는 https이거나 루프백 http여야 한다`);
    return raw.replace(/\/+$/, '');
  }
  if (env.KADAN_NOTIFY === 'off') throw new Error('KADAN_NOTIFY=off라 실제 디스코드로 요청하지 않는다');
  return DEFAULT_API;
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const backoffMs = attempt => 500 * 2 ** (attempt - 1);

// 반환: {status, json}. 실패는 DiscordError(kind: http|network|uncertain|rate|budget)로 던진다.
export async function discordRequest({base, token, method = 'GET', path, body, idempotent = method !== 'POST',
  budgetMs = 30000, fetchFn = globalThis.fetch, sleep = defaultSleep, now = Date.now}) {
  const start = now();
  const left = () => budgetMs - (now() - start);
  const headers = {'user-agent': USER_AGENT, ...(token ? {authorization: `Bot ${token}`} : {}),
    ...(body === undefined ? {} : {'content-type': 'application/json'})};
  for (let attempt = 1; ; attempt++) {
    if (left() <= 0) throw new DiscordError('시간 상한 도달', {kind: 'budget'});
    let status, text, headerRetry;
    try {
      const res = await fetchFn(base + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Math.min(ATTEMPT_MS, left())))});
      status = res.status;
      text = await res.text();
      headerRetry = res.headers.get('retry-after');
    } catch (error) {
      const code = error?.cause?.code ?? (['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : 'ERR');
      if (!CONNECT_CODES.has(code) && !idempotent)
        throw new DiscordError(`연결 뒤 응답이 불확실하다(${code}) — 보냈는지 알 수 없어 재시도하지 않는다`, {kind: 'uncertain', code});
      if (attempt >= MAX_ATTEMPTS) throw new DiscordError(`네트워크 오류(${code}) ${attempt}회 — 멈춘다`, {kind: 'network', code, exhausted: true});
      await sleep(Math.min(backoffMs(attempt), Math.max(0, left())));
      continue;
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 본문이 JSON이 아님 */ }
    if (status >= 200 && status < 300) return {status, json};
    if (status === 429) {
      const wait = Number(json?.retry_after ?? headerRetry);
      const ms = Math.ceil((Number.isFinite(wait) && wait >= 0 ? wait : 1) * 1000);
      if (ms > MAX_RATE_WAIT_MS || ms > left()) throw new DiscordError(`429 대기(${Math.ceil(ms / 1000)}초)가 상한을 넘는다`, {kind: 'rate', status, exhausted: true});
      if (attempt >= MAX_ATTEMPTS) throw new DiscordError(`429 ${attempt}회 — 멈춘다`, {kind: 'rate', status, exhausted: true});
      await sleep(ms);
      continue;
    }
    if (status >= 500) {
      if (!idempotent) throw new DiscordError(`HTTP ${status} — 보냈는지 알 수 없어 재시도하지 않는다`, {kind: 'uncertain', status});
      if (attempt >= MAX_ATTEMPTS) throw new DiscordError(`HTTP ${status} ${attempt}회 — 멈춘다`, {kind: 'http', status, exhausted: true});
      await sleep(Math.min(backoffMs(attempt), Math.max(0, left())));
      continue;
    }
    throw new DiscordError(`HTTP ${status}${json?.code ? ` (디스코드 코드 ${json.code})` : ''}`, {kind: 'http', status, code: json?.code ?? null});
  }
}

// 토큰·값을 가리는 요청 함수 하나를 만든다. 오류 문구는 scrubSecrets를 거친다.
export function createApi({base, token, secrets = [], fetchFn, sleep, now}) {
  const hide = text => scrubSecrets(text, [token, ...secrets]);
  return async function api(method, path, body, opts = {}) {
    try {
      return await discordRequest({base, token: opts.noAuth ? null : token, method, path, body, fetchFn, sleep, now,
        ...(opts.budgetMs ? {budgetMs: opts.budgetMs} : {}), ...(opts.idempotent === undefined ? {} : {idempotent: opts.idempotent})});
    } catch (error) {
      if (error instanceof DiscordError) { error.message = hide(error.message); throw error; }
      throw new DiscordError(hide(`요청 실패(${error?.code ?? 'ERR'})`), {kind: 'network'});
    }
  };
}

// 2,000자 단위로 나눈다. 문단 경계(빈 줄) > 줄바꿈 > 공백 > 강제 순서로 자르고 서로게이트 쌍은 가르지 않는다. 순서를 지킨다.
export function splitDiscord(text, limit = DISCORD_LIMIT) {
  const parts = [];
  let rest = String(text).replace(/\r\n/g, '\n').trim();
  while (rest.length > limit) {
    let cut = -1;
    for (const sep of ['\n\n', '\n', ' ']) {
      const at = rest.lastIndexOf(sep, limit - 1);
      if (at > limit * 0.3) { cut = at; break; }
    }
    if (cut < 0) {
      cut = limit;
      const c = rest.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
    }
    const head = rest.slice(0, cut).trimEnd();
    if (head) parts.push(head);
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}
