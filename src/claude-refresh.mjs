// Why: claude-swap switch만으론 켜진 카단 Claude 세션이 새 계정을 읽지 못했다(2026-10-23 kyle 실측).
// 한도에 걸린 세션을 골라 같은 대화로 다시 켜야 하고, PR-1은 '어느 세션을 왜 켤지'를 보여 주기만 한다.
// 이 모듈의 미리보기(buildPreview·formatPreview)는 읽기 전용이다: 바닥에 키를 보내지 않고, 원장·우편·알림을 쓰지 않는다.
// 실제 다시 켜기(runRefresh, PR-2)는 사람이 고른 역할만 restartRole로 켠다 — 아래 runRefresh 머리말.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { launchIdentityOf } from "./ai-identity.mjs";
import { readStatusLine } from "./watch-status-line.mjs";
import { STATE_CHANGED_CODE } from "./restart.mjs";
import { scrubForAI } from "./explain-input.mjs";
import { scrubScreen } from "./revive.mjs";
import { claudeLimitMenu } from "./claude-limit-menu.mjs";

const SECRETARY = "비서";
const MAX_TAIL_LINES = 4;
const MAX_TAIL_WIDTH = 120;
const MAX_RESET_LINE = 120;

// 화면·오류·계정에서 온 모든 글은 이 함수 하나를 지나서 나간다(검수 F8·F9: 필드마다 따로 가리면 빠지는 곳이 생긴다).
// 기존 가림 함수 둘을 겹친다 — scrubForAI(웹훅·디코 봇 토큰·깃허브 토큰·`sk-` 키·Bearer)와 scrubScreen(Bot/Bearer 헤더·토큰 모양) —
// 거기에 이메일 꼴을 더한다. 자르기는 반드시 가림 뒤에 한다(잘린 토큰 조각이 남지 않게).
const EMAIL_SHAPE = /\S+@\S+/gu;
export const scrubText = (value) => (typeof value === "string" ? scrubScreen(scrubForAI(value)).replace(EMAIL_SHAPE, "") : value);
const safeText = (value, max) => scrubText(String(value ?? "")).slice(0, max);
const ACCOUNT_TIMEOUT_MS = 10_000;

// 한도 줄은 '줄 맨 앞'이 아래 머리말로 시작할 때만 본다. 문장 중간에 문구가 든 줄은 설명·인용이라 버린다.
// 출처: Claude Code 2.1.309 프로그램(~/.local/share/claude/versions/2.1.309)의 한도 오류 판별 목록 `i4r`
// (`["You've hit your","You've reached your",…]`를 `startsWith`로 비교). 이름 목록은 가져오지 않는다.
// `Usage limit reached`는 같은 프로그램의 목표 상태 줄(`Usage limit reached · continuing …`) 머리말이다.
// 실제 한도 화면은 2.1.308 이미지 전사 1장(`●`/`⏺` 변형)만 확인했다. 다른 버전·한도 종류의 기호는 미확인이라 아래 기호 5개를 선택적으로 걷어 낸다.
// 아포스트로피는 `'`와 `’` 둘 다 받고 대소문자는 원문 그대로 본다. 감시기 STOP_PHRASES에는 붙이지 않는다(이번 범위 밖).
export const CLAUDE_LIMIT_HEADS = [/^You['’]ve hit your /u, /^You['’]ve reached your /u, /^Usage limit reached/u];
const LEAD_SYMBOL = /^\s*(?:[⏺⎿●✗⚠]\s+)?/u;

