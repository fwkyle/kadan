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
import {readPolicy, setRepoPolicy, evaluateRepo, decideNightMerge, listRepos, policyPath, setupNeededLines} from '../src/night-repo-policy.mjs';

// 격리 홈·임시 온톨로지 폴더만 쓴다. 운영 홈·실제 온톨로지·포트·GitHub에 닿지 않는다. 역할 이름도 시험용이다.
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true}); fs.writeFileSync(path.join(root, rel), text); };
// 기본 온톨로지 위치는 비어 있는 임시 폴더다(실제 카드를 읽지 않는다). 시험마다 card()로 채운다.
const EMPTY_ONTOLOGY = tmp('kadan-onto-empty-');
process.env.KADAN_ONTOLOGY_DIRS = EMPTY_ONTOLOGY;
const ontology = (...dirs) => { process.env.KADAN_ONTOLOGY_DIRS = dirs.join(path.delimiter); };
const card = (dir, name, front, {raw} = {}) => write(dir, `${name}.md`, raw ?? `---\nid: project/${name}\n${front}\n---\n\n## Why\n본문\n`);
const nightOn = home => appendLedger({kind: 'night', phase: 'on', by: '사람', text: '시험', viaChat: false,
  until: new Date(Date.now() + 3600_000).toISOString(), to: [], delivered: [], t: new Date().toISOString()}, home);
const ev = (home, repo, repoPath) => evaluateRepo(home, repo, {repoPath});

test('정책: 값 없음은 null(기본값은 카드), 저장·읽기·덮어쓰기와 원장 한 줄, auto 쓰기는 거절', () => {
  const home = tmp('kadan-repo-policy-');
  const records = [];
  const record = e => records.push(e);
  assert.deepEqual(readPolicy(home), {repos: {}, corrupt: null});
  assert.equal(ev(home, 'site', null).value, null);
  setRepoPolicy(home, {repo: 'site', value: 'hold', by: '사람', now: () => '2026-11-03T00:00:00.000Z', record});
  setRepoPolicy(home, {repo: 'site', value: 'merge', by: 'a-감독', now: () => '2026-11-03T01:00:00.000Z', record});
  assert.deepEqual(readPolicy(home).repos.site, {value: 'merge', at: '2026-11-03T01:00:00.000Z', by: 'a-감독'});
  assert.deepEqual(records.map(r => [r.kind, r.before, r.after]), [['night-repo-policy', null, 'hold'], ['night-repo-policy', 'hold', 'merge']]);
  assert.equal((fs.statSync(policyPath(home)).mode & 0o777), 0o600);
  assert.throws(() => setRepoPolicy(home, {repo: 'site', value: 'auto', by: '사람'}), /merge\|hold 중 하나/);
  assert.throws(() => setRepoPolicy(home, {repo: 'site', value: 'x', by: '사람'}), /merge\|hold 중 하나/);
  assert.throws(() => setRepoPolicy(home, {repo: '../x', value: 'hold', by: '사람'}), /저장소 이름/);
  assert.equal(readPolicy(home).repos.site.value, 'merge');
});

test('정책: 손상 파일은 쓰기 거절(파일 그대로), 읽기는 hold', () => {
  const home = tmp('kadan-repo-policy-');
  fs.writeFileSync(policyPath(home), '{깨진');
  assert.throws(() => setRepoPolicy(home, {repo: 'site', value: 'merge', by: '사람'}), /손상/);
  assert.equal(fs.readFileSync(policyPath(home), 'utf8'), '{깨진');
  const info = ev(home, 'site', tmp('kadan-clean-repo-'));
  assert.equal(info.verdict.action, 'hold');
  assert.match(info.verdict.detail, /손상/);
  fs.writeFileSync(policyPath(home), JSON.stringify({version: 1, repos: {site: {value: 'zzz'}}}));
  assert.ok(readPolicy(home).corrupt);
});

