// Why: 역할이 자기 세션 안에서 `kadan stop <자기 역할>`을 치면, 세션을 끄는 순간 명령 자신도 함께 죽어
// 창(탭) 닫기·지우기와 원장 기록이 일어나지 않았다(탭이 '종료됨'으로 남고 stop 기록이 없음).
// 해결: 자기 세션일 때만 끄기부터의 뒷부분을 pane 밖의 분리된 프로세스가 한다. 순서(끄기 → 탭 닫기 → 지우기 → 기록)는 그대로다.
// - 자기 세션 판정은 프로세스 조상으로 한다(이 프로세스가 pane PID의 자손인가). KADAN_ROLE·TMUX_PANE은 넘겨받은 프로세스도
//   물려받으므로 판정에 쓰지 않는다. 넘겨받은 쪽(runSelfStopTail)은 판정 자체를 하지 않아 다시 넘기는 고리가 없다.
// - 넘겨받은 프로세스는 새 세션(setsid)으로 떼고, 입출력은 파이프가 아니라 로그 파일로 보내며, 앞쪽이 끝난 것을 확인한 뒤
//   끄기 직전에 자기 조상 사슬에 pane이 없음을 로그에 남긴다.
// 비용: 원장 추가 읽기 없음. 판정은 `ps` 한 번이다(조상 사슬은 그 출력 표에서 따라간다).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { floor as defaultFloor } from "./floor.mjs";
import { unmarkStopped, acquireReviveLock, lockWaitMs, reclaimLog, legacyLog } from "./revive.mjs";
import { stopTail } from "./role-stop.mjs";

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const MAX_DEPTH = 64;
const PARENT_WAIT_MS = 5000;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// pid → {ppid, pgid}. 읽지 못하거나 한 줄도 해석하지 못하면 null(= 모름).
export function readProcessTable({ spawnFn = spawnSync } = {}) {
  try {
    const result = spawnFn("ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8" });
    const table = new Map();
    for (const line of String(result.stdout ?? "").split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]) });
    }
    return table.size > 0 ? table : null;
  } catch { return null; }
}

// pid의 부모 사슬(pid 자신은 뺀다). 1(launchd)·표에 없는 곳·고리에서 멈춘다.
export function ancestorsOf(pid, table) {
  const chain = [];
  const seen = new Set([Number(pid)]);
  let current = Number(pid);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const row = table?.get(current);
    if (!row || row.ppid <= 0 || seen.has(row.ppid)) break;
    chain.push(row.ppid);
    if (row.ppid === 1) break;
    seen.add(row.ppid);
    current = row.ppid;
  }
  return chain;
}

// 이 프로세스가 끄려는 세션의 pane 프로세스(또는 그 자손)인가. pane PID가 숫자가 아니거나 1 이하면(모든 프로세스가 1의 자손) 아니다.
export function isInPaneTree(panePid, { table = readProcessTable(), pid = process.pid } = {}) {
  const pane = Number(panePid);
  if (!Number.isInteger(pane) || pane <= 1 || !table) return false;
  return pid === pane || ancestorsOf(pid, table).includes(pane);
}

// 앞쪽 프로세스가 부른다: 넘길 값을 정리해 분리된 프로세스를 띄우고 로그 경로를 돌려준다.
export function handoffSelfStop(payload, deps = {}) {
  const { spawnFn = spawn, execPath = process.execPath, env = process.env, now = Date.now } = deps;
  const { home, role, session, owner } = payload;
  const dir = path.join(home, "diagnostics");
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `self-stop-${session}-${now()}.log`);
  const fd = fs.openSync(logPath, "a", 0o600);
  try {
    const body = {
      role, session, logPath, parentPid: process.pid, infrastructure: payload.infrastructure, by: payload.by,
      // 주인 확인에 필요한 값만 넘긴다(시작 기록 전체는 넘기지 않는다).
      owner: {
        role: owner.role, session: owner.session, revive: owner.revive ? {} : null,
        start: owner.start ? { panePid: owner.start.panePid, rottiePid: owner.start.rottiePid } : null,
      },
      marked: payload.marked, conversation: payload.conversation, owned: payload.owned,
    };
    const first = { t: new Date().toISOString(), step: "handoff", pid: process.pid, role, session };
    fs.writeSync(fd, JSON.stringify(first) + "\n");
    const args = [CLI, "stop", role, "--self-stop-tail", JSON.stringify(body)];
    const child = spawnFn(execPath, args, { detached: true, stdio: ["ignore", fd, fd], env });
    child.on?.("error", () => {});
    if (!child.pid) throw new Error("분리된 프로세스를 띄우지 못했다");
    child.unref();
    return { logPath };
  } finally { fs.closeSync(fd); }
}

