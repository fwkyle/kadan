import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {nightCommand} from '../src/commands/night.mjs';
import {nightGuard} from '../src/night-guard.mjs';
import {createCenterHandler} from '../src/center-wall.mjs';
import {summarizeNight} from '../src/night-summary.mjs';
import {
  readPolicy, setRepoPolicy, normalizeGithub, parseRemote, parseDeployBranch, loadCards, evaluateGithub, evaluateWork, decideNightMerge,
  listRepos, policyPath, setupNeededLines,
} from '../src/night-repo-policy.mjs';

// 격리 홈·임시 온톨로지 폴더만 쓴다. 운영 홈·실제 온톨로지·포트·GitHub에 닿지 않는다. 역할 이름·저장소 이름도 시험용이다.
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true}); fs.writeFileSync(path.join(root, rel), text); };
// 기본 온톨로지 위치는 비어 있는 임시 폴더다(실제 카드를 읽지 않는다). 시험마다 card()로 채운다.
process.env.KADAN_ONTOLOGY_DIRS = tmp('kadan-onto-empty-');
const ontology = (...dirs) => { process.env.KADAN_ONTOLOGY_DIRS = dirs.join(path.delimiter); };
const card = (dir, name, front, {raw} = {}) => write(dir, `${name}.md`, raw ?? `---\nid: project/${name}\n${front}\n---\n\n## Why\n본문\n`);
const nightOn = home => appendLedger({kind: 'night', phase: 'on', by: '사람', text: '시험', viaChat: false,
  until: new Date(Date.now() + 3600_000).toISOString(), to: [], delivered: [], t: new Date().toISOString()}, home);
const decide = (home, github, baseBranch) => decideNightMerge(home, {github, baseBranch});
const home0 = () => tmp('kadan-repo-policy-');
// 허브 폴더 모양(`<허브>-hub/ontology/cards/project`)을 임시로 만든다.
const hubDir = name => { const d = path.join(tmp('kadan-hubs-'), `${name}-hub`, 'ontology/cards/project'); fs.mkdirSync(d, {recursive: true}); return d; };

test('키: 소문자·끝 .git·끝 / 정규화, 올바르지 않은 키는 거절', () => {
  assert.equal(normalizeGithub('Acme/Site'), 'acme/site');
  assert.equal(normalizeGithub('Acme/Site.git'), 'acme/site');
  assert.equal(normalizeGithub('Acme/Site/'), 'acme/site');
  assert.equal(normalizeGithub(' Acme/Site.git/ '), 'acme/site');
  assert.equal(normalizeGithub('a-b.c_d/e-f.g_h'), 'a-b.c_d/e-f.g_h');
  for (const bad of ['site', 'a/b/c', '/a/b', 'a/', '/b', '/', '../x', 'a/..', 'a/../b', './a', 'a/.', 'a b/c', 'a/b c', '소유자/이름', '', null, undefined, 3])
    assert.equal(normalizeGithub(bad), null, String(bad));
});

test('정책: 값 없음은 null, 저장 키는 정규화돼 원장에 남고, 올바르지 않은 키·auto 쓰기는 거절', () => {
  const home = home0();
  const records = [];
  const record = e => records.push(e);
  assert.deepEqual(readPolicy(home), {repos: {}, legacy: {}, corrupt: null});
  setRepoPolicy(home, {repo: 'Acme/Site.git', value: 'hold', by: '사람', now: () => '2026-11-03T00:00:00.000Z', record});
  setRepoPolicy(home, {repo: 'acme/site/', value: 'merge', by: 'a-감독', now: () => '2026-11-03T01:00:00.000Z', record});
  assert.deepEqual(readPolicy(home).repos['acme/site'], {value: 'merge', at: '2026-11-03T01:00:00.000Z', by: 'a-감독'});
  assert.deepEqual(records.map(r => [r.kind, r.repo, r.before, r.after]), [['night-repo-policy', 'acme/site', null, 'hold'], ['night-repo-policy', 'acme/site', 'hold', 'merge']]);
  assert.equal((fs.statSync(policyPath(home)).mode & 0o777), 0o600);
  assert.throws(() => setRepoPolicy(home, {repo: 'acme/site', value: 'auto', by: '사람'}), /merge\|hold 중 하나/);
  assert.throws(() => setRepoPolicy(home, {repo: 'acme/site', value: 'x', by: '사람'}), /merge\|hold 중 하나/);
  for (const bad of ['site', 'a/b/c', '/a/b', 'a/', '../x', 'a/..']) assert.throws(() => setRepoPolicy(home, {repo: bad, value: 'hold', by: '사람'}), /GitHub 소유자\/이름/, bad);
  assert.equal(readPolicy(home).repos['acme/site'].value, 'merge');
});

test('정책: 손상 파일은 쓰기 거절(파일 그대로), 읽기는 hold', () => {
  const home = home0();
  fs.writeFileSync(policyPath(home), '{깨진');
  assert.throws(() => setRepoPolicy(home, {repo: 'acme/site', value: 'merge', by: '사람'}), /손상/);
  assert.equal(fs.readFileSync(policyPath(home), 'utf8'), '{깨진');
  const info = evaluateGithub(home, 'acme/site');
  assert.deepEqual([info.verdict.action, info.verdict.reason], ['hold', 'setup-needed']);
  assert.match(info.verdict.detail, /손상/);
  for (const repos of [{'acme/site': {value: 'zzz'}}, {'a/b/c': {value: 'hold'}}, {'Acme/Site': {value: 'hold'}}]) {
    fs.writeFileSync(policyPath(home), JSON.stringify({version: 1, repos}));
    assert.ok(readPolicy(home).corrupt, JSON.stringify(repos));
  }
});

