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
  readPolicy, setRepoPolicy, setCardSources, normalizeGithub, parseRemote, parseDeployBranch, loadCards, evaluateGithub, decideNightMerge,
  listRepos, policyPath, setupNeededLines,
} from '../src/night-repo-policy.mjs';

// 격리 홈·임시 카드 폴더만 쓴다. 운영 홈·실제 개인 폴더·포트·GitHub에 닿지 않는다. 역할 이름·저장소 이름도 시험용이다.
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true}); fs.writeFileSync(path.join(root, rel), text); };
const card = (dir, name, front, {raw} = {}) => write(dir, `${name}.md`, raw ?? `---\nid: project/${name}\n${front}\n---\n\n## Why\n본문\n`);
const nightOn = home => appendLedger({kind: 'night', phase: 'on', by: '사람', text: '시험', viaChat: false,
  until: new Date(Date.now() + 3600_000).toISOString(), to: [], delivered: [], t: new Date().toISOString()}, home);
const home0 = () => tmp('kadan-repo-policy-');
const set = (home, repo, fields = {}) => setRepoPolicy(home, {repo, by: '사람', ...fields});
// 카드 폴더를 `night source`와 같은 길(setCardSources)로 연결한다.
const link = (home, ...dirs) => setCardSources(home, {folders: dirs, by: '사람'});
const decide = (home, github, baseBranch) => decideNightMerge(home, {github, baseBranch});
const verdictOf = (home, github, baseBranch) => { const d = decide(home, github, baseBranch); return [d.action, d.reason]; };

test('키: 소문자·끝 .git·끝 / 정규화, 올바르지 않은 키는 거절', () => {
  assert.equal(normalizeGithub('Acme/Site'), 'acme/site');
  assert.equal(normalizeGithub('Acme/Site.git'), 'acme/site');
  assert.equal(normalizeGithub(' Acme/Site.git/ '), 'acme/site');
  for (const bad of ['site', 'a/b/c', '/a/b', 'a/', '../x', 'a/..', './a', 'a/.', 'a b/c', '소유자/이름', '', null, undefined, 3])
    assert.equal(normalizeGithub(bad), null, String(bad));
});

test('1. 설정 없음·연결 없음 → setup-needed. 개인 폴더 글롭도 환경변수도 카드를 읽지 않는다', () => {
  const home = home0();
  const hubs = tmp('kadan-notes-'); // 옛 글롭·환경변수 모양의 폴더를 만들어도 읽히지 않아야 한다
  card(path.join(hubs, 'notes/projects'), 'a', 'remote: acme/a\ndeploy_branch: 없음');
  process.env.KADAN_ONTOLOGY_DIRS = path.join(hubs, 'notes/projects');
  try {
    const info = evaluateGithub(home, 'acme/a');
    assert.deepEqual([info.verdict.action, info.verdict.reason], ['hold', 'setup-needed']);
    assert.deepEqual(info.card, null);
    assert.deepEqual(listRepos(home, [], {origin: () => null}), {corrupt: null, repos: [], legacy: [], sources: {cards: []}, unreadable: []});
  } finally { delete process.env.KADAN_ONTOLOGY_DIRS; }
});

test('2. 카단 설정만으로 판정: 금지→hold, 배포 브랜치와 같음→hold, 다른 브랜치→merge, 없음→merge, 브랜치를 모르면 hold', () => {
  const home = home0();
  set(home, 'Acme/Forbid', {deployBranch: 'main', nightMerge: '금지'});
  set(home, 'acme/web', {deployBranch: 'main'});
  set(home, 'acme/doc', {deployBranch: '없음'});
  set(home, 'acme/only-merge', {nightMerge: '허용'});
  assert.deepEqual(verdictOf(home, 'acme/forbid', 'dev'), ['hold', 'night-merge-forbidden']);
  assert.deepEqual(verdictOf(home, 'acme/web', 'main'), ['hold', 'deploy-branch']);
  assert.deepEqual(verdictOf(home, 'acme/web', 'dev'), ['merge', 'allowed']);
  assert.deepEqual(verdictOf(home, 'acme/web'), ['hold', 'setup-needed']); // 대상 브랜치를 모름
  assert.deepEqual(verdictOf(home, 'acme/doc', 'main'), ['merge', 'allowed']);
  assert.deepEqual(verdictOf(home, 'acme/only-merge', 'main'), ['hold', 'setup-needed']); // deployBranch 비어 있음
  assert.deepEqual(verdictOf(home, 'nobody/none', 'main'), ['hold', 'setup-needed']);
  assert.equal(evaluateGithub(home, 'site').verdict.reason, 'setup-needed');
});

