import { useSyncExternalStore } from "react";
import { Resource, type ResourceOptions } from "./resource-core.ts";
import { writeAllowed } from "./write-policy.ts";
import { createJsonLoader } from "./resource-http.ts";
export { json } from "./resource-http.ts";

const resources = new Map<string, Resource<unknown>>();
const api = "/api/dashboard/";
document.addEventListener("visibilitychange", () => {
  for (const resource of resources.values())
    resource.setVisible(!document.hidden);
});
export function useResource<T>(path: string, options: ResourceOptions = {}) {
  const url = path.startsWith("/") ? path : api + path;
  let resource = resources.get(url) as Resource<T> | undefined;
  if (!resource) {
    resource = new Resource<T>(
      createJsonLoader<T>(url),
      { pollMs: 15_000, staleMs: 5000, ...options },
    );
    resource.setVisible(!document.hidden);
    resources.set(url, resource as Resource<unknown>);
    if (resources.size > 64)
      for (const [key, old] of resources) {
        if (!old.subscribed && key !== url) {
          resources.delete(key);
          if (resources.size <= 64) break;
        }
      }
  }
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
  );
  return { ...snapshot, refresh: resource.refresh };
}
export function invalidateResources() {
  for (const resource of resources.values()) resource.invalidate();
}
export type SaveResult = {
  location: string;
  result: {
    key?: string;
    revision?: number;
    warnings?: string[];
    delivery?: { status: string; error?: string; role?: string };
    to?: string; // 질문을 받은 역할(/ask)
    mailId?: string | null;
    output?: string; // CLI 출력 요약(/roles/restart — 새 pane PID·대화 id·창)
    pending?: boolean; // /roles/restart — 화면 응답 상한(28초)을 넘겨 자식이 계속 진행 중
    filename?: string; // /runners/preset-export — 내려받을 파일 이름과 글
    text?: string;
    imported?: string; // /runners/preset-import — 가져온 프리셋 이름과 다음 안내
    next?: string;
  };
};
// 원격 보기(session의 readOnly:true)에서는 쓰기 전송을 아예 보내지 않는다. 서버도 405로 막지만 화면이 먼저 멈춘다.
let readOnly = false;
export const setReadOnly = (value: boolean) => {
  readOnly = value;
};

export async function save(
  action: string,
  fields: Record<string, string>,
  token: string,
): Promise<SaveResult> {
  if (!writeAllowed(action, token, readOnly))
    throw new Error("원격 보기에서는 저장할 수 없습니다.");
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(action, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({ ...fields, token }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // 원격 로그인 갱신으로 결정 token이 바뀌었을 수 있다. 다음 시도 전에 session을 새로 읽는다.
      if (response.status === 403) invalidateResources();
      throw new Error(
        (await response.text()).slice(0, 1000) ||
          `저장 실패 (${response.status})`,
      );
    }
    const result = (await response.json()) as SaveResult;
    invalidateResources();
    return result;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        "저장 결과를 확인하지 못했습니다. 내용은 유지했습니다. 최신 기록을 확인한 뒤 다시 시도하세요.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