test('정책: 옛 형식(맨 이름) 저장값은 덮어쓰기 없음으로 읽고 legacy·list에 따로 보이며, 다시 써도 지우지 않는다. auto는 빠진다', () => {
  const home = home0();
  const onto = tmp('kadan-onto-'), repoPath = tmp('kadan-site-');
  card(onto, 'site', `repo: ${repoPath}\nremote: acme/site\ndeploy_branch: 없음`);
  ontology(onto);
  const entry = {value: 'hold', at: 't', by: '사람'};
  fs.writeFileSync(policyPath(home), JSON.stringify({version: 1, repos: {site: entry, 'acme/old': {...entry, value: 'merge'}, gone: {...entry, value: 'auto'}}}));
  const policy = readPolicy(home);
  assert.equal(policy.corrupt, null);
  assert.deepEqual([Object.keys(policy.repos), Object.keys(policy.legacy)], [['acme/old'], ['site']]);
  const info = evaluateGithub(home, 'acme/site');
  assert.deepEqual([info.value, info.saved, info.verdict.action, info.verdict.reason], [null, null, 'merge', 'ontology-allowed']); // 옛 hold는 무시
  const out = listRepos(home, [{key: 'site/w1', repoPath}]);
  assert.deepEqual(out.legacy, [{name: 'site', value: 'hold', at: 't', by: '사람'}]);
  assert.ok(out.repos.some(r => r.github === 'acme/old' && r.repo === null && r.value === 'merge')); // 업무에 안 나온 저장값도 한 줄
  const text = nightCommand(['repo', 'list'], {}, {home, by: '사람', deps: {readWorks: () => [{key: 'site/w1', repoPath}]}});
  assert.match(text, /옛 형식 저장값\(다시 설정 필요\): site = hold/);
  setRepoPolicy(home, {repo: 'acme/site', value: 'hold', by: '사람'});
  const file = JSON.parse(fs.readFileSync(policyPath(home), 'utf8')).repos;
  assert.deepEqual(Object.keys(file).sort(), ['acme/old', 'acme/site', 'site']); // 옛 키 보존, auto는 빠짐
});

test('remote: 세 형식(github.com/o/n, git@github.com:o/n.git·별칭, 맨 o/n)과 괄호 설명, 그 밖은 null', () => {
  assert.equal(parseRemote('github.com/Acme/Site'), 'acme/site');
  assert.equal(parseRemote('github.com/Acme/Site (공개, 동업자 소유)'), 'acme/site');
  assert.equal(parseRemote('git@github.com:Acme/Site.git'), 'acme/site');
  assert.equal(parseRemote('git@github-personal:Acme/Site.git (비공개)'), 'acme/site');
  assert.equal(parseRemote('Acme/Site (비공개)'), 'acme/site');
  assert.equal(parseRemote('acme/site.git'), 'acme/site');
  for (const none of ['없음 (원격 저장소 미연결)', 'Acme 조직 (a-web, b-web, c)', 'https://github.com/acme/site', 'acme', 'a/b/c', 'github.com/acme', '', undefined])
    assert.equal(parseRemote(none), null, String(none));
});

test('deploy_branch: 낱말 하나(괄호 설명 무시)와 {소유자/이름: 브랜치} 짝 목록만 읽고, 설명 글은 못 읽은 것이다', () => {
  assert.deepEqual(parseDeployBranch('main'), {kind: 'word', value: 'main'});
  assert.deepEqual(parseDeployBranch('없음'), {kind: 'word', value: '없음'});
  assert.deepEqual(parseDeployBranch('main (위 이유로 사실상 운영 브랜치. (괄호) 중첩)'), {kind: 'word', value: 'main'});
  assert.deepEqual(parseDeployBranch('release/prod'), {kind: 'word', value: 'release/prod'});
  assert.deepEqual(parseDeployBranch('{Acme/Web: main, Acme/Admin: 없음}'), {kind: 'map', map: {'acme/web': 'main', 'acme/admin': '없음'}});
  assert.equal(parseDeployBranch(undefined), null);
  const unreadable = {kind: 'unreadable'};
  for (const bad of [
    // 지금 우산 카드의 설명 글 꼴 그대로(고정 fixture)
    'acme-web=main (머지되면 운영 자동 배포). acme-auth·acme-admin=없음 (운영은 prod-* 태그·수동) — 2026-11-03 각 저장소 origin',
    '없음 — 설명이 괄호 없이 이어짐', 'main push 때', '자동', '', '{}', '{Acme/Web: main', '{Acme/Web main}', '{web: main}', '{Acme/Web: main, acme/web: 없음}',
    '{Acme/Web: main (설명)}', '{Acme/Web: }', '{Acme/Web: main,, Acme/Admin: 없음}', 'main, develop'])
    assert.deepEqual(parseDeployBranch(bad), unreadable, bad);
});