const CLAUDE_INPUT = /^\s*[❯>]\s*$/u;
const ANY_COMPOSER = /^\s*[›❯]/u;
const USER_INPUT_LINE = /^\s*[❯>]\s+\S/u;
const RESPONSE_LINE = /^\s*⏺(?:\s|$)/u;
const TURN_DONE = /^✻\s+\S+\s+for\s+\d/u;
const FENCE = /^\s*(```|~~~)/u;
const RULE_OR_BLANK = /^[\s─━—-]*$/u;
const FOOTER_LINES = 5;

function trimmedLines(screen) {
  if (typeof screen !== "string") return [];
  const lines = screen.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

const limitHeadOf = (line) => {
  const rest = line.replace(LEAD_SYMBOL, "");
  return CLAUDE_LIMIT_HEADS.find((head) => head.test(rest)) ? rest : null;
};

// 한도 줄 찾기. 마지막 빈 입력창(또는 그 위 턴 끝 줄) 위쪽에서, 입력창과의 사이에 빈 줄·가로선·턴 끝 줄·들여쓴 이어진 줄만 있는
// 첫 한도 줄을 돌려준다. 확정할 수 없으면 null(놓치는 쪽으로 기울인다 — 오검출은 곧 엉뚱한 세션 재시작이다).
// 버리는 경우: 사이에 다른 응답 문단(`⏺ `)·사용자 입력 줄·들여쓰지 않은 다른 글이 있음, 코드 울타리 안,
// 줄 위쪽 덩어리(빈 줄 전까지)나 바로 위 줄이 `⏺ ` 응답/도구 호출이라 응답 안의 글일 수 있음.
// 알려진 한계(고치지 않음, 판정은 추천이다): 여러 줄 응답·도구 출력 뒤 빈 줄을 건너 나온 문구(F5), 문구로 시작하는 응답 첫 줄
// `⏺ You've hit your …`(F7)은 한도로 잘못 보일 수 있다. 실제 표본이 2.1.308 이미지 전사 1장뿐이라 규칙을 더 다듬지 않는다.
export function claudeLimitLine(screen) {
  const menu = claudeLimitMenu(screen);
  if (menu) {
    const above = screen.split('\n').slice(0, menu.title);
    let command = above.length - 1;
    while (command >= 0 && RULE_OR_BLANK.test(above[command])) command--;
    // 확인된 메뉴 바로 앞의 이 명령 한 줄만 예외다. 다른 입력은 기존 탐색 경계로 남긴다.
    if (command >= 0 && /^\s*❯ \/rate-limit-options\s*$/u.test(above[command])) {
      let at = command - 1;
      while (at >= 0 && (RULE_OR_BLANK.test(above[at]) || TURN_DONE.test(above[at]))) at--;
      const line = above[at];
      const head = line == null ? null : limitHeadOf(line);
      // 실제 메뉴와 정확한 명령이 바로 뒤따른 한도는 앞선 도구 응답의 들여쓰기 문맥과 구분한다.
      return head && !insideFence(above, at) ? { line: line.trim(), head } : null;
    }
    return claudeLimitLine(above.join('\n') + '\n❯');
  }
  const lines = trimmedLines(screen);
  const composer = lines.findLastIndex((line) => ANY_COMPOSER.test(line));
  if (composer < 0 || !CLAUDE_INPUT.test(lines[composer])) return null;
  const footer = lines.slice(composer + 1).filter((line) => !RULE_OR_BLANK.test(line));
  if (footer.length > FOOTER_LINES || footer.some((line) => ANY_COMPOSER.test(line) || FENCE.test(line) || /^\s*[•⏺]\s/u.test(line))) return null;
  for (let at = composer - 1; at >= 0; at--) {
    const line = lines[at];
    if (RULE_OR_BLANK.test(line) || TURN_DONE.test(line)) continue;
    if (FENCE.test(line) || USER_INPUT_LINE.test(line)) return null;
    const head = limitHeadOf(line);
    if (head) return precededByResponse(lines, at) || insideFence(lines, at) ? null : { line: line.trim(), head };
    if (RESPONSE_LINE.test(line) || !/^\s+\S/u.test(line)) return null; // 들여쓴 이어진 줄만 건너뛴다
  }
  return null;
}

function insideFence(lines, at) {
  let open = false;
  for (const line of lines.slice(0, at)) if (FENCE.test(line)) open = !open;
  return open;
}

// 한도 줄과 같은 덩어리(빈 줄 전까지) 위쪽에 응답 머리표가 있거나, 빈 줄을 건너 바로 위 글줄이 응답 머리표 줄이면 응답 안의 글이다.
// 위로 훑다가 사용자 입력 줄(`❯ 글`)이나 턴 끝 줄(`✻ … for …`)을 만나면 거기서 멈춘다 — 그 앞의 응답은 이전 턴이다(F6).
// 응답 머리표 줄이 그 자체로 한도 머리말이면(실측 2.1.308: `⏺ Usage limit reached again · continuing automatically …`) 응답 문맥이 아니라
// 한도 덩어리의 일부로 본다.
function precededByResponse(lines, at) {
  const boundary = (line) => USER_INPUT_LINE.test(line) || TURN_DONE.test(line);
  const response = (line) => RESPONSE_LINE.test(line) && !limitHeadOf(line);
  let above = at - 1;
  while (above >= 0 && !RULE_OR_BLANK.test(lines[above])) {
    if (boundary(lines[above])) return false;
    if (response(lines[above])) return true;
    above--;
  }
  while (above >= 0 && RULE_OR_BLANK.test(lines[above])) above--;
  return above >= 0 && !boundary(lines[above]) && response(lines[above]);
}

// 한도 줄이 있으면 {phrase, resetLine}. resetLine: 그 줄에 초기화 시각(`resets …`)이 있으면 원문 그대로(최대 120자).
export function claudeLimitMatch(screen) {
  const found = claudeLimitLine(screen);
  if (!found) return null;
  return { phrase: found.head.slice(0, 40), resetLine: /\bresets?\b/iu.test(found.line) ? safeText(found.line, MAX_RESET_LINE) : null };
}

// 화면 아래 상태 줄의 `Nh Nm left`는 싣지 않는다: 상태 줄 스크립트가 ccusage 공용 캐시 파일 하나에서 그리는 값이라
// 세션별·계정별 근거가 아니다(2026-10-23 감독 확인).

// 마지막 빈 입력창 위의 비지 않은 줄 최대 4줄 원문(각 줄 120자, 이메일 꼴은 지움). 사람이 직접 읽고 확인하는 근거다.
export function claudeScreenTail(screen) {
  const lines = trimmedLines(screen);
  const composer = lines.findLastIndex((line) => ANY_COMPOSER.test(line));
  const above = composer < 0 ? lines : lines.slice(0, composer);
  return above.filter((line) => !RULE_OR_BLANK.test(line)).slice(-MAX_TAIL_LINES).map((line) => safeText(line, MAX_TAIL_WIDTH));
}

// 첫 번째로 맞는 추정 하나: (a) 응답 생성 중 → (b) 한도로 보임(규칙) → (c) 입력 대기 → (d) 판정 불가
// 화면 글 규칙에 따른 추천이다. 실제 표본이 1장뿐이라 오검출·누락이 있을 수 있고, 근거는 사람이 원문(screenTail)을 읽어 확인한다.
export function judgeScreen(screen, select) {
  const status = readStatusLine(screen);
  if (status.kind === "working") return { verdict: "skip", reason: "응답 생성 중" };
  if (select === 'all' && claudeLimitMenu(screen)) return { verdict: 'skip', reason: '한도 선택 메뉴' };
  const limit = claudeLimitMatch(screen);
  if (limit) return { verdict: "target", reason: "한도로 보임(규칙)", resetLine: limit.resetLine };
  if (status.kind === "idle") return select === "all" ? { verdict: "target", reason: "입력 대기" } : { verdict: "none", reason: "해당 없음" };
  return { verdict: "skip", reason: "판정 불가" };
}

function currentStart(entries, session) {
  const events = entries.filter((e) => e.session === session);
  const index = events.findLastIndex((e) => e.kind === "start");
  if (index < 0) return null;
  if (events.slice(index + 1).some((e) => e.kind === "stop")) return null;
  return events[index];
}

const errText = (error) => safeText(String(error?.message ?? error).split("\n")[0], 80);

// 세션 하나의 한 줄. floor.read(화면 읽기)·floor.alive·floor.pid만 쓴다. buildPreview와 runRefresh(직전 확인)가 같은 판정을 쓴다.
export function previewRow({ entries, floor, pendingCards, session, self = process.env.KADAN_ROLE, select = "limit" }) {
  const start = currentStart(entries, session);
  const row = { role: start?.role ?? session.slice("kadan-".length), session, harness: null, model: null, cards: null, verdict: "excluded", reason: "", resetLine: null, screenTail: [], pending: [] };
  if (!start) { row.reason = "기반"; return row; }
  if (start.role === SECRETARY || start.roleProfile === "secretary") { row.reason = "비서"; return row; }
  if (self && start.role === self) { row.reason = "자기 자신"; return row; }
  const identity = launchIdentityOf(start.cmd);
  // not-ai: 등록 실행기가 아닌 명령(셸 등)이라 harness 칸에 든 이름은 실행기가 아니다.
  row.harness = identity.reason === "not-ai" ? null : identity.harness ?? null;
  row.model = identity.model ?? null;
  if (!row.harness) { row.reason = "실행기 모름"; return row; }
  if (row.harness !== "claude") { row.reason = `다른 실행기(${row.harness})`; return row; }
  try { row.pending = pendingCards(entries, start.role); row.cards = row.pending.length; } catch { row.cards = null; }
  try {
    if (floor.alive && !floor.alive(session)) throw new Error("세션 없음");
    if (start.panePid && floor.pid && String(floor.pid(session)) !== String(start.panePid)) throw new Error("pane PID 불일치");
  } catch { row.verdict = "skip"; row.reason = "생존 확인 실패"; return row; }
  let screen;
  try { screen = floor.read(session); } catch (error) { row.verdict = "skip"; row.reason = `화면 읽기 실패(${errText(error)})`; return row; }
  if (typeof screen !== "string") { row.verdict = "skip"; row.reason = "화면 읽기 실패(빈 응답)"; return row; }
  const judged = judgeScreen(screen, select);
  row.verdict = judged.verdict;
  row.reason = judged.reason;
  row.resetLine = judged.resetLine ?? null;
  if (judged.verdict === "target") row.screenTail = claudeScreenTail(screen);
  return row;
}

// 바닥에 살아 있는 카단 세션마다 한 줄.
export function buildPreview({ entries, floor, pendingCards, self = process.env.KADAN_ROLE, select = "limit" }) {
  const live = floor.list().filter((item) => item.alive !== false && String(item.session).startsWith("kadan-"));
  return live.map((item) => { const { pending, ...row } = previewRow({ entries, floor, pendingCards, session: item.session, self, select }); return row; });
}

export function previewCounts(rows) {
  const count = (verdict) => rows.filter((r) => r.verdict === verdict).length;
  return { target: count("target"), skip: count("skip"), excluded: count("excluded"), none: count("none") };
}

// ---- 계정 남은 한도: `claude-swap list --json` 출력만 읽는다. 이메일·조직 정보는 읽자마자 버린다. ----
const num = (value) => (Number.isFinite(value) ? value : null);
const left = (used) => (used == null ? null : Math.max(0, Math.min(100, 100 - used)));
// 허용 꼴만 싣고 아니면 대체 글자로 바꾼다: 이 칸들은 claude-swap이 준 임의 문자열이라 이메일이 섞일 수 있다(검수 F2).
const COUNTDOWN = /^\d+[dhm](?: \d+[dhm])*$/u;
const STATUS = /^[a-z0-9_-]{1,32}$/u;
const countdown = (value) => (typeof value === "string" ? (COUNTDOWN.test(value) ? value : "?") : null);
const statusCode = (value) => (typeof value === "string" ? (STATUS.test(value) ? value : "기타") : "알 수 없음");
// 마지막 방어: 계정 관련 모든 문자열도 같은 가림 함수를 지난다.
const scrub = scrubText;

function accountRow(raw) {
  const usage = raw?.usage && typeof raw.usage === "object" ? raw.usage : null;
  const five = usage?.fiveHour, seven = usage?.sevenDay;
  const ok = raw?.usageStatus === "ok" && usage != null;
  return {
    number: num(raw?.number),
    active: raw?.active === true,
    status: scrub(ok ? "ok" : `조회 실패(${statusCode(raw?.usageStatus)})`),
    fiveHourUsedPct: ok ? num(five?.pct) : null,
    fiveHourLeftPct: ok ? left(num(five?.pct)) : null,
    fiveHourResetsIn: ok ? scrub(countdown(five?.countdown)) : null,
    sevenDayUsedPct: ok ? num(seven?.pct) : null,
    sevenDayLeftPct: ok ? left(num(seven?.pct)) : null,
    sevenDayResetsIn: ok ? scrub(countdown(seven?.countdown)) : null,
    willLastToReset: ok && typeof seven?.willLastToReset === "boolean" ? seven.willLastToReset : null,
  };
}

const isExecutable = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } };

// 찾는 순서: KADAN_CLAUDE_SWAP_BIN → PATH의 claude-swap → ~/.local/bin/claude-swap(실행 파일일 때). 작업자 셸에서 PATH에 없어 127이 난 일의 재발 방지.
export function claudeSwapCandidates({ env = process.env, home = os.homedir(), executable = isExecutable } = {}) {
  const list = [];
  if (env.KADAN_CLAUDE_SWAP_BIN) list.push(env.KADAN_CLAUDE_SWAP_BIN);
  list.push("claude-swap");
  const local = path.join(home, ".local", "bin", "claude-swap");
  if (executable(local)) list.push(local);
  return list;
}

// 실행 1번에 한 번만 부른다(못 찾아 다음 후보로 넘어간 시도는 세지 않는다). 실패·시간 초과·모양 불일치는 표를 깨지 않고
// {ok:false, reason} 한 줄로 끝낸다. 이유는 정해진 짧은 코드로만 낸다 — error.message 원문은 싣지 않는다(이메일이 섞일 수 있음).
export function readAccounts({ run = spawnSync, env = process.env, home = os.homedir(), executable = isExecutable } = {}) {
  let result = null;
  for (const bin of claudeSwapCandidates({ env, home, executable })) {
    try { result = run(bin, ["list", "--json"], { encoding: "utf8", timeout: ACCOUNT_TIMEOUT_MS, env, maxBuffer: 1 << 20 }); }
    catch (error) { result = { error: { code: error?.code } }; }
    if (result?.error?.code !== "ENOENT") break;
  }
  if (result?.error) return { ok: false, reason: result.error.code === "ETIMEDOUT" ? "시간 초과" : result.error.code === "ENOENT" ? "claude-swap 없음" : "실행 실패" };
  if (result?.status !== 0) return { ok: false, reason: `종료 코드 ${Number.isInteger(result?.status) ? result.status : "없음"}` };
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { return { ok: false, reason: "JSON 아님" }; }
  if (!parsed || !Array.isArray(parsed.accounts)) return { ok: false, reason: "모양 다름" };
  const accounts = parsed.accounts.map(accountRow);
  if (accounts.some((a) => a.number == null)) return { ok: false, reason: "모양 다름" };
  return { ok: true, activeAccountNumber: num(parsed.activeAccountNumber), accounts };
}

