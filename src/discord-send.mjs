// 디스코드 웹훅 전송 자식 프로세스 — user-notify.mjs가 spawnSync로 띄워 stdin으로 {url, payload}를 준다.
// 호출하는 쪽이 모두 동기라서 여기서 네트워크를 기다리고, 부모는 강제 시간 제한만 건다.
// 같은 요청을 두 번 받으면 웹훅은 두 번 올리므로, 재시도는 "보내지 않았음이 확실한" 경우만 한다.
//   - 연결 단계 실패(연결 거부·DNS·연결 시간 초과): 최대 2회 재시도
//   - 429: retry_after를 지켜 1회 / 5xx: 1회
//   - 4xx(400·401·404 등)와 연결된 뒤의 시간 초과·끊김: 재시도 없음 (뒤쪽은 "불확실")
// wait=true면 응답의 messageId·channelId(포럼 새 글이면 channelId가 글 id)를 돌려준다.
// messageId를 주면 새로 올리지 않고 그 메시지를 고친다(PATCH .../messages/<id>). 같은 내용을 두 번 고쳐도 결과가 같아
// 재시도 규칙은 그대로 둔다. 고치는 대상 글은 threadId로 가리킨다.
// 출력(stdout 한 줄 JSON)에는 주소·토큰·오류 원문을 넣지 않는다 — 오류 코드와 HTTP 상태만 남긴다.
import http from 'node:http';
import https from 'node:https';
import {fileURLToPath} from 'node:url';

export const TOTAL_BUDGET_MS = 12000; // 재시도 포함 한 번 알림이 막는 총시간 상한(부모 강제 제한은 14초)
const CONNECT_MS = 4000;
const RESPONSE_MS = 5000;

function attempt(url, body, budgetMs, method = 'POST') {
  return new Promise(resolve => {
    const mod = url.protocol === 'https:' ? https : http;
    let connected = false, done = false, timer;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); req.destroy(); resolve(result); };
    const req = mod.request(url, {method, headers: {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => finish({kind: 'response', status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8')}));
      res.on('error', () => finish({kind: 'after-connect', reason: '응답 읽기 실패'}));
    });
    const arm = (ms, kind, reason) => { clearTimeout(timer); timer = setTimeout(() => finish({kind, reason}), Math.max(1, Math.min(ms, budgetMs))); };
    arm(CONNECT_MS, 'connect-fail', 'ETIMEDOUT(연결)');
    req.on('socket', socket => {
      const onConnect = () => { connected = true; arm(RESPONSE_MS, 'after-connect', '응답 대기 시간 초과'); };
      if (!socket.connecting) onConnect();
      else socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', onConnect);
    });
    req.on('error', error => finish(connected
      ? {kind: 'after-connect', reason: `연결 후 오류(${error.code ?? 'ERR'})`}
      : {kind: 'connect-fail', reason: error.code ?? 'ERR'}));
    req.end(body);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 반환: {outcome:'sent'|'failed'|'uncertain', attempts, status?, reason?}
export async function sendWebhook(webhook, payload, {budgetMs = TOTAL_BUDGET_MS, now = Date.now, threadId, wait, messageId} = {}) {
  const url = new URL(webhook);
  const method = messageId ? 'PATCH' : 'POST';
  if (messageId) {
    if (!/^[\w-]+$/.test(String(messageId))) return {outcome: 'failed', attempts: 0, reason: '메시지 id 형식 오류'};
    url.pathname = `${url.pathname.replace(/\/$/, '')}/messages/${messageId}`;
  } else if (wait) url.searchParams.set('wait', 'true');
  if (threadId) url.searchParams.set('thread_id', String(threadId));
  const body = JSON.stringify(payload), start = now();
  const left = () => budgetMs - (now() - start);
  let attempts = 0, connectRetries = 0, rateRetried = false, serverRetried = false;
  for (;;) {
    if (left() <= 0) return {outcome: 'failed', attempts, reason: '시간 상한 도달'};
    attempts++;
    const r = await attempt(url, body, left(), method);
    if (r.kind === 'after-connect') return {outcome: 'uncertain', attempts, reason: r.reason};
    if (r.kind === 'connect-fail') {
      if (connectRetries >= 2 || left() < 1500) return {outcome: 'failed', attempts, reason: r.reason};
      await sleep(400 * ++connectRetries);
      continue;
    }
    if (r.status >= 200 && r.status < 300) {
      const sent = {outcome: 'sent', attempts, status: r.status};
      if (wait) try { const j = JSON.parse(r.text); sent.messageId = j.id ?? null; sent.channelId = j.channel_id ?? null; } catch { /* 본문 없음 */ }
      return sent;
    }
    if (r.status === 429 && !rateRetried) {
      let wait = Number(r.headers['retry-after']);
      try { const j = JSON.parse(r.text); if (Number.isFinite(Number(j.retry_after))) wait = Number(j.retry_after); } catch { /* 헤더 값을 쓴다 */ }
      const ms = Math.ceil((Number.isFinite(wait) && wait >= 0 ? wait : 1) * 1000);
      if (ms > left() - 1500) return {outcome: 'failed', attempts, status: 429, reason: '429 대기가 시간 상한을 넘는다'};
      rateRetried = true;
      await sleep(ms);
      continue;
    }
    if (r.status >= 500 && !serverRetried && left() > 2500) { serverRetried = true; await sleep(1000); continue; }
    return {outcome: 'failed', attempts, status: r.status, reason: `HTTP ${r.status}`};
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { input += c; });
  process.stdin.on('end', async () => {
    let result;
    try {
      const {webhook, payload, budgetMs, threadId, wait, messageId} = JSON.parse(input);
      result = await sendWebhook(webhook, payload, {...(budgetMs ? {budgetMs} : {}), threadId, wait, messageId});
    } catch { result = {outcome: 'failed', attempts: 0, reason: '전송 준비 오류'}; }
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  });
}
