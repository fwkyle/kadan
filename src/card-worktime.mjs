// 카드 한 장의 작업 시간과 실제로 돌린 모델을 원장·카드 이력에서 계산한다 (읽기 전용, 2026-09-29).
//
// Why: 작업자 기본값을 바꾼 뒤 실제로 얼마나 빨라졌는지 세션 시간으로는 알 수 없다(대기·추가 지시가 섞인다).
// 카드 기록만으로 '작업 시간'을 모델별로 보여 준다. 저장소·원장에는 아무것도 쓰지 않는다.
//
// 시각은 구조화된 기록에서만 읽는다(메모 문자열을 해석하지 않는다).
//   배정   = 카드 이력에서 처음 status=assigned가 된 사건의 at
//   시작   = 카드 이력에서 처음 activity=running이 된 사건의 activityAt (`kadan card progress --activity running`)
//   결과   = card.result.at. 결과 등록은 카드당 한 번뿐이다(CardStore.report는 다른 결과의 재등록을 거부한다).
//   마감   = 원장 done 사건의 시각(`kadan done` 확정). 카드 상태 done의 시각은 쓰지 않는다(옛 카드 일괄 상태 변경이 가짜 대기를 만든다).
// 작업 시간 = 시작 → 결과. 시작 기록이 없으면 배정 → 결과이고 basis='assigned'로 구분한다.
// 대기 시간 = 배정 → 시작. 마감 대기 = 결과 → 원장 확정(없으면 null).
// 재작업 횟수는 결과 재등록이 아니라 티키타카 라운드로 센다: 같은 묶음(rallyId)의 앞선 라운드 수 = rallyRound − 1.
import {effortOfCmd} from './card-center.mjs';

