// 관계표 등록과 정리는 같은 쓰기 잠금을 사용한다. 남의 잠금은 지우지 않는다.
import fs from 'node:fs';
import path from 'node:path';

export function withHierarchyLock(hierarchyPath, run) {
  const lock = path.join(path.dirname(hierarchyPath), 'hierarchy-register.lock');
  let handle;
  try { handle = fs.openSync(lock, 'wx'); }
  catch (cause) {
    const error = new Error('관계표 쓰기 잠금을 얻지 못함', {cause});
    error.code = 'HIERARCHY_LOCKED';
    throw error;
  }
  try { return run(); }
  finally {
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}
