async function body<T>(response: Response): Promise<T> {
  if (!response.ok)
    throw new Error(
      (await response.text()).slice(0, 600) || `조회 실패 (${response.status})`,
    );
  return response.json() as Promise<T>;
}

export async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  return body<T>(await fetch(url, {credentials: "same-origin", cache: "no-store", signal}));
}

// Resource 하나에 응답 하나만 보관한다. Map을 따로 쌓지 않고 같은 data 객체를 재사용한다.
export function createJsonLoader<T>(url: string, request: typeof fetch = fetch) {
  let cached: {etag: string; value: T} | null = null;
  let generation = 0;
  return async (signal: AbortSignal, force = false): Promise<T> => {
    const current = ++generation;
    const previous = cached;
    const target = url + (force ? (url.includes("?") ? "&" : "?") + "fresh=1" : "");
    const response = await request(target, {
      credentials: "same-origin", cache: "no-store", signal,
      ...(!force && previous ? {headers: {"If-None-Match": previous.etag}} : {}),
    });
    if (response.status === 304) {
      if (!previous || force) throw new Error("비교할 이전 자료 없이 변경 없음 응답을 받았습니다.");
      return previous.value;
    }
    const value = await body<T>(response);
    // 중단된 옛 요청이 나중에 끝나도 다음 조회의 ETag/자료를 덮지 않는다.
    if (current === generation && !signal.aborted) {
      const etag = response.headers.get("etag");
      cached = etag ? {etag, value} : null;
    }
    return value;
  };
}
