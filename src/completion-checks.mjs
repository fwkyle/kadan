// 완료 검사: 카드 본문의 선택 절 `## 완료 검사`를 done 확정 때 다시 돌려 줄마다 결과를 보인다.
// 막지 않는다. 검사가 실패해도 done 확정과 종료 코드는 그대로이고, 결과만 보이고 카드 메모에 남긴다.
// 줄은 세 종류뿐이다(command·file·url). 셸 없이 허용 목록 프로그램만 argv로 실행한다.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CardStore } from "./card-store.mjs";

export const ALLOWED_PROGRAMS = ["git", "rg", "ls", "test"];
export const GIT_READ_SUBCOMMANDS = [
  "status", "log", "rev-parse", "diff", "show", "ls-files", "merge-base", "ls-remote", "branch",
];
const GIT_BRANCH_LIST_FLAGS = ["-a", "-r", "-l", "--list", "-v", "-vv", "--show-current", "--all", "--remotes"];
export const PER_CHECK_MS = 30_000;
export const TOTAL_MS = 120_000;
const SHOW_CHARS = 200;
const NOTE_PREFIX = "완료 검사:";
const SOURCE_LABEL = "카드 저장소 본문(card.md)";

const clip = (text, n = SHOW_CHARS) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

// 카드 본문에서 `## 완료 검사` 절의 줄을 꺼낸다. 절이 없으면 빈 배열이다.
export function checkLines(body) {
  const lines = String(body ?? "").split("\n");
  const start = lines.findIndex(line => /^#{1,6}\s*완료 검사\s*$/.test(line.trim()));
  if (start === -1) return [];
  const found = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const text = line.trim().replace(/^[-*]\s+/, "").replace(/^`([^`]*)`$/, "$1").trim();
    if (!text || text.startsWith("```") || text.startsWith("<!--")) continue;
    found.push(text);
  }
  return found;
}

// 한 줄을 검사 하나로 읽는다. 읽지 못하면 { error }를 돌려준다.
export function parseCheck(text) {
  let m = /^file\s+(\S+)\s+(?:exists|sha256=([0-9a-fA-F]{64}))$/.exec(text);
  if (m) return { kind: "file", path: m[1], sha256: m[2]?.toLowerCase() ?? null };
  m = /^url\s+(https?:\/\/\S+)\s+status=(\d{3})$/.exec(text);
  if (m) return { kind: "url", url: m[1], status: Number(m[2]) };
  if (!/^command\s/.test(text)) return { error: "알 수 없는 줄 (command·file·url 중 하나여야 함)" };
  let rest = text.slice("command".length).trim(), cwd = null, pattern = null;
  const inMatch = /\s+in\s+(\/\S+)$/.exec(rest);
  if (inMatch) { cwd = inMatch[1]; rest = rest.slice(0, inMatch.index).trim(); }
  const out = /(?:^|\s)stdout~\/(.+)\/$/.exec(rest);
  if (out) {
    try { pattern = new RegExp(out[1]); } catch (error) { return { error: `정규식 오류: ${error.message}` }; }
    rest = rest.slice(0, out.index).trim();
  }
  const argv = rest.split(/\s+/).filter(Boolean);
  if (!argv.length) return { error: "실행할 프로그램이 없음" };
  return { kind: "command", argv, pattern, patternSource: out?.[1] ?? null, cwd };
}

// 허용 목록 판정. 거절 이유 문자열 또는 null.
export function denyReason(argv) {
  const [program, ...args] = argv;
  if (program.includes("/")) return `허용 안 됨: ${program} (프로그램 이름만 받음)`;
  if (!ALLOWED_PROGRAMS.includes(program)) return `허용 안 됨: ${program}`;
  if (program === "git") {
    const [sub, ...rest] = args;
    if (!GIT_READ_SUBCOMMANDS.includes(sub)) return `허용 안 됨: git ${sub ?? "(하위 명령 없음)"} (읽기 하위 명령만)`;
    const bad = rest.find(a => /^--(output|ext-diff|upload-pack|exec|receive-pack|open-files-in-pager)(=|$)/.test(a));
    if (bad) return `허용 안 됨: git ${sub} ${bad}`;
    if (sub === "branch") {
      const flags = rest.filter(a => a.startsWith("-"));
      const unknown = flags.find(a => !GIT_BRANCH_LIST_FLAGS.includes(a));
      if (unknown) return `허용 안 됨: git branch ${unknown} (목록 보기만)`;
      const listing = flags.some(a => a === "-l" || a === "--list");
      if (rest.some(a => !a.startsWith("-")) && !listing) return "허용 안 됨: git branch <이름> (만들기 방지, 목록만)";
    }
  }
  if (program === "rg") {
    const bad = args.find(a => /^--(pre|hostname-bin|search-zip)(=|$)/.test(a) || /^-[a-zA-Z]*z/.test(a));
    if (bad) return `허용 안 됨: rg ${bad} (외부 명령 실행 옵션)`;
  }
  return null;
}

