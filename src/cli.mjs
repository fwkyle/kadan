#!/usr/bin/env node
import {WatchAI} from './watch-ai.mjs';
import {watchReportCommand,watchAILabel} from './watch-report.mjs';
import {notifyUser} from './watch-system.mjs';
import {storageCommand} from './storage-migration.mjs';
import {assertWritable} from './storage.mjs';
import {SecretaryMailbox,inboxCommand} from './secretary-mailbox.mjs';
import {composeRoleInstructions,startRoleProfile} from './role-instructions.mjs';
import {attachWatchOverview} from "./watch-overview.mjs";
import {PROFILE_FILE} from "./watch-cycle.mjs";
import {defaultProfilePath,readWatchProfile,applyWatchProfile,watchStartupWarnings} from "./watch-profile.mjs";
import {decisionCommand} from "./decisions.mjs";
import { CardStore } from "./card-store.mjs";
import { cardCommand } from "./card-command.mjs";
import { registerStartedRole } from "./hierarchy-register.mjs";
import {workCommand} from './work-command.mjs';
import { runInit, runUp } from './quickstart.mjs';
import {WorkStore} from './work-store.mjs';
import {resolveWorkMail} from './work-mail.mjs';
import { buildCardCenter } from "./card-center.mjs";
import { Handover } from "./handover.mjs";
import { HandoverRunner } from "./handover-runner.mjs";
import { workEntries, openTaskIds } from "./handover-state.mjs";
// kadan 코어 — 원장 + DONE 마커 감시. 바닥 호출은 floor 객체만 통한다.

import { parseHierarchy } from "./hierarchy.mjs";
import { createHash,randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { floor } from "./floor.mjs";
import {
  appendLedger,
  saveMailBody,
  readMailBody,
  ledgerBy,
  ledgerHome,
  ledgerPath,
  readLedger,
  resolveLedgerBy,
} from "./ledger.mjs";
import {
  closeRottieWindow,
  rottieConnectivity,
  SOCKET,
  buildOrcaCreateArgv,
  buildRottieCreateArgv,
  buildTmuxCreateArgv,
  capturePane,
  ensureTmuxConf,
  openWindow,
  parseRottieCreateResult,
  tmux,
  tmuxConfPath,
  tmuxConfText,
  hasSession,
} from "./floor-tmux.mjs";
import { buildRottieFloorCreateArgv } from "./floor-rottie.mjs";
import {
  buildWallSnapshot,
  createWallServer,
  renderWallHtml,
  withWaitSnapshots,
} from "./wall.mjs";
import {
  buildJudgeInput,
  parseJudgeVerdict,
  applyJudgeVerdict,
  judgeDue,
  assessRoles,
  assessResources,
  routeAlert,
  dedupAlerts,
  disconnectKind,
} from "./watch.mjs";
import {
  deliverResolution,
  formatAlertBody,
  runWatch,
} from "./watch-runner.mjs";
import { executeJudge } from "./watch-judge.mjs";
import { collectResources } from "./watch-resource.mjs";
import {
  assessSupervisorIdle,
  wakeDue,
  buildWakeMessage,
} from "./watch-supervisor.mjs";
import { boardFromRole } from "./board.mjs";

export {
  appendLedger,
  ledgerBy,
  ledgerHome,
  ledgerPath,
  readLedger,
  resolveLedgerBy,
  SOCKET,
  buildOrcaCreateArgv,
  buildRottieCreateArgv,
  buildRottieFloorCreateArgv,
  buildTmuxCreateArgv,
  capturePane,
  ensureTmuxConf,
  openWindow,
  parseRottieCreateResult,
  tmux,
  tmuxConfPath,
  tmuxConfText,
  hasSession,
  createWallServer,
  renderWallHtml,
  buildJudgeInput,
  parseJudgeVerdict,
  applyJudgeVerdict,
  judgeDue,
  assessSupervisorIdle,
  wakeDue,
  buildWakeMessage,
  assessRoles,
  assessResources,
  routeAlert,
  dedupAlerts,
  disconnectKind,
  collectResources,
  runWatch,
  formatAlertBody,
  deliverResolution,
  executeJudge,
};

export function recentSends(entries) {
  // 카드 제목은 plan 줄에만 있다. 우편함에서 id만 보면 무슨 카드인지 모른다 (2026-09-06).
  const titles = new Map();
  for (const entry of entries) {
    if (entry?.kind === "plan" && entry.taskId && entry.title) titles.set(entry.taskId, entry.title);
  }
  return entries
    .filter((entry) => entry?.kind === "send")
    .slice(-20)
    .reverse()
    .map((entry) => ({
      at: entry.t,
      by: ledgerBy(entry),
      role: entry.role ?? "모름",
      taskId: entry.taskId ?? "-",
      ...(entry.taskId && titles.has(entry.taskId) ? { title: titles.get(entry.taskId) } : {}),
      ...(entry.preview ? { preview: entry.preview } : {}),
      ...(entry.digest ? { digest: entry.digest } : {}),
      ...(entry.digest && readMailBody(entry.digest) ? { body: readMailBody(entry.digest) } : {}),
      bytes: entry.bytes ?? null,
    }));
}

const die = (message, code = 1) => {
  console.error(`오류: ${message}`);
  process.exit(code);
};

export function sessionName(role) {
  const safe = role
    .trim()
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe) die("역할 이름이 비어 있거나 부적합하다");
  return `kadan-${safe}`;
}

export function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // Rottie는 렌더된 화면이 아니라 원시 TUI 스트림을 준다. 절대 커서 이동을 그냥
    // 지우면 완료 줄과 다음 입력 프롬프트가 붙으므로 줄 경계로 보존한다(2026-08-30).
    .replace(/\x1b\[[0-9;?]*[Hf]/g, "\n")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

export function tailLines(text, count) {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-count).join("\n");
}

function waitSnapshotIso(at) {
  return (at instanceof Date ? at : new Date(at)).toISOString();
}

export function waitSnapshotPath(
  session,
  reason,
  at,
  home = ledgerHome()
) {
  if (!["quiet", "timeout", "gap"].includes(reason)) {
    throw new Error(`지원하지 않는 wait snapshot 이유: ${reason}`);
  }
  const stamp = waitSnapshotIso(at).replace(/:/g, "-");
  return path.join(home, "out", `${session}.wait-${stamp}.txt`);
}

export function formatWaitSnapshot({ session, reason, at, screen }) {
  const lines = [
    `session: ${session}`,
    `reason: ${reason}`,
    `at: ${waitSnapshotIso(at)}`,
  ];
  const tail = tailLines(screen, 30);
  if (tail) lines.push(tail);
  return lines.join("\n");
}

function writeWaitSnapshot({
  floor: selectedFloor,
  session,
  reason,
  at,
  home,
}) {
  try {
    const screen = tailLines(
      stripAnsi(normalizeFloorRead(selectedFloor.read(session)).text),
      30
    );
    const file = waitSnapshotPath(session, reason, at, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      formatWaitSnapshot({ session, reason, at, screen }),
      "utf8"
    );
    console.error(`마지막 화면 30줄 → ${file}`);
    return file;
  } catch (error) {
    console.error(`경고: 마지막 화면 저장 실패: ${error.message}`);
    return null;
  }
}

export function findDoneMarkers(text) {
  const found = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*KADAN:DONE\s+(\S+)\s+(ok|failed)\s*$/);
    if (match) found.push({ taskId: match[1], result: match[2] });
  }
  return found;
}

