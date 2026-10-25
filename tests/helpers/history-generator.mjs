// 이력 소비자 동등성 시험용 적대 자료 생성기(고정 시드). 시각 역전·잘못된 시각·동일 시각·미래 시각,
// 같은 담당 재지정, 결과 뒤 재개, 질문/답변 교차, 작성자 모름, 배정 전 보고, 명시 차례 행을 섞는다.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {s ^= s << 13;s >>>= 0;s ^= s >> 17;s ^= s << 5;s >>>= 0;return s / 4294967296;};
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
export const NOW = Date.UTC(2026, 9, 25, 3, 0, 0);
const ROLES = ['worker', 'reviewer', 'worker2', null, undefined, ''];
const STATUS = ['draft', 'ready', 'assigned', 'assigned', 'assigned', 'hold', 'done', 'cancelled'];
const ACTIVITY = [undefined, 'running', 'waiting', 'unknown', 'running'];
const KINDS = [undefined, 'progress', 'progress', 'progress', 'progress', 'progress', 'decision', 'question', 'answer'];
const BYS = ['worker', 'reviewer', 'worker2', '모름', undefined, '사람', 'worker'];

function timeText(r, base, index) {
  const mode = r();
  if (mode < 0.55) return new Date(base + index * 60_000).toISOString();                 // 정상 증가
  if (mode < 0.65) return new Date(base + Math.max(0, index - 3) * 60_000).toISOString(); // 시각 역전
  if (mode < 0.72) return new Date(base + (index - 1) * 60_000).toISOString();           // 동일 시각 근처
  if (mode < 0.80) return 'not-a-time';                                                   // 잘못된 시각
  if (mode < 0.86) return new Date(NOW + (index + 2) * 3_600_000).toISOString();         // 미래
  return new Date(base + index * 60_000).toISOString();
}

export function generateCard(seed, {maxRows = 14} = {}) {
  const r = rng(seed), base = NOW - 40 * 3_600_000, rows = [], n = 3 + Math.floor(r() * maxRows);
  let state = {key: 'demo/card', repo: 'demo', id: 'card', title: '카드', status: 'draft', role: pick(r, ROLES),
    scope: 'S1', repoPath: '/tmp/a', rallyId: undefined, rallyTitle: undefined, rallyRound: undefined, rallyStep: undefined};
  for (let i = 0; i < n; i++) {
    const row = {...state, revision: i + 1, at: timeText(r, base, i)};
    delete row.note;delete row.noteKind;delete row.by;
    if (r() < 0.4) {delete row.activity;delete row.activityAt;delete row.activityRole;} // 활동 상태는 대개 다음 행에 복사된다
    if (r() < 0.45) row.status = pick(r, STATUS);
    if (i === 0 || r() < 0.08) row.role = pick(r, i === 0 ? ['worker', 'worker', 'worker', 'reviewer', 'worker2', null] : ROLES);
    if (r() < 0.12) row.scope = pick(r, ['S1', 'S2', 'S3']);
    if (r() < 0.06) row.repoPath = pick(r, ['/tmp/a', '/tmp/b']);
    if (r() < 0.15) {
      row.rallyId = pick(r, [undefined, 'rally-1', 'rally-2']);row.rallyTitle = pick(r, [undefined, 'T1', 'T2']);
      row.rallyRound = pick(r, [undefined, '1', '2']);row.rallyStep = pick(r, [undefined, 'implementation', 'review']);
    }
    row.noteKind = pick(r, KINDS);
    if (row.noteKind) {
      row.by = r() < 0.6 && row.role ? row.role : pick(r, BYS);
      row.note = r() < 0.15 ? '' : `메모 ${i} ${row.noteKind} ${'가'.repeat(Math.floor(r() * 30))}`;
      if (row.noteKind === 'progress' && r() < 0.8) {
        row.activity = pick(r, ACTIVITY.filter(Boolean));
        row.activityAt = r() < 0.75 ? row.at : timeText(r, base, i + 1);
        row.activityRole = pick(r, ['worker', 'reviewer', undefined]);
      }
    }
    if (r() < 0.07) row.result = {at: timeText(r, base, i), outcome: pick(r, ['implemented', 'pass', 'changes']), by: 'worker'};
    if (r() < 0.12) {
      row.turnOwner = pick(r, ['worker', 'reviewer', undefined]);row.turnRevision = r() < 0.7 ? row.revision : row.revision - 1;
      row.turnAt = r() < 0.8 ? row.at : timeText(r, base, i);row.turnBy = r() < 0.8 ? row.by : '사람';
    }
    if (r() < 0.10) row.statusReason = pick(r, ['이유 A', '이유 B', undefined]);
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    rows.push(row);
    // 다음 행은 이 행의 상태를 이어받는다(원장은 전체 상태를 매 행에 복사한다). 메모·보고 필드는 행마다 새로 정한다.
    const {note, noteKind, by, result, revision, at, ...carried} = row;
    state = {...carried, ...(result ? {result} : {})};
    if (r() < 0.2) delete state.result;
  }
  const last = rows.at(-1);
  const card = {...last, history: rows, runs: [], displayState: last.status};
  // 발령 시각은 이력 중간쯤에 두어 보고가 발령 앞뒤에 모두 놓이게 한다.
  const sent = r() < 0.9 ? new Date(base + Math.floor(r() * (n + 1)) * 60_000).toISOString() : timeText(r, base, n + 1);
  if (r() < 0.85 && card.role) {
    card.runs = [{role: card.role, sentAt: sent, at: timeText(r, base, n + 2), state: pick(r, ['unconfirmed', 'done', 'orphaned', 'failed']),
      sessionState: pick(r, ['alive', 'dead'])}];
    if (r() < 0.2) card.runs.push({role: pick(r, ['worker', 'reviewer']), sentAt: timeText(r, base, n), at: timeText(r, base, n + 3), state: 'unconfirmed', sessionState: 'alive'});
  }
  card.displayState = pick(r, [last.status, last.status, 'running', 'waiting', 'unconfirmed', 'orphaned', 'failed']);
  if (r() < 0.2) card.ambiguous = true;
  return card;
}