const time = (value) => {
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
};
const stripQuotes = (value) => String(value ?? '').replace(/^["']+|["']+$/g, '').trim();

// 역할별 '실행 세대' 목록. 세대 = 실행 명령(cmd)이 있는 start부터 그 역할의 다음 stop 전까지.
// cmd 없는 start(살아 있는 세션을 다시 부른 재사용)는 새 세대도 모델 근거도 아니다.
export function buildLaunchIndex(entries) {
  const byRole = new Map();
  for (const entry of entries ?? []) {
    if (!entry?.role || (entry.kind !== 'start' && entry.kind !== 'stop')) continue;
    const list = byRole.get(entry.role) ?? [];
    byRole.set(entry.role, list);
    const open = list.at(-1)?.to === null ? list.at(-1) : null;
    if (entry.kind === 'stop') {
      if (open) open.to = time(entry.t);
      continue;
    }
    if (typeof entry.cmd !== 'string' || !entry.cmd.trim()) continue;
    const launch = {
      at: time(entry.t),
      harness: stripQuotes(entry.harness),
      model: stripQuotes(entry.model),
      effort: effortOfCmd(entry.cmd),
      profile: entry.roleProfile ?? null,
      panePid: String(entry.panePid ?? entry.rottiePid ?? ''),
    };
    if (open) open.launches.push(launch);
    else list.push({from: launch.at, to: null, launches: [launch]});
  }
  return byRole;
}

// 시각 at에 그 역할이 어떤 모델이었나. 판정할 수 없으면 이유를 붙여 '모름'이다.
//   no-anchor : 카드에 시작·배정 시각이 없다
//   no-launch : 그 시각을 품는 실행 세대가 없다(실행 명령 기록이 없는 옛 세션 포함)
//   restarted : 같은 세대 안에서 다른 모델·강도로 다시 시작됐다(어느 쪽인지 시각만으로 단정하지 않는다). 실행 도구 이름만 다른 것은 아니다
//   no-model  : 실행 명령은 있으나 모델을 읽을 수 없다
// 원장이 아는 것은 '띄울 때 명령'뿐이라 세션 안에서 나중에 모델을 바꾼 것(/model 등)은 알 수 없다.
export function modelAt(index, role, at) {
  if (at == null) return {state: 'unknown', reason: 'no-anchor'};
  const generation = (index.get(role) ?? []).find((g) => g.from != null && g.from <= at && (g.to == null || at < g.to));
  if (!generation) return {state: 'unknown', reason: 'no-launch'};
  // 아직 살아 있는 세대는 옛 세션 발령 막기(inspectCardSendIdentity)와 같이 '지금 pane PID'와 같은 시작만 본다.
  // 원장만으로는 실제 PID를 알 수 없어(읽기 전용 계산에서 바닥을 조회하지 않는다) 세대의 마지막 실행 명령 기록의 PID를 지금 PID로 본다.
  const launches = generation.to == null
    ? generation.launches.filter((l) => l.panePid === generation.launches.at(-1).panePid)
    : generation.launches;
  // 같은 세대 안의 재시작 여부는 모델·강도만 본다. 실행 도구 이름(omo·codex 등)만 다른 것은 같은 모델이라 재시작으로 보지 않는다.
  const kinds = new Set(launches.map((l) => `${l.model}\0${l.effort}`));
  if (kinds.size !== 1) return {state: 'unknown', reason: 'restarted'};
  // 화면에 보일 실행 도구·프로필·시작 시각은 카드 첫 시작 직전(같은 시각 포함)에 띄운 실행 명령 기록이다. 직전 기록이 없으면 첫 기록.
  const launch = launches.findLast((l) => l.at != null && l.at <= at) ?? launches[0];
  if (!launch.model) return {state: 'unknown', reason: 'no-model'};
  return {state: 'known', harness: launch.harness, model: launch.model, effort: launch.effort, profile: launch.profile, launchAt: launch.at, alive: generation.to == null};
}

const UNKNOWN_LABELS = {
  'no-anchor': '모델 모름: 카드에 시작·배정 기록이 없다',
  'no-launch': '모델 모름: 그 시각을 품는 세션의 실행 명령(start --cmd) 기록이 없다',
  restarted: '모델 모름: 같은 세션이 다른 모델·강도로 다시 시작되어 하나로 정할 수 없다',
  'no-model': '모델 모름: 실행 명령에서 모델을 읽을 수 없다',
};
export const modelUnknownLabel = (reason) => UNKNOWN_LABELS[reason] ?? '모델 모름';

// 역할 프로필은 시작 기록의 roleProfile이 기준이다. 없으면(옛 시작 기록·모름) 카드 단계로 추론한다.
// 발령 막기(dispatch-runner-guard)와 같은 단계 규칙이다: review는 검수자, implementation·fix·research는 작업자.
const PROFILES = ['worker', 'reviewer'];

// 카드 하나의 시간·모델. 조율(coordination) 카드는 대상이 아니라 null이다.
export function cardWorktime(card, index) {
  if (!card || card.workType === 'coordination') return null;
  const history = card.history ?? [];
  const assignedAt = time(history.find((h) => h.status === 'assigned')?.at);
  const running = history.find((h) => h.activity === 'running');
  const startAt = time(running?.activityAt ?? running?.at);
  const resultAt = time(card.result?.at);
  const role = running?.activityRole || card.role || null;
  const from = startAt ?? assignedAt;
  const span = (a, b) => (a != null && b != null && b >= a ? b - a : null);
  const confirm = (card.runs ?? []).find((r) => r.role === role && (r.state === 'done' || r.state === 'failed'));
  const confirmedAt = time(confirm?.at);
  const model = modelAt(index, role, from);
  const step = card.rallyStep || '';
  const reworks = card.rallyId && step !== 'research' && /^\d+$/.test(card.rallyRound ?? '') ? Math.max(0, Number(card.rallyRound) - 1) : null;
  const profile = PROFILES.includes(model.profile) ? model.profile : step === 'review' ? 'reviewer' : 'worker';
  return {
    role,
    step,
    basis: startAt != null ? 'start' : assignedAt != null ? 'assigned' : null,
    assignedAt,
    startAt,
    resultAt,
    confirmedAt,
    confirmResult: confirm?.result ?? null,
    workMs: span(from, resultAt),
    waitMs: span(assignedAt, startAt),
    closeMs: span(resultAt, confirmedAt),
    // 카드 종류는 rallyStep이 기준이다. 다만 구현 카드가 2라운드 이상이면 수정 턴이다(review-flow의 fixCount와 같은 규칙).
    kind: step === 'implementation' && reworks > 0 ? 'fix' : step,
    reworks,
    profile,
    profileFrom: PROFILES.includes(model.profile) ? 'launch' : 'step',
    model,
  };
}

// 카드 목록 전체. 원장 색인은 한 번만 만든다(요청당 1회·수집 캐시 안에서 부른다).
export function buildCardWorktimes(cards, entries) {
  const index = buildLaunchIndex(entries);
  return new Map((cards ?? []).map((card) => [card.key, cardWorktime(card, index)]).filter(([, w]) => w));
}

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;
export const WORKTIME_PERIODS = ['today', '7d', 'all'];
// 기간 기준은 결과 등록 시각(result.at)이다. '오늘'은 한국 시간 0시부터다(화면의 시각 표기와 같다).
export function periodStart(period, now = Date.now()) {
  if (period === 'all') return null;
  if (period === '7d') return now - 7 * DAY_MS;
  return Math.floor((now + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const stat = (bucket) => ({
  count: bucket.values.length,
  medianMs: Math.round(median(bucket.values)),
  meanMs: Math.round(mean(bucket.values)),
  assignedBasis: bucket.assigned,
  reworkCards: bucket.reworked,
});
const STEP_ORDER = ['implementation', 'fix', 'review', 'research', ''];
const PROFILE_ORDER = ['worker', 'reviewer'];

// 모델 × 카드 종류(구현·수정·검수·조사) 요약. 기간 안에 결과가 등록된 카드 중 작업 시간을 계산한 것만 센다.
// 모델을 알 수 없는 카드는 '모름'으로 따로 묶어 숨기지 않는다. 역할 프로필(worker/reviewer)은 섞지 않는다.
export function summarizeWorktimes(worktimes, {period = 'today', now = Date.now()} = {}) {
  const since = periodStart(period, now);
  const groups = new Map();
  const reasons = {};
  let count = 0, noDuration = 0;
  for (const w of worktimes) {
    if (!w || w.resultAt == null || (since != null && w.resultAt < since)) continue;
    if (w.workMs == null) { noDuration++; continue; }
    count++;
    const known = w.model.state === 'known';
    if (!known) reasons[w.model.reason] = (reasons[w.model.reason] ?? 0) + 1;
    const key = `${w.profile}\0${known ? `${w.model.model}\0${w.model.effort}` : '\0'}`;
    const group = groups.get(key) ?? {profile: w.profile, model: known ? w.model.model : null, effort: known ? w.model.effort : '', all: {values: [], assigned: 0, reworked: 0}, steps: new Map()};
    groups.set(key, group);
    const bucket = group.steps.get(w.kind) ?? {values: [], assigned: 0, reworked: 0};
    group.steps.set(w.kind, bucket);
    for (const b of [group.all, bucket]) {
      b.values.push(w.workMs);
      if (w.basis === 'assigned') b.assigned++;
      if (w.reworks > 0) b.reworked++;
    }
  }
  const order = (list, value) => (list.includes(value) ? list.indexOf(value) : list.length);
  const rows = [...groups.values()]
    .sort((a, b) => order(PROFILE_ORDER, a.profile) - order(PROFILE_ORDER, b.profile) || Number(a.model === null) - Number(b.model === null) || String(a.model).localeCompare(String(b.model)) || a.effort.localeCompare(b.effort))
    .flatMap((g) => [
      {profile: g.profile, model: g.model, effort: g.effort, step: 'all', ...stat(g.all)},
      ...[...g.steps].sort(([a], [b]) => order(STEP_ORDER, a) - order(STEP_ORDER, b)).map(([step, bucket]) => ({profile: g.profile, model: g.model, effort: g.effort, step, ...stat(bucket)})),
    ]);
  return {period, since: since == null ? null : new Date(since).toISOString(), count, noDuration, unknownReasons: reasons, rows};
}
