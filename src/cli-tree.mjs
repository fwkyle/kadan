// 역할 트리 만들기·그리기 (HW-3-impl: cli.mjs에서 옮김)
import { taskEventKey, taskConnectionError } from "./task-identity.mjs";
import { workEntries } from "./handover-state.mjs";
import { ledgerBy } from "./ledger.mjs";
import { boardFromRole } from "./board.mjs";
import { recordedPid } from "./cli-basics.mjs";
import { startDisplay } from "./cli-family.mjs";

function roleFromSession(session) {
  return typeof session === "string" && session.startsWith("kadan-")
    ? session.slice("kadan-".length)
    : session;
}

export function cardRound(taskId) {
  const review = /-(review|검수)$/.test(taskId);
  const workId = taskId.replace(/-(review|검수)$/, "");
  const match = workId.match(/-r([1-9]\d*)$/);
  return { family: match ? workId.slice(0, match.index) : workId, round: match ? Number(match[1]) : 1, review };
}

export function renderRound(group) {
  const label = card => card.state === "done" ? card.result : card.state === "planned" ? "발령 전" : "보냄";
  const numbers = [...new Set([...group.workCards, ...group.reviewCards].map(card => card.round))].sort((a, b) => a - b);
  const detail = numbers.map(round => {
    const work = group.workCards.filter(card => card.round === round).map(label).join("/");
    const review = group.reviewCards.filter(card => card.round === round).map(label).join("/");
    return "r" + round + " " + work + (review ? (work ? "·검수 " : "검수 ") + review : "");
  }).join(", ");
  return "라운드 " + group.family + ": " + group.latestRound + "/18 (블록 " + Math.ceil(group.latestRound / 3) + "/6) — " +
    detail + (group.latestRound >= 9 ? " · 정체 확인" : "") + (group.latestRound >= 18 ? " · 상한 — 사용자 결정" : "");
}

export function buildTree(entries, aliveBySession = {}, cards = null) {
  entries = workEntries(entries,cards).filter(e=>e?.transport!=='mailbox');
  const roles = new Map();
  const boards = new Map();
  const planned = new Map();
  const assignedOrDone = new Set();
  for (const entry of entries) {
    const board = entry?.kind === "plan" ? entry.board : boardFromRole(entry?.role);
    if (!board || !entry.taskId) continue;
    const key = `${board}\0${taskEventKey(entry)}`;
    if (entry.kind === "plan") {
      if (!boards.has(board)) boards.set(board, { name: board, roles: [], plannedCards: [], plannedAt: null, about: null, titleById: {} });
      const item = boards.get(board);
      if (entry.t && (!item.plannedAt || entry.t > item.plannedAt)) item.plannedAt = entry.t;
      if (entry.about) item.about = entry.about;
      if (entry.title) item.titleById[entry.taskId] = entry.title;
      if (!planned.has(key)) planned.set(key, { board, taskId: entry.taskId, plannedAt: entry.t, by: ledgerBy(entry), ...(entry.title ? { title: entry.title } : {}) });
    } else if (entry.kind === "send" || entry.kind === "done") {
      assignedOrDone.add(key);
    }
  }
  for (const [key, { board, ...card }] of planned) {
    if (!assignedOrDone.has(key)) boards.get(board).plannedCards.push(card);
  }
  const aliveEntries =
    aliveBySession instanceof Map
      ? [...aliveBySession.entries()]
      : Object.entries(aliveBySession);

  const ensureRole = (role, session) => {
    const key = session || role;
    if (!roles.has(key)) {
      roles.set(key, {
        role,
        session,
        window: null,
        lastStart: null,
        lastStop: null,
        lastActivityAt: null,
        untrackedSends: 0,
        cardsById: new Map(),
      });
    }
    return roles.get(key);
  };

  for (const entry of entries) {
    if (!entry || (!entry.role && !entry.session)) continue;
    const role = entry.role || roleFromSession(entry.session);
    const item = ensureRole(role, entry.session || `kadan-${role}`);
    if (entry.t && (!item.lastActivityAt || entry.t > item.lastActivityAt)) {
      item.lastActivityAt = entry.t;
    }
    if (entry.kind === "start") {
      item.lastStart = entry;
      item.window = entry.window ?? item.window;
    } else if (entry.kind === "stop") {
      item.lastStop = entry;
    } else if (entry.kind === "send") {
      if (!entry.taskId) {
        item.untrackedSends++;
      } else {
        const card = item.cardsById.get(taskEventKey(entry)) || {
          taskId: entry.taskId,
          ...(taskConnectionError(entry)?{connectionError:entry.taskConnection.reason}:{}),
        };
        card.sentAt = entry.t;
        card.by = ledgerBy(entry);
        item.cardsById.set(taskEventKey(entry), card);
      }
    } else if (entry.kind === "done" && entry.taskId) {
      const card = item.cardsById.get(taskEventKey(entry)) || {
        taskId: entry.taskId,
        ...(taskConnectionError(entry)?{connectionError:entry.taskConnection.reason}:{}),
      };
      card.doneAt = entry.t;
      card.result = entry.result;
      item.cardsById.set(taskEventKey(entry), card);
    }
  }

  for (const [session, alive] of aliveEntries) {
    if (!alive || alive.alive === false) continue;
    ensureRole(roleFromSession(session), session);
  }

  for (const item of roles.values()) {
    const alive = aliveBySession instanceof Map
      ? aliveBySession.get(item.session)
      : aliveBySession[item.session];
    const expectedPid = recordedPid(item.lastStart);
    const currentPid = alive?.pid == null ? null : String(alive.pid);
    let life;
    if (alive && alive.alive !== false) {
      life = {
        state: "alive",
        pidState:
          expectedPid != null && String(expectedPid) === currentPid
            ? "match"
            : "changed",
        recordedPid: expectedPid == null ? null : String(expectedPid),
        currentPid,
      };
    } else if (item.lastStop) {
      life = { state: "dead", stoppedAt: item.lastStop.t };
    } else {
      life = item.lastStart
        ? { state: "unknown", startedAt: item.lastStart.t }
        : { state: "unknown" };
    }

    const cards = [...item.cardsById.values()].map((card) =>
      card.connectionError
        ? {taskId:card.taskId,state:'connection-error',connectionError:card.connectionError,at:card.doneAt||card.sentAt,by:card.by??'모름'}
        : card.doneAt
        ? {
            taskId: card.taskId,
            state: "done",
            result: card.result,
            at: card.doneAt,
            by: card.by ?? "모름",
          }
        : {
            taskId: card.taskId,
            state: "sent",
            at: card.sentAt,
            by: card.by ?? "모름",
          }
    );
    const boardName = boardFromRole(item.role) ?? "(없음)";
    if (!boards.has(boardName)) boards.set(boardName, { name: boardName, roles: [], plannedCards: [], plannedAt: null, about: null, titleById: {} });
    boards.get(boardName).roles.push({
      role: item.role,
      session: item.session,
      window: item.window,
      lastActivityAt: item.lastActivityAt,
      untrackedSends: item.untrackedSends,
      life,
      cards,
      ...startDisplay(item.lastStart),
    });
  }
  for (const board of boards.values()) {
    // 발령 뒤에도 제목이 보여야 한다. send 줄에는 제목이 없으므로 plan 줄에서 이어 붙인다.
    // 제목이 없으면 필드 자체를 만들지 않는다 — 옛 원장 줄은 예전 모양 그대로여야 한다.
    // 발령 전 목록은 첫 plan 줄을 쓰므로, 나중에 제목을 다시 적어도 반영되게 같은 표를 태운다.
    for (const cards of [board.plannedCards, ...board.roles.map(role => role.cards)]) {
      for (const card of cards) {
        const title = board.titleById?.[card.taskId];
        if (title) card.title = title;
      }
    }
    const cards = new Map();
    for (const card of [...board.plannedCards.map(card => ({ ...card, state: "planned" })), ...board.roles.flatMap(role => role.cards)]) {
      const previous = cards.get(card.taskId);
      if (!previous || (previous.state !== "done" && card.state !== "planned")) cards.set(card.taskId, card);
    }
    const families = new Map();
    for (const card of cards.values()) {
      const { family, round, review } = cardRound(card.taskId);
      if (!families.has(family)) families.set(family, { family, latestRound: 1, workCards: [], reviewCards: [] });
      const group = families.get(family);
      group.latestRound = Math.max(group.latestRound, round);
      group[review ? "reviewCards" : "workCards"].push({ taskId: card.taskId, round, state: card.state, result: card.result });
    }
    const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    board.rounds = [...families.values()].sort((a, b) => compareId(a.family, b.family));
    for (const group of board.rounds) {
      for (const cards of [group.workCards, group.reviewCards]) cards.sort((a, b) => a.round - b.round || compareId(a.taskId, b.taskId));
    }
  }
  return [...boards.values()];
}

function shortTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "??:??"
    : `${String(date.getHours()).padStart(2, "0")}:${String(
        date.getMinutes()
      ).padStart(2, "0")}`;
}

export function renderTree(tree) {
  if (tree.length === 0) return "기록 없음";
  const lines = [];
  for (const board of tree) {
    lines.push(`판 ${board.name}${board.about ? ` — ${board.about}` : ""}`);
    if (board.plannedCards?.length) {
      lines.push(`  발령 전 ${board.plannedCards.length}장: ${board.plannedCards.map(card => card.title ? `${card.taskId}(${card.title})` : card.taskId).join(", ")}`);
    }
    for (const group of board.rounds ?? []) lines.push(`  ${renderRound(group)}`);
    const roleWidth = Math.max(...board.roles.map((role) => role.role.length));
    const cardWidth = Math.max(
      0,
      ...board.roles.flatMap((role) => role.cards.map((card) => card.taskId.length))
    );
    for (const role of board.roles) {
      let state;
      if (role.life.state === "alive") {
        state =
          role.life.pidState === "match"
            ? "살아있음 PID일치"
            : `살아있음 PID변경(${role.life.recordedPid ?? "?"}→${role.life.currentPid ?? "?"})`;
      } else if (role.life.state === "dead") {
        state = `죽음(stop ${shortTime(role.life.stoppedAt)})`;
      } else {
        state = role.life.startedAt
          ? `세션 없음(start ${shortTime(role.life.startedAt)})`
          : "기록없음";
      }
      const window = role.window ? `  창 ${role.window}` : "";
      const untracked = role.untrackedSends
        ? `  무표 send ${role.untrackedSends}건`
        : "";
      lines.push(
        `  역할 ${role.role.padEnd(roleWidth + 2)}${state}${window}${untracked}  ${role.harness ?? "모름"} · ${role.model ?? "모름"} · ${role.family ?? "모름"}`
      );
      for (const card of role.cards) {
        const label = card.taskId.padEnd(cardWidth + 2);
        const sender = `← ${card.by ?? "모름"}  `;
        const title = card.title ? `  — ${card.title}` : "";
        lines.push(
          card.connectionError
            ? `    ${label}${sender}기록 연결 실패: ${card.connectionError}${title}`
            : card.state === "done"
            ? `    ${label}${sender}done ${card.result} (${shortTime(card.at)})${title}`
            : `    ${label}${sender}보냄 ${shortTime(card.at)} (완료 없음)${title}`
        );
      }
    }
  }
  return lines.join("\n");
}
