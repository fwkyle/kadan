// Why: 목록은 카드마다 전체 이력 객체를 보관해 이력이 쌓일수록 RAM이 늘었다(실측 19,934행, 이력 몫 약 9MiB·행당 약 470B.
// 처음 적은 63.5MiB는 reader 전체 힙이었다).
// 목록 소비자가 이력에서 실제로 읽는 사실만 이름을 나눠 사건을 하나씩 적용하며 갱신한다.
// 요약 행을 이어 붙인 가짜 이력을 만들지 않는다: 모든 사실은 원래 인접 행을 비교해 얻은 값이다.
// 이력이 없는 호출(시험·옛 호출자·상세)은 listFactsOf가 같은 advance로 이력에서 사실을 만든다. 소비자 코드는 한 갈래다.
//
// 상시 보관(bounded) 모드: 한도 안 카드의 크기가 그 카드의 이력 길이와 무관하도록 한도를 둔다. 한도를 넘으면(overflow) 또는 한도 때문에
// 지금 필요한 값을 잃었으면(needsHistory) 그 카드만 이력 전체를 보관하고 사실을 쓰지 않는다. 그래서 출력은 항상 같다.
// 이력 기반(unbounded) 모드: 한도 없이 이력 위에서 만든다(상세·시험·옛 호출자).
import {advanceCardHistoryFacts} from './card-history-facts.mjs';

const NOTES = ['decision', 'question', 'answer'];
const RALLY = ['rallyId', 'rallyTitle', 'rallyRound', 'rallyStep'];
const REOPEN = ['draft', 'ready', 'assigned'];
// 한도: 실제 사본 4,036장에서 보고 스택은 묶음당 1개, 묶음 3개 이하, 명시 차례 행 최대 12개였다(evidence/iso-facts-shape.json).
export const LIMITS = {stack: 4, groups: 8, explicit: 3, waiting: 3, future: 4, roles: 6};
const parse = value => Date.parse(value);
const date = value => Date.parse(value) || 0;

const EMPTY_GROUP = Object.freeze({stack: [], minValid: Infinity, maxValid: -Infinity, hasInvalid: false});

// 보고 묶음: (작성자, 보고에 적힌 역할). stack은 "뒤에 더 늦거나 같은 시각이 없는" 보고만 남긴 목록이다.
// since 이상(또는 시각이 잘못된) 마지막 보고는 항상 이 목록에 있다: 뒤의 보고가 같거나 더 늦으면 앞 보고는 절대 마지막이 아니다.
function advanceGroup(group, report, index) {
  const t = Number.isFinite(parse(report.at)) ? parse(report.at) : Infinity;
  const stack = group.stack.slice();
  while (stack.length && stack.at(-1).t <= t) stack.pop();
  stack.push({t, index, at: report.at, by: report.by, note: report.note});
  return {stack,
    minValid: t === Infinity ? group.minValid : Math.min(group.minValid, t),
    maxValid: t === Infinity ? group.maxValid : Math.max(group.maxValid, t),
    hasInvalid: group.hasInvalid || t === Infinity};
}

export function emptyListFacts() {
  return {
    n: 0, last: null, firstKey: null, keyConsistent: true, contiguous: true,
    center: {transition: null, question: null, answer: null, changedAt: null},
    firstAssigned: null, firstRunning: null,
    registered: null, reopenMax: null,
    lastHoldEntry: null, boundary: null, dialogue: null, explicit: [], explicitDropped: false,
    notes: [], rallyDecisions: [], futureTimes: [],
    progressCount: 0, authored: new Map(), unknownAuthor: new Map(), assignments: new Map(),
    waitingNotes: new Map(), waitingDropped: false,
    overflow: false, needsHistory: false,
  };
}

