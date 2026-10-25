// Why: 정기 대조를 감시 순회에 붙이는 얇은 층이다. 대조는 비동기로 돌아 한 바퀴를 막지 않고,
// 결과는 다음 바퀴의 tick에서 반영된다. 보류 중이면 holding=true로 알려 자동 행동(재개 입력·우편 재알림)을 거르게 한다.
import {createFullSchedule} from './watch-sweep-policy.mjs';

// 전체 대조 주기 기본값: 10배 합성 자료에서 대조 시간을 잰 뒤 정한다(근거는 카드 result.md). 시작 때 1번은 항상 돈다.
export const DEFAULT_FULL_INTERVAL_MS = 6 * 60 * 60_000;
// 가벼운 대조는 몇 바퀴마다 돈다(SQL 몇 개짜리라 싸지만 매 바퀴 읽기 트랜잭션을 늘리지 않는다).
export const LIGHT_EVERY_CYCLES = 6;

export function createSweepRunner({engine, policy, reset, now = Date.now, intervalMs = DEFAULT_FULL_INTERVAL_MS,
  lightEvery = LIGHT_EVERY_CYCLES, onError = () => {}}) {
  const schedule = createFullSchedule({intervalMs});
  let running = null, cycles = 0;
  const startFull = reason => {
    schedule.ran(now());
    running = engine.full().then(result => {
      const outcome = policy.record(result);
      // 교체: 같은 snapshot에서 원본이 검증됐고 비교 중 위치가 바뀌지 않은 diff만 증분 상태를 버려 처음부터 다시 만든다.
      if (outcome.replace) reset();
    }).catch(error => { onError(error); }).finally(() => { running = null; });
    return reason;
  };
  return {
    // 매 바퀴 호출. 반환: 보류 여부와 이번에 내보낼 경보 목록.
    tick() {
      cycles++;
      if (!running) {
        let reason = null;
        if (cycles % lightEvery === 0) {
          try {
            const light = engine.light();
            if (light.mismatches.length) {
              policy.note({kind: 'light-mismatch', mismatches: light.mismatches});
              reason = schedule.due({now: now(), reason: 'light-mismatch'});
            }
          } catch (error) { onError(error); }
        }
        reason ??= schedule.due({now: now()});
        if (reason) startFull(reason);
      }
      return {holding: policy.holding(), alerts: policy.alerts()};
    },
    // 시험·종료용: 돌고 있는 대조가 끝나길 기다린다.
    idle: async () => { while (running) await running; },
  };
}
