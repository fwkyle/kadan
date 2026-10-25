// Why: 정기 대조(sweep)가 증분 상태와 처음부터 다시 계산한 값의 차이를 찾았을 때의 처리 규칙이다.
// 조용히 덮어쓰기도, 조용히 무시하기도 하지 않는다. 차이는 진단 파일에 남기고, 구분이 안 되면 자동 행동을 보류한다.
// 보류는 **메모리가 먼저**다: 진단 파일을 쓰지 못해도 보류와 경보는 사라지지 않는다(독립검수 F4).
// 보류·반복·알림 기억은 진단 파일에서 복원하므로 재시작해도 같은 차이로 kyle을 다시 울리지 않는다.
// 새 원장 종류는 만들지 않는다. 설계: 카드 evidence/sweep-mismatch-policy.md, 사용자 문서 docs/watch-overview.md.
import fs from 'node:fs';
import path from 'node:path';

export const DIAGNOSTICS_MAX_BYTES = 8 * 1024 * 1024;
export const REPEAT_PASSES = 3;
export const FULL_COOLDOWN_MS = 10 * 60_000;
// 진단 파일을 쓰지 못할 때 메모리에만 있는 보류의 키. 기록이 복구되고 정상 대조가 일치해야 풀린다.
export const DIAGNOSTICS_HOLD_KEY = 'sweep-diagnostics';
export const LIGHT_HOLD_PREFIX = 'light:';
export const REPEAT_ALERT_PREFIX = 'sweep-repeat:';

const PREFIX = 'watch-sweep-diagnostics-';
const fileOf = (dir, seq) => path.join(dir, `${PREFIX}${String(seq).padStart(4, '0')}.jsonl`);

// 진단 파일: 파일당 8MiB. 새 행을 더한 크기가 상한을 넘으면 다음 순번 파일로 넘어가고 옛 파일은 지우지 않는다
// (행 하나가 상한보다 크면 그 행만 새 파일에 쓴다 — 상한 초과는 그 경우뿐이다).
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
      const line = `${JSON.stringify(row)}\n`, size = Buffer.byteLength(line);
      let seq = sequences().at(-1) ?? 1;
      let current = 0;
      try { current = fs.statSync(fileOf(dir, seq)).size; } catch { /* 새 파일 */ }
      if (current > 0 && current + size > maxBytes) seq += 1;
      fs.appendFileSync(fileOf(dir, seq), line);
      return fileOf(dir, seq);
    },
  };
}

