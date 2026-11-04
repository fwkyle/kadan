// 저장소별 나이트런 중 자동 머지 정책(PR C1). 자동 단계에서 관문을 통과한 PR을 저장소마다 머지할지 보류할지 정한다.
// 원본은 카단 자체 설정(KADAN_HOME/night-repo-policy.json)이다: 저장소(GitHub `소유자/이름`, 소문자·끝 `.git`·`/` 제거)마다
// `deployBranch`(브랜치 이름 또는 `없음`)와 `nightMerge`(`허용`|`금지`)를 따로 둘 수 있다. 허용 저장소 목록은 두지 않는다(2026-11-02 kyle).
// 문서 원본은 카단 안의 고정 폴더 `$KADAN_HOME/ontology/`다(2026-11-03 kyle): 하위 폴더와 링크를 따라가며 `.md`를 모으고,
// 앞머리 `type: project`인 문서만 판정에 쓴다. 칸마다 카단 설정 값이 있으면 그것이 이기고, 없으면 온톨로지 문서의 값을 쓴다.
// 판정(위에서부터 처음 맞는 것): (가) 카드 쪽이 못 읽히는데 그 칸을 설정이 채우지 않았으면 hold(setup-needed)
//   (나) nightMerge 금지면 hold (다) deployBranch가 비어 있으면 hold(setup-needed) (라) 대상 브랜치 == deployBranch면 hold (마) merge.
// 문서 칸은 정해진 형식만 읽고 설명 글을 정규식으로 해석하지 않는다. 읽지 못하면 setup-needed다.
// 상주 경로가 아니다: 명령·요청 한 번에 폴더를 한 번 훑고(상한 있음) 업무 저장소의 git origin 몇 개를 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {acquireDirLock} from './dir-lock.mjs';

export const POLICY_FILE = 'night-repo-policy.json';
export const NIGHT_MERGE_VALUES = ['허용', '금지'];
export const NO_BRANCH = '없음';
export const CLEAR_FIELDS = ['deployBranch', 'nightMerge'];
const LEGACY_VALUES = ['merge', 'hold', 'auto'];
const LEGACY_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u; // 옛 형식 저장 키(맨 이름)
const BRANCH_WORD = /^(?:없음|[A-Za-z0-9._/-]+)$/;
const GITHUB_KEY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// GitHub `소유자/이름` 키: 소문자로 바꾸고 끝 `.git`·`/`를 뗀다. `/`가 정확히 하나, 양쪽 부분이 비지 않음, 앞 `/` 없음,
// `..`·`.` 부분 없음, 글자는 영문·숫자·`._-`. 올바르지 않으면 null.
export function normalizeGithub(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(/\/+$/, '').replace(/\.git$/, ''); }
  if (!GITHUB_KEY.test(s) || s.includes('..') || s.split('/').some(part => part === '.')) return null;
  return s;
}

export const policyPath = home => path.join(home, POLICY_FILE);

// 사람용 문구(message, CLI에서는 경로 포함)와 HTTP용 문구(httpMessage, 파일 이름과 오류 종류만)를 한 곳에서 나눈다.
export class NightRepoPolicyError extends Error {
  constructor(message, httpMessage = message) { super(message); this.httpMessage = httpMessage; }
}

// night repo HTTP 경로에서 나가는 오류 문구는 여기서 한 곳으로 정한다: httpMessage가 있으면 그것, 없으면 error.message 없이 고정 문구.
export const nightRepoHttpMessage = error =>
  error?.httpMessage ?? `나이트런 저장소 정책 처리 실패(${error?.code ?? '알 수 없음'})`;

const validDeployBranch = v => typeof v === 'string' && BRANCH_WORD.test(v);
const validNightMerge = v => NIGHT_MERGE_VALUES.includes(v);
const fieldOf = (e, name, valid) => (e?.[name] === undefined || e[name] === null ? null : valid(e[name]) ? e[name] : undefined); // undefined = 값이 잘못됨

