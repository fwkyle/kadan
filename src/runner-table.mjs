// Why: 실행기마다 다른 "같은 대화 다시 열기·대화 ID 찾기·한 번 호출" 지식을 runner-settings.json의
// runners.<실행기> 표(데이터) 한 곳에 두고, 코드는 실행기 이름을 모른 채 표를 읽는다(2026-10-14 [kyle]).
// 코드에는 틀 채우기 한 곳과 대화 ID 찾기 일반 함수 둘(open-file·pid-json)뿐이다. 빈 칸이면 미지원으로 거절한다.
// 실행기 출력 해석이나 실행기 이름 분기는 여기에 두지 않는다(CLAUDE.md "다중 provider 어댑터 금지").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {commandWords} from './ai-identity.mjs';
import {conversationOf, conversationDesignations} from './conversation-ref.mjs';
import {INLINE_FLAG} from './inline-screen.mjs';

// listModels: 실행기가 자기 모델 목록을 내는 명령 틀(자리 없음). 화면의 '목록 불러오기'를 누를 때만 실행한다.
// 이름이 models가 아닌 이유: runners.<실행기>.models는 이미 등록된 모델·강도 목록이다.
export const TABLE_KEYS = ['resume', 'fork', 'exec', 'execField', 'version', 'update', 'listModels'];
// 실행기·모델·강도 이름에 쓸 수 있는 글자(영문·숫자·./-[]).
export const NAME_PATTERN = /^[A-Za-z0-9._/\-[\]]+$/;
export const CONVERSATION_KINDS = ['open-file', 'pid-json'];
// 셸 문자열에 끼워 넣을 대화 ID는 좁은 글자만 허용한다.
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENTINEL = {model: 'KADANMODEL', effort: 'KADANEFFORT', conversation: 'KADANCONVERSATION'};
const unsupported = (runner, key) => new Error(`이 실행기(${runner})는 ${key} 미지원 — runner-settings.json의 runners.${runner}.${key} 칸이 비어 있다`);

// 표에서 틀 하나를 꺼낸다. 비었으면 미지원.
export function runnerTemplate(settings, runner, key) {
  const value = settings?.runners?.[runner]?.[key];
  if (typeof value !== 'string' || !value.trim()) throw unsupported(runner, key);
  return value;
}

// {model}·{effort}·{conversation}·{prompt}·{cwd} 자리를 한 번에 채운다. 값이 없는 자리는 만들지 않고 거절한다(effort만 빈 글).
// 함수로 대입하므로 값 안의 `$&`·`$`` 같은 글자가 치환 문법으로 읽히지 않고, 채운 값 안의 `{cwd}` 같은 글자는 다시 채우지 않는다.
export function fillTemplate(template, values) {
  return template.replace(/\{(effort|model|conversation|prompt|cwd)\}/g, (_, key) => {
    if (key === 'effort') return values.effort ?? '';
    if (values[key] == null || values[key] === '') throw new Error(`틀의 {${key}} 자리에 넣을 값이 없다`);
    return values[key];
  });
}

// 카드 글(prompt)은 명령 문자열에 글자로 끼워 넣지 않는다. 따옴표 처리로 막는 방식은 틀 작성자가 "{prompt}"처럼 쓰면 깨진다.
// {prompt} 자리에는 셸 변수 참조만 넣고 글 자체는 그 프로세스의 환경변수로 넘긴다. 셸은 변수 값을 다시 해석하지 않는다.
export const EXEC_PROMPT_ENV = 'KADAN_EXPLAIN_PROMPT';
// 저장 검사: {prompt}는 앞뒤가 공백(또는 처음·끝)인 독립 낱말일 때만 받는다. 따옴표나 다른 글자에 붙으면 거절한다.
export function checkExecTemplate(template) {
  const total = template.split('{prompt}').length - 1;
  const alone = [...template.matchAll(/(?<=^|\s)\{prompt\}(?=\s|$)/g)].length;
  if (total !== alone) throw new Error('exec 틀의 {prompt}는 앞뒤가 공백인 독립 낱말이어야 한다(따옴표·다른 글자에 붙이지 않는다) — 글은 환경변수로 넘기므로 틀이 따옴표를 칠 필요가 없다');
}