test('저장된 merge·hold가 카드보다 우선한다(대상 브랜치가 deploy_branch여도, night_merge 금지여도)', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'a', 'remote: acme/a\ndeploy_branch: main');
  card(onto, 'b', 'remote: acme/b\ndeploy_branch: 없음');
  card(onto, 'c', 'remote: acme/c\ndeploy_branch: 없음\nnight_merge: 금지');
  ontology(onto);
  assert.deepEqual(['acme/a', 'acme/b', 'acme/c'].map(g => decide(home, g, 'main').action), ['hold', 'merge', 'hold']);
  setRepoPolicy(home, {repo: 'acme/a', value: 'merge', by: '사람'});
  setRepoPolicy(home, {repo: 'ACME/B.git', value: 'hold', by: '사람'});
  setRepoPolicy(home, {repo: 'acme/c', value: 'merge', by: '사람'});
  const a = evaluateGithub(home, 'Acme/A', {baseBranch: 'main'});
  assert.deepEqual([a.verdict.action, a.verdict.reason, a.verdict.exceptBranch, a.value], ['merge', 'repo-policy-merge', null, 'merge']);
  assert.deepEqual(decide(home, 'acme/a', 'main').reason, 'repo-policy-merge');
  assert.deepEqual([decide(home, 'acme/b', 'dev').action, decide(home, 'acme/b', 'dev').reason], ['hold', 'repo-policy-hold']);
  assert.deepEqual([decide(home, 'acme/c', 'dev').action, decide(home, 'acme/c', 'dev').reason], ['merge', 'repo-policy-merge']);
  // 카드가 아예 없는 저장소도 저장값이 있으면 그것을 따른다
  setRepoPolicy(home, {repo: 'nobody/nocard', value: 'merge', by: '사람'});
  assert.equal(decide(home, 'nobody/nocard', 'main').action, 'merge');
});

test('낱말 하나 카드: 대상 브랜치 같음→hold, 다름→merge, 없음→어떤 브랜치든 merge, 브랜치를 모르면 hold', () => {
  const home = home0();
  const onto = hubDir('a');
  card(onto, 'main', 'remote: github.com/acme/main-app\ndeploy_branch: main (사실상 운영 브랜치)');
  card(onto, 'none', 'remote: git@github.com:acme/none-app.git\ndeploy_branch: 없음');
  ontology(onto);
  const id = n => `project/${n}`;
  assert.deepEqual(decide(home, 'acme/main-app', 'main'), {action: 'hold', reason: 'deploy-branch', github: 'acme/main-app', card: id('main'), hub: 'a', deployBranch: 'main', nightMerge: null});
  assert.deepEqual(decide(home, 'Acme/Main-App.git', 'staging'), {action: 'merge', reason: 'ontology-allowed', github: 'acme/main-app', card: id('main'), hub: 'a', deployBranch: 'main', nightMerge: null});
  assert.equal(decide(home, 'acme/main-app', 'Main').action, 'merge'); // 브랜치 이름은 대소문자를 구분한다
  for (const base of ['main', 'master', 'dev', undefined]) assert.equal(decide(home, 'acme/none-app', base).action, 'merge', String(base));
  const unknown = decide(home, 'acme/main-app', undefined);
  assert.deepEqual([unknown.action, unknown.reason], ['hold', 'setup-needed']);
  assert.equal(decide(home, 'acme/main-app', '').action, 'hold');
  assert.deepEqual(evaluateGithub(home, 'acme/main-app').verdict, {action: 'merge', reason: 'ontology-allowed', exceptBranch: 'main'});
});

test('짝 목록(우산) 카드: 키가 있으면 그 값, 목록에 없으면 setup-needed, night_merge 금지는 모든 키에 적용', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'umbrella', 'remote: Acme 조직 (web, admin, auth)\ndeploy_branch: {Acme/Web: main, Acme/Admin: 없음}');
  card(onto, 'closed', 'deploy_branch: {Acme/Lock-A: main, Acme/Lock-B: 없음}\nnight_merge: 금지');
  card(onto, 'rem', 'remote: acme/solo\ndeploy_branch: {Acme/Other: main}'); // remote는 맞지만 목록에 키가 없다
  ontology(onto);
  assert.equal(decide(home, 'acme/web', 'main').reason, 'deploy-branch');
  assert.equal(decide(home, 'acme/web', 'dev').reason, 'ontology-allowed');
  assert.deepEqual([decide(home, 'ACME/ADMIN', 'main').action, decide(home, 'acme/admin', 'main').deployBranch], ['merge', '없음']);
  assert.deepEqual(['acme/lock-a', 'acme/lock-b'].map(g => decide(home, g, 'dev').reason), ['ontology-night-merge-forbidden', 'ontology-night-merge-forbidden']);
  const missing = decide(home, 'acme/solo', 'dev');
  assert.deepEqual([missing.action, missing.reason, missing.deployBranch], ['hold', 'setup-needed', null]);
  assert.match(evaluateGithub(home, 'acme/solo').verdict.detail, /목록에 acme\/solo 없음/);
  assert.equal(decide(home, 'acme/unlisted', 'dev').reason, 'setup-needed');
});

test('지금 우산 카드의 설명 글 deploy_branch(고정 fixture)는 setup-needed다', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'umbrella', 'remote: Acme 조직 (customer-web, admin-web, partners)\n'
    + 'deploy_branch: acme-partners-web=main (머지되면 운영 자동 배포). acme-auth·acme-admin-web=없음 (운영은 prod-* 태그·수동) — 2026-11-03 각 저장소 origin');
  card(onto, 'partners', 'remote: Acme/acme-partners-web\ndeploy_branch: acme-partners-web=main (머지되면 운영 자동 배포)');
  ontology(onto);
  const d = decide(home, 'acme/acme-partners-web', 'main');
  assert.deepEqual([d.action, d.reason, d.deployBranch], ['hold', 'setup-needed', null]);
  assert.match(evaluateGithub(home, 'acme/acme-partners-web').verdict.detail, /deploy_branch 형식을 읽을 수 없음/);
  assert.equal(decide(home, 'acme/acme-admin-web', 'dev').reason, 'setup-needed'); // 카드 없음
});

