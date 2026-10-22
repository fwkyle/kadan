// Why: 비서 복원 명령은 재시작마다 대화의 마지막 --model·-c를 덧붙여 같은 키가 쌓였고, codex는
// `--model cannot be used multiple times`로 바로 끝났다(2026-10-22 재부팅 뒤 비서 복원 실패).
// 규칙: 키(--model·-m 하나, -c/--config는 `k=v`의 k)마다 처음 나온 것 하나만 남긴다.
// 시작 명령을 먼저 쓰므로 시작 명령이 이기고, 대화의 옵션은 빈 키만 채운다. 다른 낱말은 순서 그대로 둔다.
import {commandWords} from './ai-identity.mjs';
import {shellQuote} from './stop-hook-settings.mjs';


// 낱말 목록을 commandWords가 같은 낱말로 되읽는 명령 문자열로 만든다. 되읽기가 어긋나거나 안전하게 인용할
// 수 없으면 null이다(호출자가 원문을 두거나 저장을 멈춘다). `--`만 인용하지 않는다(withInlineScreen이 인용 안 한 `--`만 찾는다). `'\\''` 이스케이프는 commandWords가 거절하므로 쓰지 않는다.
export function serializeWords(words) {
  const parts = words.map(word => word === '--' ? word : shellQuote(word));
  if (parts.some(part => part === null)) return null;
  const text = parts.join(' ');
  const back = commandWords(text);
  return back && back.length === words.length && back.every((word, i) => word === words[i]) ? text : null;
}

// 반환: {key, take}. 중복을 가릴 옵션이 아니면 null. take = 이 옵션이 차지하는 낱말 수.
function optionKey(args, i) {
  const token = args[i];
  if (token === '--model' || token === '-m') return {key: 'model', take: 2};
  if (token.startsWith('--model=')) return {key: 'model', take: 1};
  if (token === '-c' || token === '--config') {
    return {key: `c:${String(args[i + 1] ?? '').split('=')[0]}`, take: 2};
  }
  if (token.startsWith('--config=')) return {key: `c:${token.slice(9).split('=')[0]}`, take: 1};
  return null;
}

function dedupe(args) {
  const seen = new Set(), out = [];
  for (let i = 0; i < args.length;) {
    const found = optionKey(args, i);
    if (!found) { out.push(args[i]); i += 1; continue; }
    if (!seen.has(found.key)) { seen.add(found.key); out.push(...args.slice(i, i + found.take)); }
    i += found.take;
  }
  return out;
}

// startArgs 뒤에 transcriptArgs를 이어 키 단위로 하나만 남긴다. `--` 뒤(프롬프트)는 손대지 않고 끝에 둔다.
export function mergeCodexOptions(startArgs, transcriptArgs = []) {
  const dash = startArgs.indexOf('--');
  const head = dash < 0 ? startArgs : startArgs.slice(0, dash);
  return [...dedupe([...head, ...transcriptArgs]), ...(dash < 0 ? [] : startArgs.slice(dash))];
}

// `codex resume <ID> …` 명령 문자열의 중복 옵션을 걷어 낸다. 읽을 수 없거나 resume 꼴이 아니면 그대로 돌려준다.
export function dedupeResumeCommand(cmd) {
  const words = commandWords(cmd);
  if (!words || words[1] !== 'resume' || words.length < 3) return cmd;
  return serializeWords([...words.slice(0, 3), ...mergeCodexOptions(words.slice(3))]) ?? cmd;
}