// 한 번 호출(exec) 틀: {prompt}가 있으면 "$KADAN_EXPLAIN_PROMPT"로 채우고 글은 env로, 없으면 표준 입력으로 보낸다. 글이 명령줄(ps)에 나오지 않는다(환경변수는 같은 사용자의 `ps eww`에는 보일 수 있다).
// execField 칸이 있으면 표준 출력 JSON에서 그 필드가 답이고, 없으면 표준 출력 전체가 답이다(실행기마다 다른 출력 모양을 코드가 모르게).
export function execCommand(settings, runner, {model, effort, prompt, cwd}) {
  const template = runnerTemplate(settings, runner, 'exec');
  checkExecTemplate(template);
  const inArgs = template.includes('{prompt}');
  const text = String(prompt ?? '').replaceAll('\0', '');
  const command = fillTemplate(template, {model, effort, cwd, prompt: inArgs ? `"$${EXEC_PROMPT_ENV}"` : undefined});
  return {command, stdin: inArgs ? '' : text, env: inArgs ? {[EXEC_PROMPT_ENV]: text} : {}, field: settings.runners[runner].execField || null};
}

const shellWord = word => /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;

// resume(또는 fork) 틀 = spawn 틀 + 뒤에 붙는 대화 인자. 그 꼬리(낱말 목록)를 돌려준다. 이 모양이 아니면 거절.
export const resumeTail = (settings, runner) => tailOf(settings, runner, 'resume');
export function tailOf(settings, runner, key) {
  const resume = runnerTemplate(settings, runner, key);
  const sentinel = template => commandWords(fillTemplate(template, {model: SENTINEL.model, effort: SENTINEL.effort,
    conversation: SENTINEL.conversation, prompt: 'P', cwd: '/'}));
  const spawnWords = sentinel(settings.runners[runner].spawn), resumeWords = sentinel(resume);
  if (!spawnWords || !resumeWords || resumeWords.length <= spawnWords.length
    || spawnWords.some((word, i) => resumeWords[i] !== word)) {
    throw new Error(`${runner}.${key} 틀은 spawn 틀 뒤에 대화 인자를 붙인 모양이어야 한다`);
  }
  const tail = resumeWords.slice(spawnWords.length);
  if (tail.filter(word => word.includes(SENTINEL.conversation)).length !== 1) {
    throw new Error(`${runner}.${key} 꼬리에는 {conversation}이 정확히 한 번 있어야 한다`);
  }
  return tail;
}

const slotMatches = (word, templateWord) => templateWord.includes(SENTINEL.conversation)
  ? word.length > templateWord.length - SENTINEL.conversation.length
    && word.startsWith(templateWord.slice(0, templateWord.indexOf(SENTINEL.conversation)))
    && word.endsWith(templateWord.slice(templateWord.indexOf(SENTINEL.conversation) + SENTINEL.conversation.length))
  : word === templateWord;

const slotValue = (word, templateWord) => word.slice(templateWord.indexOf(SENTINEL.conversation),
  word.length - (templateWord.length - templateWord.indexOf(SENTINEL.conversation) - SENTINEL.conversation.length));

