// 시니어 대화형 길의 화면·답 파일 판정 — 순수 함수만 둔다(tmux·파일을 건드리지 않는다).
// 이 길에서 가장 나쁜 것은 (1) 업데이트 선택 창 같은 예상 못 한 화면에 키가 나가는 것, (2) 빈 답·쓰는 중인 답을 ok로 돌려주는 것이다.
// 그래서 금지 문구 목록이 아니라 구조로 본다: 화면의 마지막 `›` 줄이 입력칸이고, 그 아래에는 바닥글 몇 줄뿐이어야 한다.
// 근거 화면(codex 0.166, `--no-alt-screen`): 빈 입력칸은 `› Ask Codex to do anything` + 빈 줄 + 상태 줄 한 줄이고,
// 업데이트 선택 창은 옛 빈 입력칸 아래에 `› 1. Update now …` · `  2. Skip` · `  enter continue · esc skip`가 이어진다.
import {currentErrorBlock} from './watch-stop-phrases.mjs';
import {terminal429} from './watch-rate-limit.mjs';
import {readStatusLine} from './watch-status-line.mjs';

export const ANSWER_LIMIT_BYTES = 256 * 1024;
// 헤드리스 길의 LIMIT_PATTERN(src/senior.mjs)에 codex 화면의 과부하 문구를 더한 것이다(순환 import를 피해 여기에 따로 둔다).
export const SCREEN_LIMIT_PATTERN = /429|quota|usage limit|rate limit|at capacity/i;

const PLACEHOLDER = 'Ask Codex to do anything';
const FOOTER_MAX = 2;
// 입력칸 아래에 오면 안 되는 모양: 번호 선택지, 다른 입력 기호·응답 머리표, 키 안내(`enter continue · esc skip`).
const CHOICE = /^\s*(?:[›❯>]\s*)?\d+[.)]\s/u;
const MARKED = /^\s*[›❯>•■✕×ⓘ]/u;
const KEY_HINT = /(?:^|[\s·•])(?:enter|return|esc)\s+(?:to\s+)?[a-z]/iu;
const squash = text => String(text ?? '').replace(/\s+/gu, '');

function screenLines(screen) {
  const lines = String(screen ?? '').split('\n').map(line => line.replace(/\s+$/u, ''));
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}

// 화면의 마지막 입력 기호 줄을 입력칸으로 읽는다. text: 입력칸에 든 글(감긴 줄은 이어 붙임), settled: 그 아래가 바닥글뿐인가.
export function readComposer(screen) {
  const lines = screenLines(screen);
  const at = lines.findLastIndex(line => /^›/u.test(line));
  if (at < 0) return {found: false, why: 'no-composer'};
  // 입력칸의 글이 길면 codex가 스스로 줄을 감아 다음 줄을 들여 쓴다. 빈 줄을 만나면 입력칸이 끝난다.
  let end = at;
  while (end + 1 < lines.length && /^\s+\S/u.test(lines[end + 1])) end++;
  const text = [lines[at].replace(/^›\s*/u, ''), ...lines.slice(at + 1, end + 1).map(line => line.trim())].join(' ').trim();
  const footer = lines.slice(end + 1).filter(line => line !== '');
  const bad = footer.find(line => CHOICE.test(line) || MARKED.test(line) || KEY_HINT.test(line) || !/^\s/u.test(line));
  const why = footer.length > FOOTER_MAX ? 'lines-below-composer' : bad != null ? 'selection-below-composer' : null;
  return {found: true, text, at, settled: why == null, ...(why ? {why} : {})};
}

const working = screen => readStatusLine(String(screen ?? '')).kind === 'working';

// (가) 붙여넣기 직전·끝 판정: 빈 입력칸이 화면 끝에 있고 선택 창·일하는 표시가 없다.
export function composerReady(screen) {
  const composer = readComposer(screen);
  if (!composer.found) return {ok: false, why: composer.why};
  if (!composer.settled) return {ok: false, why: composer.why};
  if (composer.text !== '' && composer.text !== PLACEHOLDER) return {ok: false, why: 'composer-has-text'};
  if (working(screen)) return {ok: false, why: 'working'};
  return {ok: true};
}

