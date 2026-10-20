// 설명 AI 실패 시도의 '구조만 기록' 진단(PR #208 5라운드, kyle 승인 267bbfc9).
// 출력 글자를 원장에 옮기지 않는다. 원장에 쓰는 문자열은 아래 다섯뿐이고 전부 코드 안의 고정 목록에서만 고른다(정규식 통과는 근거가 아니다).
//  - 키 이름(KEY_NAMES 목록에 있는 것만), 값 종류 이름 6개, 봉투 상태 4개, 낱말 id, 신호 이름(SIGNAL_NAMES)
//  - 그 밖에 '?' 표식 하나(목록에 없는 키를 센다)
// 숫자는 바이트·길이·개수·종료 코드 칸과, 값이 0~9999 정수일 때의 값(v)만 쓴다.
import {constants} from 'node:os';
import {STOP_PHRASES} from './watch-stop-phrases.mjs';

// 설명 칸 7개와 실행기 봉투·오류에서 흔한 키. 이 밖의 키는 글자를 남기지 않고 unknown으로 센다.
export const KEY_NAMES = ['title', 'workstream', 'stage', 'goal', 'summary', 'next', 'blocker',
  'response', 'result', 'output', 'text', 'content', 'message', 'error', 'errors', 'code', 'type', 'subtype', 'status',
  'is_error', 'usage', 'stats', 'models', 'reason'];
export const SIGNAL_NAMES = Object.keys(constants.signals);
// 저장 실패(write-failed:<코드>)에 붙일 수 있는 시스템 오류 코드. 이 밖의 코드는 붙이지 않는다.
export const ERRNO_CODES = ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EEXIST', 'ENOENT', 'EBUSY', 'EMFILE', 'ENFILE', 'EDQUOT',
  'EAGAIN', 'ENOTDIR', 'EISDIR'];
export const VALUE_KINDS = ['string', 'number', 'boolean', 'null', 'object', 'array'];
export const ENVELOPE_STATES = ['not-json', 'field-missing', 'field-empty', 'ok'];
export const UNKNOWN_KEY = '?';
// 시도 결과 칸에 쓸 수 있는 값. field-rule:<칸>은 설명 칸 7개와 required, stage 규칙뿐이다.
export const ATTEMPT_RESULTS = ['ok', 'timeout', 'output-limit', 'call-failed', 'template-error', 'not-json',
  'field-rule:title', 'field-rule:workstream', 'field-rule:stage', 'field-rule:goal', 'field-rule:summary',
  'field-rule:next', 'field-rule:blocker', 'field-rule:required'];

// 입력 값이 목록에 있으면 '목록 쪽의 같은 리터럴'을 돌려준다. 입력 값 자체는 쓰지 않는다.
// 문자열이 아닌 값은 문자열로 바꾸지 않고(===만 쓴다) 목록 비교에서 떨어진다.
export const pick = (list, value) => list.find(item => item === value);
// 예외 객체의 code는 한 번만 읽는다. 읽다가 예외가 나면 코드 없이 undefined.
export function errnoOf(error) {
  try { return pick(ERRNO_CODES, error?.code); } catch { return undefined; }
}
export const MAX_KEYS = 16;
const MAX_DEPTH = 2;

// 설명 AI 쪽 고정 오류 낱말. id는 고정 문자열이고 입력에서 온 글자가 아니다.
const EXTRA_WORDS = [
  ['quota', /quota/u],
  ['safety', /safety|cyber ?security|policy violation/u],
  ['blocked', /blocked|forbidden/u],
  ['unauthorized', /unauthori[sz]ed/u],
  ['invalid_api_key', /invalid[ _-]?api[ _-]?key|incorrect api key/u],
  ['model_not_found', /model[ _-]?not[ _-]?found|unknown model/u],
  ['context_length', /context[ _-]?(?:length|window)|too many tokens|maximum context/u],
  ['overloaded', /overloaded|capacity/u],
  ['empty_response', /empty[ _-]?response|no content/u],
];
const STOP_WORDS = STOP_PHRASES.filter(p => p.pattern).map(p => [p.id, p.pattern]);
const WORDS = [...STOP_WORDS, ...EXTRA_WORDS];
export const WORD_IDS = WORDS.map(([id]) => id);

// 표준 출력·표준 오류를 소문자로 바꿔 고정 낱말 목록과 맞춘다. 맞은 id만, 중복 없이 목록 순서로 남긴다.
export function wordIds(...texts) {
  const text = texts.map(t => String(t ?? '')).join('\n').toLowerCase();
  return WORDS.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
}

const kindOf = value => pick(VALUE_KINDS, value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
const sizeOf = (value, kind) => kind === 'string' ? [...value].length : kind === 'array' ? value.length : kind === 'object' ? Object.keys(value).length : undefined;
const smallInt = value => Number.isInteger(value) && value >= 0 && value <= 9999;

// JSON 값 하나의 구조: {t: 종류, n?: 길이, v?: 0~9999 정수 값, keys?, extra?, unknown?}. 객체는 두 단계까지 키를 펼친다.
export function shapeOf(value, depth = 1) {
  const t = kindOf(value);
  const out = {t};
  const n = sizeOf(value, t);
  if (n !== undefined) out.n = n;
  if (t === 'number' && smallInt(value)) out.v = value;
  if (t === 'object' && depth <= MAX_DEPTH) {
    const keys = [];
    let unknown = 0, extra = 0;
    for (const [name, child] of Object.entries(value)) {
      const known = pick(KEY_NAMES, name);
      if (known === undefined) { unknown++; continue; }
      if (keys.length >= MAX_KEYS) { extra++; continue; }
      keys.push({k: known, ...shapeOf(child, depth + 1)});
    }
    out.keys = keys;
    if (unknown) out.unknown = unknown;
    if (extra) out.extra = extra;
  }
  return out;
}

const parse = text => { try { return {value: JSON.parse(String(text ?? ''))}; } catch { return null; } };

// attempt.diag 본문. 성공 시도에는 부르지 않는다.
export function buildDiag({stdout, stderr, answer, envelope, exitCode, signal}) {
  const diag = {};
  const state = pick(ENVELOPE_STATES, envelope);
  if (state !== undefined) diag.envelope = state;
  const outer = parse(stdout);
  if (outer) diag.shape = shapeOf(outer.value);
  // 봉투 안 답이 JSON이면 그 구조도 남긴다(봉투 없는 실행기는 stdout이 곧 답이라 shape 하나로 충분하다).
  if (state !== undefined && state !== 'not-json') {
    const inner = parse(answer);
    if (inner) diag.answerShape = shapeOf(inner.value);
  }
  diag.words = wordIds(stdout, stderr);
  diag.stdoutBytes = Buffer.byteLength(String(stdout ?? ''));
  diag.stderrBytes = Buffer.byteLength(String(stderr ?? ''));
  if (Number.isInteger(exitCode)) diag.exitCode = exitCode;
  const sig = pick(SIGNAL_NAMES, signal);
  if (sig !== undefined) diag.signal = sig;
  return diag;
}
