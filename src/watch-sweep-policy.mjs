// Why: 정기 대조(sweep)가 증분 상태와 처음부터 다시 계산한 값의 차이를 찾았을 때의 처리 규칙이다.
// 조용히 덮어쓰기도, 조용히 무시하기도 하지 않는다. 차이는 진단 파일에 남기고, 구분이 안 되면 자동 행동을 보류한다.
// 보류·반복·알림 기억은 진단 파일에서 복원하므로 재시작해도 같은 차이로 kyle을 다시 울리지 않는다.
// 새 원장 종류는 만들지 않는다. 설계: 카드 evidence/sweep-mismatch-policy.md.
import fs from 'node:fs';
import path from 'node:path';

export const DIAGNOSTICS_MAX_BYTES = 8 * 1024 * 1024;
export const REPEAT_PASSES = 3;
export const FULL_COOLDOWN_MS = 10 * 60_000;

const PREFIX = 'watch-sweep-diagnostics-';
const fileOf = (dir, seq) => path.join(dir, `${PREFIX}${String(seq).padStart(4, '0')}.jsonl`);

// 진단 파일: 파일당 8MiB. 넘으면 다음 순번 파일로 넘어가고 옛 파일은 지우지 않는다.
export function createSweepDiagnostics(dir, {maxBytes = DIAGNOSTICS_MAX_BYTES} = {}) {
  const sequences = () => {
    try {
      return fs.readdirSync(dir).map(name => name.match(/^watch-sweep-diagnostics-(\d{4,})\.jsonl$/u))
        .filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
    } catch { return []; }
  };
  return {
    sequences,
    rows() {
      const rows = [];
      for (const seq of sequences()) {
        let text = '';
        try { text = fs.readFileSync(fileOf(dir, seq), 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          if (!line) continue;
          try { rows.push(JSON.parse(line)); } catch { /* 중간에 끊긴 줄은 건너뛴다. */ }
        }
      }
      return rows;
    },
    append(row) {
      fs.mkdirSync(dir, {recursive: true});
      const all = sequences();
      let seq = all.at(-1) ?? 1;
      try { if (fs.statSync(fileOf(dir, seq)).size >= maxBytes) seq += 1; } catch { /* 새 파일 */ }
      fs.appendFileSync(fileOf(dir, seq), `${JSON.stringify(row)}\n`);
      return fileOf(dir, seq);
    },
  };
}

// pass 결과: {at, status:'match'|'diff'|'error'|'moved', diffs:[{key, fingerprint, detail}], error?}
//  - match: 차이 없음. 이 항목의 보류를 풀고 해제를 기록한다.
//  - diff: 같은 snapshot에서 원본이 검증됐고 비교 중 위치가 바뀌지 않았다. 증분 상태를 처음 계산한 값으로 바꿔도 된다(replace).
//  - error·구분 불가: 교체하지 않는다. 해당 자동 행동은 보류하고 경보한다.
//  - moved: 비교 중 적용 위치나 세대가 바뀌었다. 차이로 세지 않고 다음 기회에 다시 본다.
export function createSweepPolicy({diagnostics, now = Date.now, repeatPasses = REPEAT_PASSES}) {
  const holds = new Map(), notified = new Set(), streaks = new Map();
  for (const row of diagnostics.rows()) {
    if (row.kind === 'hold') holds.set(row.key, {since: row.at, detail: row.detail ?? null});
    else if (row.kind === 'released') holds.delete(row.key);
    else if (row.kind === 'notified') notified.add(`${row.key}|${row.fingerprint}`);
    else if (row.kind === 'pass') {
      const seen = new Set();
      for (const diff of row.diffs ?? []) {
        seen.add(diff.key);
        const previous = streaks.get(diff.key);
        streaks.set(diff.key, previous?.fingerprint === diff.fingerprint
          ? {fingerprint: diff.fingerprint, count: previous.count + 1} : {fingerprint: diff.fingerprint, count: 1});
      }
      for (const key of [...streaks.keys()]) if (!seen.has(key)) streaks.delete(key);
    }
  }
  const at = () => new Date(now()).toISOString();
  return {
    holding: () => holds.size > 0,
    holds: () => [...holds].map(([key, value]) => ({key, ...value})),
    // 기존 감시 경보 경로로 넘길 경보. 보류가 있는 동안 계속 보이고, 해제되면 사라져 해소로 기록된다.
    alerts: () => [...holds].map(([key, value]) => ({id: `sweep-hold:${key}`, kind: '모름', level: 'AMBER',
      message: `정기 대조 차이로 자동 재개·우편 재알림을 보류 중: ${key} (${value.detail ?? '차이 기록 참고'})`})),
    // 반복 판정이 새로 난 항목만 돌려준다(같은 키·지문은 평생 한 번).
    record(result) {
      const diffs = result.diffs ?? [], escalate = [];
      if (result.status === 'moved') {
        diagnostics.append({kind: 'moved', at: at(), position: result.position ?? null});
        return {escalate, replace: false};
      }
      diagnostics.append({kind: 'pass', at: at(), status: result.status, diffs, error: result.error ?? null});
      const seen = new Set();
      for (const diff of diffs) {
        seen.add(diff.key);
        const previous = streaks.get(diff.key);
        const streak = previous?.fingerprint === diff.fingerprint ? previous.count + 1 : 1;
        streaks.set(diff.key, {fingerprint: diff.fingerprint, count: streak});
        if (!holds.has(diff.key)) {
          holds.set(diff.key, {since: at(), detail: diff.detail ?? null});
          diagnostics.append({kind: 'hold', at: at(), key: diff.key, fingerprint: diff.fingerprint, detail: diff.detail ?? null});
        }
        const tag = `${diff.key}|${diff.fingerprint}`;
        if (streak >= repeatPasses && !notified.has(tag)) {
          notified.add(tag);escalate.push(diff.key);
          diagnostics.append({kind: 'notified', at: at(), key: diff.key, fingerprint: diff.fingerprint});
        }
      }
      for (const key of [...streaks.keys()]) if (!seen.has(key)) streaks.delete(key);
      if (result.status === 'error') {
        const key = result.errorKey ?? 'sweep-error';
        if (!holds.has(key)) {
          holds.set(key, {since: at(), detail: result.error ?? null});
          diagnostics.append({kind: 'hold', at: at(), key, fingerprint: 'error', detail: result.error ?? null});
        }
        return {escalate, replace: false};
      }
      if (result.status === 'match') {
        for (const key of [...holds.keys()]) {
          holds.delete(key);
          diagnostics.append({kind: 'released', at: at(), key});
        }
      }
      return {escalate, replace: result.status === 'diff'};
    },
  };
}

// 전체 대조를 돌려도 되는지: 시작 1번, 정기 간격, 가벼운 대조 불일치(쿨다운 안에서는 다시 돌리지 않는다).
export function createFullSchedule({intervalMs, cooldownMs = FULL_COOLDOWN_MS}) {
  let lastAt = null, started = false;
  return {
    due({now, reason = 'periodic'}) {
      if (!started) return 'start';
      if (reason === 'light-mismatch') return lastAt != null && now - lastAt < cooldownMs ? null : 'light-mismatch';
      return lastAt == null || now - lastAt >= intervalMs ? 'periodic' : null;
    },
    ran(now) { started = true;lastAt = now; },
  };
}
