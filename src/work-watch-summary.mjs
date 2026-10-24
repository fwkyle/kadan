import {transaction} from './storage.mjs';

// 감시 판정이 읽는 이력은 마지막 담당 변경(직전 행 포함), 명시 재지정, 다시 연 시각뿐이다.
// 원래 순서의 최대 네 행을 남기므로 기존 findLast 판정을 그대로 쓸 수 있다.
function historySummary() {
  let previous, boundary = [], assigned, opened;
  return {
    add(row) {
      if (!previous || previous.owner !== row.owner) boundary = [previous, row].filter(Boolean);
      if (row.ownerAssignedAt) assigned = row;
      if (row.action === 'create' || row.action === 'reopen') opened = row;
      previous = row;
    },
    rows() {
      return [...new Set([...boundary, assigned, opened].filter(Boolean))]
        .sort((a, b) => a.revision - b.revision);
    },
  };
}

const fields = ['owner', 'at', 'ownerAssignedAt', 'action'];
// 10배 이력에서도 JS에는 최신 업무와 판정용 최대 네 행만 남는다. SQL 무결성 검사는 전체 이력을 훑는다.
// 요약·이력 검증을 한 읽기 트랜잭션에서 수행한다. 원장과 상세 조회(get/list)는 바꾸지 않는다.
export function readWatchWorkSummaries(home, keyStream) {
  return transaction(home, db => {
    const summaries = new Map();
    for (const row of db.prepare(`SELECT stream, seq, payload FROM heads
      WHERE stream GLOB 'works/*/events.jsonl' ORDER BY stream`).iterate()) {
      const key = row.stream.slice(6, -13);
      keyStream(key);
      summaries.set(row.stream, {
        work: JSON.parse(row.payload), seq: row.seq, count: 0, history: historySummary(),
      });
    }
    const query = db.prepare(`
      SELECT e.stream, e.seq, e.payload=h.payload AS matchesHead,
        json_extract(e.payload,'$.key')=substr(e.stream,7,length(e.stream)-19)
          AND json_type(e.payload,'$.revision') IN ('integer','real')
          AND json_extract(e.payload,'$.revision')=e.seq
          AND json_type(e.payload,'$.executions')='array'
          AND json_type(e.payload,'$.mailRefs')='array' AS valid,
        e.payload -> '$.owner' AS owner, e.payload -> '$.at' AS at,
        e.payload -> '$.ownerAssignedAt' AS ownerAssignedAt, e.payload -> '$.action' AS action
      FROM events e JOIN heads h ON h.stream=e.stream
      WHERE e.stream GLOB 'works/*/events.jsonl' ORDER BY e.stream,e.seq
    `);
    for (const row of query.iterate()) {
      const state = summaries.get(row.stream);
      if (!state || !row.valid || row.seq !== ++state.count || row.seq > state.seq
          || (row.seq === state.seq && !row.matchesHead)) throw new Error('업무 이력 손상');
      const event = {revision: row.seq};
      // ->는 JSON 자료형과 누락을 구분한다(null과 없는 owner도 기존 === 비교와 같게 보존).
      for (const field of fields) if (row[field] !== null) event[field] = JSON.parse(row[field]);
      state.history.add(event);
    }
    return [...summaries.values()].map(state => {
      if (!state.count || state.count !== state.seq) throw new Error('업무 이력 손상');
      return {...state.work, history: state.history.rows()};
    });
  }, {readOnly: true});
}
