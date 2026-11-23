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

// 자동 새로 읽기는 "지금 실행 중인 화면 빌드" 하나로 반복을 막는다(2026-11-23 3라운드 [kyle] 결정).
// 이 탭에서 이 빌드로 이미 새로 읽었는데 또 조각 못 읽음이면 서버가 같은 빌드를 주는 것(조각이 정말 없음)이라 멈춘다.
// 새 배포 뒤에는 빌드 표시가 바뀌므로 다시 한 번 복구된다. 오류 문구·조각 주소·화면으로 원인을 나누지 않는다.
export const BUILD_MARK_KEY = "kadan-chunk-reload-build";

export type MarkStore = { get(): string | null; set(value: string): void };

export function isChunkLoadError(message: string | null | undefined): boolean {
  return typeof message === "string" && CHUNK_ERROR.test(message);
}

// 빌드 표시: 이 모듈이 담긴 파일 이름(빌드마다 해시가 바뀌는 `index-XXXX.js`). 파일 이름을 못 읽으면 주소 문자열 그대로를
// 쓴다. 같은 빌드면 어느 경우든 같은 값이다.
export function buildIdOf(moduleUrl: string): string {
  const name = moduleUrl.split(/[?#]/)[0].split("/").pop();
  return name || moduleUrl;
}

// 조각 못 읽음이고 저장된 표시가 지금 빌드 표시와 다르면(없음·다른 빌드·손상·남이 쓴 값 포함) 지금 표시를 먼저 저장한 뒤
// 새로 읽는다. 다른 모양의 값은 "다름"으로 봐 최대 한 번만 새로 읽고 곧 지금 표시로 덮이므로 반복이 아니다.
// 저장소를 읽거나 쓰지 못하면 새로 읽지 않는다: 표시를 못 남기면 새로 읽은 뒤에도 같은 오류가 반복될 수 있다.
export function autoReloadOnChunkError(
  message: string | null | undefined,
  store: MarkStore,
  reload: () => void,
  build: string,
): boolean {
  if (typeof message !== "string" || !isChunkLoadError(message)) return false;
  try {
    if (store.get() === build) return false;
    store.set(build);
  } catch {
    return false;
  }
  reload();
  return true;
}

// 실제 화면용 저장소: 탭 단위(sessionStorage). 접근 자체가 막혀 있으면 던지므로 호출 쪽 try/catch가 받는다.
export const tabMarkStore: MarkStore = {
  get: () => sessionStorage.getItem(BUILD_MARK_KEY),
  set: (value) => sessionStorage.setItem(BUILD_MARK_KEY, value),
};

export function autoReloadChunkError(message: string | null | undefined): boolean {
  return autoReloadOnChunkError(message, tabMarkStore, () => location.reload(), buildIdOf(import.meta.url));
}
