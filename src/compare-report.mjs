// Why: 종료된 세션도 발령 당시 프리셋으로 묶고, 한 업무를 한 번만 비교한다.
import {readSettings} from './runner-settings.mjs';
import {readCompareData} from './compare-report-data.mjs';

const choiceKey = value => value ? [value.runner, value.model, value.effort ?? ''].join('/') : '확인 필요';
const time = entry => Date.parse(entry?.t ?? entry?.at ?? '');
const shortId = key => key?.split('/').at(-1);
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null;
};
export const relativeRounds = (implementationRound, passedRound) =>
  passedRound == null ? null : Number(passedRound) - Number(implementationRound) + 1;

function runIndex(entries, works) {
  const keys = new Map(), executions = new Map();
  for (const work of works) for (const execution of work.executions ?? []) {
    const id = shortId(execution.key);
    keys.set(id, keys.has(id) && keys.get(id) !== execution.key ? null : execution.key);
    executions.set(execution.key, {...execution, workKey: work.key});
  }
  const runs = new Map(), starts = new Map();
  for (const entry of entries) {
    if (entry.kind === 'start' && entry.cmd) {
      const list = starts.get(entry.role) ?? []; list.push(entry); starts.set(entry.role, list);
    }
    if (!['send', 'done'].includes(entry.kind) || !entry.taskId) continue;
    const key = entry.executionKey ?? keys.get(entry.taskId) ?? (executions.has(entry.taskId) ? entry.taskId : null);
    if (!key) continue;
    const run = runs.get(key) ?? {key, sends: [], done: null};
    if (entry.kind === 'send') run.sends.push(entry);
    else if (!run.done) run.done = entry;
    runs.set(key, run);
  }
  return {runs, starts};
}

function runProblem(run, starts) {
  const first = run?.sends[0];
  if (!first) return '귀속 확인 필요';
  if (run.sends.some(send => send.compareMode !== true)) return '폴백·명시 명령';
  if ((starts.get(first.role) ?? []).some(start => time(start) > time(first)
    && (!run.done || time(start) <= time(run.done)))) return '중간 교체';
  return null;
}

function sampleOf(execution, work, index, outcomes, picks) {
  const run = index.runs.get(execution.key), send = run?.sends[0];
  if (!send) return null;
  const pick = picks.get(send.pickId);
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
  const reviewerChoices = new Set(used.map(e => choiceKey(index.runs.get(e.key)?.sends[0]?.runnerChoice)));
  const reviewer = used.length ? index.runs.get(used[0].key).sends[0].runnerChoice : pick?.reviewer;
  let reason = runProblem(run, index.starts);
  if (!reason && used.some(e => runProblem(index.runs.get(e.key), index.starts))) {
    reason = used.map(e => runProblem(index.runs.get(e.key), index.starts)).find(Boolean);
  }
  if (!reason && reviewerChoices.size > 1) reason = '검수자 변경';
  if (!reason && (!send.settingsPreset || !send.runnerChoice || !reviewer)) reason = '귀속 확인 필요';
  if (!reason && reviews.length && !matched.length) reason = '귀속 확인 필요';
  return {workKey: work.key, key: execution.key, preset: send.settingsPreset,
    worker: send.runnerChoice, reviewer, send, reason, failed: run.done?.result === 'failed',
    rounds: relativeRounds(execution.round, firstPass?.round),
    implementationRound: Number(execution.round), passedRound: firstPass ? Number(firstPass.round) : null,
    durationMs: run.done ? time(run.done) - time(send) : null,
    reviewKeys: used.map(e => e.key)};
}

