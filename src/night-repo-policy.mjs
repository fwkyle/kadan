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

// 저장소 루트에 있으면 "기본 브랜치 push = 배포" 신호로 보는 설정 파일.
export const DEPLOY_CONFIG_FILES = ['vercel.json', 'netlify.toml', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc',
  'fly.toml', 'render.yaml', 'app.yaml'];
// 워크플로 안에서 배포 단계로 보는 낱말(주석 줄은 뺀다).
export const DEPLOY_WORDS = /\b(deploy|publish|gh-pages|vercel|wrangler|netlify|flyctl|pages-action)\b/i;

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
    return {repos: {}, corrupt: `밤 저장소 정책 파일 손상: ${file} (${error.message})`};
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
    if (current.corrupt) throw new Error(`${current.corrupt} — 파일을 확인한 뒤 고치거나 .trash/로 옮기세요. 읽기는 hold로 봅니다`);
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
const stripComment = line => line.replace(/(^|\s)#.*$/, '');
const indentOf = line => line.length - line.trimStart().length;
const unquote = s => s.trim().replace(/^['"]|['"]$/g, '');

function defaultBranches(repoPath) {
  const names = new Set(['main', 'master']);
  try {
    const head = readText(path.join(repoPath, '.git', 'refs', 'remotes', 'origin', 'HEAD')).trim();
    const m = /^ref:\s*refs\/remotes\/origin\/(.+)$/.exec(head);
    if (m) names.add(m[1]);
  } catch { /* .git이 파일(worktree)이거나 없으면 main·master만 본다 */ }
  return names;
}

const matchesBranch = (token, branches) => token.includes('*') || branches.has(token);

// `on:` 아래 push 블록이 기본 브랜치 push에 반응하는지. true | false | null(판단 못 함).
export function pushesToDefault(text, branches) {
  const lines = text.split(/\r?\n/).map(stripComment);
  const at = lines.findIndex(l => /^(on|"on"|'on'|true)\s*:/.test(l));
  if (at < 0) return null;
  const inline = lines[at].replace(/^[^:]+:/, '').trim();
  if (inline) {
    if (inline.startsWith('{') || inline.startsWith('&') || inline.startsWith('*')) return null;
    return inline.replace(/[[\]]/g, '').split(',').some(w => unquote(w) === 'push') ? true : false;
  }
  const block = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() && indentOf(lines[i]) === 0) break;
    block.push(lines[i]);
  }
  const body = block.filter(l => l.trim());
  if (!body.length) return null;
  const childIndent = indentOf(body[0]);
  if (body[0].trim().startsWith('-')) return body.some(l => unquote(l.trim().replace(/^-\s*/, '')) === 'push') ? true : false;
  const pushAt = body.findIndex(l => indentOf(l) === childIndent && /^push\s*:/.test(l.trim()));
  if (pushAt < 0) return false;
  const pushInline = body[pushAt].trim().replace(/^push\s*:/, '').trim();
  if (pushInline.startsWith('{')) return null;
  const sub = [];
  for (let i = pushAt + 1; i < body.length && indentOf(body[i]) > childIndent; i++) sub.push(body[i]);
  const keyAt = key => sub.findIndex(l => new RegExp(`^${key}\\s*:`).test(l.trim()));
  const tokens = key => {
    const i = keyAt(key);
    if (i < 0) return null;
    const rest = sub[i].trim().replace(new RegExp(`^${key}\\s*:`), '').trim();
    if (rest) return rest.replace(/[[\]]/g, '').split(',').map(unquote).filter(Boolean);
    const out = [];
    for (let j = i + 1; j < sub.length && (indentOf(sub[j]) > indentOf(sub[i]) || sub[j].trim().startsWith('-')); j++)
      if (sub[j].trim().startsWith('-')) out.push(unquote(sub[j].trim().slice(1)));
    return out;
  };
  const branchList = tokens('branches'), ignoreList = tokens('branches-ignore'), tagList = tokens('tags');
  if (branchList) return branchList.some(t => matchesBranch(t, branches));
  if (ignoreList) return ![...branches].some(b => ignoreList.includes(b));
  if (tagList && !sub.some(l => /^(paths|paths-ignore)\s*:/.test(l.trim()))) return false; // 태그 push만 받는다
  return true; // 브랜치 조건이 없으면 모든 브랜치 push에 반응한다
}

// 판별: deploy(근거 파일들) | clean(찾아본 파일들) | unknown(이유). 근거 경로는 저장소 기준 상대 경로다.
export function detectDeploy(repoPath) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) return {result: 'unknown', reason: '저장소 경로를 모릅니다', checked: []};
  let stat;
  try { stat = fs.statSync(repoPath); } catch { stat = null; }
  if (!stat?.isDirectory()) return {result: 'unknown', reason: '저장소 경로를 읽을 수 없습니다', checked: []};
  const checked = [], deploy = [], unknown = [];
  for (const name of DEPLOY_CONFIG_FILES) {
    checked.push(name);
    if (fs.existsSync(path.join(repoPath, name))) deploy.push(name);
  }
  const dir = path.join(repoPath, '.github', 'workflows');
  let flows = [];
  try { flows = fs.readdirSync(dir).filter(f => /\.ya?ml$/i.test(f)).sort(); } catch (error) {
    if (error.code !== 'ENOENT') unknown.push(`.github/workflows: ${error.code ?? '읽기 실패'}`);
  }
  const branches = defaultBranches(repoPath);
  for (const file of flows) {
    const rel = `.github/workflows/${file}`;
    checked.push(rel);
    let text;
    try { text = readText(path.join(dir, file)); } catch { unknown.push(`${rel}: 읽기 실패`); continue; }
    const hasDeploy = text.split(/\r?\n/).some(l => DEPLOY_WORDS.test(stripComment(l)));
    if (!hasDeploy) continue;
    const push = pushesToDefault(text, branches);
    if (push === true) deploy.push(rel);
    else if (push === null) unknown.push(`${rel}: 실행 조건(on)을 판단하지 못함`);
  }
  if (deploy.length) return {result: 'deploy', files: deploy, checked};
  if (unknown.length) return {result: 'unknown', reason: unknown.join('; '), checked};
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
