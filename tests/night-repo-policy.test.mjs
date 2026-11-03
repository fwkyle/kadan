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
import {readPolicy, setRepoPolicy, detectDeploy, decide, evaluateRepo, policyPath, findDeployWord} from '../src/night-repo-policy.mjs';

// 격리 홈·가짜 저장소 폴더만 쓴다. 운영 홈·실제 포트·GitHub에 닿지 않는다. 역할 이름도 시험용이다.
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true}); fs.writeFileSync(path.join(root, rel), text); };
const flow = on => `name: x\non:\n${on}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
const withDeploy = text => `${text}      - run: npx wrangler deploy\n`;
const nightOn = home => appendLedger({kind: 'night', phase: 'on', by: '사람', text: '시험', viaChat: false,
  until: new Date(Date.now() + 3600_000).toISOString(), to: [], delivered: [], t: new Date().toISOString()}, home);

test('정책: 값 없음은 auto, 저장·읽기·덮어쓰기와 원장 한 줄', () => {
  const home = tmp('kadan-repo-policy-');
  const records = [];
  const record = e => records.push(e);
  assert.deepEqual(readPolicy(home), {repos: {}, corrupt: null});
  assert.equal(evaluateRepo(home, 'site', {repoPath: null}).value, 'auto');
  setRepoPolicy(home, {repo: 'site', value: 'hold', by: '사람', now: () => '2026-11-03T00:00:00.000Z', record});
  setRepoPolicy(home, {repo: 'site', value: 'merge', by: 'a-감독', now: () => '2026-11-03T01:00:00.000Z', record});
  assert.deepEqual(readPolicy(home).repos.site, {value: 'merge', at: '2026-11-03T01:00:00.000Z', by: 'a-감독'});
  assert.deepEqual(records.map(r => [r.kind, r.before, r.after]), [['night-repo-policy', null, 'hold'], ['night-repo-policy', 'hold', 'merge']]);
  assert.equal((fs.statSync(policyPath(home)).mode & 0o777), 0o600);
  assert.throws(() => setRepoPolicy(home, {repo: 'site', value: 'x', by: '사람'}), /merge\|hold\|auto/);
  assert.throws(() => setRepoPolicy(home, {repo: '../x', value: 'hold', by: '사람'}), /저장소 이름/);
});

test('정책: 손상 파일은 쓰기 거절(파일 그대로), 읽기는 hold', () => {
  const home = tmp('kadan-repo-policy-');
  fs.writeFileSync(policyPath(home), '{깨진');
  assert.throws(() => setRepoPolicy(home, {repo: 'site', value: 'merge', by: '사람'}), /손상/);
  assert.equal(fs.readFileSync(policyPath(home), 'utf8'), '{깨진');
  const info = evaluateRepo(home, 'site', {repoPath: tmp('kadan-clean-repo-')});
  assert.equal(info.verdict.action, 'hold');
  assert.match(info.verdict.detail, /손상/);
  fs.writeFileSync(policyPath(home), JSON.stringify({version: 1, repos: {site: {value: 'zzz'}}}));
  assert.ok(readPolicy(home).corrupt);
});

test('판별: 설정 파일·워크플로 push main+배포 → deploy, test만·파일 없음 → clean, 경로 없음 → unknown', () => {
  const vercel = tmp('kadan-det-');
  write(vercel, 'vercel.json', '{}');
  const v = detectDeploy(vercel);
  assert.equal(v.result, 'deploy');
  assert.deepEqual(v.files, ['vercel.json']);

  const ci = tmp('kadan-det-');
  write(ci, '.github/workflows/deploy.yml', withDeploy(flow('  push:\n    branches: [main]')));
  const d = detectDeploy(ci);
  assert.equal(d.result, 'deploy');
  assert.deepEqual(d.files, ['.github/workflows/deploy.yml']);

  const testOnly = tmp('kadan-det-');
  write(testOnly, '.github/workflows/ci.yml', flow('  push:\n    branches: [main]\n  pull_request:'));
  const t = detectDeploy(testOnly);
  assert.equal(t.result, 'clean');
  assert.ok(t.checked.includes('.github/workflows/ci.yml') && t.checked.includes('vercel.json'));

  assert.equal(detectDeploy(tmp('kadan-det-')).result, 'clean');
  assert.equal(detectDeploy(null).result, 'unknown');
  assert.equal(detectDeploy('/nonexistent-kadan-path-xyz').result, 'unknown');
  assert.equal(detectDeploy('상대/경로').result, 'unknown');
});

const repoWith = files => { const r = tmp('kadan-det-'); for (const [rel, text] of Object.entries(files)) write(r, rel, text); return r; };
const deployStep = '      - run: vercel deploy\n';
const hold = r => decide('auto', detectDeploy(r)).action === 'hold';

test('판별: 트리거를 읽지 않고 배포 낱말이 보이면 보류(검수 F1~F4 입력)', () => {
  const head = 'name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n';
  const cases = {
    'F1 따옴표 push': `on:\n  "push":\n    branches: [main]\n${head}${deployStep}`,
    'F2 branches-ignore main': `on:\n  push:\n    branches-ignore: [main]\n${head}${deployStep}`,
    'F3 기본 브랜치 trunk, 참조 없음': `on:\n  push:\n    branches: [trunk]\n${head}${deployStep}`,
    'flow map on': `on: {push: {branches: [main]}}\n${head}${deployStep}`,
    '확장자 대문자': `on: push\n${head}${deployStep}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const r = repoWith({[`.github/workflows/${name.startsWith('확장자') ? 'ci.YAML' : 'ci.yml'}`]: text});
    assert.equal(detectDeploy(r).result, 'deploy', name);
    assert.ok(hold(r), name);
  }
  // 워크플로 하위 폴더도 재귀로 본다.
  assert.equal(detectDeploy(repoWith({'.github/workflows/sub/ship.yml': `on: push\n${head}${deployStep}`})).result, 'deploy');
});

