import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {autopilotCommand} from '../src/commands/autopilot.mjs';
import {autopilotGuard} from '../src/autopilot-guard.mjs';
import {createCenterHandler} from '../src/center-wall.mjs';
import {summarizeAutopilot} from '../src/autopilot-summary.mjs';
import {
  readPolicy, setRepoPolicy, normalizeGithub, parseRemote, parseDeployBranch, loadOntology, evaluateGithub, decideNightMerge,
  listRepos, policyPath, setupNeededLines,
} from '../src/autopilot-repo-policy.mjs';

// 격리 홈·임시 문서 폴더만 쓴다. 운영 홈·실제 개인 폴더·포트·GitHub에 닿지 않는다. 역할 이름·저장소 이름도 시험용이다.
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true}); fs.writeFileSync(path.join(root, rel), text); };
const card = (dir, name, front, {raw} = {}) => write(dir, `${name}.md`, raw ?? `---\nid: project/${name}\ntype: project\n${front}\n---\n\n## Why\n본문\n`);
const autopilotOn = home => appendLedger({kind: 'autopilot', phase: 'on', by: '사람', text: '시험', viaChat: false,
  until: new Date(Date.now() + 3600_000).toISOString(), to: [], delivered: [], t: new Date().toISOString()}, home);
const home0 = () => tmp('kadan-repo-policy-');
const set = (home, repo, fields = {}) => setRepoPolicy(home, {repo, by: '사람', ...fields});
// 사용자가 하듯이 문서 폴더를 `$KADAN_HOME/ontology/<이름>` 링크로 연결한다(기본 이름 notes).
const link = (home, dir, name = 'notes') => {
  fs.mkdirSync(path.join(home, 'ontology'), {recursive: true});
  fs.symlinkSync(dir, path.join(home, 'ontology', name));
};
const NO_ONTOLOGY = {exists: false, files: 0, projects: 0, unreadable: 0};
const decide = (home, github, baseBranch) => decideNightMerge(home, {github, baseBranch});
const verdictOf = (home, github, baseBranch) => { const d = decide(home, github, baseBranch); return [d.action, d.reason]; };

test('키: 소문자·끝 .git·끝 / 정규화, 올바르지 않은 키는 거절', () => {
  assert.equal(normalizeGithub('Acme/Site'), 'acme/site');
  assert.equal(normalizeGithub('Acme/Site.git'), 'acme/site');
  assert.equal(normalizeGithub(' Acme/Site.git/ '), 'acme/site');
  for (const bad of ['site', 'a/b/c', '/a/b', 'a/', '../x', 'a/..', './a', 'a/.', 'a b/c', '소유자/이름', '', null, undefined, 3])
    assert.equal(normalizeGithub(bad), null, String(bad));
});

test('1. 설정 없음·온톨로지 폴더 없음 → setup-needed(오류 아님). 개인 폴더 글롭도 환경변수도 읽지 않는다', () => {
  const home = home0();
  const hubs = tmp('kadan-notes-'); // 옛 글롭·환경변수 모양의 폴더를 만들어도 읽히지 않아야 한다
  card(path.join(hubs, 'notes/projects'), 'a', 'remote: acme/a\ndeploy_branch: 없음');
  process.env.KADAN_ONTOLOGY_DIRS = path.join(hubs, 'notes/projects');
  try {
    const info = evaluateGithub(home, 'acme/a');
    assert.deepEqual([info.verdict.action, info.verdict.reason], ['hold', 'setup-needed']);
    assert.deepEqual(info.card, null);
    assert.deepEqual(listRepos(home, [], {origin: () => null}), {corrupt: null, repos: [], legacy: [], sources: {ontology: NO_ONTOLOGY}, unreadable: []});
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
    ['autopilot-repo-policy', 'acme/site', {deployBranch: null, nightMerge: null}, {deployBranch: 'main', nightMerge: '금지'}],
    ['autopilot-repo-policy', 'acme/site', {deployBranch: 'main', nightMerge: '금지'}, {deployBranch: 'main', nightMerge: '허용'}],
    ['autopilot-repo-policy', 'acme/site', {deployBranch: 'main', nightMerge: '허용'}, {deployBranch: 'main', nightMerge: null}]]);
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

test('3. 온톨로지 문서가 빈 칸을 채우고, 카단 설정이 칸별로 문서를 이기고, 칸마다 출처가 보인다', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'site', 'remote: Acme/Site (비공개)\ndeploy_branch: main\nnight_merge: 허용');
  link(home, onto);
  const card_ = evaluateGithub(home, 'acme/site');
  assert.deepEqual(card_.effective, {deployBranch: {value: 'main', from: 'ontology'}, nightMerge: {value: '허용', from: 'ontology'}});
  assert.deepEqual(card_.card, {id: 'site', path: 'notes/site.md', deployBranch: 'main', nightMerge: '허용'});
  assert.deepEqual(verdictOf(home, 'acme/site', 'main'), ['hold', 'deploy-branch']);
  set(home, 'acme/site', {deployBranch: '없음'}); // 한 칸만 설정: 다른 칸은 문서
  const mixed = evaluateGithub(home, 'acme/site', {baseBranch: 'main'});
  assert.deepEqual(mixed.effective, {deployBranch: {value: '없음', from: 'kadan'}, nightMerge: {value: '허용', from: 'ontology'}});
  assert.deepEqual([mixed.verdict.action, mixed.verdict.reason], ['merge', 'allowed']);
  set(home, 'acme/site', {nightMerge: '금지'});
  assert.deepEqual(verdictOf(home, 'acme/site', 'dev'), ['hold', 'night-merge-forbidden']);
  // 문서가 없고 설정도 안 채운 칸은 출처가 null이다
  assert.deepEqual(evaluateGithub(home, 'acme/none').effective, {deployBranch: {value: null, from: null}, nightMerge: {value: null, from: null}});
  // 링크를 치우면 그 문서는 더 읽지 않는다
  fs.unlinkSync(path.join(home, 'ontology', 'notes'));
  assert.equal(evaluateGithub(home, 'acme/site').card, null);
});

