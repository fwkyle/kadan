// Why: 역할이 자기 세션 안에서 `kadan stop <자기 역할>`을 치면, 세션을 끄는 순간 명령 자신도 함께 죽어
// 창(탭) 닫기·지우기와 원장 기록이 일어나지 않았다(탭이 '종료됨'으로 남고 stop 기록이 없음).
// 해결: 자기 세션일 때만, 끄기부터의 뒷부분을 pane 밖의 분리된 프로세스가 한다. 순서(끄기 → 탭 닫기 → 지우기 → 기록)는 그대로다.
// - 자기 세션 판정은 프로세스 조상으로 한다(이 프로세스가 pane PID의 자손인가). KADAN_ROLE·TMUX_PANE은 넘겨받은 프로세스도
//   물려받으므로 판정에 쓰지 않는다. 넘겨받은 쪽(runSelfStopTail)은 판정 자체를 하지 않아 다시 넘기는 고리가 없다.
// - 숨은 인자 `--self-stop-tail`은 일반 `kadan stop <역할>`보다 힘이 세면 안 된다. 받는 값은 역할과 앞쪽 PID뿐이고,
//   세션 이름·기반 프로세스 여부·시작 기록·기대 pane PID·by는 넘겨받은 쪽이 원장·바닥·환경에서 다시 정한다.
//   끄기는 일반 stop과 같은 `stopRole`(생존·주인·카드·업무·멈춤 표시·끄기 직전 소유 재확인)을 그대로 거친다.
// - 넘겨받은 프로세스는 새 세션(setsid)으로 떼고, 입출력은 파이프가 아니라 로그 파일로 보낸다.
//   끄기 직전에 pane 트리 밖인지 확인하고, `ps` 표를 못 읽거나 아직 pane 안이면 끄지 않는다(멈춤 표시는 stopRole이 되돌린다).
// 비용: 원장 추가 읽기 없음(자기 종료만 넘겨받은 쪽의 `stopRole`이 일반 stop만큼 읽는다). 판정은 `ps` 한 번이다.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { floor as defaultFloor } from "./floor.mjs";
import { stopRole } from "./role-stop.mjs";

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const MAX_DEPTH = 64;
const PARENT_WAIT_MS = 5000;
const PS_TIMEOUT_MS = 2000;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// pid → {ppid, pgid}. 읽지 못하거나(실패·시간 초과·해석 불가) 한 줄도 해석하지 못하면 null(= 모름).
export function readProcessTable({ spawnFn = spawnSync, timeout = PS_TIMEOUT_MS } = {}) {
  try {
    const result = spawnFn("ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8", timeout });
    if (result.error || result.status !== 0) return null;
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
// 표를 못 읽으면 판정하지 못하므로 false다(앞쪽은 예전 길로 간다. 넘겨받은 쪽은 표 없음을 따로 거절한다).
export function isInPaneTree(panePid, { table = readProcessTable(), pid = process.pid } = {}) {
  const pane = Number(panePid);
  if (!Number.isInteger(pane) || pane <= 1 || !table) return false;
  return pid === pane || ancestorsOf(pid, table).includes(pane);
}

// 로그 위치는 세션 이름과 앞쪽 PID로 정해진다. 앞쪽(입출력 연결)과 넘겨받은 쪽(줄 기록)이 같은 계산으로 같은 파일을 쓴다.
export function selfStopLogPath(home, session, parentPid) {
  return path.join(home, "diagnostics", `self-stop-${session}-${parentPid}.log`);
}

// 앞쪽 프로세스가 부른다: 분리된 프로세스를 띄우고 로그 경로를 돌려준다. 넘기는 값은 역할과 앞쪽 PID뿐이다.
export function handoffSelfStop({ home, role, session }, deps = {}) {
  const { spawnFn = spawn, execPath = process.execPath, env = process.env } = deps;
  const logPath = selfStopLogPath(home, session, process.pid);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "a", 0o600);
  try {
    const first = { t: new Date().toISOString(), step: "handoff", pid: process.pid, role, session };
    fs.writeSync(fd, JSON.stringify(first) + "\n");
    const body = JSON.stringify({ role, parentPid: process.pid });
    const child = spawnFn(execPath, [CLI, "stop", role, "--self-stop-tail", body],
      { detached: true, stdio: ["ignore", fd, fd], env });
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

// 넘겨받은 프로세스의 본체(`kadan stop <역할> --self-stop-tail <JSON>`). role·session은 명령 인자에서 온 값이고
// body에서는 parentPid만 읽는다(body.role은 명령의 역할과 같아야 한다). 어떤 실패도 로그에 남긴다.
export function runSelfStopTail(body, { role, session, home }, deps = {}) {
  const { floor = defaultFloor, waitMs = PARENT_WAIT_MS, readTable = readProcessTable, stop = stopRole } = deps;
  const parentPid = body?.parentPid;
  const logPath = Number.isInteger(parentPid) && parentPid > 1 ? selfStopLogPath(home, session, parentPid) : null;
  const write = line => {
    if (!logPath) return;
    const row = JSON.stringify({ t: new Date().toISOString(), ...line }) + "\n";
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.appendFileSync(logPath, row, { mode: 0o600 }); }
    catch { /* 로그를 못 써도 일반 stop과 같은 확인은 계속한다 */ }
  };
  const abort = message => { write({ step: "error", message }); return { ok: false, message }; };
  if (!logPath) return abort("앞쪽 PID가 올바르지 않아 끄지 않았다");
  if (body.role !== role) return abort(`명령의 역할(${role})과 넘겨받은 역할(${body.role})이 달라 끄지 않았다`);
  // 앞쪽이 끝날 때까지 기다린다(끝내 안 끝나면 pane 트리 안에서 끄게 되므로 하지 않는다).
  const until = Date.now() + waitMs;
  while (!parentGone(parentPid) && Date.now() < until) sleep(20);
  if (!parentGone(parentPid)) return abort(`앞쪽 명령(${parentPid})이 끝나지 않아 끄지 않았다`);
  // 끄기 직전 확인(stopRole이 소유 재확인 바로 앞에서 부른다). 던지면 stopRole이 멈춤 표시를 되돌리고 끄지 않는다.
  const beforeStop = () => {
    const table = readTable();
    if (!table) throw new Error("ps 표를 읽지 못해 pane 밖인지 확인하지 못했다 — 끄지 않았다");
    const panePid = floor.pid(session);
    const inPaneTree = isInPaneTree(panePid, { table });
    write({
      step: "before-stop", pid: process.pid, ppid: process.ppid, pgid: table.get(process.pid)?.pgid ?? null,
      panePid: Number(panePid) || null, ancestors: ancestorsOf(process.pid, table), inPaneTree,
    });
    if (inPaneTree) throw new Error("분리된 프로세스가 아직 pane 안에 있어 끄지 않았다");
  };
  const text = step => line => write({ step, text: String(line) });
  try {
    const result = stop({ role, session, home, floor, log: text("out"), warn: text("warn"), beforeStop, selfStop: null });
    write({ step: "done", ok: result.ok, windowIncomplete: Boolean(result.windowIncomplete), message: result.message });
    return result;
  } catch (error) { return abort(error.message); }
}
