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

// 같은 탭에서 이 시간 안에 이미 한 번 새로 읽었으면 다시 하지 않는다(무한 반복 방지).
export const RELOAD_WINDOW_MS = 30_000;
export const RELOAD_MARK_KEY = "kadan-chunk-reload-at";

export type MarkStore = { get(): string | null; set(value: string): void };

export function isChunkLoadError(message: string | null | undefined): boolean {
  return typeof message === "string" && CHUNK_ERROR.test(message);
}

// 마지막 자동 새로 읽기 표시(저장된 글자)가 상한 안이면 false. 표시가 없거나 읽을 수 없는 값이면 true.
// 표시 시각이 지금보다 미래(시계 어긋남)면 상한 안으로 봐 false — 반복 쪽으로 기울지 않는다.
export function reloadAllowed(now: number, mark: string | null): boolean {
  if (mark === null) return true;
  const at = Number(mark);
  if (!Number.isFinite(at)) return true;
  return now - at >= RELOAD_WINDOW_MS;
}

// 조각 못 읽음이고 상한을 지났으면 표시를 먼저 남긴 뒤 새로 읽는다. 새로 읽었으면 true.
// 저장소를 읽거나 쓰지 못하면 새로 읽지 않는다: 표시를 못 남기면 새로 읽은 뒤에도 같은 오류가 무한 반복될 수 있다.
export function autoReloadOnChunkError(
  message: string | null | undefined,
  store: MarkStore,
  now: number,
  reload: () => void,
): boolean {
  if (!isChunkLoadError(message)) return false;
  try {
    if (!reloadAllowed(now, store.get())) return false;
    store.set(String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

// 실제 화면용 저장소: 탭 단위(sessionStorage). 접근 자체가 막혀 있으면 던지므로 호출 쪽 try/catch가 받는다.
export const tabMarkStore: MarkStore = {
  get: () => sessionStorage.getItem(RELOAD_MARK_KEY),
  set: (value) => sessionStorage.setItem(RELOAD_MARK_KEY, value),
};

export function autoReloadChunkError(message: string | null | undefined): boolean {
  return autoReloadOnChunkError(message, tabMarkStore, Date.now(), () => location.reload());
}
