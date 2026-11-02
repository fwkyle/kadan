// 완료 검사: 카드의 `## 완료 검사` 절을 done 확정 때 다시 돌려 줄마다 결과를 보인다.
// 막지 않는다. 검사가 실패해도 done 확정과 종료 코드는 그대로이고, 결과만 보이고 카드 메모에 남긴다.
// 줄은 고정 검사 네 종류뿐이다(file·git head·git pushed·git tidy). 카드에는 데이터(경로·SHA·브랜치)만 적고,
// 실행 인자는 코드가 정한다. 출력 원문은 화면에도 카드 메모에도 남기지 않는다(종류·대상·결과·정해진 이유 낱말만).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CardStore, checkLines } from "./card-store.mjs";

export { checkLines };
export const PER_CHECK_MS = 30_000;
export const TOTAL_MS = 120_000;
export const MAX_CHECKS = 20;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_NOTE_CHARS = 4000;
const SHOW_CHARS = 120;
const NOTE_PREFIX = "완료 검사:";
export const SOURCE_STORED = "발령 때 저장한 검사 줄";
const SOURCE_DRAFT = "발령 전 카드 본문";

// git 실행기 하나: 고정 PATH에서 한 번 찾은 절대경로, 최소 환경, 코드가 정한 앞 인자.
// 저장소 설정(fsmonitor·hooks·pager·외부 diff·ext 전송·자격 증명·ssh/프록시 실행)이 외부 프로그램을 부르지 못하게 막는다.
export const GIT_PATH = "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin";
export const GIT_FRONT_ARGS = [
  "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat",
  "-c", "diff.external=", "-c", "protocol.ext.allow=never",
  "-c", "credential.helper=", "-c", "core.sshCommand=ssh", "-c", "core.gitProxy=",
  "-c", "remote.origin.uploadpack=git-upload-pack", "-c", "remote.origin.proxy=",
];
let gitBinCache;
export function gitBinary() {
  if (gitBinCache !== undefined) return gitBinCache;
  gitBinCache = null;
  for (const dir of GIT_PATH.split(":")) {
    const file = path.join(dir, "git");
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) { gitBinCache = file; break; } } catch { /* 다음 후보 */ }
  }
  return gitBinCache;
}
export function gitEnv() {
  return {
    PATH: GIT_PATH, HOME: process.env.HOME ?? "", GIT_ALLOW_PROTOCOL: "https:ssh", GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
  };
}
function runGit(spawn, args, cwd, ms) {
  const bin = gitBinary();
  if (!bin) return { error: { code: "ENOENT" }, status: null, stdout: "" };
  return spawn(bin, [...GIT_FRONT_ARGS, ...args], {
    cwd, encoding: "utf8", timeout: ms, maxBuffer: 1024 * 1024, env: gitEnv(), stdio: ["ignore", "pipe", "ignore"],
  });
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const branchShapeOk = name => BRANCH_RE.test(name) && !/\.\.|\/\/|\.lock(\/|$)|[./]$|\/\./.test(name);

// 한 줄을 검사 하나로 읽는다. 읽지 못하면 { error: "형식 오류" }를 돌려준다. 실행은 하지 않는다.
export function parseCheck(text) {
  const t = String(text).trim();
  let m = /^file\s+(\S+)\s+(?:exists|sha256=([0-9a-fA-F]{64}))$/.exec(t);
  if (m) return { kind: "file", path: m[1], sha256: m[2]?.toLowerCase() ?? null };
  m = /^git\s+head\s+(\S+)\s+=\s+([0-9a-fA-F]{7,40})$/.exec(t);
  if (m) return { kind: "head", path: m[1], sha: m[2].toLowerCase() };
  m = /^git\s+pushed\s+(\S+)\s+(\S+)$/.exec(t);
  if (m && branchShapeOk(m[2])) return { kind: "pushed", path: m[1], branch: m[2] };
  m = /^git\s+tidy\s+(\S+)$/.exec(t);
  if (m) return { kind: "tidy", path: m[1] };
  return { error: "형식 오류" };
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

// 저장소와 등록된 worktree 목록. 이 호출도 같은 git 실행기를 지난다.
function allowedRoots(card, spawn) {
  const roots = [fs.realpathSync(card.repoPath)];
  const listed = runGit(spawn, ["worktree", "list", "--porcelain"], card.repoPath, 10_000);
  for (const line of String(listed.stdout ?? "").split("\n")) {
    const m = /^worktree (.+)$/.exec(line);
    if (!m) continue;
    try { roots.push(fs.realpathSync(m[1])); } catch { /* 사라진 worktree */ }
  }
  return roots;
}

// 경로 하나를 범위 안으로 풀어 { real, shown } 또는 { denied }로 돌려준다. 밖 경로는 화면에도 적지 않는다.
function scoped(rawPath, ctx) {
  if (rawPath.split(/[\\/]/).includes("..")) return { denied: true };
  const real = realpathLoose(path.resolve(ctx.base, rawPath));
  const roots = (ctx.roots ??= allowedRoots(ctx.card, ctx.spawn));
  const root = roots.find(r => underRoot(real, r));
  if (!root) return { denied: true };
  const rel = path.relative(root, real) || ".";
  return { real, shown: root === ctx.base ? rel : `${path.basename(root)}:${rel}` };
}

const out = (status, detail = "", label = "") => ({ status, detail, label });
const clip = (text, n = SHOW_CHARS) => (String(text).length > n ? `${String(text).slice(0, n)}…` : String(text));
const gitFailure = (ran, ms) => {
  if (ran.error?.code === "ETIMEDOUT") return out("timeout", "시간 초과");
  return null;
};

async function runOne(parsed, ctx, ms) {
  const { spawn } = ctx;
  const where = scoped(parsed.path, ctx);
  const head = { file: "file", head: "git head", pushed: "git pushed", tidy: "git tidy" }[parsed.kind];
  if (where.denied) return out("denied", "범위 밖", `${head} (저장소 밖 경로)`);
  const shown = clip(where.shown);
  if (parsed.kind === "file") {
    const label = `file ${shown} ${parsed.sha256 ? "sha256" : "exists"}`;
    let stat;
    try { stat = fs.statSync(where.real); } catch { return out("fail", "파일 없음", label); }
    if (!parsed.sha256) return out("pass", "", label);
    if (!stat.isFile()) return out("fail", "파일 없음", label);
    if (stat.size > ctx.maxFileBytes) return out("fail", "크기 초과", label);
    const actual = createHash("sha256").update(fs.readFileSync(where.real)).digest("hex");
    return actual === parsed.sha256 ? out("pass", "", label) : out("fail", "sha 다름", label);
  }
  // git 검사: 대상은 폴더여야 한다.
  const label = parsed.kind === "pushed" ? `git pushed ${shown} ${parsed.branch}`
    : parsed.kind === "head" ? `git head ${shown}` : `git tidy ${shown}`;
  try { if (!fs.statSync(where.real).isDirectory()) return out("fail", "파일 없음", label); } catch { return out("fail", "파일 없음", label); }
  const git = args => runGit(spawn, args, where.real, ms);
  const bad = ran => gitFailure(ran, ms) ?? (ran.error || ran.status !== 0 ? out("fail", "실행 실패", label) : null);
  if (parsed.kind === "tidy") {
    const ran = git(["status", "--porcelain"]);
    if (ran.error?.code === "ENOBUFS") return out("fail", "변경 있음", label);
    const failed = bad(ran);
    if (failed) return { ...failed, label };
    return String(ran.stdout ?? "").trim() === "" ? out("pass", "", label) : out("fail", "변경 있음", label);
  }
  const local = git(["rev-parse", "HEAD"]);
  const localFail = bad(local);
  if (localFail) return { ...localFail, label };
  const localSha = String(local.stdout ?? "").trim().toLowerCase();
  if (parsed.kind === "head") return localSha.startsWith(parsed.sha) ? out("pass", "", label) : out("fail", "sha 다름", label);
  // pushed
  const format = git(["check-ref-format", "--branch", parsed.branch]);
  if (format.error || format.status !== 0 || String(format.stdout ?? "").trim() !== parsed.branch) return out("unreadable", "형식 오류", label);
  const remote = git(["ls-remote", "origin", `refs/heads/${parsed.branch}`]);
  const remoteFail = bad(remote);
  if (remoteFail) return { ...remoteFail, label };
  const row = String(remote.stdout ?? "").split("\n").map(l => l.split("\t")).find(([, ref]) => ref === `refs/heads/${parsed.branch}`);
  if (!row) return out("fail", "원격에 없음", label);
  return row[0].toLowerCase() === localSha ? out("pass", "", label) : out("fail", "sha 다름", label);
}

// 줄마다 돌려 결과를 모은다. 검사 MAX_CHECKS개까지, 검사당 PER_CHECK_MS, 전체 TOTAL_MS.
// 전체를 넘으면 남은 검사는 건너뛰고, 개수를 넘는 줄은 돌리지 않고 생략 수만 센다.
export async function runChecks(card, lines, deps = {}) {
  const spawn = deps.spawn ?? spawnSync, now = deps.now ?? Date.now;
  const perMs = deps.perMs ?? PER_CHECK_MS, totalMs = deps.totalMs ?? TOTAL_MS;
  const ctx = { card, spawn, roots: null, base: fs.realpathSync(card.repoPath), maxFileBytes: deps.maxFileBytes ?? MAX_FILE_BYTES };
  const startedAt = now();
  const results = [];
  for (const [index, line] of lines.slice(0, MAX_CHECKS).entries()) {
    const parsed = parseCheck(line);
    if (parsed.error) { results.push(out("unreadable", parsed.error, `줄 ${index + 1}`)); continue; }
    const remaining = totalMs - (now() - startedAt);
    if (remaining <= 0) { results.push(out("skipped", "시간 초과", `줄 ${index + 1}`)); continue; }
    let outcome;
    try { outcome = await runOne(parsed, ctx, Math.min(perMs, remaining)); } catch { outcome = out("fail", "실행 실패", `줄 ${index + 1}`); }
    results.push(outcome);
  }
  const omitted = Math.max(0, lines.length - MAX_CHECKS);
  return { source: deps.source ?? SOURCE_STORED, results, omitted, summary: summarize(results) };
}

export function summarize(results) {
  const count = pred => results.filter(r => pred(r.status)).length;
  const pass = count(s => s === "pass"), fail = count(s => s === "fail" || s === "timeout");
  const unreadable = count(s => s === "unreadable"), denied = count(s => s === "denied"), skipped = count(s => s === "skipped");
  return `통과 ${pass}·실패 ${fail}·읽지 못함 ${unreadable}${denied ? `·거절 ${denied}` : ""}${skipped ? `·건너뜀 ${skipped}` : ""}`;
}

const STATUS_LABEL = { pass: "통과", fail: "실패", timeout: "시간 초과", unreadable: "읽지 못함", denied: "거절", skipped: "건너뜀" };
const reportLines = report => [
  ...report.results.map(r => `  [${STATUS_LABEL[r.status]}] ${r.label}${r.detail ? ` — ${r.detail}` : ""}`),
  ...(report.omitted ? [`  … ${MAX_CHECKS}개 상한으로 ${report.omitted}개 생략`] : []),
];

export function formatReport(report) {
  return [`완료 검사 (기준: ${report.source}): ${report.summary}`, ...reportLines(report)].join("\n");
}

function noteText(report) {
  const text = [`${NOTE_PREFIX} ${report.summary} (기준: ${report.source})`, ...reportLines(report)].join("\n");
  return text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS)}\n  … 메모 길이 상한으로 생략` : text;
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

// 검사 줄의 출처: 발령 때 이력에 저장한 줄(completionChecks). 발령 전(draft·ready) 카드만 본문을 직접 읽는다.
// 발령 뒤 card.md를 고쳐도 실행 내용은 바뀌지 않는다.
export function loadChecks(home, key) {
  if (!key) return null;
  let card;
  try {
    const store = new CardStore(home);
    card = store.get(key, { body: false });
    if (Array.isArray(card.completionChecks)) {
      const lines = card.completionChecks.filter(l => typeof l === "string");
      return lines.length ? { card, lines, source: SOURCE_STORED } : null;
    }
    if (!["draft", "ready"].includes(card.status)) return null;
    const lines = checkLines(store.get(key).body);
    return lines.length ? { card, lines, source: SOURCE_DRAFT } : null;
  } catch { return null; }
}

// 돌리고 카드 메모에 남긴다. 기록 실패는 보고에 적고 던지지 않는다.
export async function runCardChecks(home, key, { by, deps } = {}) {
  const loaded = loadChecks(home, key);
  if (!loaded) return null;
  const report = await runChecks(loaded.card, loaded.lines, { ...deps, source: loaded.source });
  try { report.recorded = recordReport(new CardStore(home), key, report, by); } catch (error) { report.recordError = error.message; }
  return report;
}
