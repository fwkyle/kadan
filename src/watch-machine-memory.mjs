import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {notifyUser} from './user-notify.mjs';

// XNU vm_compressor.c의 공간 부족선은 약 98%. 90/97/80은 실측으로 최적화한 값이 아니다.
// 공개 근거: apple-oss-distributions/xnu f6217f8, vm_compressor.c:903,918.
export const MACHINE_MEMORY_LIMITS = Object.freeze({critical: 90, imminent: 97, recovery: 80});
// 정상 순회 간격 약190초는 허용하되 잠자기·감시 중단을 넘어 회복을 이어 세지 않는다.
export const MACHINE_MEMORY_RECOVERY_GAP_MS = 10 * 60_000;
// 잘린 한도 등으로 생긴 비현실적인 비율을 거르는 방어선이며 실측으로 정한 값은 아니다.
export const MACHINE_MEMORY_MAX_PCT = 150;
export const MACHINE_MEMORY_KEYS = Object.freeze([
  'kern.memorystatus_vm_pressure_level',
  'vm.swapusage',
  'vm.compressor.segment.total',
  'vm.compressor.segment.limit',
  'vm.compressor.pages_compressed',
  'vm.compressor.pages_compressed_limit',
]);
const ID = 'machine:memory';
const KIND = '기기메모리';
const unknown = reason => ({known: false, reason});
const swapPattern = new RegExp(
  /^total\s*=\s*\d+(?:\.\d+)?[KMGT]/.source
  + /\s+used\s*=\s*(\d+(?:\.\d+)?)([KMGT])/.source
  + /\s+free\s*=\s*\d+(?:\.\d+)?[KMGT](?:\s+\(encrypted\))?$/.source);

export function parseMachineMemory(output) {
  const values = new Map();
  const text = String(output), lines = text.split('\n');
  const unfinished = lines.pop(); // 마지막 줄은 줄바꿈이 있어야 완결된 값이다.
  for (const line of lines) {
    const match = line.match(/^([^:\s]+):[ \t]*(.*)$/);
    if (!match) continue;
    values.set(match[1], values.has(match[1]) ? null : match[2]);
  }
  const unfinishedKey = unfinished.match(/^([^:\s]+):/);
  if (unfinishedKey) values.set(unfinishedKey[1], null);
  const integer = key => {
    const raw = values.get(key);
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(value) ? value : NaN;
  };
  const rawPressure = integer(MACHINE_MEMORY_KEYS[0]);
  const pressure = [1, 2, 4].includes(rawPressure) ? rawPressure : null;
  const [segments, segmentLimit, pages, pageLimit] = MACHINE_MEMORY_KEYS.slice(2).map(integer);
  const ratio = (used, limit) => {
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
    const percent = used / limit * 100;
    return percent <= MACHINE_MEMORY_MAX_PCT ? percent : null;
  };
  const segmentPct = ratio(segments, segmentLimit), pagePct = ratio(pages, pageLimit);
  const swap = values.get('vm.swapusage')?.match(swapPattern);
  const swapMb = swap ? Number(swap[1]) * ({K: 1 / 1024, M: 1, G: 1024, T: 1024 ** 2}[swap[2]]) : NaN;
  // known은 두 공간 축을 모두 읽었는가다. 보조 값은 각각 null(모름)일 수 있다.
  return {known: segmentPct !== null && pagePct !== null, segmentPct, pagePct, pressure,
    swapUsedMb: Number.isFinite(swapMb) ? swapMb : null, recoveryAllowed: text.endsWith('\n')};
}

export function readMachineMemory(spawn = spawnSync, platform = process.platform) {
  if (platform !== 'darwin') return unknown('platform');
  try {
    const result = spawn('/usr/sbin/sysctl', MACHINE_MEMORY_KEYS, {
      encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024, env: {...process.env, LC_ALL: 'C'},
    });
    // 원인 모를 종료2 이상은100%가 보여도 버린다. 실패 출력을 믿지 않는 의도된 손해다.
    if (result.error || result.signal || ![0, 1].includes(result.status)) {
      return unknown(result.error?.code === 'ETIMEDOUT' ? 'timeout' : 'read');
    }
    const sample = parseMachineMemory(result.stdout);
    // 없는 키로 종료1이어도 성공한 다른 키의 출력은 쓴다. 완전한 출력의 원인 불명 실패는 모름이다.
    const complete = [sample.segmentPct, sample.pagePct, sample.pressure, sample.swapUsedMb]
      .every(Number.isFinite);
    return result.status === 0 || !complete ? sample : unknown('read');
  } catch { return unknown('read'); }
}

