// 시니어 agy 대화창의 화면·답 구간 판정 — 순수 함수만 둔다(tmux·파일을 건드리지 않는다).
// 근거 화면은 agy 1.5.10 대화창 한 세션이다(2026-11-18 조사). claude·codex 판정기를 그대로 쓰지 않는다: 입력 기호가 `>`이고
// 입력칸이 가로줄 두 개 사이에 있으며, 답은 파일이 아니라 화면(스크롤 기록)에 남는다.
//   ────────────            ← 입력칸 위 가로줄
//   > (입력칸의 글, 길면 다음 줄을 두 칸 들여 잇는다)
//   ────────────            ← 입력칸 아래 가로줄
//   ? for shortcuts   auto · kadan-noexec (모델 · 강도)  /agents     ← 바닥글 한 줄
// 바닥글 왼쪽 글이 상태를 말한다: 빈 입력칸은 `? for shortcuts`, 일하는 중은 `esc to cancel`, 글이 들면 비어 있다.
// 가장 나쁜 것은 (1) 신뢰·선택 창에 키가 나가는 것, (2) 잘린 답·남의 답을 ok로 받는 것이다. 모르는 모양은 모두 '아니다'로 읽는다.
import {NOEXEC_AGENT} from './exec-agent.mjs';
import {ANSWER_LIMIT_BYTES} from './senior-screen.mjs';

const RULE = /^─{20,}$/u;
const IDLE_HINT = '? for shortcuts';
const WORKING_HINT = 'esc to cancel';
// 일하는 표시 줄: 점자 회전 글자 + 낱말 + 말줄임(`⣟  Generating...`). 입력칸 위 가로줄 바로 위에 온다.
const SPINNER = /^[⠀-⣿]\s+\S.*(?:\.\.\.|…)$/u;
const squash = text => String(text ?? '').replace(/\s+/gu, '');

function screenLines(screen) {
  const lines = String(screen ?? '').split('\n').map(line => line.replace(/\s+$/u, ''));
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}

// 화면 끝의 입력칸을 읽는다. 마지막 두 가로줄 사이가 입력칸이고 그 아래는 바닥글 한 줄뿐이어야 한다.
// 반환: {found: false, why} | {found: true, text, top, hint, settled, working, why?}
//  - hint: 바닥글 왼쪽 글(`? for shortcuts`·`esc to cancel`·빈 글·그 밖의 글)
//  - settled: 바닥글이 한 줄이고 우리가 띄운 에이전트 이름이 그 줄에 있다(선택 창·완성 목록·다른 화면이 아니다)
export function readAgyComposer(screen, agent = NOEXEC_AGENT) {
  const lines = screenLines(screen);
  const bottom = lines.findLastIndex(line => RULE.test(line));
  const top = bottom < 0 ? -1 : lines.findLastIndex((line, index) => index < bottom && RULE.test(line));
  if (top < 0) return {found: false, why: 'no-composer'};
  const inner = lines.slice(top + 1, bottom);
  if (!inner.length || !/^>(?:\s|$)/u.test(inner[0])) return {found: false, why: 'no-composer'};
  if (inner.slice(1).some(line => !/^\s{2}\S/u.test(line))) return {found: false, why: 'no-composer'};
  const text = [inner[0].replace(/^>\s*/u, ''), ...inner.slice(1).map(line => line.trim())].join(' ').trim();
  const footer = lines.slice(bottom + 1).filter(line => line !== '');
  const status = footer[0] ?? '';
  const hint = /^\s/u.test(status) ? '' : status.split(/\s{2,}/u)[0].trim();
  const why = footer.length === 0 ? 'no-footer' : footer.length > 1 ? 'lines-below-composer'
    : !status.includes(agent) ? 'unknown-footer' : null;
  const working = hint === WORKING_HINT || SPINNER.test(lines[top - 1] ?? '');
  return {found: true, text, top, hint, working, settled: why == null, ...(why ? {why} : {})};
}

// 읽어 둔 입력칸이 '쉬는 빈 입력칸'인가. 반환: null(그렇다) | 아닌 이유 낱말.
function notIdle(composer) {
  if (!composer.settled) return composer.why;
  if (composer.working) return 'working';
  if (composer.hint !== IDLE_HINT) return composer.hint === '' ? 'composer-has-text' : 'unknown-footer';
  return null;
}