test('설정 쓰기: 칸 일부만 바꾸고, --clear로 칸을 지우고, 원장에 이전·이후가 남고, 잘못된 값은 거절', () => {
  const home = home0();
  const records = [];
  const record = e => records.push(e);
  set(home, 'Acme/Site.git', {deployBranch: 'main', nightMerge: '금지', record, now: () => 't1'});
  set(home, 'acme/site', {nightMerge: '허용', record, now: () => 't2'}); // deployBranch는 그대로
  assert.deepEqual(readPolicy(home).repos['acme/site'], {deployBranch: 'main', nightMerge: '허용', at: 't2', by: '사람'});
  set(home, 'acme/site', {clear: 'nightMerge', record});
  assert.equal(readPolicy(home).repos['acme/site'].nightMerge, null);
  assert.deepEqual(records.map(r => [r.kind, r.repo, r.before, r.after]), [
    ['night-repo-policy', 'acme/site', {deployBranch: null, nightMerge: null}, {deployBranch: 'main', nightMerge: '금지'}],
    ['night-repo-policy', 'acme/site', {deployBranch: 'main', nightMerge: '금지'}, {deployBranch: 'main', nightMerge: '허용'}],
    ['night-repo-policy', 'acme/site', {deployBranch: 'main', nightMerge: '허용'}, {deployBranch: 'main', nightMerge: null}]]);
  set(home, 'acme/site', {clear: 'deployBranch'});
  assert.deepEqual(readPolicy(home).repos, {}); // 두 칸 다 비면 줄이 사라진다
  assert.equal((fs.statSync(policyPath(home)).mode & 0o777), 0o600);
  assert.throws(() => set(home, 'acme/site', {}), /바꿀 칸이 없습니다/);
  assert.throws(() => set(home, 'acme/site', {deployBranch: 'main (설명)'}), /deployBranch는/);
  assert.throws(() => set(home, 'acme/site', {nightMerge: 'merge'}), /허용\|금지/);
  assert.throws(() => set(home, 'acme/site', {clear: 'at'}), /지울 칸/);
  assert.throws(() => set(home, 'acme/site', {deployBranch: 'main', clear: 'deployBranch'}), /같은 칸/);
  for (const bad of ['site', 'a/b/c', '../x']) assert.throws(() => set(home, bad, {deployBranch: 'main'}), /GitHub 소유자\/이름/, bad);
});

test('3. night source로 연결한 카드가 빈 칸을 채우고, 카단 설정이 칸별로 카드를 이기고, 칸마다 출처가 보인다', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'site', 'remote: Acme/Site (비공개)\ndeploy_branch: main\nnight_merge: 허용');
  link(home, onto);
  const card_ = evaluateGithub(home, 'acme/site');
  assert.deepEqual(card_.effective, {deployBranch: {value: 'main', from: 'card'}, nightMerge: {value: '허용', from: 'card'}});
  assert.deepEqual(card_.card, {id: 'site', folder: 0, deployBranch: 'main', nightMerge: '허용'});
  assert.deepEqual(verdictOf(home, 'acme/site', 'main'), ['hold', 'deploy-branch']);
  set(home, 'acme/site', {deployBranch: '없음'}); // 한 칸만 설정: 다른 칸은 카드
  const mixed = evaluateGithub(home, 'acme/site', {baseBranch: 'main'});
  assert.deepEqual(mixed.effective, {deployBranch: {value: '없음', from: 'kadan'}, nightMerge: {value: '허용', from: 'card'}});
  assert.deepEqual([mixed.verdict.action, mixed.verdict.reason], ['merge', 'allowed']);
  set(home, 'acme/site', {nightMerge: '금지'});
  assert.deepEqual(verdictOf(home, 'acme/site', 'dev'), ['hold', 'night-merge-forbidden']);
  // 카드가 없고 설정도 안 채운 칸은 출처가 null이다
  assert.deepEqual(evaluateGithub(home, 'acme/none').effective, {deployBranch: {value: null, from: null}, nightMerge: {value: null, from: null}});
  // 연결 해제 뒤에는 카드를 읽지 않는다
  setCardSources(home, {clear: true, by: '사람'});
  assert.equal(evaluateGithub(home, 'acme/site').card, null);
});

