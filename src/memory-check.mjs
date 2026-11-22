// 무거운 명령의 메모리 보호: 띄우기 직전의 시작 관문과, 도는 동안의 실행 중 보호. 판정 기준만 둔다(대기·종료는 heavy-limit.mjs).
// 왜: 패닉 3번(2026-11-13·11-21 두 번)은 모두 맥의 압축 메모리 공간 100% 고갈이었다. 11-21 2차는 스왑 0·세그먼트 19%에서
// 시작해 4분 23초 만에 고갈돼 시작 전 확인만으로는 못 막는다. 옛 조건(여유 30%·스왑 used 0)은 평소 스왑이 0으로
// 내려오지 않아(11/13~17 정상 3.4일 중앙값 6.9GiB) 계속 대기를 만들어 뺐다(2026-11-22 [kyle]).
// "압축 공간"은 감시기(watch-machine-memory.mjs)와 같은 정의다: max(세그먼트 비율, 보관 페이지 비율).
// 문턱 숫자는 실측으로 정한 값이 아니라 시작값이다. 끄는 스위치는 파일이나 환경 변수 하나다.
import fs from 'node:fs';
import path from 'node:path';

// 시작 관문: 압축 공간이 이 값 이상이거나 압박 단계가 위급이면 시작하지 않고 기다린다.
export const MEMORY_START_MAX_PCT = 75;
// 실행 중 보호: 압축 공간이 이 값 이상이거나, 압박 위급이면서 MEMORY_START_MAX_PCT 이상인 읽기가 연속 MEMORY_STOP_STREAK번이면 끊는다.
export const MEMORY_STOP_PCT = 85;
export const MEMORY_STOP_STREAK = 2;
export const MEMORY_PRESSURE_CRITICAL = 4;
// 시작 전 다시 재는 간격이자 실행 중 읽는 간격.
export const MEMORY_POLL_MS = 5000;
// 시작 전 메모리가 풀리길 기다리는 최대 시간.
export const MEMORY_WAIT_MS = 90_000;
// 실행 중 보호가 SIGTERM을 보낸 뒤 SIGKILL까지 기다리는 시간.
export const MEMORY_KILL_GRACE_MS = 10_000;
// 시험 실패(1)·사용법 오류(2)·명령 없음(127)·신호(128+)와 겹치지 않는 종료 코드. 75(EX_TEMPFAIL)는 시작하지 않음, 76은 돌던 명령을 끊음.
export const MEMORY_WAIT_EXIT = 75;
export const MEMORY_STOP_EXIT = 76;
export const MEMORY_OFF_FILE = 'memory-check.off';
export const MEMORY_OFF_ENV = 'KADAN_MEMORY_CHECK';

const PRESSURE_NAME = {1: '정상', 2: '경고', 4: '위급'};
const percent = value => `${value.toFixed(1)}%`;

// readMachineMemory()의 결과에서 압축 공간 비율. 두 축을 모두 읽지 못했으면(known이 true가 아니면) null이다.
export function compressorPct(sample) {
  if (sample?.known !== true) return null;
  return Math.max(sample.segmentPct, sample.pagePct);
}

// 대기·종료 줄에 쓰는 잰 값 한 줄. 스왑은 참고로만 보이고 판정에 쓰지 않는다.
export function describeMemory(sample) {
  const used = compressorPct(sample);
  if (used === null) return '못 읽음';
  const swap = Number.isFinite(sample.swapUsedMb) ? `${(sample.swapUsedMb / 1024).toFixed(1)}G` : '모름';
  return `압축 공간 ${percent(used)}(세그먼트 ${percent(sample.segmentPct)}·보관 페이지 ${percent(sample.pagePct)})`
    + `·압박 ${PRESSURE_NAME[sample.pressure] ?? '모름'}·스왑 ${swap}(참고)`;
}

// 시작해도 되는지. 못 읽은 값은 막는다(ok false). 압박 단계를 못 읽으면 위급이 아닌 것으로 본다.
export function judgeStart(sample) {
  const used = compressorPct(sample), line = describeMemory(sample);
  if (used === null) return {ok: false, line};
  return {ok: used < MEMORY_START_MAX_PCT && sample.pressure !== MEMORY_PRESSURE_CRITICAL, line};
}

// 도는 중의 읽기 한 번이 위험한가. 못 읽은 값은 read false이고 끊는 근거로 쓰지 않는다.
export function judgeRunning(sample) {
  const used = compressorPct(sample), line = describeMemory(sample);
  if (used === null) return {read: false, danger: false, line};
  const danger = used >= MEMORY_STOP_PCT
    || (sample.pressure === MEMORY_PRESSURE_CRITICAL && used >= MEMORY_START_MAX_PCT);
  return {read: true, danger, line};
}

// 연속 셈: 위험한 읽기면 +1, 위험하지 않거나 못 읽으면 0으로 되돌린다. MEMORY_STOP_STREAK에 닿으면 끊는다.
export function nextStopStreak(streak, verdict) {
  return verdict.read && verdict.danger ? streak + 1 : 0;
}

// 켜짐이 운영 기본이다. 환경 변수 KADAN_MEMORY_CHECK=off(시험 실행기 tests/run.mjs가 넣는다) 또는 $KADAN_HOME/memory-check.off 파일이 있으면
// 시작 관문과 실행 중 보호를 모두 끈다. 문턱이 실측 전 값이라 잘못 막거나 끊을 때 사람이 바로 끌 수 있게 파일 스위치를 둔다.
export function memoryCheckEnabled(home, env = process.env) {
  if (String(env[MEMORY_OFF_ENV] ?? '').toLowerCase() === 'off') return false;
  try { return !fs.existsSync(path.join(home, MEMORY_OFF_FILE)); } catch { return true; }
}
