// 나이트 기록(`night-note`): 켜진 동안 대신 정한 것·보류·관문 판정·머지·시작한 일감을 한 줄씩 남긴다.
// `night` 종류와 따로 둔다: night 사건에 phase를 더하면 nightState의 "마지막 night 사건" 계산이 꺼짐으로 읽힌다.
// 새 권한이 아니다. 판정하지 않고 적기만 한다. 관문 판정(gate)과 실제 머지(merge)는 서로 다른 사건이다.
import {normalizeGithub} from './night-repo-policy.mjs';

export const NOTE_KINDS = ['decision', 'hold', 'gate', 'merge', 'start'];
export const HOLD_KINDS = ['decision', 'gate', 'deploy-repo'];
export const VERDICTS = ['pass', 'reject'];
export const NOTE_TEXT_LIMIT = 200;
export const DECISION_PREFIX = '[나이트 결정]';
const USAGE = `kadan night note ${NOTE_KINDS.join('|')} "<한 줄>" [--work 키] [--pr 저장소#번호] [--sha …] [--reason …] [--hold-kind ${HOLD_KINDS.join('|')}] [--verdict ${VERDICTS.join('|')}]`;

// 공백류(줄바꿈·탭)는 공백 하나로 접고 남은 제어 문자(C0·DEL·C1: ESC·NUL·backspace 등)는 지운다.
// 아침 요약과 CLI 출력이 화면 제어 문자로 깨지지 않게 저장 전과 요약 직전에 같은 함수를 거친다.
export const cleanNoteText = value => String(value ?? '').replace(/\s+/g, ' ').replace(/\p{Cc}/gu, '').trim();

// 정리한 뒤 글자 200개에서 자른다(adopt message 규칙과 같게 `…`을 붙인다).
export function foldNoteText(value, limit = NOTE_TEXT_LIMIT) {
  const chars = [...cleanNoteText(value)];
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('');
}

const optional = (flags, name) => {
  const v = flags[name];
  if (v === undefined) return null;
  const clean = typeof v === 'string' ? cleanNoteText(v) : '';
  if (!clean) throw new Error(`--${name}에 값이 필요합니다. ${USAGE}`);
  return clean;
};

// PR 키 정규화: `소유자/이름#번호`의 저장소 부분을 normalizeGithub로 맞춘다(대소문자·.git). 관문 기록·merge 기록·요약 짝짓기가 같은 함수를 쓴다.
// 소유자/이름 꼴이 아닌 키(예: kadan#327)는 그대로 둔다. 옛 원장은 고치지 않고 읽을 때 이 함수를 거친다.
export function normalizePrKey(pr) {
  if (typeof pr !== 'string') return pr;
  const i = pr.lastIndexOf('#');
  const repo = i > 0 ? normalizeGithub(pr.slice(0, i)) : null;
  return repo ? `${repo}${pr.slice(i)}` : pr;
}

// 입력을 검사해 원장에 쓸 사건을 만든다. 나이트가 켜져 있는지는 부르는 쪽이 먼저 본다.
export function buildNightNote({words, flags, by, now}) {
  const [noteKind, ...rest] = words;
  if (!NOTE_KINDS.includes(noteKind)) throw new Error(`종류는 ${NOTE_KINDS.join('|')} 중 하나여야 합니다. ${USAGE}`);
  const text = foldNoteText(rest.join(' '));
  if (!text) throw new Error(`기록할 한 줄이 필요합니다. ${USAGE}`);
  const work = optional(flags, 'work'), pr = optional(flags, 'pr'), sha = optional(flags, 'sha'), reason = optional(flags, 'reason');
  const holdKind = optional(flags, 'hold-kind'), verdict = optional(flags, 'verdict');
  if (pr && !/^[^\s#]+#\d+$/.test(pr)) throw new Error(`--pr은 저장소#번호 꼴이어야 합니다(예: kadan#327). ${USAGE}`);
  if (sha && !/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`--sha는 커밋 해시(7~40자리 16진수)여야 합니다. ${USAGE}`);
  if (noteKind === 'hold') {
    if (!HOLD_KINDS.includes(holdKind)) throw new Error(`hold에는 --hold-kind ${HOLD_KINDS.join('|')}가 필요합니다. ${USAGE}`);
  } else if (holdKind) throw new Error(`--hold-kind는 hold에만 쓸 수 있습니다. ${USAGE}`);
  if (noteKind === 'gate') {
    if (!VERDICTS.includes(verdict)) throw new Error(`gate에는 --verdict ${VERDICTS.join('|')}가 필요합니다. ${USAGE}`);
  } else if (verdict) throw new Error(`--verdict는 gate에만 쓸 수 있습니다. ${USAGE}`);
  return {
    kind: 'night-note', noteKind, text,
    ...(holdKind ? {holdKind} : {}), ...(verdict ? {verdict} : {}),
    ...(work ? {work} : {}), ...(pr ? {pr: normalizePrKey(pr)} : {}), ...(sha ? {sha} : {}),
    ...(reason ? {reason: foldNoteText(reason)} : {}),
    by, t: new Date(now).toISOString(),
  };
}

const LABEL = {hold: '보류', gate: '관문', merge: '머지', start: '시작'};
// 명령이 보여 주는 한 줄. 결정은 접두 `[나이트 결정]`을 붙인다.
export const noteLine = event => (event.noteKind === 'decision' ? `${DECISION_PREFIX} ${event.text}` : `[나이트 ${LABEL[event.noteKind]}] ${event.text}`);

// 아침 요약용 집계. notes는 구간 안 night-note 사건. 같은 PR의 관문 통과·머지는 한 번으로 센다(pr가 없으면 사건마다).
export function tallyNotes(notes) {
  const by = kind => notes.filter(n => n.noteKind === kind);
  const distinct = list => new Set(list.map((n, i) => normalizePrKey(n.pr) || `#${i}`)).size;
  const holds = by('hold');
  const gates = by('gate');
  // 관문을 통과했는데 같은 --pr의 merge 기록이 없는 PR(pr가 없는 기록은 짝을 못 지으므로 뺀다). 머지를 못 했거나 기록을 빠뜨린 것이다.
  const mergedPrs = new Set(by('merge').map(n => normalizePrKey(n.pr)).filter(Boolean));
  const unmerged = [...new Map(gates.filter(n => n.verdict === 'pass' && n.pr && !mergedPrs.has(normalizePrKey(n.pr))).map(n => [normalizePrKey(n.pr), n])).values()];
  return {
    total: notes.length,
    decisions: by('decision'), holds, starts: by('start'),
    passes: gates.filter(n => n.verdict === 'pass'), unmerged, rejects: gates.filter(n => n.verdict === 'reject'), merges: by('merge'),
    counts: {
      noteDecisions: by('decision').length,
      noteHolds: Object.fromEntries(HOLD_KINDS.map(k => [k, holds.filter(n => n.holdKind === k).length])),
      gatePass: distinct(gates.filter(n => n.verdict === 'pass')),
      gateReject: distinct(gates.filter(n => n.verdict === 'reject')),
      merges: distinct(by('merge')),
      unmerged: unmerged.length,
      starts: by('start').length,
    },
  };
}