test('4. 카드가 못 읽히는데 설정이 두 칸을 다 채우면 설정으로 판정, 한 칸만 채우면 setup-needed', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'dup1', 'remote: acme/app\ndeploy_branch: main');
  card(onto, 'dup2', 'remote: acme/app\ndeploy_branch: develop'); // 카드 둘 → 못 읽힘
  link(home, onto);
  assert.match(evaluateGithub(home, 'acme/app').verdict.detail, /카드가 여럿/);
  assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['hold', 'setup-needed']);
  set(home, 'acme/app', {deployBranch: 'main'});
  assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['hold', 'setup-needed']); // nightMerge 칸이 못 읽힘
  set(home, 'acme/app', {nightMerge: '허용'});
  assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['merge', 'allowed']);
  assert.deepEqual(verdictOf(home, 'acme/app', 'main'), ['hold', 'deploy-branch']);
  // 카드 한 장의 deploy_branch 칸만 못 읽히면 그 칸만 설정이 대신한다
  card(onto, 'odd', 'remote: acme/odd\ndeploy_branch: main push 때\nnight_merge: 허용');
  assert.match(evaluateGithub(home, 'acme/odd').verdict.detail, /deploy_branch 형식/);
  set(home, 'acme/odd', {deployBranch: '없음'});
  assert.deepEqual(verdictOf(home, 'acme/odd', 'main'), ['merge', 'allowed']);
});

test('5. 예전 merge|hold 저장값(맨 이름 키 포함)은 legacy로만 보이고 판정에 쓰지 않으며, 다시 써도 지우지 않는다. auto는 빠진다', () => {
  const home = home0();
  const entry = {value: 'hold', at: 't', by: '사람'};
  fs.writeFileSync(policyPath(home), JSON.stringify({version: 1, repos: {site: entry, 'acme/old': {...entry, value: 'merge'}, gone: {...entry, value: 'auto'}}}));
  const policy = readPolicy(home);
  assert.equal(policy.corrupt, null);
  assert.deepEqual(policy.repos, {});
  assert.deepEqual(Object.keys(policy.legacy).sort(), ['acme/old', 'site']);
  assert.deepEqual(verdictOf(home, 'acme/old', 'main'), ['hold', 'setup-needed']); // 예전 merge는 무시
  const out = listRepos(home, [], {origin: () => null});
  assert.deepEqual(out.legacy, [{name: 'acme/old', value: 'merge', at: 't', by: '사람'}, {name: 'site', value: 'hold', at: 't', by: '사람'}]);
  assert.match(nightCommand(['repo', 'list'], {}, {home, by: '사람', deps: {readWorks: () => [], origin: () => null}}), /옛 형식 저장값\(판정에 쓰지 않음\): site = hold/);
  set(home, 'acme/new', {deployBranch: 'main'});
  const file = JSON.parse(fs.readFileSync(policyPath(home), 'utf8'));
  assert.equal(file.version, 2);
  assert.deepEqual([Object.keys(file.legacy).sort(), Object.keys(file.repos)], [['acme/old', 'site'], ['acme/new']]);
});

test('정책 파일 손상: 쓰기 거절(파일 그대로), 읽기는 setup-needed, 문구에 홈 경로 없음, 쓰기 거절은 CLI용으로 경로를 붙인다', () => {
  const home = home0();
  fs.writeFileSync(policyPath(home), '{깨진');
  assert.throws(() => set(home, 'acme/site', {deployBranch: 'main'}), error => error.message.includes(policyPath(home)) && !error.httpMessage.includes(home));
  assert.equal(fs.readFileSync(policyPath(home), 'utf8'), '{깨진');
  const info = evaluateGithub(home, 'acme/site');
  assert.deepEqual([info.verdict.action, info.verdict.reason], ['hold', 'setup-needed']);
  assert.match(info.verdict.detail, /손상/);
  assert.ok(!JSON.stringify(info).includes(home));
  for (const repos of [{'acme/site': {deployBranch: 'zzz zzz'}}, {'a/b/c': {deployBranch: 'main'}}, {'Acme/Site': {deployBranch: 'main'}}, {'acme/site': {nightMerge: 'merge'}}]) {
    fs.writeFileSync(policyPath(home), JSON.stringify({version: 2, repos}));
    assert.ok(readPolicy(home).corrupt, JSON.stringify(repos));
  }
  fs.writeFileSync(policyPath(home), JSON.stringify({version: 2, repos: {}, cards: ['상대/경로']}));
  assert.ok(readPolicy(home).corrupt);
  assert.throws(() => set(home, 'acme/x', {deployBranch: 'main'}), /손상/); // cards 경로가 상대 경로인 파일도 손상이다
});

test('정책: 읽기 권한 오류·임시 파일 쓰기 실패 문구에도 절대 경로가 없다', () => {
  const home = tmp('kadan-repo-policy-');
  set(home, 'acme/site', {deployBranch: 'main'});
  fs.chmodSync(policyPath(home), 0o000);
  try {
    const {corrupt} = readPolicy(home);
    assert.match(corrupt, /night-repo-policy\.json \(EACCES\)/);
    assert.ok(!corrupt.includes(home), corrupt);
  } finally { fs.chmodSync(policyPath(home), 0o600); }
});