export function diffDoneMarkers(baselineMarkers, currentMarkers) {
  const counts = new Map();
  for (const marker of baselineMarkers) {
    const key = JSON.stringify(marker);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const fresh = [];
  for (const marker of currentMarkers) {
    const key = JSON.stringify(marker);
    const count = counts.get(key) || 0;
    if (count > 0) counts.set(key, count - 1);
    else fresh.push(marker);
  }
  return fresh;
}

export function digest(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function lastStartFor(session) {
  const starts = readLedger().filter(
    (entry) => entry.kind === "start" && entry.session === session
  );
  return starts[starts.length - 1] || null;
}

function recordedPid(entry) {
  return entry?.panePid ?? entry?.rottiePid ?? null;
}

export function dutyHead(role) {
  if (typeof role !== "string" || !role) return "";
  return role.slice((boardFromRole(role)?.length ?? -1) + 1).split("-")[0];
}

// 모델 이름 앞머리 규칙. 실행기별 어댑터가 아니다.
// openai-codex/gpt-6-astra 처럼 provider 접두가 있어도 마지막 이름 조각으로 읽는다.
export function modelFamily(model) {
  if (typeof model !== "string" || !model.trim()) return "모름";
  const name = model.trim().split("/").pop() ?? "";
  if (/^gpt/i.test(name)) return "gpt";
  if (/^claude/i.test(name)) return "claude";
  // claude 실행기는 짧은 별명으로 띄운다(--model fable, --model opus). 앞머리가 claude가 아니라 모름으로 빠졌다(2026-09-12 실측).
  if (/^(fable|opus|sonnet|haiku)/i.test(name)) return "claude";
  if (/^glm/i.test(name)) return "glm";
  if (/^kimi/i.test(name) || /^k3/i.test(name)) return "kimi";
  if (/^grok/i.test(name)) return "grok";
  if (/^deepseek/i.test(name)) return "deepseek";
  if (/^gemini/i.test(name)) return "gemini";
  return "모름";
}

export function startDisplay(start) {
  const harness =
    typeof start?.harness === "string" && start.harness.trim()
      ? start.harness.trim()
      : "모름";
  const model =
    typeof start?.model === "string" && start.model.trim()
      ? start.model.trim()
      : "모름";
  return {
    harness,
    model,
    family: modelFamily(model === "모름" ? undefined : model),
  };
}

function lastStartModel(entries, role) {
  const last = (entries ?? []).filter((entry) => entry?.kind === "start" && entry.role === role).at(-1);
  return typeof last?.model === "string" && last.model ? last.model : undefined;
}

// 검수자에게 보낼 때만 같은 판 작업자 최신 start 모델과 계열을 비교한다.
// 겹치거나 한쪽이 모름이면 경고·원장만 남기고, 전송은 막지 않는다.
export function familyConflictAlerts({ role, session, entries = [], source, env } = {}) {
  if (dutyHead(role) !== "검수자") return [];
  const board = boardFromRole(role);
  const latestWorkerStart = new Map();
  for (const entry of entries) {
    if (entry?.kind !== "start") continue;
    if (dutyHead(entry.role) !== "작업자") continue;
    if (boardFromRole(entry.role) !== board) continue;
    latestWorkerStart.set(entry.role, entry);
  }
  const reviewerModel = lastStartModel(entries, role);
  const reviewerFamily = modelFamily(reviewerModel);
  const out = [];
  for (const [workerRole, start] of latestWorkerStart) {
    const workerModel = typeof start.model === "string" && start.model ? start.model : undefined;
    const workerFamily = modelFamily(workerModel);
    if (reviewerFamily !== "모름" && workerFamily !== "모름" && reviewerFamily !== workerFamily) continue;
    const shownWorker = workerModel ?? "모름";
    const shownReviewer = reviewerModel ?? "모름";
    out.push({
      warning: `경고: 계열겹침 작업자=${workerRole} 모델=${shownWorker} 계열=${workerFamily} / 검수자=${role} 모델=${shownReviewer} 계열=${reviewerFamily}`,
      alert: {
        kind: "alert",
        alertKind: "계열겹침",
        level: "AMBER",
        role,
        session,
        counterpart: workerRole,
        ...(reviewerModel ? { model: reviewerModel } : {}),
        ...(workerModel ? { counterpartModel: workerModel } : {}),
        family: reviewerFamily,
        counterpartFamily: workerFamily,
        by: resolveLedgerBy({ source, env }),
      },
    });
  }
  return out;
}

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
  return "라운드 " + group.family + ": " + group.latestRound + "/18 (블록 " + Math.ceil(group.latestRound / 3) + "/6) — " + detail + (group.latestRound >= 9 ? " · 정체 확인" : "") + (group.latestRound >= 18 ? " · 상한 — 사용자 결정" : "");
}

export function buildTree(entries, aliveBySession = {}) {
  entries = workEntries(entries).filter(e=>e?.transport!=='mailbox');
  const roles = new Map();
  const boards = new Map();
  const planned = new Map();
  const assignedOrDone = new Set();
  for (const entry of entries) {
    const board = entry?.kind === "plan" ? entry.board : boardFromRole(entry?.role);
    if (!board || !entry.taskId) continue;
    const key = `${board}\0${entry.taskId}`;
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
        const card = item.cardsById.get(entry.taskId) || {
          taskId: entry.taskId,
        };
        card.sentAt = entry.t;
        card.by = ledgerBy(entry);
        item.cardsById.set(entry.taskId, card);
      }
    } else if (entry.kind === "done" && entry.taskId) {
      const card = item.cardsById.get(entry.taskId) || {
        taskId: entry.taskId,
      };
      card.doneAt = entry.t;
      card.result = entry.result;
      item.cardsById.set(entry.taskId, card);
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
      card.doneAt
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
          card.state === "done"
            ? `    ${label}${sender}done ${card.result} (${shortTime(card.at)})${title}`
            : `    ${label}${sender}보냄 ${shortTime(card.at)} (완료 없음)${title}`
        );
      }
    }
  }
  return lines.join("\n");
}

function normalizeFloorRead(value) {
  if (typeof value === "string") {
    return {
      text: value,
      cursor: null,
      gap: null,
      incremental: false,
    };
  }
  return {
    text: value?.text ?? "",
    cursor: value?.cursor ?? null,
    gap: value?.gap ?? null,
    incremental: value?.incremental === true,
  };
}

export function guardedSend({
  floor: selectedFloor,
  session,
  role,
  message,
  taskId,
  mailContext,
  roleProfile,
  raw = false,
  source,
  env = process.env,
  recordedPid: expectedPid,
  record = appendLedger,
  readEntries = readLedger,
  saveBody = saveMailBody,
}) {
  assertWritable(env.KADAN_HOME||env.KADAN_LITE_HOME||ledgerHome());
  if (taskId != null && (typeof taskId !== "string" || !/^\S+$/.test(taskId))) {
    throw new Error("taskId는 공백 없는 한 덩어리여야 한다");
  }
  // 파일/기록 읽기는 생존 검사 전에 끝낸다. 본문은 항상 앞에 그대로 둔다.
  let entries;
  try { entries = readEntries(); }
  catch (error) { entries = [{broken:`원장 읽기 실패: ${error.message}`}]; }
  const sourceCwd = entries.filter(e=>e.kind==='start'&&e.role===role&&e.cwd).at(-1)?.cwd ?? null;
  const originalCardPath = extractCardPath(message,sourceCwd);
  const composed = composeRoleInstructions({home:env.KADAN_HOME||env.KADAN_LITE_HOME||ledgerHome(),
    role,message,profile:roleProfile,raw,taskId,mailContext,entries});
  message = composed.message;
  const conflicts = familyConflictAlerts({role,session,entries,source,env});
  for (const conflict of conflicts) {
    console.error(conflict.warning);
    try { record(conflict.alert); }
    catch (error) { console.error(`원장 기록 실패: ${error.message}`); }
  }
  if (!selectedFloor.alive(session)) {
    const error = new Error(`세션 없음: ${session} — 먼저 kadan start ${role}`);
    error.code = "KADAN_SESSION_MISSING";
    error.delivery = "not-sent";
    throw error;
  }
  const currentPid = selectedFloor.pid(session);
  if (expectedPid && currentPid !== String(expectedPid)) {
    const error = new Error(
      `이름은 같은데 다른 프로세스다 (기록 ${expectedPid} / 현재 ${currentPid}). 사람 확인 필요.`
    );
    error.code = "KADAN_PID_MISMATCH";
    error.delivery = "not-sent";
    throw error;
  }
  if (!expectedPid) {
    console.error("경고: 원장에 이 세션의 시작 기록이 없다 (PID 대조 생략)");
  }

  let receipt;
  try {
    receipt = selectedFloor.send(session, message) || {};
  } catch (error) {
    if (!["not-sent", "unknown"].includes(error.delivery)) error.delivery = "unknown";
    throw error;
  }
  const entry = {
    kind: "send",
    mailId:randomUUID(),
    ...(mailContext?.workKey?{workKey:mailContext.workKey}:{}),
    ...(mailContext?.executionKey?{executionKey:mailContext.executionKey}:{}),
    ...(mailContext?.replyTo?{replyTo:mailContext.replyTo}:{}),
    floor: selectedFloor.name,
    ...(receipt.keyDelivery ? {keyDelivery:receipt.keyDelivery, inputAcceptance:receipt.inputAcceptance} : {}),
    role,
    session,
    roleInstructions: composed.metadata,
    originalCardPath,
    ...(composed.metadata.profile ? {roleProfile:composed.metadata.profile} : {}),
    by: resolveLedgerBy({ source, env }),
    ...(taskId != null ? { taskId } : {}),
    bytes: Buffer.byteLength(message),
    digest: digest(message),
    ...(mailPreview(message) ? { preview: mailPreview(message) } : {}),
    ...(receipt.sequence != null ? { sequence: receipt.sequence } : {}),
    ...(receipt.enterSequence != null
      ? { enterSequence: receipt.enterSequence }
      : {}),
    ...(receipt.bodySha256 ? { bodySha256: receipt.bodySha256 } : {}),
    ...(receipt.outputCursor ? { outputCursor: receipt.outputCursor } : {}),
    ...(receipt.deliveryId ? { deliveryId: receipt.deliveryId } : {}),
    ...(receipt.terminalId ? { rottieTerminalId: receipt.terminalId } : {}),
    ...(receipt.baselineText != null
      ? {
          baselineMarkers: findDoneMarkers(stripAnsi(receipt.baselineText)),
        }
      : {}),
  };
  // 본문은 원장이 아니라 옆 파일에 둔다. 저장이 실패해도 전달은 이미 끝났으므로 막지 않는다.
  try {
    saveBody(digest(message), message);
  } catch (error) {
    console.error(`편지 본문 저장 실패(전달은 됨): ${error.message}`);
  }
  try {
    record(entry);
  } catch (error) {
    error.delivery = "sent";
    throw error;
  }
  return entry;
}