test('4. 문서가 못 읽히는데 설정이 두 칸을 다 채우면 설정으로 판정, 한 칸만 채우면 setup-needed', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'dup1', 'remote: acme/app\ndeploy_branch: main');
  card(onto, 'dup2', 'remote: acme/app\ndeploy_branch: develop'); // 문서 둘 → 못 읽힘
  link(home, onto);
  assert.match(evaluateGithub(home, 'acme/app').verdict.detail, /문서가 여럿/);
  assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['hold', 'setup-needed']);
  set(home, 'acme/app', {deployBranch: 'main'});
  assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['hold', 'setup-needed']); // nightMerge 칸이 못 읽힘
  set(home, 'acme/app', {nightMerge: '허용'});
  assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['merge', 'allowed']);
  assert.deepEqual(verdictOf(home, 'acme/app', 'main'), ['hold', 'deploy-branch']);
  // 문서 한 장의 deploy_branch 칸만 못 읽히면 그 칸만 설정이 대신한다
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
  assert.match(autopilotCommand(['repo', 'list'], {}, {home, by: '사람', deps: {readWorks: () => [], origin: () => null}}), /옛 형식 저장값\(판정에 쓰지 않음\): site = hold/);
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
  assert.equal(readPolicy(home).corrupt, null); // 예전 cards 칸은 읽지도 검사하지도 않는다
});