// 저장 파일(version 2): {version, repos:{<소유자/이름>:{deployBranch?, nightMerge?, at, by}}, legacy:{<키>:{value, at, by}}}.
// 손상은 "읽지 못함"과 같게 다룬다: 읽기는 hold, 쓰기는 거절. 다른 값으로 넘어가지 않는다.
// 옛 파일(version 1, merge|hold 값)은 전부 legacy로 읽는다: 판정에 쓰지 않고 지우지도 않는다. 옛 `auto` 값은 버린다.
const empty = () => ({repos: {}, legacy: {}, rawCards: undefined, corrupt: null});
export function readPolicy(home) {
  const file = policyPath(home);
  if (!fs.existsSync(file)) return empty();
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
    if (!isObj(value) || ![1, 2].includes(value.version) || !isObj(value.repos)) throw new Error('모양이 다름');
    const legacy = {};
    const addLegacy = (key, e) => { if (e.value !== 'auto') legacy[key] = {value: e.value, at: e.at ?? null, by: e.by ?? null}; };
    if (value.version === 1) {
      for (const [key, e] of Object.entries(value.repos)) {
        if (!(key === normalizeGithub(key) || LEGACY_NAME.test(key)) || !LEGACY_VALUES.includes(e?.value)) throw new Error('모양이 다름');
        addLegacy(key, e);
      }
      return {repos: {}, legacy, rawCards: undefined, corrupt: null};
    }
    const repos = {};
    for (const [key, e] of Object.entries(value.repos)) {
      if (key !== normalizeGithub(key) || !isObj(e)) throw new Error('모양이 다름');
      const deployBranch = fieldOf(e, 'deployBranch', validDeployBranch), nightMerge = fieldOf(e, 'nightMerge', validNightMerge);
      if (deployBranch === undefined || nightMerge === undefined) throw new Error('모양이 다름');
      repos[key] = {deployBranch, nightMerge, at: e.at ?? null, by: e.by ?? null};
    }
    if (value.legacy !== undefined) {
      if (!isObj(value.legacy)) throw new Error('모양이 다름');
      for (const [key, e] of Object.entries(value.legacy)) { if (!LEGACY_VALUES.includes(e?.value)) throw new Error('모양이 다름'); addLegacy(key, e); }
    }
    // 예전 `cards` 칸(night source)은 판정에 쓰지 않는다. 지우지도 않고 그대로 보존해 다시 쓴다.
    return {repos, legacy, rawCards: value.cards, corrupt: null};
  } catch (error) {
    // 원격 GET에도 나가는 문구라 OS 오류 문장(절대 경로 포함)을 쓰지 않는다: 파일 이름과 오류 코드만.
    const detail = error.code ?? (error instanceof SyntaxError ? 'JSON 구문 오류' : error.message);
    return {...empty(), corrupt: `나이트런 저장소 정책 파일 손상: ${POLICY_FILE} (${detail})`};
  }
}

// 쓰기는 한 곳이다: 잠금 → 읽기 → mutate(current) → 임시 파일 + rename. mutate가 {repos, event, result}를 돌려준다.
function updatePolicy(home, mutate, {record}) {
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const lock = path.join(home, '.night-repo-policy-lock');
  if (!acquireDirLock(lock)) throw new NightRepoPolicyError('나이트런 저장소 정책 저장 중: 잠시 뒤 다시 확인하세요');
  try {
    const current = readPolicy(home);
    if (current.corrupt) {
      const advice = '파일을 확인한 뒤 고치거나 .trash/로 옮기세요. 읽기는 hold로 봅니다';
      throw new NightRepoPolicyError(`${current.corrupt} (${policyPath(home)}) — ${advice}`, `${current.corrupt} — ${advice}`);
    }
    const next = mutate(current);
    const file = policyPath(home), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({version: 2, repos: next.repos, legacy: current.legacy, ...(current.rawCards !== undefined ? {cards: current.rawCards} : {})}, null, 2) + '\n', {mode: 0o600});
    fs.renameSync(tmp, file);
    record?.(next.event);
    return next.result;
  } finally { fs.renameSync(lock, `${lock}.released-${randomUUID()}`); }
}

const pick = e => ({deployBranch: e?.deployBranch ?? null, nightMerge: e?.nightMerge ?? null});

