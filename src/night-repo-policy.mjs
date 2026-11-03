// 저장소별 밤 머지 정책(PR C1). 자동 단계에서 관문을 통과한 PR을 저장소마다 merge|hold로 다룬다.
// 판정 키는 GitHub `소유자/이름`이다(소문자, 끝 `.git`·`/` 제거): 업무 키(폴더) 하나에 저장소가 여럿일 수 있고(우산 카드),
// 머지 관문(C2)은 PR 주소에서 소유자/이름을 바로 얻는다. 허용 저장소 목록은 두지 않는다(2026-11-02 kyle).
// 값이 없으면 온톨로지 project 카드의 `deploy_branch`·`night_merge`·`remote` 칸이 기본값이다(2026-11-03 kyle:
// "배포브랜치를 적어두면, 해당 브랜치에만 머지 안 해도 되는 거니까").
// 판정(위에서부터 처음 맞는 것): 저장값 → 카드·deploy_branch를 못 읽으면 hold(setup-needed) → night_merge 금지면 hold
//   → 대상 브랜치가 deploy_branch면 hold → merge. 카드의 `deploy` 칸은 판정에 쓰지 않고 화면 참고용으로만 응답에 담는다.
// 칸은 정해진 형식만 읽는다. 설명 글을 정규식으로 해석하지 않고, 읽지 못하면 setup-needed다(네 라운드의 교훈).
// 상주 경로가 아니다: 명령·요청 한 번에 카드 앞머리 몇십 장을 읽는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireDirLock} from './dir-lock.mjs';

export const POLICY_FILE = 'night-repo-policy.json';
export const POLICY_VALUES = ['merge', 'hold'];
const LEGACY_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u; // 옛 형식 저장 키(맨 이름)

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

// 온톨로지 project 카드 폴더: 허브마다 `~/Dev/*-hub/ontology/cards/project`다(허브가 늘어도 같은 규칙).
// 시험·다른 기계는 KADAN_ONTOLOGY_DIRS(경로 구분자로 여럿)로 바꾼다.
export const defaultOntologyDirs = () => {
  const dev = path.join(os.homedir(), 'Dev');
  try {
    return fs.readdirSync(dev).filter(n => n.endsWith('-hub')).sort().map(n => path.join(dev, n, 'ontology/cards/project'));
  } catch { return []; }
};
const expandHome = p => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);
const normPath = p => expandHome(String(p).trim()).replace(/\/+$/, '');

export const policyPath = home => path.join(home, POLICY_FILE);

// 사람용 문구(message, CLI에서는 경로 포함)와 HTTP용 문구(httpMessage, 파일 이름과 오류 종류만)를 한 곳에서 나눈다(검수 F3).
export class NightRepoPolicyError extends Error {
  constructor(message, httpMessage = message) { super(message); this.httpMessage = httpMessage; }
}

// 손상은 "읽지 못함"과 같게 다룬다: 읽기는 hold, 쓰기는 거절. 다른 값으로 넘어가지 않는다.
// 저장 키는 GitHub 소유자/이름이다. 옛 형식(맨 이름)은 "덮어쓰기 없음"으로 읽고 legacy에 따로 담는다(지우지 않는다).
// 예전 `auto` 값은 저장값 없음으로 읽는다(legacy에도 담지 않고, 다시 쓸 때 빠진다).
export function readPolicy(home) {
  const file = policyPath(home);
  if (!fs.existsSync(file)) return {repos: {}, legacy: {}, corrupt: null};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = value && value.version === 1 && value.repos && typeof value.repos === 'object' && !Array.isArray(value.repos)
      && Object.entries(value.repos).every(([key, r]) => (key === normalizeGithub(key) || LEGACY_NAME.test(key)) && [...POLICY_VALUES, 'auto'].includes(r?.value));
    if (!ok) throw new Error('모양이 다름');
    const live = Object.entries(value.repos).filter(([, r]) => r.value !== 'auto');
    return {repos: Object.fromEntries(live.filter(([key]) => key.includes('/'))), legacy: Object.fromEntries(live.filter(([key]) => !key.includes('/'))), corrupt: null};
  } catch (error) {
    // 원격 GET에도 나가는 문구라 OS 오류 문장(절대 경로 포함)을 쓰지 않는다: 파일 이름과 오류 코드만.
    const detail = error.code ?? (error instanceof SyntaxError ? 'JSON 구문 오류' : error.message);
    return {repos: {}, legacy: {}, corrupt: `밤 저장소 정책 파일 손상: ${POLICY_FILE} (${detail})`};
  }
}

