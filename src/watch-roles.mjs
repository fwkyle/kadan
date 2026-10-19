// 감시 한 바퀴에서 역할 화면 읽기·전달된 화면 흡수 (HW-3-impl: watch-runner.mjs에서 옮김)
import { taskIdentity, taskConnectionError } from "./task-identity.mjs";
import { findDoneMarkers, diffDoneMarkers } from "./done-marker.mjs";
import { createHash } from "node:crypto";
import { hookDoneSince } from "./stop-hook-spool.mjs";
import { ledgerHome } from "./ledger.mjs";

export function shortDigest(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

// 변화 판단(정체·시작보고누락·완료 유지) 전용 지문. 경과 시계·토큰 수 같은 숫자와 회전 표시만
// 바뀐 화면은 같은 화면으로 본다(2026-10-17 codex 0.163 `Reconnecting... (14h 04m 30s)` 14시간 방치 사고).
// DONE 마커·끊김 낱말·terminal429·AI에게 넘기는 화면·기록에는 원래 화면을 쓴다. 여기에 쓰지 않는다.
export function normalizeForChange(text) {
  return text.replace(/\d+/gu, "#").replace(/[\u2800-\u28ff◐◑◒◓]/gu, "*");
}

export function changeDigest(text) {
  return shortDigest(normalizeForChange(text));
}

export function readText(value) {
  if (typeof value === "string") return value;
  return typeof value?.text === "string" ? value.text : null;
}

function latestStarts(entries) {
  const starts = new Map();
  for (const entry of entries) {
    if (
      entry?.kind === "start" &&
      typeof entry.session === "string" &&
      entry.session.startsWith("kadan-")
    ) {
      starts.set(entry.session, entry);
    }
  }
  return starts;
}

function startTimeMs(entry) {
  const at = Date.parse(entry?.t);
  return Number.isFinite(at) ? at : 0;
}

// hookHome: Stop 훅 증거(spool) 폴더. 기본은 원장 홈이다(시험은 가짜 홈을 넘긴다).
export function collectRoles(selectedFloor, entries, monitoredSessions = null, cards = null, { hookHome = null } = {}) {
  const liveItems = selectedFloor.list();
  const liveBySession = new Map(
    liveItems
      .filter((item) => item.alive !== false)
      .map((item) => [item.session, item])
  );
  const starts = latestStarts(entries);
  const identity = taskIdentity(cards ?? []);
  const taskKey = (id, key) => {
    const found = identity.resolve(id, key);
    if (found.state === 'resolved') return found.key;
    if (cards == null) return key || id;
    return found.state === 'unregistered' ? id : null;
  };
  // 6줄 제한을 없애되, 현재 세대에 실제 발령한 카드와 발령 전 화면을 함께 대조한다.
  const dispatches = new Map(), generations = new Map();
  for (const entry of entries) {
    if (entry?.kind === 'start') {
      const previous = generations.get(entry.session);
      const pid = entry.panePid ?? entry.rottiePid;
      // start는 살아 있는 세션을 다시 열 때도 기록된다. 창의 reused 값과 프로세스 세대는 별개다.
      const reused = previous && pid != null && String(pid).trim() !== '' &&
        String(pid) === String(previous.panePid ?? previous.rottiePid) && previous.role === entry.role &&
        (previous.floor ?? 'tmux') === (entry.floor ?? 'tmux') &&
        (entry.floor !== 'rottie' || previous.rottieTerminalId === entry.rottieTerminalId);
      if (!reused) {
        generations.set(entry.session, entry);
        // restart(같은 대화를 다시 연 새 프로세스)는 같은 정체라 발령한 카드를 이어받는다. 그 밖의 새 세대는 비운다.
        if (!(entry.restartOf && dispatches.has(entry.session))) dispatches.set(entry.session, new Map());
      }
      continue;
    }
    if (entry?.kind === 'stop') {
      generations.delete(entry.session);
      // 종료된 선임도 확정 인계할 수 있다. 발령은 인계에만 남기고 다음 start에서는 비운다.
      continue;
    }
    // 확정된 결과와 같은 훅·화면 마커는 아래에서 뺀다. 옛 훅이 새 카드의 멈춤·정체를
    // 막지 않게 하되, 원장과 결과가 다른 마커는 감독이 확인할 완료후보로 남긴다.
    if (entry?.kind === 'done' && entry.role && !taskConnectionError(entry)) {
      const key = taskKey(entry.taskId, entry.executionKey);
      const pending = dispatches.get(`kadan-${entry.role}`), sent = pending?.get(key);
      if (sent && Date.parse(entry.t) >= Date.parse(sent.t)) {
        pending.set(key, {...sent, confirmedResult: entry.result});
      }
      continue;
    }
    if (entry?.kind === 'handover' && entry.phase === 'transferred') {
      const from = `kadan-${entry.from}`, to = `kadan-${entry.to}`;
      const source = dispatches.get(from), target = dispatches.get(to);
      if (from === to || !source || !target || !generations.has(to)) continue;
      for (const id of entry.taskIds ?? []) {
        const key = taskKey(id), sent = source.get(key);
        if (!key || !sent) continue;
        target.set(key, {...sent, role:entry.to, session:to, handoverId:entry.handoverId, handoverAt:entry.t});
        source.delete(key);
      }
      continue;
    }
    if (entry?.kind !== 'send' || !entry.taskId || entry.transport === 'mailbox' || entry.notificationOnly || taskConnectionError(entry)) continue;
    const key = taskKey(entry.taskId, entry.executionKey);
    if (key && entry.role === generations.get(entry.session)?.role) dispatches.get(entry.session)?.set(key, entry);
  }
  const observations = new Map();
  const screenAlerts = [];
  for (const [session, start] of starts) {
    const monitored =
      monitoredSessions == null || monitoredSessions.has(session);
    const live = liveBySession.get(session);
    const role = start.role ?? session.slice("kadan-".length);
    const expectedPid = start.panePid ?? start.rottiePid ?? null;
    let screen = null;
    let screenError = null;
    // 카드가 없는 세션도 화면은 읽는다 — 큐에 쌓인 입력은 발령과 무관하게 생긴다.
    // 다만 화면 읽기 실패 경보의 표면은 그대로 두어 감시 대상에만 올린다.
    if (live) {
      try {
        screen = readText(selectedFloor.read(session));
        if (screen == null) throw new Error("빈 응답");
      } catch (error) {
        screenError = error.message;
        if (monitored && !/감독$/u.test(role)) {
          screenAlerts.push({
            id: `screen-read:${session}`,
            kind: "모름",
            level: "AMBER",
            role,
            session,
            screenError,
          });
        }
      }
    }
    const completionDispatches = dispatches.get(session) ?? new Map();
    const markers = findDoneMarkers(screen ?? ''), fresh = new Set();
    for (const [key, dispatch] of completionDispatches) {
      const newer = diffDoneMarkers(dispatch.baselineMarkers ?? [], markers,
        marker => JSON.stringify([taskKey(marker.taskId), marker.result]));
      for (const marker of newer) {
        if (taskKey(marker.taskId) === key && marker.result !== dispatch.confirmedResult) fresh.add(marker);
      }
    }
    // 중앙 카드 조회를 쓰지 않는 기존 호출은 발령 없는 화면 후보도 보고한다.
    // 실제 CLI는 카드 목록(빈 목록 포함)을 넘기므로 등록 카드 감시는 위 대조를 반드시 거친다.
    // 빠른 길: 실행기가 턴을 마칠 때 훅이 남긴 증거가 발령 뒤에 있으면 화면 대신 그것을 쓴다. 없으면 화면 판정이다.
    // 증거는 같은 역할(훅이 보는 KADAN_ROLE = 세션 이름에서 kadan- 뗀 것)·같은 카드·그 발령(send) 뒤 시각이어야 한다.
    let hookMarker = null;
    for (const [key, dispatch] of completionDispatches) {
      const found = hookDoneSince({ home: hookHome ?? ledgerHome(), role: session.slice("kadan-".length), since: dispatch.t,
        taskMatches: id => taskKey(id) === key }).at(-1);
      if (found && found.result !== dispatch.confirmedResult &&
          (!hookMarker || Date.parse(found.at) > Date.parse(hookMarker.at))) hookMarker = found;
    }
    const screenMarker = cards == null && completionDispatches.size === 0
      ? markers.at(-1) : markers.findLast(marker => fresh.has(marker));
    const doneMarker = hookMarker ? { taskId: hookMarker.taskId, result: hookMarker.result } : screenMarker;
    observations.set(session, {
      role,
      alive: Boolean(live),
      pid: live?.pid ?? null,
      expectedPid,
      harness: start.harness ?? null,
      digest: screen == null ? null : changeDigest(screen),
      screen,
      screenError,
      startedAt: generations.get(session)?.t ?? start.t,
      doneMarker: doneMarker ?? null,
      doneSource: doneMarker ? (hookMarker ? "hook" : "screen") : null,
      completionDispatches,
    });
  }
  const liveSessions = new Set(
    [...starts.entries()]
      .sort((left, right) => startTimeMs(right[1]) - startTimeMs(left[1]))
      .filter(([session]) => liveBySession.has(session))
      .map(([session]) => session)
  );
  return { observations, liveSessions, screenAlerts };
}

export function absorbDeliveredScreens(floor, roleStates, deliveredRecipients) {
  const screenAlerts = [];
  for (const recipient of deliveredRecipients) {
    const session = `kadan-${recipient}`;
    const state = roleStates.get(session);
    if (state?.alive) {
      try {
        const screen = readText(floor.read(session));
        if (screen == null) throw new Error("빈 응답");
        roleStates.set(session, {
          ...state,
          digest: changeDigest(screen),
          screenError: null,
        });
      } catch (error) {
        roleStates.set(session, {
          ...state,
          digest: null,
          screenError: error.message,
        });
        if (!/감독$/u.test(state.role)) {
          screenAlerts.push({
            id: `screen-read:${session}`,
            kind: "모름",
            level: "AMBER",
            role: state.role,
            session,
            screenError: error.message,
          });
        }
      }
    }
  }
  return { states: roleStates, screenAlerts };
}