test('정책: 예전 파일의 auto 저장값은 저장값 없음으로 읽고, 다시 쓸 때 빠진다', () => {
  const home = tmp('kadan-repo-policy-');
  const onto = tmp('kadan-onto-'), repoPath = tmp('kadan-site-');
  card(onto, 'site', `repo: ${repoPath}\ndeploy: 수동 (npm run deploy)\ndeploy_branch: 없음`);
  ontology(onto);
  fs.writeFileSync(policyPath(home), JSON.stringify({version: 1, repos: {site: {value: 'auto', at: 't', by: '사람'}, docs: {value: 'hold', at: 't', by: '사람'}}}));
  assert.equal(readPolicy(home).corrupt, null);
  assert.deepEqual(Object.keys(readPolicy(home).repos), ['docs']);
  const info = ev(home, 'site', repoPath);
  assert.deepEqual([info.value, info.saved, info.verdict.action, info.verdict.reason], [null, null, 'merge', 'ontology-allowed']);
  const saved = setRepoPolicy(home, {repo: 'site', value: 'hold', by: '사람'});
  assert.equal(saved.before, null);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(policyPath(home), 'utf8')).repos).sort(), ['docs', 'site']);
});

test('저장된 merge·hold가 카드보다 우선한다(대상 브랜치가 deploy_branch여도 merge)', () => {
  const home = tmp('kadan-repo-policy-');
  const onto = tmp('kadan-onto-'), a = tmp('kadan-a-'), b = tmp('kadan-b-'), c = tmp('kadan-c-');
  card(onto, 'a', `repo: ${a}\ndeploy_branch: main`);
  card(onto, 'b', `repo: ${b}\ndeploy_branch: 없음`);
  card(onto, 'c', `repo: ${c}\ndeploy_branch: 없음\nnight_merge: 금지`);
  ontology(onto);
  assert.deepEqual([ev(home, 'a', a).verdict.action, ev(home, 'b', b).verdict.action, ev(home, 'c', c).verdict.action], ['merge', 'merge', 'hold']);
  setRepoPolicy(home, {repo: 'a', value: 'merge', by: '사람'});
  setRepoPolicy(home, {repo: 'b', value: 'hold', by: '사람'});
  setRepoPolicy(home, {repo: 'c', value: 'merge', by: '사람'});
  const a1 = evaluateRepo(home, 'a', {repoPath: a, baseBranch: 'main'});
  assert.deepEqual([a1.verdict.action, a1.verdict.reason, a1.verdict.exceptBranch], ['merge', 'repo-policy-merge', null]);
  assert.deepEqual(decideNightMerge(home, 'a', {repoPath: a, baseBranch: 'main'}).reason, 'repo-policy-merge');
  assert.deepEqual([ev(home, 'b', b).verdict.action, ev(home, 'b', b).verdict.reason], ['hold', 'repo-policy-hold']);
  assert.deepEqual([ev(home, 'c', c).verdict.action, ev(home, 'c', c).verdict.reason], ['merge', 'repo-policy-merge']);
  assert.equal(decideNightMerge(home, 'b', {repoPath: b, baseBranch: 'feature'}).action, 'hold');
});

test('setup-needed: 카드 없음·경로 모름·deploy_branch 칸 없음/빈 값·앞머리 깨짐·이상한 night_merge는 hold이고 night_merge보다 먼저 본다', () => {
  const home = tmp('kadan-repo-policy-');
  const onto = tmp('kadan-onto-');
  const names = ['nobranch', 'emptybranch', 'broken', 'oddnight', 'emptynight', 'nocard', 'forbid'];
  const paths = Object.fromEntries(names.map(k => [k, tmp(`kadan-${k}-`)]));
  card(onto, 'nobranch', `repo: ${paths.nobranch}\ndeploy: 수동`);
  card(onto, 'emptybranch', `repo: ${paths.emptybranch}\ndeploy_branch:`);
  card(onto, 'broken', '', {raw: `---\nrepo: ${paths.broken}\ndeploy_branch: 없음\n(닫는 줄 없음)\n`});
  card(onto, 'oddnight', `repo: ${paths.oddnight}\ndeploy_branch: 없음\nnight_merge: 가끔`);
  card(onto, 'emptynight', `repo: ${paths.emptynight}\ndeploy_branch: 없음\nnight_merge:`);
  card(onto, 'forbid', `repo: ${paths.forbid}\nnight_merge: 금지`); // deploy_branch 없음 → 규칙 2가 먼저
  ontology(onto);
  for (const name of names) {
    const info = ev(home, name, paths[name]);
    assert.deepEqual([info.verdict.action, info.verdict.reason, info.source.kind], ['hold', 'setup-needed', 'none'], `${name}: ${JSON.stringify(info)}`);
    assert.equal(decideNightMerge(home, name, {repoPath: paths[name], baseBranch: 'dev'}).reason, 'setup-needed', name);
  }
  assert.match(ev(home, 'nobranch', paths.nobranch).verdict.detail, /deploy_branch 칸 없음/);
  assert.match(ev(home, 'oddnight', paths.oddnight).verdict.detail, /night_merge 값을 모름: 가끔/);
  assert.match(ev(home, 'nocard', null).verdict.detail, /경로를 모름/);
  assert.match(ev(home, 'nocard', paths.nocard).verdict.detail, /카드 없음/);
});

