// Why: 조용한 세션의 같은 화면을 매 주기 외부 명령으로 다시 읽는 비용을 줄인다.
// 10배 이력에서도 현재 살아 있는 세션과 4MiB 화면만 보관한다. 판정은 매 주기 계속한다.
export function createWatchScreenCache({now = Date.now, refreshMs = 120_000,
  maxBytes = 4 * 1024 * 1024} = {}) {
  const screens = new Map();
  let bytes = 0, reads = 0, hits = 0;
  const remove = session => {
    const old = screens.get(session);
    if (old) { bytes -= old.bytes; screens.delete(session); }
  };
  return {
    retain(sessions) {
      for (const session of screens.keys()) if (!sessions.has(session)) remove(session);
    },
    read(session, live, read) {
      const version = live?.screenVersion;
      if (!version) { remove(session); reads++; return read(); }
      const at = now(), old = screens.get(session);
      // tmux 활동 시각은 초 단위다. 읽은 초와 같은 초의 후속 출력을 놓치지 않게
      // 활동이 이전 초에 끝났던 화면만 재사용한다. 버전 없는 바닥은 매번 읽는다.
      if (old && old.pid === live.pid && old.signature === version.signature &&
          version.activity < Math.floor(old.at / 1000) && at >= old.at && at - old.at < refreshMs) {
        hits++; return old.value;
      }
      remove(session);
      reads++;
      const value = read(); // 실패한 읽기는 보관하지 않는다.
      if (typeof value !== 'string' || !value) return value;
      const size = Buffer.byteLength(value);
      if (size <= maxBytes) {
        screens.set(session, {pid: live.pid, signature: version.signature, at, value, bytes: size});
        bytes += size;
        while (bytes > maxBytes) remove(screens.keys().next().value);
      }
      return value;
    },
    info: () => ({entries: screens.size, bytes, reads, hits}),
  };
}
