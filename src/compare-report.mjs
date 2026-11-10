// Why: 어떤 모드로 띄웠든 발령에 남은 실제 조합(실행기/모델/강도)으로 묶고, 한 업무를 한 번만 센다.
import {readCompareData} from './compare-report-data.mjs';

export const DEFAULT_REPORT_DAYS = 14;
// 띄운 방식: 설정대로(검수자의 review-for 포함)는 기본 행, 나머지는 표시가 붙은 별도 행이다.
const LAUNCH_LABELS = {settings: null, 'review-for': null, override: '명시 명령', fallback: '폴백'};
const choiceKey = value => value ? [value.runner, value.model, value.effort ?? ''].join('/') : '';
export const choiceLabel = value => value
  ? [value.runner, value.model, value.effort ?? '강도 미기록'].join('/') : '검수 발령 없음';
const time = entry => Date.parse(entry?.t ?? entry?.at ?? '');
const shortId = key => key?.split('/').at(-1);
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null;
};
export const relativeRounds = (implementationRound, passedRound) =>
  passedRound == null ? null : Number(passedRound) - Number(implementationRound) + 1;
const isoMs = (value, name) => {
  if (value == null) return null;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`${name}에는 ISO 날짜가 필요하다`);
  return ms;
};

function runIndex(entries, works) {
  const keys = new Map(), executions = new Map();
  for (const work of works) for (const execution of work.executions ?? []) {
    const id = shortId(execution.key);
    keys.set(id, keys.has(id) && keys.get(id) !== execution.key ? null : execution.key);
    executions.set(execution.key, {...execution, workKey: work.key});
  }
  const runs = new Map(), starts = new Map(), orphans = [];
  for (const entry of entries) {
    if (entry.kind === 'start' && entry.cmd) {
      const list = starts.get(entry.role) ?? []; list.push(entry); starts.set(entry.role, list);
    }
    if (!['send', 'done'].includes(entry.kind) || !entry.taskId) continue;
    const key = entry.executionKey ?? keys.get(entry.taskId) ?? (executions.has(entry.taskId) ? entry.taskId : null);
    // 읽은 업무 어디에도 없는 카드 발령은 버리지 않고 따로 센다.
    if (!key || !executions.has(key)) { if (entry.kind === 'send') orphans.push(entry); continue; }
    const run = runs.get(key) ?? {key, sends: [], done: null};
    if (entry.kind === 'send') run.sends.push(entry);
    else if (!run.done) run.done = entry;
    runs.set(key, run);
  }
  return {runs, starts, orphans};
}

// 발령에 실제 조합과 띄운 방식이 남았는가. 없으면 추정하지 않는다.
const attributed = run => run.sends.every(send => send.runnerChoice
  && Object.hasOwn(LAUNCH_LABELS, send.launchSource ?? ''));
// 실행 도중 그 역할을 새 명령으로 다시 띄웠는가(cmd 없는 재사용 start는 교체가 아니다).
const replaced = (run, starts) => (starts.get(run.sends[0].role) ?? []).some(start =>
  time(start) > time(run.sends[0]) && (!run.done || time(start) <= time(run.done)));

