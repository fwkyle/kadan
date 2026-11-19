// Why: 비서 복원 명령은 재시작마다 대화의 마지막 --model·-c를 덧붙여 같은 키가 쌓였고, codex는
// `--model cannot be used multiple times`로 바로 끝났다(2026-10-22 재부팅 뒤 비서 복원 실패).
// 규칙: 키(--model·-m 하나, -c/--config는 `k=v`의 k)마다 처음 나온 것 하나만 남긴다.
// 시작 명령을 먼저 쓰므로 시작 명령이 이기고, 대화의 옵션은 빈 키만 채운다. 다른 낱말은 순서 그대로 둔다.
import {commandWords} from './ai-identity.mjs';

// commandWords 문법에 맞춘 인용: 작은따옴표가 아닌 구간은 '…', 작은따옴표 하나는 "'"로 쓰고 이어 붙인다.
// 예: Don't → 'Don'"'"'t'. 줄바꿈이 든 낱말만 null(commandWords도 읽지 못한다).
export function quoteWord(word) {
  const text = String(word);
  if (/[\n\r]/.test(text)) return null;
  return text.split("'").map(part => `'${part}'`).join(`"'"`);
}

// 낱말 목록을 commandWords가 같은 낱말로 되읽는 명령 문자열로 만든다. 되읽기가 어긋나면 null이다(마지막 울타리).
// `--`만 인용하지 않는다(withInlineScreen이 인용 안 한 `--`만 찾는다).
export function serializeWords(words) {
  const parts = words.map(word => word === '--' ? word : quoteWord(word));
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

const EFFORT_KEY = 'model_reasoning_effort';
const unquote = value => value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
// 값이 든 낱말의 자리(at)와 그 낱말에서 값 앞에 붙는 글자(prefix). 한 낱말 꼴은 `--model=값`·`--config=키=값`이다.
function valueSlot(head, i, take, slot) {
  const at = i + take - 1, word = head[at];
  const prefix = slot === 'model' ? (take === 1 ? '--model=' : '') : `${take === 1 ? '--config=' : ''}${EFFORT_KEY}=`;
  return word.startsWith(prefix) ? {at, prefix, value: word.slice(prefix.length)} : null;
}

// 모델과 추론 강도 두 키의 **값만** 바꾼다(비서를 다시 열 때 실행 모델 설정값을 입힌다 — secretary-settings.mjs).
// 키 판정은 위 중복 걷기(optionKey)와 같다. 다른 낱말·순서는 그대로 두고 `--` 뒤(프롬프트)는 손대지 않는다.
// - 값이 이미 같으면 그 낱말을 건드리지 않는다. 강도는 따옴표를 벗긴 값으로 비교한다.
// - 키가 없으면 `--` 앞 끝에 한 번 넣는다. effort가 없으면(null) 강도는 보지도 바꾸지도 않는다.
// - 읽지 못하는 꼴이면 null이다: 같은 키가 둘 이상, 값 낱말이 없음, 붙여 쓴 짧은 옵션(`-m값`·`-c값`), `-c model=…`.
//   이런 명령에 덧붙이면 같은 옵션이 둘이 되어 실행기가 바로 끝난다.
// 반환: {args, changed, previous: {model, effort}(없었으면 null), rest(두 키를 뺀 나머지 낱말 — 호출자의 대조용)}
export function replaceModelOptions(args, {model, effort = null}) {
  const dash = args.indexOf('--');
  const head = dash < 0 ? [...args] : args.slice(0, dash), tail = dash < 0 ? [] : args.slice(dash);
  const found = {model: null, effort: null}, rest = [];
  for (let i = 0; i < head.length;) {
    const token = head[i], option = optionKey(head, i);
    if (!option) {
      if (/^-[mc]./.test(token)) return null;
      rest.push(token); i += 1; continue;
    }
    if (option.take === 2 && i + 1 >= head.length) return null;
    const slot = option.key === 'model' ? 'model' : option.key === `c:${EFFORT_KEY}` ? 'effort' : null;
    if (option.key === 'c:model') return null;
    if (!slot) { rest.push(...head.slice(i, i + option.take)); i += option.take; continue; }
    if (found[slot]) return null;
    found[slot] = valueSlot(head, i, option.take, slot);
    if (!found[slot]) return null;
    i += option.take;
  }
  const previous = {model: found.model?.value ?? null, effort: found.effort ? unquote(found.effort.value) : null};
  const next = [...head];
  let changed = false;
  if (previous.model !== model) {
    changed = true;
    if (found.model) next[found.model.at] = found.model.prefix + model; else next.push('--model', model);
  }
  if (effort != null && previous.effort !== effort) {
    changed = true;
    const value = JSON.stringify(effort);
    if (found.effort) next[found.effort.at] = found.effort.prefix + value; else next.push('-c', `${EFFORT_KEY}=${value}`);
  }
  return {args: [...next, ...tail], changed, previous, rest: [...rest, ...tail]};
}

// `codex resume <ID> …` 명령 문자열의 중복 옵션을 걷어 낸다. 읽을 수 없거나 resume 꼴이 아니면 그대로 돌려준다.
export function dedupeResumeCommand(cmd) {
  const words = commandWords(cmd);
  if (!words || words[1] !== 'resume' || words.length < 3) return cmd;
  return serializeWords([...words.slice(0, 3), ...mergeCodexOptions(words.slice(3))]) ?? cmd;
}
