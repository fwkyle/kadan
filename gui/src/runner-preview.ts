import type {Choice} from './pages/Runners';

// 시니어 가운데 scripts/senior.sh(codex exec)로 부르는 실행기. 서버 SENIOR_SCRIPT_RUNNER와 같다.
const SENIOR_SCRIPT_RUNNER = 'codex';

// 바꾸기 칸의 시니어 '바뀔 명령' 한 명분. 서버 seniorCommandLabel(src/senior.mjs)과 같은 갈래·같은 글이다.
// 옛 화면은 agy에도 `KADAN_SENIOR_EFFORT=max senior.sh`를 보였다(2026-11-20). 두 곳이 다시 어긋나지 않게
// gui/tests/runner-preview.test.ts가 서버 함수와 글자를 대조한다.
export const seniorPreview = (choice: Choice) =>
  choice.runner === SENIOR_SCRIPT_RUNNER
    ? `KADAN_SENIOR_MODEL=${choice.model} KADAN_SENIOR_EFFORT=${choice.effort || 'max'} senior.sh (codex exec, 저장소 읽기 전용)`
    : `${choice.runner} 대화창 · 모델 ${choice.model} (도구 없는 에이전트, 저장소 읽기 전용 폴더)`;