test('카드 찾기: (a) 짝 목록 키가 (b) remote보다 먼저, remote 세 형식, 없음 remote는 안 맞음, 둘 이상 맞으면 setup-needed', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'r1', 'remote: github.com/acme/one (설명)\ndeploy_branch: main');
  card(onto, 'r2', 'remote: git@github-work:acme/two.git\ndeploy_branch: main');
  card(onto, 'r3', 'remote: Acme/Three (설명)\ndeploy_branch: main');
  card(onto, 'norem', 'remote: 없음 (원격 저장소 미연결)\ndeploy_branch: main');
  card(onto, 'both-a', 'deploy_branch: {Acme/Both: main}'); // (a)
  card(onto, 'both-b', 'remote: acme/both\ndeploy_branch: 없음'); // (b)는 (a)가 있으면 쓰지 않는다
  card(onto, 'dup1', 'remote: acme/dup\ndeploy_branch: main');
  card(onto, 'dup2', 'remote: acme/dup\ndeploy_branch: 없음');
  ontology(onto);
  for (const g of ['acme/one', 'acme/two', 'acme/three']) assert.equal(decide(home, g, 'main').reason, 'deploy-branch', g);
  assert.equal(decide(home, 'acme/none', 'main').reason, 'setup-needed');
  assert.equal(decide(home, 'acme/norem', 'main').reason, 'setup-needed');
  const both = decide(home, 'acme/both', 'main');
  assert.deepEqual([both.reason, both.card.endsWith('/both-a')], ['deploy-branch', true]);
  const dup = evaluateGithub(home, 'acme/dup');
  assert.deepEqual([dup.verdict.action, dup.verdict.reason], ['hold', 'setup-needed']);
  assert.match(dup.verdict.detail, /여럿/);
  // 같은 키가 (a) 목록에 두 카드에서 나와도 같다
  const x = tmp('kadan-onto-x-');
  card(x, 'p', 'deploy_branch: {Acme/Same: main}');
  card(x, 'q', 'deploy_branch: {Acme/Same: 없음}');
  ontology(x);
  assert.equal(decide(home, 'acme/same', 'dev').reason, 'setup-needed');
});

test('setup-needed: 카드 없음·잘못된 키·deploy_branch 칸 없음/빈 값·앞머리 깨짐·이상한 night_merge, night_merge보다 먼저 본다', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'nobranch', 'remote: acme/nobranch\ndeploy: 수동');
  card(onto, 'emptybranch', 'remote: acme/emptybranch\ndeploy_branch:');
  card(onto, 'broken', '', {raw: '---\nremote: acme/broken\ndeploy_branch: 없음\n(닫는 줄 없음)\n'});
  card(onto, 'oddnight', 'remote: acme/oddnight\ndeploy_branch: 없음\nnight_merge: 가끔');
  card(onto, 'emptynight', 'remote: acme/emptynight\ndeploy_branch: 없음\nnight_merge:');
  card(onto, 'forbid', 'remote: acme/forbid\nnight_merge: 금지'); // deploy_branch 없음 → 먼저 setup-needed
  ontology(onto);
  for (const g of ['acme/nobranch', 'acme/emptybranch', 'acme/oddnight', 'acme/emptynight', 'acme/forbid', 'acme/nocard', 'bad key', 'site', undefined]) {
    const d = decide(home, g, 'dev');
    assert.deepEqual([d.action, d.reason], ['hold', 'setup-needed'], String(g));
  }
  assert.match(evaluateGithub(home, 'acme/nobranch').verdict.detail, /deploy_branch 칸 없음/);
  assert.match(evaluateGithub(home, 'acme/oddnight').verdict.detail, /night_merge 값을 모름: 가끔/);
  assert.match(evaluateGithub(home, 'acme/nocard').verdict.detail, /카드 없음/);
  assert.match(evaluateGithub(home, 'site').verdict.detail, /소유자\/이름이 올바르지 않음/);
  // 앞머리가 깨진 카드는 remote를 못 읽어 못 찾은 것으로 본다
  assert.match(evaluateGithub(home, 'acme/broken').verdict.detail, /카드 없음/);
});

test('night_merge: 금지면 hold, 칸이 없으면 허용, 허용은 설명이 붙어도 첫 낱말로 읽는다', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'forbid', 'remote: acme/forbid\ndeploy_branch: 없음\nnight_merge: 금지 (동업자 저장소, kyle 말로만 머지)');
  card(onto, 'absent', 'remote: acme/absent\ndeploy_branch: 없음');
  card(onto, 'allow', 'remote: acme/allow\ndeploy_branch: 없음\nnight_merge: 허용 (기본)');
  ontology(onto);
  const f = decide(home, 'acme/forbid', 'dev');
  assert.deepEqual([f.action, f.reason, f.nightMerge, f.deployBranch], ['hold', 'ontology-night-merge-forbidden', '금지', '없음']);
  const a = decide(home, 'acme/absent', 'dev');
  assert.deepEqual([a.action, a.reason, a.nightMerge], ['merge', 'ontology-allowed', null]);
  assert.equal(decide(home, 'acme/allow', 'dev').nightMerge, '허용');
});