// 저장소 하나의 칸을 바꾼다. deployBranch·nightMerge는 비어 있으면(undefined·'') 그대로 두고, clear로 칸을 지운다(한 번에 하나).
export function setRepoPolicy(home, {repo, deployBranch, nightMerge, clear, by, now = () => new Date().toISOString(), record}) {
  const key = normalizeGithub(repo);
  if (!key) throw new NightRepoPolicyError(`저장소 키는 GitHub 소유자/이름이어야 합니다: ${repo ?? '(없음)'}`);
  const set = v => v !== undefined && v !== null && v !== '';
  if (set(deployBranch) && !validDeployBranch(deployBranch)) throw new NightRepoPolicyError(`deployBranch는 브랜치 이름 또는 ${NO_BRANCH}이어야 합니다: ${deployBranch}`);
  if (set(nightMerge) && !validNightMerge(nightMerge)) throw new NightRepoPolicyError(`nightMerge는 ${NIGHT_MERGE_VALUES.join('|')} 중 하나여야 합니다: ${nightMerge}`);
  if (set(clear) && !CLEAR_FIELDS.includes(clear)) throw new NightRepoPolicyError(`지울 칸은 ${CLEAR_FIELDS.join('|')} 중 하나여야 합니다: ${clear}`);
  if (!set(deployBranch) && !set(nightMerge) && !set(clear)) throw new NightRepoPolicyError('바꿀 칸이 없습니다: --deploy-branch, --night-merge, --clear 중 하나가 필요합니다');
  if (set(clear) && ((clear === 'deployBranch' && set(deployBranch)) || (clear === 'nightMerge' && set(nightMerge)))) throw new NightRepoPolicyError(`같은 칸을 바꾸면서 지울 수 없습니다: ${clear}`);
  return updatePolicy(home, current => {
    const before = pick(current.repos[key]), after = {...before};
    if (set(deployBranch)) after.deployBranch = deployBranch;
    if (set(nightMerge)) after.nightMerge = nightMerge;
    if (set(clear)) after[clear] = null;
    const at = now(), repos = {...current.repos};
    if (after.deployBranch === null && after.nightMerge === null) delete repos[key];
    else repos[key] = {...(after.deployBranch !== null ? {deployBranch: after.deployBranch} : {}), ...(after.nightMerge !== null ? {nightMerge: after.nightMerge} : {}), at, by};
    return {repos, result: {repo: key, ...after, at, by, before},
      event: {kind: 'night-repo-policy', repo: key, before, after, by, t: at}};
  }, {record});
}