// 카드 id는 `card-65` 또는 `card-65:사람이 읽는 제목` 형태를 받는다. 제목과 판 설명(about)은
// 화면에서 "mp가 도대체 뭐느냐"를 없애려고 넣는다 (2026-09-06 [kyle]). 안 적으면 예전처럼 id만 남는다.
// 우편함에서 "무슨 편지였나"가 한 줄로 보이게 앞머리만 원장에 남긴다. 전문은 옆 파일에 있다.
// 편지 본문에 적힌 카드 파일 경로를 읽어 화면에서 펼친다 (2026-09-06 [kyle]).
// 아무 파일이나 읽지 않는다: 절대경로 .md, 실재하는 파일, 60KB 상한. 셋 다 맞아야 읽는다.
export function extractCardPath(text, cwd = null) {
  if (typeof text !== "string") return null;
  // 절대경로는 줄머리나 공백·따옴표 뒤에서 시작할 때만 인정한다. 그러지 않으면
  // "tasks/card.md"의 뒷부분을 "/card.md"로 잘못 문다 (2026-09-06 시험이 잡았다).
  const absolute = text.match(/(?:^|[\s"'(])(\/[^\s"']+\.md)/u)?.[1];
  if (absolute) return absolute;
  // 레포마다 카드 폴더 규칙이 다르고 상대경로로 보내기도 한다 (2026-09-06 [kyle]).
  // 그때는 그 역할이 일하던 폴더(start 원장의 cwd)를 기준으로 푼다. cwd를 모르면 포기한다.
  const relative = text.match(/(?:^|[\s"'(])([\w.@~-][\w./@~-]*\.md)/u)?.[1];
  if (!relative || !cwd) return null;
  return path.resolve(cwd, relative.replace(/^~(?=\/)/u, process.env.HOME ?? "~"));
}

const CARD_FILE_LIMIT = 60_000;

export function collectCardFiles(entries, deps = {}) {
  const readFile = deps.readFile ?? ((file) => fs.readFileSync(file, "utf8"));
  const readBody = deps.readBody ?? readMailBody;
  const files = {};
  const cwdByRole = new Map();
  for (const entry of entries ?? []) {
    if (entry?.kind === "start" && entry.role && entry.cwd) cwdByRole.set(entry.role, entry.cwd);
  }
  for (const entry of entries ?? []) {
    if (entry?.kind !== "send" || !entry.taskId || files[entry.taskId]) continue;
    // 새 영수증의 null은 원문에 경로가 없었다는 뜻이다. 첨부를 대신 카드로 읽지 않는다.
    let file;
    if (Object.hasOwn(entry,'originalCardPath')) {
      file = typeof entry.originalCardPath==='string'&&path.isAbsolute(entry.originalCardPath)&&entry.originalCardPath.endsWith('.md') ? entry.originalCardPath : null;
    } else {
      const source = (entry.digest ? readBody(entry.digest) : null) ?? entry.preview ?? "";
      file = extractCardPath(source, cwdByRole.get(entry.role) ?? null);
    }
    if (!file) continue;
    try {
      const text = readFile(file);
      files[entry.taskId] = text.length > CARD_FILE_LIMIT
        ? { path: file, text: `${text.slice(0, CARD_FILE_LIMIT)}\n… (너무 길어 잘랐다)` }
        : { path: file, text };
    } catch (error) {
      files[entry.taskId] = { path: file, error: error.code === "ENOENT" ? "파일 없음" : "못 읽음" };
    }
  }
  return files;
}

export function mailPreview(message, limit = 100) {
  if (typeof message !== "string") return "";
  const flat = message.replace(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

export function parsePlanCard(item) {
  if (typeof item !== "string") return { taskId: item };
  const index = item.indexOf(":");
  if (index === -1) return { taskId: item };
  const title = item.slice(index + 1).trim();
  return { taskId: item.slice(0, index), ...(title ? { title } : {}) };
}

export function planCards({ board, taskIds, about = null, env = process.env, record = appendLedger }) {
  const valid = value => typeof value === "string" && /^\S+$/.test(value);
  const cards = Array.isArray(taskIds) ? taskIds.map(parsePlanCard) : [];
  if (!valid(board) || cards.length === 0 ||
      !cards.every(card => valid(card.taskId)) ||
      new Set(cards.map(card => card.taskId)).size !== cards.length) {
    const error = new Error("판과 카드 id는 공백 없는 문자열이어야 하며 카드 중복은 허용하지 않는다");
    error.exitCode = 2;
    throw error;
  }
  const boardAbout = typeof about === "string" && about.trim() ? about.trim() : null;
  for (const { taskId, title } of cards) {
    record({
      kind: "plan",
      board,
      taskId,
      ...(title ? { title } : {}),
      ...(boardAbout ? { about: boardAbout } : {}),
      by: resolveLedgerBy({ env }),
    });
  }
}

export function confirmDone({
  entries,
  role,
  taskId,
  result,
  env = process.env,
  record = appendLedger,
}) {
  const reject = (message) => {
    const error = new Error(message);
    error.exitCode = 2;
    throw error;
  };
  if (!role) reject("역할이 비어 있다");
  if (typeof taskId !== "string" || !/^\S+$/.test(taskId)) {
    reject("카드 id는 공백 없는 한 덩어리여야 한다");
  }
  if (result !== "ok" && result !== "failed") {
    reject("결과는 ok 또는 failed여야 한다");
  }
  if (
    entries.some(
      (entry) =>
        entry?.kind === "done" &&
        entry.role === role &&
        entry.taskId === taskId
    )
  ) {
    reject(`이미 완료 확정됨: 역할=${role} 카드=${taskId}`);
  }
  const session = sessionName(role);
  const start = entries
    .filter(
      (entry) =>
        entry?.kind === "start" &&
        entry.role === role
    )
    .at(-1);
  if (!start) reject(`시작 기록 없음: ${role}`);

  const entry = {
    kind: "done",
    ...(start.floor ? { floor: start.floor } : {}),
    role,
    session: start.session || session,
    by: resolveLedgerBy({ env }),
    taskId,
    result,
  };
  record(entry);
  return entry;
}

export function runWaitLoop({
  floor: selectedFloor,
  session,
  role,
  intervalMs,
  timeoutMs,
  quietMs,
  since,
  baselineMarkers,
  now = Date.now,
  record = appendLedger,
  snapshotHome = null,
  snapshotAt = () => new Date(),
}) {
  const incomplete = (result) => {
    if (snapshotHome) {
      writeWaitSnapshot({
        floor: selectedFloor,
        session,
        reason: result.reason,
        at: snapshotAt(),
        home: snapshotHome,
      });
    }
    return result;
  };
  const started = now();
  let observation = normalizeFloorRead(
    selectedFloor.read(session, since ? { since } : undefined)
  );
  if (observation.gap) {
    return incomplete({ code: 2, reason: "gap", gap: observation.gap });
  }

  const baseline =
    baselineMarkers ??
    findDoneMarkers(stripAnsi(observation.text));
  let accumulated = baselineMarkers ? observation.text : "";
  let lastHash = digest(observation.text);
  let lastChange = now();

  const inspect = () => {
    const fresh = diffDoneMarkers(
      baseline,
      findDoneMarkers(stripAnsi(accumulated))
    );
    if (fresh.length === 0) return null;
    for (const marker of fresh) {
      record({
        kind: "done",
        floor: selectedFloor.name,
        role,
        session,
        taskId: marker.taskId,
        result: marker.result,
      });
    }
    return { code: 0, reason: "done", markers: fresh };
  };

  if (baselineMarkers) {
    const immediate = inspect();
    if (immediate) return immediate;
  }

  while (now() - started < timeoutMs) {
    selectedFloor.waitForChange(session, intervalMs, observation.cursor);
    const next = normalizeFloorRead(
      selectedFloor.read(
        session,
        observation.cursor ? { since: observation.cursor } : undefined
      )
    );
    if (next.gap) {
      return incomplete({ code: 2, reason: "gap", gap: next.gap });
    }
    accumulated = next.incremental ? accumulated + next.text : next.text;
    const hash = digest(accumulated);
    if (hash !== lastHash) {
      lastHash = hash;
      lastChange = now();
    }
    observation = next;

    const completed = inspect();
    if (completed) return completed;
    if (now() - lastChange >= quietMs) {
      return incomplete({ code: 2, reason: "quiet" });
    }
  }
  return incomplete({ code: 3, reason: "timeout" });
}

export function resolveWindowChoice(env = process.env) {
  const value = env.KADAN_WINDOW;
  if (!value) return { kind: "none" };
  if (value === "orca" || value === "rottie" || value === "none") {
    return { kind: value };
  }
  return { error: "KADAN_WINDOW_INVALID", value };
}

function requireWindowChoice(env = process.env) {
  const choice = resolveWindowChoice(env);
  if (choice.error) {
    die(
      `${choice.error}: KADAN_WINDOW=${choice.value} (orca|rottie|none만 허용)`,
      2
    );
  }
  if (choice.kind === "orca" && !env.KADAN_ORCA_BIN) {
    die("KADAN_ORCA_BIN_REQUIRED: KADAN_WINDOW=orca에는 절대경로가 필요하다", 2);
  }
  if (choice.kind === "rottie" && !env.KADAN_ROTTIE_BIN) {
    die("KADAN_ROTTIE_BIN_REQUIRED: KADAN_WINDOW=rottie에는 절대경로가 필요하다", 2);
  }
  return choice;
}

const ROTTIE_BIN_NAME = /(^|[\/])rottie$/i;

function rottieBinFromCommand(command) {
  if (typeof command !== "string") return null;
  const text = command.trim();
  if (!text.startsWith("/")) return null;
  const app = text.match(/^(\/.+?\/Contents\/MacOS\/rottie)(?:\s|$)/i);
  const unix = text.match(/^(\/\S*\/rottie)(?:\s|$)/i);
  const binary = app?.[1] ?? unix?.[1];
  if (!binary) return null;
  if (binary.includes("terminal-daemons")) return null;
  if (!ROTTIE_BIN_NAME.test(binary)) return null;
  return binary;
}

export function listRunningRottieBins({ spawnFn = spawnSync } = {}) {
  const result = spawnFn("ps", ["-axww", "-o", "command="], { encoding: "utf8" });
  const seen = new Set();
  const bins = [];
  for (const line of (result.stdout ?? "").split("\n")) {
    const bin = rottieBinFromCommand(line);
    if (!bin) continue;
    if (seen.has(bin)) continue;
    seen.add(bin);
    bins.push(bin);
  }
  return bins;
}

function formatRottiePreflightFailure({ reason, bin, connection, candidates }) {
  const shown = bin ?? "모름";
  const what =
    reason === "missing"
      ? "파일 없음: KADAN_ROTTIE_BIN=" + shown
      : "연결 실패: KADAN_ROTTIE_BIN=" +
        shown +
        " 번들 " +
        (connection?.bundleId ?? "모름") +
        "(빌드 " +
        (connection?.build ?? "모름") +
        ")에 " +
        (connection?.code ?? "모름");
  const listed = candidates.length
    ? candidates.map((item) => "  " + item).join("\n")
    : "  (지금 켜진 로티 실행 파일 없음)";
  return [
    what,
    "지금 켜진 로티 실행 파일 후보:",
    listed,
    "사람이 할 일: KADAN_ROTTIE_BIN을 위 후보 중 하나로 바꾼다. 카단은 자동으로 갈아타지 않는다.",
  ].join("\n");
}

// 임시 장치: 로티 정식 출시로 경로가 고정되면 이 점검은 걷어낸다 (2026-09-06 [kyle] 결정).
export function inspectRottieStartPreflight({
  env = process.env,
  floorName,
  hidden = false,
  existsFn = fs.existsSync,
  connectFn = rottieConnectivity,
  listBinsFn = listRunningRottieBins,
} = {}) {
  const needsWindow = floorName === "rottie" || env.KADAN_WINDOW === "rottie";
  if (!needsWindow || hidden) return { ok: true, skipped: true };
  const bin = env.KADAN_ROTTIE_BIN;
  const candidates = listBinsFn();
  if (!bin || !existsFn(bin)) {
    return {
      ok: false,
      reason: "missing",
      bin,
      candidates,
      message: formatRottiePreflightFailure({ reason: "missing", bin, candidates }),
    };
  }
  const connection = connectFn({ bin });
  if (!connection?.ok) {
    return {
      ok: false,
      reason: "connect",
      bin,
      connection,
      candidates,
      message: formatRottiePreflightFailure({
        reason: "connect",
        bin,
        connection,
        candidates,
      }),
    };
  }
  return { ok: true, bin, connection, candidates };
}

// 실행 명령에서 실행기(harness)와 모델을 읽어 원장에 남긴다. 판단에는 쓰지 않는다 —
// 사고 뒤 "어느 실행기·어느 모델이었나"를 원장만으로 답하기 위한 기록이다. 화면이 사라지면
// ps도 함께 사라진다. 실행기별 어댑터가 아니라 명령 첫 낱말과 --model 값을 그대로 옮긴다.
export function describeStartCmd(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return {};
  const text = cmd.trim();
  const tokens = text.split(/\s+/);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  const harness = tokens[index]?.split("/").pop();
  // 따옴표를 벗겨서 남긴다. 안 벗기면 원장에 '\'kimi/k3[1m]\'' 처럼 따옴표째 박힌다(2026-09-12 실측).
  const model = text.match(/--model[=\s]+["']*([^\s"']+)["']*/)?.[1];
  return {
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    cmd: text,
  };
}

export function buildStartLedgerEntry({
  floorName,
  role,
  session,
  evidence,
  window,
  rottieTerminalId,
  orcaTerminalHandle,
  reused,
  cmd,
  cwd,
  env = process.env,
}) {
  return {
    kind: "start",
    floor: floorName,
    role,
    session,
    by: resolveLedgerBy({ env }),
    ...describeStartCmd(cmd),
    ...(cwd ? { cwd } : {}),
    ...(evidence.panePid ? { panePid: evidence.panePid } : {}),
    ...(evidence.rottiePid ? { rottiePid: evidence.rottiePid } : {}),
    ...(evidence.rottieTerminalId
      ? { rottieTerminalId: evidence.rottieTerminalId }
      : {}),
    ...(evidence.rottieWorkspaceId
      ? { rottieWorkspaceId: evidence.rottieWorkspaceId }
      : {}),
    ...(evidence.rottieBuild ? { rottieBuild: evidence.rottieBuild } : {}),
    window,
    ...(rottieTerminalId ? { rottieTerminalId } : {}),
    ...(orcaTerminalHandle ? { orcaTerminalHandle } : {}),
    ...(typeof reused === "boolean" ? { reused } : {}),
    ...(evidence.outputLog ? { outputLog: evidence.outputLog } : {}),
  };
}

// 종료 전에 그 역할이 받았지만 done이 없는 카드를 센다. 화면은 stop과 함께 사라지므로
// 그 뒤엔 아무도 결과를 증언할 수 없다 (2026-09-01 c31·c32·c34 미아 6건). 막지 않고 알린다.
export function pendingCardsFor(entries, role) {
  return openTaskIds(entries, role);
}

export function buildStopLedgerEntry({ role, session, env = process.env }) {
  return {
    kind: "stop",
    role,
    session,
    by: resolveLedgerBy({ env }),
  };
}

export function openStartedWindow(session, platform = process.platform, deps = {}) {
  let fields = {};
  if (deps.choice?.kind === "rottie") {
    const result = rottieConnectivity({ bin: deps.rottieBin ?? process.env.KADAN_ROTTIE_BIN, spawnFn: deps.spawnFn });
    fields = { rottieBundleId: result.bundleId, rottieConnect: result.ok ? "ok" : "failed" };
    if (!result.ok) {
      (deps.print ?? console.log)(`창 rottie 연결 안 됨: KADAN_ROTTIE_BIN 번들 ${result.bundleId ?? "모름"}(빌드 ${result.build ?? "모름"})에 ${result.code} — 켜진 로티가 이 번들이 아니면 KADAN_ROTTIE_BIN을 켜진 앱의 CLI로 바꾼다`);
      return { method: "manual", ...fields, rottieConnectError: String(result.code) };
    }
  }
  return { ...(openWindow(session, platform, deps) ?? { method: "manual" }), ...fields };
}

export function closeStartedWindow(lastStart, { env = process.env, closeFn = closeRottieWindow, connectFn = rottieConnectivity, print = console.log } = {}) {
  const terminalId = lastStart?.rottieTerminalId;
  if (!terminalId) return {};
  if (!env.KADAN_ROTTIE_BIN) {
    print("창 닫기 건너뜀: KADAN_ROTTIE_BIN 없음");
    return { rottieTerminalId: terminalId, rottieWindowClosed: false, rottieWindowError: "KADAN_ROTTIE_BIN 없음" };
  }
  const result = closeFn({ bin: env.KADAN_ROTTIE_BIN, terminalId });
  if (result.closed) print(`창 닫힘: ${terminalId}`);
  else {
    const connection = connectFn({ bin: env.KADAN_ROTTIE_BIN });
    print(`창 닫기 실패: ${terminalId} ${result.code} (번들 ${connection.bundleId ?? "모름"})`);
  }
  return {
    rottieTerminalId: terminalId,
    rottieWindowClosed: result.closed,
    ...(!result.closed ? { rottieWindowError: String(result.code) } : {}),
  };
}

function cmdStart(argv, flags) {
  const role = argv[0];
  if (!role) die("사용법: kadan start <역할> [--hidden] [--cmd <명령>] [--profile secretary|super|conductor|worker|reviewer]");
  const windowChoice = floor.name === "tmux" ? requireWindowChoice() : null;
  const preflight = inspectRottieStartPreflight({
    floorName: floor.name,
    hidden: Boolean(flags.hidden),
  });
  if (!preflight.ok) die(preflight.message, 2);
  const session = sessionName(role);
  const reusing = floor.alive(session);
  const roleProfile = startRoleProfile({home:ledgerHome(),role,profile:flags.profile,previous:reusing?lastStartFor(session):null,reusing});
  let evidence;
  let startedCmd;
  if (reusing) {
    console.log(`이미 살아 있음: ${session}`);
    const existingPid = floor.pid(session);
    evidence =
      floor.name === "rottie"
        ? {
            rottieTerminalId: lastStartFor(session)?.rottieTerminalId,
            rottiePid: existingPid,
            rottieWorkspaceId: lastStartFor(session)?.rottieWorkspaceId,
            rottieBuild: lastStartFor(session)?.rottieBuild,
          }
        : { panePid: existingPid };
  } else {
    try {
      startedCmd = flags.cmd || undefined;
      evidence = floor.create({
        session,
        role,
        cwd: process.cwd(),
        cmd: startedCmd,
      });
    } catch (error) {
      die(error.message);
    }
  }

  const pid = evidence.panePid ?? evidence.rottiePid;
  let method = floor.name === "rottie" ? "rottie" : "hidden";
  let rottieTerminalId;
  let orcaTerminalHandle;
  let reused;
  let rottieConnection = {};
  if (!flags.hidden && floor.name === "tmux") {
    if (process.platform === "darwin") {
      const window = openStartedWindow(session, process.platform, {
        choice: windowChoice,
        role,
        panePid: pid,
      });
      if (window && typeof window === "object") {
        method = window.method;
        rottieTerminalId = window.rottieTerminalId;
        orcaTerminalHandle = window.orcaTerminalHandle;
        reused = window.reused;
        const { rottieBundleId, rottieConnect, rottieConnectError } = window;
        rottieConnection = { rottieBundleId, rottieConnect, rottieConnectError };
      } else {
        method = "manual";
      }
    } else {
      method = "manual";
    }
  }

  appendLedger({ ...buildStartLedgerEntry({
    floorName: floor.name,
    role,
    session,
    evidence,
    window: method,
    rottieTerminalId,
    orcaTerminalHandle,
    reused,
    cmd: startedCmd,
    cwd: process.cwd(),
  }), ...rottieConnection, ...(roleProfile?{roleProfile}: {}) });
  console.log(
    `시작됨: ${session} (${floor.name === "rottie" ? "Rottie PID" : "pane PID"} ${pid ?? "?"}, 창: ${method}${
      method === "manual" ? ` — 직접: ${floor.attach(session)}` : ""
    })`
  );
  // 감시 알림이 갈 곳을 사람이 따로 적지 않아도 되게 한다. 실패는 알리기만 하고 시작을 막지 않는다.
  const registration = registerStartedRole({
    role,
    creator: resolveLedgerBy({ env: process.env }),
    home: ledgerHome(),
  });
  if (registration.registered) {
    console.log(`감시 등록: ${role} → ${registration.parent}`);
  } else if (registration.hierarchyPath && registration.reason !== "이미 등록됨") {
    // 관계표를 찾았는데도 못 적은 경우만 알린다. 관계표가 없는 환경은 정상이다.
    console.error(`감시 등록 안 됨(${registration.reason}) — 알림 수신자를 직접 확인하라`);
  }
}

function cmdSend(argv, flags) {
  const role = argv[0];
  if (!role) {
    die("사용법: kadan send <역할> [--task <카드id>] [--raw] <메시지...> (메시지 생략 시 표준 입력)");
  }
  if(role==='비서'&&flags.task)throw new Error('비서 우편은 작업 발령이 아닙니다. --task를 사용하지 마세요');
  if (flags.task) new CardStore(ledgerHome()).checkSend(flags.task, role);
  const session = sessionName(role);
  const argText = argv.slice(1).join(" ");
  const input = argText || fs.readFileSync(0, "utf8");
  const message = flags.raw || argText ? input : input.replace(/\n+$/, "");
  if (!message) die("보낼 메시지가 비어 있다");
  if(role==='비서'){
    if (flags.raw) throw new Error('비서 우편함은 --raw 대상이 아닙니다. 원문은 항상 보존됩니다');
    const receipt=new SecretaryMailbox(ledgerHome()).send({by:resolveLedgerBy({env:process.env}),message,category:flags['mail-kind']||'report',replyTo:flags['reply-to'],workKey:flags.work,executionKey:flags.execution});
    console.log(JSON.stringify(receipt));return;
  }

  let receipt;
  try {
    const mailContext=resolveWorkMail(ledgerHome(),{workKey:flags.work,executionKey:flags.execution,replyTo:flags['reply-to'],taskId:flags.task});
    receipt = guardedSend({
      floor,
      session,
      role,
      message,
      taskId: flags.task,
      mailContext,
      raw:flags.raw===true,
      recordedPid: recordedPid(lastStartFor(session)),
    });
  } catch (error) {
    die(error.message, error.exitCode || 1);
  }
  console.log(
    `${floor.name === "tmux" ? "키 전송됨" : "전달됨"}: ${session} (${receipt.bytes}B, 지문 ${receipt.digest})${floor.name === "tmux" ? " — 입력 접수·AI 실행 미확인" : ""} — 역할 지침 ${receipt.roleInstructions.status==='applied'?receipt.roleProfile:`적용 안 됨 (${receipt.roleInstructions.reason})`}`
  );
}

function cmdPlan(argv, flags = {}) {
  const [board, ...taskIds] = argv;
  if (!board || taskIds.length === 0) {
    die('사용법: kadan plan <판> [--about "<판 설명>"] <카드id[:제목]>...', 2);
  }
  const about = typeof flags.about === "string" ? flags.about : null;
  planCards({ board, taskIds, about });
  const shown = taskIds
    .map(parsePlanCard)
    .map(card => (card.title ? `${card.taskId}(${card.title})` : card.taskId))
    .join(", ");
  console.log(`계획됨: 판=${board}${about ? ` 설명=${about}` : ""} 카드=${shown}`);
}

function cmdDone(argv) {
  const [role, taskId, result, ...extra] = argv;
  if (!role || !taskId || !result || extra.length > 0) {
    die("사용법: kadan done <역할> <카드id> <ok|failed>", 2);
  }
  const entry = confirmDone({
    entries: readLedger(),
    role,
    taskId,
    result,
  });
  console.log(
    `완료 확정: 역할=${entry.role} 카드=${entry.taskId} 결과=${entry.result} 확인=${entry.by}`
  );
}

function cmdWait(argv, flags) {
  const role = argv[0];
  if (!role) {
    die("사용법: kadan wait <역할> [--timeout 초] [--quiet 초] [--interval 초]");
  }
  const session = sessionName(role);
  if (!floor.alive(session)) die(`세션 없음: ${session}`);
  const interval = (Number(flags.interval) || 2) * 1000;
  const timeout = (Number(flags.timeout) || 600) * 1000;
  const quietMs = (Number(flags.quiet) || 120) * 1000;

  const lastSend = readLedger()
    .filter((entry) => entry.kind === "send" && entry.session === session)
    .at(-1);
  let result;
  try {
    result = runWaitLoop({
      floor,
      session,
      role,
      intervalMs: interval,
      timeoutMs: timeout,
      quietMs,
      since: lastSend?.outputCursor,
      baselineMarkers: lastSend?.baselineMarkers,
      snapshotHome: ledgerHome(),
    });
  } catch (error) {
    die(error.message, error.exitCode || 1);
  }
  if (result.code === 0) {
    for (const marker of result.markers) {
      console.log(`완료 마커: taskId=${marker.taskId} 결과=${marker.result}`);
    }
  } else if (result.reason === "gap") {
    console.log(
      `출력 누락 보고: ${result.gap.from}→${result.gap.to}, 마커를 놓쳤을 수 있음 — 사람 확인 필요`
    );
  } else if (result.reason === "quiet") {
    console.log(
      `정지 보고: ${Math.round(quietMs / 1000)}초간 출력 없음, 마커 없음 — 사람 확인 필요`
    );
  } else {
    console.log("제한 시간 도달: 아직 진행 중일 수 있음");
  }
  process.exit(result.code);
}

function sendWatchMessage(role,message) {
  if (role==='@user') {
    const failure=notifyUser(message,spawnSync);
    if (failure) { const error=new Error('사용자 알림 실패'); error.delivery='not-sent'; throw error; }
    return;
  }
  const session=sessionName(role);
  guardedSend({floor,session,role,message,source:'watch',recordedPid:recordedPid(lastStartFor(session))});
}

function cmdWatch(argv, flags) {
  const usage =
    "사용법: kadan watch [--profile <JSON파일>] [--interval 초] [--stall 횟수] [--stall-after 분] [--start-report-after 분] [--idle 분] [--route <판>=<역할>]... [--super <역할>] [--hierarchy <JSON파일>] [--wake <역할>] [--wake-every 분] [--user-notify] [--judge-cmd <셸 명령>] [--judge-cooldown 분]\n  --profile: 정식 명령을 담은 JSON({flags,env}). 직접 준 옵션이 우선. 옵션이 하나도 없고 $KADAN_HOME/" + PROFILE_FILE + "이 있으면 자동 적용.";
  if (flags.help) {
    console.log(usage);
    return;
  }
  if (argv.length > 0) die(usage, 2);
  const allowed = new Set([
    "profile",
    "interval",
    "stall",
    "stall-after",
    "start-report-after",
    "idle",
    "route",
    "super",
    "hierarchy",
    "wake",
    "wake-every",
    "user-notify",
    "judge-cmd",
    "judge-cooldown",
  ]);
  const unknown = Object.keys(flags).find((name) => !allowed.has(name));
  if (unknown) die(`watch가 모르는 옵션: --${unknown}`, 2);
  if (flags.profile === true || Array.isArray(flags.profile)) die("watch --profile에는 파일 하나가 필요하다", 2);
  const defaultProfile = defaultProfilePath(ledgerHome());
  const profileFile = flags.profile ? path.resolve(flags.profile) : Object.keys(flags).length === 0 && fs.existsSync(defaultProfile) ? defaultProfile : null;
  let profile = null;
  if (profileFile) {
    try { profile = readWatchProfile(profileFile); } catch (error) { die(error.message, 2); }
    delete flags.profile;
    const applied = applyWatchProfile(flags, profile);
    console.log(`감시 프로필 적용: ${profileFile}${applied.length ? " (" + applied.join(", ") + ")" : " (적용한 옵션 없음)"}`);
  }
  for (const line of watchStartupWarnings(flags, {profileFile, defaultProfile, exists: fs.existsSync})) console.error(line);

  const intervalSeconds = flags.interval == null ? 60 : Number(flags.interval);
  const stallAfterMinutes=flags["stall-after"]==null?5:Number(flags["stall-after"]);
  const startReportMinutes=flags["start-report-after"]==null?5:Number(flags["start-report-after"]);
  if(!Number.isFinite(stallAfterMinutes)||stallAfterMinutes<=0||!Number.isFinite(startReportMinutes)||startReportMinutes<=0)die("감시 시간은 0보다 큰 분이어야 한다",2);
  const stallN = flags.stall == null ? 2 : Number(flags.stall);
  const idleMinutes = flags.idle == null ? 30 : Number(flags.idle);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    die("watch --interval은 0보다 큰 초여야 한다", 2);
  }
  if (!Number.isInteger(stallN) || stallN <= 0) {
    die("watch --stall은 1 이상의 정수여야 한다", 2);
  }
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
    die("watch --idle은 0보다 큰 분이어야 한다", 2);
  }
  if (flags.super === true || Array.isArray(flags.super)) {
    die("watch --super에는 역할 하나가 필요하다", 2);
  }
  if (flags.wake === true || Array.isArray(flags.wake)) {
    die("watch --wake에는 역할 하나가 필요하다", 2);
  }
  if (flags["judge-cmd"] === true || Array.isArray(flags["judge-cmd"])) {
    die("watch --judge-cmd에는 셸 명령 하나가 필요하다", 2);
  }
  const judgeCooldownMinutes =
    flags["judge-cooldown"] == null ? 5 : Number(flags["judge-cooldown"]);
  if (!Number.isFinite(judgeCooldownMinutes) || judgeCooldownMinutes <= 0) {
    die("watch --judge-cooldown은 0보다 큰 분이어야 한다", 2);
  }
  const wakeEveryMinutes =
    flags["wake-every"] == null ? 30 : Number(flags["wake-every"]);
  if (!Number.isFinite(wakeEveryMinutes) || wakeEveryMinutes <= 0) {
    die("watch --wake-every는 0보다 큰 분이어야 한다", 2);
  }

  const routeValues =
    flags.route == null
      ? []
      : Array.isArray(flags.route)
        ? flags.route
        : [flags.route];
  const routes = new Map();
  for (const value of routeValues) {
    if (typeof value !== "string" || !/^[^-=\s][^=\s]*=[^=\s]+$/.test(value)) {
      die(`잘못된 watch route: ${String(value)} (예: w1=w1-감독)`, 2);
    }
    const [board, role] = value.split("=");
    routes.set(board, role);
  }

  let parents = new Map();
  if (flags.hierarchy != null) {
    try {
      if (typeof flags.hierarchy !== "string") throw new Error("파일 경로 하나가 필요하다");
      parents = parseHierarchy(JSON.parse(fs.readFileSync(flags.hierarchy, "utf8")));
    } catch (error) {
      die(`watch hierarchy 읽기 실패: ${error.message}`, 2);
    }
  }
  const watchController=new AbortController();
  const stopWatch=()=>watchController.abort();
  process.once('SIGTERM',stopWatch);process.once('SIGINT',stopWatch);
  return runWatch({
    floor,
    readEntries: readLedger,
    readCards: () => new CardStore(ledgerHome()).list(),
    readWorks: () => new WorkStore(ledgerHome()).list(),
    startReportGraceMs: startReportMinutes*60_000,
    stallAfterMs: stallAfterMinutes*60_000,
    record: entry => appendLedger({ ...entry, t: new Date().toISOString() }),
    sendAlert: sendWatchMessage,
    resume429: (role,message,expectedPid) => {
      const session=sessionName(role);
      if(String(recordedPid(lastStartFor(session)))!==String(expectedPid))throw new Error('429 재개 세대 변경');
      guardedSend({floor,session,role,message,source:'watch',recordedPid:expectedPid});
    },
    ai: flags['judge-cmd'] ? new WatchAI({home:ledgerHome(),floor,send:sendWatchMessage}) : null,
    hierarchyPath: flags.hierarchy ? path.resolve(flags.hierarchy) : null,
    profilePath: profileFile,
    intervalMs: intervalSeconds * 1000,
    stallN,
    routes,
    superRole: flags.super || null,
    parents,
    loadHierarchy: flags.hierarchy ? () => {
      const text = fs.readFileSync(flags.hierarchy, "utf8");
      return { parents: parseHierarchy(JSON.parse(text)), path: path.resolve(flags.hierarchy), hash: createHash("sha256").update(text).digest("hex") };
    } : null,
    idleMs: idleMinutes * 60 * 1_000,
    wakeRole: flags.wake || null,
    wakeEveryMs: wakeEveryMinutes * 60 * 1_000,
    userNotify: flags["user-notify"] === true,
    judgeCmd: flags["judge-cmd"] || null,
    judgeCooldownMs: judgeCooldownMinutes * 60 * 1_000,
    signal:watchController.signal,
  }).finally(()=>{process.removeListener('SIGTERM',stopWatch);process.removeListener('SIGINT',stopWatch);});
}

function cmdStop(argv) {
  const role = argv[0];
  if (!role) die("사용법: kadan stop <역할>");
  const session = sessionName(role);
  if (!floor.alive(session)) die(`세션 없음: ${session}`);
  const pending = pendingCardsFor(readLedger(), role);
  if (pending.length > 0) {
    console.log(
      `미확정 카드 ${pending.length}건: ${pending.join(", ")} — 종료하면 화면이 사라진다. 확인했으면 kadan done ${role} <카드id> <ok|failed>`
    );
  }
  try {
    floor.stop(session);
  } catch (error) {
    die(error.message);
  }
  const windowFields = floor.name === "tmux" ? closeStartedWindow(lastStartFor(session)) : {};
  appendLedger({ ...buildStopLedgerEntry({ role, session }), ...windowFields });
  console.log(`종료됨: ${session}`);
}

function cmdStatus() {
  let sessions;
  try {
    sessions = floor.list();
  } catch (error) {
    die(error.message, error.exitCode || 1);
  }
  if (sessions.length === 0) {
    console.log(`카단 구획(${SOCKET})에 세션 없음`);
    return;
  }
  for (const item of sessions) {
    const recorded = recordedPid(lastStartFor(item.session));
    const pidState = !recorded
      ? "기록없음"
      : recorded === item.pid
        ? "PID일치"
        : `PID변경(${recorded}→${item.pid})`;
    const shown = startDisplay(lastStartFor(item.session));
    const modelBit = `  ${shown.harness} · ${shown.model} · ${shown.family}`;
    if (floor.name === "rottie") {
      console.log(
        `${item.session}  Rottie=${item.terminalId}  상태=${item.state}  ${pidState}${modelBit}`
      );
    } else {
      console.log(
        `${item.session}  ${Number(item.attached) ? "창붙음" : "백그라운드"}  시작=${new Date(
          item.created * 1000
        ).toISOString()}  ${pidState}${modelBit}`
      );
    }
  }
}

function cmdTree(_argv, flags = {}) {
  if (!flags.legacy) {
    const snapshot=loadWallSnapshot();
    if (snapshot.centerError) die(snapshot.centerError);
    const c=snapshot.center;
    console.log(JSON.stringify({summary:c.summary,executionSummary:c.executionSummary,monitoring:c.monitoring,
      boards:c.boards.map(b=>({name:b.name,state:b.state,cards:b.cards.length,unregisteredRuns:b.runs.length,monitoring:b.monitoring})),
      pendingCards:c.cards.filter(card=>!['done','cancelled','superseded','archived'].includes(card.displayState)).map(card=>({key:card.key,state:card.displayState,workType:card.workType||'execution',board:card.board,role:card.role})),
      liveRoles:c.roles.filter(r=>r.life.state==='alive').map(r=>({role:r.role,life:r.life})),
      unregisteredRuns:c.unregistered.length},null,2)); return;
  }
  let sessions;
  try {
    sessions = floor.list();
  } catch (error) {
    die(error.message, error.exitCode || 1);
  }
  const aliveBySession = Object.fromEntries(
    sessions
      .filter((item) => item.alive !== false)
      .map((item) => [item.session, item])
  );
  console.log(renderTree(buildTree(readLedger(), aliveBySession)));
}

function loadWallSnapshot() {
  const collectedAt = new Date();
  const resourceSnapshot = buildWallSnapshot({ collect: () => collectResources(spawnSync) });
  const file = ledgerPath();
  let entries = [];
  let ledgerLines = null;
  const errors = [];
  try {
    entries = readLedger();
    ledgerLines = entries.length;
  } catch (error) {
    errors.push(`원장 못 읽음(0개가 아니라 모름): ${error.message}`);
  }

  let sessions = [];
  try {
    sessions = floor.list();
  } catch (error) {
    errors.push(`생존 못 읽음(죽음이 아니라 모름): ${error.message}`);
  }
  const aliveBySession = Object.fromEntries(
    sessions
      .filter((item) => item.alive !== false)
      .map((item) => [item.session, item])
  );
  const tree=withWaitSnapshots(buildTree(entries,aliveBySession),ledgerHome());
  let center=null, centerError=null;
  try {
    if (ledgerLines===null) throw new Error("원장을 읽을 수 없어 카드 상태 모름");
    center=buildCardCenter({cards:new CardStore(ledgerHome()).list(),entries,tree,runtimeKnown:!errors.some(x=>x.startsWith("생존"))});
    center=attachWatchOverview(center,entries,{works:new WorkStore(ledgerHome()).list(),profilePath:fs.existsSync(defaultProfilePath(ledgerHome()))?defaultProfilePath(ledgerHome()):null});
  } catch(error) { centerError=error.message; }
  return {
    center,centerError,tree,
    ...resourceSnapshot,
    entries,
    version: fs.existsSync(new URL("../package.json", import.meta.url)) ? JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version : "",
    mailbox: ledgerLines === null ? null : recentSends(entries),
    cardFiles: ledgerLines === null ? {} : collectCardFiles(entries),
    collectedAt,
    ledgerPath: file,
    ledgerLines,
    error: errors.length > 0 ? errors.join(" / ") : null,
  };
}

function cmdWall(_argv, flags) {
  if (flags.help) {
    console.log("사용법: kadan wall [--port 8790]  (모든 판: 주소 뒤에 ?all=1, 카단 판정: ?judge=1)");
    return;
  }
  const rawPort = flags.port ?? "8790";
  if (
    typeof rawPort !== "string" ||
    !/^\d+$/.test(rawPort) ||
    Number(rawPort) > 65535
  ) {
    die("--port는 0부터 65535까지의 정수여야 한다");
  }
  const server = createWallServer(loadWallSnapshot, {home:ledgerHome()});
  server.on("error", (error) => {
    console.error(`오류: 관제 화면 서버 시작 실패: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(Number(rawPort), "127.0.0.1", () => {
    const address = server.address();
    console.log(
      `관제 화면: http://127.0.0.1:${address.port} (Ctrl+C로 종료)`
    );
  });
}

function cmdInit(_argv, flags) {
  if (flags.help) {
    console.log("사용법: kadan init [--runner codex|claude] [--no-skills]  (환경 확인 · 스킬 링크 · 실행기 선택, 처음 한 번)");
    return;
  }
  runInit({
    home: ledgerHome(),
    repoRoot: new URL("..", import.meta.url).pathname,
    flags,
    floorName: floor.name,
  });
}

function cmdUp(_argv, flags) {
  if (flags.help) {
    console.log("사용법: kadan up [--cmd <실행기 명령>] [--port 8790] [--hidden] [--no-prompt]  (비서 세션 + 대시보드 세션)");
    return;
  }
  if (floor.name === "tmux") requireWindowChoice();
  runUp({
    home: ledgerHome(),
    flags,
    floor,
    sessionName,
    cliPath: new URL(import.meta.url).pathname,
    start: (argv, startFlags) => cmdStart(argv, startFlags),
    send: ({ role, session, message, roleProfile }) => {
      const receipt=guardedSend({ floor, session, role, message, roleProfile, recordedPid: recordedPid(lastStartFor(session)) });
      console.log(`첫 지문 전송됨: ${session} (${receipt.bytes}B, 지문 ${receipt.digest}) — 입력 접수·AI 실행 미확인`);
    },
  });
}

function cmdRead(argv, flags) {
  const role = argv[0];
  if (!role) die("사용법: kadan read <역할> [--lines N]");
  const session = sessionName(role);
  if (!floor.alive(session)) die(`세션 없음: ${session}`);
  const lines = Number(flags.lines ?? 30);
  if (!Number.isInteger(lines) || lines < 1) {
    die("--lines는 1 이상의 정수여야 한다");
  }
  const output = tailLines(
    stripAnsi(normalizeFloorRead(floor.read(session)).text),
    lines
  );
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export function renderLogEntry(entry) {
  const subject =
    entry.kind === "done"
      ? entry.role ?? entry.session ?? entry.broken ?? ""
      : `${ledgerBy(entry)} → ${entry.role ?? entry.session ?? entry.broken ?? ""}`;
  const extra =
    entry.kind === "send"
      ? `${entry.taskId ?? "(카드 없음)"}  지문=${entry.digest} ${entry.bytes}B`
      : entry.kind === "done"
        ? `taskId=${entry.taskId} ${entry.result}`
        : entry.kind === "start"
          ? `PID=${entry.panePid ?? entry.rottiePid ?? "?"} 창=${entry.window}`
          : entry.kind.startsWith('watch-ai-')
            ? `${watchAILabel(entry.source)} ${entry.verdict ?? entry.reason ?? entry.delivery ?? ''}`
            : "";
  return `${entry.t ?? "???"}  ${entry.kind.padEnd(5)}  ${subject}  ${extra}`;
}

function cmdLog() {
  for (const entry of readLedger().slice(-30)) {
    console.log(renderLogEntry(entry));
  }
}

function cmdAttach(argv) {
  const role = argv[0];
  if (!role) die("사용법: kadan attach <역할>");
  const session = sessionName(role);
  if (!floor.alive(session)) die(`세션 없음: ${session}`);
  if (floor.name === "rottie") {
    console.log(floor.attach(session));
    return;
  }
  const windowChoice = requireWindowChoice();
  if (process.platform !== "darwin") {
    console.log(`macOS가 아니어서 창을 열지 않는다 — 직접: ${floor.attach(session)}`);
    return;
  }
  const window = openWindow(session, process.platform, {
    choice: windowChoice,
    role,
    panePid: floor.pid(session),
  });
  const name = window ? window.method : null;
  if (!name) console.log(`창 열기 실패 — 직접: ${floor.attach(session)}`);
  else console.log(`창 열림(${name}): ${session}`);
}

export function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--raw" || arg === "--hidden" || arg === "--user-notify" || arg === "--help" || arg === "--writers-stopped" || arg === "--at-boundary" || arg === "--source-ended") {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      let value;
      if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        value = argv[++index];
      } else {
        value = true;
      }
      if (Object.hasOwn(flags, name)) {
        flags[name] = Array.isArray(flags[name])
          ? [...flags[name], value]
          : [flags[name], value];
      } else {
        flags[name] = value;
      }
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

export function createHandoverRunner() {
  const operation = new Handover({ home: ledgerHome(), floor, readEntries: readLedger,
    record: entry => appendLedger({ ...entry, by: resolveLedgerBy({env:operation.env}) }),
    start: (role, command, cwd, roleProfile) => {
      let window = process.env.KADAN_WINDOW;
      if (!window) window = process.env.KADAN_ROTTIE_BIN ? "rottie" : "none";
      const result = spawnSync(process.execPath, [new URL(import.meta.url).pathname, "start", role, "--cmd", command,...(roleProfile?['--profile',roleProfile]:[])],
        {cwd, env:{...process.env,KADAN_WINDOW:window},encoding:"utf8"});
      if (result.status !== 0) throw new Error(`후임 생성 실패: ${result.stderr || result.stdout}`);
    },
    send: (role,message,expectedPid) => guardedSend({floor,session:sessionName(role),role,message,env:operation.env,
      recordedPid:expectedPid ?? recordedPid(lastStartFor(sessionName(role)))}),
    closeWindow: lastStart => closeStartedWindow(lastStart,{print:console.error}),
  });
  return new HandoverRunner(operation, {notify:(target,message) => {
    if (target.transport === "mailbox") return new SecretaryMailbox(ledgerHome()).send({
      by:resolveLedgerBy({env:operation.env}), message, category:"report"});
    if (target.transport === "user") {
      if (notifyUser(message,spawnSync)) {
        const error = new Error("사용자 알림 실패"); error.delivery = "not-sent"; throw error;
      }
      return {status:"sent"};
    }
    guardedSend({floor,session:sessionName(target.role),role:target.role,message,recordedPid:target.pid,env:operation.env});
    return {status:"sent"};
  }});
}

function cmdHandover(argv, flags) {
  const usage = "kadan handover <선임> --to <후임> --at-boundary --hierarchy <절대JSON> --context <절대문서> [--source-ended] [--cmd 명령] [--cwd 절대경로] [--manual | --wait-timeout 1800 --notify 수신자] | accept <id> --receipt <절대JSON> | finish <id> [--timeout 90] | status <id> | abort <id>";
  // 공용 옵션 해석기는 건드리지 않고 --manual의 위치만 여기서 처리한다.
  if (typeof flags.manual === "string") { argv = [flags.manual,...argv]; flags = {...flags,manual:true}; }
  if (flags.help || !argv.length) { console.log(usage); return; }
  const [first,id] = argv;
  const subcommands = {accept:["receipt"],finish:["timeout"],status:[],abort:[]};
  const allowed = new Set(Object.hasOwn(subcommands,first) ? subcommands[first] : ["to","at-boundary","source-ended","hierarchy","context","cmd","cwd","manual","wait-timeout","notify"]);
  for (const key of Object.keys(flags)) if (!allowed.has(key)) throw new Error(`handover ${first}에서 사용할 수 없는 옵션: ${key}; 자동 대기는 --wait-timeout, finish 대기는 --timeout`);
  const runner = createHandoverRunner(), operation = runner.h;
  let result;
  if (["accept","finish","status","abort"].includes(first)) {
    if (!id || argv.length !== 2) throw new Error(usage);
    if (first === "finish" && flags.timeout != null && typeof flags.timeout !== "string") throw new Error("--timeout 초 필요");
    if (first === "accept") operation.accept(id,flags.receipt);
    else if (first === "finish") result = operation.finish(id,{timeout:flags.timeout==null?90:Number(flags.timeout)});
    else if (first === "abort") result = operation.abort(id);
    result = {...runner.status(id), ...(result?.waiting ? {waiting:result.waiting} : {}), ...(result?.warning ? {warning:result.warning} : {})};
  } else {
    if (argv.length !== 1) throw new Error(usage);
    if (flags.manual && (flags["wait-timeout"] != null || flags.notify != null)) throw new Error("--manual은 --wait-timeout/--notify와 함께 사용할 수 없음");
    if (flags["wait-timeout"] != null && typeof flags["wait-timeout"] !== "string") throw new Error("--wait-timeout 초 필요");
    const config = flags.manual ? null : runner.prepare(first,{waitTimeout:flags["wait-timeout"]==null?1800:Number(flags["wait-timeout"]), notify:flags.notify});
    const state = operation.begin(first,{to:flags.to,cmd:flags.cmd,cwd:flags.cwd,hierarchy:flags.hierarchy,
      context:flags.context,atBoundary:flags["at-boundary"]===true,sourceEnded:flags["source-ended"]===true});
    result = config ? runner.start(state.id,config) : runner.status(state.id);
  }
  console.log(JSON.stringify(result,null,2));
}

const COMMANDS = {
  work:async(args,flags)=>console.log(JSON.stringify(await workCommand(args,flags,{
    home:ledgerHome(),by:resolveLedgerBy({env:process.env}),floor,
    send:({role,pid,message,taskId,workKey,executionKey,roleProfile,transmit})=>guardedSend({
      floor:{...floor,send:(name,text)=>transmit(()=>floor.send(name,text))},
      session:sessionName(role),role,message,taskId,roleProfile,recordedPid:pid,
      mailContext:{workKey,executionKey},
    }),
    observeDone:s=>{
      const observation=normalizeFloorRead(floor.read(sessionName(s.current.role)));
      if(observation.gap)throw new Error('완료 화면 출력 누락');
      const markers=diffDoneMarkers(findDoneMarkers(stripAnsi(s.baseline)),findDoneMarkers(stripAnsi(observation.text)))
        .filter(m=>m.taskId===s.current.key.split('/')[1]);
      if(new Set(markers.map(m=>m.result)).size>1)throw new Error('완료 마커 충돌');
      return markers[0]?.result||null;
    },
  }),null,2)),
  'watch-report':(args,flags)=>console.log(JSON.stringify(watchReportCommand(args,flags,{home:ledgerHome(),floor,send:sendWatchMessage}),null,2)),
  storage:(args,flags)=>console.log(JSON.stringify(storageCommand(args,flags,{home:ledgerHome()}),null,2)),
  inbox:(args,flags)=>console.log(JSON.stringify(inboxCommand(args,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})}),null,2)),
  decision: (argv,flags) => console.log(JSON.stringify(decisionCommand(argv,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})}),null,2)),
  card: (argv,flags) => console.log(JSON.stringify(cardCommand(argv,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})}),null,2)),
  handover: cmdHandover,
  plan: cmdPlan,
  init: cmdInit,
  up: cmdUp,
  start: cmdStart,
  send: cmdSend,
  done: cmdDone,
  wait: cmdWait,
  watch: cmdWatch,
  stop: cmdStop,
  status: cmdStatus,
  tree: cmdTree,
  wall: cmdWall,
  dashboard: cmdWall,
  read: cmdRead,
  log: cmdLog,
  attach: cmdAttach,
};

export function main(argv) {
  const [command, ...rest] = argv;
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(
      "사용법: kadan <init|up|plan|start|send|done|wait|watch|watch-report|stop|status|tree|wall|dashboard|read|log|attach|handover|work|card|decision|storage|inbox> [대상] [옵션]"
    );
    process.exit(command && command !== "--help" ? 1 : 0);
  }
  const { flags, rest: args } = parseFlags(rest);
  try {
    if(['init','up','start','send','stop','done','plan','watch-report'].includes(command)||command==='handover'&&!['show','list'].includes(args[0])||command==='card'&&!['list','show'].includes(args[0])||command==='decision'&&!['list','show'].includes(args[0]))assertWritable(ledgerHome());
    const result=fn(args, flags);
    if(result?.catch)return result.catch(error=>{
      console.error(`오류: ${error.message}`);
      process.exitCode=error.exitCode||1;
    });
  } catch (error) {
    console.error(`오류: ${error.message}`);
    process.exit(error.exitCode || 1);
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
if (isMain) main(process.argv.slice(2));
