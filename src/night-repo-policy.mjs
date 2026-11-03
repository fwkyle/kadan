// 저장소별 밤 머지 정책(PR C1). 자동 단계에서 관문을 통과한 PR을 저장소마다 merge|hold로 다룬다.
// 허용 저장소 목록은 두지 않는다(2026-11-02 kyle). 값이 없으면 온톨로지 project 카드의 새 칸 둘이 기본값이다
// (2026-11-03 kyle: "배포브랜치를 적어두면, 해당 브랜치에만 머지 안 해도 되는 거니까"):
//   deploy_branch(push·머지되면 운영에 자동 배포되는 브랜치, 없으면 `없음`)와 night_merge(`허용`·`금지`, 칸이 없으면 허용).
// 판정(위에서부터 처음 맞는 것): 저장값 → 카드·deploy_branch를 못 읽으면 hold(setup-needed) → night_merge 금지면 hold
//   → 대상 브랜치가 deploy_branch면 hold → merge. 카드의 `deploy` 칸은 판정에 쓰지 않고 화면 참고용으로만 응답에 담는다.
// 파일 낱말로 배포를 추정하지 않는다. 상주 경로가 아니다: 명령·요청 한 번에 카드 앞머리 몇십 장을 읽는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireDirLock} from './dir-lock.mjs';

export const POLICY_FILE = 'night-repo-policy.json';
export const POLICY_VALUES = ['merge', 'hold'];
export const REPO_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

// 온톨로지 project 카드 폴더: 개인·회사 허브 모두 `~/Dev/*-hub/ontology/cards/project`다(허브가 늘어도 같은 규칙).
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

// 손상은 "읽지 못함"과 같게 다룬다: 읽기는 hold, 쓰기는 거절. 다른 값으로 넘어가지 않는다.
// 예전 파일에 저장된 `auto`는 "저장값 없음"으로 읽는다(기본값을 따른다). 다시 쓸 때 빠진다.
export function readPolicy(home) {
  const file = policyPath(home);
  if (!fs.existsSync(file)) return {repos: {}, corrupt: null};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = value && value.version === 1 && value.repos && typeof value.repos === 'object' && !Array.isArray(value.repos)
      && Object.entries(value.repos).every(([name, r]) => REPO_NAME.test(name) && [...POLICY_VALUES, 'auto'].includes(r?.value));
    if (!ok) throw new Error('모양이 다름');
    return {repos: Object.fromEntries(Object.entries(value.repos).filter(([, r]) => r.value !== 'auto')), corrupt: null};
  } catch (error) {
    // 원격 GET에도 나가는 문구라 OS 오류 문장(절대 경로 포함)을 쓰지 않는다: 파일 이름과 오류 코드만.
    const detail = error.code ?? (error instanceof SyntaxError ? 'JSON 구문 오류' : error.message);
    return {repos: {}, corrupt: `밤 저장소 정책 파일 손상: ${POLICY_FILE} (${detail})`};
  }
}

export function setRepoPolicy(home, {repo, value, by, now = () => new Date().toISOString(), record}) {
  if (!REPO_NAME.test(repo ?? '')) throw new Error(`저장소 이름이 올바르지 않습니다: ${repo ?? '(없음)'}`);
  if (!POLICY_VALUES.includes(value)) throw new Error(`값은 ${POLICY_VALUES.join('|')} 중 하나여야 합니다: ${value ?? '(없음)'}`);
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const lock = path.join(home, '.night-repo-policy-lock');
  if (!acquireDirLock(lock)) throw new Error('밤 저장소 정책 저장 중: 잠시 뒤 다시 확인하세요');
  try {
    const current = readPolicy(home);
    if (current.corrupt) throw new Error(`${current.corrupt} (${policyPath(home)}) — 파일을 확인한 뒤 고치거나 .trash/로 옮기세요. 읽기는 hold로 봅니다`);
    const before = current.repos[repo]?.value ?? null;
    const entry = {value, at: now(), by};
    const file = policyPath(home), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({version: 1, repos: {...current.repos, [repo]: entry}}, null, 2) + '\n', {mode: 0o600});
    fs.renameSync(tmp, file);
    record?.({kind: 'night-repo-policy', repo, before, after: value, by, t: entry.at});
    return {repo, ...entry, before};
  } finally { fs.renameSync(lock, `${lock}.released-${randomUUID()}`); }
}

// 카드 앞머리(`---` 사이)의 `키: 값` 줄. 닫는 `---`가 없거나 첫 줄이 `---`가 아니면 null(깨짐).
function frontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return fields;
}

const realPath = p => { try { return fs.realpathSync(p).replace(/\/+$/, ''); } catch { return p; } };
// 카드 `repo:` 값은 경로 부분만 쓴다(첫 공백 앞까지, 뒤의 "(…)" 설명은 버림). `~`를 펼치고 realpath로 바꾼다.
const cardRepoPath = value => { const first = String(value ?? '').trim().split(/\s+/)[0]; return first ? realPath(normPath(first)) : null; };
const firstWord = value => (typeof value === 'string' ? value.trim().split(/\s+/)[0] : '') || null;

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
      let fields = null;
      try { fields = frontmatter(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { /* 깨진 카드와 같게 본다 */ }
      cards.push({id: `${path.basename(dir)}/${name.slice(0, -3)}`, name: name.slice(0, -3), broken: fields === null,
        repo: fields ? cardRepoPath(fields.repo) : null, deploy: firstWord(fields?.deploy),
        deployBranch: firstWord(fields?.deploy_branch), nightMerge: fields && 'night_merge' in fields ? (firstWord(fields.night_merge) ?? '') : null});
    }
  }
  return {cards, unreadable};
}

