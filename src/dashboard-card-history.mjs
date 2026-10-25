// Why: 목록은 과거 이력을 RAM에 두지 않는다. 상세·이력 화면을 열 때만 그 카드(업무)의 이력을 SQL로 읽는다.
// 읽는 범위는 수집한 revision까지고, 마지막 행의 지문이 수집 때의 head 지문과 같아야 한다. 다르면 새 수집을 한 번 받게 한다
// (본문 요약과 같은 규칙: dashboard-card-body.mjs, wall.mjs의 한 번 재시도).
import {createHash} from 'node:crypto';
import {transaction} from './storage.mjs';

const CHANGED = () => Object.assign(new Error('수집 뒤 이력이 바뀌었습니다'), {code: 'KADAN_HISTORY_CHANGED'});

export function hydrateHistory(item, home) {
  if (!item?.historyRef || item.history) return item;
  const {stream, revision, hash} = item.historyRef;
  if (!home) throw new Error('이력을 읽을 홈이 필요합니다');
  const rows = transaction(home, db => db.prepare('SELECT seq,payload FROM events WHERE stream=? AND seq<=? ORDER BY seq')
    .all(stream, revision), {readOnly: true});
  if (rows.length !== revision || rows.some((row, index) => row.seq !== index + 1)
      || createHash('sha256').update(rows.at(-1).payload).digest('hex') !== hash) throw CHANGED();
  return {...item, history: rows.map(row => JSON.parse(row.payload))};
}
