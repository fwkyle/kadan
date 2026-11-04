// kadan board의 순수 계산: 문자 폭·목록 만들기·뱃지 합산·목록 포커스 키 상태 전이.
// 터미널·tmux·HTTP를 직접 부르지 않는다(시험은 가짜 입력으로 한다). 1차(#341)의 목록·뱃지 코드를 가져왔고 창 밖으로 붙는 길(Enter 붙기·읽기 전용 보기)은 뺐다.

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
// supers: [{role, repos|null}], sessions: 살아 있는 tmux 세션 이름 Set, summary: /api/dashboard/summary 응답 또는 null
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

// ---- 목록(사이드바·설명) 포커스 키 ----
// 상태 {sel, notice} + 키 → {state, action}. action: focus-term|toggle-1|toggle-2|toggle-3|refresh|quit|null.
// 세션이 없는 줄(alive false)은 터미널 포커스 대신 안내 한 줄만 낸다. 터미널 포커스 키는 board-input.mjs가 따로 다룬다.
export function reduceKey(state, key, entries) {
  const count = entries.length;
  const sel = Math.min(Math.max(state.sel, 0), Math.max(count - 1, 0));
  const base = { ...state, sel, notice: "" };
  if (key === "up") return { state: { ...base, sel: Math.max(sel - 1, 0) }, action: null };
  if (key === "down") return { state: { ...base, sel: Math.min(sel + 1, Math.max(count - 1, 0)) }, action: null };
  if (key === "1" || key === "2" || key === "3") return { state: base, action: `toggle-${key}` };
  if (key === "r") return { state: base, action: "refresh" };
  if (key === "q" || key === "ctrl-c") return { state: base, action: "quit" };
  if (key === "enter") {
    const entry = entries[sel];
    if (!entry) return { state: { ...base, notice: "고를 슈퍼감독이 없습니다" }, action: null };
    if (!entry.alive) return { state: { ...base, notice: `${entry.role}: 세션이 없어 입력할 수 없습니다 (회색 줄)` }, action: null };
    return { state: base, action: "focus-term" };
  }
  return { state: base, action: null };
}
