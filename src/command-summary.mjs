// Why: 역할의 시작 명령에는 토큰·환경변수·프롬프트가 실릴 수 있다. 경고·실패 안내·복구 조사 출력에 명령 원문을
// 그대로 싣지 않고 사람이 판단하는 데 필요한 것(실행기·모델·강도, 어떤 옵션이 다른가)만 보여 준다(#435 후속).
//
// 가릴 것을 찾는 방식이 아니라 허용 목록이다. 보이는 것: 실행기·모델·강도, `-`로 시작하는 옵션의 이름(`=` 앞까지,
// `-c`/`--config`는 키까지). 그 밖의 낱말(환경변수 대입, 옵션 값, `--` 뒤 프롬프트, 하위 명령)은 내용 없이 개수만 센다.
// 반쯤 가린 줄을 명령처럼 복사해 칠 수 없도록, 결과는 한국어 라벨이 붙은 요약이며 명령 꼴이 아니다.
import {commandWords, launchIdentityOf} from './ai-identity.mjs';
import {INLINE_FLAG} from './inline-screen.mjs';
import {wordsWithoutStopHook} from './stop-hook-settings.mjs';

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none']);
const EFFORT_FLAGS = new Set(['--effort', '--reasoning-effort']);
const EFFORT_KEY = 'model_reasoning_effort';
const MODEL_FLAGS = new Set(['--model', '-m']);
const CONFIG_FLAGS = new Set(['-c', '--config']);
const OPTION_NAME = /^--?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CONFIG_KEY = /^[A-Za-z0-9_.-]+$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// 명령 하나를 허용 목록 요약으로 바꾼다. others는 내용을 내보내지 않는 내부 값이다(차이 개수를 세는 데만 쓴다).
export function summarizeCommand(cmd) {
  const all = commandWords(cmd);
  // 카단이 스스로 붙이는 화면 고정·Stop 훅 설정 낱말은 요약에서 뺀다(옛 세션과 견줄 때 가짜 차이가 된다).
  const words = all ? wordsWithoutStopHook(all.filter(word => word !== INLINE_FLAG)) : null;
  if (!words) return {ok: false, reason: 'unsafe-command', harness: null, model: null, effort: null, names: [], others: []};
  const identity = launchIdentityOf(cmd);
  const summary = {ok: identity.ok, harness: identity.harness ?? null, model: identity.model ?? null,
    effort: null, names: [], others: []};
  if (!identity.ok) summary.reason = identity.reason;
  while (words.length && ENV_ASSIGNMENT.test(words[0])) summary.others.push(words.shift());
  words.shift(); // 실행 파일 — 실행기 이름은 위 identity가 등록 이름으로만 보여 준다
  const setEffort = value => {
    // `-c 'model_reasoning_effort="high"'`처럼 셸 인용이 TOML 따옴표를 그대로 남기는 꼴도 있다
    const bare = value == null ? null : String(value).replace(/^(["'])(.*)\1$/, '$2');
    if (bare != null && EFFORTS.has(bare.toLowerCase())) summary.effort = bare.toLowerCase();
    else if (value != null) summary.others.push(String(value));
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === '--') { summary.others.push(...words.slice(i + 1)); break; }
    if (!word.startsWith('-')) { summary.others.push(word); continue; }
    const eq = word.indexOf('=');
    const name = eq < 0 ? word : word.slice(0, eq);
    const inline = eq < 0 ? null : word.slice(eq + 1);
    const takeValue = () => inline ?? (words[i + 1] !== undefined ? words[++i] : null);
    if (MODEL_FLAGS.has(name)) { takeValue(); continue; }
    if (EFFORT_FLAGS.has(name)) { setEffort(takeValue()); continue; }
    if (CONFIG_FLAGS.has(name)) {
      const pair = takeValue();
      if (pair === null) { summary.names.push(name); continue; }
      const at = pair.indexOf('=');
      const key = at < 0 ? pair : pair.slice(0, at);
      if (key === EFFORT_KEY && at >= 0) { setEffort(pair.slice(at + 1)); continue; }
      if (!CONFIG_KEY.test(key)) { summary.others.push(pair); continue; }
      summary.names.push(`${name} ${key}`);
      if (at >= 0) summary.others.push(pair.slice(at + 1));
      continue;
    }
    if (!OPTION_NAME.test(name)) { summary.others.push(word); continue; }
    summary.names.push(name);
    if (inline !== null) summary.others.push(inline);
  }
  return summary;
}

// 사람이 읽는 한 줄 요약. 명령으로 칠 수 없는 모양(라벨·쉼표·개수)으로만 낸다.
export function describeCommand(cmd) {
  const s = typeof cmd === 'string' ? summarizeCommand(cmd) : {ok: false, harness: null, names: [], others: []};
  if (!s.harness && !s.ok) return '시작 명령을 읽지 못함(내용은 표시하지 않음)';
  const parts = [`실행기 ${s.harness}`, s.model ? `모델 ${s.model}` : '모델 모름', `강도 ${s.effort ?? '없음'}`];
  if (s.names.length) parts.push(`옵션 이름 ${s.names.join(', ')}`);
  if (s.others.length) parts.push(`그 밖 낱말·값 ${s.others.length}개(내용은 표시하지 않음)`);
  return parts.join(' · ');
}

const countOf = items => items.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map());
// a에는 있고 b에는 없는 항목(중복은 개수만큼). 내용은 돌려주되 호출자가 이름만 쓰고 others는 개수만 쓴다.
function onlyIn(a, b) {
  const rest = countOf(b), out = [];
  for (const item of a) {
    if (rest.get(item) > 0) rest.set(item, rest.get(item) - 1);
    else out.push(item);
  }
  return out;
}

// 두 명령의 다른 점만 말한다: 강도, 한쪽에만 있는 옵션 이름, 그 밖 낱말·값의 다른 개수.
export function describeCommandDiff(sessionCmd, expectedCmd) {
  const session = summarizeCommand(sessionCmd), expected = summarizeCommand(expectedCmd);
  if (!session.ok || !expected.ok) return '시작 명령을 읽지 못해 다른 점을 말할 수 없다(내용은 표시하지 않음)';
  const parts = [];
  if (session.effort !== expected.effort) parts.push(`강도 세션 ${session.effort ?? '없음'} ↔ 기본값 ${expected.effort ?? '없음'}`);
  const sessionOnly = onlyIn(session.names, expected.names), expectedOnly = onlyIn(expected.names, session.names);
  if (sessionOnly.length) parts.push(`세션에만 있는 옵션 이름 ${sessionOnly.join(', ')}`);
  if (expectedOnly.length) parts.push(`기본값에만 있는 옵션 이름 ${expectedOnly.join(', ')}`);
  const otherDiff = onlyIn(session.others, expected.others).length + onlyIn(expected.others, session.others).length;
  if (otherDiff) parts.push(`그 밖 낱말·값 ${otherDiff}개 다름(내용은 표시하지 않음)`);
  return parts.length ? parts.join(' · ') : '표시할 수 있는 차이 없음(낱말 순서·따옴표 등 — 내용은 표시하지 않음)';
}

// 다른 곳이 던진 오류 문구에 명령 원문이 섞여 있으면 그 자리를 지운다. 명령 전체와, 값이 붙은 낱말(`KEY=값`, `--옵션=값`)을 지운다.
export function withoutCommands(text, ...commands) {
  let out = String(text ?? '');
  const secrets = new Set();
  for (const cmd of commands) {
    if (typeof cmd !== 'string' || !cmd.trim()) continue;
    secrets.add(cmd);
    const words = commandWords(cmd) ?? [], dash = words.indexOf('--');
    words.forEach((word, i) => {
      // 값이 붙은 낱말(`KEY=값`, `--옵션=값`)과 `--` 뒤 프롬프트. 너무 짧은 낱말은 일반 문구를 망가뜨려 건너뛴다.
      if (word.length > 3 && (word.includes('=') || (dash >= 0 && i > dash))) secrets.add(word);
    });
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join('(시작 명령 생략)');
  return out;
}
