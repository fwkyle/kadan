// 재빌드 뒤 옛 탭의 화면 조각 못 읽음(2026-11-23 [kyle]): 화면 조각 파일 이름은 빌드마다 바뀌어, 그 전에 열어 둔 탭이
// 옛 조각을 부르면 404다. 사람이 오류를 보기 전에 페이지를 한 번 새로 읽는다. 이 모듈은 화면 없이 판단만 한다.

// 조각 못 읽음 문구: 브라우저별 동적 불러오기 실패(크롬·엣지 / 사파리 / 파이어폭스)와 Vite의 조각 스타일 미리 읽기 실패.
const CHUNK_ERROR = new RegExp(
  [
    "Failed to fetch dynamically imported module",
    "Importing a module script failed",
    "error loading dynamically imported module",
    "Unable to preload CSS",
  ].join("|"),
  "i",
);

// 이 탭에서 이미 자동 새로 읽기를 해 본 원인 목록(2026-11-23 검수 수정). 시간이 아니라 원인으로 반복을 막는다:
// 같은 원인(같은 조각 주소)이 새로 읽은 뒤에도 또 나오면 실패 간격이 얼마든 다시 새로 읽지 않는다.
// 원인이 다르면(그 사이 다시 빌드해 생긴 별도 조각) 한 번 더 할 수 있다. 원인마다 한 번이라 반복이 끝없이 이어지지 않는다.
export const TRIED_KEY = "kadan-chunk-reload-tried";
// 한 탭에서 기억할 원인 수 상한. 넘으면 더는 자동으로 새로 읽지 않는다(끝없는 반복 쪽으로 실패하지 않는다).
export const TRIED_MAX = 20;
const CAUSE_MAX = 300;

export type MarkStore = { get(): string | null; set(value: string): void };

export function isChunkLoadError(message: string | null | undefined): boolean {
  return typeof message === "string" && CHUNK_ERROR.test(message);
}

// 원인 이름: 오류 문구(크롬·파이어폭스는 조각 주소가 들어 있다) + 화면 범위. 사파리는 문구에 주소가 없어
// 화면 범위(보던 화면의 주소 해시)로 원인을 나눈다.
export function causeKey(message: string, scope = ""): string {
  return (scope + "|" + message).slice(0, CAUSE_MAX);
}

// 저장된 글자를 원인 목록으로 읽는다. 표시가 없으면 빈 목록, 손상됐으면 null(읽을 수 없음).
export function parseTried(raw: string | null): string[] | null {
  if (raw === null) return [];
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) && list.every((item) => typeof item === "string") ? list : null;
  } catch {
    return null;
  }
}

// 조각 못 읽음이고 이 원인으로 아직 새로 읽은 적이 없으면 원인을 먼저 적은 뒤 새로 읽는다. 새로 읽었으면 true.
// 저장소를 읽거나 쓰지 못하거나 표시가 손상됐으면 새로 읽지 않는다: 표시를 못 남기면 새로 읽은 뒤에도 같은 오류가 반복될 수 있다.
export function autoReloadOnChunkError(
  message: string | null | undefined,
  store: MarkStore,
  reload: () => void,
  scope = "",
): boolean {
  if (typeof message !== "string" || !isChunkLoadError(message)) return false;
  try {
    const tried = parseTried(store.get());
    const key = causeKey(message, scope);
    if (tried === null || tried.length >= TRIED_MAX || tried.includes(key)) return false;
    store.set(JSON.stringify([...tried, key]));
  } catch {
    return false;
  }
  reload();
  return true;
}

// 실제 화면용 저장소: 탭 단위(sessionStorage). 접근 자체가 막혀 있으면 던지므로 호출 쪽 try/catch가 받는다.
export const tabMarkStore: MarkStore = {
  get: () => sessionStorage.getItem(TRIED_KEY),
  set: (value) => sessionStorage.setItem(TRIED_KEY, value),
};

export function autoReloadChunkError(message: string | null | undefined): boolean {
  return autoReloadOnChunkError(message, tabMarkStore, () => location.reload(), location.hash);
}