function sampleOf(execution, work, index, outcomes, picks) {
  const run = index.runs.get(execution.key), send = run?.sends[0];
  if (!send) return null;
  const reviews = (work.executions ?? []).filter(e => e.phase === 'review'
    && Number(e.round) >= Number(execution.round)).sort((a, b) => Number(a.round) - Number(b.round));
  // 업무·라운드와 발령에 보존된 작업자 역할이 모두 맞는 검수만 연결한다.
  const matched = reviews.filter(e => {
    const reviewSend = index.runs.get(e.key)?.sends[0];
    const possible = (work.executions ?? []).filter(other => other.phase === 'implementation'
      && Number(other.round) === Number(execution.round));
    return reviewSend && (reviewSend.reviewFor?.role === send.role
      || (!reviewSend.reviewFor && reviews.length === 1 && possible.length === 1));
  });
  const firstPass = matched.find(e => outcomes.get(e.key) === 'pass' && index.runs.get(e.key)?.done);
  const used = firstPass ? matched.filter(e => Number(e.round) <= Number(firstPass.round)) : matched;
  const runs = [run, ...used.map(e => index.runs.get(e.key))];
  // 같은 실행을 다른 조합으로 다시 보낸 것도 조합 변경이다. 첫 발령만이 아니라 모든 발령을 본다.
  const reviewerChoices = new Set(runs.slice(1).flatMap(r => r.sends).map(s => choiceKey(s.runnerChoice)));
  const reasons = new Set();
  if (runs.some(r => replaced(r, index.starts))) reasons.add('중간 교체');
  if (reviewerChoices.size > 1) reasons.add('검수자 변경');
  if (new Set(run.sends.map(s => choiceKey(s.runnerChoice))).size > 1) reasons.add('작업자 변경');
  return {workKey: work.key, key: execution.key, worker: send.runnerChoice, send, reasons,
    // 검수 발령이 아직 없으면 검수자는 비운다(예약에 적힌 검수자가 있을 때만 그 값).
    reviewer: used.length ? runs[1].sends[0].runnerChoice : picks.get(send.pickId)?.reviewer ?? null,
    sends: runs.flatMap(r => r.sends), runSends: run.sends,
    unknown: !runs.every(attributed) || (reviews.length > 0 && !matched.length),
    failed: run.done?.result === 'failed',
    rounds: relativeRounds(execution.round, firstPass?.round),
    implementationRound: Number(execution.round), passedRound: firstPass ? Number(firstPass.round) : null,
    durationMs: run.done ? time(run.done) - time(send) : null,
    reviewKeys: used.map(e => e.key)};
}