// (나) Enter 직전: 입력칸의 글이 방금 붙인 자기 한 줄과 같고(공백은 걷고 비교) 선택 창·일하는 표시가 없다. 빈 입력칸은 요구하지 않는다.
export function composerHolds(screen, line) {
  const composer = readComposer(screen);
  if (!composer.found) return {ok: false, why: composer.why};
  if (!composer.settled) return {ok: false, why: composer.why};
  if (!squash(line) || squash(composer.text) !== squash(line)) return {ok: false, why: 'composer-not-own-line'};
  if (working(screen)) return {ok: false, why: 'working'};
  return {ok: true};
}

export const screenWorking = working;

// 한도: 입력칸 바로 위 '현재 오류 덩어리'의 줄에 한도 낱말이 있거나, 429 종결 화면이다. 답 본문에만 있는 낱말은 한도가 아니다.
export function limitScreen(screen, now) {
  const text = String(screen ?? '');
  const block = currentErrorBlock(text);
  if (block?.lines.some(line => SCREEN_LIMIT_PATTERN.test(line))) return true;
  return terminal429(text, now) != null;
}

// `/mcp` 출력 구간. 명령 메아리 줄 → 머리줄 → 서버 줄들 → 끝줄이 모두 있고 그 뒤가 입력칸일 때만 완전한 구간이다.
// 잘린 구간·모르는 줄·모르는 상태 낱말은 통과시키지 않는다(연결된 이름 '전부'를 읽었다고 말할 수 없다).
const MCP_HEAD = /^🔌\s+MCP Tools$/u;
const MCP_ROW = /^\s+•\s+([A-Za-z0-9_.-]+):\s+([a-z]+)(?:\s+\(\d+\s+tools?\))?$/u;
const MCP_TAIL = /^\s+Use \/mcp verbose for tools and resources\.$/u;
export function readMcpBlock(screen) {
  const lines = screenLines(screen);
  const echo = lines.findLastIndex(line => line.trim() === '/mcp');
  if (echo < 0) return {ok: false, why: 'mcp-not-shown'};
  const rest = lines.slice(echo + 1).filter(line => line !== '');
  if (!MCP_HEAD.test(rest[0] ?? '')) return {ok: false, why: 'mcp-not-shown'};
  const tail = rest.findIndex(line => MCP_TAIL.test(line));
  if (tail < 0) return {ok: false, why: 'mcp-incomplete'};
  if (!/^›/u.test(rest[tail + 1] ?? '') || rest.slice(tail + 2).some(line => /^›/u.test(line))) {
    return {ok: false, why: 'mcp-incomplete'};
  }
  const connected = [], disabled = [];
  for (const line of rest.slice(1, tail)) {
    const row = MCP_ROW.exec(line);
    if (!row) return {ok: false, why: 'mcp-unreadable'};
    if (row[2] === 'connected') connected.push(row[1]);
    else if (row[2] === 'disabled') disabled.push(row[1]);
    else return {ok: false, why: 'mcp-pending', pending: row[1]};
  }
  return {ok: true, connected, disabled};
}

// 허용 목록 글(한 줄에 이름 하나, 빈 줄과 `#` 줄은 건너뜀) → 이름 집합.
export function parseAllowList(text) {
  return new Set(String(text ?? '').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')));
}

// 연결된 이름이 모두 허용 목록 안인가. allow가 null이면 파일이 없는 것이다(거절 — 스스로 저장하지 않는다).
export function gateVerdict(connected, allow) {
  if (allow == null) return {ok: false, why: 'allow-missing', outside: connected};
  const outside = connected.filter(name => !allow.has(name));
  return outside.length ? {ok: false, why: 'not-allowed', outside} : {ok: true};
}

// 끝 표지는 조각으로만 건네고 모델이 조립한다(완성된 표지는 input.txt에도 화면 입력에도 없다 — 잠긴 규칙 6과 같은 이유).
export const markerParts = token => ['KADAN-SENIOR', '-END-', String(token)];
export const markerOf = token => markerParts(token).join('');

// 답 파일의 글 → 답 후보. 마지막 줄이 이번 호출의 표지이고, 표지가 정확히 한 번이며, 표지를 뗀 답이 비어 있지 않을 때만이다.
export function readAnswerText(raw, marker) {
  const text = String(raw ?? '').replace(/\r\n?/gu, '\n').replace(/\s+$/u, '');
  const lines = text.split('\n');
  if (lines.at(-1).trim() !== marker) return {ok: false, why: 'no-marker'};
  if (text.split(marker).length !== 2) return {ok: false, why: 'marker-repeated'};
  const answer = lines.slice(0, -1).join('\n').replace(/\s+$/u, '');
  if (!answer.trim()) return {ok: false, why: 'marker-only'};
  return {ok: true, answer};
}