test('source의 null 규칙과 github·hub: nightMerge 칸 없음→null, deployBranch 없음→"없음"·칸 없음→null, deploy는 첫 낱말만', () => {
  const home = home0();
  const onto = hubDir('team');
  const p = Object.fromEntries(['full', 'nonight', 'nobranch', 'nodeploy'].map(k => [k, tmp(`kadan-${k}-`)]));
  card(onto, 'full', `repo: ${p.full}\nremote: Acme/Full (공개)\ndeploy: 자동 (main push → Vercel)\ndeploy_branch: main (설명)\nnight_merge: 허용 (기본)`);
  card(onto, 'nonight', `repo: ${p.nonight}\nremote: acme/nonight\ndeploy: 수동 (npm run deploy → …)\ndeploy_branch: 없음`);
  card(onto, 'nobranch', `repo: ${p.nobranch}\nremote: 없음\ndeploy: 없음 (로컬)`);
  card(onto, 'nodeploy', `repo: ${p.nodeploy}\ndeploy_branch: 없음`);
  ontology(onto);
  const one = (key, repoPath) => evaluateWork(home, key, {repoPath})[0];
  assert.deepEqual(one('full', p.full).source,
    {kind: 'ontology', card: 'project/full', hub: 'team', github: 'acme/full', deploy: '자동', deployBranch: 'main', nightMerge: '허용', reason: null});
  assert.deepEqual(one('nonight', p.nonight).source,
    {kind: 'ontology', card: 'project/nonight', hub: 'team', github: 'acme/nonight', deploy: '수동', deployBranch: '없음', nightMerge: null, reason: null});
  assert.deepEqual(one('nobranch', p.nobranch).source,
    {kind: 'none', card: 'project/nobranch', hub: 'team', github: null, deploy: '없음', deployBranch: null, nightMerge: null, reason: 'deploy_branch 칸 없음'});
  assert.deepEqual([one('nodeploy', p.nodeploy).source.deploy, one('nodeploy', p.nodeploy).verdict.action], [null, 'merge']); // deploy 칸 없어도 판정은 deploy_branch로
  assert.deepEqual(one('ghost', tmp('kadan-ghost-')).source,
    {kind: 'none', card: null, hub: null, github: null, deploy: null, deployBranch: null, nightMerge: null, reason: '온톨로지 카드 없음'});
  // 허브 이름: 허브 폴더 모양이면 `-hub`를 뗀 이름, 아니면 null
  assert.equal(loadCards([onto]).cards[0].hub, 'team');
  assert.equal(loadCards([tmp('kadan-plain-')]).cards.length, 0);
  const plain = tmp('kadan-plain-');
  card(plain, 'x', 'deploy_branch: 없음');
  assert.equal(loadCards([plain]).cards[0].hub, null);
});

test('업무 키로 카드 찾기: repo의 ~·끝 /·"(…)" 설명·realpath, 경로 일치가 파일 이름보다 우선, 둘 이상이면 setup-needed', () => {
  const home = home0();
  const onto = tmp('kadan-onto-'), real = tmp('kadan-real-'), other = tmp('kadan-other-');
  const first = (key, repoPath) => evaluateWork(home, key, {repoPath})[0];
  card(onto, 'site', `repo: ${other}\nremote: acme/site\ndeploy_branch: main`); // 이름은 맞지만 경로가 다르다
  card(onto, 'saju', `repo: ${real}/ (설명 문장 (괄호) 뒤는 버린다)\nremote: acme/saju\ndeploy_branch: 없음`);
  ontology(onto);
  const byPath = first('site', real);
  assert.deepEqual([byPath.verdict.action, byPath.source.card.endsWith('/saju'), byPath.github, byPath.repo], ['merge', true, 'acme/saju', 'site']);
  assert.equal(first('site', tmp('kadan-nomatch-')).source.card.endsWith('/site'), true); // 경로 일치가 없으면 파일 이름
  const link = path.join(tmp('kadan-link-'), 'to-real');
  fs.symlinkSync(real, link);
  assert.equal(first('whatever', link).source.card.endsWith('/saju'), true); // 업무 repoPath가 링크여도
  const onto2 = tmp('kadan-onto-link-');
  card(onto2, 'viaLink', `repo: ${link}\ndeploy_branch: 없음`);
  ontology(onto2);
  assert.equal(first('x', real).source.card.endsWith('/viaLink'), true); // 카드 repo가 링크여도
  const onto3 = tmp('kadan-onto-home-');
  card(onto3, 'tilde', 'repo: ~/Dev/kadan-test-tilde-xyz (설명)\ndeploy_branch: 없음');
  ontology(onto3);
  assert.equal(first('tilde', path.join(os.homedir(), 'Dev/kadan-test-tilde-xyz/')).verdict.action, 'merge');
  const dup = tmp('kadan-onto-dup-');
  card(dup, 'one', `repo: ${real}\ndeploy_branch: 없음`);
  card(dup, 'two', `repo: ${real}\ndeploy_branch: 없음`);
  ontology(dup);
  assert.match(first('one', real).verdict.detail, /여럿/);
  const x = tmp('kadan-onto-x-'), y = tmp('kadan-onto-y-');
  card(x, 'site', 'deploy_branch: 없음');
  card(y, 'site', 'deploy_branch: 없음');
  ontology(x, y);
  assert.equal(first('site', tmp('kadan-z-')).verdict.reason, 'setup-needed');
  assert.match(first('site', null).verdict.detail, /경로를 모름/);
});