test('remote·deploy_branch 읽기 형식(재사용): 세 형식, 낱말 하나·짝 목록, 설명 글은 못 읽음', () => {
  assert.equal(parseRemote('github.com/Acme/Site (공개)'), 'acme/site');
  assert.equal(parseRemote('git@github-personal:Acme/Site.git (비공개)'), 'acme/site');
  assert.equal(parseRemote('Acme/Site (비공개)'), 'acme/site');
  for (const none of ['없음 (원격 저장소 미연결)', 'Acme 조직 (a-web, b-web)', 'https://github.com/acme/site', 'acme', 'a/b/c', '', undefined])
    assert.equal(parseRemote(none), null, String(none));
  assert.deepEqual(parseDeployBranch('main (설명. (괄호) 중첩)'), {kind: 'word', value: 'main'});
  assert.deepEqual(parseDeployBranch('{Acme/Web: main, Acme/Admin: 없음}'), {kind: 'map', map: {'acme/web': 'main', 'acme/admin': '없음'}});
  assert.equal(parseDeployBranch(undefined), null);
  for (const bad of ['acme-web=main (머지되면 운영 자동 배포). acme-admin=없음 — 설명', '없음 — 설명이 괄호 없이 이어짐', 'main push 때', '', '{}', '{Acme/Web: main',
    '{web: main}', '{Acme/Web: main, acme/web: 없음}', '{Acme/Web: main (설명)}', 'main, develop'])
    assert.deepEqual(parseDeployBranch(bad), {kind: 'unreadable'}, bad);
});

test('8. 카드 찾기·우산 카드·엄격 읽기: 짝 목록이 remote보다 먼저, 목록에 없는 키는 못 찾고, night_merge는 카드 전체에 적용', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'umb', 'deploy_branch: {Acme/Web: main, Acme/Admin: 없음}\nnight_merge: 금지');
  card(onto, 'plain', 'remote: git@github.com:Acme/Plain.git\ndeploy_branch: 없음');
  card(onto, 'noremote', 'remote: 없음 (원격 미연결)\ndeploy_branch: main');
  link(home, onto);
  assert.deepEqual(['acme/web', 'acme/admin'].map(g => verdictOf(home, g, 'dev')[1]), ['night-merge-forbidden', 'night-merge-forbidden']);
  assert.deepEqual(verdictOf(home, 'ACME/PLAIN.git', 'main'), ['merge', 'allowed']);
  assert.equal(evaluateGithub(home, 'acme/other').card, null); // 목록에도 remote에도 없음
  assert.equal(decide(home, 'acme/plain', 'main').card, 'plain');
  const rows = listRepos(home, [], {origin: () => null}).repos;
  assert.deepEqual(rows.map(r => r.github), ['acme/admin', 'acme/plain', 'acme/web']); // 연결 카드에서 읽힌 키
  // 판정 칸 엄격 읽기(검수 F1): 형식 틀림·중복은 못 읽음 → setup-needed, 정상 카드는 그대로
  const strict = fields => {
    const d = tmp('kadan-strict-'), h = home0();
    write(d, 'app.md', `---\nremote: Acme/App\n${fields}\n---\n`);
    link(h, d);
    return [h, evaluateGithub(h, 'acme/app', {baseBranch: 'dev'}).verdict];
  };
  for (const bad of ['deploy_branch: main\nnight_merge: 금지\nnight_merge: 허용', 'deploy_branch: main\n  night_merge: 허용', 'deploy_branch: main\n"night_merge": 금지',
    'Deploy_Branch: main', 'deploy_branch: main\nnight_merge: 모름', 'deploy_branch: main\nnight_merge:'])
    assert.equal(strict(bad)[1].reason, 'setup-needed', bad);
  assert.deepEqual(strict('deploy_branch: main')[1].reason, 'allowed'); // night_merge 칸이 아예 없으면 허용
  assert.match(strict('deploy_branch: main\nnight_merge: 금지\nnight_merge: 허용')[1].detail, /줄 \d+·\d+/);
  // 하위 폴더·링크는 훑지 않는다
  const d2 = tmp('kadan-sub-'), h2 = home0();
  card(path.join(d2, 'sub'), 'deep', 'remote: acme/deep\ndeploy_branch: 없음');
  fs.symlinkSync(path.join(d2, 'sub', 'deep.md'), path.join(d2, 'link.md'));
  link(h2, d2);
  assert.deepEqual(loadCards([d2]).cards, []);
  // 연결한 폴더가 사라지면 조용히 건너뛰지 않고 못 읽힘이다(경로 없는 문구)
  fs.rmSync(onto, {recursive: true});
  const gone = evaluateGithub(home, 'acme/plain');
  assert.equal(gone.verdict.reason, 'setup-needed');
  assert.match(gone.verdict.detail, /카드 폴더 0를 읽을 수 없음\(ENOENT\)/);
  assert.ok(!JSON.stringify(gone).includes(onto));
});

