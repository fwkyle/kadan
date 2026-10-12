// plan 카드 입력·done 확정·wait 반복·대기 화면 저장 (HW-3-impl: cli.mjs에서 옮김)
import { findDoneMarkers, diffDoneMarkers } from "./done-marker.mjs";
import { taskIdentity, taskConnectionError } from "./task-identity.mjs";
import { CardStore } from "./card-store.mjs";
import { workEntries } from "./handover-state.mjs";
import fs from "node:fs";
import path from "node:path";
import { floor } from "./floor.mjs";
import { appendLedger, ledgerHome, resolveLedgerBy } from "./ledger.mjs";
import {
  sessionName,
  stripAnsi,
  tailLines,
  digest,
  normalizeFloorRead,
  sleepMs,
} from "./cli-basics.mjs";

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

export function parsePlanCard(item) {
  if (typeof item !== "string") return { taskId: item };
  const index = item.indexOf(":");
  if (index === -1) return { taskId: item };
  const title = item.slice(index + 1).trim();
  return { taskId: item.slice(0, index), ...(title ? { title } : {}) };
}

export function planCards({ board, taskIds, about = null, env = process.env, record = appendLedger, cards = null }) {
  const valid = value => typeof value === "string" && /^\S+$/.test(value);
  const planned = Array.isArray(taskIds) ? taskIds.map(parsePlanCard) : [];
  if (!valid(board) || planned.length === 0 ||
      !planned.every(card => valid(card.taskId)) ||
      new Set(planned.map(card => card.taskId)).size !== planned.length) {
    const error = new Error("판과 카드 id는 공백 없는 문자열이어야 하며 카드 중복은 허용하지 않는다");
    error.exitCode = 2;
    throw error;
  }
  const identity=taskIdentity(cards ?? new CardStore(env.KADAN_HOME||env.KADAN_LITE_HOME||ledgerHome()).listSummaries());
  const resolved=planned.map(card=>({...card,...identity.write(card.taskId)}));
  if(new Set(resolved.map(c=>c.executionKey||c.taskId)).size!==resolved.length)throw new Error('같은 카드의 별칭을 중복 계획할 수 없습니다');
  const boardAbout = typeof about === "string" && about.trim() ? about.trim() : null;
  for (const { taskId, title, executionKey, rawTaskId } of resolved) {
    record({
      kind: "plan",
      board,
      taskId,
      ...(executionKey?{executionKey}:{}),
      ...(rawTaskId?{rawTaskId}:{}),
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
  cards = null,
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
  const identity=taskIdentity(cards ?? new CardStore(env.KADAN_HOME||env.KADAN_LITE_HOME||ledgerHome()).listSummaries());
  const address=identity.write(taskId);
  entries=workEntries(entries,identity);
  if (
    entries.some(
      (entry) =>
        entry?.kind === "done" &&
        entry.role === role &&
        entry.taskId === address.taskId && !taskConnectionError(entry)
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
    ...address,
    result,
  };
  record(entry);
  return entry;
}

// 완료 통지 뒤 감독이 작업자 화면의 DONE을 대조해 확정한다(2026-09-27 [kyle]: 감독이 만든 확인 스크립트가
// 짧은 카드id 마커를 못 알아봐 재출력 요청을 반복했다). 그 카드를 그 역할에 보낸 마지막 발령 때 화면에 있던 마커는 빼고,
// 짧은 id·정식 주소 어느 쪽이든 같은 카드로 읽는다. 여러 줄이면 마지막 줄의 결과를 쓴다. 없으면 null이다.
export function screenDoneResult({ text, entries = [], role, taskId, cards = [] }) {
  const identity = taskIdentity(cards);
  const target = (id, executionKey) => {
    const found = identity.resolve(id, executionKey);
    return found.state === "resolved" ? found.key : String(id ?? "").split("/").pop();
  };
  const want = target(taskId);
  const session = sessionName(role);
  const dispatch = entries.filter((e) => e?.kind === "send" && e.session === session && e.taskId && target(e.taskId, e.executionKey) === want).at(-1);
  const markers = diffDoneMarkers(dispatch?.baselineMarkers ?? [], findDoneMarkers(stripAnsi(text)))
    .filter((m) => target(m.taskId) === want);
  return { result: markers.at(-1)?.result ?? null, dispatch: dispatch ?? null, count: markers.length };
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
  cards = null,
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
    const identity=taskIdentity(cards ?? (snapshotHome?new CardStore(snapshotHome).listSummaries():[]));
    const resolved=fresh.map(marker=>({...marker,...identity.write(marker.taskId)}));
    for (const marker of resolved) {
      record({
        kind: "done",
        floor: selectedFloor.name,
        role,
        session,
        taskId: marker.taskId,
        ...(marker.executionKey?{executionKey:marker.executionKey}:{}),
        ...(marker.rawTaskId?{rawTaskId:marker.rawTaskId}:{}),
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

// --from-screen --wait <초>: 완료 편지가 화면 마커보다 먼저 도착하는 구조(응답 중간의 send, 응답 마지막 줄의 마커)라
// 감독이 바로 확정하면 종료코드 3이 나고 15분 뒤 완료후보로 다시 깨어난다(2026-10-05 점검 보고서 1-H1).
// 프로그램이 짧은 간격으로 화면만 다시 읽는 유한 대기다. 시간이 다 되면 종료코드 3은 그대로이며 완료후보 감시도 그대로다.
export function waitScreenDone({ readScreen, entries, role, taskId, cards, waitMs = 0, intervalMs = 2000, sleep = (ms) => sleepMs(ms), now = Date.now }) {
  const deadline = now() + Math.max(0, waitMs);
  let found = screenDoneResult({ text: readScreen(), entries, role, taskId, cards }), reads = 1;
  while (!found.result && now() < deadline) {
    sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
    found = screenDoneResult({ text: readScreen(), entries, role, taskId, cards }); reads++;
  }
  return { ...found, reads };
}
