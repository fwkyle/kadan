// 보고서는 기간 시작보다 앞선 행을 읽지 않는다. 귀속은 send에 고정된 값만 읽는다.
import {storageSnapshot} from './storage.mjs';

const MAIN = "'system/events.jsonl','mail/events.jsonl','tasks/events.jsonl'";
// 업무 줄은 내용을 읽지 않고 스트림 이름(업무 키)만 쓴다. 마지막 상태는 heads에서 읽는다.
export const REPORT_SQL = `SELECT rowid, stream,
    CASE WHEN stream GLOB 'works/*/*/events.jsonl' THEN NULL ELSE payload END AS payload
  FROM events NOT INDEXED
  WHERE rowid > ? AND (
    (stream IN (${MAIN}) AND (json_extract(payload,'$.kind') IN ('compare-pick','start','done')
      OR (json_extract(payload,'$.kind') = 'send' AND json_extract(payload,'$.taskId') IS NOT NULL)))
    OR stream GLOB 'works/*/*/events.jsonl') ORDER BY rowid`;
export const REPORT_HEAD_SQL = 'SELECT payload FROM heads WHERE stream = ?';
export const REPORT_PROBE_SQL = `SELECT rowid, json_extract(payload,'$.t') AS t FROM events NOT INDEXED
  WHERE rowid >= ? AND stream IN (${MAIN}) AND json_extract(payload,'$.t') IS NOT NULL
  ORDER BY rowid LIMIT 1`;
export const REPORT_FIRST_SQL = 'SELECT rowid FROM events WHERE stream = ? AND seq = 1';
// 원장 순서와 사건 시각이 어긋날 수 있는 폭. 2026-11-10 운영 원장의 발령 스트림 최대 역전은 약 5.6분이었다.
export const ORDER_SLACK_MS = 60 * 60 * 1000;

// 기간 시작(여유 포함)보다 앞선 것이 확인된 가장 큰 rowid. 이분 탐색이라 원장이 10배여도 조회 3~4번이 늘 뿐이다.
export function lowerRowid(db, sinceMs) {
  if (!Number.isFinite(sinceMs)) return 0;
  const target = sinceMs - ORDER_SLACK_MS, probe = db.prepare(REPORT_PROBE_SQL);
  let low = 0, high = (db.prepare('SELECT max(rowid) AS v FROM events').get().v ?? 0) + 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2), row = probe.get(middle);
    // 시각을 못 읽으면 앞쪽으로 넓혀 더 읽는다(덜 읽는 쪽으로 틀리지 않는다).
    if (row && row.rowid < high && Date.parse(row.t) < target) low = row.rowid;
    else high = middle;
  }
  return low;
}

export function readCompareData(home, {since} = {}) {
  return storageSnapshot(home, db => {
    const entries = [], works = [], cards = [], workKeys = new Set();
    if (!db) return {entries, works, cards, afterRowid: 0};
    const afterRowid = lowerRowid(db, since == null ? NaN : Date.parse(since));
    const sent = new Set();
    for (const row of db.prepare(REPORT_SQL).iterate(afterRowid)) {
      if (row.payload === null) { workKeys.add(row.stream.slice(6, -13)); continue; }
      const value = JSON.parse(row.payload);
      entries.push({...value, rowid: row.rowid});
      if (value.kind !== 'send') continue;
      if (value.workKey) workKeys.add(value.workKey);
      sent.add(value.executionKey ?? value.taskId);
    }
    // 기간 앞에 만들어진 업무도 발령의 workKey로 직접 읽는다. 전체 카드 목록은 읽지 않는다.
    const head = db.prepare(REPORT_HEAD_SQL), first = db.prepare(REPORT_FIRST_SQL);
    for (const key of workKeys) {
      const row = head.get(`works/${key}/events.jsonl`), work = row && JSON.parse(row.payload);
      if (!work?.executions?.some(e => sent.has(e.key) || sent.has(e.key.split('/').at(-1)))) continue;
      works.push(work);
      for (const execution of work.executions) {
        const stream = `cards/${execution.key}/events.jsonl`, card = head.get(stream);
        if (!card) continue;
        // 읽은 범위에 발령이 없는 구현이 기간 앞에서 만들어졌는지: 기간 전에 시작한 업무를 가려내는 근거.
        const early = afterRowid > 0 && execution.phase === 'implementation' && !sent.has(execution.key)
          && (first.get(stream)?.rowid ?? Infinity) <= afterRowid;
        cards.push({...JSON.parse(card.payload), ...(early ? {createdBeforeWindow: true} : {})});
      }
    }
    return {entries, works, cards, afterRowid};
  });
}
