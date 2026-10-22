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
// 시니어는 대체 후보가 아니라 등록 목록(최대 2명)이 roles.senior에 있다. 같은 목록 조작 칸을 쓰되 읽는 곳만 다르다.
export const listOf = (settings: Part, role: string): unknown[] => {
  const preset = settings.presets[settings.activePreset];
  if (role === "senior") {
    const value = preset?.roles.senior;
    return Array.isArray(value) ? value : value ? [value] : [];
  }
  return preset?.fallback?.[role] ?? [];
};
export const ownPart = (settings: Part, role: string, fallback: boolean) => {
  const preset = settings.presets[settings.activePreset];
  return JSON.stringify(
    fallback ? listOf(settings, role) : (preset?.roles[role] ?? null),
  );
};

// 늘 보이는 요약표·접힌 칸 제목에 쓰는, 역할별 저장된 대체 후보 목록(순서대로 "실행기 / 모델 / 강도").
export const fallbackLabels = (settings: Part, role: string) =>
  listOf(settings, role).map((c) => {
    const { runner, model, effort } = c as {
      runner?: string;
      model?: string;
      effort?: string;
    };
    return [runner, model, effort].filter(Boolean).join(" / ");
  });
