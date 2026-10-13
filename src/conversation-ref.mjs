// Why: 같은 대화를 다시 여는 start(resume)와 새 대화를 여는 start(new·fork)를 가르려면 명령에서 대화 정보를 읽어야 한다.
// harness·model을 cmd에서 읽는 것(cli-start-support.mjs describeStartCmd)과 같은 일반 파싱이다. 실행기 어댑터나 대화 파일 읽기는 없다.
// 셸 인자 경계는 ai-identity.mjs commandWords가 지킨다(따옴표 안 입력은 한 낱말). 옵션 자리의 낱말만 보고,
// 판단할 수 없는 명령(셸 연산·모르는 옵션)은 new다 — 그 경우 같은 대화를 resume한 우편이 이전 세대로 숨을 수 있다.
import {commandWords} from './ai-identity.mjs';

// codex 0.155.0 `codex --help`·`codex resume --help`의 값을 받는 옵션(2026-10-13 실측). -i/--image는 값을 여러 개 받아
// 하위 명령 낱말을 삼킬 수 있어 목록에 넣지 않는다(만나면 판단 불가 → new).
const CODEX_VALUE_OPTIONS = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);
const CODEX_FLAG_OPTIONS = new Set(['--strict-config', '--oss', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust', '--worktree', '--search', '--no-alt-screen']);
const NEW = {conversationMode: 'new'};

function claudeConversation(args) {
  let ref = null, fork = false, cont = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') break;
    const inline = token.match(/^(?:--resume|-r)=(.+)$/);
    if (inline) ref = inline[1];
    else if ((token === '--resume' || token === '-r') && args[i + 1] && !args[i + 1].startsWith('-')) ref = args[++i];
    else if (token === '--fork-session') fork = true;
    else if (token === '--continue' || token === '-c') cont = true; // 이 폴더의 가장 최근 대화를 이어 연다(대화 ID 없음)
  }
  if (!ref && !cont) return NEW;
  return {conversationMode: fork ? 'fork' : 'resume', ...(ref ? {conversationRef: ref} : {})};
}

function codexConversation(args) {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === 'resume' || token === 'fork') {
      const ref = args[i + 1];
      return ref && !ref.startsWith('-') ? {conversationMode: token, conversationRef: ref} : NEW;
    }
    if (!token.startsWith('-')) return NEW; // 다른 하위 명령이거나 첫 프롬프트
    const eq = token.indexOf('=');
    if (eq > 0 && token.startsWith('--') && CODEX_VALUE_OPTIONS.has(token.slice(0, eq))) continue;
    if (CODEX_FLAG_OPTIONS.has(token)) continue;
    if (CODEX_VALUE_OPTIONS.has(token)) { i += 1; continue; }
    return NEW; // 목록에 없는 옵션은 값을 받는지 몰라 판단하지 않는다.
  }
  return NEW;
}

export function conversationOf(cmd) {
  const words = commandWords(typeof cmd === 'string' ? cmd.trim() : cmd);
  if (!words?.length) return NEW;
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  const harness = words[index]?.split('/').pop(), args = words.slice(index + 1);
  if (harness === 'claude') return claudeConversation(args);
  if (harness === 'codex') return codexConversation(args);
  return NEW;
}
