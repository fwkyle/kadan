// 맥 전체 메모리 상태를 sysctl 한 번으로 읽는다. 읽기만 하고 알림·원장 모듈을 끌고 오지 않는다.
// 감시기(watch-machine-memory.mjs)와 무거운 명령의 메모리 보호(memory-check.mjs·heavy-limit.mjs)가 같이 쓴다.
import {spawnSync} from 'node:child_process';

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
export const unknownMachineMemory = reason => ({known: false, reason});
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
  if (platform !== 'darwin') return unknownMachineMemory('platform');
  try {
    const result = spawn('/usr/sbin/sysctl', MACHINE_MEMORY_KEYS, {
      encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024, env: {...process.env, LC_ALL: 'C'},
    });
    // 원인 모를 종료2 이상은100%가 보여도 버린다. 실패 출력을 믿지 않는 의도된 손해다.
    if (result.error || result.signal || ![0, 1].includes(result.status)) {
      return unknownMachineMemory(result.error?.code === 'ETIMEDOUT' ? 'timeout' : 'read');
    }
    const sample = parseMachineMemory(result.stdout);
    // 없는 키로 종료1이어도 성공한 다른 키의 출력은 쓴다. 완전한 출력의 원인 불명 실패는 모름이다.
    const complete = [sample.segmentPct, sample.pagePct, sample.pressure, sample.swapUsedMb]
      .every(Number.isFinite);
    return result.status === 0 || !complete ? sample : unknownMachineMemory('read');
  } catch { return unknownMachineMemory('read'); }
}