test('판별: 연쇄(F4) — 외부 재사용·workflow_run은 낱말이 없어도 unknown, 로컬 재사용은 대상 파일 낱말로 deploy', () => {
  const ci = 'name: x\non: push\njobs:\n  a:\n    steps:\n      - run: npm test\n';
  const run = repoWith({'.github/workflows/ci.yml': ci, '.github/workflows/after.yml': 'name: y\non:\n  workflow_run:\n    workflows: [x]\njobs: {}\n'});
  assert.equal(detectDeploy(run).result, 'unknown');
  assert.match(detectDeploy(run).reason, /after\.yml/);
  const ext = repoWith({'.github/workflows/ci.yml': 'name: x\non: push\njobs:\n  a:\n    uses: acme/shared/.github/workflows/ship.yml@v1\n'});
  assert.equal(detectDeploy(ext).result, 'unknown');
  const local = repoWith({'.github/workflows/ci.yml': 'name: x\non: push\njobs:\n  a:\n    uses: ./.github/workflows/ship.yml\n',
    '.github/workflows/ship.yml': `on: workflow_call\njobs:\n  s:\n    steps:\n${deployStep}`});
  const d = detectDeploy(local);
  assert.equal(d.result, 'deploy');
  assert.deepEqual(d.files, ['.github/workflows/ship.yml']);
  assert.equal(detectDeploy(repoWith({'.github/workflows/ci.yml': 'name: x\non: push\njobs:\n  a:\n    uses: ./.github/workflows/lint.yml\n',
    '.github/workflows/lint.yml': 'on: workflow_call\njobs:\n  s:\n    steps:\n      - run: npm test\n'})).result, 'clean');
});

test('판별: 하위 폴더 배포 설정·package.json(F5)과 상한', () => {
  for (const [rel, text] of [['packages/web/netlify.toml', ''], ['packages/web/vercel.json', '{}'], ['apps/a/.vercel/project.json', '{}'],
    ['svc/Procfile', 'web: node x'], ['package.json', '{"scripts":{"ship":"vercel --prod"}}'],
    ['packages/web/package.json', '{"scripts":{"release":"x"}}'], ['package.json', '{"publishConfig":{"access":"public"}}']]) {
    const r = repoWith({[rel]: text});
    assert.equal(detectDeploy(r).result, 'deploy', rel);
    assert.ok(detectDeploy(r).files.some(f => rel === f || rel.startsWith(`${f}/`)), rel);
  }
  assert.equal(detectDeploy(repoWith({'package.json': '{"scripts":{"test":"node --test"}}', 'packages/a/package.json': '{"name":"a"}'})).result, 'clean');
  assert.equal(detectDeploy(repoWith({'package.json': '{깨짐'})).result, 'unknown');
  // 건너뛰는 폴더 안의 신호는 보지 않는다.
  assert.equal(detectDeploy(repoWith({'node_modules/x/vercel.json': '{}', 'dist/netlify.toml': ''})).result, 'clean');
  // 상한은 값을 주입해 시험한다(큰 트리를 만들지 않는다).
  const deep = repoWith({'a/b/c/d/e/f.txt': ''});
  assert.equal(detectDeploy(deep).result, 'unknown');
  assert.match(detectDeploy(deep).reason, /깊이 상한/);
  assert.equal(detectDeploy(deep, {maxDepth: 5, maxDirs: 2000}).result, 'clean');
  const wide = repoWith({'a/x.txt': '', 'b/x.txt': '', 'c/x.txt': ''});
  assert.equal(detectDeploy(wide, {maxDepth: 4, maxDirs: 2}).result, 'unknown');
  assert.match(detectDeploy(wide, {maxDepth: 4, maxDirs: 2}).reason, /상한/);
  assert.equal(detectDeploy(wide, {maxDepth: 4, maxDirs: 100}).result, 'clean');
});

