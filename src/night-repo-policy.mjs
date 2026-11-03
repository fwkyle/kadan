// 저장소별 밤 머지 정책(PR C1). 자동 단계에서 관문을 통과한 PR을 저장소마다 merge|hold|auto로 다룬다.
// 허용 저장소 목록은 두지 않는다(2026-11-02 kyle): 값이 없으면 auto이고, auto는 파일 신호로 배포 저장소를 가려 아침까지 보류한다.
// 판별은 파일 신호를 보는 추정이다. 브랜치 보호·웹 콘솔의 자동 배포 같은 외부 설정은 보지 못하므로 의심되면 hold로 덮어쓴다.
// 상주 경로가 아니다: 명령·요청 한 번에 저장소 파일 몇 개를 읽고, 정책 파일은 저장소 수만큼 작다.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireDirLock} from './dir-lock.mjs';

export const POLICY_FILE = 'night-repo-policy.json';
export const POLICY_VALUES = ['merge', 'hold', 'auto'];
export const REPO_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

// 배포를 뜻하는 낱말(대소문자 무시). 워크플로 본문·package.json 스크립트에 하나라도 보이면 deploy로 본다.
// 트리거(on.push 등)는 읽지 않는다: 낱말이 보이면 어떤 조건이든 보류 쪽으로 틀린다. 앞뒤가 영문·숫자가 아닐 때만 맞고,
// 줄기 낱말(deploy·publish·release)은 뒤에 글자가 더 붙어도 맞는다(deployment·released). `docker push` 등 두 낱말은 공백 하나 이상.
export const DEPLOY_WORDS = ['deploy', 'publish', 'release', 'vercel', 'netlify', 'wrangler', 'pages', 'firebase', 'heroku',
  'fly', 'flyctl', 'render', 'railway', 'aws', 'gcloud', 'azure', 'kubectl', 'helm', 'terraform', 'ansible', 'rsync', 'scp',
  'ssh', 'docker push', 'npm publish', 'pypi', 'twine', 'cargo publish'];
const STEM_WORDS = new Set(['deploy', 'publish', 'release']);
const wordSource = w => w.replace(/ /g, '\\s+') + (STEM_WORDS.has(w) ? '' : '(?![A-Za-z0-9])');
const DEPLOY_RE = new RegExp(`(?<![A-Za-z0-9])(?:${DEPLOY_WORDS.map(wordSource).join('|')})`, 'i');
export const findDeployWord = text => DEPLOY_RE.exec(text)?.[0].toLowerCase().replace(/\s+/g, ' ') ?? null;

// 배포 설정 파일(이름, 대소문자 무시)·폴더. 루트와 하위 폴더에서 찾는다.
export const DEPLOY_CONFIG_FILES = ['vercel.json', 'netlify.toml', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc',
  'fly.toml', 'render.yaml', 'app.yaml', 'firebase.json', 'procfile'];
export const DEPLOY_CONFIG_DIRS = ['.vercel', '.netlify'];
export const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next']);
export const SCAN_LIMITS = {maxDepth: 4, maxDirs: 2000};
// 다른 저장소의 재사용 workflow(`uses: owner/repo/.github/workflows/…`)와 workflow_run은 연쇄 대상을 볼 수 없다.
const CHAIN_RE = /\bworkflow_run\b|^\s*-?\s*uses:\s*['"]?[^.\s'"/][^\s'"]*\/\.github\/workflows\//m;

export const policyPath = home => path.join(home, POLICY_FILE);