export function setRepoPolicy(home, {repo, value, by, now = () => new Date().toISOString(), record}) {
  const key = normalizeGithub(repo);
  if (!key) throw new Error(`저장소 키는 GitHub 소유자/이름이어야 합니다: ${repo ?? '(없음)'}`);
  if (!POLICY_VALUES.includes(value)) throw new Error(`값은 ${POLICY_VALUES.join('|')} 중 하나여야 합니다: ${value ?? '(없음)'}`);
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const lock = path.join(home, '.night-repo-policy-lock');
  if (!acquireDirLock(lock)) throw new Error('밤 저장소 정책 저장 중: 잠시 뒤 다시 확인하세요');
  try {
    const current = readPolicy(home);
    if (current.corrupt) {
      const advice = '파일을 확인한 뒤 고치거나 .trash/로 옮기세요. 읽기는 hold로 봅니다';
      throw new NightRepoPolicyError(`${current.corrupt} (${policyPath(home)}) — ${advice}`, `${current.corrupt} — ${advice}`);
    }
    const before = current.repos[key]?.value ?? null;
    const entry = {value, at: now(), by};
    const file = policyPath(home), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({version: 1, repos: {...current.legacy, ...current.repos, [key]: entry}}, null, 2) + '\n', {mode: 0o600});
    fs.renameSync(tmp, file);
    record?.({kind: 'night-repo-policy', repo: key, before, after: value, by, t: entry.at});
    return {repo: key, ...entry, before};
  } finally { fs.renameSync(lock, `${lock}.released-${randomUUID()}`); }
}