test('판별: 링크·읽기 실패는 unknown(F6), 배포 낱말 없는 CI는 clean', () => {
  const broken = tmp('kadan-det-');
  fs.mkdirSync(path.join(broken, '.github'));
  fs.symlinkSync(path.join(broken, 'no-such-target'), path.join(broken, '.github', 'workflows'));
  assert.equal(detectDeploy(broken).result, 'unknown');
  const out = tmp('kadan-det-'), outside = tmp('kadan-det-outside-');
  write(outside, 'x.yml', `on: push\njobs:\n  s:\n    steps:\n${deployStep}`);
  write(out, '.github/workflows/ok.yml', 'on: push\n');
  fs.symlinkSync(path.join(outside, 'x.yml'), path.join(out, '.github', 'workflows', 'link.yml'));
  assert.equal(detectDeploy(out).result, 'unknown');
  const noDeploy = repoWith({'.github/workflows/ci.yml': flow('  push:\n    branches: [main]\n  pull_request:'), 'package.json': '{"scripts":{"test":"node tests/run.mjs"}}'});
  assert.equal(detectDeploy(noDeploy).result, 'clean');
  assert.equal(decide('auto', detectDeploy(noDeploy)).action, 'merge');
});

test('판별: 낱말 경계와 목록 — upload-artifact는 배포가 아니다', () => {
  for (const hit of ['deploy', 'Deployment', 'gh-pages', 'actions/deploy-pages', 'npm publish', 'docker  push', 'flyctl', 'AWS_KEY', 'ssh-agent', 'kubectl apply', 'wrangler'])
    assert.ok(findDeployWord(hit), hit);
  for (const miss of ['actions/upload-artifact@v4', 'butterfly', 'npm test', 'compression', 'render2'])
    assert.equal(findDeployWord(miss), null, miss);
});

test('판별: 이 저장소(kadan) 자체는 clean이다', () => {
  assert.equal(detectDeploy(REPO_ROOT).result, 'clean');
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

test('최종 판정 표: merge·hold·auto × deploy·clean·unknown', () => {
  const det = {deploy: {result: 'deploy', files: ['vercel.json'], checked: []}, clean: {result: 'clean', checked: []}, unknown: {result: 'unknown', reason: '모름', checked: []}};
  const table = {
    merge: {deploy: 'merge', clean: 'merge', unknown: 'merge'},
    hold: {deploy: 'hold', clean: 'hold', unknown: 'hold'},
    auto: {deploy: 'hold', clean: 'merge', unknown: 'hold'},
  };
  for (const [value, row] of Object.entries(table))
    for (const [kind, action] of Object.entries(row)) assert.equal(decide(value, det[kind]).action, action, `${value}×${kind}`);
  assert.equal(decide('auto', det.deploy).reason, 'deploy-repo');
  assert.deepEqual(decide('auto', det.deploy).files, ['vercel.json']);
  assert.equal(decide('auto', det.unknown).reason, 'deploy-repo');
});

test('CLI 명령: 저장 출력·list·show·--repo-path·업무의 repoPath', () => {
  const home = tmp('kadan-repo-cli-');
  const site = tmp('kadan-site-');
  write(site, 'netlify.toml', '');
  const works = [{key: 'site/w1', status: 'open', repoPath: site}, {key: 'docs/w2', status: 'open', repoPath: tmp('kadan-docs-')}];
  const run = (args, flags = {}, by = '사람') => nightCommand(['repo', ...args], flags, {home, by, deps: {readWorks: () => works}});
  assert.match(run(['site', 'auto']), /저장: site = auto[\s\S]*판별 deploy — 근거 netlify\.toml[\s\S]*최종 판정 보류 \(deploy-repo\)/);
  const shown = run(['show', 'docs']);
  assert.match(shown, /docs: 최종 판정 머지 \(auto-clean\)/);
  assert.match(run(['site', 'merge']), /최종 판정 머지 \(repo-policy-merge\)/);
  const list = run(['list']);
  assert.match(list, /site: 저장 값 merge/);
  assert.match(list, /docs: 저장 값 없음\(auto\)/);
  assert.match(run(['show', 'ghost'], {'repo-path': site}), /ghost: 판별 deploy/);
  assert.match(run(['show', 'ghost']), /ghost: 판별 unknown/);
  assert.match(run([]), /사용법/);
  assert.throws(() => run(['site']), /값이 필요/);
  assert.throws(() => run(['show']), /저장소 이름/);
  assert.deepEqual(readLedger(home).filter(e => e.kind === 'night-repo-policy').map(e => e.after), ['auto', 'merge']);
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
  assert.equal(JSON.parse((await call(handler2, fakeReq('GET', '/api/night/repos'))).body).repos[0].verdict.action, 'hold');
});

test('이 저장소(kadan) 판별: 배포가 아닌 CI라 clean(문서에 적은 결과와 같다)', () => {
  const d = detectDeploy(REPO_ROOT);
  assert.equal(d.result, 'clean', JSON.stringify(d));
  assert.ok(d.checked.includes('.github/workflows/ci.yml'));
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
