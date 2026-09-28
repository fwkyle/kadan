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