export function assessMachineMemory(state, sample, now) {
  const usage = Math.max(...[sample.segmentPct, sample.pagePct].filter(Number.isFinite));
  const stage = usage >= MACHINE_MEMORY_LIMITS.imminent ? 2
    : usage >= MACHINE_MEMORY_LIMITS.critical ? 1 : 0;
  if (stage) {
    const next = {...state, since: state.since ?? now,
      stage: Math.max(state.stage ?? 0, stage), normalCycles: 0, lastRecoveryAt: null};
    return {state: next, ...(stage > (state.stage ?? 0) ? {alert: {...next, sample}} : {})};
  }
  // 한 축만 낮은 것은 회복 근거가 아니다. 보지 못한 축이 높을 수 있다.
  if (!sample.known || sample.recoveryAllowed === false) {
    return {state: {...state, normalCycles: 0, lastRecoveryAt: null}};
  }
  const consecutive = state.normalCycles > 0 && Number.isFinite(state.lastRecoveryAt)
    && now >= state.lastRecoveryAt && now - state.lastRecoveryAt <= MACHINE_MEMORY_RECOVERY_GAP_MS;
  const normalCycles = usage < MACHINE_MEMORY_LIMITS.recovery ? (consecutive ? state.normalCycles + 1 : 1) : 0;
  if (state.since != null && normalCycles >= 2) return {state: {}, resolved: state};
  return {state: state.since == null ? {} : {...state, normalCycles, lastRecoveryAt: normalCycles ? now : null}};
}

// 울릴 때만 기기 전체를 한 번 읽는다. 명령줄 인자·PID는 수집하지 않는다.
export function topMachineProcesses(spawn = spawnSync) {
  try {
    const result = spawn('ps', ['-axo', 'rss=,comm='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return [];
    const top = [];
    for (const line of String(result.stdout).split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const rssMb = Number(match[1]) / 1024;
      if (!Number.isFinite(rssMb)) continue;
      top.push({name: path.posix.basename(match[2]).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80), rssMb});
      top.sort((a, b) => b.rssMb - a.rssMb);
      if (top.length > 3) top.pop();
    }
    return top;
  } catch { return []; }
}

export function machineMemoryBody({stage, sample}, processes = []) {
  const usage = Math.max(...[sample.segmentPct, sample.pagePct].filter(Number.isFinite));
  const axis = (sample.segmentPct ?? -Infinity) >= (sample.pagePct ?? -Infinity) ? '세그먼트' : '보관 페이지';
  const pressure = {1: '정상', 2: '경고', 4: '위급'}[sample.pressure] ?? '모름';
  const swap = Number.isFinite(sample.swapUsedMb) ? `${(sample.swapUsedMb / 1024).toFixed(1)}G 사용` : '모름';
  const biggest = processes.length ? ` 큰 프로세스: ${processes
    .map(p => `${p.name} ${(p.rssMb / 1024).toFixed(1)}G`).join(', ')}.` : '';
  return `맥 메모리 ${stage === 2 ? '고갈 임박' : '위급'}: 압축 메모리 공간 ${usage.toFixed(1)}% 사용(${axis}). `
    + '100%가 되면 맥이 멈추고 재부팅될 수 있다(11/13 사례). 메모리를 많이 쓰는 앱을 닫아라. '
    + `스왑 ${swap}, 압박 단계 ${pressure}.${biggest}`;
}

// 이 경보의 사고 기억은 프로세스 안에만 둔다. 재시작·재부팅 뒤 첫 위급은 다시 울린다.
// 원장 복원을 기다리지 않아 첫 관측·울림도 원장 읽기보다 앞선다.
export function createMachineMemoryWatch({spawn = spawnSync, read = () => readMachineMemory(spawn),
  notify = notifyUser} = {}) {
  let state = {};
  return {
    tick({now, record}) {
      let sample;
      try { sample = read(); } catch { sample = unknown('read'); }
      const assessed = assessMachineMemory(state, sample, now);
      state = assessed.state;
      if (assessed.alert || assessed.resolved) {
        const incident = assessed.alert ?? assessed.resolved;
        let delivered = false;
        let text;
        if (assessed.alert) {
          text = machineMemoryBody(incident, topMachineProcesses(spawn));
          const key = `alert:${ID}:${process.pid}:${incident.since}:${incident.stage}`;
          try {
            const sent = notify(text, spawn, {kind: 'alert', alertKind: KIND, level: 'RED', ring: true,
              key, decision: {id: key}});
            delivered = sent?.error === null && !sent.skipped && !sent.duplicate
              && ['discord', 'system'].includes(sent.via);
          } catch { /* 알림 전달 실패도 나머지 감시를 막지 않는다. 같은 단계는 다시 울리지 않는다. */ }
        }
        try {
          record({kind: 'alert', id: ID, alertKind: KIND, level: 'RED', by: 'watch',
            recipient: '@user', since: incident.since, stage: incident.stage, delivered,
            ...(text ? {text} : {}), ...(assessed.resolved ? {resolved: true} : {})});
        } catch { /* 원장 잠금도 기기 경보·감시 순회를 멈추지 않는다. */ }
      }
      return sample;
    },
  };
}
