// Why: 같은 관계표와 전달 경로를 감시AI 요청마다 복사하지 않고 불변 원장 한 줄로 공유한다.
// 10배 요청에서도 관계표는 내용이 바뀐 횟수만큼, 각 요청은 고정 길이 지문만 추가된다.
import {createHash} from 'node:crypto';
import {appendRow} from './storage.mjs';

const prefix = 'watch-context/';
const digest = text => createHash('sha256').update(text).digest('hex');
const streamFor = ref => `${prefix}${ref}.jsonl`;
const failure = () => new Error('감시AI 관계표 참조 손상');

function contextPayload(db, ref) {
  if (typeof ref !== 'string' || !/^[a-f0-9]{64}$/.test(ref)) throw failure();
  const stream = streamFor(ref);
  const rows = db.prepare('SELECT seq,payload FROM events WHERE stream=? ORDER BY seq LIMIT 2').all(stream);
  const head = db.prepare('SELECT seq,payload FROM heads WHERE stream=?').get(stream);
  if (rows.length !== 1 || rows[0].seq !== 1 || head?.seq !== 1 ||
      head.payload !== rows[0].payload || digest(rows[0].payload) !== ref) throw failure();
  return rows[0].payload;
}

function context(db, ref) {
  const value = JSON.parse(contextPayload(db, ref));
  if (value.kind !== 'watch-ai-context' || value.version !== 1 ||
      !Array.isArray(value.parents) || !Array.isArray(value.routes)) throw failure();
  return value;
}

// appendDomainLedger의 같은 쓰기 트랜잭션 안에서만 호출한다. 기존 사건은 다시 쓰지 않는다.
export function storeWatchRequestContext(db, request) {
  if (request.kind !== 'watch-ai-request') return request;
  if (Object.hasOwn(request, 'contextRef')) throw new Error('감시AI 관계표 참조는 저장 모듈이 만듭니다');
  if (!Array.isArray(request.parents) || !Array.isArray(request.routes)) return request;
  const {parents, routes, ...rest} = request;
  const value = {kind: 'watch-ai-context', version: 1, parents, routes};
  const payload = JSON.stringify(value), ref = digest(payload), stream = streamFor(ref);
  if (db.prepare('SELECT 1 FROM heads WHERE stream=?').get(stream)) {
    // 같은 원문을 비교하면 반복 요청마다 큰 배열을 다시 해석·직렬화하지 않아도 된다.
    if (contextPayload(db, ref) !== payload) throw failure();
  } else {
    if (db.prepare('SELECT 1 FROM events WHERE stream=? LIMIT 1').get(stream)) throw failure();
    appendRow(db, stream, value);
  }
  return {...rest, contextRef: ref};
}

// 과거의 본문 포함 요청도 그대로 읽는다. 누락·손상된 참조는 빈 관계표로 꾸미지 않는다.
export function hydrateWatchRequest(db, request) {
  if (!Object.hasOwn(request, 'contextRef')) return request;
  if (Object.hasOwn(request, 'parents') || Object.hasOwn(request, 'routes')) throw failure();
  const {parents, routes} = context(db, request.contextRef);
  return {...request, parents, routes};
}

export function verifyWatchContexts(db) {
  const refs = new Set();
  for (const {stream} of db.prepare('SELECT stream FROM heads WHERE stream GLOB ?').iterate(`${prefix}*`)) {
    if (!stream.endsWith('.jsonl')) throw failure();
    const ref = stream.slice(prefix.length, -'.jsonl'.length);
    context(db, ref);refs.add(ref);
  }
  for (const {payload} of db.prepare(`SELECT payload FROM events WHERE stream='system/events.jsonl'
    AND json_extract(payload,'$.kind')='watch-ai-request'
    AND json_type(payload,'$.contextRef') IS NOT NULL`).iterate()) {
    const request = JSON.parse(payload);
    if (!refs.has(request.contextRef) || Object.hasOwn(request, 'parents') ||
        Object.hasOwn(request, 'routes')) throw failure();
  }
}
