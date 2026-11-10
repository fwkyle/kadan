// Autopilot이 켜진 동안 역할 세션(KADAN_ROLE 있음)이 부르면 거절하는 카단 명령 목록. 설계 갈래 A.
// 한계: KADAN_ROLE은 스스로 밝히는 값이라 `env -u KADAN_ROLE kadan …`로 우회된다. 이 거절은 실수 방지이지 보안 경계가 아니고,
// 아침 사후 드러냄(요약)과 짝이다. 꺼져 있거나 사람이 직접 치면 동작은 그대로다.
import {ledgerHome, readLedger} from './ledger.mjs';
import {autopilotState, readDecisionEvents} from './autopilot.mjs';
import {TARGETS} from './revive.mjs';
import {LEVEL_FULL} from './autopilot-terms.mjs';

// 허용 목록 방식(2026-11-02 PR #327 검수 F2): 막을 쓰기 목록이 아니라 읽기만 하는 하위 명령 목록이다.
// 새 쓰기 하위 명령이 생겨도 여기 넣지 않는 한 켜진 동안 역할 세션에서 자동으로 거절된다.
// - `window`: 하위 명령 없음(사용법 출력)·`show`만 통과. `set`·`unset`과 모르는 것은 거절.
// - `runners`: 하위 명령 없음(사용법)·`show`·`report`·`compare show`·`--out` 없는 `export`만 통과.
//   `set`·`runner`·`model`·`block`·`preset`·`import`·`fallback`·`favorite`·`init`·`compare on|off`·`export --out`은 거절.
// - `stop`: 기반 프로세스(TARGETS = 비서·대시보드·디코·watch)만 거절. 작업자·검수자 세션 종료는 감독의 정상 정리라 통과.
// - `restart`: `--force`만 거절.
// - `autopilot wingman`: 인자 없음(보기)만 통과. 이름 저장·`--clear`는 거절.
// - `autopilot repo`: 인자 없음·`list`·`show`만 통과. `autopilot repo <저장소> …`(쓰기)는 거절(저장소 이름이 list·show면 읽기로 본다).
// 거절 검사는 `--help`와 상관없이 먼저 한다(명령 함수가 --help를 무시하고 실행하던 길이 샜다, F1).
function runnersIsReadOnly(args, flags) {
  const [action, sub] = args;
  if (action === undefined || action === 'show' || action === 'report') return true;
  if (action === 'compare') return sub === 'show';
  if (action === 'export') return flags.out == null;
  return false;
}

// 켜진 동안 역할 세션에서 막을 명령이면 이유 한 줄, 아니면 null. 원장을 읽지 않는 싼 검사다.
export function guardedReason(command, args = [], flags = {}) {
  const [first] = args;
  if (command === 'restart' && flags.force) return 'restart --force';
  if (command === 'stop' && TARGETS.includes(first)) return `stop ${first}`;
  if (command === 'window' && first !== undefined && first !== 'show') return `window ${first}`;
  if (command === 'runners' && !runnersIsReadOnly(args, flags)) return `runners ${first}`;
  if (command === 'autopilot' && first === 'on' && flags.level === LEVEL_FULL) return `autopilot on --level ${LEVEL_FULL}`;
  // `autopilot repo`: 인자 없음·list·show만 읽기다. 저장소 이름 뒤 값(쓰기)과 모르는 모양은 거절한다.
  if (command === 'autopilot' && first === 'repo' && ![undefined, 'list', 'show'].includes(args[1])) return `autopilot repo ${args[1]}`;
  // `autopilot wingman`: 인자 없음이 읽기다. 이름을 주거나 --clear를 주는 쓰기는 거절한다.
  if (command === 'autopilot' && first === 'wingman' && (args[1] !== undefined || flags.clear !== undefined)) return 'autopilot wingman 저장';
  return null;
}

// 거절하면 exitCode 2로 던진다. 원장은 거절 대상일 때만, 역할 세션일 때만 한 번 읽는다(entries를 주면 재사용).
export function autopilotGuard({command, args, flags, home, env = process.env, now = Date.now(), entries, decisionEvents}) {
  const what = guardedReason(command, args, flags);
  if (!what || !String(env.KADAN_ROLE ?? '').trim()) return;
  // home을 안 주면 여기서야 읽는다: 거절 대상·역할 세션이 아니면 홈을 건드리지 않는다(--help·홈 없는 시험도 그대로).
  const where = home ?? ledgerHome();
  const state = autopilotState(entries ?? readLedger(where), decisionEvents ?? readDecisionEvents(where), now);
  if (!state.on) return;
  const error = new Error(`Autopilot이 켜져 있어 역할 세션에서는 \`kadan ${what}\`를 쓸 수 없습니다. kyle이 직접 치거나 Autopilot을 끈 뒤 하세요`);
  error.exitCode = 2;
  throw error;
}