// (가) 붙여넣기 직전·끝 판정: 빈 입력칸이다. agy가 바닥글에 `? for shortcuts`를 보일 때만이다 — 글이 든 입력칸·일하는 중·
// 선택 창에는 이 글이 없다. 첫 기동의 입력칸에는 안내 글(`Auto mode: …`)이 보이지만 바닥글은 같다(빈 칸이다).
// 생성 중에도 빈 `>`가 보이므로 `>` 줄이 비었다는 것만으로는 통과하지 못한다.
export function agyComposerReady(screen, agent = NOEXEC_AGENT) {
  const composer = readAgyComposer(screen, agent);
  if (!composer.found) return {ok: false, why: composer.why};
  const why = notIdle(composer);
  return why ? {ok: false, why} : {ok: true};
}

// (나) Enter 직전: 입력칸의 글이 방금 붙인 자기 한 줄과 같고(공백은 걷고 비교 — 긴 줄은 화면에서 감긴다),
// 바닥글 왼쪽이 비어 있다(글이 든 입력칸의 모양). `/`로 시작하는 글의 완성 목록·선택 창은 바닥글이 여러 줄이라 걸린다.
export function agyComposerHolds(screen, line, agent = NOEXEC_AGENT) {
  const composer = readAgyComposer(screen, agent);
  if (!composer.found || !composer.settled) return {ok: false, why: composer.why};
  if (composer.working) return {ok: false, why: 'working'};
  if (composer.hint !== '') return {ok: false, why: composer.hint === IDLE_HINT ? 'composer-empty' : 'unknown-footer'};
  if (!squash(line) || squash(composer.text) !== squash(line)) return {ok: false, why: 'composer-not-own-line'};
  return {ok: true};
}

export function agyScreenWorking(screen, agent = NOEXEC_AGENT) {
  const composer = readAgyComposer(screen, agent);
  return composer.found && composer.settled && composer.working;
}

const TRUST_HEAD = 'Accessing workspace:';
const TRUST_QUESTION = 'Do you trust the contents of this project?';
const TRUST_YES = /^(>\s+|\s+)Yes, I trust this folder$/u;
const TRUST_NO = /^(>\s+|\s+)No, exit$/u;
const TRUST_CONFIRM = /(?:^|[\s·])enter Confirm$/u;

// 폴더 신뢰 창을 구조로 읽는다. 조사 화면: 첫 줄 `Accessing workspace:` → 경로 한 줄 → 질문 → 설명 → `> Yes, …` · `  No, exit`
// → `↑/↓ Navigate · enter Confirm` → 상태 줄 한 줄. 이 순서·개수가 아니면 신뢰 창이 아니다(found: false).
// 반환: {found: false} | {found: true, path: 문자열|null(경로 줄이 한 줄이 아님), selected: 'yes'|'no'|null}
export function readAgyTrust(screen) {
  const rows = screenLines(screen).filter(line => line !== '');
  if (rows[0]?.trim() !== TRUST_HEAD) return {found: false};
  const question = rows.findIndex(line => line.trim() === TRUST_QUESTION);
  if (question < 2) return {found: false};
  const yes = rows.findIndex((line, index) => index > question && TRUST_YES.test(line));
  if (yes < 0 || !TRUST_NO.test(rows[yes + 1] ?? '') || !TRUST_CONFIRM.test(rows[yes + 2] ?? '')) return {found: false};
  // 확인 안내 아래는 상태 줄 한 줄까지만이다. 그 아래에 다른 줄이 있으면 신뢰 창이 화면 끝이 아니다.
  const below = rows.slice(yes + 3);
  if (below.length > 1 || below.some(line => /^>/u.test(line))) return {found: false};
  const marked = rows.map((line, index) => (/^>/u.test(line) ? index : -1)).filter(index => index >= 0);
  const selected = marked.length !== 1 ? null : marked[0] === yes ? 'yes' : marked[0] === yes + 1 ? 'no' : null;
  return {found: true, path: question === 2 ? rows[1].trim() : null, selected};
}

// 스크롤 기록에서 이번 질문의 시작 경계(제출해 화면에 되찍힌 자기 한 줄)를 찾는다. 그 줄은 `> `로 시작하고 길면 두 칸 들여 이어진다.
// 반환: 경계가 끝나는 줄 번호들(되찍힌 줄의 마지막 줄). 한 번이 아니면 경계가 없거나 모호한 것이다.
export function findAgyBoundary(lines, line, limit = lines.length) {
  const target = squash(line);
  const ends = [];
  if (!target) return ends;
  for (let at = 0; at < limit; at++) {
    if (!/^>\s/u.test(lines[at])) continue;
    let text = squash(lines[at].replace(/^>\s*/u, '')), end = at;
    while (text !== target && target.startsWith(text) && end + 1 < limit && /^\s{2}\S/u.test(lines[end + 1])) text += squash(lines[++end]);
    if (text === target) ends.push(end);
  }
  return ends;
}

