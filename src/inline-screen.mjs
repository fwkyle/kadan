// Why: codex 0.157부터 대화형 화면이 풀스크린(alternate screen)이 기본이라, 죽은 창의 마지막 줄 보존(captureTail)·
// pipe-pane 출력 기록(DONE 마커)·tmux 위로 스크롤이 약해진다(2026-10-18 [kyle] 결정). 사용자 설정에 기대지 않고
// 카단이 만드는 대화형 codex 명령에 --no-alt-screen을 붙여 스크롤백(인라인) 화면으로 고정한다.
// 토큰 단위로만 본다 — 모델 이름에 alt-screen이 들어가도 빠지면 안 된다. 판단할 수 없는 명령(셸 연산·따옴표 깨짐)은 그대로 둔다.
import {commandWords, launchIdentityOf} from './ai-identity.mjs';

export const INLINE_FLAG = '--no-alt-screen';

// 값을 받는 codex 옵션(codex 0.163 `codex --help`). 값 낱말을 하위 명령으로 읽지 않으려고 건너뛴다.
const VALUE_OPTIONS = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir',
  '-a', '--ask-for-approval', '-i', '--image']);

// 대화형 화면이 없는 하위 명령(codex 0.163 `codex --help`). resume·fork·하위 명령 없음(첫 프롬프트)만 대화형이다.
const NON_INTERACTIVE = new Set(['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server',
  'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive',
  'delete', 'migrate-rollouts', 'unarchive', 'cloud', 'exec-server', 'features', 'help']);

// 대화형 codex 실행 명령이면 --no-alt-screen을 끝에 덧붙인 명령을, 아니면 받은 명령 그대로 돌려준다. 이미 있으면 중복하지 않는다.
export function withInlineScreen(cmd) {
  const words = commandWords(cmd);
  if (!words?.length) return cmd;
  let head = 0;
  while (head < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[head])) head += 1; // LC_ALL=C codex …
  const executable = words[head]?.split('/').pop();
  if (executable !== 'codex' && executable !== 'kadan-codex') return cmd;
  const args = words.slice(head + 1);
  if (args.includes(INLINE_FLAG)) return cmd;
  // `--` 뒤는 옵션이 아니라 위치 인자(프롬프트)라, 있으면 그 앞에 넣는다(끝에 덧붙이면 프롬프트 낱말이 된다).
  const dash = args.indexOf('--');
  for (let i = 0; i < (dash < 0 ? args.length : dash); i++) {
    const token = args[i];
    if (token.startsWith('-')) {
      if (!token.includes('=') && VALUE_OPTIONS.has(token)) i += 1;
      continue;
    }
    if (NON_INTERACTIVE.has(token)) return cmd;
    break;
  }
  if (dash < 0) return `${cmd.trimEnd()} ${INLINE_FLAG}`;
  // 원문 인용을 보존하려고 글자 자리에 끼운 뒤, 낱말 분해 결과가 '`--` 바로 앞에 플래그 하나'인지 확인한다. 아니면 그대로 둔다.
  const at = cmd.search(/(^|\s)--(?=\s|$)/);
  if (at < 0) return cmd;
  const cut = at + (/\s/.test(cmd[at]) ? 1 : 0);
  const next = `${cmd.slice(0, cut)}${INLINE_FLAG} ${cmd.slice(cut)}`;
  const expected = [...words.slice(0, head + 1 + dash), INLINE_FLAG, ...words.slice(head + 1 + dash)];
  const got = commandWords(next);
  return got && got.length === expected.length && got.every((word, i) => word === expected[i]) ? next : cmd;
}

// 옛 세션(플래그 도입 전에 뜬 명령)과 지금 기본값을 견줄 때 쓴다. 플래그만 다른 것은 다른 명령이 아니다.
// 셸 낱말 단위로 견준다(따옴표 안 공백 차이는 다른 명령). 낱말로 못 나누는 명령은 원문 그대로 견준다.
export function withoutInlineScreen(cmd) {
  const words = commandWords(cmd);
  return words ? JSON.stringify(words.filter(word => word !== INLINE_FLAG)) : cmd;
}

// claude-code 2.1.302: 풀스크린(alternate screen)은 환경 변수 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN(참이면 끔)·
// CLAUDE_CODE_NO_FLICKER=0, 또는 설정 tui:"default"로 끈다(설치 묶음의 문자열·판정 코드로 확인, 2026-10-18; 실제 화면 실측은 못 했다).
// 명령 문자열을 바꾸면 신원 대조·재시작 해석이 흔들려, 창을 만들 때 tmux 환경으로만 넣는다. 사용자 전역 설정 파일은 고치지 않는다.
export const CLAUDE_INLINE_ENV = 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1';
export const inlineScreenEnv = cmd => launchIdentityOf(cmd).harness === 'claude' ? [CLAUDE_INLINE_ENV] : [];