test('night_merge: 금지면 hold, 칸이 없으면 허용, 허용은 설명이 붙어도 첫 낱말로 읽는다', () => {
  const home = tmp('kadan-repo-policy-');
  const onto = tmp('kadan-onto-');
  const p = Object.fromEntries(['forbid', 'absent', 'allow'].map(k => [k, tmp(`kadan-${k}-`)]));
  card(onto, 'forbid', `repo: ${p.forbid}\ndeploy_branch: 없음\nnight_merge: 금지 (동업자 저장소, kyle 말로만 머지)`);
  card(onto, 'absent', `repo: ${p.absent}\ndeploy_branch: 없음`);
  card(onto, 'allow', `repo: ${p.allow}\ndeploy_branch: 없음\nnight_merge: 허용 (기본)`);
  ontology(onto);
  const f = decideNightMerge(home, 'forbid', {repoPath: p.forbid, baseBranch: 'dev'});
  assert.deepEqual([f.action, f.reason, f.nightMerge, f.deployBranch], ['hold', 'ontology-night-merge-forbidden', '금지', '없음']);
  assert.equal(ev(home, 'forbid', p.forbid).verdict.reason, 'ontology-night-merge-forbidden');
  const a = decideNightMerge(home, 'absent', {repoPath: p.absent, baseBranch: 'dev'});
  assert.deepEqual([a.action, a.reason, a.nightMerge], ['merge', 'ontology-allowed', null]);
  assert.deepEqual(decideNightMerge(home, 'allow', {repoPath: p.allow, baseBranch: 'dev'}).nightMerge, '허용');
});

test('대상 브랜치: deploy_branch와 같으면 hold, 다르면 merge, 없음이면 어떤 브랜치든 merge, 브랜치를 모르면 hold', () => {
  const home = tmp('kadan-repo-policy-');
  const onto = tmp('kadan-onto-');
  const main = tmp('kadan-main-'), none = tmp('kadan-none-');
  card(onto, 'main', `repo: ${main}\ndeploy_branch: main (위 이유로 사실상 운영 브랜치)`);
  card(onto, 'none', `repo: ${none}\ndeploy_branch: 없음`);
  ontology(onto);
  const d = (repo, repoPath, baseBranch) => decideNightMerge(home, repo, {repoPath, baseBranch});
  assert.deepEqual(d('main', main, 'main'), {action: 'hold', reason: 'deploy-branch', card: `${path.basename(onto)}/main`, deployBranch: 'main', nightMerge: null});
  assert.deepEqual(d('main', main, 'staging'), {action: 'merge', reason: 'ontology-allowed', card: `${path.basename(onto)}/main`, deployBranch: 'main', nightMerge: null});
  assert.equal(d('main', main, 'Main').action, 'merge'); // 브랜치 이름은 대소문자를 구분한다
  for (const base of ['main', 'master', 'dev']) assert.equal(d('none', none, base).action, 'merge', base);
  assert.equal(d('none', none, undefined).action, 'merge'); // 없음이면 대상 브랜치를 몰라도 어떤 브랜치와도 같지 않다
  const unknown = d('main', main, undefined);
  assert.deepEqual([unknown.action, unknown.reason], ['hold', 'setup-needed']);
  assert.equal(d('main', main, '').action, 'hold');
  // 저장소 단위(API): merge + exceptBranch
  const repoLevel = ev(home, 'main', main).verdict;
  assert.deepEqual(repoLevel, {action: 'merge', reason: 'ontology-allowed', exceptBranch: 'main'});
  assert.equal(ev(home, 'none', none).verdict.exceptBranch, null);
});

