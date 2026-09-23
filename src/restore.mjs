// 로티 데몬을 다시 켜면 tmux 세션(에이전트)은 살고 그 세션을 보여 주던 로티 탭만 죽는다.
// 기록된 로티 탭이 죽은 세션에만 새 탭을 붙인다 (2026-09-23 [kyle] 결정: 연결 수가 아니라 탭 상태로 판단).
const ALIVE_STATES = new Set(["running", "created"]);

// 세션이 지금 쓰는 로티 탭. 마지막 start에 탭이 있어야 로티 창 세션이고, 그 뒤 restore가 남긴
// window 기록이 탭 번호를 갈아 끼운다. 마지막 start에 탭이 없으면 숨김이거나 로티 밖에서 띄운 세션이다.
export function currentRottieWindow(entries, session) {
  let window = null;
  for (const entry of entries ?? []) {
    if (entry?.session !== session) continue;
    if (entry.kind === "start") {
      window = entry.rottieTerminalId
        ? { role: entry.role, cwd: entry.cwd, rottieTerminalId: entry.rottieTerminalId }
        : null;
    } else if (entry.kind === "window" && window && entry.rottieTerminalId) {
      window = { ...window, rottieTerminalId: entry.rottieTerminalId };
    }
  }
  return window;
}

// 복구 대상을 고른다. 탭 조회가 하나라도 실패하면 아무것도 고르지 않는다(모르면 판단하지 않는다).
export function planRestore({ sessions, entries, only = null, show }) {
  const items = [];
  const alive = new Set(sessions.map((item) => item.session));
  for (const wanted of only ?? []) {
    if (!alive.has(wanted)) items.push({ session: wanted, action: "skip", reason: "세션 없음" });
  }
  for (const item of sessions) {
    if (only && !only.includes(item.session)) continue;
    const window = currentRottieWindow(entries, item.session);
    if (!window) {
      items.push({ session: item.session, action: "skip", reason: "로티 창 기록 없음" });
      continue;
    }
    const shown = show(window.rottieTerminalId);
    const gone = !shown.ok && shown.code === "ROTTIE_TERMINAL_NOT_FOUND";
    if (!shown.ok && !gone) {
      return { error: `탭 ${window.rottieTerminalId}(${item.session}) 상태 조회 실패: ${shown.code}` };
    }
    const state = gone ? "없음" : shown.state;
    const base = {
      session: item.session,
      role: window.role ?? item.session.replace(/^kadan-/, ""),
      cwd: window.cwd,
      pid: item.pid,
      oldTerminalId: window.rottieTerminalId,
      oldState: state,
    };
    items.push(
      !gone && ALIVE_STATES.has(state)
        ? { ...base, action: "skip", reason: `탭 살아 있음(${state})` }
        : { ...base, action: "restore" }
    );
  }
  return { items };
}

// 고른 세션마다 새 탭을 붙이고, 원장에는 start가 아니라 window 기록만 남긴다 — start를 새로 쓰면
// 모델 표시·감시 기준이 재시작처럼 흔들린다. 죽은 옛 탭은 한 번 지워 보고 실패는 알리기만 한다.
export function runRestore({ items, open, remove, record, print, now = Date.now }) {
  let failed = 0;
  for (const item of items) {
    if (item.action !== "restore") {
      print(`건너뜀: ${item.session} — ${item.reason}`);
      continue;
    }
    const window = open({ ...item, idempotencyKey: `kadan-${item.session}-${item.pid}-restore-${now()}` });
    if (!window?.rottieTerminalId) {
      failed += 1;
      print(`복구 실패: ${item.session} — 새 탭을 붙이지 못했다`);
      continue;
    }
    record({
      kind: "window",
      role: item.role,
      session: item.session,
      rottieTerminalId: window.rottieTerminalId,
      restoredFrom: item.oldTerminalId,
      oldState: item.oldState,
      ...(item.pid ? { panePid: item.pid } : {}),
    });
    print(`복구: ${item.session} (옛 탭 ${item.oldTerminalId} ${item.oldState} → 새 탭 ${window.rottieTerminalId})`);
    if (item.oldState === "없음") continue;
    const removal = remove(item.oldTerminalId);
    if (!removal.removed) print(`  옛 탭 제거 실패: ${removal.code} — 목록에 '종료됨'으로 남는다`);
  }
  return { failed };
}