const NIGHT_MERGE_VALUES = ['허용', '금지'];
const NO_BRANCH = '없음';
// source: 화면 참고용 근거(카드 id만, 절대 경로 없음). null 뜻: nightMerge 칸 없음(판정은 허용)·deployBranch 칸 없음/읽지 못함(판정은 setup-needed)·
// deploy는 첫 낱말(자동·수동·없음)만, nightMerge·deployBranch는 첫 낱말 원문. verdict.exceptBranch가 있으면 "merge이지만 그 브랜치로 가는 PR만 보류"다.
const sourceOf = (card, reason, kind = 'none') => ({kind, card: card?.id ?? null, deploy: card?.deploy ?? null,
  deployBranch: card?.deployBranch ?? null, nightMerge: card?.nightMerge || null, reason});
const setupNeeded = (reason, card = null) => ({source: sourceOf(card, reason), verdict: {action: 'hold', reason: 'setup-needed', detail: reason, exceptBranch: null}});

// 값이 없을 때의 기본값(저장소 단위): 카드 고르기(repo: 경로 일치 → 파일 이름) → deploy_branch·night_merge. 애매하면 hold(setup-needed).
export function ontologyDefault(repo, repoPath, {cards, unreadable}) {
  if (unreadable) return setupNeeded(unreadable);
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) return setupNeeded('저장소 경로를 모름');
  const target = realPath(normPath(repoPath));
  let picked = cards.filter(c => c.repo === target);
  if (!picked.length) picked = cards.filter(c => c.name === repo);
  if (!picked.length) return setupNeeded('온톨로지 카드 없음');
  if (picked.length > 1) return setupNeeded(`온톨로지 카드가 여럿: ${picked.map(c => c.id).join(', ')}`);
  const [card] = picked;
  if (card.broken) return setupNeeded('카드 앞머리를 읽을 수 없음', card);
  if (!card.deployBranch) return setupNeeded('deploy_branch 칸 없음', card);
  const night = card.nightMerge ?? '허용';
  if (!NIGHT_MERGE_VALUES.includes(night)) return setupNeeded(`night_merge 값을 모름: ${night || '(빈 값)'}`, card);
  const ok = {source: sourceOf(card, null, 'ontology')};
  if (night === '금지') return {...ok, verdict: {action: 'hold', reason: 'ontology-night-merge-forbidden', exceptBranch: null}};
  return {...ok, verdict: {action: 'merge', reason: 'ontology-allowed', exceptBranch: card.deployBranch === NO_BRANCH ? null : card.deployBranch}};
}

// 저장소의 지금 정책 한 건. 저장 값이 있으면 그것이 이기고(kyle 덮어쓰기), 없으면 온톨로지 기본값이다.
// baseBranch(PR 대상 브랜치)를 주면 deploy_branch와 같을 때 hold(deploy-branch)로 바꾼다. 주지 않으면 저장소 단위 판정(exceptBranch)이다.
// 정책 파일이 손상이면 hold다. 응답에 절대 경로를 넣지 않는다(카드는 id만).
export function evaluateRepo(home, repo, {repoPath, baseBranch, policy = readPolicy(home), ontology = loadCards()} = {}) {
  if (policy.corrupt) return {repo, value: null, saved: null, ...setupNeeded(policy.corrupt)};
  const saved = policy.repos[repo] ?? null;
  const base = {repo, value: saved?.value ?? null, saved};
  if (saved) return {...base, source: sourceOf(null, null), verdict: {action: saved.value, reason: `repo-policy-${saved.value}`, exceptBranch: null}};
  const info = {...base, ...ontologyDefault(repo, repoPath, ontology)};
  const except = info.verdict.exceptBranch;
  if (baseBranch !== undefined && except && baseBranch === except) info.verdict = {action: 'hold', reason: 'deploy-branch', exceptBranch: null};
  return info;
}

// C2 머지 관문이 PR마다 부르는 함수. baseBranch는 PR 대상 브랜치다. 카드 기본값이 "그 브랜치만 보류"인데 대상 브랜치를 모르면 hold다.
export function decideNightMerge(home, repo, {repoPath, baseBranch, policy, ontology} = {}) {
  const info = evaluateRepo(home, repo, {repoPath, baseBranch: typeof baseBranch === 'string' && baseBranch ? baseBranch : undefined, policy, ontology});
  let {action, reason} = info.verdict;
  if (action === 'merge' && info.verdict.exceptBranch && !(typeof baseBranch === 'string' && baseBranch)) { action = 'hold'; reason = 'setup-needed'; }
  return {action, reason, card: info.source.card, deployBranch: info.source.deployBranch, nightMerge: info.source.nightMerge};
}

// 업무 목록에서 저장소 경로를 찾는다(업무 키 앞부분 = 저장소). 같은 저장소의 경로가 여럿이면 첫 번째다.
export function repoPathFromWorks(works, repo) {
  return works.find(w => String(w.key ?? '').split('/')[0] === repo && typeof w.repoPath === 'string')?.repoPath ?? null;
}

export function listRepos(home, works) {
  const policy = readPolicy(home), ontology = loadCards();
  const names = new Set([...Object.keys(policy.repos), ...works.map(w => String(w.key ?? '').split('/')[0]).filter(n => REPO_NAME.test(n))]);
  return {corrupt: policy.corrupt, repos: [...names].sort()
    .map(repo => evaluateRepo(home, repo, {repoPath: repoPathFromWorks(works, repo), policy, ontology}))};
}

// 아침 요약용(C2 관문이 그 밤에 본 저장소 목록을 넘겨 부른다): 기본값을 못 정해 보류한 저장소의 안내 줄.
export const setupNeededLines = infos => infos.filter(i => i.verdict.reason === 'setup-needed')
  .map(i => `설정 필요: kadan night repo ${i.repo} merge|hold`);
