// Why: SQL에서 검증한 사건을 RAM validator와 여러 원장 배열로 다시 보관하지 않는다.
// SQL은 새 위치만 읽는다. 단일 전체 배열의 보관과 새 사건 때 참조 복사는 아직 과거 크기에 비례한다.
import {domainProjector} from './ledger-domains.mjs';
import {sourceViewValues} from './ledger-view.mjs';

export function createWatchLedgerView() {
  let state = null;
  const projector = domainProjector(null);
  return (store, info) => {
    if (store && store.scope !== '') throw new Error('감시 사건은 원문 조회 영역이 필요합니다');
    const counts = store?.prepare("SELECT value FROM meta WHERE key='counts'").get()?.value;
    const total = counts ? JSON.parse(counts)['']?.total ?? 0 : 0;
    const previous = state?.generation === info.generation && state.position <= info.position ? state : null;
    if (previous?.position === info.position && previous.entries.length === total) return previous.entries;
    const added = [];
    let position = previous?.position ?? 0;
    if (store) {
      const query = store.prepare(`SELECT v.position,r.stream,r.seq FROM views v
        JOIN source_rows r USING(position) WHERE v.domain='' AND v.position>? AND v.position<=?
        ORDER BY v.position LIMIT 256`);
      while (true) {
        const rows = query.all(position, info.position);
        if (!rows.length) break;
        const values = sourceViewValues(store.source, rows);
        for (const [index, row] of rows.entries()) {
          const entry = (row.stream === 'ledger.jsonl' ? projector.legacy([values[index]])
            : projector.rows([values[index]]))[0];
          if (entry == null || entry.broken) throw new Error('원장 손상: 감시 사건 조회 불가');
          added.push(entry);position = row.position;
        }
      }
    }
    const entries = previous && !added.length ? previous.entries : (previous?.entries ?? []).concat(added);
    if (entries.length !== total) throw new Error('감시 사건 조회 개수 불일치');
    // 바깥 commit이 실패해도 이 배열은 검증된 원본 prefix다. 다음 조회의 세대/끝 위치를 다시 확인한다.
    state = {generation:info.generation, position:info.position, entries};
    return entries;
  };
}