test('우산 카드 목록: 짝마다 한 줄(repo=업무 키 첫 마디, github=짝 키), 덮어쓰기는 github 키로 찾는다', () => {
  const home = home0();
  const onto = hubDir('co');
  const dir = tmp('kadan-umbrella-'), solo = tmp('kadan-solo-');
  card(onto, 'umbrella', `repo: ${dir} (우산 폴더)\nremote: Acme 조직 (web, admin)\ndeploy: 저장소마다 다름\ndeploy_branch: {Acme/Web: main, Acme/Admin: 없음}\nnight_merge: 허용`);
  card(onto, 'solo', `repo: ${solo}\nremote: acme/solo\ndeploy_branch: main`);
  ontology(onto);
  setRepoPolicy(home, {repo: 'acme/admin', value: 'hold', by: '사람'});
  const works = [{key: 'umb/w1', repoPath: dir}, {key: 'umb/w2', repoPath: dir}, {key: 'solo/w3', repoPath: solo}, {key: 'lost/w4', repoPath: tmp('kadan-lost-')}];
  const {corrupt, repos, legacy} = listRepos(home, works);
  assert.deepEqual([corrupt, legacy], [null, []]);
  assert.deepEqual(repos.map(r => [r.repo, r.github]), [['lost', null], ['solo', 'acme/solo'], ['umb', 'acme/admin'], ['umb', 'acme/web']]);
  const [lost, soloRow, admin, web] = repos;
  assert.deepEqual([admin.value, admin.verdict.reason, admin.source.kind], ['hold', 'repo-policy-hold', 'none']);
  assert.deepEqual(web.verdict, {action: 'merge', reason: 'ontology-allowed', exceptBranch: 'main'});
  assert.deepEqual([web.source.card, web.source.hub, web.source.github, web.source.deploy, web.source.deployBranch], ['project/umbrella', 'co', null, '저장소마다', 'main']);
  assert.deepEqual(soloRow.verdict, {action: 'merge', reason: 'ontology-allowed', exceptBranch: 'main'});
  assert.deepEqual([lost.verdict.reason, lost.source.reason], ['setup-needed', '온톨로지 카드 없음']);
  for (const r of repos) assert.deepEqual(Object.keys(r).sort(), ['github', 'repo', 'saved', 'source', 'value', 'verdict']);
  assert.ok(!JSON.stringify(repos).includes(dir) && !JSON.stringify(repos).includes(onto));
  // 같은 판정을 PR 단위 함수로: 우산 카드 짝마다 값이 다르다
  assert.deepEqual([decide(home, 'acme/web', 'main').action, decide(home, 'acme/web', 'dev').action, decide(home, 'acme/admin', 'dev').action], ['hold', 'merge', 'hold']);
});