// ---- 온톨로지 폴더 ----
// 판정에 쓰는 칸. 이 키처럼 보이는 줄(따옴표·공백·대소문자·들여쓰기 변형 포함)이 정확한 형식(`키: 값`)이 아니거나 두 번 나오면
// "못 읽음"이다. "칸 없음"은 키처럼 보이는 줄이 전혀 없을 때만이다. 다른 칸은 너그럽게 읽는다.
const STRICT_KEYS = ['night_merge', 'deploy_branch', 'remote'];
const STRICT_LINE = /^(night_merge|deploy_branch|remote):/;
const LOOSE_LINE = /^\s*["']?\s*(night[_-]merge|deploy[_-]branch|remote)\s*["']?\s*:/i;

// 문서 앞머리(`---` 사이)의 `키: 값` 줄. 첫 줄이 `---`가 아니면 {none: true}(앞머리 없는 일반 문서), 닫는 `---`가 없으면 null(깨짐).
// 판정 칸의 문제는 problems에 줄 번호(파일 기준 1부터)와 함께 담는다. type 칸의 문제는 typeProblem에 한 줄로 담는다.
function frontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {none: true};
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const fields = {}, exact = {}, badForm = {};
  const typeExact = [], typeLoose = [];
  lines.slice(1, end).forEach((line, i) => {
    const no = i + 2;
    if (/^type:/.test(line)) typeExact.push(no);
    else if (/^\s*["']?\s*type\s*["']?\s*:/i.test(line)) typeLoose.push(no);
    const strict = STRICT_LINE.exec(line)?.[1];
    if (strict) (exact[strict] ??= []).push(no);
    else { const loose = LOOSE_LINE.exec(line)?.[1]; if (loose) (badForm[loose.toLowerCase().replace('-', '_')] ??= []).push(no); }
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  });
  const problems = STRICT_KEYS.flatMap(key => [
    ...(badForm[key] ? [`${key} 줄 ${badForm[key].join('·')} 형식이 틀림(정확히 "${key}: 값"만 읽음)`] : []),
    ...(exact[key]?.length > 1 ? [`${key} 칸이 중복: 줄 ${exact[key].join('·')}`] : []),
  ]);
  // type은 최상위 `type: 값` 한 줄만 읽는다. 없거나 두 번 나오면 읽지 못함이다(들여쓴 하위 칸의 type은 최상위가 있으면 무시).
  const typeProblem = typeExact.length > 1 ? `type 칸이 중복: 줄 ${typeExact.join('·')}`
    : typeExact.length ? null
    : typeLoose.length ? `type 줄 ${typeLoose.join('·')} 형식이 틀림(정확히 "type: 값"만 읽음)` : 'type 칸이 없음';
  return {fields, problems, typeProblem};
}

// type 값: 'project' | 'other'(판정에 쓰지 않음) | 'unreadable'. 앞뒤 공백을 벗기고 짝이 맞는 따옴표만 벗긴 값(앞머리 읽기에서 한 번 벗김)이
// `project`(뒤에 괄호 설명만 허용)면 project, 소문자 낱말 하나(`^[a-z][a-z0-9_-]*$`)면 other다. 그 밖은 모두 못 읽음이다:
// 닫지 않은 따옴표·대문자·공백이 낀 값·`project # 메모`·빈 값은 project 문서일 수 있어 무시하지 않는다.
function typeOf(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (/^project(?:\s+\(.*\))?$/.test(v)) return 'project';
  return /^[a-z][a-z0-9_-]*$/.test(v) ? 'other' : 'unreadable';
}

const firstWord = value => (typeof value === 'string' ? value.trim().split(/\s+/)[0] : '') || null;

// 카드 `remote:`는 세 형식만 읽는다(첫 낱말, 뒤의 괄호 설명은 무시): `github.com/o/n`, `git@github.com:o/n.git`
// (또는 `git@github-<별칭>:o/n.git`), 맨 `o/n`(소유자에 점 없음). `없음`이거나 다른 형식이면 null이다.
const REMOTE_FORMS = [
  /^github\.com\/([^/\s]+\/[^/\s]+)$/i,
  /^git@github(?:\.com|-[\w.-]+):([^/\s]+\/[^/\s]+)$/i,
  /^([A-Za-z0-9-]+\/[^/\s:@]+)$/, // 맨 o/n: GitHub 소유자 이름에는 점이 없어 `github.com/x` 같은 도메인 꼴은 맞지 않는다
];
export function parseRemote(value) {
  const first = typeof value === 'string' ? value.trim().split(/\s+/)[0] : '';
  for (const form of REMOTE_FORMS) { const m = form.exec(first); if (m) return normalizeGithub(m[1]); }
  return null;
}

// `deploy_branch`는 두 형식만 읽는다. (가) 낱말 하나(`main`·`없음`, 뒤는 비었거나 괄호 설명뿐) (나) YAML 흐름 짝 목록
// `{소유자/이름: 브랜치, …}`. 그 밖은 unreadable이다(설명 글을 해석하지 않는다). 칸이 없으면 null.
export function parseDeployBranch(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const unreadable = {kind: 'unreadable'};
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) return unreadable;
    const map = {};
    for (const part of text.slice(1, -1).split(',')) {
      const i = part.indexOf(':');
      const key = i < 0 ? null : normalizeGithub(part.slice(0, i)), branch = i < 0 ? '' : part.slice(i + 1).trim();
      if (!key || !BRANCH_WORD.test(branch) || key in map) return unreadable;
      map[key] = branch;
    }
    return Object.keys(map).length ? {kind: 'map', map} : unreadable;
  }
  const m = /^(\S+)(?:\s+\(.*)?$/s.exec(text);
  return m && BRANCH_WORD.test(m[1]) ? {kind: 'word', value: m[1]} : unreadable;
}

export const ONTOLOGY_DIR = 'ontology';
export const ONTOLOGY_LIMITS = {depth: 8, dirs: 2000, files: 5000};
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const posixRel = (...parts) => parts.join('/');

// `$KADAN_HOME/ontology/`를 한 번 훑어 `type: project` 문서만 모은다(앞머리만 읽는다). 폴더가 없으면 빈 것이다(오류 아님).
// 하위 폴더와 링크(폴더·파일, 폴더 밖을 가리키는 것 포함)를 따라간다. 들어간 폴더의 실제 경로(realpath)와 읽은 파일의 실제 경로를
// 기억해 순환·중복을 막는다. 상한(깊이·폴더 수·파일 수)을 넘으면 읽기를 멈추고 "상한 초과" 1건으로 친다(limits는 시험이 주입한다).
// 문서는 경로가 아니라 `ontology/` 기준 상대 경로(링크를 따라갔으면 링크 쪽 경로)로만 가리킨다.
// 읽지 못한 것(깨진 링크·권한 오류·앞머리 손상·type 칸 문제·판정 칸 형식 틀림)은 unreadableCards에 따로 모은다.
// 누구 문서인지 알 수 없으므로 "이 저장소 문서가 아니다"라고 단정하지 않는다(rowFor가 이 목록으로 보류한다).
// 앞머리 없는 일반 문서와 다른 type 문서는 읽고 무시한다. 폴더 전체를 못 읽는 경우(루트 읽기 실패·상한 초과)는 unreadable이다.
export function loadOntology(home, {limits = ONTOLOGY_LIMITS} = {}) {
  const root = path.join(home, ONTOLOGY_DIR);
  const cards = [], unreadableCards = [], seenDirs = new Set(), seenFiles = new Set();
  const stats = {exists: false, files: 0, dirs: 0};
  let unreadable = null, stopped = false;
  const bad = (rel, reason) => unreadableCards.push({path: rel, reason});
  const code = error => error?.code ?? '읽기 실패';
  const overflow = () => { stopped = true; unreadable ??= `온톨로지 폴더 상한 초과(깊이 ${limits.depth}·폴더 ${limits.dirs}개·파일 ${limits.files}개)`; };

  const readDoc = (full, rel) => {
    let real;
    try { real = fs.realpathSync(full); } catch (error) { return bad(rel, `문서를 읽을 수 없음(${code(error)})`); }
    if (seenFiles.has(real)) return;
    seenFiles.add(real);
    if (++stats.files > limits.files) return overflow();
    let parsed;
    try { parsed = frontmatter(fs.readFileSync(full, 'utf8')); } catch (error) { return bad(rel, `문서를 읽을 수 없음(${code(error)})`); }
    if (parsed?.none) return; // 앞머리 없는 일반 문서
    if (parsed === null) return bad(rel, '앞머리를 읽을 수 없음');
    if (parsed.typeProblem) return bad(rel, parsed.typeProblem);
    const kind = typeOf(parsed.fields.type);
    if (kind === 'other') return;
    if (kind === 'unreadable') return bad(rel, 'type 값을 읽을 수 없음(project 문서일 수 있음)');
    const {fields, problems} = parsed;
    const deployBranch = parseDeployBranch(fields.deploy_branch);
    const mapBroken = deployBranch?.kind === 'unreadable' && String(fields.deploy_branch).trim().startsWith('{');
    const reason = problems.length ? '판정 칸 형식이 틀림' : mapBroken ? 'deploy_branch 짝 목록 형식이 틀림' : null;
    if (reason) bad(rel, reason);
    cards.push({id: path.basename(rel, '.md'), path: rel, broken: false, problems,
      github: parseRemote(fields.remote), deployBranch,
      nightMerge: 'night_merge' in fields ? (firstWord(fields.night_merge) ?? '') : null});
  };

  const walk = (dir, rel, depth) => {
    if (stopped) return;
    let real;
    try { real = fs.realpathSync(dir); } catch (error) { return bad(rel, `폴더를 읽을 수 없음(${code(error)})`); }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);
    if (depth > limits.depth || ++stats.dirs > limits.dirs) return overflow();
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch (error) { return bad(rel, `폴더를 읽을 수 없음(${code(error)})`); }
    for (const name of names) {
      if (stopped) return;
      const full = path.join(dir, name), childRel = rel ? posixRel(rel, name) : name;
      let stat;
      try { stat = fs.statSync(full); } catch (error) { bad(childRel, `읽을 수 없음(깨진 링크 또는 ${code(error)})`); continue; }
      if (stat.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full, childRel, depth + 1); }
      else if (stat.isFile() && name.endsWith('.md')) readDoc(full, childRel);
    }
  };

  // 루트는 lstat으로 본다: 항목 자체가 없을 때(ENOENT)만 빈 상태다. 링크인데 대상이 없거나 폴더가 아니면 읽지 못함이다.
  try {
    const isLink = fs.lstatSync(root).isSymbolicLink();
    try {
      if (fs.statSync(root).isDirectory()) stats.exists = true;
      else if (isLink) unreadable = '온톨로지 링크 대상이 폴더가 아님'; // 링크 없는 평범한 파일은 예전처럼 없는 것과 같다
    } catch (error) { unreadable = `온톨로지 폴더를 읽을 수 없음(깨진 링크 또는 ${code(error)})`; }
  } catch (error) {
    if (error.code !== 'ENOENT') unreadable = `온톨로지 폴더를 읽을 수 없음(${code(error)})`;
  }
  if (stats.exists) walk(root, '', 0);
  const unreadableList = [...(unreadable ? [{path: null, reason: unreadable}] : []), ...unreadableCards];
  return {cards, unreadable, unreadableCards, unreadableList,
    stats: {exists: stats.exists || unreadable !== null, files: Math.min(stats.files, limits.files), projects: cards.length, unreadable: unreadableList.length}};
}

