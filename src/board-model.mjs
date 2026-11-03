// kadan board(PR4)의 순수 계산: 목록 만들기·뱃지 합산·키 처리 상태 전이·붙기 명령 조립·화면 그리기.
// 터미널·tmux·HTTP를 직접 부르지 않는다(시험은 가짜 입력으로 한다). 키를 보내는 길도 여기엔 없다.
import { tmuxClientEnv } from "./floor-tmux.mjs";

// ---- 문자 폭: 칸 맞춤은 이 함수 하나로 한다 ----
// 한글·한자·전각은 2칸, 이모지(🌙 등)는 2칸, 결합 문자·변형 선택자는 0칸이다.
export function cellWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if ((code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f) || code === 0x200d) continue;
    const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

// 폭에 맞춰 자르고(넘치면 …) 모자라면 공백으로 채운다. 제어 문자는 공백으로 바꾼다.
export function fit(text, width) {
  if (width <= 0) return "";
  const clean = String(text).replace(/[\x00-\x1f\x7f]/g, " ");
  let out = "", used = 0;
  const over = cellWidth(clean) > width;
  const limit = over ? width - 1 : width;
  for (const ch of clean) {
    const w = cellWidth(ch);
    if (used + w > limit) break;
    out += ch; used += w;
  }
  if (over) { out += "…"; used += 1; }
  return out + " ".repeat(Math.max(0, width - used));
}

// ---- 🌙 나이트런 중 자동 머지 글자 ----
// gui/src/night-repos.ts의 badgeOf와 같은 대응이다(TypeScript라 가져올 수 없어 문구만 맞춘다).
export function nightWord(line) {
  const { reason, exceptBranch } = line?.verdict ?? {};
  if (reason === "allowed") return exceptBranch ? `안 함(배포 브랜치 ${exceptBranch})` : "함";
  if (reason === "night-merge-forbidden") return "금지";
  if (reason === "setup-needed") return "설정 필요";
  return "판정 모름";
}

// 슈퍼감독의 저장소들에 걸린 줄을 한 글자로 접는다. 모르면 "?", 줄이 없으면 "-", 서로 다르면 "섞임".
export function nightFor(nightRepos, repos) {
  if (!nightRepos || !Array.isArray(nightRepos.repos) || !repos?.length) return "?";
  const set = new Set(repos);
  const words = nightRepos.repos.filter((l) => l.repo && set.has(l.repo)).map(nightWord);
  if (!words.length) return "-";
  return words.every((w) => w === words[0]) ? words[0] : "섞임";
}

// ---- 목록 만들기 ----
// supers: [{role, repos|null}] (대시보드 현황의 supervisors.items 또는 관계표·프로필 계산)
// sessions: 살아 있는 tmux 세션 이름 Set, summary: /api/dashboard/summary 응답 또는 null
// 뱃지 합산: sidebar는 저장소 단위라 그 슈퍼감독의 저장소들 수를 더한다. 저장소를 모르거나 값이 null이면 0이 아니라 null(?)이다.
export function buildEntries({ supers, sessions, summary, nightRepos, toSession }) {
  const byRepo = new Map((summary?.sidebar ?? []).map((r) => [r.repo, r]));
  const sum = (repos, key) => {
    if (!summary || !repos?.length) return null;
    let total = 0;
    for (const repo of repos) {
      const value = byRepo.get(repo)?.[key];
      if (!Number.isInteger(value)) return null;
      total += value;
    }
    return total;
  };
  return supers.map(({ role, repos }) => {
    const session = toSession(role);
    return {
      role, session, repos: repos ?? null,
      alive: sessions.has(session),
      decisions: sum(repos, "decisions"),
      merges: sum(repos, "merges"),
      night: nightFor(nightRepos, repos),
      nightOn: summary?.night?.on === true,
    };
  });
}

export function badgesOf(entry) {
  const parts = [];
  const count = (mark, n) => { if (n === null) parts.push(`${mark}?`); else if (n > 0) parts.push(`${mark}${n}`); };
  count("⚑", entry.decisions);
  count("⇡", entry.merges);
  parts.push(`🌙${entry.night}`);
  return parts.join(" ");
}

// ---- 키 입력 ----
const KEY_TABLE = [
  ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1bOA", "up"], ["\x1bOB", "down"],
  ["\r", "enter"], ["\n", "enter"], ["\x03", "ctrl-c"],
  ["k", "up"], ["j", "down"], ["v", "v"], ["r", "r"], ["q", "q"],
];
// 원시 입력 덩어리를 키 이름 목록으로 바꾼다. 모르는 키는 버린다(어디에도 전달하지 않는다).
export function parseKeys(chunk) {
  const keys = [];
  let rest = String(chunk);
  while (rest) {
    const hit = KEY_TABLE.find(([seq]) => rest.startsWith(seq));
    if (hit) { keys.push(hit[1]); rest = rest.slice(hit[0].length); }
    else rest = rest.slice(rest.codePointAt(0) > 0xffff ? 2 : 1);
  }
  return keys;
}

