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
import { cmdStart } from "./start.mjs";
import { cmdAttach } from "./inspect.mjs";

export const SUPER_USAGE = "사용: kadan super — 지금 폴더(git 최상위)의 레포 슈퍼감독을 연다. 없으면 `<레포>-슈퍼감독`을 --profile super로 새로 띄우고, 있으면 그 창을 연다. 인자·옵션 없음. 창·모델은 기계 설정(kadan window · kadan runners)을 따른다.";

const realOrResolved = dir => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };

// git 최상위(realpath). git 밖이거나 폴더가 없으면 그 폴더 자신.
export function gitRootOf(dir) {
  const env = { ...process.env };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE;
  const result = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", env });
  const top = result.status === 0 ? result.stdout.trim() : "";
  return realOrResolved(top || dir);
}

// 무엇을 할지만 정한다(부작용 없음, alive·rootOf는 주입 가능). action: start | attach | multiple | conflict | inside-home.
export function planSuper({ cwd, home, entries, alive, rootOf = gitRootOf }) {
  const inside = workdirInsideHome(cwd, home);
  if (inside) return { action: "inside-home", message: workdirInsideHomeMessage(inside) };
  const root = rootOf(cwd);
  const role = `${path.basename(root)}-슈퍼감독`;
  const session = sessionName(role);
  const lastStart = new Map();
  for (const entry of entries) if (entry?.kind === "start" && entry.session) lastStart.set(entry.session, entry);
  const matches = [];
  for (const [name, start] of lastStart) {
    if (start.roleProfile !== "super" || !alive(name)) continue;
    if (rootOf(typeof start.cwd === "string" ? start.cwd : "") === root) matches.push(start);
  }
  if (matches.length > 1) return { action: "multiple", root, role, matches };
  if (matches.length === 1) return { action: "attach", root, role, target: matches[0] };
  if (alive(session)) return { action: "conflict", root, role, session, other: lastStart.get(session) ?? null };
  return { action: "start", root, role };
}

const roleOfStart = start => start.role ?? String(start.session).replace(/^kadan-/, "");

export function cmdSuper(argv, flags, deps = {}) {
  const { start = cmdStart, attach = cmdAttach, alive = name => floor.alive(name), cwd = process.cwd(),
    home = ledgerHome(), entries = readLedger(home), rootOf = gitRootOf } = deps;
  if (argv.length > 0 || Object.keys(flags).length > 0) die(SUPER_USAGE, 2);
  const plan = planSuper({ cwd, home, entries, alive, rootOf });
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
      const why = plan.other?.roleProfile === "super"
        ? `다른 폴더(${plan.other.cwd})에서 띄운 슈퍼감독이다`
        : "슈퍼감독 프로필(--profile super)로 띄운 세션이 아니다";
      console.error(`오류: 같은 이름 ${plan.session}이 이미 살아 있지만 이 레포(${plan.root})의 슈퍼감독이 아니다 — ${why}. 붙지 않고 멈춘다. `
        + `폴더 이름만 같은 다른 레포라면 그쪽을 먼저 끄거나(\`kadan stop ${plan.role}\`) 이름이 다른 폴더에서 치세요.`);
      process.exitCode = 1;
      return;
    }
    case "attach":
      return attach([roleOfStart(plan.target)]);
    default:
      return start([plan.role], { profile: "super" });
  }
}