// 소유자/이름으로 문서 찾기(위에서부터): (a) deploy_branch 짝 목록에 그 키가 있는 카드 (b) 카드 remote가 그 키인 카드.
// 문서가 없으면 {card: null}(빈 칸), 둘 이상이거나 폴더를 못 읽으면 {problem}(못 읽힘)이다.
function cardForGithub(key, {cards, unreadable, unreadableCards = []}) {
  if (unreadable) return {problem: unreadable};
  let picked = cards.filter(c => c.deployBranch?.kind === 'map' && key in c.deployBranch.map);
  if (!picked.length) picked = cards.filter(c => c.github === key);
  // 그 저장소 카드가 스스로 못 읽히면 구체적인 이유(줄 번호 등)를 보이고, 아니면 읽지 못한 카드가 있다는 사실만 알린다.
  if (unreadableCards.length && !(picked.length === 1 && (picked[0].broken || picked[0].problems.length)))
    return {problem: `온톨로지 문서 ${unreadableCards.length}건을 읽지 못함`};
  if (!picked.length) return {card: null};
  if (picked.length > 1) return {problem: `문서가 여럿: ${picked.map(c => c.path).join(', ')}`};
  return {card: picked[0]};
}

// 문서가 내는 칸 값: {value, state: 'ok'|'empty'|'unreadable', detail}. 문서 전체 문제(깨짐·중복 줄)는 두 칸 모두 못 읽힘이다.
function cardFields(found, key) {
  const bad = detail => ({value: null, state: 'unreadable', detail});
  const empty_ = {value: null, state: 'empty', detail: null};
  if (found.problem) return {deployBranch: bad(found.problem), nightMerge: bad(found.problem)};
  const {card} = found;
  if (!card) return {deployBranch: empty_, nightMerge: empty_};
  if (card.broken) { const d = '문서 앞머리를 읽을 수 없음'; return {deployBranch: bad(d), nightMerge: bad(d)}; }
  if (card.problems.length) { const d = `문서 판정 칸을 읽을 수 없음: ${card.problems.join('; ')}`; return {deployBranch: bad(d), nightMerge: bad(d)}; }
  const db = card.deployBranch;
  const deployBranch = db === null ? empty_
    : db.kind === 'unreadable' ? bad('deploy_branch 형식을 읽을 수 없음(낱말 하나 또는 {소유자/이름: 브랜치} 목록만 읽음)')
    : db.kind === 'word' ? {value: db.value, state: 'ok', detail: null}
    : key in db.map ? {value: db.map[key], state: 'ok', detail: null} : bad(`deploy_branch 목록에 ${key} 없음`);
  const nm = card.nightMerge;
  const nightMerge = nm === null ? empty_ : validNightMerge(nm) ? {value: nm, state: 'ok', detail: null} : bad(`night_merge 값을 모름: ${nm || '(빈 값)'}`);
  return {deployBranch, nightMerge};
}

