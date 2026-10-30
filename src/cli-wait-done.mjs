// plan 카드 입력·done 확정·wait 반복·대기 화면 저장 (HW-3-impl: cli.mjs에서 옮김)
import { findDoneMarkers, diffDoneMarkers } from "./done-marker.mjs";
import { hookDoneSince } from "./stop-hook-spool.mjs";
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
  via = null, // 어느 길로 읽은 완료인지(hook·screen). 사람이 직접 준 결과는 비운다
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
    ...(via ? { via } : {}),
  };
  record(entry);
  return entry;
}

// 완료 통지 뒤 감독이 작업자 화면의 DONE을 대조해 확정한다(2026-09-27 [kyle]: 감독이 만든 확인 스크립트가
// 짧은 카드id 마커를 못 알아봐 재출력 요청을 반복했다). 그 카드를 그 역할에 보낸 마지막 발령 때 화면에 있던 마커는 빼고,
// 짧은 id·정식 주소 어느 쪽이든 같은 카드로 읽는다. 여러 줄이면 마지막 줄의 결과를 쓴다. 없으면 null이다.
// 훅 증거를 쓸 때의 '같은 카드' 조건 하나. watch·from-screen·wait가 모두 이 규칙(짧은 id·정식 주소 같은 카드)을 쓴다.
export function hookTaskMatcher({ cards = [], dispatch }) {
  if (!dispatch?.taskId) return null;
  const identity = taskIdentity(cards);
  const target = (id, executionKey) => {
    const found = identity.resolve(id, executionKey);
    return found.state === "resolved" ? found.key : String(id ?? "").split("/").pop();
  };
  const want = target(dispatch.taskId, dispatch.executionKey);
  return id => target(id) === want;
}

// hookHome이 있으면 먼저 Stop 훅 증거(같은 역할·같은 카드·그 발령 뒤)를 본다. 없으면 화면 판정이다. via = 어느 길로 읽었는지.
export function screenDoneResult({ text, entries = [], role, taskId, cards = [], hookHome = null }) {
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
  const hooked = hookHome && dispatch?.t
    ? hookDoneSince({ home: hookHome, role: session.slice("kadan-".length), since: dispatch.t, taskMatches: hookTaskMatcher({ cards, dispatch }) })
    : [];
  if (hooked.length) return { result: hooked.at(-1).result, dispatch, count: hooked.length, via: "hook" };
  return { result: markers.at(-1)?.result ?? null, dispatch: dispatch ?? null, count: markers.length };
}

function lastPerTask(markers, keyOf) {
  const last = new Map();
  markers.forEach((marker, index) => last.set(keyOf(marker), index));
  return markers.filter((marker, index) => last.get(keyOf(marker)) === index);
}

// 같은 카드의 마커가 여럿이면 원장에 기록한 마지막 결과 하나만 줄로 보이고, 결과가 다른 앞 결과만 바뀐 것으로 밝힌다(같은 결과 반복은 문구 없음).
export const waitMarkerLines = (final) => final.map(({ taskId, result, earlier }) => {
  const changed = [...new Set(earlier.filter(value => value !== result))];
  return `완료 마커: taskId=${taskId} 결과=${result}${changed.length ? ` (앞선 결과 ${changed.join("·")}는 나중 결과로 바뀜)` : ""}`;
});

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
  hook = null, // {home, since, taskMatches}: 이 시각 뒤 같은 역할·같은 카드의 Stop 훅 DONE 증거를 화면보다 먼저 본다
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
    // 마지막 증거 하나만 쓴다 — 다른 소비처(watch·from-screen)와 같은 최종 의미다. 카드 조건이 없으면 훅 증거를 쓰지 않는다.
    const hooked = hook ? hookDoneSince({ home: hook.home, role: session.slice("kadan-".length), since: hook.since,
      taskMatches: hook.taskMatches }).slice(-1) : [];
    const fresh = hooked.length ? hooked.map(({ taskId, result }) => ({ taskId, result })) : diffDoneMarkers(
      baseline,
      findDoneMarkers(stripAnsi(accumulated))
    );
    if (fresh.length === 0) return null;
    const identity=taskIdentity(cards ?? (snapshotHome?new CardStore(snapshotHome).listSummaries():[]));
    // 화면에 같은 카드의 마커가 여럿이면 카드별 마지막 하나만 기록한다 — screenDoneResult(from-screen)와 같은 의미다.
    const identified=fresh.map(marker=>({...marker,...identity.write(marker.taskId)}));
    const keyOf=m=>m.executionKey??m.taskId;
    const resolved=lastPerTask(identified,keyOf);
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
        via: hooked.length ? "hook" : "screen",
      });
    }
    // 출력용: 카드마다 기록한 최종 결과 하나와, 그 앞에서 나중 결과로 바뀐 결과들(기록 루프와 무관).
    const final = resolved.map(({ taskId, result }, i) => ({ taskId, result,
      earlier: identified.filter(m => keyOf(m) === keyOf(resolved[i]) && m !== resolved[i]).map(m => m.result) }));
    return { code: 0, reason: "done", markers: fresh, final, via: hooked.length ? "hook" : "screen" };
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
export function waitScreenDone({ readScreen, entries, role, taskId, cards, hookHome = null, waitMs = 0, intervalMs = 2000, sleep = (ms) => sleepMs(ms), now = Date.now }) {
  const deadline = now() + Math.max(0, waitMs);
  let found = screenDoneResult({ text: readScreen(), entries, role, taskId, cards, hookHome }), reads = 1;
  while (!found.result && now() < deadline) {
    sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
    found = screenDoneResult({ text: readScreen(), entries, role, taskId, cards, hookHome }); reads++;
  }
  return { ...found, reads };
}