const underRoot = (target, root) => target === root || target.startsWith(root + path.sep);

// 없는 경로도 가장 가까운 기존 조상의 realpath에 나머지를 붙여 판정한다.
function realpathLoose(target) {
  const tail = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail.reverse()); } catch { /* 조상으로 올라감 */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    tail.push(path.basename(current));
    current = parent;
  }
}

function allowedRoots(card, spawn) {
  const roots = [fs.realpathSync(card.repoPath)];
  const listed = spawn("git", ["-C", card.repoPath, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  for (const line of String(listed.stdout ?? "").split("\n")) {
    const m = /^worktree (.+)$/.exec(line);
    if (!m) continue;
    try { roots.push(fs.realpathSync(m[1])); } catch { /* 사라진 worktree */ }
  }
  return roots;
}

function checkEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };
  delete env.GIT_EXTERNAL_DIFF;
  return env;
}

const result = (status, detail = "") => ({ status, detail });

async function runOne(parsed, ctx, ms) {
  const { card, spawn, fetchFn } = ctx;
  const roots = () => (ctx.roots ??= allowedRoots(card, spawn));
  if (parsed.kind === "url") {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), ms);
    try {
      const response = await fetchFn(parsed.url, { method: "GET", redirect: "manual", signal: control.signal });
      response.body?.cancel?.().catch?.(() => {});
      return response.status === parsed.status ? result("pass", `status=${response.status}`)
        : result("fail", `status=${response.status} (기대 ${parsed.status})`);
    } catch (error) {
      return control.signal.aborted ? result("timeout", `${Math.round(ms)}ms 안에 응답 없음`) : result("fail", `요청 실패: ${clip(error.message)}`);
    } finally { clearTimeout(timer); }
  }
  const base = fs.realpathSync(card.repoPath);
  if (parsed.kind === "file") {
    if (parsed.path.split(/[\\/]/).includes("..")) return result("denied", "거절: 경로에 .. 가 있음");
    const real = realpathLoose(path.resolve(base, parsed.path));
    if (!roots().some(root => underRoot(real, root))) return result("denied", `거절: 저장소·등록된 worktree 밖 (${real})`);
    if (!fs.existsSync(real)) return result("fail", "파일 없음");
    if (!parsed.sha256) return result("pass", "있음");
    if (!fs.statSync(real).isFile()) return result("fail", "일반 파일이 아님");
    const actual = createHash("sha256").update(fs.readFileSync(real)).digest("hex");
    return actual === parsed.sha256 ? result("pass", "sha256 일치") : result("fail", `sha256 불일치 (실제 ${actual.slice(0, 12)}…)`);
  }
  // command
  const denied = denyReason(parsed.argv);
  if (denied) return result("denied", denied);
  let cwd = base;
  if (parsed.cwd) {
    if (parsed.cwd.split(/[\\/]/).includes("..")) return result("denied", "거절: 실행 폴더에 .. 가 있음");
    const real = realpathLoose(parsed.cwd);
    if (!roots().includes(real)) return result("denied", `거절: 저장소·등록된 worktree가 아님 (${real})`);
    cwd = real;
  }
  const [program, ...rest] = parsed.argv;
  const args = program === "git" && ["diff", "show", "log"].includes(rest[0]) ? [...rest, "--no-ext-diff", "--no-textconv"] : rest;
  const ran = spawn(program, args, { cwd, encoding: "utf8", timeout: ms, maxBuffer: 1024 * 1024, env: checkEnv(), stdio: ["ignore", "pipe", "pipe"] });
  if (ran.error) {
    return ran.error.code === "ETIMEDOUT" ? result("timeout", `${Math.round(ms)}ms 안에 끝나지 않음`) : result("fail", `실행 못함: ${clip(ran.error.message)}`);
  }
  if (ran.status !== 0) return result("fail", `종료 코드 ${ran.status}${ran.stderr ? ` — ${clip(ran.stderr)}` : ""}`);
  if (!parsed.pattern) return result("pass", "종료 코드 0");
  const stdout = String(ran.stdout ?? "").replace(/\n+$/, ""); // 끝 줄바꿈은 빼서 ^…$ 로 한 줄을 맞출 수 있게 한다
  return parsed.pattern.test(stdout) ? result("pass", `출력이 /${clip(parsed.patternSource, 80)}/ 와 맞음`)
    : result("fail", `출력이 /${clip(parsed.patternSource, 80)}/ 와 안 맞음: "${clip(stdout)}"`);
}

