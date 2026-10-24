import {createHash} from 'node:crypto';

// 수집 시각은 관측 시점이며 상태 버전이 아니다. 약한 ETag로 같은 상태의 조건부 조회를 받는다.
export function sendVersionedJson(request, response, value, {fresh = false} = {}) {
  const {collectedAt, ...state} = value;
  const etag = `W/"${createHash('sha256').update(JSON.stringify(state)).digest('hex')}"`;
  const headers = {'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', etag};
  const supplied = String(request.headers['if-none-match'] ?? '').split(',').map(x => x.trim());
  if (!fresh && (supplied.includes('*') || supplied.includes(etag) || supplied.includes(etag.slice(2)))) {
    response.writeHead(304, headers); response.end(); return;
  }
  response.writeHead(200, headers); response.end(JSON.stringify(value));
}
