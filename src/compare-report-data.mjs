// 보고서는 비교 도입 전 행을 읽지 않는다. 귀속은 send에 고정된 값만 읽는다.
import {storageSnapshot} from './storage.mjs';

export const REPORT_SQL = `SELECT rowid, stream, payload FROM events NOT INDEXED
  WHERE rowid > ? AND (
    (stream IN ('system/events.jsonl','mail/events.jsonl','tasks/events.jsonl')
      AND json_extract(payload,'$.kind') IN ('compare-pick','start','send','done'))
    OR stream GLOB 'works/*/*/events.jsonl') ORDER BY rowid`;
export const REPORT_HEAD_SQL = 'SELECT payload FROM heads WHERE stream = ?';

export function readCompareData(home, compare) {
  return storageSnapshot(home, db => {
    const entries = [], works = new Map(), cards = new Map();
    if (!db || !compare?.enabledAt) return {entries, works: [], cards: []};
    const after = compare.historyStartRowid ?? compare.afterRowid ?? 0;
    const wanted = new Set();
    for (const row of db.prepare(REPORT_SQL).iterate(after)) {
      const value = JSON.parse(row.payload);
      if (row.stream.startsWith('works/')) works.set(value.key, value);
      else {
        entries.push({...value, rowid: row.rowid});
        if (value.workKey) wanted.add(value.workKey);
      }
    }
    // 회차 앞에 만들어진 업무도 발령의 workKey로 직접 읽는다. 전체 카드 목록은 읽지 않는다.
    const head = db.prepare(REPORT_HEAD_SQL);
    for (const key of new Set([...wanted, ...works.keys()])) {
      const row = head.get(`works/${key}/events.jsonl`);
      if (row) works.set(key, JSON.parse(row.payload));
    }
    const relevant = new Set(entries.filter(e => e.kind === 'send' && e.compareMode).map(e => e.executionKey));
    for (const [key, work] of works) {
      if (!wanted.has(key) && !work.executions?.some(e => relevant.has(e.key))) { works.delete(key); continue; }
      for (const execution of work.executions ?? []) {
        const row = head.get(`cards/${execution.key}/events.jsonl`);
        if (row) cards.set(execution.key, JSON.parse(row.payload));
      }
    }
    return {entries, works: [...works.values()], cards: [...cards.values()]};
  });
}