// 손상은 "판별 못 함"과 같게 다룬다: 읽기는 hold, 쓰기는 거절. 다른 값으로 넘어가지 않는다.
export function readPolicy(home) {
  const file = policyPath(home);
  if (!fs.existsSync(file)) return {repos: {}, corrupt: null};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = value && value.version === 1 && value.repos && typeof value.repos === 'object' && !Array.isArray(value.repos)
      && Object.entries(value.repos).every(([name, r]) => REPO_NAME.test(name) && POLICY_VALUES.includes(r?.value));
    if (!ok) throw new Error('모양이 다름');
    return {repos: value.repos, corrupt: null};
  } catch (error) {
    return {repos: {}, corrupt: `밤 저장소 정책 파일 손상: ${POLICY_FILE} (${error.message})`};
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

const readText = file => fs.readFileSync(file, 'utf8');
const lower = s => s.toLowerCase();

// package.json: scripts의 이름·값, 최상위 키 vercel·netlify·publishConfig에 배포 낱말이 있으면 deploy. 깨졌으면 unknown.
function inspectPackage(file, rel, out) {
  out.checked.push(rel);
  let pkg;
  try { pkg = JSON.parse(readText(file)); } catch { out.unknown.push(`${rel}: 읽기 실패 또는 JSON 손상`); return; }
  if (!pkg || typeof pkg !== 'object') { out.unknown.push(`${rel}: JSON 모양이 다름`); return; }
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? Object.entries(pkg.scripts) : [];
  const hit = scripts.map(([k, v]) => findDeployWord(`${k} ${v}`)).find(Boolean)
    ?? ['vercel', 'netlify', 'publishConfig'].find(k => k in pkg);
  if (hit) out.deploy.push({file: rel, word: hit});
}

// .github/workflows 아래 모든 .yml·.yaml(대소문자 무시)을 재귀로 본다. 링크는 따라가지 않고 unknown이다.
function inspectWorkflows(repoPath, out, budget) {
  const base = path.join(repoPath, '.github');
  for (const dir of [base, path.join(base, 'workflows')]) {
    let st;
    try { st = fs.lstatSync(dir); } catch (error) {
      if (error.code === 'ENOENT') return;
      out.unknown.push(`${path.relative(repoPath, dir)}: ${error.code ?? '읽기 실패'}`); return;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) { out.unknown.push(`${path.relative(repoPath, dir)}: 링크라 따라가지 않음`); return; }
  }
  const stack = [path.join(base, 'workflows')];
  while (stack.length) {
    const dir = stack.pop(), relDir = path.relative(repoPath, dir);
    if (++budget.dirs > budget.maxDirs) { out.unknown.push(`${relDir}: 폴더 수 상한 초과`); return; }
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name)); } catch (error) {
      out.unknown.push(`${relDir}: ${error.code ?? '읽기 실패'}`); continue;
    }
    for (const e of entries) {
      const rel = `${relDir}/${e.name}`;
      if (e.isSymbolicLink()) { out.unknown.push(`${rel}: 링크라 따라가지 않음`); continue; }
      if (e.isDirectory()) { stack.push(path.join(dir, e.name)); continue; }
      if (!/\.ya?ml$/i.test(e.name)) continue;
      out.checked.push(rel);
      let text;
      try { text = readText(path.join(dir, e.name)); } catch { out.unknown.push(`${rel}: 읽기 실패`); continue; }
      const word = findDeployWord(text);
      if (word) out.deploy.push({file: rel, word});
      else if (CHAIN_RE.test(text)) out.unknown.push(`${rel}: 다른 workflow로 이어지는 연쇄(workflow_run·외부 재사용)를 볼 수 없음`);
    }
  }
}

// 루트와 하위 폴더의 배포 설정 파일·폴더·package.json. 깊이·폴더 수 상한에 걸리면 unknown이다. 링크는 따라가지 않는다.
function inspectTree(repoPath, out, budget) {
  const queue = [{dir: repoPath, depth: 0}];
  for (let i = 0; i < queue.length; i++) {
    const {dir, depth} = queue[i], relDir = path.relative(repoPath, dir);
    if (++budget.dirs > budget.maxDirs) { out.unknown.push('폴더 수 상한 초과'); return; }
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name)); } catch (error) {
      out.unknown.push(`${relDir || '.'}: ${error.code ?? '읽기 실패'}`); continue;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name, name = lower(e.name);
      if (e.isDirectory() && DEPLOY_CONFIG_DIRS.includes(name)) { out.deploy.push({file: rel, word: name}); continue; }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (depth >= budget.maxDepth) { out.unknown.push(`${rel}: 깊이 상한 초과`); continue; }
        queue.push({dir: path.join(dir, e.name), depth: depth + 1});
        continue;
      }
      if (DEPLOY_CONFIG_FILES.includes(name)) { out.deploy.push({file: rel, word: name}); continue; }
      if (name === 'package.json') {
        if (e.isSymbolicLink()) out.unknown.push(`${rel}: 링크라 따라가지 않음`);
        else inspectPackage(path.join(dir, e.name), rel, out);
      }
    }
  }
}

