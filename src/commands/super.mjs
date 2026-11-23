// kadan super — 지금 폴더의 레포 슈퍼감독을 한 마디로 연다(2026-11-23 [kyle] 요청).
// 없으면 `kadan start <레포>-슈퍼감독 --profile super`와 같은 경로로 띄우고, 있으면 `kadan attach`로 그 창을 연다.
// "있다"의 기준은 이름이 아니라 마지막 start의 roleProfile(super)과 그 start 작업 폴더의 git 최상위(realpath)다.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { floor } from "../floor.mjs";
import { ledgerHome, readLedger } from "../ledger.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import { workdirInsideHome, workdirInsideHomeMessage } from "../cli-start-support.mjs";
import { launchStart } from "../role-conversation.mjs";
import { cmdStart } from "./start.mjs";
import { cmdAttach } from "./inspect.mjs";

export const SUPER_USAGE = "사용: kadan super — 지금 폴더(git 최상위)의 레포 슈퍼감독을 연다. 없으면 `<레포>-슈퍼감독`을 --profile super로 새로 띄우고, 있으면 그 창을 연다. 인자·옵션 없음. 창·모델은 기계 설정(kadan window · kadan runners)을 따른다.";

const realOrResolved = dir => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };

// git 최상위(realpath). git 밖이면 그 폴더 자신. 경로가 비었거나 폴더가 없으면 null(소속을 모른다 — 빈 경로를 git에 넘기지 않는다).
export function gitRootOf(dir) {
  if (typeof dir !== "string" || !dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) return null;
  const env = { ...process.env };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE;
  const result = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", env });
  const top = result.status === 0 ? result.stdout.trim() : "";
  return realOrResolved(top || dir);
}

const pidOf = entry => entry?.panePid ?? entry?.rottiePid;

// 같은 이름 세션이 이 레포의 확인된 후보가 아닐 때의 이유. 판정은 이 코드로만 하고 문구로 분기하지 않는다.
export const REASON_TEXT = {
  "no-record": "원장에서 이 세션을 띄운 시작 기록을 찾지 못했다(소속 확인 불가)",
  "no-cwd": "띄운 시작 기록에 작업 폴더가 없거나 읽을 수 없다(소속 확인 불가)",
  "pid-changed": "원장의 pane PID와 지금 pane PID가 달라 같은 세대인지 확인할 수 없다(소속 확인 불가, PID 다름)",
  "other-root": "다른 폴더에서 띄운 슈퍼감독이다",
  "other-profile": "슈퍼감독 프로필(--profile super)로 띄운 세션이 아니다",
};

