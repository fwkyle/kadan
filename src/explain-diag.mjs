// 설명 AI 실패 시도의 '구조만 기록' 진단(PR #208 5라운드, kyle 승인 267bbfc9).
// 출력 글자를 원장에 옮기지 않는다. 원장에 쓰는 문자열은 아래 넷뿐이다.
//  - 키 이름(KEY_NAME 정규식을 통과한 것만), 값 종류 이름 6개, 봉투 상태 4개, 낱말 id(코드 상수)
//  - 그 밖에 '?' 표식 하나(정규식을 못 넘은 키를 센다)
// 숫자는 바이트·길이·개수·종료 코드 칸과, 값이 0~9999 정수일 때의 값(v)만 쓴다.
import {STOP_PHRASES} from './watch-stop-phrases.mjs';

export const KEY_NAME = /^[A-Za-z_]{1,24}$/;
export const VALUE_KINDS = ['string', 'number', 'boolean', 'null', 'object', 'array'];
export const ENVELOPE_STATES = ['not-json', 'field-missing', 'field-empty', 'ok'];
export const UNKNOWN_KEY = '?';
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

const kindOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
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
      if (!KEY_NAME.test(name)) { unknown++; continue; }
      if (keys.length >= MAX_KEYS) { extra++; continue; }
      keys.push({k: name, ...shapeOf(child, depth + 1)});
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
  if (envelope) diag.envelope = envelope;
  const outer = parse(stdout);
  if (outer) diag.shape = shapeOf(outer.value);
  // 봉투 안 답이 JSON이면 그 구조도 남긴다(봉투 없는 실행기는 stdout이 곧 답이라 shape 하나로 충분하다).
  if (envelope && envelope !== 'not-json') {
    const inner = parse(answer);
    if (inner) diag.answerShape = shapeOf(inner.value);
  }
  diag.words = wordIds(stdout, stderr);
  diag.stdoutBytes = Buffer.byteLength(String(stdout ?? ''));
  diag.stderrBytes = Buffer.byteLength(String(stderr ?? ''));
  if (Number.isInteger(exitCode)) diag.exitCode = exitCode;
  if (typeof signal === 'string' && /^SIG[A-Z0-9]{2,12}$/.test(signal)) diag.signal = signal;
  return diag;
}
