// Why: RSS에서 빠진 압축 메모리를 top 값과 같은 순간의 힙으로 비교한다.
// 원장이 10배여도 구간당 자식 하나와 고정 크기 표본 하나만 보관한다.
import {spawn as spawnProcess} from 'node:child_process';
import {CYCLE_RECORD_MS} from './watch-cycle.mjs';

const MAX_MEMORY = 999_999.9;
const MAX_OUTPUT = 16 * 1024;
const mib = bytes => Math.min(MAX_MEMORY, Math.round(bytes / 1048576 * 10) / 10);

export function parseProcessTop(output, pid) {
  const lines = output.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
  const header = lines.findIndex(parts => ['PID', 'MEM', 'CMPRS'].every(key => parts.includes(key)));
  if (header < 0) return null;
  const columns = lines[header];
  const row = lines.slice(header + 1).find(parts => parts[columns.indexOf('PID')] === String(pid));
  if (!row) return null;
  const values = ['MEM', 'CMPRS'].map(key => {
    const match = /^(\d+(?:\.\d+)?)([BKMG])[+-]?$/i.exec(row[columns.indexOf(key)] ?? '');
    if (!match) return null;
    const bytes = Number(match[1]) * 1024 ** 'BKMG'.indexOf(match[2].toUpperCase());
    return Number.isFinite(bytes) ? mib(bytes) : null;
  });
  return values.includes(null) ? null : {mem: values[0], cmprs: values[1]};
}

export function createWatchProcessTop({
  spawn = spawnProcess, platform = process.platform, pid = process.pid,
  now = Date.now, memoryUsage = () => process.memoryUsage(),
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let active = null, stopActive = null, last = null, startedAt = null, failures = 0, stopped = false;
  return {
    sample() {
      const at = now();
      if (stopped || platform !== 'darwin' || active
        || (startedAt !== null && at - startedAt < CYCLE_RECORD_MS)) return;
      startedAt = at;
      let child, timer, output = '', size = 0, settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        last = null;
        failures = Math.min(999_999, failures + 1);
        clearTimer(timer);
      };
      const kill = () => { try { child?.kill('SIGKILL'); } catch { /* 종료됐어도 재시도하지 않는다. */ } };
      try {
        const heapUsed = memoryUsage().heapUsed;
        if (!Number.isFinite(heapUsed) || heapUsed < 0) { fail(); return; }
        child = spawn('/usr/bin/top', ['-l', '1', '-pid', String(pid), '-stats', 'pid,mem,cmprs'], {
          env: {...process.env, LC_ALL: 'C'}, stdio: ['ignore', 'pipe', 'ignore'],
        });
        active = child;
        child.on('error', fail);
        child.stdout.on('error', () => { fail(); kill(); });
        child.stdout.on('data', data => {
          if (settled) return;
          size += Buffer.byteLength(data);
          if (size > MAX_OUTPUT) { fail(); kill(); return; }
          output += data.toString();
        });
        child.once('close', code => {
          active = null;
          stopActive = null;
          clearTimer(timer);
          if (settled) return;
          try {
            const parsed = code === 0 ? parseProcessTop(output, pid) : null;
            if (!parsed) { fail(); return; }
            last = {...parsed, heapUsed: mib(heapUsed), at};
            settled = true;
          } catch { fail(); }
        });
        child.unref();
        child.stdout.unref?.();
        timer = setTimer(() => { fail(); kill(); }, 5000);
        timer.unref?.();
        stopActive = () => { settled = true; clearTimer(timer); kill(); };
      } catch { fail(); kill(); }
    },
    snapshot() {
      const ageMs = last ? Math.max(0, Math.round(now() - last.at)) : 0;
      const top = last && ageMs < 2 * CYCLE_RECORD_MS
        ? {mem: last.mem, cmprs: last.cmprs, heapUsed: last.heapUsed, ageMs} : null;
      return {top, topFailures: failures};
    },
    // 진행 중인 결과와 앞 구간 표본은 보존하고 기록이 끝난 실패 수만 비운다.
    clear() { failures = 0; },
    stop() { stopped = true; stopActive?.(); },
  };
}