// ---- 표 ----
const pct = (value) => (value == null ? "-" : `${value}%`);
const cell = (value) => (value == null || value === "" ? "-" : String(value));

export function formatPreview(rows, accounts, { select = "limit" } = {}) {
  const out = ["미리보기 — 아무것도 바꾸지 않음", `선택 기준: ${select}`, ""];
  const header = ["역할", "세션", "실행기·모델", "카드", "추정", "조치"];
  const body = rows.map((r) => {
    const screenJudged = ["응답 생성 중", "판정 불가", "입력 대기"].includes(r.reason) || r.verdict === "target" || r.verdict === "none";
    const judged = screenJudged ? r.reason : `${{ skip: "건너뜀", excluded: "제외" }[r.verdict]}: ${r.reason}`;
    const action = r.verdict === "target"
      ? (r.cards > 0 ? `다시 켜기 대상(카드 ${r.cards}건 — 다시 켜도 카드는 그대로 남는다)` : "다시 켜기 대상")
      : "-";
    return [r.role, r.session, r.harness ? `${r.harness} ${cell(r.model)}` : "-", cell(r.cards), judged, action];
  });
  out.push(...table([header, ...body]));
  const c = previewCounts(rows);
  out.push("", `대상 ${c.target} · 건너뜀 ${c.skip} · 제외 ${c.excluded} · 해당 없음 ${c.none}`);
  out.push("추정은 화면 글 규칙에 따른 추천이다. 근거는 아래 원문을 직접 읽어 확인한다");
  for (const r of rows) {
    if (!r.screenTail?.length) continue;
    out.push("", `[${r.role}] 입력창 위 화면 원문(최대 ${MAX_TAIL_LINES}줄)`, ...r.screenTail.map((line) => `  | ${line}`));
    if (r.resetLine) out.push(`  초기화 줄: ${r.resetLine}`);
  }
  if (accounts) {
    out.push("");
    if (!accounts.ok) out.push(`계정 한도: 읽지 못함(${scrub(accounts.reason)})`);
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

// ---- 2단계: 사람이 --role로 고른 세션만 같은 대화로 다시 켜기 ----
// 대상은 사람이 고른다. 화면 판정(한도로 보임 등)은 추천일 뿐이라 선택에 쓰지 않고, 직전 안전 확인(입력창 비어 있고 응답 생성 중이 아님)에만 쓴다.
// 다시 켜기는 restartRole(accountRefresh)이 한다 — 끝나지 않은 카드가 있어도 --force 없이 켠다(2026-10-23 [kyle] 질문 2).
// 사람 확인: KADAN_ROLE이 설정된 셸(카단 역할 세션 안)에서는 거절한다. 스스로 밝힌 신분이라 완전한 인증은 아니다 —
// 환경 변수를 비우면 우회할 수 있어, 막는 것은 역할 AI가 실수로 부르는 경우다.
export const HUMAN_ONLY_MESSAGE = "이 명령은 사람이 직접 친다 — 역할 세션 안에서는 실행하지 않는다";
// --role 값은 미리보기 표의 role 칸 이름이다. 세션 이름(kadan-…)을 주면 알아보기 쉬운 오류를 낸다. 잘못된 값은 Error로 던진다.
export const roleOfSession = (entries, session) => currentStart(entries, session)?.role ?? session.slice("kadan-".length);

export function parseRoleList(flag, liveRoles, liveSessions) {
  if (typeof flag !== "string" || !flag.trim()) throw new Error("--role에는 역할 이름이 필요하다 — 미리보기 표의 role 칸 이름(쉼표로 여러 개)");
  const roles = flag.split(",").map((name) => name.trim());
  if (roles.some((name) => !name)) throw new Error("--role에 빈 이름이 있다");
  if (new Set(roles).size !== roles.length) throw new Error("--role에 같은 역할이 두 번 들어 있다");
  for (const name of roles) {
    if (!liveRoles.has(name) && liveSessions.has(name)) {
      throw new Error(`'${name}'은 세션 이름이다 — --role에는 미리보기 표의 role 칸 이름(예: ${name.slice("kadan-".length)})을 쓴다`);
    }
  }
  return roles;
}

const READY_WAIT_MS = 30_000;
const READY_POLL_MS = 2_000;
const SCREEN_END_LINES = 4;

// 다시 켠 뒤 화면 끝 원문 4줄(가림 함수 통과). 입력창 위치와 무관하게 마지막 비지 않은 줄을 본다.
export function screenEnd(screen) {
  return trimmedLines(screen).filter((line) => !RULE_OR_BLANK.test(line)).slice(-SCREEN_END_LINES).map((line) => safeText(line, MAX_TAIL_WIDTH));
}

// 큰 대화의 --resume은 처음 몇 초가 불러오는 화면이라 idle 또는 working이 될 때까지 최대 30초 읽는다. 판정은 하지 않는다.
export function waitForScreen({ floor, session, sleep, now }) {
  const started = now();
  let screen = null, error = null;
  for (;;) {
    try { screen = floor.read(session); error = null; } catch (e) { error = e; }
    if (typeof screen === "string" && readStatusLine(screen).kind !== "unknown") return { state: "ready", screen };
    if (now() - started >= READY_WAIT_MS) return { state: "timeout", screen: typeof screen === "string" ? screen : null, error };
    sleep(READY_POLL_MS);
  }
}

// roles: 사람이 고른 역할 이름(순서 그대로). 첫 실패에서 멈추고 나머지는 "안 함"으로 표에 남긴다.
export function runRefresh({ roles, entriesOf, floor, pendingCards, restart, reason = null, accountSlot = null, intervalSec = 8, self = process.env.KADAN_ROLE, sleep, now }) {
  const results = [];
  let needRest = false, halted = false;
  for (const role of roles) {
    if (halted) { results.push({ role, outcome: "not-run", reason: "앞선 역할 실패로 멈춤" }); continue; }
    const entries = entriesOf();
    const live = floor.list().filter((item) => item.alive !== false && String(item.session).startsWith("kadan-"));
    const session = live.map((item) => item.session).find((name) => currentStart(entries, name)?.role === role);
    if (!session) { results.push({ role, outcome: "skipped", reason: "살아 있는 역할이 아님" }); continue; }
    // 순서는 "쉬기 → 확인 → 다시 켜기"다. 쉰 뒤에 확인해야 확인과 끄기 사이에 기다리는 시간이 끼지 않는다(검수 F1).
    if (needRest) { sleep(intervalSec * 1000); needRest = false; }
    // 직전 확인: 바로 지금 읽은 화면이 idle이어야 한다. select "all"에서 target이면 곧 idle(빈 입력창, 진행 표시 없음)이다.
    const row = previewRow({ entries, floor, pendingCards, session, self, select: "all" });
    if (row.verdict !== "target") { results.push({ role, outcome: "skipped", reason: `${row.verdict === "excluded" ? "제외" : "건너뜀"}: ${row.reason}` }); continue; }
    let receipt;
    try {
      receipt = restart({ role, session, flags: { accountRefresh: true, ...(reason ? { reason } : {}), ...(accountSlot != null ? { accountSlot } : {}) } });
    } catch (error) {
      // 끄기 직전 재확인(restartRole의 beforeStop)이 막은 것은 실패가 아니다. 끄지 않았으니 다음 역할로 계속 간다.
      if (error?.code === STATE_CHANGED_CODE) { results.push({ role, outcome: "skipped", reason: safeText(error.message, 300), cards: row.pending }); continue; }
      results.push({ role, outcome: "failed", reason: safeText(error?.message ?? error, 1000), cards: row.pending });
      halted = true;
      continue;
    }
    needRest = true;
    const waited = waitForScreen({ floor, session, sleep, now });
    results.push({ role, outcome: "restarted", cards: row.pending, panePid: receipt.panePid ?? null, conversation: receipt.conversation ?? null,
      screenState: waited.state, screenEnd: waited.screen == null ? [] : screenEnd(waited.screen) });
  }
  return results;
}

const OUTCOME_LABEL = { restarted: "다시 켬", skipped: "건너뜀", failed: "실패", "not-run": "안 함" };

export function formatRefreshResult(results) {
  const out = ["계정 전환 재시작 결과", ""];
  out.push(...table([["역할", "결과", "카드", "새 PID", "이유"], ...results.map((r) => [r.role, OUTCOME_LABEL[r.outcome], r.cards ? r.cards.length : "-", r.panePid ?? "-", r.reason ?? "-"])]));
  for (const r of results) {
    if (r.outcome === "failed") out.push("", `[${r.role}] 실패 — 나머지는 하지 않았다. 원인을 모르면 재시도하지 않는다. 복구 명령은 위 이유 칸의 안내를 따른다.`);
    if (r.outcome !== "restarted") continue;
    out.push("", `[${r.role}] 화면 끝 원문(최대 ${SCREEN_END_LINES}줄) — ${r.screenState === "ready" ? "입력 대기 또는 작업 중 화면" : "30초 안에 안정되지 않아 시간 초과 시점 화면"}`, ...r.screenEnd.map((line) => `  | ${line}`));
  }
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  out.push("", `다시 켬 ${count("restarted")} · 건너뜀 ${count("skipped")} · 실패 ${count("failed")} · 안 함 ${count("not-run")}`);
  out.push("판정은 하지 않는다. 한도 메시지가 사라졌는지는 위 원문을 직접 읽어 확인한다");
  return out.join("\n");
}