// 한 칸의 합친 값: 설정 값이 있으면 설정이 이긴다(from 'kadan'), 없으면 온톨로지 문서(from 'ontology'), 둘 다 없으면 비어 있다(from null).
// 문서가 못 읽히고 설정이 비워 두었으면 unreadable이다.
function merged(setting, fromCard) {
  if (setting !== null && setting !== undefined) return {value: setting, from: 'kadan', unreadable: null};
  if (fromCard.state === 'ok') return {value: fromCard.value, from: 'ontology', unreadable: null};
  return {value: null, from: null, unreadable: fromCard.state === 'unreadable' ? fromCard.detail : null};
}

const settingsOf = e => ({deployBranch: e?.deployBranch ?? null, nightMerge: e?.nightMerge ?? null, at: e?.at ?? null, by: e?.by ?? null});
const hold = (reason, detail = null, exceptBranch = null) => ({action: 'hold', reason, detail, exceptBranch});

// 저장소 하나(GitHub 소유자/이름)의 지금 정책과 판정. 대상 브랜치는 모른다: "그 브랜치로 가는 PR만 보류"는 exceptBranch로 알린다.
function rowFor(policy, ontology, github, repo = null) {
  const saved = policy.repos[github] ?? null;
  const found = cardForGithub(github, ontology);
  const fromCard = cardFields(found, github);
  const effective = {deployBranch: merged(saved?.deployBranch, fromCard.deployBranch), nightMerge: merged(saved?.nightMerge, fromCard.nightMerge)};
  const card = found.card ? {id: found.card.id, path: found.card.path, deployBranch: fromCard.deployBranch.value, nightMerge: fromCard.nightMerge.value} : null;
  const row = {github, repo, settings: settingsOf(saved), card,
    effective: {deployBranch: {value: effective.deployBranch.value, from: effective.deployBranch.from}, nightMerge: {value: effective.nightMerge.value, from: effective.nightMerge.from}}};
  const unreadable = effective.deployBranch.unreadable ?? effective.nightMerge.unreadable;
  if (unreadable) return {...row, verdict: hold('setup-needed', unreadable)};
  if (effective.nightMerge.value === '금지') return {...row, verdict: hold('night-merge-forbidden')};
  const branch = effective.deployBranch.value;
  if (branch === null) return {...row, verdict: hold('setup-needed', 'deploy_branch 값이 없음(카단 설정과 온톨로지 문서 모두)')};
  return {...row, verdict: {action: 'merge', reason: 'allowed', detail: null, exceptBranch: branch === NO_BRANCH ? null : branch}};
}