// 마지막 시작 명령에서 대화 인자만 바꿔 다시 연다: 꼬리가 이미 붙어 있으면(이전 restart) 떼고, 새 ID로 붙인다.
// 대화를 가리키는 다른 인자(fork·--continue 등)가 남으면 같은 대화를 보장할 수 없어 거절한다.
export function rebuildResumeCommand(settings, runner, oldCmd, conversation) {
  if (!CONVERSATION_ID.test(String(conversation))) throw new Error('대화 ID 형식이 안전하지 않다');
  const tail = resumeTail(settings, runner);
  // 카단이 붙인 --no-alt-screen은 꼬리 비교 앞에서 떼고, 호출자가 다시 붙인다(inline-screen.mjs).
  const words = commandWords(typeof oldCmd === 'string' ? oldCmd.trim() : oldCmd)?.filter(word => word !== INLINE_FLAG);
  if (!words?.length) throw new Error('마지막 시작 명령을 읽을 수 없다(셸 결합·주석·확장이 있다)');
  // 이전 restart·서버 복원이 붙인 resume 꼬리는 명령 어디에 있든, 판정 해석기(conversation-ref)가 대화 지정으로 본 자리가
  // 정확히 하나이고 표의 꼬리와 같은 모양이면 떼고, 현재 대화의 resume 꼬리를 끝에 붙인다. 옵션 값 안의 낱말은 해석기가 건너뛴다.
  // 대화 ID 자리는 CONVERSATION_ID를 통과해야 한다. 갈라 연(fork) 꼬리는 끝에 있을 때만 뗀다.
  const reject = why => { throw new Error(`마지막 시작 명령에 대화 지정(resume·fork·continue)이 ${why} — 같은 대화를 보장할 수 없다`); };
  const fits = (at, candidate) => at >= 0 && at + candidate.length <= words.length
    && candidate.every((word, i) => slotMatches(words[at + i], word)
      && (!word.includes(SENTINEL.conversation) || CONVERSATION_ID.test(slotValue(words[at + i], word))));
  const {offset, items} = conversationDesignations(words.map(shellWord).join(' '));
  const slot = item => offset + item.at;
  let base = words;
  const fork = settings.runners[runner].fork ? tailOf(settings, runner, 'fork') : null;
  const forkAt = fork ? words.length - fork.length : -1;
  if (fork && fits(forkAt, fork) && items.some(item => item.kind === 'pair' && slot(item) === forkAt)) {
    base = words.slice(0, forkAt);
  } else if (items.length > 1) reject('둘 이상 있다');
  else if (items.length === 1) {
    const [item] = items;
    if (item.kind !== 'pair' || !fits(slot(item), tail)) reject('이미 있고 표의 resume 꼬리와 다르다');
    base = [...words.slice(0, slot(item)), ...words.slice(slot(item) + tail.length)];
  }
  if (base.includes('--')) reject('이미 있고 `--` 뒤 입력이 남아 위치를 옮길 수 없다');
  if (conversationOf(base.map(shellWord).join(' ')).conversationMode !== 'new') {
    throw new Error('마지막 시작 명령에 대화 지정(resume·fork·continue)이 이미 있고 표의 resume 꼬리와 다르다 — 같은 대화를 보장할 수 없다');
  }
  const next = [...base, ...tail.map(word => word.replace(SENTINEL.conversation, conversation))];
  const result = next.map(shellWord).join(' ');
  const check = conversationOf(result);
  if (check.conversationMode !== 'resume' || check.conversationRef !== conversation) reject('다시 만든 명령에서 현재 대화로 읽히지 않는다');
  return result;
}

// 모델 목록 명령의 표준 출력: 줄마다 첫 낱말이 모델 id다. 이름 규칙에 맞지 않는 줄·빈 줄·중복은 버린다.
// 나머지 글(탭 뒤 표시 이름 등)은 사람이 보는 이름으로만 돌려준다.
export function parseModelList(stdout) {
  const seen = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const [id, ...rest] = line.trim().split(/\s+/);
    if (id && NAME_PATTERN.test(id) && !seen.has(id)) seen.set(id, rest.join(' '));
  }
  return [...seen].map(([model, name]) => ({model, name}));
}

// ---- 대화 ID 찾기: 일반 함수 둘 ----

export function checkConversationSpec(spec) {
  if (!spec || typeof spec !== 'object' || !CONVERSATION_KINDS.includes(spec.kind))
    throw new Error(`conversation.kind는 ${CONVERSATION_KINDS.join('|')}`);
  if (spec.kind === 'open-file') {
    if (typeof spec.pattern !== 'string') throw new Error('conversation.pattern(정규식 글) 필요');
    if (new RegExp(`${spec.pattern}|`).exec('').length !== 2) throw new Error('conversation.pattern에는 캡처 그룹이 정확히 하나 있어야 한다');
    // evidence: 저장 여부와 무관하게 대화 ID를 드러내는 다른 파일(lock 등)의 정규식들. 서로 다른 ID가 보이면 거절한다.
    for (const extra of spec.evidence ?? [])
      if (typeof extra !== 'string' || new RegExp(`${extra}|`).exec('').length !== 2) throw new Error('conversation.evidence 항목에는 캡처 그룹이 정확히 하나 있어야 한다');
  } else {
    if (typeof spec.path !== 'string' || !spec.path.includes('{pid}')) throw new Error('conversation.path에는 {pid}가 있어야 한다');
    if (typeof spec.field !== 'string' || !spec.field) throw new Error('conversation.field 필요');
    for (const [key, value] of Object.entries(spec.match ?? {}))
      if (typeof value !== 'string') throw new Error(`conversation.match.${key}는 글이어야 한다`);
  }
  if (spec.stored != null && (typeof spec.stored !== 'string' || !spec.stored.includes('{conversation}')))
    throw new Error('conversation.stored에는 {conversation}이 있어야 한다');
  return spec;
}

function expandHome(value, homeDir) {
  return value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value;
}