export function calculateCompareReport({entries, works, cards},
  {since, until, asOf = new Date().toISOString()} = {}) {
  const sinceMs = isoMs(since, '--since') ?? -Infinity, untilMs = isoMs(until, '--until') ?? Infinity;
  if (sinceMs > untilMs) throw new Error('--since가 --until보다 늦다');
  const inWindow = entry => time(entry) >= sinceMs && time(entry) <= untilMs;
  const picks = new Map(entries.filter(e => e.kind === 'compare-pick').map(e => [e.pickId, e]));
  const cardOf = new Map(cards.map(card => [card.key, card]));
  const outcomes = new Map(cards.map(card => [card.key, card.result?.outcome]));
  const index = runIndex(entries, works), groups = new Map(), mixed = {}, unknown = [];
  const rowFor = (reviewer, worker, launch, difficulty) => {
    const reviewerId = choiceKey(reviewer);
    if (!groups.has(reviewerId)) groups.set(reviewerId, {reviewer: reviewer ?? null, rows: new Map()});
    const group = groups.get(reviewerId), rowKey = `${choiceKey(worker)}|${launch ?? ''}|${difficulty}`;
    if (!group.rows.has(rowKey)) group.rows.set(rowKey, {worker, launch, difficulty, presets: new Set(),
      samples: 0, independentSamples: 0, completedSamples: 0, firstRoundPasses: 0,
      failed: 0, inProgress: 0, mixed: {}, mixedWorkIds: new Set(), workIds: new Set(), cardIds: new Set(),
      rounds: [], durations: []});
    return group.rows.get(rowKey);
  };
  for (const work of works) {
    const executions = work.executions ?? [];
    const implementations = executions.filter(e => e.phase === 'implementation');
    const firstSend = implementations.map(e => index.runs.get(e.key)?.sends[0]).filter(Boolean)
      .sort((a, b) => time(a) - time(b))[0];
    // 읽은 범위 앞에서 실제로 발령된 구현이 있으면 기간 전에 시작한 업무다(읽기 모듈이 원장에서 확인한 값).
    const startedBefore = implementations.some(e => !index.runs.get(e.key)?.sends.length
      && cardOf.get(e.key)?.sentBeforeWindow);
    // 업무의 기간 포함 여부는 첫 구현 발령 시각으로 정한다. 업무당 독립 표본은 늘 하나다.
    if (!firstSend || startedBefore || !inWindow(firstSend)) continue;
    const samples = implementations.map(e => sampleOf(e, work, index, outcomes, picks)).filter(Boolean);
    // 수정(fix) 발령은 표본이 아니지만, 같은 업무에서 조합이 바뀌었는지는 함께 본다.
    const fixes = executions.filter(e => e.phase === 'fix').map(e => index.runs.get(e.key))
      .filter(run => run?.sends.length);
    if (samples.some(s => s.unknown) || !fixes.every(attributed)) { unknown.push(work.key); continue; }
    const first = samples[0];
    // 업무의 난이도는 첫 구현 발령에 고정된 값이다(칸이 없으면 보통). 뒤 수정 카드의 값으로 행을 바꾸지 않는다.
    const difficulty = firstSend.difficulty === 'hard' ? 'hard' : 'normal';
    const labels = new Set([...samples.flatMap(s => s.sends), ...fixes.flatMap(run => run.sends)]
      .map(send => LAUNCH_LABELS[send.launchSource]));
    // 아직 검수 발령이 없는 구현은 다른 검수자가 아니다. 검수자가 정해진 구현끼리만 비교한다.
    const reviewers = samples.map(s => s.reviewer).filter(Boolean);
    const row = rowFor(reviewers[0] ?? null, first.worker,
      ['명시 명령', '폴백'].filter(label => labels.has(label)).join('·') || null, difficulty);
    for (const sample of samples) if (sample.send.settingsPreset) row.presets.add(sample.send.settingsPreset);
    const reasons = new Set(samples.flatMap(s => [...s.reasons]));
    if (fixes.some(run => replaced(run, index.starts))) reasons.add('중간 교체');
    if (new Set(reviewers.map(choiceKey)).size > 1) reasons.add('검수자 변경');
    if (new Set([...samples.flatMap(s => s.runSends), ...fixes.flatMap(run => run.sends)]
      .map(send => choiceKey(send.runnerChoice))).size > 1) reasons.add('작업자 변경');
    // 난이도 올림: 보통으로 시작한 업무에 뒤늦게 어려움 작업자 발령(구현·수정)이 생겼다. 어려움으로 시작한 업무의 보통 수정은 섞임이 아니다.
    if (difficulty === 'normal' && [...samples.flatMap(s => s.runSends), ...fixes.flatMap(run => run.sends)]
      .some(send => send.difficulty === 'hard')) reasons.add('난이도 올림');
    if (reasons.size) {
      // 한 조합의 성과로 셀 수 없다. 사유는 한 업무에 여럿일 수 있다.
      for (const reason of reasons) {
        row.mixed[reason] = (row.mixed[reason] ?? 0) + 1;
        mixed[reason] = (mixed[reason] ?? 0) + 1;
      }
      row.mixedWorkIds.add(work.key);
      continue;
    }
    row.workIds.add(work.key);
    for (const sample of samples) for (const key of [sample.key, ...sample.reviewKeys]) row.cardIds.add(key);
    row.samples += samples.length;
    row.independentSamples++;
    row.failed += samples.filter(s => s.failed).length;
    const firstRound = Math.min(...samples.map(s => s.implementationRound));
    const branches = new Map();
    for (const sample of samples) {
      const previous = branches.get(sample.send.role) ?? null;
      const passed = sample.passedRound;
      branches.set(sample.send.role, Number.isFinite(passed)
        ? (previous === null ? passed : Math.min(previous, passed)) : previous);
    }
    const passed = [...branches.values()];
    if (!passed.every(Number.isFinite) && !['done', 'cancelled'].includes(work.status)) {
      row.inProgress++;
      continue;
    }
    row.completedSamples++;
    const rounds = relativeRounds(firstRound,
      passed.every(Number.isFinite) ? Math.max(...passed) : null);
    if (samples.every(s => !s.failed) && rounds === 1) row.firstRoundPasses++;
    const duration = median(samples.filter(s => s.implementationRound === firstRound).map(s => s.durationMs));
    if (rounds !== null) row.rounds.push(rounds);
    if (duration !== null) row.durations.push(duration);
  }
  const started = new Set(entries.filter(e => e.kind === 'start' && e.cmd
    && e.compareMode && e.roleProfile === 'worker').map(e => e.pickId));
  const reservationsWithoutStart = [...picks.values()].filter(p => inWindow(p)
    && !started.has(p.pickId)).map(p => p.pickId);
  const unlinkedCards = [...new Set(index.orphans.filter(inWindow).map(e => e.executionKey ?? e.taskId))];
  return {since: since ?? null, until: until ?? null, asOf, mixed,
    unknown: {count: unknown.length, workIds: unknown, unlinkedCards}, reservationsWithoutStart,
    groups: [...groups.values()].map(group => ({reviewer: group.reviewer,
      rows: [...group.rows.values()].map(({rounds, durations, presets, mixedWorkIds, workIds, cardIds, ...row}) =>
        ({...row, presets: [...presets], mixedWorkIds: [...mixedWorkIds],
          firstRoundPassRate: row.completedSamples ? row.firstRoundPasses / row.completedSamples : null,
          medianRounds: median(rounds), medianImplementationMs: median(durations),
          workIds: [...workIds], cardIds: [...cardIds]}))}))};
}