test('목록: 설정 키·연결 카드 키·업무 저장소(git origin)를 합치고, 각 줄 판정은 decideNightMerge와 같다', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'a', 'remote: acme/a\ndeploy_branch: main');
  link(home, onto);
  set(home, 'acme/saved', {deployBranch: '없음'});
  const origins = {'/work/site': 'acme/site', '/work/a': 'acme/a'};
  const works = [{key: 'site/w1', repoPath: '/work/site'}, {key: 'a/w2', repoPath: '/work/a'}, {key: 'x/w3', repoPath: '/work/none'}, {key: 'rel/w4', repoPath: 'relative'}];
  const out = listRepos(home, works, {origin: p => origins[p] ?? null});
  assert.deepEqual(out.repos.map(r => [r.github, r.repo]), [['acme/a', 'a'], ['acme/saved', null], ['acme/site', 'site']]);
  for (const row of out.repos) {
    assert.deepEqual([row.verdict.action, row.verdict.reason], verdictOf(home, row.github, 'zzz-other'));
    if (row.verdict.exceptBranch) assert.deepEqual(verdictOf(home, row.github, row.verdict.exceptBranch), ['hold', 'deploy-branch']);
  }
  assert.deepEqual(setupNeededLines(out.repos.concat(evaluateGithub(home, 'acme/ok-none'))),
    ['설정 필요: acme/site — 나이트런 중 자동 머지 안 함(kadan night repo acme/site --deploy-branch <브랜치|없음>)', '설정 필요: acme/ok-none — 나이트런 중 자동 머지 안 함(kadan night repo acme/ok-none --deploy-branch <브랜치|없음>)']);
});

test('nightGuard: 켜짐+역할 세션의 night repo 쓰기·night source 등록·해제는 거절, 읽기는 통과, 꺼짐·사람은 통과', () => {
  const home = tmp('kadan-repo-guard-');
  const env = {KADAN_ROLE: 'a-작업자'};
  const call = (args, flags = {}, e = env) => nightGuard({command: 'night', args, flags, home, env: e});
  call(['repo', 'acme/kadan'], {'deploy-branch': 'main'}); // 꺼져 있으면 통과
  call(['source'], {cards: '/x'});
  nightOn(home);
  assert.throws(() => call(['repo', 'acme/kadan'], {'deploy-branch': 'main'}), error => error.exitCode === 2 && /night repo acme\/kadan/.test(error.message));
  assert.throws(() => call(['source'], {cards: '/x'}), error => error.exitCode === 2 && /night source/.test(error.message));
  assert.throws(() => call(['source', '/y'], {cards: '/x'}), /나이트 모드가 켜져 있어/);
  assert.throws(() => call(['source'], {clear: true}), /night source/);
  for (const args of [['repo'], ['repo', 'list'], ['repo', 'show', 'acme/kadan'], ['source']]) call(args);
  call(['repo', 'acme/kadan'], {'deploy-branch': 'main'}, {}); // 사람(역할 없음)
  call(['source'], {clear: true}, {});
});

