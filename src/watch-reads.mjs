// 감시 한 주기 안에서 원장·카드·업무 전체 읽기를 원장이 바뀌지 않았으면 재사용한다.
// 2026-09-30 실측: 429·큐 재개 재확인과 우편 감시가 세션마다 전체를 다시 읽어 한 주기에 N+1번 읽을 수 있었다.
// 화면·PID(바닥 조회)는 여기서 감싸지 않는다 — 재개 직전·전송 후 확인은 항상 새로 읽어야 한다.
// version()은 원장 전체의 마지막 사건 번호다(null이면 비교 불가: JSONL은 매번 다시 읽는다).
// 카드 목록은 card.md 본문과 폴더 목록도 읽어 version이 다 덮지 못하므로, 재사용은 한 주기 안으로 한정한다.
export function cycleReads({readEntries, readCards = null, readWorks = () => [], version = () => null}) {
  const cache = new Map();
  const counts = {entries:0, cards:0, works:0, reused:0};
  const wrap = (name, read) => () => {
    // 번호를 먼저 읽는다. 그 사이 쓰기가 끼면 다음 호출에서 번호가 달라져 다시 읽으므로 안전하다.
    const v = version();
    const hit = cache.get(name);
    if (v !== null && hit && hit.v === v) { counts.reused++; return hit.value; }
    counts[name]++;
    const value = read();
    if (v !== null) cache.set(name, {v, value});
    return value;
  };
  return {
    readEntries: wrap('entries', readEntries),
    readCards: readCards ? wrap('cards', readCards) : null,
    readWorks: wrap('works', readWorks),
    // 주기 시작에 부른다. 직전 주기의 재사용 자료를 버리고 읽기 횟수를 0으로 되돌린다.
    begin() { cache.clear(); for (const key of Object.keys(counts)) counts[key] = 0; },
    stats() { return {...counts}; },
  };
}