// 무엇을 할지만 정한다(부작용 없음, alive·livePid·rootOf는 주입 가능). action: start | attach | multiple | conflict | inside-home.
// 규칙 두 단계(2026-11-23 감독 결정):
// 1) 같은 이름 `<레포>-슈퍼감독` 세션이 바닥에 살아 있으면(원장 기록 유무와 무관) 이 레포의 확인된 후보일 때만 2)로 간다.
//    아니면 이유 코드(reason)를 정해 conflict로 멈춘다. 별칭 후보가 있든 없든 같다.
// 2) 이 레포의 확인된 후보(같은 이름 포함) 0개 → start, 1개 → attach, 2개 이상 → multiple.
// "확인된 후보" = 그 세대를 실제로 띄운 start(launchStart)가 있고, roleProfile이 super이고, 그 pane PID가 지금 pane PID와 같고,
// start cwd의 git 최상위를 읽을 수 있고 지금 최상위와 같다.
export function planSuper({ cwd, home, entries, alive, livePid = () => null, rootOf = gitRootOf }) {
  const inside = workdirInsideHome(cwd, home);
  if (inside) return { action: "inside-home", message: workdirInsideHomeMessage(inside) };
  const root = rootOf(cwd);
  const role = `${path.basename(root)}-슈퍼감독`;
  const session = sessionName(role);
  const eventsBy = new Map();
  for (const entry of entries) {
    if ((entry?.kind !== "start" && entry?.kind !== "stop") || !entry.session) continue;
    if (!eventsBy.has(entry.session)) eventsBy.set(entry.session, []);
    eventsBy.get(entry.session).push(entry);
  }
  const launched = name => {
    const events = eventsBy.get(name) ?? [];
    // 마지막 사건이 stop이면 원장상 꺼진 세대라 지금 pane이 그 세대인지 모른다.
    return events.at(-1)?.kind === "stop" ? null : launchStart(events);
  };
  // 살아 있는 세션 하나의 소속: {ok: true, start} | {ok: false, reason, start}
  const classify = (name, start) => {
    if (!start) return { ok: false, reason: "no-record", start };
    if (start.roleProfile !== "super") return { ok: false, reason: "other-profile", start };
    if (pidOf(start) == null || String(pidOf(start)) !== String(livePid(name))) return { ok: false, reason: "pid-changed", start };
    const startRoot = rootOf(start.cwd);
    if (startRoot === null) return { ok: false, reason: "no-cwd", start };
    return startRoot === root ? { ok: true, start } : { ok: false, reason: "other-root", start };
  };
  const candidates = [];
  if (alive(session)) {
    const verdict = classify(session, launched(session));
    if (!verdict.ok) return { action: "conflict", root, role, session, reason: verdict.reason, otherCwd: verdict.start?.cwd };
    candidates.push(verdict.start);
  }
  for (const name of eventsBy.keys()) {
    if (name === session) continue;
    const start = launched(name);
    if (start?.roleProfile !== "super" || !alive(name)) continue;
    const verdict = classify(name, start);
    if (verdict.ok) candidates.push(verdict.start);
  }
  if (candidates.length > 1) return { action: "multiple", root, role, matches: candidates };
  if (candidates.length === 1) return { action: "attach", root, role, target: candidates[0] };
  return { action: "start", root, role };
}

const roleOfStart = start => start.role ?? String(start.session).replace(/^kadan-/, "");

export function cmdSuper(argv, flags, deps = {}) {
  const { start = cmdStart, attach = cmdAttach, alive = name => floor.alive(name), livePid = name => floor.pid(name), cwd = process.cwd(),
    home = ledgerHome(), entries = readLedger(home), rootOf = gitRootOf } = deps;
  if (argv.length > 0 || Object.keys(flags).length > 0) die(SUPER_USAGE, 2);
  const plan = planSuper({ cwd, home, entries, alive, livePid, rootOf });
  switch (plan.action) {
    case "inside-home":
      die(plan.message, 2);
      break;
    case "multiple":
      console.error(`오류: 이 레포(${plan.root})의 슈퍼감독이 ${plan.matches.length}개 살아 있다 — 하나를 골라 직접 \`kadan attach <역할>\`로 여세요.`);
      for (const s of plan.matches) console.error(`  ${roleOfStart(s)}  (세션 ${s.session}, 시작 폴더 ${s.cwd})`);
      process.exitCode = 1;
      return;
    case "conflict": {
      const detail = plan.reason === "other-root" && plan.otherCwd ? ` (시작 폴더 ${plan.otherCwd})` : "";
      console.error(`오류: 같은 이름 ${plan.session}이 이미 살아 있지만 이 레포(${plan.root})의 슈퍼감독으로 확인되지 않는다 — ${REASON_TEXT[plan.reason]}${detail}. 붙지도 새로 띄우지도 않고 멈춘다. `
        + `확인이 끝나면 \`kadan stop ${plan.role}\`로 끄거나, 다른 이름의 폴더에서 치세요.`);
      process.exitCode = 1;
      return;
    }
    case "attach":
      return attach([roleOfStart(plan.target)]);
    default:
      return start([plan.role], { profile: "super" });
  }
}