test('CLI 실행: 설정 저장·source 등록·해제, 켜짐+역할 세션은 종료 2·저장 안 됨, 읽기는 통과, 예전 merge|hold는 거절', () => {
  const home = tmp('kadan-repo-cli2-');
  const onto = tmp('kadan-onto-');
  card(onto, 'site', 'remote: acme/site\ndeploy_branch: main');
  const run = (argv, role) => spawnSync(process.execPath, [CLI, ...argv], {
    env: {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none', KADAN_ROLE: role ?? ''}, encoding: 'utf8', timeout: 20_000});
  assert.match(run(['night', 'source']).stdout, /연결한 카드 폴더가 없습니다/);
  const reg = run(['night', 'source', '--cards', onto, tmp('kadan-onto2-')]);
  assert.equal(reg.status, 0, reg.stderr);
  assert.equal(readPolicy(home).cards.length, 2);
  assert.match(run(['night', 'source']).stdout, /연결한 카드 폴더:/);
  const saved = run(['night', 'repo', 'Acme/Site', '--night-merge', '금지']);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /nightMerge 금지/);
  assert.match(saved.stdout, /카드 폴더 0\/site|폴더 0\/site/);
  assert.match(saved.stdout, /최종 판정 나이트런 중 자동 머지 안 함 \(night-merge-forbidden\)/);
  assert.equal(run(['night', 'repo', 'acme/site', 'hold']).status, 1); // 예전 merge|hold 쓰기는 없다
  assert.equal(run(['night', 'repo', 'acme/site', '--deploy-branch']).status, 1); // 값 없음
  assert.equal(run(['night', 'source', '--cards', '/없는/폴더']).status, 1);
  nightOn(home);
  const before = fs.readFileSync(policyPath(home), 'utf8');
  for (const argv of [['night', 'repo', 'acme/kadan', '--deploy-branch', 'main'], ['night', 'source', '--cards', onto], ['night', 'source', '--clear']]) {
    const denied = run(argv, 'a-작업자');
    assert.equal(denied.status, 2, denied.stderr);
    assert.match(denied.stderr, /나이트 모드가 켜져 있어/);
  }
  assert.equal(fs.readFileSync(policyPath(home), 'utf8'), before);
  for (const argv of [['night', 'repo', 'list'], ['night', 'source']]) assert.equal(run(argv, 'a-작업자').status, 0);
  assert.equal(run(['night', 'source', '--clear']).status, 0); // 사람
  assert.deepEqual(readPolicy(home).cards, []);
});

function fakeReq(method, pathname, {body = '', remote = false, origin, host = '127.0.0.1:1'} = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {method, url: pathname, headers: {host, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(origin ? {origin} : {})}, kadanRemote: remote || undefined,
    async *[Symbol.asyncIterator]() { yield* chunks; }};
}
async function call(handler, req) {
  const out = {status: null, body: ''};
  const res = {writeHead(status) { out.status = status; }, end(text = '') { out.body += text; }};
  const handled = await handler.handle(req, res, new URL(req.url, 'http://127.0.0.1'));
  return {handled, ...out};
}
const form = (handler, fields) => new URLSearchParams({token: handler.token, ...fields}).toString();

test('7. API: GET 모양(원문 예)·절대 경로 없음, POST는 칸 일부만 바꾸고 기존 거절(토큰·출처·원격 405·나이트 켜짐 409)은 그대로', async () => {
  const home = tmp('kadan-repo-api-');
  const onto = tmp('kadan-onto-');
  card(onto, 'shop', 'remote: Acme/Shop (비공개)\ndeploy_branch: main');
  card(onto, 'umb', 'deploy_branch: {Acme/Web: main, Acme/Admin: 없음}\nnight_merge: 금지');
  link(home, onto);
  const handler = createCenterHandler(home);
  const get = JSON.parse((await call(handler, fakeReq('GET', '/api/night/repos'))).body);
  assert.deepEqual(Object.keys(get), ['corrupt', 'repos', 'legacy', 'sources', 'unreadable']);
  assert.deepEqual(get.sources, {cards: [0]});
  const shop = get.repos.find(r => r.github === 'acme/shop');
  assert.deepEqual(shop, {github: 'acme/shop', repo: null,
    settings: {deployBranch: null, nightMerge: null, at: null, by: null},
    card: {id: 'shop', folder: 0, deployBranch: 'main', nightMerge: null},
    effective: {deployBranch: {value: 'main', from: 'card'}, nightMerge: {value: null, from: null}},
    verdict: {action: 'merge', reason: 'allowed', detail: null, exceptBranch: 'main'}});
  assert.deepEqual(get.repos.filter(r => r.github.startsWith('acme/') && r.github !== 'acme/shop').map(r => [r.github, r.verdict.reason]),
    [['acme/admin', 'night-merge-forbidden'], ['acme/web', 'night-merge-forbidden']]);
  assert.ok(!JSON.stringify(get).includes(onto) && !JSON.stringify(get).includes(home));

  const post = (fields, opts) => call(handler, fakeReq('POST', '/api/night/repos', {body: form(handler, fields), ...opts}));
  assert.equal((await call(handler, fakeReq('POST', '/api/night/repos', {body: new URLSearchParams({repo: 'acme/site', deployBranch: 'main'}).toString()}))).status, 403); // 토큰 없음
  assert.equal((await post({repo: 'acme/site', deployBranch: 'main'}, {origin: 'http://evil.example'})).status, 403);
  assert.equal((await post({repo: 'acme/site', deployBranch: 'main'}, {remote: true})).status, 405);
  assert.deepEqual(readPolicy(home).repos, {});
  assert.equal((await post({repo: 'Acme/Site.git', deployBranch: 'main'})).status, 200);
  assert.equal((await post({repo: 'acme/site', nightMerge: '금지', deployBranch: ''})).status, 200); // 빈 값은 그대로 둔다
  assert.deepEqual(readPolicy(home).repos['acme/site'], {deployBranch: 'main', nightMerge: '금지', at: readPolicy(home).repos['acme/site'].at, by: '사람'});
  for (const bad of [{repo: 'acme/site', nightMerge: 'merge'}, {repo: 'site', deployBranch: 'main'}, {repo: 'acme/site', deployBranch: 'a b'}, {repo: 'acme/site'}]) {
    assert.equal((await post(bad)).status, 409, JSON.stringify(bad));
  }
  assert.equal((await call(handler, fakeReq('POST', '/api/night/sources', {body: form(handler, {cards: '/x'})}))).handled, false); // 연결 바꾸기는 API로 열지 않는다
  nightOn(home);
  const blocked = await post({repo: 'acme/site', deployBranch: 'dev'});
  assert.equal(blocked.status, 409);
  assert.match(blocked.body, /나이트가 켜진 동안은 바꿀 수 없음/);
  assert.equal(readPolicy(home).repos['acme/site'].deployBranch, 'main');
});

test('POST 오류 응답에는 절대 경로·OS 원문이 없다(손상 파일, 임시 파일 쓰기 실패)', async () => {
  const home = tmp('kadan-repo-post-corrupt-');
  fs.writeFileSync(policyPath(home), '{bad');
  const handler = createCenterHandler(home);
  const r = await call(handler, fakeReq('POST', '/api/night/repos', {body: form(handler, {repo: 'acme/app', deployBranch: 'main'})}));
  assert.equal(r.status, 409);
  assert.ok(!r.body.includes(home), r.body);
  assert.match(r.body, /night-repo-policy\.json[\s\S]*JSON 구문 오류/);
  assert.equal(fs.readFileSync(policyPath(home), 'utf8'), '{bad');
  const home2 = tmp('kadan-repo-post-eisdir-');
  fs.mkdirSync(`${policyPath(home2)}.${process.pid}.tmp`);
  const handler2 = createCenterHandler(home2);
  const r2 = await call(handler2, fakeReq('POST', '/api/night/repos', {body: form(handler2, {repo: 'acme/app', deployBranch: 'main'})}));
  assert.equal(r2.status, 409);
  assert.equal(r2.body, '밤 저장소 정책 처리 실패(EISDIR)');
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

test('원장: source 변경 사건은 폴더 경로가 아니라 개수만 남긴다', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  const records = [];
  setCardSources(home, {folders: [onto], by: '사람', record: e => records.push(e), now: () => 't'});
  setCardSources(home, {clear: true, by: '사람', record: e => records.push(e), now: () => 't'});
  assert.deepEqual(records, [{kind: 'night-repo-policy', repo: null, sources: {before: 0, after: 1}, by: '사람', t: 't'},
    {kind: 'night-repo-policy', repo: null, sources: {before: 1, after: 0}, by: '사람', t: 't'}]);
  assert.ok(!JSON.stringify(records).includes(onto));
  assert.throws(() => setCardSources(home, {folders: [], by: '사람'}), /연결할 카드 폴더가 필요/);
  assert.throws(() => setCardSources(home, {folders: [path.join(onto, 'nope')], by: '사람'}), /카드 폴더가 아니거나 없습니다/);
});

// ---- PR #333 검수 F1~F3 (읽지 못한 카드는 "없음"이 아니다 / 폴더 링크 / 문서 예시) ----
// 금지 카드 하나와 카단 설정(deployBranch만 채움)을 만들고, 그 카드를 망가뜨린 뒤 판정한다.
const forbidSetup = (mutate) => {
  const home = home0(), dir = tmp('kadan-f1-');
  const file = path.join(dir, 'app.md');
  fs.writeFileSync(file, '---\nremote: acme/app\ndeploy_branch: main\nnight_merge: 금지\n---\n');
  link(home, dir);
  set(home, 'acme/app', {deployBranch: '없음'});
  mutate?.(file);
  return home;
};

test('F1. 읽지 못한 카드는 없는 카드가 아니다: 앞머리 손상·권한 오류·remote 형식 틀림이면 두 칸을 다 못 채운 저장소는 setup-needed', () => {
  const cases = {
    '닫는 --- 없음': f => fs.writeFileSync(f, '---\nremote: acme/app\nnight_merge: 금지\n'),
    '권한 오류': f => fs.chmodSync(f, 0o000),
    'remote 키 형식 틀림': f => fs.writeFileSync(f, '---\nremote : acme/app\nnight_merge: 금지\n---\n'),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const home = forbidSetup(mutate);
    const d = decide(home, 'Acme/App.git/', 'dev');
    assert.deepEqual([d.action, d.reason], ['hold', 'setup-needed'], name);
    assert.match(evaluateGithub(home, 'acme/app').verdict.detail, /연결된 카드 1장을 읽지 못함/, name);
    assert.ok(!evaluateGithub(home, 'acme/app').verdict.detail.includes(os.tmpdir()), name);
    // 다른 저장소도(그 카드가 누구 것인지 모르니) 두 칸을 설정으로 다 정하지 않았으면 보류
    assert.deepEqual(verdictOf(home, 'acme/other', 'dev'), ['hold', 'setup-needed'], name);
    // 반대 대조: 두 칸을 설정으로 다 채우면 손상 카드가 있어도 설정대로
    set(home, 'acme/app', {deployBranch: 'main', nightMerge: '허용'});
    assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['merge', 'allowed'], name);
    assert.deepEqual(verdictOf(home, 'acme/app', 'main'), ['hold', 'deploy-branch'], name);
    set(home, 'acme/app', {nightMerge: '금지'});
    assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['hold', 'night-merge-forbidden'], name);
    for (const f of fs.readdirSync(readPolicy(home).cards[0])) fs.chmodSync(path.join(readPolicy(home).cards[0], f), 0o600); // 임시 파일 권한 복원
  }
});

test('F1. 목록(GET·CLI)에 unreadable이 폴더 순번·파일 이름·이유로 보이고 절대 경로는 없다', () => {
  const home = forbidSetup(f => fs.writeFileSync(f, '---\nremote: acme/app\n'));
  const out = listRepos(home, [], {origin: () => null});
  assert.deepEqual(out.unreadable, [{folder: 0, file: 'app.md', reason: '앞머리를 읽을 수 없음'}]);
  assert.ok(!JSON.stringify(out).includes(os.tmpdir()));
  // deploy_branch 짝 목록 형식이 틀려도 읽지 못한 카드다
  const dir = tmp('kadan-f1-map-'), h2 = home0();
  card(dir, 'umb', 'deploy_branch: {Acme/Web: main, 깨짐');
  link(h2, dir);
  assert.deepEqual(listRepos(h2, [], {origin: () => null}).unreadable, [{folder: 0, file: 'umb.md', reason: 'deploy_branch 짝 목록 형식이 틀림'}]);
});

test('F1. 반대 대조: 정상 금지 카드는 hold, night_merge 칸이 정말 없는 정상 카드는 merge, 설정 main + 대상 main은 hold', () => {
  const home = forbidSetup();
  assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['hold', 'night-merge-forbidden']);
  assert.deepEqual(listRepos(home, [], {origin: () => null}).unreadable, []);
  const dir = tmp('kadan-f1-ok-'), h2 = home0();
  card(dir, 'ok', 'remote: acme/ok\ndeploy_branch: 없음');
  link(h2, dir);
  assert.deepEqual(verdictOf(h2, 'acme/ok', 'dev'), ['merge', 'allowed']);
  set(h2, 'acme/web', {deployBranch: 'main'});
  assert.deepEqual(verdictOf(h2, 'acme/web', 'main'), ['hold', 'deploy-branch']);
});