export function calculateCompareReport({entries, works, cards}, {since, epoch, asOf = new Date().toISOString()} = {}) {
  const sinceMs = since == null ? -Infinity : Date.parse(since);
  if (!Number.isFinite(sinceMs) && sinceMs !== -Infinity) throw new Error('--since에는 ISO 날짜가 필요하다');
  const inWindow = entry => time(entry) >= sinceMs;
  const picks = new Map(entries.filter(e => e.kind === 'compare-pick').map(e => [e.pickId, e]));
  const outcomes = new Map(cards.map(card => [card.key, card.result?.outcome]));
  const index = runIndex(entries, works), groups = new Map(), mixed = [], excluded = {};
  const rowFor = (preset, worker, reviewer) => {
    const reviewerId = choiceKey(reviewer);
    if (!groups.has(reviewerId)) groups.set(reviewerId, {reviewer, rows: new Map()});
    const group = groups.get(reviewerId), rowKey = `${preset}:${choiceKey(worker)}`;
    if (!group.rows.has(rowKey)) group.rows.set(rowKey, {preset, worker, picks: 0, starts: 0,
      samples: 0, independentSamples: 0, completedSamples: 0, firstRoundPasses: 0,
      failed: 0, inProgress: 0, excluded: {}, workIds: new Set(), cardIds: new Set(),
      rounds: [], durations: []});
    return group.rows.get(rowKey);
  };
  for (const pick of picks.values()) {
    if (!inWindow(pick) || (epoch && pick.epoch !== epoch)) continue;
    rowFor(pick.preset, pick.worker, pick.reviewer).picks++;
  }
  for (const start of entries.filter(e => e.kind === 'start' && e.cmd && e.compareMode
    && e.roleProfile === 'worker' && inWindow(e))) {
    const pick = picks.get(start.pickId);
    if (pick && (!epoch || pick.epoch === epoch)) rowFor(start.settingsPreset, pick.worker, pick.reviewer).starts++;
  }
  for (const work of works) {
    const implementations = (work.executions ?? []).filter(e => e.phase === 'implementation');
    const comparison = implementations.filter(e => index.runs.get(e.key)?.sends.some(s => s.compareMode
      || ['fallback', 'override'].includes(s.launchSource)));
    const firstSend = comparison.map(e => index.runs.get(e.key).sends[0])
      .sort((a, b) => time(a) - time(b))[0];
    if (!firstSend || !inWindow(firstSend)) continue;
    const selected = comparison.filter(e => {
      const send = index.runs.get(e.key).sends[0];
      return (!epoch || picks.get(send.pickId)?.epoch === epoch
        || (!send.compareMode && time(send) >= Date.parse(epoch)));
    });
    if (!selected.length) continue;
    if (comparison.some(e => index.runs.get(e.key).sends.some(s => !s.compareMode))) {
      excluded['폴백·명시 명령'] = (excluded['폴백·명시 명령'] ?? 0) + 1;
      continue;
    }
    // 기간 밖의 같은 업무도 군 혼합 판정에는 포함한다. 업무당 독립 표본은 늘 하나다.
    const presets = new Set(comparison.flatMap(e => index.runs.get(e.key).sends
      .filter(s => s.compareMode).map(s => s.settingsPreset)));
    if (presets.size > 1) {
      mixed.push({workId: work.key, presets: [...presets], cardIds: comparison.map(e => e.key)});
      excluded['혼합 군'] = (excluded['혼합 군'] ?? 0) + 1;
      continue;
    }
    const samples = comparison.map(e => sampleOf(e, work, index, outcomes, picks)).filter(Boolean);
    const first = samples[0];
    if (!first) continue;
    const row = rowFor(first.preset, first.worker, first.reviewer);
    row.workIds.add(work.key);
    for (const sample of samples) for (const key of [sample.key, ...sample.reviewKeys]) row.cardIds.add(key);
    const reasons = new Set(samples.map(s => s.reason).filter(Boolean));
    if (new Set(samples.map(s => choiceKey(s.reviewer))).size > 1) reasons.add('검수자 변경');
    if (new Set(samples.map(s => choiceKey(s.worker))).size > 1) reasons.add('작업자 변경');
    if (reasons.size) {
      for (const reason of reasons) {
        row.excluded[reason] = (row.excluded[reason] ?? 0) + 1;
        excluded[reason] = (excluded[reason] ?? 0) + 1;
      }
      continue;
    }
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
    && (!epoch || p.epoch === epoch) && !started.has(p.pickId)).map(p => p.pickId);
  return {since: since ?? null, epoch: epoch ?? null, asOf, mixed, excluded, reservationsWithoutStart,
    groups: [...groups.values()].map(group => ({reviewer: group.reviewer,
      rows: [...group.rows.values()].map(({rounds, durations, workIds, cardIds, ...row}) => ({...row,
        firstRoundPassRate: row.completedSamples ? row.firstRoundPasses / row.completedSamples : null,
        medianRounds: median(rounds), medianImplementationMs: median(durations),
        workIds: [...workIds], cardIds: [...cardIds]}))}))};
}

export function compareReport(home, {since} = {}) {
  if (since != null && (typeof since !== 'string' || !Number.isFinite(Date.parse(since)))) {
    throw new Error('--since에는 ISO 날짜가 필요하다');
  }
  const compare = readSettings(home)?.compare;
  return calculateCompareReport(readCompareData(home, compare), {
    since: since ?? compare?.enabledAt, epoch: since ? undefined : compare?.enabledAt,
  });
}

export function formatCompareReport(report) {
  const number = value => value == null ? '—' : String(Math.round(value * 100) / 100);
  const lines = [`비교 결과 (${report.since ?? '기록 없음'} 이후) — 업무당 1표본, 검수자 묶음 간 순위 없음`];
  for (const group of report.groups) {
    lines.push('', `검수자 ${choiceKey(group.reviewer)}`);
    lines.push('프리셋 / 작업자 | 예약 | 시작 | 표본 | 독립 | 첫 왕복 통과 | 왕복 중앙 | 구현 분 중앙 | failed | 진행 중');
    for (const row of group.rows) {
      lines.push(`${row.preset} / ${choiceKey(row.worker)} | ${row.picks} | ${row.starts} | ${row.samples}`
        + ` | ${row.independentSamples} | ${row.firstRoundPasses}/${row.completedSamples}`
        + ` | ${number(row.medianRounds)} | ${number(row.medianImplementationMs == null
          ? null : row.medianImplementationMs / 60000)} | ${row.failed} | ${row.inProgress}`);
      lines.push(`  제외 ${JSON.stringify(row.excluded)} · 업무 ${row.workIds.join(', ') || '없음'}`,
        `  카드 ${row.cardIds.join(', ') || '없음'}`);
    }
  }
  lines.push('', `혼합 군 ${report.mixed.length}: ${report.mixed.map(w => w.workId).join(', ') || '없음'}`,
    `예약만 있고 시작 없음 ${report.reservationsWithoutStart.length} (시작 중인지 실패했는지는 미확인)`,
    `제외 사유(업무 수): ${JSON.stringify(report.excluded)}`);
  return lines.join('\n');
}