// baseBranch(PR 대상 브랜치)를 주면 deployBranch와 같을 때 hold(deploy-branch)로 바꾼다.
function withBase(row, baseBranch) {
  const except = row.verdict.exceptBranch;
  return except && baseBranch === except ? {...row, verdict: hold('deploy-branch')} : row;
}

// 온톨로지 폴더는 `$KADAN_HOME/ontology/`에서 읽는다(호출마다 한 번 훑음. PR마다 부르는 쪽은 ontology를 넘겨 재사용한다).
export function evaluateGithub(home, github, {baseBranch, policy = readPolicy(home), ontology = loadOntology(home)} = {}) {
  const key = normalizeGithub(github);
  if (!key) return {github: null, repo: null, settings: settingsOf(null), card: null, effective: {deployBranch: {value: null, from: null}, nightMerge: {value: null, from: null}},
    verdict: hold('setup-needed', `GitHub 소유자/이름이 올바르지 않음: ${github ?? '(없음)'}`)};
  if (policy.corrupt) return {...rowFor(empty(), {cards: [], unreadable: null, unreadableCards: []}, key), verdict: hold('setup-needed', policy.corrupt)};
  return withBase(rowFor(policy, ontology, key), baseBranch);
}

// C2 머지 관문이 PR마다 부르는 함수. github는 PR 주소의 소유자/이름, baseBranch는 PR 대상 브랜치다.
// "그 브랜치만 보류"인데 대상 브랜치를 모르면 hold(setup-needed)다.
export function decideNightMerge(home, {github, baseBranch, policy, ontology} = {}) {
  const hasBase = typeof baseBranch === 'string' && baseBranch !== '';
  const info = evaluateGithub(home, github, {baseBranch: hasBase ? baseBranch : undefined, policy, ontology});
  let {action, reason} = info.verdict;
  if (action === 'merge' && info.verdict.exceptBranch && !hasBase) { action = 'hold'; reason = 'setup-needed'; }
  return {action, reason, github: info.github, card: info.card?.id ?? null,
    deployBranch: info.effective.deployBranch.value, nightMerge: info.effective.nightMerge.value};
}