test('F2. 카드 폴더가 심볼릭 링크면 등록을 거절하고, 읽는 시점의 링크는 폴더 전체를 못 읽음으로 본다', () => {
  const real = tmp('kadan-f2-'), alias = path.join(tmp('kadan-f2-alias-'), 'alias');
  card(real, 'app', 'remote: acme/app\ndeploy_branch: 없음');
  fs.symlinkSync(real, alias);
  const home = home0();
  assert.throws(() => link(home, alias), /링크.*실제 폴더/);
  assert.deepEqual(readPolicy(home).cards, []);
  // 등록 뒤 폴더가 링크로 바뀐 경우: 정책 파일에 직접 넣어 읽는 시점을 확인한다
  const dir = tmp('kadan-f2-swap-'), h2 = home0();
  card(dir, 'app', 'remote: acme/app\ndeploy_branch: 없음');
  link(h2, dir);
  const moved = dir + '-moved';
  fs.renameSync(dir, moved);
  fs.symlinkSync(moved, dir);
  assert.deepEqual(verdictOf(h2, 'acme/app', 'dev'), ['hold', 'setup-needed']);
  assert.match(evaluateGithub(h2, 'acme/app').verdict.detail, /카드 폴더 0를 읽을 수 없음\(폴더 링크\)/);
  assert.deepEqual(listRepos(h2, [], {origin: () => null}).unreadable.map(u => [u.folder, u.file]), [[0, null]]);
});

test('F3. 문서의 카드 예시를 그대로 복사하면 의도대로 판정된다(night_merge 금지 → 보류)', () => {
  const doc = fs.readFileSync(new URL('../docs/night-repo-cards.md', import.meta.url), 'utf8');
  const example = /```\n(---\n[\s\S]*?\n---)\n```/.exec(doc)[1].replace('github.com/소유자/이름', 'github.com/acme/app');
  const dir = tmp('kadan-f3-'), home = home0();
  write(dir, 'app.md', example + '\n');
  link(home, dir);
  assert.deepEqual(listRepos(home, [], {origin: () => null}).unreadable, []);
  assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['hold', 'night-merge-forbidden']);
  assert.equal(evaluateGithub(home, 'acme/app').effective.deployBranch.value, 'main');
  assert.match(doc, /`#` 주석은 지원하지 않는다/);
  assert.match(doc, /하나라도 못 읽으면, 두 칸을 카단 설정으로 다 정하지 않은 저장소는 설정 필요/);
});