// pass 결과: {status:'match'|'diff'|'error'|'moved', diffs:[{key, fingerprint, detail}], position, generation,
//             arrayDigest, sourceDigest, arrayCount, sourceCount, error?}
//  - match: 차이 없음. 진단 기록이 정상일 때만 모든 보류를 풀고 해제를 기록한다.
//  - diff: 같은 고정 snapshot에서 원본이 검증됐고 위치가 바뀌지 않았다. 증분 상태를 처음 계산한 값으로 바꿔도 된다(replace).
//  - error·구분 불가: 교체하지 않는다. 해당 자동 행동은 보류하고 경보한다.
//  - moved: 비교 중 적용 위치나 세대가 바뀌었다. 차이로 세지 않고 다음 기회에 다시 본다.
export function createSweepPolicy({diagnostics, now = Date.now, repeatPasses = REPEAT_PASSES}) {
  const holds = new Map(), notified = new Set(), streaks = new Map(), episodes = new Map();
  for (const row of diagnostics.rows()) {
    if (row.kind === 'hold') holds.set(row.key, {since: row.at, detail: row.detail ?? null});
    else if (row.kind === 'released') { holds.delete(row.key);episodes.delete(row.key); }
    else if (row.kind === 'notified') { notified.add(`${row.key}|${row.fingerprint}`);episodes.set(row.key, row.fingerprint); }
    else if (row.kind === 'pass') {
      const seen = new Set();
      for (const diff of row.diffs ?? []) {
        seen.add(diff.key);
        const previous = streaks.get(diff.key);
        streaks.set(diff.key, previous?.fingerprint === diff.fingerprint
          ? {fingerprint: diff.fingerprint, count: previous.count + 1} : {fingerprint: diff.fingerprint, count: 1});
        // 실행 중(record)과 같은 전이: 새 지문을 보면 이전 지문의 반복 에피소드는 끝난다. 이 전이가 복원에 없으면 재시작 뒤
        // 끝난 반복 경보가 사용자에게 다시 살아난다(재검수 F8-R1). 이어지는 notified 행이 새 지문의 에피소드를 다시 연다.
        if (episodes.has(diff.key) && episodes.get(diff.key) !== diff.fingerprint) episodes.delete(diff.key);
      }
      for (const key of [...streaks.keys()]) if (!seen.has(key)) streaks.delete(key);
    }
  }
  const at = () => new Date(now()).toISOString();
  // 진단 쓰기: 실패하면 행을 메모리에 쌓아 두고 다음 쓰기에서 순서대로 다시 시도한다. 보류는 쓰기와 무관하게 메모리에 있다.
  const backlog = [];
  let diagnosticsError = null;
  function write(row) {
    backlog.push(row);
    while (backlog.length) {
      try { diagnostics.append(backlog[0]);backlog.shift(); }
      catch (error) { diagnosticsError = error?.message ?? String(error);return false; }
    }
    diagnosticsError = null;
    return true;
  }
  const hold = (key, detail, fingerprint = 'hold') => {
    if (holds.has(key)) return;
    holds.set(key, {since: at(), detail: detail ?? null});
    write({kind: 'hold', at: at(), key, fingerprint, detail: detail ?? null});
  };
  return {
    note: row => write({at: at(), ...row}),
    // 쿨다운 중이어도 새 불일치는 바로 보류한다. 해제는 검증된 전체 대조 일치뿐이다(독립검수 F1).
    holdLight(mismatches) {
      write({kind: 'light-mismatch', at: at(), mismatches});
      for (const item of mismatches) {
        hold(`${LIGHT_HOLD_PREFIX}${item.name}`, `가벼운 대조 불일치 ${item.name}: 증분 ${item.incremental} / 원본 ${item.sql}`, 'light');
      }
    },
    holding: () => holds.size > 0 || diagnosticsError != null,
    holds: () => [...holds].map(([key, value]) => ({key, ...value})),
    diagnosticsError: () => diagnosticsError,
    // 기존 감시 경보 경로로 넘길 경보. 보류가 있는 동안 계속 보이고, 해제되면 사라져 해소로 기록된다.
    // 반복 경보(사용자)는 '전달한 이력'이 아니라 '지금 이어지는 반복 에피소드'만 내보낸다: 같은 키·지문은 평생 1회,
    // 해제 뒤 재발이나 새 지문은 연속 반복이 다시 채워져야 한다(독립검수 F8). 수신자는 라우터가 id로 정한다(F2).
    alerts() {
      const list = [...holds].flatMap(([key, value]) => [
        {id: `sweep-hold:${key}`, kind: '모름', level: 'AMBER',
          message: `정기 대조 차이로 자동 재개·우편 재알림을 보류 중: ${key} (${value.detail ?? '차이 기록 참고'})`},
        ...(episodes.has(key) ? [{id: `${REPEAT_ALERT_PREFIX}${key}:${episodes.get(key)}`, kind: '모름', level: 'RED',
          message: `정기 대조 차이가 ${repeatPasses}번 이상 반복됐습니다: ${key} (${value.detail ?? '진단 파일 참고'})`}] : []),
      ]);
      if (diagnosticsError != null) {
        list.push({id: `sweep-hold:${DIAGNOSTICS_HOLD_KEY}`, kind: '모름', level: 'AMBER',
          message: `정기 대조 진단 파일을 쓰지 못해 자동 재개·우편 재알림을 보류 중: ${diagnosticsError}`});
      }
      return list;
    },
    // 항상 {escalate, replace}를 돌려주고 던지지 않는다(진단 쓰기 실패 포함).
    record(result) {
      const diffs = result.diffs ?? [], escalate = [];
      if (result.status === 'moved') {
        write({kind: 'moved', at: at(), position: result.position ?? null});
        return {escalate, replace: false};
      }
      write({kind: 'pass', at: at(), status: result.status, position: result.position ?? null,
        generation: result.generation ?? null, arrayDigest: result.arrayDigest ?? null, sourceDigest: result.sourceDigest ?? null,
        arrayCount: result.arrayCount ?? null, sourceCount: result.sourceCount ?? null, diffs, error: result.error ?? null});
      const seen = new Set();
      for (const diff of diffs) {
        seen.add(diff.key);
        const previous = streaks.get(diff.key);
        const streak = previous?.fingerprint === diff.fingerprint ? previous.count + 1 : 1;
        streaks.set(diff.key, {fingerprint: diff.fingerprint, count: streak});
        if (episodes.has(diff.key) && episodes.get(diff.key) !== diff.fingerprint) episodes.delete(diff.key);
        hold(diff.key, diff.detail, diff.fingerprint);
        const tag = `${diff.key}|${diff.fingerprint}`;
        if (streak >= repeatPasses && !notified.has(tag)) {
          notified.add(tag);episodes.set(diff.key, diff.fingerprint);escalate.push(diff.key);
          write({kind: 'notified', at: at(), key: diff.key, fingerprint: diff.fingerprint});
        }
      }
      for (const key of [...streaks.keys()]) if (!seen.has(key)) streaks.delete(key);
      if (result.status === 'error') {
        hold(result.errorKey ?? 'sweep-error', result.error ?? null, 'error');
        return {escalate, replace: false};
      }
      if (result.status === 'match') {
        // 진단 기록이 복구돼 있어야 푼다: 기록 없이 풀면 해제 근거가 남지 않는다.
        if (diagnosticsError == null) {
          for (const key of [...holds.keys()]) {
            holds.delete(key);episodes.delete(key);
            write({kind: 'released', at: at(), key});
          }
        }
      }
      // 진단을 쓰지 못한 채로 증분 상태를 바꾸지 않는다(교체 근거를 남길 수 없다).
      return {escalate, replace: result.status === 'diff' && diagnosticsError == null};
    },
  };
}

// 전체 대조를 돌려도 되는지: 시작 1번, 정기 간격, 가벼운 대조 불일치(쿨다운 안에서는 전체 대조만 다시 돌리지 않는다).
// 쿨다운은 재대조 빈도만 정한다. 자동 행동 허용 여부는 보류(holdLight)가 따로 정한다.
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