// 표지 뒤에 와도 되는 agy의 꼬리: 빈 줄, 출처 묶음(`Sources:` + `▸ …` 줄들), 펼치기 안내. 그 밖의 글이 있으면 답이 아니다.
const TAIL_SOURCES = /^\s+Sources:$/u, TAIL_SOURCE = /^\s+▸ \S/u, TAIL_EXPAND = /^\s+\(ctrl\+o to expand\)$/u;
function tailOnly(lines) {
  let inSources = false;
  for (const line of lines) {
    if (line === '' || TAIL_EXPAND.test(line)) continue;
    if (TAIL_SOURCES.test(line)) { inSources = true; continue; }
    if (inSources && TAIL_SOURCE.test(line)) continue;
    return false;
  }
  return true;
}

// 전체 스크롤 기록(`capture-pane -J -S -`) → 답 후보. 답으로 받는 조건:
//  - 이 캡처 자체가 쉬는 화면이다: 화면 끝이 빈 입력칸이고 일하는 표시·선택 창·글이 든 입력칸이 아니다. 끝 판정 때 따로 읽은
//    '지금 화면'이 쉬고 있었어도, 답을 읽는 이 캡처에서 다시 본다(두 번 읽는 사이에 화면이 바뀔 수 있다)
//  - 이번 질문의 시작 경계가 정확히 한 번 남아 있다(없으면 밀려났거나 지워진 것, 둘 이상이면 어느 것이 이번 답인지 모른다)
//  - 경계 뒤부터 입력칸 위 가로줄까지에서, 이번 표지가 단독 줄로 정확히 한 번이고 다른 곳(본문 속 인용 포함)에는 없다
//  - 표지 뒤에는 agy의 꼬리만 있다(표지가 답 구간의 마지막 단독 줄이다)
//  - 표지 앞 답이 비어 있지 않고 상한(256KiB) 안이다
// 답 본문은 화면에 그려진 글이다: agy가 두 칸 들여 그린 줄만 모아 들여쓰기를 걷는다. 첫 칸에서 시작하는 줄(생각·도구 표시)은
// 답이 아니라 뺀다. 앱이 스스로 넣은 줄바꿈은 추측해 잇지 않는다(tmux가 감은 줄만 -J가 잇는다).
// 반환: {ok: true, answer} | {ok: false, why, lost?: true(경계·화면 구조 문제 — 답이 없어서가 아니라 회수를 믿을 수 없다)}
export function readAgyAnswer(capture, {line, marker, agent = NOEXEC_AGENT}) {
  const lines = screenLines(capture);
  const composer = readAgyComposer(lines.join('\n'), agent);
  if (!composer.found) return {ok: false, why: 'no-composer', lost: true};
  const busy = notIdle(composer);
  if (busy) return {ok: false, why: `final-capture-not-idle:${busy}`, lost: true};
  const ends = findAgyBoundary(lines, line, composer.top);
  if (ends.length === 0) return {ok: false, why: 'boundary-lost', lost: true};
  if (ends.length > 1) return {ok: false, why: 'boundary-repeated', lost: true};
  const region = lines.slice(ends[0] + 1, composer.top);
  // 경계 뒤에 또 다른 제출 줄(첫 칸 `>`)이 있으면 이 세션에 다른 입력이 들어간 것이다.
  if (region.some(row => /^>/u.test(row))) return {ok: false, why: 'other-input-after-boundary', lost: true};
  // agy가 표지 줄을 마크다운 강조로 그려 `<표지>*`처럼 끝에 기호가 붙는 경우가 있다(운영 기록 5건). 줄 앞뒤의 `*`·`_`·`` ` ``만 걷고 견준다.
  const alone = region.map((row, index) => (row.trim().replace(/^[*_`]+|[*_`]+$/gu, '') === marker ? index : -1)).filter(index => index >= 0);
  const mentions = region.join('\n').split(marker).length - 1;
  if (alone.length === 0) return {ok: false, why: mentions ? 'marker-not-alone' : 'no-marker'};
  if (alone.length > 1 || mentions > 1) return {ok: false, why: 'marker-repeated'};
  if (!tailOnly(region.slice(alone[0] + 1))) return {ok: false, why: 'text-after-marker'};
  const body = region.slice(0, alone[0]).filter(row => row === '' || /^\s{2}/u.test(row)).map(row => row.slice(2));
  const answer = body.join('\n').replace(/^\n+/u, '').replace(/\s+$/u, '');
  if (!answer.trim()) return {ok: false, why: 'marker-only'};
  if (Buffer.byteLength(answer) > ANSWER_LIMIT_BYTES) return {ok: false, why: 'answer-too-big'};
  return {ok: true, answer};
}