// 기간을 주지 않으면 최근 14일이다. 읽는 범위는 기간 시작부터라 원장 전체가 아니라 기간에 비례한다.
export function compareReport(home, {since, until, now = () => new Date()} = {}) {
  const sinceMs = isoMs(since, '--since'), untilMs = isoMs(until, '--until');
  if (sinceMs != null && untilMs != null && sinceMs > untilMs) throw new Error('--since가 --until보다 늦다');
  const asOf = now();
  const from = since ?? new Date((untilMs ?? asOf.getTime()) - DEFAULT_REPORT_DAYS * 86400000).toISOString();
  return calculateCompareReport(readCompareData(home, {since: from}),
    {since: from, until, asOf: asOf.toISOString()});
}

export function formatCompareReport(report) {
  const number = value => value == null ? '—' : String(Math.round(value * 100) / 100);
  const counts = value => Object.entries(value).map(([name, n]) => `${name} ${n}`).join(' · ') || '없음';
  // 검수 발령이 없는 묶음의 0/N은 검수 실패율이 아니다. 통과 칸을 숫자 대신 말로 보인다.
  const passes = (group, row) => group.reviewer ? `${row.firstRoundPasses}/${row.completedSamples}` : '검수 없음';
  const lines = [`조합별 성과 (${report.since ?? '처음'} ~ ${report.until ?? report.asOf})`
    + ' — 업무당 1표본, 검수자 묶음 간 순위 없음'];
  // 어려움 표본이 하나도 없으면 난이도 제목 줄을 만들지 않는다(칸을 안 쓰는 사용자의 출력은 지금과 같다).
  const hasHard = report.groups.some(group => group.rows.some(row => row.difficulty === 'hard'));
  for (const group of report.groups) {
    lines.push('', `검수자 ${choiceLabel(group.reviewer)}`);
    for (const level of hasHard ? ['normal', 'hard'] : [null]) {
    const rows = level ? group.rows.filter(row => (row.difficulty ?? 'normal') === level) : group.rows;
    if (!rows.length) continue;
    if (level) lines.push(`난이도 ${level === 'hard' ? '어려움' : '보통'}`);
    lines.push('작업자 | 표본 | 독립 | 첫 왕복 통과 | 왕복 중앙 | 구현 분 중앙 | failed | 진행 중');
    for (const row of rows) {
      lines.push(`${choiceLabel(row.worker)}${row.launch ? ` [${row.launch}]` : ''} | ${row.samples}`
        + ` | ${row.independentSamples} | ${passes(group, row)}`
        + ` | ${number(row.medianRounds)} | ${number(row.medianImplementationMs == null
          ? null : row.medianImplementationMs / 60000)} | ${row.failed} | ${row.inProgress}`);
      lines.push(`  프리셋 ${row.presets.join(', ') || '없음'} · 업무 ${row.workIds.join(', ') || '없음'}`,
        `  섞임 ${counts(row.mixed)}${row.mixedWorkIds.length ? ` · 업무 ${row.mixedWorkIds.join(', ')}` : ''}`,
        `  카드 ${row.cardIds.join(', ') || '없음'}`);
    }
    }
  }
  if (!report.groups.length) lines.push('', '이 기간에 집계할 발령이 없다.');
  lines.push('', `섞임 사유(업무 수): ${counts(report.mixed)}`,
    `귀속 불명 ${report.unknown.count}: ${report.unknown.workIds.join(', ') || '없음'}`
      + ` · 업무에 연결되지 않은 발령 카드 ${report.unknown.unlinkedCards.length}`,
    `예약만 있고 시작 없음 ${report.reservationsWithoutStart.length} (시작 중인지 실패했는지는 미확인)`);
  return lines.join('\n');
}
