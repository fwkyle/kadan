// 무거운 명령을 띄우기 직전의 메모리 확인. 여유가 모자라거나 스왑을 이미 쓰고 있으면 시작하지 않는다.
// 왜: 2026-11-21 맥이 메모리 압축 한계로 커널 패닉 재부팅을 두 번 했다(19:45·20:59). 여러 역할이 무거운 명령을 겹쳐 돌린 탓이다.
// 문턱은 [kyle] 규칙 그대로다: 여유 30% 이상 그리고 스왑 used 0일 때만 시작한다.
// 맥이 아니거나 값을 못 읽으면 막지 않는다(건너뛰고 이유만 알린다). 끄는 스위치는 파일이나 환경 변수 하나다.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const MEMORY_FREE_MIN_PERCENT = 30;
export const SWAP_USED_MAX_MB = 0;
// 메모리가 풀리길 기다리는 최대 시간. 도구 호출 한 번의 제한(10분)보다 짧게 둔다.
export const MEMORY_WAIT_MS = 5 * 60 * 1000;
// 시험 실패(1)·사용법 오류(2)·명령 없음(127)·신호(128+)와 겹치지 않는 종료 코드(EX_TEMPFAIL).
export const MEMORY_WAIT_EXIT = 75;
export const MEMORY_OFF_FILE = 'memory-check.off';
export const MEMORY_OFF_ENV = 'KADAN_MEMORY_CHECK';

// `memory_pressure`의 마지막 줄: "System-wide memory free percentage: 58%"
export function parseFreePercent(text) {
  const all = [...String(text ?? '').matchAll(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)\s*%/g)];
  return all.length ? Number(all.at(-1)[1]) : null;
}

// `sysctl vm.swapusage`: "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)" → used를 MB로
const UNIT_MB = {K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024};
export function parseSwapUsedMb(text) {
  const found = /\bused\s*=\s*(\d+(?:\.\d+)?)\s*([KMGT]?)/i.exec(String(text ?? ''));
  if (!found) return null;
  return Number(found[1]) * (UNIT_MB[found[2].toUpperCase()] ?? 1);
}

// 읽은 값: {freePercent, swapUsedMb} 또는 건너뛸 이유 {skip}. 둘 중 하나라도 못 읽으면 건너뛴다.
export function readMemory({platform = process.platform, run = spawnSync} = {}) {
  if (platform !== 'darwin') return {skip: `맥이 아님(${platform})`};
  const ask = (cmd, args) => {
    try {
      const result = run(cmd, args, {encoding: 'utf8', timeout: 5000});
      return result?.status === 0 ? String(result.stdout ?? '') : null;
    } catch { return null; }
  };
  const free = ask('memory_pressure', []);
  if (free === null) return {skip: 'memory_pressure를 실행하지 못함'};
  const freePercent = parseFreePercent(free);
  if (freePercent === null) return {skip: 'memory_pressure 출력에서 여유 비율을 읽지 못함'};
  const swap = ask('sysctl', ['vm.swapusage']);
  if (swap === null) return {skip: 'sysctl vm.swapusage를 실행하지 못함'};
  const swapUsedMb = parseSwapUsedMb(swap);
  if (swapUsedMb === null) return {skip: 'vm.swapusage 출력에서 used를 읽지 못함'};
  return {freePercent, swapUsedMb};
}

const mb = value => `${Number(value.toFixed(2))}M`;
export const describeMemory = ({freePercent, swapUsedMb}) =>
  `여유 ${freePercent}%(${MEMORY_FREE_MIN_PERCENT}% 이상 필요)·스왑 used ${mb(swapUsedMb)}(${SWAP_USED_MAX_MB}이어야 함)`;

// 시작해도 되는지. 못 읽은 값(skip)은 막지 않는다.
export function judgeMemory(memory) {
  if (memory.skip) return {ok: true, skip: memory.skip};
  const ok = memory.freePercent >= MEMORY_FREE_MIN_PERCENT && memory.swapUsedMb <= SWAP_USED_MAX_MB;
  return {ok, line: describeMemory(memory)};
}

// 켜짐이 운영 기본이다. 환경 변수 KADAN_MEMORY_CHECK=off(시험 실행기 tests/run.mjs가 넣는다) 또는 $KADAN_HOME/memory-check.off 파일이 있으면 끈다.
// 파일 스위치 이유: 스왑은 한 번 쓰이면 메모리가 풀려도 0으로 돌아오지 않을 수 있어, 이 확인을 고치는 작업까지 막힐 수 있다.
export function memoryCheckEnabled(home, env = process.env) {
  if (String(env[MEMORY_OFF_ENV] ?? '').toLowerCase() === 'off') return false;
  try { return !fs.existsSync(path.join(home, MEMORY_OFF_FILE)); } catch { return true; }
}
