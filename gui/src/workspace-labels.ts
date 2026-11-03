// 워크 표와 카드 표가 같은 열을 쓰되, 워크 표에서는 워크 수준과 카드 수준이 구분되게 이름을 바꾼다.
const workLabels: Record<string, string> = { title: "워크 · 목적", healthLabel: "안쪽 카드 상황" };

export function columnLabel(key: string, label: string, collection: string): string {
  return collection === "work" ? workLabels[key] || label : label;
}

// 카드와 워크 탭 옆에 두 숫자의 관계를 한 줄로 알려 준다. 카드 수에는 워크 미연결 카드도 들어 있다.
export function collectionHint(counts?: { work: number | null; executions: number; unlinked: number }): string {
  if (!counts) return "워크 하나에 카드 여러 장이 들어갑니다.";
  const inside = Math.max(0, counts.executions - counts.unlinked);
  return `워크 하나에 카드 여러 장이 들어갑니다 · 카드 ${counts.executions}장 중 ${inside}장은 워크 안, ${counts.unlinked}장은 워크 미연결`;
}

// '닫을 카드'는 카드 기준 숫자라 워크 표 아래에는 두지 않는다.
export function showDoneButOpen(collection: string, count: number): boolean {
  return collection !== "work" && count > 0;
}

// 워크·카드 화면 주소 조각. 버튼이 이 함수를 그대로 쓰므로 시험이 버튼 경로를 직접 확인한다(PR2 검수 F1).
// 작업 종류 전환은 거르기 조건은 비우되 사이드 탭이 고른 저장소(repo)는 건드리지 않는다.
export function collectionSwitchPatch(key: string): Record<string, string | null> {
  return { collection: key, card: null, detail: "0", q: null, board: null, state: null };
}
// '필터 초기화'는 사용자가 일부러 모두 푸는 버튼이라 저장소(repo)도 함께 푼다.
export function filterResetPatch(): Record<string, string | null> {
  return { q: null, repo: null, board: null, health: null, rally: null, state: null };
}
