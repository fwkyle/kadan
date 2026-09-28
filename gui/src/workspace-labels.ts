// 업무 표와 실행 표가 같은 열을 쓰되, 업무 표에서는 업무 수준과 실행 수준이 구분되게 이름을 바꾼다.
const workLabels: Record<string, string> = { healthLabel: "안쪽 실행 상황" };

export function columnLabel(key: string, label: string, collection: string): string {
  return collection === "work" ? workLabels[key] || label : label;
}

// 업무와 실행 탭 아래에 두 숫자의 관계를 한 줄로 알려 준다. 실행 수에는 업무 미연결 실행도 들어 있다.
export function collectionHint(counts?: { work: number | null; executions: number; unlinked: number }): string {
  if (!counts) return "업무 하나에 실행 여러 건이 들어갑니다.";
  const inside = Math.max(0, counts.executions - counts.unlinked);
  return `업무 하나에 실행 여러 건이 들어갑니다 · 실행 ${counts.executions}건 중 ${inside}건은 업무 안, ${counts.unlinked}건은 업무 미연결`;
}

// '닫을 실행 카드'는 실행 기준 숫자라 업무 표 아래에는 두지 않는다.
export function showDoneButOpen(collection: string, count: number): boolean {
  return collection !== "work" && count > 0;
}