test('source의 null 규칙: nightMerge 칸 없음→null, deployBranch 없음→"없음"·칸 없음→null, deploy는 첫 낱말만', () => {
  const home = tmp('kadan-repo-policy-');
  const onto = tmp('kadan-onto-');
  const p = Object.fromEntries(['full', 'nonight', 'nobranch', 'nodeploy'].map(k => [k, tmp(`kadan-${k}-`)]));
  card(onto, 'full', `repo: ${p.full}\ndeploy: 자동 (main push → Vercel)\ndeploy_branch: main (설명)\nnight_merge: 허용 (기본)`);
  card(onto, 'nonight', `repo: ${p.nonight}\ndeploy: 수동 (npm run deploy → …)\ndeploy_branch: 없음`);
  card(onto, 'nobranch', `repo: ${p.nobranch}\ndeploy: 없음 (로컬)`);
  card(onto, 'nodeploy', `repo: ${p.nodeploy}\ndeploy_branch: 없음`);
  ontology(onto);
  const id = n => `${path.basename(onto)}/${n}`;
  assert.deepEqual(ev(home, 'full', p.full).source, {kind: 'ontology', card: id('full'), deploy: '자동', deployBranch: 'main', nightMerge: '허용', reason: null});
  assert.deepEqual(ev(home, 'nonight', p.nonight).source, {kind: 'ontology', card: id('nonight'), deploy: '수동', deployBranch: '없음', nightMerge: null, reason: null});
  assert.deepEqual(ev(home, 'nobranch', p.nobranch).source,
    {kind: 'none', card: id('nobranch'), deploy: '없음', deployBranch: null, nightMerge: null, reason: 'deploy_branch 칸 없음'});
  assert.equal(ev(home, 'nodeploy', p.nodeploy).source.deploy, null); // deploy 칸이 없어도 판정은 deploy_branch로 한다
  assert.equal(ev(home, 'nodeploy', p.nodeploy).verdict.action, 'merge');
  assert.deepEqual(ev(home, 'ghost', tmp('kadan-ghost-')).source, {kind: 'none', card: null, deploy: null, deployBranch: null, nightMerge: null, reason: '온톨로지 카드 없음'});
});

test('카드 고르기: repo의 ~·끝 /·"(…)" 설명·realpath를 처리하고, 경로 일치가 파일 이름보다 우선하며, 둘 이상 맞으면 hold', () => {
  const home = tmp('kadan-repo-policy-');
  const onto = tmp('kadan-onto-'), real = tmp('kadan-real-'), other = tmp('kadan-other-');
  // 이름은 맞지만 경로가 다른 카드 vs 경로가 맞는 카드(oneul-gyeol 꼴).
  card(onto, 'site', `repo: ${other}\ndeploy_branch: main`);
  card(onto, 'saju', `repo: ${real}/ (설명 문장 (괄호) 뒤는 버린다)\ndeploy_branch: 없음`);
  ontology(onto);
  const byPath = ev(home, 'site', real);
  assert.deepEqual([byPath.verdict.action, byPath.source.card.endsWith('/saju')], ['merge', true]);
  assert.equal(ev(home, 'site', tmp('kadan-nomatch-')).source.card.endsWith('/site'), true); // 경로 일치가 없으면 파일 이름
  // realpath: 업무 repoPath가 심볼릭 링크여도 같은 카드다.
  const link = path.join(tmp('kadan-link-'), 'to-real');
  fs.symlinkSync(real, link);
  assert.equal(ev(home, 'whatever', link).source.card.endsWith('/saju'), true);
  // 카드 repo가 링크여도 같다.
  const onto2 = tmp('kadan-onto-link-');
  card(onto2, 'viaLink', `repo: ${link}\ndeploy_branch: 없음`);
  ontology(onto2);
  assert.equal(ev(home, 'x', real).source.card.endsWith('/viaLink'), true);
  // ~ 펼침
  const onto3 = tmp('kadan-onto-home-');
  card(onto3, 'tilde', 'repo: ~/Dev/kadan-test-tilde-xyz (설명)\ndeploy_branch: 없음');
  ontology(onto3);
  assert.equal(ev(home, 'tilde', path.join(os.homedir(), 'Dev/kadan-test-tilde-xyz/')).verdict.action, 'merge');
  // 같은 경로를 가리키는 카드가 둘이면 hold
  const dup = tmp('kadan-onto-dup-');
  card(dup, 'one', `repo: ${real}\ndeploy_branch: 없음`);
  card(dup, 'two', `repo: ${real}\ndeploy_branch: 없음`);
  ontology(dup);
  const two = ev(home, 'one', real);
  assert.deepEqual([two.verdict.action, two.verdict.reason], ['hold', 'setup-needed']);
  assert.match(two.verdict.detail, /여럿/);
  // 이름만 같은 카드가 둘(두 허브에 같은 파일 이름)도 같다.
  const x = tmp('kadan-onto-x-'), y = tmp('kadan-onto-y-');
  card(x, 'site', 'deploy_branch: 없음');
  card(y, 'site', 'deploy_branch: 없음');
  ontology(x, y);
  assert.equal(ev(home, 'site', tmp('kadan-z-')).verdict.reason, 'setup-needed');
});