test('온톨로지 폴더: 여러 허브(회사 포함)를 찾고, 폴더가 없으면 건너뛰며, 읽을 수 없는 폴더가 있으면 전부 setup-needed', () => {
  const home = home0();
  const personal = hubDir('personal'), company = hubDir('company');
  card(personal, 'other', 'remote: acme/other\ndeploy_branch: main');
  card(company, 'corp', 'remote: acme/corp\ndeploy_branch: main\nnight_merge: 금지');
  ontology(personal, company);
  const d = decideNightMerge(home, {github: 'acme/corp', baseBranch: 'dev'});
  assert.deepEqual([d.reason, d.hub], ['ontology-night-merge-forbidden', 'company']);
  ontology(path.join(personal, 'missing'), company);
  assert.equal(decide(home, 'acme/corp', 'dev').reason, 'ontology-night-merge-forbidden');
  const file = path.join(personal, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  ontology(file, company);
  assert.equal(decide(home, 'acme/corp', 'dev').reason, 'setup-needed');
});

test('아침 요약 줄: 기본값을 못 정해 보류한 저장소만 설정 필요 안내(소유자/이름을 모르면 카드부터)', () => {
  const home = home0();
  const onto = tmp('kadan-onto-'), repoPath = tmp('kadan-ok-');
  card(onto, 'ok', `repo: ${repoPath}\nremote: acme/ok\ndeploy_branch: 없음`);
  ontology(onto);
  setRepoPolicy(home, {repo: 'acme/pinned', value: 'hold', by: '사람'});
  const infos = [evaluateGithub(home, 'acme/ok'), evaluateGithub(home, 'Acme/Ghost'), evaluateGithub(home, 'acme/pinned'), ...evaluateWork(home, 'lost', {repoPath: null})];
  assert.deepEqual(setupNeededLines(infos), ['설정 필요: kadan night repo acme/ghost merge|hold', '설정 필요: lost — 온톨로지 카드의 remote(소유자/이름)부터 채우세요']);
});

test('정책: 손상 문구에는 홈 절대 경로를 넣지 않는다(F7). 쓰기 거절은 CLI용으로 경로를 붙인다', () => {
  const home = home0();
  fs.writeFileSync(policyPath(home), '{깨진');
  const {corrupt} = readPolicy(home);
  assert.match(corrupt, /night-repo-policy\.json/);
  assert.ok(!corrupt.includes(home), corrupt);
  assert.ok(!evaluateGithub(home, 'acme/site').verdict.detail.includes(home));
  assert.throws(() => setRepoPolicy(home, {repo: 'acme/site', value: 'hold', by: '사람'}), e => e.message.includes(home));
});

test('CLI 명령: 저장·list·show(소유자/이름·업무 키)·옛 형식 안내·기본값 근거(카드 id만)', () => {
  const home = home0();
  const onto = hubDir('team');
  const site = tmp('kadan-site-'), docs = tmp('kadan-docs-'), umb = tmp('kadan-umb-');
  card(onto, 'site', `repo: ${site}\nremote: acme/site\ndeploy: 자동 (Vercel)\ndeploy_branch: main`);
  card(onto, 'docs', `repo: ${docs}\nremote: acme/docs\ndeploy: 없음\ndeploy_branch: 없음`);
  card(onto, 'umb', `repo: ${umb}\ndeploy_branch: {Acme/One: main, Acme/Two: 없음}`);
  ontology(onto);
  const works = [{key: 'site/w1', status: 'open', repoPath: site}, {key: 'docs/w2', status: 'open', repoPath: docs}, {key: 'umb/w3', repoPath: umb}];
  const run = (args, flags = {}, by = '사람') => nightCommand(['repo', ...args], flags, {home, by, deps: {readWorks: () => works}});
  assert.match(run(['show', 'Acme/Site']), /acme\/site: 저장 값 없음[\s\S]*기본값 근거 카드 team:project\/site deploy_branch main[\s\S]*최종 판정 머지 \(ontology-allowed, main으로 가는 PR만 보류\)/);
  assert.match(run(['show', 'site']), /acme\/site \[업무 site\]: 저장 값 없음/);
  assert.match(run(['show', 'umb']), /acme\/one [\s\S]*acme\/two /);
  assert.match(run(['show', 'docs']), /acme\/docs: 최종 판정 머지 \(ontology-allowed\)/);
  assert.match(run(['Acme/Site.git', 'merge']), /저장: acme\/site = merge \(이전 없음\)[\s\S]*최종 판정 머지 \(repo-policy-merge\)/);
  const list = run(['list']);
  assert.match(list, /acme\/site \[업무 site\]: 저장 값 merge/);
  assert.match(list, /acme\/docs \[업무 docs\]: 저장 값 없음/);
  assert.ok(!list.includes(onto) && !list.includes(site), list); // 절대 경로를 보이지 않는다
  assert.match(run(['show', 'ghost']), /ghost: 최종 판정 보류 \(setup-needed, 저장소 경로를 모름\)/);
  assert.match(run(['show', 'ghost'], {'repo-path': tmp('kadan-nocard-')}), /ghost: 최종 판정 보류 \(setup-needed, 온톨로지 카드 없음\)/);
  assert.match(run([]), /사용법: kadan night repo <소유자\/이름> merge\|hold /);
  assert.throws(() => run(['acme/site']), /값이 필요/);
  assert.throws(() => run(['site', 'merge']), /GitHub 소유자\/이름/);
  assert.throws(() => run(['acme/site', 'auto']), /merge\|hold 중 하나/);
  assert.throws(() => run(['show', 'a/b/c']), /GitHub 소유자\/이름/);
  assert.throws(() => run(['show']), /저장소 이름/);
  assert.deepEqual(readLedger(home).filter(e => e.kind === 'night-repo-policy').map(e => [e.repo, e.after]), [['acme/site', 'merge']]);
});

test('nightGuard: 켜짐+역할 세션의 night repo 쓰기는 거절, list·show·인자 없음은 통과, 꺼짐·사람은 통과', () => {
  const home = tmp('kadan-repo-guard-');
  const env = {KADAN_ROLE: 'a-작업자'};
  const call = (args, e = env) => nightGuard({command: 'night', args, flags: {}, home, env: e});
  call(['repo', 'acme/kadan', 'merge']); // 꺼져 있으면 통과
  nightOn(home);
  assert.throws(() => call(['repo', 'acme/kadan', 'merge']), error => error.exitCode === 2 && /night repo acme\/kadan/.test(error.message));
  assert.throws(() => call(['repo', 'acme/kadan']), /나이트 모드가 켜져 있어/);
  call(['repo']);
  call(['repo', 'list']);
  call(['repo', 'show', 'acme/kadan']);
  call(['repo', 'acme/kadan', 'merge'], {}); // 사람(역할 없음)
});

test('CLI 실행: 켜짐+역할 세션의 쓰기는 종료 2·저장 안 됨, 읽기는 통과, 사람은 저장', () => {
  const home = tmp('kadan-repo-cli2-');
  nightOn(home);
  const run = (argv, role) => spawnSync(process.execPath, [CLI, ...argv], {
    env: {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none', KADAN_ROLE: role ?? ''}, encoding: 'utf8', timeout: 20_000});
  const denied = run(['night', 'repo', 'acme/kadan', 'merge'], 'a-작업자');
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /나이트 모드가 켜져 있어/);
  assert.equal(fs.existsSync(policyPath(home)), false);
  const read = run(['night', 'repo', 'list'], 'a-작업자');
  assert.equal(read.status, 0, read.stderr);
  const human = run(['night', 'repo', 'Acme/Kadan', 'hold']);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(readPolicy(home).repos['acme/kadan'].value, 'hold');
  assert.equal(run(['night', 'repo', 'kadan', 'hold']).status, 1); // 맨 이름은 거절
});

function fakeReq(method, pathname, {body = '', remote = false, origin, host = '127.0.0.1:1'} = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  const req = {method, url: pathname, headers: {host, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(origin ? {origin} : {})}, kadanRemote: remote || undefined,
    async *[Symbol.asyncIterator]() { yield* chunks; }};
  return req;
}
async function call(handler, req) {
  const out = {status: null, body: ''};
  const res = {writeHead(status) { out.status = status; }, end(text = '') { out.body += text; }};
  const handled = await handler.handle(req, res, new URL(req.url, 'http://127.0.0.1'));
  return {handled, ...out};
}
const form = (handler, fields) => new URLSearchParams({token: handler.token, ...fields}).toString();

test('API: GET 모양, POST는 토큰·출처·원격 검사를 받고 나이트 켜짐이면 409(저장 안 됨), 꺼짐이면 소유자/이름으로 저장', async () => {
  const home = tmp('kadan-repo-api-');
  const handler = createCenterHandler(home);
  const get = await call(handler, fakeReq('GET', '/api/night/repos'));
  assert.equal(get.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(get.body)), ['corrupt', 'repos', 'legacy']);
  assert.deepEqual(JSON.parse(get.body).repos, []);

  const post = (fields, opts) => call(handler, fakeReq('POST', '/api/night/repos', {body: form(handler, fields), ...opts}));
  assert.equal((await call(handler, fakeReq('POST', '/api/night/repos', {body: new URLSearchParams({repo: 'acme/site', value: 'hold'}).toString()}))).status, 403); // 토큰 없음
  assert.equal((await post({repo: 'acme/site', value: 'hold'}, {origin: 'http://evil.example'})).status, 403);
  assert.equal((await post({repo: 'acme/site', value: 'hold'}, {remote: true})).status, 405);
  assert.equal(fs.existsSync(policyPath(home)), false);

  nightOn(home);
  const blocked = await post({repo: 'acme/site', value: 'hold'});
  assert.equal(blocked.status, 409);
  assert.match(blocked.body, /나이트가 켜진 동안은 바꿀 수 없음/);
  assert.equal(fs.existsSync(policyPath(home)), false);

  const off = tmp('kadan-repo-api-off-');
  const handler2 = createCenterHandler(off);
  const ok = await call(handler2, fakeReq('POST', '/api/night/repos', {body: form(handler2, {repo: 'Acme/Site.git', value: 'hold'})}));
  assert.equal(ok.status, 200);
  assert.equal(readPolicy(off).repos['acme/site'].value, 'hold');
  assert.equal(readPolicy(off).repos['acme/site'].by, '사람');
  for (const bad of [{repo: 'acme/site', value: 'zzz'}, {repo: 'site', value: 'hold'}, {repo: 'acme/site', value: 'auto'}]) {
    const r = await call(handler2, fakeReq('POST', '/api/night/repos', {body: form(handler2, bad)}));
    assert.equal(r.status, 409, JSON.stringify(bad));
  }
  assert.equal(readPolicy(off).repos['acme/site'].value, 'hold');
  const body = JSON.parse((await call(handler2, fakeReq('GET', '/api/night/repos'))).body);
  assert.equal(body.repos[0].verdict.action, 'hold');
  assert.deepEqual(Object.keys(body.repos[0]).sort(), ['github', 'repo', 'saved', 'source', 'value', 'verdict']);
  assert.deepEqual(Object.keys(body.repos[0].source), ['kind', 'card', 'hub', 'github', 'deploy', 'deployBranch', 'nightMerge', 'reason']);
  assert.deepEqual(Object.keys(body.repos[0].verdict).sort(), ['action', 'exceptBranch', 'reason']);
  assert.ok(!JSON.stringify(body).includes(off));
});

test('API 응답 모양: 일반 카드·우산 카드·설정 필요(원문 예), 절대 경로 없음', () => {
  const home = tmp('kadan-repo-shape-');
  const onto = hubDir('team');
  const shop = tmp('kadan-shop-'), umb = tmp('kadan-umb-');
  card(onto, 'shop', `repo: ${shop}\nremote: Acme/Shop (비공개)\ndeploy: 수동 (npm run deploy)\ndeploy_branch: main`);
  card(onto, 'umb', `repo: ${umb}\ndeploy: 저장소마다 다름\ndeploy_branch: {Acme/Web: main, Acme/Admin: 없음}\nnight_merge: 금지`);
  ontology(onto);
  const out = listRepos(home, [{key: 'shop/w1', repoPath: shop}, {key: 'umb/w2', repoPath: umb}, {key: 'ghost/w3', repoPath: tmp('kadan-g-')}]);
  assert.deepEqual(Object.keys(out), ['corrupt', 'repos', 'legacy']);
  assert.deepEqual(out.repos[0], {repo: 'ghost', github: null, value: null, saved: null,
    source: {kind: 'none', card: null, hub: null, github: null, deploy: null, deployBranch: null, nightMerge: null, reason: '온톨로지 카드 없음'},
    verdict: {action: 'hold', reason: 'setup-needed', detail: '온톨로지 카드 없음', exceptBranch: null}});
  assert.deepEqual(out.repos[1], {repo: 'shop', github: 'acme/shop', value: null, saved: null,
    source: {kind: 'ontology', card: 'project/shop', hub: 'team', github: 'acme/shop', deploy: '수동', deployBranch: 'main', nightMerge: null, reason: null},
    verdict: {action: 'merge', reason: 'ontology-allowed', exceptBranch: 'main'}});
  assert.deepEqual(out.repos.slice(2).map(r => [r.repo, r.github, r.source.deployBranch, r.verdict.action, r.verdict.reason]),
    [['umb', 'acme/admin', '없음', 'hold', 'ontology-night-merge-forbidden'], ['umb', 'acme/web', 'main', 'hold', 'ontology-night-merge-forbidden']]);
  assert.ok(!JSON.stringify(out).includes(onto) && !JSON.stringify(out).includes(shop));
});

test('아침 요약: 배포 저장소 보류 PR이 근거 파일과 함께 따로 보인다', () => {
  const T0 = Date.parse('2026-11-03T14:00:00.000Z');
  const start = {kind: 'night', phase: 'on', by: '사람', text: '밤', viaChat: false, t: new Date(T0).toISOString(), until: new Date(T0 + 8 * 3600_000).toISOString(), to: [], delivered: []};
  const hold = {kind: 'night-note', noteKind: 'hold', text: '사이트 PR 보류', by: 'a-감독', t: new Date(T0 + 60_000).toISOString(),
    holdKind: 'deploy-repo', pr: 'site#7', reason: 'vercel.json'};
  const s = summarizeNight({start, phase: 'expired', endedAt: T0 + 8 * 3600_000, entries: [hold], decisionEvents: [], readBody: () => null});
  assert.match(s.text, /배포 저장소 보류[^\n]*site#7[^\n]*근거: vercel\.json/);
  assert.equal(s.counts.noteHolds['deploy-repo'], 1);
});

test('정책 F7: 읽기 권한 오류 문구에도 절대 경로가 없다(파일 이름과 오류 코드만)', () => {
  const home = tmp('kadan-repo-policy-');
  setRepoPolicy(home, {repo: 'acme/site', value: 'hold', by: '사람'});
  fs.chmodSync(policyPath(home), 0o000);
  try {
    const {corrupt} = readPolicy(home);
    assert.match(corrupt, /night-repo-policy\.json \(EACCES\)/);
    assert.ok(!corrupt.includes(home), corrupt);
    assert.ok(!JSON.stringify(evaluateGithub(home, 'acme/site')).includes(home));
  } finally { fs.chmodSync(policyPath(home), 0o600); }
});