// 줄마다 돌려 결과를 모은다. 검사당 PER_CHECK_MS, 전체 TOTAL_MS. 전체를 넘으면 남은 검사는 건너뛴다.
export async function runChecks(card, lines, deps = {}) {
  const spawn = deps.spawn ?? spawnSync, fetchFn = deps.fetchFn ?? globalThis.fetch, now = deps.now ?? Date.now;
  const perMs = deps.perMs ?? PER_CHECK_MS, totalMs = deps.totalMs ?? TOTAL_MS;
  const ctx = { card, spawn, fetchFn, roots: null };
  const startedAt = now();
  const results = [];
  for (const line of lines) {
    const parsed = parseCheck(line);
    if (parsed.error) { results.push({ line, ...result("unreadable", parsed.error) }); continue; }
    const remaining = totalMs - (now() - startedAt);
    if (remaining <= 0) { results.push({ line, ...result("skipped", "전체 시간 상한을 넘어 건너뜀") }); continue; }
    let outcome;
    try { outcome = await runOne(parsed, ctx, Math.min(perMs, remaining)); } catch (error) { outcome = result("fail", `검사 중 오류: ${clip(error.message)}`); }
    results.push({ line, ...outcome });
  }
  return { source: SOURCE_LABEL, results, summary: summarize(results) };
}

export function summarize(results) {
  const count = pred => results.filter(r => pred(r.status)).length;
  const pass = count(s => s === "pass"), fail = count(s => s === "fail" || s === "timeout");
  const unreadable = count(s => s === "unreadable" || s === "denied"), skipped = count(s => s === "skipped");
  return `통과 ${pass}·실패 ${fail}·읽지 못함 ${unreadable}${skipped ? `·건너뜀 ${skipped}` : ""}`;
}

const LABEL = { pass: "통과", fail: "실패", timeout: "시간 초과", unreadable: "읽지 못함", denied: "허용 안 됨", skipped: "건너뜀" };
const reportLines = report => report.results.map(r => `  [${LABEL[r.status]}] ${clip(r.line, 160)}${r.detail ? ` — ${r.detail}` : ""}`);

export function formatReport(report) {
  return [`완료 검사 (기준: ${report.source}): ${report.summary}`, ...reportLines(report)].join("\n");
}

function noteText(report) {
  return [`${NOTE_PREFIX} ${report.summary} (기준: ${report.source})`, ...reportLines(report)].join("\n");
}

// 같은 결과가 이어지면 다시 적지 않는다(마지막 완료 검사 메모와 글자까지 같을 때).
export function recordReport(store, key, report, by) {
  const card = store.get(key, { body: false });
  const note = noteText(report);
  const last = [...card.history].reverse().find(e => typeof e.note === "string" && e.note.startsWith(NOTE_PREFIX));
  if (last?.note === note) return "same";
  store.update(key, {}, { revision: card.revision, by, noteKind: "progress", note });
  return "recorded";
}

// 카드에 완료 검사 줄이 있으면 { card, lines }, 없으면 null.
export function loadChecks(home, key) {
  if (!key) return null;
  let card;
  try { card = new CardStore(home).get(key); } catch { return null; }
  const lines = checkLines(card.body);
  return lines.length ? { card, lines } : null;
}

// 돌리고 카드 메모에 남긴다. 기록 실패는 보고에 적고 던지지 않는다.
export async function runCardChecks(home, key, { by, deps } = {}) {
  const loaded = loadChecks(home, key);
  if (!loaded) return null;
  const report = await runChecks(loaded.card, loaded.lines, deps);
  try { report.recorded = recordReport(new CardStore(home), key, report, by); } catch (error) { report.recordError = error.message; }
  return report;
}
