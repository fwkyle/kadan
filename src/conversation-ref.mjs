// Why: 같은 대화를 다시 여는 start(resume)와 새 대화를 여는 start(new·fork)를 가르려면 명령에서 대화 정보를 읽어야 한다.
// harness·model을 cmd에서 읽는 것(cli-start-support.mjs describeStartCmd)과 같은 일반 파싱이다. 실행기 어댑터나 대화 파일 읽기는 없다.
// 셸 인자 경계는 ai-identity.mjs commandWords가 지킨다(따옴표 안 입력은 한 낱말). 옵션 자리의 낱말만 보고,
// 판단할 수 없는 명령(셸 연산·모르는 옵션)은 new다 — 그 경우 같은 대화를 resume한 우편이 이전 세대로 숨을 수 있다.
import {commandWords, normalizeAiCommand} from './ai-identity.mjs';

// codex 0.155.0 `codex --help`·`codex resume --help`의 값을 받는 옵션(2026-10-13 실측). -i/--image는 값을 여러 개 받아
// 하위 명령 낱말을 삼킬 수 있어 목록에 넣지 않는다(만나면 판단 불가 → new).
export const CODEX_VALUE_OPTIONS = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);
export const CODEX_FLAG_OPTIONS = new Set(['--strict-config', '--oss', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust', '--worktree', '--search', '--no-alt-screen']);
// claude 2.1.296 `claude --help`에서 값이 꼭 있는 옵션(<값>)이다(2026-10-13 실측). 값은 건너뛰어 그 낱말을 옵션으로 읽지 않는다.
// 값이 선택인 옵션([값]: --resume·--debug·--worktree 등)과 목록 밖 옵션은 값 없는 옵션으로 본다.
export const CLAUDE_VALUE_OPTIONS = new Set(['--add-dir', '--agent', '--agents', '--allowedTools', '--allowed-tools', '--append-system-prompt',
  '--autocompact', '--betas', '--debug-file', '--disallowedTools', '--disallowed-tools', '--effort', '--environment', '--fallback-model',
  '--file', '--input-format', '--json-schema', '--max-budget-usd', '--mcp-config', '--model', '-n', '--name', '--output-format',
  '--permission-mode', '--permission-prompts', '--plugin-dir', '--plugin-url', '--remote-control-session-name-prefix', '--session-id',
  '--setting-sources', '--settings', '--system-prompt', '--system-prompt-snapshot', '--tools']);
const NEW = {conversationMode: 'new'};

function claudeConversation(args, sink) {
  let ref = null, fork = false, cont = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') break;
    const inline = token.match(/^(?:--resume|-r)=(.+)$/);
    if (inline) { ref = inline[1]; sink?.push({at: i, length: 1, kind: 'inline'}); }
    else if ((token === '--resume' || token === '-r') && args[i + 1] && !args[i + 1].startsWith('-')) {
      sink?.push({at: i, length: 2, kind: 'pair', flag: token}); ref = args[++i];
    } else if (token === '--resume' || token === '-r') sink?.push({at: i, length: 1, kind: 'bare'});
    else if (CLAUDE_VALUE_OPTIONS.has(token.split('=')[0]) && token.startsWith('--') || CLAUDE_VALUE_OPTIONS.has(token)) {
      if (!token.includes('=')) i += 1; // --opt=값은 한 낱말, --opt 값은 다음 낱말까지 건너뛴다.
    } else if (token === '--fork-session') { fork = true; sink?.push({at: i, length: 1, kind: 'fork'}); }
    else if (token === '--continue' || token === '-c') { cont = true; sink?.push({at: i, length: 1, kind: 'continue'}); } // 이 폴더의 가장 최근 대화를 이어 연다(대화 ID 없음)
  }
  if (!ref && !cont) return NEW;
  return {conversationMode: fork ? 'fork' : 'resume', ...(ref ? {conversationRef: ref} : {})};
}

function codexConversation(args, sink) {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === 'resume' || token === 'fork') {
      const ref = args[i + 1];
      sink?.push({at: i, length: ref && !ref.startsWith('-') ? 2 : 1, kind: ref && !ref.startsWith('-') ? 'pair' : 'bare', flag: token});
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

// agy 1.3.5 `agy --help`: `--conversation <ID>`(ID로 이어 열기)·`-c/--continue`(가장 최근). fork 옵션은 도움말에 없다(2026-10-14 실측).
// devin 3000.11.3 `devin --help`: `-r/--resume [<ID>]`·`-c/--continue`. fork는 확인하지 못했다.
// 두 실행기는 값을 받는 옵션을 건너뛰는 목록이 없다 — 옵션 값이 정확히 `--conversation`/`--resume` 낱말이면 잘못 읽는다(따옴표 안 입력은 한 낱말이라 안전).
function plainResume(args, {flags, continueFlags}, sink) {
  let ref = null, cont = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') break;
    const eq = token.indexOf('=');
    const name = eq > 0 && token.startsWith('--') ? token.slice(0, eq) : token;
    if (flags.includes(name)) {
      if (eq > 0 && token.startsWith('--')) { ref = token.slice(eq + 1); sink?.push({at: i, length: 1, kind: 'inline'}); }
      else if (args[i + 1] && !args[i + 1].startsWith('-')) { sink?.push({at: i, length: 2, kind: 'pair', flag: token}); ref = args[++i]; }
      else sink?.push({at: i, length: 1, kind: 'bare'});
    } else if (continueFlags.includes(token)) { cont = true; sink?.push({at: i, length: 1, kind: 'continue'}); }
  }
  if (!ref && !cont) return NEW;
  return {conversationMode: 'resume', ...(ref ? {conversationRef: ref} : {})};
}

function resolve(cmd, sink) {
  const normalized = normalizeAiCommand(cmd);
  if (!normalized) return NEW;
  const {harness, args} = normalized;
  if (harness === 'claude') return claudeConversation(args, sink);
  if (harness === 'codex') return codexConversation(args, sink);
  if (harness === 'agy') return plainResume(args, {flags: ['--conversation'], continueFlags: ['--continue', '-c']}, sink);
  if (harness === 'devin') return plainResume(args, {flags: ['--resume', '-r'], continueFlags: ['--continue', '-c']}, sink);
  return NEW;
}

export function conversationOf(cmd) { return resolve(cmd); }

// 같은 해석기가 대화 지정으로 본 낱말 자리들. at은 실행기 이름 뒤 낱말(args) 기준 위치, offset은 args 앞 낱말 수다.
// kind: pair(플래그+값 두 낱말)·inline(--flag=값)·bare(값 없는 플래그)·fork·continue. 옵션 값 안의 낱말은 해석기가 건너뛰므로 나오지 않는다.
export function conversationDesignations(cmd) {
  const normalized = normalizeAiCommand(cmd);
  const words = commandWords(typeof cmd === 'string' ? cmd.trim() : cmd);
  const items = [];
  resolve(cmd, items);
  return {offset: normalized && words ? words.length - normalized.args.length : 0, items};
}

// 첫 안내(start-brief)용 확신 판정: 'new' | 'fork' | 'resume' | 'unknown'.
// conversationOf는 판단할 수 없는 명령을 new로 돌려준다(우편 세대 계약). 안내는 그러면 안 된다 — 이미 안내받은 대화에 다시 들어간다.
// '새 대화로 확실함'은 알려진 실행기이고, 모든 낱말이 이 표의 알려진 무해 옵션(--model·--effort·-c 설정 등과 그 값)뿐일 때다.
// 모르는 옵션·하위 명령(resume 포함)·첫 프롬프트·`--`가 하나라도 있으면 unknown이라 보내지 않는다.
const CERTAIN_NEW = {
  codex: {value: CODEX_VALUE_OPTIONS, flag: CODEX_FLAG_OPTIONS},
  claude: {value: CLAUDE_VALUE_OPTIONS, flag: new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose', '--strict-mcp-config'])},
  agy: {value: new Set(['--model']), flag: new Set(['--dangerously-skip-permissions'])},
  devin: {value: new Set(['--model', '--permission-mode', '--respect-workspace-trust']), flag: new Set()},
};

// 같은 표로 실행기 이름 뒤 낱말을 처음부터 끝까지 걷는다(restart --model-from-settings가 옵션과 값을 가르는 데 쓴다).
// 성공: {ok: true, harness, options: [{at, name, valueAt, inline}]} — at·valueAt은 명령 전체 낱말 기준 위치다.
//   `--opt 값`은 valueAt이 값 낱말 위치(값 낱말이 없으면 null), `--opt=값`은 inline true이고 valueAt은 null, 값 없는 옵션은 valueAt null.
// 실패: {ok: false, word, reason} — 표가 없는 실행기, 표에 없는 옵션, 옵션 자리가 아닌 맨 낱말(하위 명령·첫 프롬프트), `--`.
// 대화 지정(--resume 등)은 표에 없어 실패한다. 부르는 쪽이 대화 꼬리를 먼저 뗀다.
export function walkKnownOptions(cmd) {
  const normalized = normalizeAiCommand(cmd);
  const spec = normalized && CERTAIN_NEW[normalized.harness];
  if (!spec) return {ok: false, word: normalized?.harness ?? null, reason: 'unknown-runner'};
  const words = commandWords(typeof cmd === 'string' ? cmd.trim() : cmd), args = normalized.args;
  const offset = words.length - args.length, options = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') return {ok: false, word: token, reason: 'double-dash'};
    if (!token.startsWith('-')) return {ok: false, word: token, reason: 'bare-word'};
    const long = token.startsWith('--'), eq = token.indexOf('=');
    const inline = long && eq > 0, name = inline ? token.slice(0, eq) : token;
    if (spec.value.has(name)) {
      options.push({at: offset + i, name, valueAt: inline || i + 1 >= args.length ? null : offset + i + 1, inline});
      if (!inline) i += 1;
      continue;
    }
    if (spec.flag.has(name) && !inline) { options.push({at: offset + i, name, valueAt: null, inline: false}); continue; }
    return {ok: false, word: token, reason: 'unknown-option'};
  }
  return {ok: true, harness: normalized.harness, options};
}

export function startConversationCertainty(cmd) {
  const normalized = normalizeAiCommand(cmd);
  const spec = normalized && CERTAIN_NEW[normalized.harness];
  if (!spec) return 'unknown';
  const mode = conversationOf(cmd).conversationMode;
  if (mode === 'resume' || mode === 'fork') return mode;
  return walkKnownOptions(cmd).ok ? 'new' : 'unknown';
}
