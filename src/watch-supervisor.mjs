import { workEntries } from "./handover-state.mjs";
import { isDescendant } from "./hierarchy.mjs";
import { boardFromRole, supervisorForBoard } from "./board.mjs";

function startedAtMs(state) {
  const at = Date.parse(state?.startedAt);
  return Number.isFinite(at) ? at : 0;
}

// 감독 멈춤은 두 단계다(2026-10-05 [kyle] 결정): idleMs 동안 멈추면 본인에게(1단), 그 두 배가 되면 상위에게(2단).
// 두 단계는 다른 id라 1단은 2단이 뜨면 조용히 닫히고, 상위는 2단에서 처음 받는다. 움직이면 둘 다 닫힌다.
function idleAlert(baseId, role, session, openCards, idleFor, idleMs) {
  const stage = idleFor >= idleMs * 2 ? 2 : 1;
  return { id: stage === 2 ? `${baseId}:상위` : baseId, kind: "놀고 있음", level: "AMBER", role, session,
    openCards, idleMinutes: Math.floor(idleFor / 60_000), stage };
}

// 실행이 다 끝났거나 아직 없는 열린 워크는 책임 감독의 할 일이다(2026-10-05 [kyle]: "매번 내가 말해 줘야 다음 걸 한다").
// 진행 중 실행 = 카드가 assigned·hold인 것. draft·ready는 아직 발령 전이라 할 일로 본다.
export function idleWorkEntries(works, cards, parents) {
  const byKey = new Map((cards ?? []).map(c => [c.key, c]));
  return (works ?? []).filter(w => w?.status === "open" && parents.has(w.owner)
      && !(w.executions ?? []).some(x => ["assigned", "hold"].includes(byKey.get(x.key)?.status)))
    .map(w => ({ kind: "send", role: w.owner, taskId: `work:${w.key}`, t: w.at }));
}

export function assessSupervisorIdle(
  entries,
  roleStates,
  now,
  idleMs,
  ledgerError = null,
  parents = new Map(),
  { works = [], cards = [] } = {}
) {
  if (ledgerError) {
    return [
      {
        id: "ledger:unreadable",
        kind: "모름",
        level: "AMBER",
        ledgerError: ledgerError.message,
      },
    ];
  }

  entries = workEntries(entries);
  // 명시한 역할은 이름 기반의 옛 판정과 중복하지 않는다.
  const mappedBoards = new Set([...parents.keys()].map(boardFromRole).filter(Boolean));
  const mappedTasks = new Set(entries.filter(entry => parents.has(entry?.role) && entry.taskId).map(entry => entry.taskId));
  const legacyEntries = entries.filter(entry => !parents.has(entry?.role) &&
    !(entry?.kind === "plan" && (mappedBoards.has(entry.board) || mappedTasks.has(entry.taskId))));
  const completed = new Set();
  for (const entry of legacyEntries) {
    const board = boardFromRole(entry?.role);
    if (entry?.kind === "done" && board && entry.taskId) {
      completed.add(`${board}\0${entry.taskId}`);
    }
  }

  const openByBoard = new Map();
  for (const entry of legacyEntries) {
    const board = entry?.kind === "plan" ? entry.board : boardFromRole(entry?.role);
    const at = Date.parse(entry?.t);
    if (!board || !Number.isFinite(at)) continue;
    if (
      (entry.kind === "plan" || entry.kind === "send") &&
      entry.taskId &&
      !completed.has(`${board}\0${entry.taskId}`)
    ) {
      const cards = openByBoard.get(board) ?? new Map();
      const previous = cards.get(entry.taskId);
      cards.set(entry.taskId, previous == null ? at : Math.min(previous, at));
      openByBoard.set(board, cards);
    }
  }

  const alerts = [];
  const liveSessions = [...roleStates.entries()]
    .filter(([, state]) => state?.alive)
    .sort((left, right) => startedAtMs(right[1]) - startedAtMs(left[1]))
    .map(([session]) => session);
  for (const [board, cards] of openByBoard) {
    const role = supervisorForBoard(board, liveSessions) ?? `${board}-감독`;
    const session = `kadan-${role}`;
    const state = roleStates.get(session);
    if (state?.deathActive) continue;
    if (!state?.alive || state.digest == null) {
      alerts.push({
        id: `idle:screen:${board}`,
        kind: "모름",
        level: "AMBER",
        role,
        session,
        openCards: cards.size,
        screenError: state?.screenError ?? "화면 없음",
      });
      continue;
    }
    const openedAt = Math.min(...cards.values());
    const idleFor = Math.min(now - openedAt, state.unchangedMs ?? 0);
    if (idleFor < idleMs) continue;
    alerts.push(idleAlert(`idle:${board}`, role, session, cards.size, idleFor, idleMs));
  }
  alerts.push(...assessHierarchyIdle([...entries, ...idleWorkEntries(works, cards, parents)], roleStates, now, idleMs, parents));
  return alerts;
}

