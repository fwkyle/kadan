// Why: SQL에서 검증한 사건을 RAM validator와 여러 원장 배열로 다시 보관하지 않는다.
// SQL은 새 위치만 읽는다. 단일 전체 배열의 보관과 새 사건 때 참조 복사는 아직 과거 크기에 비례한다.
import {domainProjector} from './ledger-domains.mjs';
import {sourceViewValues} from './ledger-view.mjs';

// 감시 판정이 읽지 않는 것만 RAM 배열에서 뺀다(실측 2026-10-25 운영 사본: 이 둘이 배열 JSON 52MiB 중 약 27MiB).
//  - 종류 watch-cycle·watch-scope: 감시기가 기록만 하고 이 배열의 소비자가 없다(순회 시각은 런너가 메모리로 기억).
//  - send의 roleInstructions: 받는 쪽 지침 적용 기록(약 630B). 감시 소비자가 읽지 않는다.
// 원문(SQL)과 우편 조회는 그대로다. 다른 필드·종류·순서는 바꾸지 않는다.
export const WATCH_ARRAY_SKIP_KINDS = new Set(['watch-cycle', 'watch-scope']);
const slimEntry = entry => {
  if (entry.kind !== 'send' || !Object.hasOwn(entry, 'roleInstructions')) return entry;
  const {roleInstructions, ...rest} = entry;
  return rest;
};

// 원문 행 [after, upTo]를 감시 배열 규칙(종류 제외·필드 슬림)으로 읽는다. 증분 읽기와 정기 대조가 같은 규칙을 쓴다.
export function readWatchRows(store, projector, after, upTo, limit = 256) {
  const query = store.prepare(`SELECT v.position,r.stream,r.seq FROM views v
    JOIN source_rows r USING(position) WHERE v.domain='' AND v.position>? AND v.position<=?
    ORDER BY v.position LIMIT ?`);
  const rows = query.all(after, upTo, limit);
  const entries = [];
  let skipped = 0;
  if (rows.length) {
    const values = sourceViewValues(store.source, rows);
    for (const [index, row] of rows.entries()) {
      const entry = (row.stream === 'ledger.jsonl' ? projector.legacy([values[index]])
        : projector.rows([values[index]]))[0];
      if (entry == null || entry.broken) throw new Error('원장 손상: 감시 사건 조회 불가');
      if (WATCH_ARRAY_SKIP_KINDS.has(entry.kind)) skipped++;
      else entries.push(slimEntry(entry));
    }
  }
  return {entries, skipped, rows: rows.length, last: rows.length ? rows.at(-1).position : after};
}

export function createWatchLedgerView() {
  let state = null;
  const projector = domainProjector(null);
  const view = (store, info) => {
    if (store && store.scope !== '') throw new Error('감시 사건은 원문 조회 영역이 필요합니다');
    const counts = store?.prepare("SELECT value FROM meta WHERE key='counts'").get()?.value;
    const total = counts ? JSON.parse(counts)['']?.total ?? 0 : 0;
    const previous = state?.generation === info.generation && state.position <= info.position ? state : null;
    if (previous?.position === info.position && previous.entries.length + previous.skipped === total) return previous.entries;
    const added = [];
    let position = previous?.position ?? 0, skipped = previous?.skipped ?? 0;
    if (store) {
      while (true) {
        const chunk = readWatchRows(store, projector, position, info.position);
        if (!chunk.rows) break;
        added.push(...chunk.entries);skipped += chunk.skipped;position = chunk.last;
      }
    }
    const entries = previous && !added.length ? previous.entries : (previous?.entries ?? []).concat(added);
    if (entries.length + skipped !== total) throw new Error('감시 사건 조회 개수 불일치');
    // 바깥 commit이 실패해도 이 배열은 검증된 원본 prefix다. 다음 조회의 세대/끝 위치를 다시 확인한다.
    state = {generation:info.generation, position:info.position, entries, skipped};
    return entries;
  };
  // 정기 대조용: 지금 들고 있는 증분 상태(불변 배열)와, 처음부터 다시 만들기 위한 초기화.
  view.peek = () => state && {generation:state.generation, position:state.position, entries:state.entries, skipped:state.skipped};
  view.reset = () => { state = null; };
  view.projector = projector;
  return view;
}