test('정책: 읽기 권한 오류·임시 파일 쓰기 실패 문구에도 절대 경로가 없다', () => {
  const home = tmp('kadan-repo-policy-');
  set(home, 'acme/site', {deployBranch: 'main'});
  fs.chmodSync(policyPath(home), 0o000);
  try {
    const {corrupt} = readPolicy(home);
    assert.match(corrupt, /autopilot-repo-policy\.json \(EACCES\)/);
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

test('8. 문서 찾기·우산 문서·엄격 읽기: 짝 목록이 remote보다 먼저, 목록에 없는 키는 못 찾고, night_merge는 문서 전체에 적용', () => {
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
  assert.deepEqual(rows.map(r => r.github), ['acme/admin', 'acme/plain', 'acme/web']); // 온톨로지 문서에서 읽힌 키
  // 판정 칸 엄격 읽기(검수 F1): 형식 틀림·중복은 못 읽음 → setup-needed, 정상 카드는 그대로
  const strict = fields => {
    const d = tmp('kadan-strict-'), h = home0();
    write(d, 'app.md', `---\ntype: project\nremote: Acme/App\n${fields}\n---\n`);
    link(h, d);
    return [h, evaluateGithub(h, 'acme/app', {baseBranch: 'dev'}).verdict];
  };
  for (const bad of ['deploy_branch: main\nnight_merge: 금지\nnight_merge: 허용', 'deploy_branch: main\n  night_merge: 허용', 'deploy_branch: main\n"night_merge": 금지',
    'Deploy_Branch: main', 'deploy_branch: main\nnight_merge: 모름', 'deploy_branch: main\nnight_merge:'])
    assert.equal(strict(bad)[1].reason, 'setup-needed', bad);
  assert.deepEqual(strict('deploy_branch: main')[1].reason, 'allowed'); // night_merge 칸이 아예 없으면 허용
  assert.match(strict('deploy_branch: main\nnight_merge: 금지\nnight_merge: 허용')[1].detail, /줄 \d+·\d+/);
  // 연결한 폴더가 사라지면(깨진 링크) 조용히 건너뛰지 않고 못 읽힘이다(절대 경로 없는 문구)
  fs.rmSync(onto, {recursive: true});
  const gone = evaluateGithub(home, 'acme/plain');
  assert.equal(gone.verdict.reason, 'setup-needed');
  assert.match(gone.verdict.detail, /온톨로지 문서 1건을 읽지 못함/);
  assert.ok(!JSON.stringify(gone).includes(onto));
});

test('목록: 설정 키·온톨로지 문서 키·업무 저장소(git origin)를 합치고, 각 줄 판정은 decideNightMerge와 같다', () => {
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
    ['설정 필요: acme/site — Autopilot 중 자동 머지 안 함(kadan autopilot repo acme/site --deploy-branch <브랜치|없음>)', '설정 필요: acme/ok-none — Autopilot 중 자동 머지 안 함(kadan autopilot repo acme/ok-none --deploy-branch <브랜치|없음>)']);
});

test('autopilotGuard: 켜짐+역할 세션의 autopilot repo 쓰기는 거절, 읽기는 통과, 꺼짐·사람은 통과. autopilot source는 더 이상 규칙이 없다', () => {
  const home = tmp('kadan-repo-guard-');
  const env = {KADAN_ROLE: 'a-작업자'};
  const call = (args, flags = {}, e = env) => autopilotGuard({command: 'autopilot', args, flags, home, env: e});
  call(['repo', 'acme/kadan'], {'deploy-branch': 'main'}); // 꺼져 있으면 통과
  autopilotOn(home);
  assert.throws(() => call(['repo', 'acme/kadan'], {'deploy-branch': 'main'}), error => error.exitCode === 2 && /autopilot repo acme\/kadan/.test(error.message));
  for (const args of [['repo'], ['repo', 'list'], ['repo', 'show', 'acme/kadan'], ['source']]) call(args); // source는 명령 쪽에서 모르는 하위 명령 오류가 난다
  call(['repo', 'acme/kadan'], {'deploy-branch': 'main'}, {}); // 사람(역할 없음)
});

test('CLI 실행: 설정 저장, autopilot source는 없어짐, 켜짐+역할 세션은 종료 2·저장 안 됨, 읽기는 통과, 예전 merge|hold는 거절', () => {
  const home = tmp('kadan-repo-cli2-');
  const onto = tmp('kadan-onto-');
  card(onto, 'site', 'remote: acme/site\ndeploy_branch: main');
  link(home, onto);
  const run = (argv, role) => spawnSync(process.execPath, [CLI, ...argv], {
    env: {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none', KADAN_ROLE: role ?? ''}, encoding: 'utf8', timeout: 20_000});
  for (const argv of [['autopilot', 'source'], ['autopilot', 'source', '--cards', onto], ['autopilot', 'source', '--clear']]) {
    const gone = run(argv);
    assert.equal(gone.status, 1, argv.join(' '));
    assert.match(gone.stderr, /알 수 없는 autopilot 명령/);
  }
  assert.ok(!fs.existsSync(policyPath(home)));
  const saved = run(['autopilot', 'repo', 'Acme/Site', '--night-merge', '금지']);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /nightMerge 금지/);
  assert.match(saved.stdout, /온톨로지 문서 notes\/site\.md/);
  assert.ok(!saved.stdout.includes(onto) && !saved.stdout.includes(home));
  assert.match(saved.stdout, /최종 판정 Autopilot 중 자동 머지 안 함 \(night-merge-forbidden\)/);
  assert.equal(run(['autopilot', 'repo', 'acme/site', 'hold']).status, 1); // 예전 merge|hold 쓰기는 없다
  assert.equal(run(['autopilot', 'repo', 'acme/site', '--deploy-branch']).status, 1); // 값 없음
  autopilotOn(home);
  const before = fs.readFileSync(policyPath(home), 'utf8');
  const denied = run(['autopilot', 'repo', 'acme/kadan', '--deploy-branch', 'main'], 'a-작업자');
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /Autopilot이 켜져 있어/);
  assert.equal(fs.readFileSync(policyPath(home), 'utf8'), before);
  assert.equal(run(['autopilot', 'repo', 'list'], 'a-작업자').status, 0);
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

test('7. API: GET 모양(원문 예)·절대 경로 없음, POST는 칸 일부만 바꾸고 기존 거절(토큰·출처·원격 405·Autopilot 켜짐 409)은 그대로', async () => {
  const home = tmp('kadan-repo-api-');
  const onto = tmp('kadan-onto-');
  card(onto, 'shop', 'remote: Acme/Shop (비공개)\ndeploy_branch: main');
  card(onto, 'umb', 'deploy_branch: {Acme/Web: main, Acme/Admin: 없음}\nnight_merge: 금지');
  write(onto, 'account.md', '---\ntype: account\nremote: acme/shop\nnight_merge: 금지\n---\n'); // 다른 type은 영향 없음
  link(home, onto);
  const handler = createCenterHandler(home);
  const get = JSON.parse((await call(handler, fakeReq('GET', '/api/autopilot/repos'))).body);
  assert.deepEqual(Object.keys(get), ['corrupt', 'repos', 'legacy', 'sources', 'unreadable']);
  assert.deepEqual(get.sources, {ontology: {exists: true, files: 3, projects: 2, unreadable: 0}});
  const shop = get.repos.find(r => r.github === 'acme/shop');
  assert.deepEqual(shop, {github: 'acme/shop', repo: null,
    settings: {deployBranch: null, nightMerge: null, at: null, by: null},
    card: {id: 'shop', path: 'notes/shop.md', deployBranch: 'main', nightMerge: null},
    effective: {deployBranch: {value: 'main', from: 'ontology'}, nightMerge: {value: null, from: null}},
    verdict: {action: 'merge', reason: 'allowed', detail: null, exceptBranch: 'main'}});
  assert.deepEqual(get.repos.filter(r => r.github.startsWith('acme/') && r.github !== 'acme/shop').map(r => [r.github, r.verdict.reason]),
    [['acme/admin', 'night-merge-forbidden'], ['acme/web', 'night-merge-forbidden']]);
  assert.ok(!JSON.stringify(get).includes(onto) && !JSON.stringify(get).includes(home));

  const post = (fields, opts) => call(handler, fakeReq('POST', '/api/autopilot/repos', {body: form(handler, fields), ...opts}));
  assert.equal((await call(handler, fakeReq('POST', '/api/autopilot/repos', {body: new URLSearchParams({repo: 'acme/site', deployBranch: 'main'}).toString()}))).status, 403); // 토큰 없음
  assert.equal((await post({repo: 'acme/site', deployBranch: 'main'}, {origin: 'http://evil.example'})).status, 403);
  assert.equal((await post({repo: 'acme/site', deployBranch: 'main'}, {remote: true})).status, 405);
  assert.deepEqual(readPolicy(home).repos, {});
  assert.equal((await post({repo: 'Acme/Site.git', deployBranch: 'main'})).status, 200);
  assert.equal((await post({repo: 'acme/site', nightMerge: '금지', deployBranch: ''})).status, 200); // 빈 값은 그대로 둔다
  assert.deepEqual(readPolicy(home).repos['acme/site'], {deployBranch: 'main', nightMerge: '금지', at: readPolicy(home).repos['acme/site'].at, by: '사람'});
  for (const bad of [{repo: 'acme/site', nightMerge: 'merge'}, {repo: 'site', deployBranch: 'main'}, {repo: 'acme/site', deployBranch: 'a b'}, {repo: 'acme/site'}]) {
    assert.equal((await post(bad)).status, 409, JSON.stringify(bad));
  }
  assert.equal((await call(handler, fakeReq('POST', '/api/autopilot/sources', {body: form(handler, {cards: '/x'})}))).handled, false); // 연결 바꾸기는 API로 열지 않는다
  autopilotOn(home);
  const blocked = await post({repo: 'acme/site', deployBranch: 'dev'});
  assert.equal(blocked.status, 409);
  assert.match(blocked.body, /Autopilot이 켜진 동안은 바꿀 수 없음/);
  assert.equal(readPolicy(home).repos['acme/site'].deployBranch, 'main');
});

test('POST 오류 응답에는 절대 경로·OS 원문이 없다(손상 파일, 임시 파일 쓰기 실패)', async () => {
  const home = tmp('kadan-repo-post-corrupt-');
  fs.writeFileSync(policyPath(home), '{bad');
  const handler = createCenterHandler(home);
  const r = await call(handler, fakeReq('POST', '/api/autopilot/repos', {body: form(handler, {repo: 'acme/app', deployBranch: 'main'})}));
  assert.equal(r.status, 409);
  assert.ok(!r.body.includes(home), r.body);
  assert.match(r.body, /autopilot-repo-policy\.json[\s\S]*JSON 구문 오류/);
  assert.equal(fs.readFileSync(policyPath(home), 'utf8'), '{bad');
  const home2 = tmp('kadan-repo-post-eisdir-');
  fs.mkdirSync(`${policyPath(home2)}.${process.pid}.tmp`);
  const handler2 = createCenterHandler(home2);
  const r2 = await call(handler2, fakeReq('POST', '/api/autopilot/repos', {body: form(handler2, {repo: 'acme/app', deployBranch: 'main'})}));
  assert.equal(r2.status, 409);
  assert.equal(r2.body, 'Autopilot 저장소 정책 처리 실패(EISDIR)');
});

test('아침 요약: 배포 저장소 보류 PR이 근거 파일과 함께 따로 보인다', () => {
  const T0 = Date.parse('2026-11-03T14:00:00.000Z');
  const start = {kind: 'autopilot', phase: 'on', by: '사람', text: '밤', viaChat: false, t: new Date(T0).toISOString(), until: new Date(T0 + 8 * 3600_000).toISOString(), to: [], delivered: []};
  const hold = {kind: 'autopilot-note', noteKind: 'hold', text: '사이트 PR 보류', by: 'a-감독', t: new Date(T0 + 60_000).toISOString(),
    holdKind: 'deploy-repo', pr: 'site#7', reason: 'vercel.json'};
  const s = summarizeAutopilot({start, phase: 'expired', endedAt: T0 + 8 * 3600_000, entries: [hold], decisionEvents: [], readBody: () => null});
  assert.match(s.text, /배포 저장소 보류[^\n]*site#7[^\n]*근거: vercel\.json/);
  assert.equal(s.counts.noteHolds['deploy-repo'], 1);
});

test('예전 정책 파일의 cards 칸은 판정에 쓰지 않고, 다시 써도 지우지 않는다', () => {
  const home = home0();
  const onto = tmp('kadan-onto-');
  card(onto, 'app', 'remote: acme/app\ndeploy_branch: main\nnight_merge: 금지');
  fs.writeFileSync(policyPath(home), JSON.stringify({version: 2, repos: {}, cards: [onto]}));
  assert.equal(readPolicy(home).corrupt, null);
  assert.equal(evaluateGithub(home, 'acme/app').card, null); // 예전에 연결했던 폴더는 읽지 않는다
  assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['hold', 'setup-needed']);
  set(home, 'acme/app', {deployBranch: 'main'});
  assert.deepEqual(JSON.parse(fs.readFileSync(policyPath(home), 'utf8')).cards, [onto]);
  assert.deepEqual(listRepos(home, [], {origin: () => null}).sources, {ontology: NO_ONTOLOGY});
});

// ---- PR #333 검수 F1·F3 (읽지 못한 문서는 "없음"이 아니다 / 문서 예시)를 온톨로지 폴더로 옮김 ----
// 금지 카드 하나와 카단 설정(deployBranch만 채움)을 만들고, 그 카드를 망가뜨린 뒤 판정한다.
const forbidSetup = (mutate) => {
  const home = home0(), dir = tmp('kadan-f1-');
  const file = path.join(dir, 'app.md');
  fs.writeFileSync(file, '---\ntype: project\nremote: acme/app\ndeploy_branch: main\nnight_merge: 금지\n---\n');
  link(home, dir);
  set(home, 'acme/app', {deployBranch: '없음'});
  mutate?.(file);
  return home;
};

test('F1. 읽지 못한 문서는 없는 문서가 아니다: 앞머리 손상·권한 오류·remote 형식 틀림이면 두 칸을 다 못 채운 저장소는 setup-needed', () => {
  const cases = {
    '닫는 --- 없음': f => fs.writeFileSync(f, '---\ntype: project\nremote: acme/app\nnight_merge: 금지\n'),
    '권한 오류': f => fs.chmodSync(f, 0o000),
    'remote 키 형식 틀림': f => fs.writeFileSync(f, '---\ntype: project\nremote : acme/app\nnight_merge: 금지\n---\n'),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const home = forbidSetup(mutate);
    const d = decide(home, 'Acme/App.git/', 'dev');
    assert.deepEqual([d.action, d.reason], ['hold', 'setup-needed'], name);
    assert.match(evaluateGithub(home, 'acme/app').verdict.detail, /온톨로지 문서 1건을 읽지 못함/, name);
    assert.ok(!evaluateGithub(home, 'acme/app').verdict.detail.includes(os.tmpdir()), name);
    // 다른 저장소도(그 문서가 누구 것인지 모르니) 두 칸을 설정으로 다 정하지 않았으면 보류
    assert.deepEqual(verdictOf(home, 'acme/other', 'dev'), ['hold', 'setup-needed'], name);
    // 반대 대조: 두 칸을 설정으로 다 채우면 손상 문서가 있어도 설정대로
    set(home, 'acme/app', {deployBranch: 'main', nightMerge: '허용'});
    assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['merge', 'allowed'], name);
    assert.deepEqual(verdictOf(home, 'acme/app', 'main'), ['hold', 'deploy-branch'], name);
    set(home, 'acme/app', {nightMerge: '금지'});
    assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['hold', 'night-merge-forbidden'], name);
    for (const f of fs.readdirSync(path.join(home, 'ontology', 'notes'))) fs.chmodSync(path.join(home, 'ontology', 'notes', f), 0o600); // 임시 파일 권한 복원
  }
});

test('F1. 목록(GET·CLI)에 unreadable이 상대 경로·이유로 보이고 절대 경로는 없다', () => {
  const home = forbidSetup(f => fs.writeFileSync(f, '---\ntype: project\nremote: acme/app\n'));
  const out = listRepos(home, [], {origin: () => null});
  assert.deepEqual(out.unreadable, [{path: 'notes/app.md', reason: '앞머리를 읽을 수 없음'}]);
  assert.ok(!JSON.stringify(out).includes(os.tmpdir()));
  // deploy_branch 짝 목록 형식이 틀려도 읽지 못한 문서다
  const dir = tmp('kadan-f1-map-'), h2 = home0();
  card(dir, 'umb', 'deploy_branch: {Acme/Web: main, 깨짐');
  link(h2, dir);
  assert.deepEqual(listRepos(h2, [], {origin: () => null}).unreadable, [{path: 'notes/umb.md', reason: 'deploy_branch 짝 목록 형식이 틀림'}]);
});

test('F1. 반대 대조: 정상 금지 문서는 hold, night_merge 칸이 정말 없는 정상 문서는 merge, 설정 main + 대상 main은 hold', () => {
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

test('F3. 문서의 예시를 그대로 복사하면 의도대로 판정된다(night_merge 금지 → 보류)', () => {
  const doc = fs.readFileSync(new URL('../docs/autopilot-repo-cards.md', import.meta.url), 'utf8');
  const example = /```\n(---\n[\s\S]*?\n---)\n```/.exec(doc)[1].replace('github.com/소유자/이름', 'github.com/acme/app');
  const dir = tmp('kadan-f3-'), home = home0();
  write(dir, 'app.md', example + '\n');
  link(home, dir);
  assert.deepEqual(listRepos(home, [], {origin: () => null}).unreadable, []);
  assert.deepEqual(verdictOf(home, 'acme/app', 'dev'), ['hold', 'night-merge-forbidden']);
  assert.equal(evaluateGithub(home, 'acme/app').effective.deployBranch.value, 'main');
  assert.match(doc, /`#` 주석은 지원하지 않는다/);
  assert.match(doc, /읽지 못한 문서가 하나라도 있으면, 두 칸을 카단 설정으로 다 정하지 않은 저장소는 설정 필요/);
});

// ---- 온톨로지 폴더 훑기 (PR C2a) ----
const onto = home => path.join(home, 'ontology');
const rels = ontology => ontology.cards.map(c => c.path).sort();

test('O1. 하위 폴더 문서를 읽고, 링크 폴더·링크 파일(폴더 밖을 가리키는 것 포함)을 따라간다. .git·node_modules·.md 아닌 파일은 건너뛴다', () => {
  const home = home0(), outside = tmp('kadan-outside-');
  card(path.join(onto(home), 'deep/er'), 'a', 'remote: acme/a\ndeploy_branch: main');
  card(outside, 'b', 'remote: acme/b\ndeploy_branch: 없음');
  card(outside, 'c', 'remote: acme/c\ndeploy_branch: 없음');
  fs.symlinkSync(outside, path.join(onto(home), 'linked-dir'));
  fs.symlinkSync(path.join(outside, 'c.md'), path.join(onto(home), 'deep', 'c-file.md'));
  card(path.join(onto(home), '.git'), 'skip1', 'remote: acme/s1');
  card(path.join(onto(home), 'node_modules/x'), 'skip2', 'remote: acme/s2');
  write(onto(home), 'memo.txt', '---\ntype: project\nremote: acme/txt\n---\n');
  const out = loadOntology(home);
  // 같은 실제 파일(outside/c.md)은 링크 경로가 둘이어도 한 번만 읽는다: 먼저 만나는 쪽(정렬 순서의 deep/c-file.md)이 남는다
  assert.deepEqual(rels(out), ['deep/c-file.md', 'deep/er/a.md', 'linked-dir/b.md']);
  assert.deepEqual(out.stats, {exists: true, files: 3, projects: 3, unreadable: 0});
  assert.deepEqual(verdictOf(home, 'acme/a', 'dev'), ['merge', 'allowed']); // 하위 폴더 문서(a는 main 배포)로 판정
  assert.deepEqual(verdictOf(home, 'acme/a', 'main'), ['hold', 'deploy-branch']);
});

test('O2. 순환 링크(a→b→a, 자기 자신)에서도 끝나고 같은 파일·폴더를 두 번 세지 않는다', () => {
  const home = home0();
  card(path.join(onto(home), 'a'), 'doc', 'remote: acme/doc\ndeploy_branch: 없음');
  fs.symlinkSync(path.join(onto(home), 'b'), path.join(onto(home), 'a', 'to-b'));
  fs.mkdirSync(path.join(onto(home), 'b'));
  fs.symlinkSync(path.join(onto(home), 'a'), path.join(onto(home), 'b', 'to-a'));
  fs.symlinkSync(path.join(onto(home), 'a', 'self'), path.join(onto(home), 'a', 'self')); // 자기 자신을 가리키는 링크
  fs.symlinkSync(onto(home), path.join(onto(home), 'a', 'root-again')); // 루트로 되돌아가는 링크
  fs.symlinkSync(path.join(onto(home), 'a'), path.join(onto(home), 'a-twin')); // 같은 폴더를 두 이름으로
  const out = loadOntology(home);
  assert.deepEqual(rels(out), ['a/doc.md']);
  assert.equal(out.stats.files, 1);
  // 자기 자신 링크는 stat이 실패(ELOOP)해 읽지 못함 1건이다: 판정은 안전 쪽
  assert.equal(out.unreadableCards.length, 1);
  assert.match(out.unreadableCards[0].reason, /읽을 수 없음/);
  assert.deepEqual(verdictOf(home, 'acme/doc', 'dev'), ['hold', 'setup-needed']);
});

test('O3. 상한(깊이·폴더·파일)을 넘으면 읽기를 멈추고 읽지 못함 1건, 판정은 안전 쪽. 상한은 주입해 작게 시험한다', () => {
  const mk = () => {
    const home = home0();
    for (const n of ['a', 'b', 'c']) card(path.join(onto(home), n), `doc-${n}`, `remote: acme/${n}\ndeploy_branch: 없음`);
    return home;
  };
  const home = mk();
  assert.equal(loadOntology(home).unreadable, null); // 기본 상한 안
  for (const [name, limits] of [['폴더', {depth: 8, dirs: 3, files: 100}], ['파일', {depth: 8, dirs: 100, files: 2}], ['깊이', {depth: 0, dirs: 100, files: 100}]]) {
    const out = loadOntology(home, {limits});
    assert.match(out.unreadable, /^온톨로지 폴더 상한 초과/, name);
    assert.equal(out.unreadableList.filter(u => u.path === null).length, 1, name);
    // 판정: 설정이 두 칸을 다 채우지 않은 저장소는 setup-needed
    const info = evaluateGithub(home, 'acme/a', {baseBranch: 'dev', ontology: out});
    assert.deepEqual([info.verdict.action, info.verdict.reason], ['hold', 'setup-needed'], name);
    assert.match(info.verdict.detail, /상한 초과/, name);
    assert.deepEqual(decideNightMerge(home, {github: 'acme/a', baseBranch: 'dev', ontology: out}).action, 'hold', name);
    assert.ok(!JSON.stringify(info).includes(home), name);
  }
  // 목록(API 값)에도 한 건으로 보이고, 설정이 두 칸을 다 채운 저장소는 설정대로 판정한다
  set(home, 'acme/a', {deployBranch: 'main', nightMerge: '허용'});
  const listed = listRepos(home, [], {origin: () => null, limits: {depth: 8, dirs: 3, files: 100}});
  assert.equal(listed.unreadable.length, 1);
  assert.deepEqual(listed.sources.ontology.unreadable, 1);
  assert.deepEqual(listed.repos.filter(r => r.github === 'acme/a').map(r => r.verdict.reason), ['allowed']);
});

test('O4. 다른 type 문서와 앞머리 없는 README는 읽고 무시하고, type 칸 없음·틀림·깨진 앞머리는 읽지 못함이다', () => {
  const home = home0();
  card(onto(home), 'ok', 'remote: acme/ok\ndeploy_branch: 없음');
  write(onto(home), 'accounts/acct.md', '---\ntype: account\nremote: acme/ok\nnight_merge: 금지\ndeploy_branch: main\n---\n');
  write(onto(home), 'devices/dev.md', '---\ntype: device\nnight_merge: 모름\nnight_merge: 두번\n---\n'); // 판정 칸이 틀려도 project가 아니면 무시
  write(onto(home), 'README.md', '# 안내\nremote: acme/ok\nnight_merge: 금지\n');
  write(onto(home), 'rule.md', '---\ntype: "rule"\n---\n');
  let out = loadOntology(home);
  assert.deepEqual(rels(out), ['ok.md']);
  assert.deepEqual(out.unreadableList, []);
  assert.deepEqual(verdictOf(home, 'acme/ok', 'main'), ['merge', 'allowed']); // account의 금지·main이 영향 없음
  assert.equal(listRepos(home, [], {origin: () => null}).sources.ontology.files, 5);
  // type 칸이 없는 앞머리 문서 → 읽지 못함(project 문서일 수도 있음)
  write(onto(home), 'maybe.md', '---\nremote: acme/maybe\ndeploy_branch: main\n---\n');
  out = loadOntology(home);
  assert.deepEqual(out.unreadableList, [{path: 'maybe.md', reason: 'type 칸이 없음'}]);
  assert.deepEqual(verdictOf(home, 'acme/ok', 'main'), ['hold', 'setup-needed']);
  set(home, 'acme/ok', {deployBranch: '없음', nightMerge: '허용'});
  assert.deepEqual(verdictOf(home, 'acme/ok', 'main'), ['merge', 'allowed']); // 설정이 두 칸을 다 채우면 설정대로
  // 그 밖의 type 문제: 중복·형식 틀림·project로 보이는 틀린 값·깨진 앞머리
  const bad = {'dup.md': '---\ntype: project\ntype: account\n---\n', 'form.md': '---\n"type" : project\n---\n', 'case.md': '---\ntype: Project\n---\n',
    'note.md': '---\ntype: project # 메모\n---\n', 'empty.md': '---\ntype:\n---\n', 'open.md': '---\ntype: account\n'};
  for (const [name, text] of Object.entries(bad)) { write(onto(home), name, text); fs.rmSync(path.join(onto(home), 'maybe.md'), {force: true}); }
  out = loadOntology(home);
  assert.deepEqual(out.unreadableList.map(u => u.path).sort(), Object.keys(bad).sort());
  // 괄호 설명이 붙은 project와 들여쓴 하위 type은 읽는다
  const h2 = home0();
  write(onto(h2), 'p.md', '---\ntype: project (카드)\nowner:\n  type: person\nremote: acme/p\ndeploy_branch: 없음\n---\n');
  assert.deepEqual([rels(loadOntology(h2)), loadOntology(h2).unreadableList], [['p.md'], []]);
});

test('O5. 깨진 링크와 권한 오류(폴더·파일)는 읽지 못함이고 판정은 안전 쪽이다', () => {
  const home = home0();
  card(onto(home), 'ok', 'remote: acme/ok\ndeploy_branch: 없음');
  fs.symlinkSync(path.join(home, '없는-곳'), path.join(onto(home), 'broken'));
  write(onto(home), 'locked/x.md', '---\ntype: project\n---\n');
  write(onto(home), 'secret.md', '---\ntype: project\n---\n');
  fs.chmodSync(path.join(onto(home), 'locked'), 0o000);
  fs.chmodSync(path.join(onto(home), 'secret.md'), 0o000);
  try {
    const out = loadOntology(home);
    assert.deepEqual(out.unreadableList.map(u => u.path).sort(), ['broken', 'locked', 'secret.md']);
    assert.deepEqual(rels(out), ['ok.md']);
    assert.ok(!JSON.stringify(out).includes(home));
    assert.deepEqual(verdictOf(home, 'acme/ok', 'dev'), ['hold', 'setup-needed']);
  } finally { fs.chmodSync(path.join(onto(home), 'locked'), 0o700); fs.chmodSync(path.join(onto(home), 'secret.md'), 0o600); }
  // 루트가 폴더가 아니면 폴더 전체를 못 읽음
  const h2 = home0();
  fs.writeFileSync(onto(h2), '파일');
  assert.deepEqual(loadOntology(h2).stats, {exists: false, files: 0, projects: 0, unreadable: 0}); // 폴더가 아니면 없는 것과 같다
});

test('O6. 홈 안 ontology 자체가 링크여도 따라가고, 목록 API는 숫자만 담는다', () => {
  const home = home0(), real = tmp('kadan-real-onto-');
  card(real, 'x', 'remote: acme/x\ndeploy_branch: 없음');
  fs.symlinkSync(real, onto(home));
  assert.deepEqual(rels(loadOntology(home)), ['x.md']);
  const sources = listRepos(home, [], {origin: () => null}).sources;
  assert.deepEqual(sources, {ontology: {exists: true, files: 1, projects: 1, unreadable: 0}});
  assert.ok(!JSON.stringify(sources).includes(real));
});

test('O7. type 값은 엄격하다: 닫지 않은 따옴표·대문자·공백 낀 값은 못 읽음, 정상 인용·공백은 project, 올바른 다른 낱말만 무시', () => {
  const run = type => {
    const home = home0();
    set(home, 'acme/app', {deployBranch: '없음'});
    write(onto(home), 'd.md', `---\ntype: ${type}\nremote: acme/app\ndeploy_branch: main\nnight_merge: 금지\n---\n`);
    return verdictOf(home, 'acme/app', 'dev');
  };
  for (const type of ["'project", '"project', 'project"', "'Project'", 'my project', 'project x', '""', "''"])
    assert.deepEqual(run(type), ['hold', 'setup-needed'], type);
  for (const type of ['project', '"project"', "'project'", '   project   ', '"project" '])
    assert.deepEqual(run(type), ['hold', 'night-merge-forbidden'], type);
  for (const type of ['account', '"device"', 'rule-x_1']) assert.deepEqual(run(type), ['merge', 'allowed'], type);
});

test('O8. 루트 ontology 링크: 깨진 링크·파일을 가리키는 링크는 못 읽음, 정상 링크는 읽고, 아예 없으면 빈 상태', () => {
  const setup = () => { const home = home0(); set(home, 'acme/app', {deployBranch: '없음'}); return home; };
  const broken = setup();
  fs.symlinkSync(path.join(broken, '없는-곳'), onto(broken));
  assert.deepEqual(verdictOf(broken, 'acme/app', 'dev'), ['hold', 'setup-needed']);
  assert.deepEqual(loadOntology(broken).stats, {exists: true, files: 0, projects: 0, unreadable: 1});
  const toFile = setup(), file = path.join(toFile, 'plain.txt');
  fs.writeFileSync(file, '파일');
  fs.symlinkSync(file, onto(toFile));
  assert.deepEqual(verdictOf(toFile, 'acme/app', 'dev'), ['hold', 'setup-needed']);
  const good = setup(), real = tmp('kadan-real-onto-');
  write(real, 'f.md', '---\ntype: project\nremote: acme/app\ndeploy_branch: main\nnight_merge: 금지\n---\n');
  fs.symlinkSync(real, onto(good));
  assert.deepEqual(verdictOf(good, 'acme/app', 'dev'), ['hold', 'night-merge-forbidden']);
  const none = setup();
  assert.deepEqual(loadOntology(none).stats, NO_ONTOLOGY);
  assert.deepEqual(verdictOf(none, 'acme/app', 'dev'), ['merge', 'allowed']);
});