// row: 새 사건, previousRow: 바로 앞 원래 행(없으면 null), now: 미래 시각 판정 기준(적용 시각).
export function advanceListFacts(previous, previousRow, row, now = Date.now(), {bounded = false} = {}) {
  const facts = {...(previous ?? emptyListFacts())};
  const first = !previousRow, index = facts.n;
  facts.n = index + 1;
  facts.last = row; // 가장 최근 원래 행(목록 행이 이미 같은 객체를 든다). 실행 모델이 원래 행을 읽는다.
  if (first) facts.firstKey = row.key;
  if (row.key !== facts.firstKey) facts.keyConsistent = false;
  if (row.revision !== index + 1) facts.contiguous = false;
  facts.center = advanceCardHistoryFacts(facts.center, previousRow, row);
  const statusChanged = !!previousRow && previousRow.status !== row.status;
  const roleChanged = !!previousRow && previousRow.role !== row.role;
  if (!facts.firstAssigned && row.status === 'assigned') facts.firstAssigned = {at: row.at};
  if (!facts.firstRunning && row.activity === 'running') {
    facts.firstRunning = {activityAt: row.activityAt, at: row.at, activityRole: row.activityRole};
  }
  if (!facts.registered && row.result) facts.registered = {scope: row.scope, role: row.role, repoPath: row.repoPath};
  if (statusChanged && REOPEN.includes(row.status)) {
    facts.reopenMax = facts.reopenMax === null ? date(row.at) : Math.max(facts.reopenMax, date(row.at));
  }
  if (row.status === 'hold' && previousRow?.status !== 'hold') facts.lastHoldEntry = {at: row.at};
  if (first || statusChanged || roleChanged) facts.boundary = {at: row.at};
  if (['question', 'answer'].includes(row.noteKind)) {
    facts.dialogue = {at: row.at, revision: row.revision, noteKind: row.noteKind};
  }
  if (Number.isInteger(row.turnRevision) && row.turnRevision === row.revision) {
    const kept = [...facts.explicit, {revision: row.revision, at: row.at, by: row.by, role: row.role,
      status: row.status, turnAt: row.turnAt, turnOwner: row.turnOwner, turnBy: row.turnBy, turnRevision: row.turnRevision}];
    facts.explicit = bounded ? kept.slice(-LIMITS.explicit) : kept;
    if (bounded && kept.length > LIMITS.explicit) facts.explicitDropped = true;
  }
  if (NOTES.includes(row.noteKind) && row.note) {
    facts.notes = [...facts.notes, {kind: row.noteKind, by: row.by, note: row.note}].slice(-5);
  }
  // 옛 목록의 최근 판단은 rally 필드가 인접 행과 모두 같은 행의 decision만 후보로 삼고, 시각이 가장 늦은(같으면 앞선) 하나만 쓴다.
  if (row.noteKind === 'decision' && row.note && !RALLY.some(k => row[k] !== previousRow?.[k])) {
    const candidate = {at: row.at, note: row.note.slice(0, 240)};
    if (!bounded) facts.rallyDecisions = [...facts.rallyDecisions, candidate];
    else if (!Number.isFinite(parse(row.at))) facts.overflow = true; // 잘못된 시각이 섞이면 정렬 결과가 후보 전체에 달려 있다
    else if (!facts.rallyDecisions.length || parse(row.at) > parse(facts.rallyDecisions[0].at)) facts.rallyDecisions = [candidate];
  }
  for (const value of [row.at, row.activityAt]) {
    const t = parse(value);
    if (t > now && !facts.futureTimes.includes(t)) {
      facts.futureTimes = [...facts.futureTimes, t].sort((a, b) => a - b);
      if (bounded && facts.futureTimes.length > LIMITS.future) facts.overflow = true;
    }
  }
  if (row.noteKind === 'progress') {
    facts.progressCount += 1;
    const by = row.by, unknown = !by || by === '모름', key = `${row.role || ''}`;
    const put = (map, mapKey) => {
      const next = new Map(map), group = advanceGroup(next.get(mapKey) ?? EMPTY_GROUP, row, index);
      if (bounded && (group.stack.length > LIMITS.stack || (!next.has(mapKey) && next.size >= LIMITS.groups))) facts.overflow = true;
      next.set(mapKey, group);
      return next;
    };
    // 작성자가 '모름'인 보고는 현재 역할이 '모름'인 드문 경우에만 owned이기도 하다(기존 두 필터가 독립이라 둘 다 센다).
    if (unknown) facts.unknownAuthor = put(facts.unknownAuthor, key);
    if (by) facts.authored = put(facts.authored, `${by}\u0000${key}`);
    if (row.activity === 'waiting' && row.activityAt === row.at) {
      const waiting = new Map(facts.waitingNotes);
      waiting.delete(row.at);waiting.set(row.at, row.note);
      if (bounded && waiting.size > LIMITS.waiting) {waiting.delete(waiting.keys().next().value);facts.waitingDropped = true;}
      facts.waitingNotes = waiting;
    }
  }
  if (row.status === 'assigned' && row.role && (previousRow?.role !== row.role || previousRow?.status !== 'assigned')) {
    facts.assignments = new Map(facts.assignments).set(row.role, {at: row.at});
    if (bounded && facts.assignments.size > LIMITS.roles) facts.overflow = true;
  }
  // 한도 때문에 지금 행이 필요로 하는 값을 잃었으면 이 카드는 이력 전체를 보관한다(출력이 달라지지 않게).
  facts.needsHistory = facts.overflow
    || (facts.explicitDropped && Number.isInteger(row.turnRevision) && !facts.explicit.some(e => e.revision === row.turnRevision))
    || (facts.waitingDropped && row.activityAt != null && !facts.waitingNotes.has(row.activityAt));
  return facts;
}

export function listFactsFromHistory(history, now = Date.now()) {
  let facts = null, previous = null;
  for (const row of history ?? []) {facts = advanceListFacts(facts, previous, row, now);previous = row;}
  return facts ?? emptyListFacts();
}

const derived = new WeakMap();
// 소비자는 이 함수 하나로 사실을 얻는다: 목록 행은 listFacts를 들고 있고, 이력만 있는 호출은 이력에서 만든다.
export function listFactsOf(card) {
  if (card.listFacts) return card.listFacts;
  const history = card.history ?? [];
  let facts = derived.get(history);
  if (!facts) {facts = listFactsFromHistory(history);derived.set(history, facts);}
  return facts;
}

// 진행 보고 조회(임의 since): 카드의 현재 역할 R 기준으로 기존 history 필터와 같은 결과만 돌려준다.
export function progressQuery(facts, role, since) {
  const owned = [facts.authored.get(`${role}\u0000`), facts.authored.get(`${role}\u0000${role}`)].filter(Boolean);
  let report = null;
  for (const group of owned) {
    const hit = [...group.stack].reverse().find(e => e.t >= since);
    if (hit && (!report || hit.index > report.index)) report = hit;
  }
  const unknownGroups = [facts.unknownAuthor.get(''), facts.unknownAuthor.get(role)].filter(Boolean);
  return {
    report,
    ownedExists: owned.length > 0,
    ownedBefore: owned.some(g => g.minValid < since),
    unknownAfter: unknownGroups.some(g => g.hasInvalid || g.maxValid >= since),
  };
}
