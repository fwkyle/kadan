// 접어 둔 결정: 이 브라우저에 결정 ID로 기억한다. 지금 결정할 수 없는 요청(예: 관리자 인터뷰 필요)이 계속 펼쳐져
// 다른 결정을 가렸다(2026-09-26 kyle). 저장할 때 아직 기다리는 결정만 남겨 목록이 끝없이 늘지 않게 한다.
export const foldKey = "kadan.decisions.folded";
type Store = Pick<Storage, "getItem" | "setItem">;

export function readFolded(store: Store | null): Set<string> {
  try {
    const value: unknown = JSON.parse(store?.getItem(foldKey) || "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function toggleFolded(folded: Set<string>, id: string): Set<string> {
  const next = new Set(folded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function saveFolded(store: Store | null, folded: Set<string>, openIds: string[] | null): void {
  const keep = openIds ? [...folded].filter(id => openIds.includes(id)) : [...folded];
  try {
    store?.setItem(foldKey, JSON.stringify(keep));
  } catch {
    // 저장소를 못 쓰는 창(사생활 보호 등)에서는 이번 화면에서만 접는다.
  }
}
