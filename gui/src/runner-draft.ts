// 실행 모델 바꾸기 칸이 실제로 고치는 부분만 꺼낸다.
// 설정 버전은 모델 목록·다른 역할·즐겨찾기만 바뀌어도 오른다. 이 부분이 그대로면 작성 중인 칸이
// 새 버전으로 이어서 저장해도 남의 변경을 덮지 않는다(2026-09-29 [kyle]: AI가 모델 목록을 넣은 뒤 저장이 조용히 거부됐다).
type Part = {
  activePreset: string;
  presets: Record<
    string,
    { roles: Record<string, unknown>; fallback?: Record<string, unknown[]> }
  >;
};
export const ownPart = (settings: Part, role: string, fallback: boolean) => {
  const preset = settings.presets[settings.activePreset];
  return JSON.stringify(
    fallback ? (preset?.fallback?.[role] ?? []) : (preset?.roles[role] ?? null),
  );
};
