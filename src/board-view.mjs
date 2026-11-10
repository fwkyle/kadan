// kadan board 화면 그리기(순수 함수): 세 칸 배치·색 유지 자르기·설명 칸 줄 만들기. tmux·터미널을 직접 부르지 않는다.
import { badgesOf, cellWidth, fit } from "./board-model.mjs";

const RESET = "\x1b[0m", DIM = "\x1b[2m", INVERSE = "\x1b[7m", BOLD_YELLOW = "\x1b[1;33m", GREEN = "\x1b[32m", BOLD_GREEN = "\x1b[1;32m";
const SGR = /^\x1b\[[0-9;:]*m/;
const OTHER_ESCAPE = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_a-z0-9=<>])/;

// 색(SGR)은 남기고 폭에 정확히 맞춘다. 넘치는 오른쪽은 자르고 모자라면 공백으로 채운다. 커서 이동 같은 다른 제어는 버린다.
export function cropAnsi(line, width) {
  if (width <= 0) return "";
  const text = String(line);
  let out = "", used = 0, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\x1b") {
      const rest = text.slice(i);
      const sgr = SGR.exec(rest);
      if (sgr) { out += sgr[0]; i += sgr[0].length; continue; }
      const other = OTHER_ESCAPE.exec(rest);
      i += other ? other[0].length : 1;
      continue;
    }
    const code = c.codePointAt(0);
    if (code < 0x20 || code === 0x7f) { i += 1; continue; }
    const ch = String.fromCodePoint(code), w = cellWidth(ch);
    if (used + w > width) break;
    out += ch; used += w; i += ch.length;
  }
  return out + RESET + " ".repeat(Math.max(0, width - used));
}

// ---- 칸 너비 ----
// 켜진 칸만 배치한다. 터미널 칸이 남는 폭을 받고(꺼졌으면 설명 → 사이드바 순으로 받는다). 터미널 칸이 20칸보다 좁아지면 설명 → 사이드바를 접는다.
export const MIN_TERM = 20;
export function layoutPanes({ cols, panes }) {
  let side = panes.side, desc = panes.desc;
  const term = panes.term;
  const sideW = Math.min(Math.max(Math.floor(cols * 0.22), 22), 34);
  const descW = Math.min(Math.max(Math.floor(cols * 0.28), 26), 44);
  const fixed = () => (side ? sideW + 1 : 0) + (desc ? descW + 1 : 0);
  if (term && cols - fixed() < MIN_TERM) desc = false;
  if (term && cols - fixed() < MIN_TERM) side = false;
  const widths = { side: side ? sideW : 0, desc: desc ? descW : 0, term: 0 };
  const shown = ["side", "desc", "term"].filter((k) => (k === "side" ? side : k === "desc" ? desc : term));
  if (!shown.length) return { widths, shown, hidden: [] };
  const last = shown.at(-1);
  const used = shown.slice(0, -1).reduce((n, k) => n + widths[k] + 1, 0);
  widths[last] = Math.max(cols - used, 1);
  const hidden = [["side", panes.side && !side], ["desc", panes.desc && !desc]].filter(([, h]) => h).map(([k]) => k);
  return { widths, shown, hidden };
}

// ---- 터미널 칸 내용 ----
// capture: {lines, paneWidth, paneHeight, cursor:{x,y}|null}. 칸 높이에 맞춰 커서가 보이는 구간을 고른다.
export function termWindow(capture, height, width) {
  const all = capture?.lines ?? [];
  const paneHeight = capture?.paneHeight || all.length;
  const start = paneHeight > height ? Math.min(Math.max((capture.cursor?.y ?? paneHeight - 1) - (height - 1), 0), paneHeight - height) : 0;
  const rows = Array.from({ length: height }, (_, i) => cropAnsi(all[start + i] ?? "", width));
  const c = capture?.cursor;
  const visible = c && c.y >= start && c.y < start + height && c.x < width;
  return { rows, cursor: visible ? { row: c.y - start, col: c.x } : null, cut: Boolean(capture?.paneWidth && capture.paneWidth > width) };
}

// ---- 설명 칸 ----
const two = (n) => String(n).padStart(2, "0");
const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--:--" : `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const HEAD_MARK = "▸ ";
const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

// status: GET /api/dashboard/status?super=<역할> 응답 또는 null(못 읽음). 값이 null인 칸은 0이 아니라 "모름"으로 쓴다.
export function describeLines(entry, status, state = {}) {
  const lines = [];
  const head = (title) => lines.push(`${HEAD_MARK}${title}`); // 제목 줄: 그릴 때 흐리게
  if (!entry) return ["슈퍼감독을 고르세요"];
  lines.push(`${entry.role}${entry.alive ? "" : " (세션 없음)"}`);
  if (!status) {
    lines.push(state.loading ? "설명을 읽는 중…" : "설명을 못 읽었습니다 (대시보드 꺼짐 또는 무응답) — 모름");
    return lines;
  }
  const works = status.works ?? [];
  head(`열린 워크 ${works.length}`);
  for (const w of works) lines.push(`· ${text(w.title)}${w.turnLabel ? ` [${text(w.turnLabel)}]` : ""}${w.next ? ` → ${text(w.next)}` : ""}`);
  const rows = status.rows ?? [];
  head(`작업중 카드 ${rows.length}`);
  for (const r of rows) lines.push(`· ${text(r.title)}${r.healthLabel ? ` (${text(r.healthLabel)})` : ""}`);
  const decisions = status.decisions;
  head(decisions == null ? "kyle 결정 대기 모름" : `kyle 결정 대기 ${decisions.length}`);
  for (const d of decisions ?? []) lines.push(`⚑ ${text(d.question)}`);
  const alerts = status.alerts;
  head(alerts == null ? "경보 모름" : `경보 ${alerts.count}`);
  for (const a of alerts?.items ?? []) lines.push(`! ${text(a.kind)}${a.level ? ` ${text(a.level)}` : ""} ${text(a.role)}`);
  head("최근 활동");
  const recent = (status.recent ?? []).slice(0, 8);
  if (!recent.length) lines.push("· 없음");
  for (const e of recent) lines.push(`${clock(e.at)} ${text(e.label || e.kind)}${e.card?.title ? ` · ${text(e.card.title)}` : ""}`);
  head("최근 우편");
  lines.push("· 준비 중");
  return lines;
}