// 1단: 감독 본인에게. 예전 --wake(30분 타이머에 고정 점검 목록)를 대신한다 — 근거(할 일 수·멈춘 시간)가 있는
// 문구만 보내고, 멈추지 않았으면 아무것도 보내지 않는다. 15분 더 멈추면 2단으로 상위에게 간다고 미리 알린다.
export function buildIdleNudge(alert) {
  return `놀고 있음 ${alert.session} (할 일 ${alert.openCards}건, ${alert.idleMinutes}분간 화면 변화 없음) — 판을 확인하고 다음 행동을 정하라. 이대로 ${alert.idleMinutes}분 더 멈추면 상위에게 알린다.`;
}

export function assessHierarchyIdle(entries, states, now, idleMs, parents) {
  const pending = new Map();
  for (const entry of entries) {
    if (!parents.has(entry?.role) || !entry.taskId) continue;
    const key = `${entry.role}\0${entry.taskId}`;
    if (entry.kind === "send") pending.set(key, entry);
    if (entry.kind === "done") pending.delete(key);
  }
  const supervisors = new Set([...parents.values()].filter(role => parents.has(role)));
  // 아직 미발령인 plan은 같은 판의 직속 감독 한 명에게만 귀속한다.
  const assigned = new Set(entries.filter(entry => parents.has(entry?.role) && entry.taskId && entry.kind === "send").map(entry => entry.taskId));
  for (const entry of entries) {
    if (entry?.kind !== "plan" || assigned.has(entry.taskId)) continue;
    const candidates = [...supervisors].filter(role => boardFromRole(role) === entry.board);
    const owners = candidates.filter(role => !candidates.some(other => other !== role && isDescendant(other, role, parents)));
    if (owners.length === 1) pending.set(`plan\0${entry.board}\0${entry.taskId}`, { ...entry, role: owners[0] });
  }
  const alerts = [];
  for (const role of supervisors) {
    const cards = [...pending.values()].filter(entry => isDescendant(entry.role, role, parents));
    if (!cards.length) continue;
    const session = `kadan-${role}`;
    const state = states.get(session);
    if (state?.deathActive) continue;
    if (!state?.alive || state.digest == null) {
      alerts.push({ id: `idle:hierarchy:screen:${role}`, kind: "모름", level: "AMBER",
        role, session, openCards: cards.length, screenError: state?.screenError ?? "화면 없음" });
      continue;
    }
    // 하위 담당자가 실제로 진행하면 상위의 조용한 대기는 이상이 아니다.
    const active = [state, ...cards.map(entry => states.get(`kadan-${entry.role}`))]
      .filter(item => item?.alive && item.digest != null);
    const openedAt = Math.min(...cards.map(entry => Date.parse(entry.t)).filter(Number.isFinite));
    const idleFor = Math.min(now - openedAt, ...active.map(item => item.unchangedMs ?? 0));
    if (idleFor < idleMs) continue;
    alerts.push(idleAlert(`idle:hierarchy:${role}`, role, session, cards.length, idleFor, idleMs));
  }
  return alerts;
}