// 판별은 낱말 신호를 보는 보수 추정이다: deploy(근거 파일들) | clean(찾아본 파일들) | unknown(이유).
// 틀리는 방향은 항상 보류다. 근거 경로는 저장소 기준 상대 경로다. 응답 모양(result·files·reason·checked)은 그대로다.
export function detectDeploy(repoPath, limits = SCAN_LIMITS) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) return {result: 'unknown', reason: '저장소 경로를 모릅니다', checked: []};
  let stat;
  try { stat = fs.statSync(repoPath); } catch { stat = null; }
  if (!stat?.isDirectory()) return {result: 'unknown', reason: '저장소 경로를 읽을 수 없습니다', checked: []};
  const out = {deploy: [], unknown: [], checked: [...DEPLOY_CONFIG_FILES]};
  const budget = {dirs: 0, maxDirs: limits.maxDirs, maxDepth: limits.maxDepth};
  inspectTree(repoPath, out, budget);
  inspectWorkflows(repoPath, out, budget);
  const checked = out.checked;
  if (out.deploy.length) {
    return {result: 'deploy', files: [...new Set(out.deploy.map(d => d.file))].sort(), checked};
  }
  if (out.unknown.length) return {result: 'unknown', reason: out.unknown.join('; '), checked};
  return {result: 'clean', checked};
}

// 최종 판정: merge | hold. 판별 못 하면 보류한다.
export function decide(value, detection) {
  if (value === 'merge') return {action: 'merge', reason: 'repo-policy-merge'};
  if (value === 'hold') return {action: 'hold', reason: 'repo-policy-hold'};
  if (detection.result === 'clean') return {action: 'merge', reason: 'auto-clean'};
  if (detection.result === 'deploy') return {action: 'hold', reason: 'deploy-repo', files: detection.files};
  return {action: 'hold', reason: 'deploy-repo', detail: `판별 못 함: ${detection.reason}`};
}

// 저장소의 지금 정책 한 건: 저장 값·판별·최종 판정. 손상 파일이면 hold(판별 못 함)다.
export function evaluateRepo(home, repo, {repoPath, policy = readPolicy(home)} = {}) {
  const saved = policy.repos[repo] ?? null;
  const value = saved?.value ?? 'auto';
  if (policy.corrupt) return {repo, value: null, saved: null, detection: {result: 'unknown', reason: policy.corrupt, checked: []},
    verdict: {action: 'hold', reason: 'deploy-repo', detail: policy.corrupt}};
  // merge·hold는 판별을 읽지 않아도 정해진다. 그래도 근거를 같이 보이려고 경로가 있으면 판별한다.
  const detection = detectDeploy(repoPath);
  return {repo, value, saved, detection, verdict: decide(value, detection)};
}

// 업무 목록에서 저장소 경로를 찾는다(업무 키 앞부분 = 저장소). 같은 저장소의 경로가 여럿이면 첫 번째다.
export function repoPathFromWorks(works, repo) {
  return works.find(w => String(w.key ?? '').split('/')[0] === repo && typeof w.repoPath === 'string')?.repoPath ?? null;
}

export function listRepos(home, works) {
  const policy = readPolicy(home);
  const names = new Set([...Object.keys(policy.repos), ...works.map(w => String(w.key ?? '').split('/')[0]).filter(n => REPO_NAME.test(n))]);
  return {corrupt: policy.corrupt, repos: [...names].sort().map(repo => evaluateRepo(home, repo, {repoPath: repoPathFromWorks(works, repo), policy}))};
}