// 판정에 쓰는 칸. 이 키처럼 보이는 줄(따옴표·공백·대소문자·들여쓰기 변형 포함)이 정확한 형식(`키: 값`)이 아니거나 두 번 나오면
// "못 읽음"이다. "칸 없음(기본 허용)"은 키처럼 보이는 줄이 전혀 없을 때만이다(검수 F1). 다른 칸(url·rules 등)은 너그럽게 읽는다.
const STRICT_KEYS = ['night_merge', 'deploy_branch', 'remote'];
const STRICT_LINE = /^(night_merge|deploy_branch|remote):/;
const LOOSE_LINE = /^\s*["']?\s*(night[_-]merge|deploy[_-]branch|remote)\s*["']?\s*:/i;

// 카드 앞머리(`---` 사이)의 `키: 값` 줄. 닫는 `---`가 없거나 첫 줄이 `---`가 아니면 null(깨짐).
// 판정 칸의 문제는 problems에 줄 번호(파일 기준 1부터)와 함께 담는다.
function frontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const fields = {}, exact = {}, badForm = {};
  lines.slice(1, end).forEach((line, i) => {
    const no = i + 2;
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
  return {fields, problems};
}

const realPath = p => { try { return fs.realpathSync(p).replace(/\/+$/, ''); } catch { return p; } };
// 카드 `repo:` 값은 경로 부분만 쓴다(첫 공백 앞까지, 뒤의 "(…)" 설명은 버림). `~`를 펼치고 realpath로 바꾼다.
const cardRepoPath = value => { const first = String(value ?? '').trim().split(/\s+/)[0]; return first ? realPath(normPath(first)) : null; };
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

const BRANCH_WORD = /^(?:없음|[A-Za-z0-9._/-]+)$/;
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

// 허브 이름: `<허브>/ontology/cards/project` 폴더면 허브 폴더 이름에서 `-hub`를 뗀 것, 아니면 null.
const hubOf = dir => {
  const parts = dir.split('/').filter(Boolean);
  return parts.slice(-3).join('/') === 'ontology/cards/project' && parts.length > 3 ? parts[parts.length - 4].replace(/-hub$/, '') : null;
};

// 온톨로지 project 카드 전부(앞머리만 읽는다). 폴더가 없으면 건너뛰고, 그 밖의 읽기 오류는 unreadable로 표시한다.
export function loadCards(dirs = process.env.KADAN_ONTOLOGY_DIRS?.split(path.delimiter).filter(Boolean) ?? defaultOntologyDirs()) {
  const cards = [];
  let unreadable = null;
  for (const dir of dirs.map(normPath)) {
    let names;
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort(); } catch (error) {
      if (error.code !== 'ENOENT') unreadable ??= `온톨로지 폴더를 읽을 수 없음(${error.code ?? '읽기 실패'})`;
      continue;
    }
    for (const name of names) {
      let parsed = null;
      try { parsed = frontmatter(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { /* 깨진 카드와 같게 본다 */ }
      const fields = parsed?.fields ?? null;
      cards.push({id: `${path.basename(dir)}/${name.slice(0, -3)}`, hub: hubOf(dir), name: name.slice(0, -3), broken: parsed === null,
        problems: parsed?.problems ?? [],
        repo: fields ? cardRepoPath(fields.repo) : null, github: parseRemote(fields?.remote), deploy: firstWord(fields?.deploy),
        deployBranch: parseDeployBranch(fields?.deploy_branch),
        nightMerge: fields && 'night_merge' in fields ? (firstWord(fields.night_merge) ?? '') : null});
    }
  }
  return {cards, unreadable};
}

const NIGHT_MERGE_VALUES = ['허용', '금지'];
const NO_BRANCH = '없음';
// source: 화면 참고용 근거(카드 id·허브 이름만, 절대 경로 없음). null 뜻: nightMerge 칸 없음(판정은 허용)·deployBranch 칸 없음/읽지 못함
// (판정은 setup-needed)·github는 카드 remote를 읽지 못함. deploy는 첫 낱말(자동·수동·없음)만. kind는 카드가 판정 근거면 ontology, 아니면 none.
const sourceOf = (card, reason, {kind = 'none', branch = null} = {}) => ({kind, card: card?.id ?? null, hub: card?.hub ?? null, github: card?.github ?? null,
  deploy: card?.deploy ?? null, deployBranch: branch, nightMerge: card?.nightMerge || null, reason});
const setupNeeded = (reason, card = null, branch = null) => ({source: sourceOf(card, reason, {branch}),
  verdict: {action: 'hold', reason: 'setup-needed', detail: reason, exceptBranch: null}});
const noSource = () => sourceOf(null, null);

// 카드 한 장 + 저장소 키(우산 카드는 짝 키)의 기본값 판정(저장소 단위, 대상 브랜치는 모른다). verdict.exceptBranch가 있으면
// "merge이지만 그 브랜치로 가는 PR만 보류"다.
function judgeCard(card, key) {
  if (card.broken) return setupNeeded('카드 앞머리를 읽을 수 없음', card);
  if (card.problems.length) return setupNeeded(`카드 판정 칸을 읽을 수 없음: ${card.problems.join('; ')}`, card);
  const db = card.deployBranch;
  if (db === null) return setupNeeded('deploy_branch 칸 없음', card);
  if (db.kind === 'unreadable') return setupNeeded('deploy_branch 형식을 읽을 수 없음(낱말 하나 또는 {소유자/이름: 브랜치} 목록만 읽음)', card);
  const branch = db.kind === 'word' ? db.value : (key ? db.map[key] : undefined);
  if (branch === undefined) return setupNeeded(`deploy_branch 목록에 ${key ?? '(저장소 키 없음)'} 없음`, card);
  const night = card.nightMerge ?? '허용';
  if (!NIGHT_MERGE_VALUES.includes(night)) return setupNeeded(`night_merge 값을 모름: ${night || '(빈 값)'}`, card, branch);
  const ok = {source: sourceOf(card, null, {kind: 'ontology', branch})};
  if (night === '금지') return {...ok, verdict: {action: 'hold', reason: 'ontology-night-merge-forbidden', exceptBranch: null}};
  return {...ok, verdict: {action: 'merge', reason: 'ontology-allowed', exceptBranch: branch === NO_BRANCH ? null : branch}};
}

// 저장 값이 있으면 그것이 이기고(kyle 덮어쓰기), 없으면 카드 판정이다. 정책 파일이 손상이면 hold다.
function rowFor(policy, {repo, github, card, problem}) {
  if (policy.corrupt) return {repo, github, value: null, saved: null, ...setupNeeded(policy.corrupt)};
  const saved = (github && policy.repos[github]) || null;
  const row = {repo, github, value: saved?.value ?? null, saved};
  if (saved) return {...row, source: noSource(), verdict: {action: saved.value, reason: `repo-policy-${saved.value}`, exceptBranch: null}};
  return {...row, ...(card ? judgeCard(card, github) : setupNeeded(problem))};
}

// baseBranch(PR 대상 브랜치)를 주면 deploy_branch와 같을 때 hold(deploy-branch)로 바꾼다.
function withBase(row, baseBranch) {
  const except = row.verdict.exceptBranch;
  return except && baseBranch === except ? {...row, verdict: {action: 'hold', reason: 'deploy-branch', exceptBranch: null}} : row;
}

// GitHub 소유자/이름으로 카드 찾기(위에서부터): (a) deploy_branch 짝 목록에 그 키가 있는 카드 (b) 카드 remote가 그 키인 카드.
// 카드가 하나도 없거나 둘 이상이면 못 찾은 것이다.
function cardForGithub(key, {cards, unreadable}) {
  if (unreadable) return {problem: unreadable};
  let picked = cards.filter(c => c.deployBranch?.kind === 'map' && key in c.deployBranch.map);
  if (!picked.length) picked = cards.filter(c => c.github === key);
  if (!picked.length) return {problem: '온톨로지 카드 없음'};
  if (picked.length > 1) return {problem: `온톨로지 카드가 여럿: ${picked.map(c => `${c.hub ? `${c.hub}/` : ''}${c.id}`).join(', ')}`};
  return {card: picked[0]};
}

// 저장소 하나(GitHub 소유자/이름)의 지금 정책. baseBranch를 주면 PR 단위 판정이다.
export function evaluateGithub(home, github, {baseBranch, policy = readPolicy(home), ontology = loadCards()} = {}) {
  const key = normalizeGithub(github);
  if (!key) return {repo: null, github: null, value: null, saved: null, ...setupNeeded(`GitHub 소유자/이름이 올바르지 않음: ${github ?? '(없음)'}`)};
  return withBase(rowFor(policy, {repo: null, github: key, ...cardForGithub(key, ontology)}), baseBranch);
}

// C2 머지 관문이 PR마다 부르는 함수. github는 PR 주소의 소유자/이름, baseBranch는 PR 대상 브랜치다.
// 카드 기본값이 "그 브랜치만 보류"인데 대상 브랜치를 모르면 hold(setup-needed)다.
export function decideNightMerge(home, {github, baseBranch, policy, ontology} = {}) {
  const hasBase = typeof baseBranch === 'string' && baseBranch !== '';
  const info = evaluateGithub(home, github, {baseBranch: hasBase ? baseBranch : undefined, policy, ontology});
  let {action, reason} = info.verdict;
  if (action === 'merge' && info.verdict.exceptBranch && !hasBase) { action = 'hold'; reason = 'setup-needed'; }
  return {action, reason, github: info.github, card: info.source.card, hub: info.source.hub, deployBranch: info.source.deployBranch, nightMerge: info.source.nightMerge};
}

// 업무 키(폴더)로 카드 찾기: 카드 repo: 경로 == 업무 repoPath(둘 다 realpath) → 없으면 파일 이름 == 업무 키. 둘 이상 맞으면 못 찾은 것이다.
function cardForWork(workKey, repoPath, {cards, unreadable}) {
  if (unreadable) return {problem: unreadable};
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) return {problem: '저장소 경로를 모름'};
  const target = realPath(normPath(repoPath));
  let picked = cards.filter(c => c.repo === target);
  if (!picked.length) picked = cards.filter(c => c.name === workKey);
  if (!picked.length) return {problem: '온톨로지 카드 없음'};
  if (picked.length > 1) return {problem: `온톨로지 카드가 여럿: ${picked.map(c => `${c.hub ? `${c.hub}/` : ''}${c.id}`).join(', ')}`};
  return {card: picked[0]};
}

// 업무 키 기준 목록(화면·CLI): 한 업무가 카드 한 장에 맞고, 우산 카드(deploy_branch가 짝 목록)는 짝마다 한 줄이다.
// 각 줄의 repo는 업무 키 첫 마디, github는 짝 키(일반 카드는 카드 remote를 읽은 값, 못 읽으면 null)다. 덮어쓰기는 github 키로 찾는다.
export function evaluateWork(home, workKey, {repoPath, policy = readPolicy(home), ontology = loadCards()} = {}) {
  const found = cardForWork(workKey, repoPath, ontology);
  if (!found.card) return [rowFor(policy, {repo: workKey, github: null, problem: found.problem})];
  const {card} = found;
  const keys = card.deployBranch?.kind === 'map' ? Object.keys(card.deployBranch.map).sort() : [card.github];
  // 판정 원본은 한 곳이다(검수 F2): github 키가 있는 줄은 decideNightMerge와 같은 evaluateGithub 결과를 쓰고 업무 경로는 줄을 만들 때만 쓴다.
  // 그 키가 다른 카드와 겹치면 판정 함수처럼 setup-needed다. 키를 모르는 줄(카드 remote를 못 읽음)만 이 카드로 직접 판정한다.
  return keys.map(github => (github ? {...evaluateGithub(home, github, {policy, ontology}), repo: workKey}
    : rowFor(policy, {repo: workKey, github, card})));
}

// 업무 목록에서 저장소 경로를 찾는다(업무 키 앞부분 = 폴더). 같은 키의 경로가 여럿이면 첫 번째다.
export function repoPathFromWorks(works, repo) {
  return works.find(w => String(w.key ?? '').split('/')[0] === repo && typeof w.repoPath === 'string')?.repoPath ?? null;
}

// legacy: 옛 형식(맨 이름) 저장값. 덮어쓰기로 쓰지 않고 "다시 설정 필요"로 따로 보인다.
export function listRepos(home, works) {
  const policy = readPolicy(home), ontology = loadCards();
  const workKeys = [...new Set(works.map(w => String(w.key ?? '').split('/')[0]).filter(n => LEGACY_NAME.test(n)))].sort();
  const rows = workKeys.flatMap(key => evaluateWork(home, key, {repoPath: repoPathFromWorks(works, key), policy, ontology}));
  // 저장값은 있는데 어떤 업무 줄에도 안 나온 저장소는 따로 한 줄 낸다(github 키만 안다).
  const listed = new Set(rows.map(r => r.github).filter(Boolean));
  const extra = policy.corrupt ? [] : Object.keys(policy.repos).filter(key => !listed.has(key)).sort()
    .map(key => rowFor(policy, {repo: null, github: key, ...cardForGithub(key, ontology)}));
  const legacy = Object.entries(policy.legacy).map(([name, e]) => ({name, value: e.value, at: e.at ?? null, by: e.by ?? null})).sort((a, b) => a.name.localeCompare(b.name));
  return {corrupt: policy.corrupt, repos: [...rows, ...extra], legacy};
}

// 아침 요약용(C2 관문이 그 밤에 본 저장소 줄을 넘겨 부른다): 기본값을 못 정해 보류한 저장소의 안내 줄.
// 소유자/이름을 모르는 줄은 덮어쓸 키가 없어 카드부터 고쳐야 한다.
export const setupNeededLines = infos => infos.filter(i => i.verdict.reason === 'setup-needed')
  .map(i => (i.github ? `설정 필요: kadan night repo ${i.github} merge|hold` : `설정 필요: ${i.repo ?? '(이름 모름)'} — 온톨로지 카드의 remote(소유자/이름)부터 채우세요`));
