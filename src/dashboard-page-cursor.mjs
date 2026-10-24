// Why: 기록·우편의 쪽 이동은 조회 세대와 조건에 묶인 위치로 표현한다.
import {createHash} from 'node:crypto';

export const pageQueryKey = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const encodePageCursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export const invalidPageCursor = () => Object.assign(new Error('조회 위치가 올바르지 않습니다'), {status:400});
export function decodePageCursor(value) {
  if (!value) return null;
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidPageCursor();
  let cursor;
  try {cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));} catch {throw invalidPageCursor();}
  if (cursor?.v !== 1 || typeof cursor.g !== 'string' || typeof cursor.q !== 'string' ||
    !['before', 'after'].includes(cursor.direction) ||
    ![cursor.anchor, cursor.edge, cursor.page].every(n => Number.isSafeInteger(n) && n > 0) ||
    cursor.edge > cursor.anchor + 1) throw invalidPageCursor();
  return cursor;
}
