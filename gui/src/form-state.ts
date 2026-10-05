// 라디오 선택 표시 규칙. 빈 값("")을 가진 선택지가 초기값("")과 같다는 이유로 미리 선택되던 문제를 막는다(2026-10-05).
// 사용자가 그 라디오를 한 번이라도 고른 뒤에만 빈 값 선택지를 선택된 것으로 그린다. 추천안 미리선택 금지와 같은 뜻이다.
export function radioChecked(
  values: Record<string, string>,
  touched: Record<string, boolean>,
  name: string,
  value: string,
): boolean {
  if ((values[name] ?? "") !== value) return false;
  return value !== "" || touched[name] === true;
}