// 상태 {sel, count, notice} + 키 → {state, action}. action: attach|view|refresh|quit|null.
// 세션이 없는 줄(alive false)은 attach·view 대신 안내 한 줄만 낸다. entries는 현재 목록.
export function reduceKey(state, key, entries) {
  const count = entries.length;
  const sel = Math.min(Math.max(state.sel, 0), Math.max(count - 1, 0));
  const base = { ...state, sel, notice: "" };
  if (key === "up") return { state: { ...base, sel: Math.max(sel - 1, 0) }, action: null };
  if (key === "down") return { state: { ...base, sel: Math.min(sel + 1, Math.max(count - 1, 0)) }, action: null };
  if (key === "r") return { state: base, action: "refresh" };
  if (key === "q" || key === "ctrl-c") return { state: base, action: "quit" };
  if (key === "enter" || key === "v") {
    const entry = entries[sel];
    if (!entry) return { state: { ...base, notice: "고를 슈퍼감독이 없습니다" }, action: null };
    if (!entry.alive) return { state: { ...base, notice: `${entry.role}: 세션이 없어 들어갈 수 없습니다 (회색 줄)` }, action: null };
    return { state: base, action: key === "enter" ? "attach" : "view" };
  }
  return { state: base, action: null };
}

// ---- 붙기 명령 ----
// 기존 floor의 attach 문구(`tmux -L <소켓> attach -t <세션>`)와 같은 꼴에 정확 대상(=세션:)을 쓴다. 새 세션·키 전송 없음.
export function attachArgv({ session, socket, readOnly = false }) {
  return ["-u", "-L", socket, "attach", ...(readOnly ? ["-r"] : []), "-t", `=${session}:`];
}
// 이미 tmux 안이면 TMUX를 지워 중첩 client로 붙는다. 창 선택 값은 floor와 같은 규칙으로 뺀다.
export function attachEnv(env = process.env) {
  const clean = tmuxClientEnv(env);
  delete clean.TMUX;
  return clean;
}

// ---- 화면 ----
const DIM = "\x1b[2m", INVERSE = "\x1b[7m", BOLD_YELLOW = "\x1b[1;33m", RESET = "\x1b[0m";
const TITLE_KEYS = "↑↓/jk 고르기 · Enter 들어가 입력 · v 읽기 전용 · r 새로 읽기 · q 끝";

function leftLine(entry, selected, width) {
  const badges = badgesOf(entry);
  const repo = entry.repos?.length ? ` ${entry.repos.join(",")}` : "";
  const mark = selected ? "▶" : " ";
  const tail = ` ${badges}`;
  const nameWidth = Math.max(width - cellWidth(tail) - 2, 6);
  const head = fit(`${mark} ${entry.role}${repo}`, nameWidth + 2);
  let line = fit(head + tail, width);
  if (selected) return `${INVERSE}${line}${RESET}`;
  if (!entry.alive) return `${DIM}${line}${RESET}`;
  if (entry.nightOn) line = line.replace(/🌙\S+/, (m) => `${BOLD_YELLOW}${m}${RESET}`);
  return line;
}

// frame: 화면 전체를 한 번에 쓸 문자열(줄마다 끝까지 지움). rows·cols는 터미널 크기.
export function renderFrame({ entries, state, cols, rows, preview = [], notice = "", dashboard = "?" }) {
  const width = Math.max(cols, 20), height = Math.max(rows, 5);
  const leftW = Math.min(Math.max(Math.floor(width * 0.4), 24), 56, width - 12);
  const rightW = width - leftW - 1;
  const bodyH = height - 3;
  const sel = entries[Math.min(state.sel, entries.length - 1)];
  const lines = [fit(`카단 관제 · 슈퍼감독 ${entries.length}명 · 대시보드 ${dashboard}`, width)];
  const head = sel ? `${sel.session}${sel.alive ? "" : " (세션 없음)"}` : "(슈퍼감독 없음)";
  for (let i = 0; i < bodyH; i++) {
    const entry = entries[i];
    const left = entry ? leftLine(entry, entries[state.sel] === entry, leftW) : " ".repeat(leftW);
    const right = i === 0 ? `${DIM}${fit(head, rightW)}${RESET}` : fit(preview[i - 1] ?? "", rightW);
    lines.push(`${left}│${right}`);
  }
  lines.push(fit(notice || state.notice || "", width));
  lines.push(fit(TITLE_KEYS, width));
  return "\x1b[H" + lines.map((l) => `${l}\x1b[K`).join("\r\n");
}

// capture-pane 결과에서 끝의 빈 줄을 빼고 마지막 count줄만 남긴다.
export function tailOf(text, count) {
  const lines = String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && lines.at(-1) === "") lines.pop();
  return count > 0 ? lines.slice(-count) : [];
}
