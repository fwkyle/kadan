// 질문 원문은 등록 때 한 번만 보존한다. 목록·감시에서는 작은 표시만 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {appendStream, readStream} from './storage.mjs';

const LIMIT = 128 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stream = id => `decisions/${id}/body.jsonl`;

export function loadDecisionBodyFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('--body-file은 절대경로 필요');
  if (fs.statSync(file).size > LIMIT) throw new Error('질문 원문은 128KiB 이내로 작성하세요');
  const bytes = fs.readFileSync(file);
  if (bytes.length > LIMIT) throw new Error('질문 원문은 128KiB 이내로 작성하세요');
  let text;
  try {text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);}
  catch {throw new Error('질문 원문은 UTF-8 파일이어야 합니다');}
  return {file, bytes: bytes.length, sha256: digest(bytes), text};
}

// 호출한 등록 함수의 트랜잭션에 참여한다. 원문을 갱신하는 함수는 없다.
export function writeDecisionBody(home, decision, body) {
  appendStream(home, stream(decision.id), {id: decision.id, at: decision.at, ...body});
}

// 표시가 없는 옛 결정은 반환 모양도 바꾸지 않는다. 원문 손상은 결정 자체를 숨기지 않는다.
export function decisionBodyContent(home, decision) {
  if (!decision.body) return {};
  try {
    const rows = readStream(home, stream(decision.id), {optional: true}), body = rows[0];
    if (rows.length !== 1 || body?.id !== decision.id || typeof body.text !== 'string')
      throw new Error('저장된 원문이 없거나 형식이 다릅니다');
    const bytes = Buffer.from(body.text, 'utf8'), sha256 = digest(bytes);
    if (bytes.length > LIMIT || body.bytes !== bytes.length || body.sha256 !== sha256
        || decision.body.bytes !== bytes.length || decision.body.sha256 !== sha256)
      throw new Error('저장된 원문의 크기 또는 지문이 다릅니다');
    return {bodyText: body.text};
  } catch (error) {
    return {bodyError: `질문 원문을 읽지 못했습니다: ${error.message}`};
  }
}
