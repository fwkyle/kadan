// 응답 개수뿐 아니라 UTF-8 본문 총 바이트도 제한한다. 로컬/원격 캐시 키는 호출자가 분리한다.
export function createResponseCache({maxEntries = 50, maxBytes = 4 * 1024 * 1024} = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = key => {
    const old = entries.get(key);
    if (old) { bytes -= old.bytes; entries.delete(key); }
  };
  return {
    get: key => entries.get(key)?.value,
    delete: remove,
    clear() { entries.clear(); bytes = 0; },
    set(key, value) {
      remove(key);
      const size = Buffer.byteLength(value.body);
      if (size > maxBytes) return;
      entries.set(key, {value, bytes: size}); bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
    },
    info: () => ({entries: entries.size, bytes}),
  };
}