// 경로 한 칸(세그먼트)에만 `*`를 허용하는 존재 확인.
function existsWithGlob(pattern) {
  let current = ['/'];
  for (const segment of pattern.split('/').filter(Boolean)) {
    const next = [];
    for (const dir of current) {
      if (!segment.includes('*')) { const full = path.join(dir, segment); if (fs.existsSync(full)) next.push(full); continue; }
      const re = new RegExp(`^${segment.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { /* 없는 폴더는 후보 없음 */ }
      for (const name of names) if (re.test(name)) next.push(path.join(dir, name));
    }
    if (!next.length) return false;
    current = next;
  }
  return true;
}

// deps: pids, openFiles(), readJson(경로), processStartedAt(pid)(Unix ms), tmuxLocation, homeDir, exists(패턴)
// 0개·여러 개·형식 불일치는 모두 거절한다. "가장 최근" 같은 추측은 없다.
export function findConversation(spec, deps) {
  checkConversationSpec(spec);
  const homeDir = deps.homeDir ?? os.homedir();
  let id;
  if (spec.kind === 'open-file') {
    const re = new RegExp(spec.pattern);
    const files = deps.openFiles();
    const ids = [...new Set(files.map(file => re.exec(file)?.[1]).filter(Boolean))];
    const seen = new Set(ids);
    for (const extra of spec.evidence ?? []) for (const file of files) { const hit = new RegExp(extra).exec(file)?.[1]; if (hit) seen.add(hit); }
    if (seen.size > 1) throw new Error(`본체 사슬이 서로 다른 대화 ${seen.size}개의 흔적을 열고 있어 하나로 확정할 수 없다`);
    if (ids.length === 0) throw new Error('이 역할이 열어 둔 대화 파일이 없다 — 첫 입력 전이거나 아직 저장되지 않았다');
    if (ids.length > 1) throw new Error(`열린 대화 파일이 ${ids.length}개라 하나로 확정할 수 없다`);
    id = ids[0];
  } else {
    const found = [];
    for (const pid of deps.pids) {
      const file = expandHome(spec.path.replaceAll('{pid}', pid), homeDir);
      let json;
      try { json = deps.readJson(file); } catch { continue; }
      if (json && typeof json === 'object') found.push({file, json, pid});
    }
    if (found.length === 0) throw new Error('이 역할의 프로세스에 묶인 대화 정보 파일이 없다');
    if (found.length > 1) throw new Error(`대화 정보 파일이 ${found.length}개라 하나로 확정할 수 없다`);
    const {json, file, pid} = found[0];
    let startedAt;
    try { startedAt = deps.processStartedAt(pid); }
    catch { throw new Error('프로세스 시작 시각을 확인할 수 없다 — 기존 세션을 끄지 않는다'); }
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      throw new Error('프로세스 시작 시각을 확인할 수 없다 — 기존 세션을 끄지 않는다');
    }
    const mtime = fs.statSync(file).mtimeMs;
    // ps lstart가 초 아래를 버리므로 같은 초는 허용한다. 이전 초의 파일은 재사용 PID의 낡은 파일이다.
    if (!Number.isFinite(mtime) || Math.floor(mtime / 1000) < Math.floor(startedAt / 1000)) {
      throw new Error('낡은 대화 정보 파일이다 — 현재 프로세스가 시작되기 전에 쓰였다');
    }
    for (const [key, template] of Object.entries(spec.match ?? {})) {
      if (!Object.hasOwn(json, key)) continue;
      const expected = template.replaceAll('{tmux}', deps.tmuxLocation ?? '');
      if (typeof json[key] !== 'string' || json[key] !== expected)
        throw new Error(`대화 정보 파일의 ${key} 값이 이 역할의 자리와 다르거나 없다 — 다른 세션의 대화일 수 있다`);
    }
    id = json[spec.field];
    if (typeof id !== 'string') throw new Error(`대화 정보 파일에 ${spec.field} 값이 없다`);
  }
  if (!CONVERSATION_ID.test(id)) throw new Error('찾은 대화 ID 형식이 안전하지 않다');
  if (spec.stored && !(deps.exists ?? existsWithGlob)(expandHome(spec.stored.replaceAll('{conversation}', id), homeDir)))
    throw new Error('다시 열 대화가 아직 저장되지 않았다(첫 입력 전일 수 있다) — 기존 세션을 끄지 않는다');
  return id;
}

// 저장된 대화가 지금도 남아 있는가(꺼진 역할을 다시 열기 전 확인). 표에 stored 칸이 없는 실행기는 확인할 수 없어 null이다.
export function conversationStored(spec, id, {homeDir = os.homedir(), exists = existsWithGlob} = {}) {
  if (!spec?.stored) return null;
  return Boolean(exists(expandHome(spec.stored.replaceAll('{conversation}', id), homeDir)));
}
