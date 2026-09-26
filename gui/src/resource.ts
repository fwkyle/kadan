import { useSyncExternalStore } from "react";
import { Resource, type ResourceOptions } from "./resource-core.ts";

const resources = new Map<string, Resource<unknown>>();
const api = "/api/dashboard/";
export async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new Error(
      (await response.text()).slice(0, 600) || `조회 실패 (${response.status})`,
    );
  return response.json() as Promise<T>;
}
document.addEventListener("visibilitychange", () => {
  for (const resource of resources.values())
    resource.setVisible(!document.hidden);
});
export function useResource<T>(path: string, options: ResourceOptions = {}) {
  const url = path.startsWith("/") ? path : api + path;
  let resource = resources.get(url) as Resource<T> | undefined;
  if (!resource) {
    resource = new Resource<T>(
      (signal, force) =>
        json<T>(
          url + (force ? (url.includes("?") ? "&" : "?") + "fresh=1" : ""),
          signal,
        ),
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
    delivery?: { status: string; error?: string; role?: string };
  };
};
export async function save(
  action: string,
  fields: Record<string, string>,
  token: string,
): Promise<SaveResult> {
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
    if (!response.ok)
      throw new Error(
        (await response.text()).slice(0, 1000) ||
          `저장 실패 (${response.status})`,
      );
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
