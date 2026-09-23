// 새 역할을 만들면 만든 사람(감독)을 상위로 관계표에 적는다.
// 사람이 기억해서 한 줄 넣는 습관에 기대지 않기 위한 것이다 (2026-09-11 [kyle] 지시).
// 추가만 하고 기존 줄은 고치거나 지우지 않는다. 조금이라도 불확실하면 건너뛴다.
import fs from "node:fs";
import path from "node:path";
import { ledgerHome, readLedger } from "./ledger.mjs";
import { parseHierarchy } from "./hierarchy.mjs";
import { commandWords } from "./ai-identity.mjs";

// 감시기가 실제로 읽고 있는 관계표 경로. 원장의 마지막 hierarchy-loaded가 원본이다.
export function activeHierarchyPath(entries) {
  const loaded = entries
    .filter((entry) => entry?.kind === "hierarchy-loaded" && typeof entry.path === "string" && entry.path)
    .at(-1);
  return loaded?.path ?? null;
}

// 화면·표시용 읽기. 실패는 모름(null)이며 관계표를 고치지 않는다.
export function readActiveHierarchy(entries) {
  const hierarchyPath = activeHierarchyPath(entries ?? []);
  if (!hierarchyPath) return null;
  try {
    return Object.fromEntries(parseHierarchy(JSON.parse(fs.readFileSync(hierarchyPath, "utf8"))));
  } catch {
    return null;
  }
}

function readTable(hierarchyPath) {
  const raw = fs.readFileSync(hierarchyPath, "utf8");
  const value = JSON.parse(raw);
  parseHierarchy(value);
  return value;
}

// 같은 순간 두 곳이 고치면 한쪽이 사라지므로 자기 잠금으로 막는다. 남의 잠금은 지우지 않는다.
function withLock(hierarchyPath, run) {
  const lockPath = path.join(path.dirname(hierarchyPath), "hierarchy-register.lock");
  let handle;
  try {
    handle = fs.openSync(lockPath, "wx");
  } catch {
    return { registered: false, reason: "다른 등록이 진행 중" };
  }
  try {
    return run();
  } finally {
    try { fs.closeSync(handle); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

// 카단 자신의 감시기·대시보드 세션은 보고 관계의 역할이 아니다. 관계표에 넣으면 트리에 부하처럼 보이고,
// 만든 감독의 인계 때 "보고 대상 변경" 편지가 그 프로그램 창에 붙는다(2026-09-23 [kyle] 지시로 제외).
const TOOL_SUBCOMMANDS = new Set(["watch", "dashboard", "wall"]);
export function isKadanToolCommand(cmd) {
  const words = commandWords(cmd);
  if (!words) return false;
  let i = 0;
  if (words[i]?.split("/").pop() === "env") {
    for (i++; i < words.length; i++) {
      if (words[i] === "-u" || words[i] === "--unset") i++;
      else if (!words[i].startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) break;
    }
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
  const base = value => value?.split("/").pop();
  if (["node", "nodejs", "bun"].includes(base(words[i])) && base(words[i + 1]) === "cli.mjs") i += 2;
  else if (base(words[i]) === "kadan") i += 1;
  else return false;
  return TOOL_SUBCOMMANDS.has(words[i]);
}

export function registerStartedRole({ role, creator, cmd, home = ledgerHome(), entries = null } = {}) {
  if (!role) return { registered: false, reason: "역할 없음" };
  if (isKadanToolCommand(cmd)) return { registered: false, reason: "카단 운영 도구 세션" };
  if (!creator || creator === "사람" || creator === "watch") {
    return { registered: false, reason: "만든 사람의 역할을 모름" };
  }
  if (creator === role) return { registered: false, reason: "자기 자신은 상위가 될 수 없음" };
  let hierarchyPath;
  try {
    hierarchyPath = activeHierarchyPath(entries ?? readLedger(home));
  } catch {
    return { registered: false, reason: "원장을 읽지 못함" };
  }
  if (!hierarchyPath) return { registered: false, reason: "감시기가 읽는 관계표를 모름" };
  return withLock(hierarchyPath, () => {
    let table;
    try {
      table = readTable(hierarchyPath);
    } catch (error) {
      return { registered: false, reason: `관계표를 읽지 못함: ${error.message}`, hierarchyPath };
    }
    if (Object.hasOwn(table, role)) {
      return { registered: false, reason: "이미 등록됨", parent: table[role], hierarchyPath };
    }
    // 상위가 표에 없으면 위로 올라가는 길이 끊긴다. 그때는 사람이 정하게 둔다.
    if (!Object.hasOwn(table, creator)) {
      return { registered: false, reason: `상위 ${creator}가 관계표에 없음`, hierarchyPath };
    }
    const next = { ...table, [role]: creator };
    try {
      parseHierarchy(next);
    } catch (error) {
      return { registered: false, reason: `추가하면 관계가 깨짐: ${error.message}`, hierarchyPath };
    }
    const temporaryPath = `${hierarchyPath}.register-${process.pid}`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
      fs.renameSync(temporaryPath, hierarchyPath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch {}
      return { registered: false, reason: `관계표를 쓰지 못함: ${error.message}`, hierarchyPath };
    }
    return { registered: true, parent: creator, hierarchyPath };
  });
}
