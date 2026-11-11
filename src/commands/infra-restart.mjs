// `kadan restart watch|대시보드`의 실제 연결(본체는 ../infra-restart.mjs). 시작은 `kadan up`·되살리기와 같은 함수를 쓴다.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome } from "../ledger.mjs";
import { sessionName, die } from "../cli-basics.mjs";
import { restartInfra, INFRA_RESTART_TARGETS } from "../infra-restart.mjs";
import { dashboardCommand, ensureWatch, DASHBOARD_ROLE } from "../quickstart.mjs";
import { cmdStart } from "./start.mjs";
import { reviveOps, startWatchSession } from "./quickstart.mjs";
import { installedWorkingDirectory } from "../autostart.mjs";
import { readWatchProcesses } from "../watch-overview.mjs";
import { watchProcessName } from "../watch-system.mjs";
import { buildStopLedgerEntry } from "../cli-start-support.mjs";

const CLI = new URL("../cli.mjs", import.meta.url).pathname;
const CODE_ROOT = new URL("../..", import.meta.url).pathname;

// 새 프로세스가 launchd 되살리기와 같은 바탕에서 뜨게 한다: 부른 역할의 신원·창·tmux 표시·작업 폴더를 넘기지 않는다.
// 되살리기(`kadan up --hidden --auto`)가 쓰는 값(KADAN_WINDOW=none, KADAN_WINDOW_FORCE=1, plist의 WorkingDirectory)을 그대로 쓴다.
export function normalizeForRevive({ env = process.env, chdir = (dir) => process.chdir(dir), workdir = installedWorkingDirectory() ?? CODE_ROOT } = {}) {
  for (const name of ["KADAN_ROLE", "KADAN_PANE_SOCKET", "TMUX", "TMUX_PANE", "KADAN_RESTART_REASON", "KADAN_RESTART_EXPECT_PID"]) delete env[name];
  env.KADAN_WINDOW = "none";
  env.KADAN_WINDOW_FORCE = "1";
  chdir(workdir);
  return workdir;
}

// cmdStart는 실패하면 die()로 프로세스를 끝낸다. 재시작은 끈 뒤 실패를 알리고 기록해야 하므로 그 종료를 오류로 바꿔 받는다.
export function callWithoutExit(fn, exit = process) {
  const real = exit.exit;
  exit.exit = (code) => { throw new Error(`시작 명령이 종료 코드 ${code ?? 1}로 끝남(위 오류 출력 참고)`); };
  try { return fn(); } finally { exit.exit = real; }
}

// 이 프로세스가 대상 세션의 pane 프로세스 아래에서 돌고 있는지: true/false, 판정 못 하면 null.
export function insideSession(target, { pidOf = (s) => floor.pid(s), alive = (s) => floor.alive(s), parentOf = defaultParentOf, self = process.pid } = {}) {
  try {
    const session = sessionName(target);
    if (!alive(session)) return false;
    const pane = Number(pidOf(session));
    if (!Number.isInteger(pane) || pane <= 0) return null;
    for (let pid = self, hops = 0; pid > 1 && hops < 64; hops++) {
      if (pid === pane) return true;
      const parent = parentOf(pid);
      if (!Number.isInteger(parent)) return null;
      pid = parent;
    }
    return false;
  } catch { return null; }
}
function defaultParentOf(pid) {
  const r = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  const n = Number(String(r.stdout ?? "").trim());
  return r.status === 0 && Number.isInteger(n) ? n : NaN;
}

export function infraDeps(home) {
  const ops = reviveOps(home);
  const flags = {};
  const { port } = dashboardCommand({ home, flags, cliPath: CLI });
  return {
    stop: (target) => {
      const session = sessionName(target);
      if (!floor.alive(session)) return;
      floor.stop(session);
      // 대시보드는 start 기록이 있는 세션이라 stop 기록을 남긴다(감시기는 원래 기록이 없다). 멈춤 표시는 남기지 않는다.
      if (target === DASHBOARD_ROLE) appendLedger({ ...buildStopLedgerEntry({ role: target, session }), restart: true, reason: "infra-restart" }, home);
    },
    start: (target) => {
      normalizeForRevive();
      if (target === "watch") return startWatchSession(home);
      const { cmd } = dashboardCommand({ home, flags, cliPath: CLI });
      callWithoutExit(() => cmdStart([DASHBOARD_ROLE], { cmd, hidden: true }));
      return "started";
    },
    insideTarget: (target) => insideSession(target),
    // 살아 있으면 프로세스 표식(같은 표식이 안정 구간 뒤에도 보여야 성공), 아니면 null.
    verify: async (target) => {
      const session = sessionName(target);
      if (!floor.alive(session)) return null;
      if (target === "watch") { const procs = readWatchProcesses(spawnSync, watchProcessName(home)); return procs.length ? procs.map((p) => p.pid).sort().join(",") : null; }
      try {
        const base = `http://127.0.0.1:${port}`;
        const status = await fetch(`${base}/api/dashboard/status`, { signal: AbortSignal.timeout(3000) });
        const page = await fetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
        return status.ok && page.status !== 503 ? String(floor.pid(session)) : null;
      } catch { return null; }
    },
    notify: (message, opts) => ops.notify(message, opts),
    record: (entry) => appendLedger(entry, home),
  };
}

export async function cmdRestartInfra(target, flags) {
  if (!INFRA_RESTART_TARGETS.includes(target)) die(`재시작 대상이 아님: ${target}`, 2);
  const extra = Object.keys(flags);
  if (extra.length) die(`kadan restart ${target}는 옵션을 받지 않는다(받은 옵션: ${extra.map((k) => `--${k}`).join(" ")})`, 2);
  const home = ledgerHome();
  const byRole = String(process.env.KADAN_ROLE ?? "").trim() || null;
  const waitMs = Number(process.env.KADAN_INFRA_RESTART_WAIT_MS);
  const result = await restartInfra({ home, target, byRole, deps: infraDeps(home), ...(Number.isFinite(waitMs) && waitMs >= 0 && process.env.KADAN_INFRA_RESTART_WAIT_MS !== undefined ? { waitMs } : {}) });
  (result.ok ? console.log : console.error)(result.message);
  if (!result.ok) process.exitCode = result.code;
}