test('회사 허브 폴더의 카드도 찾는다', () => {
  const home = tmp('kadan-repo-policy-');
  const personal = tmp('kadan-onto-personal-'), company = tmp('kadan-onto-company-');
  const repoPath = tmp('kadan-co-');
  card(personal, 'other', 'repo: /nonexistent/other\ndeploy_branch: main');
  card(company, 'corp', `repo: ${repoPath}\ndeploy_branch: main\nnight_merge: 금지`);
  ontology(personal, company);
  const info = ev(home, 'corp', repoPath);
  assert.deepEqual([info.verdict.action, info.verdict.reason], ['hold', 'ontology-night-merge-forbidden']);
  // 폴더가 없어도(ENOENT) 다른 폴더는 읽는다. 읽을 수 없는 폴더(파일 하나)가 있으면 전부 setup-needed다.
  ontology(path.join(personal, 'missing'), company);
  assert.equal(ev(home, 'corp', repoPath).verdict.reason, 'ontology-night-merge-forbidden');
  const file = path.join(personal, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  ontology(file, company);
  assert.equal(ev(home, 'corp', repoPath).verdict.reason, 'setup-needed');
});

test('아침 요약 줄: 기본값을 못 정해 보류한 저장소만 설정 필요 안내', () => {
  const home = tmp('kadan-repo-policy-');
  const onto = tmp('kadan-onto-'), repoPath = tmp('kadan-ok-');
  card(onto, 'ok', `repo: ${repoPath}\ndeploy_branch: 없음`);
  ontology(onto);
  setRepoPolicy(home, {repo: 'pinned', value: 'hold', by: '사람'});
  const infos = ['ok', 'ghost', 'pinned', 'second'].map(r => ev(home, r, r === 'ok' ? repoPath : null));
  assert.deepEqual(setupNeededLines(infos), ['설정 필요: kadan night repo ghost merge|hold', '설정 필요: kadan night repo second merge|hold']);
});

test('정책: 손상 문구에는 홈 절대 경로를 넣지 않는다(F7). 쓰기 거절은 CLI용으로 경로를 붙인다', () => {
  const home = tmp('kadan-repo-policy-');
  fs.writeFileSync(policyPath(home), '{깨진');
  const {corrupt} = readPolicy(home);
  assert.match(corrupt, /night-repo-policy\.json/);
  assert.ok(!corrupt.includes(home), corrupt);
  assert.ok(!evaluateRepo(home, 'site', {repoPath: null}).verdict.detail.includes(home));
  assert.throws(() => setRepoPolicy(home, {repo: 'site', value: 'hold', by: '사람'}), e => e.message.includes(home));
});


test('CLI 명령: 저장 출력·list·show·--repo-path·업무의 repoPath·기본값 근거(카드 id만)', () => {
  const home = tmp('kadan-repo-cli-');
  const onto = tmp('kadan-onto-');
  const site = tmp('kadan-site-'), docs = tmp('kadan-docs-');
  card(onto, 'site', `repo: ${site}\ndeploy: 자동 (Vercel)\ndeploy_branch: main`);
  card(onto, 'docs', `repo: ${docs}\ndeploy: 없음\ndeploy_branch: 없음`);
  ontology(onto);
  const works = [{key: 'site/w1', status: 'open', repoPath: site}, {key: 'docs/w2', status: 'open', repoPath: docs}];
  const run = (args, flags = {}, by = '사람') => nightCommand(['repo', ...args], flags, {home, by, deps: {readWorks: () => works}});
  assert.match(run(['show', 'site']), /site: 저장 값 없음[\s\S]*기본값 근거 카드 [^\n]*\/site deploy_branch main[\s\S]*최종 판정 머지 \(ontology-allowed, main으로 가는 PR만 보류\)/);
  assert.match(run(['show', 'docs']), /docs: 최종 판정 머지 \(ontology-allowed\)/);
  assert.match(run(['site', 'merge']), /저장: site = merge \(이전 없음\)[\s\S]*최종 판정 머지 \(repo-policy-merge\)/);
  const list = run(['list']);
  assert.match(list, /site: 저장 값 merge/);
  assert.match(list, /docs: 저장 값 없음/);
  assert.ok(!list.includes(onto) && !list.includes(site), list); // 절대 경로를 보이지 않는다
  assert.match(run(['show', 'ghost']), /ghost: 최종 판정 보류 \(setup-needed, 저장소 경로를 모름\)/);
  assert.match(run(['show', 'ghost'], {'repo-path': tmp('kadan-nocard-')}), /ghost: 최종 판정 보류 \(setup-needed, 온톨로지 카드 없음\)/);
  assert.match(run([]), /사용법: kadan night repo <저장소> merge\|hold /);
  assert.throws(() => run(['site']), /값이 필요/);
  assert.throws(() => run(['site', 'auto']), /merge\|hold 중 하나/);
  assert.throws(() => run(['show']), /저장소 이름/);
  assert.deepEqual(readLedger(home).filter(e => e.kind === 'night-repo-policy').map(e => e.after), ['merge']);
});

test('nightGuard: 켜짐+역할 세션의 night repo 쓰기는 거절, list·show·인자 없음은 통과, 꺼짐·사람은 통과', () => {
  const home = tmp('kadan-repo-guard-');
  const env = {KADAN_ROLE: 'a-작업자'};
  const call = (args, e = env) => nightGuard({command: 'night', args, flags: {}, home, env: e});
  call(['repo', 'kadan', 'merge']); // 꺼져 있으면 통과
  nightOn(home);
  assert.throws(() => call(['repo', 'kadan', 'merge']), error => error.exitCode === 2 && /night repo kadan/.test(error.message));
  assert.throws(() => call(['repo', 'kadan']), /나이트 모드가 켜져 있어/);
  call(['repo']);
  call(['repo', 'list']);
  call(['repo', 'show', 'kadan']);
  call(['repo', 'kadan', 'merge'], {}); // 사람(역할 없음)
});

test('CLI 실행: 켜짐+역할 세션의 쓰기는 종료 2·저장 안 됨, 읽기는 통과, 사람은 저장', () => {
  const home = tmp('kadan-repo-cli2-');
  nightOn(home);
  const run = (argv, role) => spawnSync(process.execPath, [CLI, ...argv], {
    env: {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none', KADAN_ROLE: role ?? ''}, encoding: 'utf8', timeout: 20_000});
  const denied = run(['night', 'repo', 'kadan', 'merge'], 'a-작업자');
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /나이트 모드가 켜져 있어/);
  assert.equal(fs.existsSync(policyPath(home)), false);
  const read = run(['night', 'repo', 'list'], 'a-작업자');
  assert.equal(read.status, 0, read.stderr);
  const human = run(['night', 'repo', 'kadan', 'hold', '--repo-path', REPO_ROOT]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(readPolicy(home).repos.kadan.value, 'hold');
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

test('API: GET 모양, POST는 토큰·출처·원격 검사를 받고 나이트 켜짐이면 409(저장 안 됨), 꺼짐이면 저장', async () => {
  const home = tmp('kadan-repo-api-');
  const handler = createCenterHandler(home);
  const get = await call(handler, fakeReq('GET', '/api/night/repos'));
  assert.equal(get.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(get.body)), ['corrupt', 'repos']);
  assert.deepEqual(JSON.parse(get.body).repos, []);

  const post = (fields, opts) => call(handler, fakeReq('POST', '/api/night/repos', {body: form(handler, fields), ...opts}));
  assert.equal((await call(handler, fakeReq('POST', '/api/night/repos', {body: new URLSearchParams({repo: 'site', value: 'hold'}).toString()}))).status, 403); // 토큰 없음
  assert.equal((await post({repo: 'site', value: 'hold'}, {origin: 'http://evil.example'})).status, 403);
  assert.equal((await post({repo: 'site', value: 'hold'}, {remote: true})).status, 405);
  assert.equal(fs.existsSync(policyPath(home)), false);

  nightOn(home);
  const blocked = await post({repo: 'site', value: 'hold'});
  assert.equal(blocked.status, 409);
  assert.match(blocked.body, /나이트가 켜진 동안은 바꿀 수 없음/);
  assert.equal(fs.existsSync(policyPath(home)), false);

  const off = tmp('kadan-repo-api-off-');
  const handler2 = createCenterHandler(off);
  const ok = await call(handler2, fakeReq('POST', '/api/night/repos', {body: form(handler2, {repo: 'site', value: 'hold'})}));
  assert.equal(ok.status, 200);
  assert.equal(readPolicy(off).repos.site.value, 'hold');
  assert.equal(readPolicy(off).repos.site.by, '사람');
  const bad = await call(handler2, fakeReq('POST', '/api/night/repos', {body: form(handler2, {repo: 'site', value: 'zzz'})}));
  assert.equal(bad.status, 409);
  assert.equal(readPolicy(off).repos.site.value, 'hold');
  const body = JSON.parse((await call(handler2, fakeReq('GET', '/api/night/repos'))).body);
  assert.equal(body.repos[0].verdict.action, 'hold');
  assert.deepEqual(Object.keys(body.repos[0]).sort(), ['repo', 'saved', 'source', 'value', 'verdict']);
  assert.deepEqual(Object.keys(body.repos[0].verdict).sort(), ['action', 'exceptBranch', 'reason']);
  assert.ok(!JSON.stringify(body).includes(off));
});

// 실제 kadan 저장소 내용에 묶지 않는다(파일 하나만 바뀌어도 깨진다). kadan과 같은 꼴의 고정 fixture로 본다:


test('API 응답 모양: 저장소 단위 항목(source·verdict.exceptBranch), 절대 경로 없음', () => {
  const home = tmp('kadan-repo-shape-');
  const onto = tmp('kadan-onto-shape-'), shop = tmp('kadan-shop-'), rot = tmp('kadan-rot-');
  card(onto, 'shop', `repo: ${shop}\ndeploy: 수동 (npm run deploy)\ndeploy_branch: main`);
  card(onto, 'rot', `repo: ${rot}\ndeploy: 수동 (…)\ndeploy_branch: 없음\nnight_merge: 금지`);
  ontology(onto);
  const out = listRepos(home, [{key: 'shop/w1', repoPath: shop}, {key: 'rot/w3', repoPath: rot}, {key: 'ghost/w2', repoPath: tmp('kadan-g-')}]);
  assert.deepEqual(Object.keys(out), ['corrupt', 'repos']);
  const [ghost, rotInfo, shopInfo] = out.repos;
  const id = n => `${path.basename(onto)}/${n}`;
  assert.deepEqual(shopInfo, {repo: 'shop', value: null, saved: null,
    source: {kind: 'ontology', card: id('shop'), deploy: '수동', deployBranch: 'main', nightMerge: null, reason: null},
    verdict: {action: 'merge', reason: 'ontology-allowed', exceptBranch: 'main'}});
  assert.deepEqual(rotInfo.verdict, {action: 'hold', reason: 'ontology-night-merge-forbidden', exceptBranch: null});
  assert.deepEqual([ghost.source.kind, ghost.source.card, ghost.source.reason, ghost.verdict.reason], ['none', null, '온톨로지 카드 없음', 'setup-needed']);
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
  setRepoPolicy(home, {repo: 'site', value: 'hold', by: '사람'});
  fs.chmodSync(policyPath(home), 0o000);
  try {
    const {corrupt} = readPolicy(home);
    assert.match(corrupt, /night-repo-policy\.json \(EACCES\)/);
    assert.ok(!corrupt.includes(home), corrupt);
    assert.ok(!JSON.stringify(evaluateRepo(home, 'site', {repoPath: null})).includes(home));
  } finally { fs.chmodSync(policyPath(home), 0o600); }
});