// cmdStop에 넣는 짝: 판정과 넘기기.
export function createSelfStop(home, deps = {}) {
  return {
    isSelf: panePid => isInPaneTree(panePid, deps.table ? { table: deps.table } : {}),
    handoff: payload => handoffSelfStop({ ...payload, home }, deps),
  };
}

// 앞쪽이 끝났는가: 부모가 없어졌거나(ESRCH), 부모가 바뀌었다(앞쪽이 끝나 reparent됨 — 회수 전 좀비는 kill 0이 성공한다).
const parentGone = parentPid => {
  if (process.ppid !== parentPid) return true;
  try { process.kill(parentPid, 0); return false; } catch (error) { return error.code !== "EPERM"; }
};

// 넘겨받은 프로세스의 본체(`kadan stop <역할> --self-stop-tail <JSON>`).
// 어떤 실패도 로그에 남기고, 끄기가 실패하면 멈춤 표시를 되돌린다. 자기 세션 판정은 하지 않는다(다시 넘기지 않는다).
export function runSelfStopTail(body, { home, floor = defaultFloor, waitMs = PARENT_WAIT_MS, readTable = readProcessTable } = {}) {
  const { role, session, logPath, parentPid, infrastructure, owner, marked, conversation, owned, by } = body;
  const write = line => {
    const row = JSON.stringify({ t: new Date().toISOString(), ...line }) + "\n";
    try { fs.appendFileSync(logPath, row); } catch { /* 로그를 못 써도 정리는 계속한다 */ }
  };
  let release = () => {};
  const rollback = () => {
    if (!marked) return;
    try { unmarkStopped(home, role, marked); }
    catch (error) { write({ step: "error", message: `멈춤 표시를 되돌리지 못했다: ${error.message}` }); }
  };
  const abort = message => { rollback(); release(); write({ step: "error", message }); return { ok: false, message }; };
  try {
    // 앞쪽이 끝날 때까지 기다린다(끝내 안 끝나면 pane 트리 안에서 끄게 되므로 하지 않는다).
    const until = Date.now() + waitMs;
    while (!parentGone(parentPid) && Date.now() < until) sleep(20);
    if (!parentGone(parentPid)) return abort(`앞쪽 명령(${parentPid})이 끝나지 않아 끄지 않았다`);
    if (infrastructure) {
      const lock = acquireReviveLock(home, { waitMs: lockWaitMs(), onReclaim: reclaimLog, onLegacy: legacyLog });
      if (!lock) return abort("자동 되살리기 잠금을 잡지 못해 끄지 않았다");
      release = lock;
    }
    const panePid = floor.pid(session);
    const table = readTable();
    const inPaneTree = isInPaneTree(panePid, { table });
    write({
      step: "before-stop", pid: process.pid, ppid: process.ppid, pgid: table?.get(process.pid)?.pgid ?? null,
      panePid: Number(panePid) || null, ancestors: ancestorsOf(process.pid, table), inPaneTree,
    });
    if (inPaneTree) return abort("분리된 프로세스가 아직 pane 안에 있어 끄지 않았다");
    const refuse = message => { release(); write({ step: "refused", message }); return { ok: false, code: 1, message }; };
    const text = step => line => write({ step, text: String(line) });
    const result = stopTail({
      role, session, home, floor, owner, infrastructure, marked, conversation, owned, refuse, release,
      log: text("out"), warn: text("warn"), env: { KADAN_ROLE: by },
    });
    write({ step: "done", ok: result.ok, windowIncomplete: Boolean(result.windowIncomplete), message: result.message });
    return result;
  } catch (error) { return abort(error.message); }
}
