import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
let accepted = location.href,
  index = Number(history.state?.kadanIndex) || 0,
  restoring = false;
history.replaceState(
  { ...history.state, kadanIndex: index },
  "",
  location.href,
);
window.addEventListener("popstate", (event) => {
  if (restoring) {
    restoring = false;
    return;
  }
  const nextIndex = Number(event.state?.kadanIndex);
  if (!mayLeave()) {
    if (Number.isFinite(nextIndex) && nextIndex !== index) {
      restoring = true;
      history.go(index - nextIndex);
    } else
      history.replaceState(
        { ...history.state, kadanIndex: index },
        "",
        accepted,
      );
    return;
  }
  index = Number.isFinite(nextIndex) ? nextIndex : index;
  accepted = location.href;
  notify();
});
export function useLocation() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => location.href,
  );
}
let mayLeave: () => boolean = () => true;
export function setNavigationGuard(guard: () => boolean) {
  mayLeave = guard;
}
export function navigate(
  to: string | URL,
  replace = false,
  bypassGuard = false,
) {
  const url = new URL(to, location.href);
  if (url.origin !== location.origin || url.pathname !== "/") return false;
  if (!bypassGuard && !mayLeave()) return false;
  if (!replace) index++;
  // 다른 화면으로 옮길 때만 본문이 살짝 겹쳐 넘어간다(2026-10-07 모션). 같은 화면의 필터·페이지 변경은 그대로.
  const changesView = new URL(accepted).hash !== url.hash;
  history[replace ? "replaceState" : "pushState"](
    { ...history.state, kadanIndex: index },
    "",
    url,
  );
  accepted = location.href;
  const doc = typeof document === "undefined" ? null : document as Document & { startViewTransition?: (update: () => void) => unknown };
  if (changesView && doc?.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches)
    doc.startViewTransition(() => flushSync(notify));
  else notify();
  return true;
}
export function patchLocation(
  patch: Record<string, string | null>,
  hash?: string,
  replace = false,
) {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  if (hash) url.hash = hash;
  return navigate(url, replace);
}
export function cardUrl(key: string) {
  const url = new URL(location.href);
  const executionCollection = viewOf(url) === "dashboard" && url.searchParams.get("collection") === "unlinked"
    ? "unlinked" : "executions";
  url.searchParams.set("card", key);
  url.searchParams.set("detail", "1");
  url.searchParams.set(
    "collection",
    key.startsWith("work:") ? "work" : executionCollection,
  );
  url.hash = "detail";
  return url.pathname + url.search + url.hash;
}
export function viewOf(url: URL) {
  const hash = url.hash.slice(1);
  if (hash === "create") return "card-create";
  if (["detail", "cards", "card-list"].includes(hash)) return "dashboard";
  if (["overview", "boards", ""].includes(hash)) return "status";
  if (hash.startsWith("decision-")) return "decisions";
  if (hash.startsWith("status-")) return "status";
  // 담당자 상태는 실행 모델 화면 안의 절이 됐다(2026-10-05). 옛 주소는 그 절로 온다.
  if (hash === "sessions") return "runner-settings";
  return hash;
}