// 업무 저장소의 git origin(GitHub 소유자/이름). 읽지 못하면 null. https·ssh 주소를 모두 읽는다.
export function gitOriginGithub(repoPath) {
  try {
    const url = execFileSync('git', ['-C', repoPath, 'config', '--get', 'remote.origin.url'], {encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']}).trim();
    return parseRemote(url.replace(/^(?:https?|ssh):\/\/(?:[^@/]+@)?/i, '').replace(/^git@([^:/]+)\//, 'git@$1:'));
  } catch { return null; }
}

// 목록(화면·CLI)에 나오는 저장소는 셋을 합친 것이다: 카단 설정이 있는 키, 온톨로지 문서에서 읽힌 키(remote·짝 목록),
// 업무가 있는 저장소(업무 repoPath의 git origin). 각 줄은 evaluateGithub와 같은 판정이다.
// legacy: 옛 형식(merge|hold, 맨 이름) 저장값. 판정에 쓰지 않고 "다시 설정 필요"로 따로 보인다.
// sources.ontology는 {exists, files, projects, unreadable} 숫자만 담는다(경로 없음).
export function listRepos(home, works = [], {origin = gitOriginGithub, limits} = {}) {
  const policy = readPolicy(home);
  const ontology = loadOntology(home, limits ? {limits} : {});
  const sources = {ontology: ontology.stats};
  const legacy = Object.entries(policy.legacy).map(([name, e]) => ({name, ...e})).sort((a, b) => a.name.localeCompare(b.name));
  if (policy.corrupt) return {corrupt: policy.corrupt, repos: [], legacy, sources, unreadable: []};
  const unreadable = ontology.unreadableList; // 읽지 못한 것: ontology/ 기준 상대 경로·이유. 폴더 전체(루트·상한 초과)면 path가 null
  const keys = new Map(); // github → 업무 키 첫 마디(있으면)
  for (const key of Object.keys(policy.repos)) keys.set(key, null);
  for (const c of ontology.cards) {
    for (const k of c.deployBranch?.kind === 'map' ? Object.keys(c.deployBranch.map) : [c.github]) if (k && !keys.has(k)) keys.set(k, null);
  }
  const paths = new Map(); // repoPath → 업무 키 첫 마디(처음 본 것)
  for (const w of works) if (typeof w.repoPath === 'string' && path.isAbsolute(w.repoPath) && !paths.has(w.repoPath)) paths.set(w.repoPath, String(w.key ?? '').split('/')[0] || null);
  for (const [repoPath, repo] of paths) { const g = origin(repoPath); if (g && (!keys.has(g) || keys.get(g) === null)) keys.set(g, repo); }
  const repos = [...keys].sort(([a], [b]) => a.localeCompare(b)).map(([github, repo]) => rowFor(policy, ontology, github, repo));
  return {corrupt: null, repos, legacy, sources, unreadable};
}

// 아침 요약용(C2 관문이 그 밤에 본 저장소 줄을 넘겨 부른다): 기본값을 못 정해 보류한 저장소의 안내 줄.
export const setupNeededLines = infos => infos.filter(i => i.verdict.reason === 'setup-needed' && i.github)
  .map(i => `설정 필요: ${i.github} — 나이트런 중 자동 머지 안 함(kadan night repo ${i.github} --deploy-branch <브랜치|없음>)`);
