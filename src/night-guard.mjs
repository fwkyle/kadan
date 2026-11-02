// 나이트 모드가 켜진 동안 역할 세션(KADAN_ROLE 있음)이 부르면 거절하는 카단 명령 목록. 설계 갈래 A.
// 한계: KADAN_ROLE은 스스로 밝히는 값이라 `env -u KADAN_ROLE kadan …`로 우회된다. 이 거절은 실수 방지이지 보안 경계가 아니고,
// 아침 사후 드러냄(요약)과 짝이다. 꺼져 있거나 사람이 직접 치면 동작은 그대로다.
import {readLedger} from './ledger.mjs';
import {nightState, readDecisionEvents} from './night.mjs';

const RUNNERS_WRITE = ['set', 'runner', 'model'];

// 켜진 동안 역할 세션에서 막을 명령이면 이유 한 줄, 아니면 null. 원장을 읽지 않는 싼 검사다.
export function guardedReason(command, args = [], flags = {}) {
  const [first] = args;
  if (command === 'restart' && flags.force) return 'restart --force';
  if (command === 'stop' && ['watch', '대시보드'].includes(first)) return `stop ${first}`;
  if (command === 'window' && ['set', 'unset'].includes(first)) return `window ${first}`;
  if (command === 'runners' && RUNNERS_WRITE.includes(first)) return `runners ${first}`;
  if (command === 'night' && first === 'on' && flags.level === '바이패스') return 'night on --level 바이패스';
  return null;
}

// 거절하면 exitCode 2로 던진다. 원장은 거절 대상일 때만, 역할 세션일 때만 한 번 읽는다(entries를 주면 재사용).
export function nightGuard({command, args, flags, home, env = process.env, now = Date.now(), entries, decisionEvents}) {
  const what = guardedReason(command, args, flags);
  if (!what || !String(env.KADAN_ROLE ?? '').trim()) return;
  const state = nightState(entries ?? readLedger(home), decisionEvents ?? readDecisionEvents(home), now);
  if (!state.on) return;
  const error = new Error(`나이트 모드가 켜져 있어 역할 세션에서는 \`kadan ${what}\`를 쓸 수 없습니다. kyle이 직접 치거나 나이트를 끈 뒤 하세요`);
  error.exitCode = 2;
  throw error;
}