// ---- 사이드바 줄 ----
function sideLine(entry, selected, width) {
  const badges = badgesOf(entry);
  const tail = ` ${badges}`;
  const nameWidth = Math.max(width - cellWidth(tail), 6);
  const fitted = fit(fit(`${selected ? "▶" : " "} ${entry.role}`, nameWidth) + fit(tail, width - nameWidth), width);
  if (selected) return `${INVERSE}${fitted}${RESET}`;
  if (!entry.alive) return `${DIM}${fitted}${RESET}`;
  return entry.autopilotOn ? fitted.replace(/🌙\S+/, (m) => `${BOLD_YELLOW}${m}${RESET}`) : fitted;
}

const KEYS_LIST = "↑↓ 고르기 · Enter/Tab 터미널 입력 · 1 사이드바 2 설명 3 터미널 켜고 끄기 · r 새로 읽기 · q 끝";

// 화면 전체를 한 번에 쓸 문자열. 터미널 포커스면 터미널 칸 테두리·머리를 초록으로 하고 실제 커서를 대상 커서 자리에 둔다.
export function renderFrame({ entries, state, focus, panes, cols, rows, desc, term, notice = "", dashboard = "?" }) {
  const width = Math.max(cols, 30), height = Math.max(rows, 6);
  const bodyH = height - 3;
  const layout = layoutPanes({ cols: width, panes });
  const sel = entries[Math.min(state.sel, entries.length - 1)];
  const typing = focus === "term" && layout.shown.includes("term");
  const cells = {};
  if (layout.shown.includes("side")) {
    const w = layout.widths.side;
    cells.side = [`${DIM}${fit("슈퍼감독", w)}${RESET}`,
      ...Array.from({ length: bodyH - 1 }, (_, i) => (entries[i] ? sideLine(entries[i], entries[i] === sel, w) : " ".repeat(w)))];
  }
  if (layout.shown.includes("desc")) {
    const w = layout.widths.desc;
    const body = describeLines(sel, desc?.status ?? null, { loading: desc?.loading });
    const descLine = (i) => (body[i]?.startsWith(HEAD_MARK) ? `${DIM}${fit(body[i], w)}${RESET}` : fit(body[i] ?? "", w));
    cells.desc = [`${DIM}${fit("현재 세션 설명", w)}${RESET}`, ...Array.from({ length: bodyH - 1 }, (_, i) => descLine(i))];
  }
  let cursor = null;
  if (layout.shown.includes("term")) {
    const w = layout.widths.term;
    const view = termWindow(term, bodyH - 1, w);
    let label = sel?.session ?? "(슈퍼감독 없음)";
    if (sel && !sel.alive) label = `${sel.session} (세션 없음)`;
    else if (sel && typing) label = `입력 중 → ${sel.session} · Ctrl-] 목록으로`;
    const cut = view.cut && sel?.alive ? " · 오른쪽 잘림(사이드바·설명을 끄면 넓어짐)" : "";
    const headText = fit(label + (typing ? "" : cut), w);
    cells.term = [typing ? `${BOLD_GREEN}${headText}${RESET}` : `${DIM}${headText}${RESET}`, ...view.rows];
    if (typing && view.cursor) {
      const left = layout.shown.slice(0, -1).reduce((n, k) => n + layout.widths[k] + 1, 0);
      cursor = { row: 1 + view.cursor.row, col: left + view.cursor.col };
    }
  }
  const sep = (nextKey) => (nextKey === "term" && typing ? `${GREEN}┃${RESET}` : "│");
  const folded = layout.hidden.length ? " · 좁아서 일부 칸 접힘" : "";
  const lines = [fit(`카단 관제 · 슈퍼감독 ${entries.length}명 · 대시보드 ${dashboard}${folded}`, width)];
  for (let i = 0; i < bodyH; i++) {
    if (!layout.shown.length) { lines.push(fit(i === 0 ? "모든 칸이 꺼져 있습니다 — 1 2 3 으로 켜세요" : "", width)); continue; }
    lines.push(layout.shown.map((k, n) => (n ? sep(k) : "") + cells[k][i]).join(""));
  }
  lines.push(fit(notice || state.notice || "", width));
  lines.push(fit(typing ? "터미널 입력 중: Ctrl-]만 board가 받고 나머지 키는 전부 대상 창으로 갑니다" : KEYS_LIST, width));
  const tail = cursor ? `\x1b[${2 + cursor.row};${1 + cursor.col}H\x1b[?25h` : "\x1b[?25l";
  return "\x1b[H" + lines.map((l) => `${l}\x1b[K`).join("\r\n") + tail;
}
