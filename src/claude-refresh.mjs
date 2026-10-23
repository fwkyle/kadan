// Why: claude-swap switch만으론 켜진 카단 Claude 세션이 새 계정을 읽지 못했다(2026-10-23 kyle 실측).
// 한도에 걸린 세션을 골라 같은 대화로 다시 켜야 하고, PR-1은 '어느 세션을 왜 켤지'를 보여 주기만 한다.
// 이 모듈은 읽기 전용이다: 바닥에 키를 보내지 않고, 원장·우편·알림을 쓰지 않는다.
import { spawnSync } from "node:child_process";
import { launchIdentityOf } from "./ai-identity.mjs";
import { readStatusLine } from "./watch-status-line.mjs";

const SECRETARY = "비서";
const BOTTOM_LINES = 14;
const MAX_RESET_LINE = 120;
const ACCOUNT_TIMEOUT_MS = 10_000;

// 둘 다 kyle이 본 문구다. 실제 Claude 한도 화면 표본은 없다(2026-10-23 감독이 감시AI 기록·작업자 화면을 찾았으나 못 찾음).
// 아포스트로피는 `'`와 `’` 둘 다 받고 대소문자는 원문 그대로 본다. 감시기 STOP_PHRASES에는 붙이지 않는다(이번 범위 밖).
export const CLAUDE_LIMIT_PHRASES = [/You['’]ve hit your session limit/u, /Usage limit reached/u];

const CLAUDE_INPUT = /^\s*[❯>]\s*$/u;
const ANY_COMPOSER = /^\s*[›❯]/u;
const TURN_DONE = /^✻\s+\S+\s+for\s+\d/u;
const CLAUDE_ERROR_HEAD = /^⏺\s+API Error:/u;
const FENCE = /^\s*(```|~~~)/u;
const RULE_OR_BLANK = /^[\s─━—-]*$/u;
const QUOTED = /^\s*[>❯"“'‘│]/u;
const FOOTER_LINES = 5;
const TIME_LEFT = /\d+h \d+m left/gu;

function trimmedLines(screen) {
  if (typeof screen !== "string") return [];
  const lines = screen.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

// 현재 오류 덩어리: 마지막 빈 입력창(또는 그 위 턴 끝 줄) 바로 위에 붙은, 빈 줄로 끊기지 않는 덩어리.
// 머리줄 모양(`⏺ API Error:` 등)에는 기대지 않는다. 대신 대화 본문으로 보이는 것만 뺀다:
//  - 코드 울타리가 한 줄이라도 걸친 덩어리, 응답 머리표(`⏺ `) 문단(`⏺ API Error:`만 예외), 콜론으로 끝나는 소개 문단 바로 아래
//  - 입력창에 쓰는 중인 글이 마지막이거나 입력창 아래에 다른 응답·입력창이 있는 화면
export function claudeCurrentBlock(screen) {
  const lines = trimmedLines(screen);
  const composer = lines.findLastIndex((line) => ANY_COMPOSER.test(line));
  if (composer < 0 || !CLAUDE_INPUT.test(lines[composer])) return null;
  const footer = lines.slice(composer + 1).filter((line) => !RULE_OR_BLANK.test(line));
  if (footer.length > FOOTER_LINES || footer.some((line) => ANY_COMPOSER.test(line) || FENCE.test(line) || /^\s*[•⏺]\s/u.test(line))) return null;
  let end = composer - 1;
  while (end >= 0 && RULE_OR_BLANK.test(lines[end])) end--;
  if (end >= 0 && TURN_DONE.test(lines[end])) {
    end--;
    while (end >= 0 && RULE_OR_BLANK.test(lines[end])) end--;
  }
  if (end < 0) return null;
  let head = end;
  while (head > 0 && !RULE_OR_BLANK.test(lines[head - 1])) head--;
  const block = lines.slice(head, end + 1);
  // 코드 울타리: 덩어리 안에 울타리 줄이 있거나, 위쪽에서 열린 울타리 안이면 코드다.
  let open = false;
  for (const line of lines.slice(0, head)) if (FENCE.test(line)) open = !open;
  if (open || block.some((line) => FENCE.test(line))) return null;
  if (/^⏺\s/u.test(block[0]) && !CLAUDE_ERROR_HEAD.test(block[0])) return null;
  let above = head - 1;
  while (above >= 0 && RULE_OR_BLANK.test(lines[above])) above--;
  const intro = above >= 0 ? lines[above] : "";
  if (/[:：]\s*$/u.test(intro)) return null;
  return { lines: block };
}

// 한도 문구가 현재 오류 덩어리 안에 있으면 {phrase, resetLine}. 없으면 null.
// 인용 줄(`>`·`❯`·따옴표로 시작)의 문구는 대화 인용이라 세지 않는다. resetLine: 문구가 든 줄에 초기화 시각(`resets …`)이 있으면 원문 그대로(최대 120자).
export function claudeLimitMatch(screen) {
  const block = claudeCurrentBlock(screen);
  if (!block) return null;
  for (const line of block.lines) {
    if (QUOTED.test(line)) continue;
    const pattern = CLAUDE_LIMIT_PHRASES.find((p) => p.test(line));
    if (!pattern) continue;
    const text = line.trim();
    return { phrase: pattern.exec(line)[0], resetLine: /\bresets?\b/iu.test(text) ? text.slice(0, MAX_RESET_LINE) : null };
  }
  return null;
}

// Claude 화면 아래 상태 줄의 `3h 43m left` 조각을 원문 그대로. 없으면 null. 해석하지 않는다.
export function claudeTimeLeft(screen) {
  const text = trimmedLines(screen).slice(-BOTTOM_LINES).join("\n");
  const found = text.match(TIME_LEFT);
  return found ? found.at(-1) : null;
}

// 첫 번째로 맞는 판정 하나: (a) 응답 생성 중 → (b) 한도 문구 → (c) 입력 대기 → (d) 화면 판정 불가
export function judgeScreen(screen, select) {
  const status = readStatusLine(screen);
  if (status.kind === "working") return { verdict: "skip", reason: "응답 생성 중" };
  const limit = claudeLimitMatch(screen);
  if (limit) return { verdict: "target", reason: "한도 문구 일치", resetLine: limit.resetLine };
  if (status.kind === "idle") return select === "all" ? { verdict: "target", reason: "입력 대기" } : { verdict: "none", reason: "해당 없음" };
  return { verdict: "skip", reason: "화면 판정 불가" };
}

function currentStart(entries, session) {
  const events = entries.filter((e) => e.session === session);
  const index = events.findLastIndex((e) => e.kind === "start");
  if (index < 0) return null;
  if (events.slice(index + 1).some((e) => e.kind === "stop")) return null;
  return events[index];
}

const errText = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 80);

// 바닥에 살아 있는 카단 세션마다 한 줄. floor.read(화면 읽기)·floor.alive·floor.pid만 쓴다.
export function buildPreview({ entries, floor, pendingCards, self = process.env.KADAN_ROLE, select = "limit" }) {
  const rows = [];
  const live = floor.list().filter((item) => item.alive !== false && String(item.session).startsWith("kadan-"));
  for (const item of live) {
    const session = item.session;
    const start = currentStart(entries, session);
    const row = { role: start?.role ?? session.slice("kadan-".length), session, harness: null, model: null, cards: null, timeLeft: null, verdict: "excluded", reason: "", resetLine: null };
    rows.push(row);
    if (!start) { row.reason = "기반"; continue; }
    if (start.role === SECRETARY || start.roleProfile === "secretary") { row.reason = "비서"; continue; }
    if (self && start.role === self) { row.reason = "자기 자신"; continue; }
    const identity = launchIdentityOf(start.cmd);
    // not-ai: 등록 실행기가 아닌 명령(셸 등)이라 harness 칸에 든 이름은 실행기가 아니다.
    row.harness = identity.reason === "not-ai" ? null : identity.harness ?? null;
    row.model = identity.model ?? null;
    if (!row.harness) { row.reason = "실행기 모름"; continue; }
    if (row.harness !== "claude") { row.reason = `다른 실행기(${row.harness})`; continue; }
    try { row.cards = pendingCards(entries, start.role).length; } catch { row.cards = null; }
    try {
      if (floor.alive && !floor.alive(session)) throw new Error("세션 없음");
      if (start.panePid && floor.pid && String(floor.pid(session)) !== String(start.panePid)) throw new Error("pane PID 불일치");
    } catch { row.verdict = "skip"; row.reason = "생존 확인 실패"; continue; }
    let screen;
    try { screen = floor.read(session); } catch (error) { row.verdict = "skip"; row.reason = `화면 읽기 실패(${errText(error)})`; continue; }
    if (typeof screen !== "string") { row.verdict = "skip"; row.reason = "화면 읽기 실패(빈 응답)"; continue; }
    row.timeLeft = claudeTimeLeft(screen);
    const judged = judgeScreen(screen, select);
    row.verdict = judged.verdict;
    row.reason = judged.reason;
    row.resetLine = judged.resetLine ?? null;
  }
  return rows;
}

export function previewCounts(rows) {
  const count = (verdict) => rows.filter((r) => r.verdict === verdict).length;
  return { target: count("target"), skip: count("skip"), excluded: count("excluded"), none: count("none") };
}

// ---- 계정 남은 한도: `claude-swap list --json` 출력만 읽는다. 이메일·조직 정보는 읽자마자 버린다. ----
const num = (value) => (Number.isFinite(value) ? value : null);
const left = (used) => (used == null ? null : Math.max(0, Math.min(100, 100 - used)));
const text = (value) => (typeof value === "string" ? value.slice(0, 40) : null);

function accountRow(raw) {
  const usage = raw?.usage && typeof raw.usage === "object" ? raw.usage : null;
  const five = usage?.fiveHour, seven = usage?.sevenDay;
  const ok = raw?.usageStatus === "ok" && usage != null;
  return {
    number: num(raw?.number),
    active: raw?.active === true,
    status: ok ? "ok" : `조회 실패(${text(raw?.usageStatus) ?? "알 수 없음"})`,
    fiveHourUsedPct: ok ? num(five?.pct) : null,
    fiveHourLeftPct: ok ? left(num(five?.pct)) : null,
    fiveHourResetsIn: ok ? text(five?.countdown) : null,
    sevenDayUsedPct: ok ? num(seven?.pct) : null,
    sevenDayLeftPct: ok ? left(num(seven?.pct)) : null,
    sevenDayResetsIn: ok ? text(seven?.countdown) : null,
    willLastToReset: ok && typeof seven?.willLastToReset === "boolean" ? seven.willLastToReset : null,
  };
}

// 실행 1번에 한 번만 부른다. 실패·시간 초과·모양 불일치는 표를 깨지 않고 {ok:false, reason} 한 줄로 끝낸다.
export function readAccounts({ run = spawnSync, env = process.env } = {}) {
  let result;
  try { result = run("claude-swap", ["list", "--json"], { encoding: "utf8", timeout: ACCOUNT_TIMEOUT_MS, env, maxBuffer: 1 << 20 }); }
  catch (error) { return { ok: false, reason: errText(error) }; }
  if (result?.error) return { ok: false, reason: result.error.code === "ETIMEDOUT" ? "시간 초과(10초)" : result.error.code === "ENOENT" ? "claude-swap 없음" : errText(result.error) };
  if (result?.status !== 0) return { ok: false, reason: `종료 코드 ${result?.status ?? "없음"}` };
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { return { ok: false, reason: "JSON이 아님" }; }
  if (!parsed || !Array.isArray(parsed.accounts)) return { ok: false, reason: "모양이 다름(accounts 없음)" };
  const accounts = parsed.accounts.map(accountRow);
  if (accounts.some((a) => a.number == null)) return { ok: false, reason: "모양이 다름(번호 없음)" };
  return { ok: true, activeAccountNumber: num(parsed.activeAccountNumber), accounts };
}

// ---- 표 ----
const pct = (value) => (value == null ? "-" : `${value}%`);
const cell = (value) => (value == null || value === "" ? "-" : String(value));

export function formatPreview(rows, accounts, { select = "limit" } = {}) {
  const out = ["미리보기 — 아무것도 바꾸지 않음", `선택 기준: ${select}`, ""];
  const header = ["역할", "세션", "실행기·모델", "카드", "남은 시간", "판정", "조치"];
  const body = rows.map((r) => {
    const verdict = { target: "대상", skip: "건너뜀", excluded: "제외", none: "" }[r.verdict];
    const judged = r.verdict === "none" ? r.reason : `${verdict}: ${r.reason}`;
    const action = r.verdict === "target"
      ? (r.cards > 0 ? `다시 켜기 대상(카드 ${r.cards}건 — 카드 유지 재시작은 kyle 결정 대기)` : "다시 켜기 대상")
      : "-";
    return [r.role, r.session, r.harness ? `${r.harness} ${cell(r.model)}` : "-", cell(r.cards), cell(r.timeLeft), judged, action];
  });
  out.push(...table([header, ...body]));
  for (const r of rows) if (r.resetLine) out.push(`  ${r.role} 초기화 줄: ${r.resetLine}`);
  const c = previewCounts(rows);
  out.push("", `대상 ${c.target} · 건너뜀 ${c.skip} · 제외 ${c.excluded} · 해당 없음 ${c.none}`);
  if (accounts) {
    out.push("");
    if (!accounts.ok) out.push(`계정 한도: 읽지 못함(${accounts.reason})`);
    else {
      out.push(...table([
        ["계정", "활성", "5시간 남은", "5시간 초기화까지", "주간 남은", "주간 초기화까지", "주간 버팀", "조회"],
        ...accounts.accounts.map((a) => [a.number, a.active ? "활성" : "-", pct(a.fiveHourLeftPct), cell(a.fiveHourResetsIn), pct(a.sevenDayLeftPct), cell(a.sevenDayResetsIn),
          a.willLastToReset == null ? "-" : a.willLastToReset ? "예" : "아니오", a.status === "ok" ? "정상" : a.status]),
      ]));
      out.push("활성 계정 = 새로 켜는 세션이 쓸 계정, 이미 켜진 세션은 옛 로그인일 수 있음");
    }
  }
  return out.join("\n");
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => displayWidth(String(r[i])))));
  return rows.map((r) => r.map((v, i) => String(v) + " ".repeat(widths[i] - displayWidth(String(v)))).join("  ").trimEnd());
}

// 한글·전각은 두 칸으로 센다(터미널 표 정렬용).
function displayWidth(value) {
  let width = 0;
  for (const ch of value) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/u.test(ch) ? 2 : 1;
  return width;
}

export function previewJson(rows, accounts) {
  return { preview: true, rows, counts: previewCounts(rows), accounts: accounts ?? null };
}
