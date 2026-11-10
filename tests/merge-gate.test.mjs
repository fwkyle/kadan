import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {cardCommand} from '../src/card-command.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {setRepoPolicy} from '../src/autopilot-repo-policy.mjs';
import {mergeGate, mergeGateCommand, forbiddenGroup} from '../src/merge-gate.mjs';

// Why: Autopilot 중 PR을 밤에 머지해도 되는지 코드가 판정한다. 하나라도 애매하면 거절(아침으로 보류)이어야 한다.
const H = 'a'.repeat(40), OTHER = 'b'.repeat(40), GH = 'acme/app';

function fixture({policy = {deployBranch: '없음', nightMerge: '허용'}, autopilot = null} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-merge-gate-'));
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mg-repo-')));
  assert.equal(spawnSync('git', ['-C', repoDir, 'init', '--quiet'], {encoding: 'utf8'}).status, 0);
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new WorkStore(home), cards = new CardStore(home);
  store.create({key: 'repo/w', title: '업무', goal: '결과', scope: '범위', acceptance: '조건', owner: '감독', repoPath: repoDir});
  if (policy) setRepoPolicy(home, {repo: GH, ...policy, by: 'test', record: () => {}});
  if (autopilot) appendLedger({kind: 'autopilot', phase: 'on', by: '사람', text: '자자', viaChat: false, until: new Date(Date.now() + 3_600_000).toISOString(), to: [], delivered: [], t: new Date().toISOString(), ...autopilot}, home);
  let round = 0;
  const review = (outcome, sha) => {
    round++;
    store.change('repo/w', 'execute', {title: `검수${round}`, body: `# 검수\n\n## 읽고 시작할 것\n- ${home}/AGENTS.md — 규칙\n`, phase: 'review', round: String(round)}, {revision: store.get('repo/w').revision, by: '감독', note: '검수 등록'});
    const key = store.get('repo/w').executions.at(-1).key;
    cards.update(key, {status: 'assigned', scope: '범위', board: 'b', role: 'rv-test', rallyId: 'w', rallyTitle: '업무', rallyRound: String(round), rallyStep: 'review'},
      {revision: cards.get(key).revision, by: '감독', note: '발령', manual: true});
    const card = cards.get(key);
    fs.writeFileSync(card.resultPath, `검수 결과 ${key}`);
    cardCommand(['report', key], {revision: card.revision, outcome, sha}, {home, by: 'rv-test'});
  };
  const pr = (over = {}) => ({url: `https://github.com/${GH}/pull/7`, number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: H, baseRefName: 'main',
    changedFiles: 1, ...over});
  const PASS = [{name: 'ci', state: 'SUCCESS', bucket: 'pass'}];
  const F = (...names) => names.map(filename => ({filename, status: 'modified'}));
  const REPO = {mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true};
  const input = (o = {}) => JSON.stringify({pr: o.pr ?? pr(), repo: Object.hasOwn(o, 'repo') ? o.repo : REPO, files: Object.hasOwn(o, 'files') ? o.files : F('src/a.mjs'), ...(Object.hasOwn(o, 'requiredChecks') ? (o.requiredChecks === undefined ? {} : {requiredChecks: o.requiredChecks}) : {requiredChecks: PASS})});
  const gate = (raw = input(), deps = {}) => mergeGate('repo/w', raw, {home, by: '슈퍼', deps: {origin: () => GH, ...deps}});
  const notes = () => readLedger(home).filter(e => e.kind === 'autopilot-note');
  return {home, store, review, pr, input, gate, notes, F};
}

const good = f => { f.review('pass', H); return f; };

test('1. 모든 조건이 맞으면 통과하고, Autopilot이 켜져 있으면 gate pass를 남긴다', () => {
  const f = good(fixture({autopilot: {}}));
  const r = f.gate();
  assert.equal(r.verdict, 'pass'); assert.deepEqual(r.reasons, []);
  assert.equal(r.pr, `${GH}#7`);
  const [n] = f.notes();
  assert.equal(f.notes().length, 1);
  assert.equal(n.noteKind, 'gate'); assert.equal(n.verdict, 'pass'); assert.equal(n.pr, `${GH}#7`); assert.equal(n.sha, H); assert.equal(n.work, 'repo/w');
});

test('1. Autopilot이 꺼져 있으면 판정만 하고 기록하지 않는다', () => {
  const f = good(fixture());
  const r = f.gate();
  assert.equal(r.verdict, 'pass'); assert.equal(r.recorded, false);
  assert.equal(f.notes().length, 0);
  const out = mergeGateCommand(['repo/w'], {}, {home: f.home, by: '슈퍼', stdin: () => f.input(), deps: {origin: () => GH}});
  assert.match(out.text, /기록 없음\(Autopilot 꺼짐\)/);
});

test('1. 거절도 Autopilot이 켜져 있으면 gate reject를 한 줄 남긴다', () => {
  const f = good(fixture({autopilot: {}}));
  const r = f.gate(f.input({pr: f.pr({isDraft: true})}));
  assert.equal(r.verdict, 'reject');
  assert.equal(f.notes()[0].verdict, 'reject');
});

test('2. 검수 SHA가 앞 7자리만 같으면 거절한다 (sameCommit 너그러움 차단)', () => {
  const f = fixture(); f.review('pass', H.slice(0, 7));
  const r = f.gate();
  assert.equal(r.verdict, 'reject');
  assert.ok(r.reasons.some(x => x.includes('40자리')));
});

test('2. PR head가 40자리가 아니면 거절한다', () => {
  const f = good(fixture());
  const r = f.gate(f.input({pr: f.pr({headRefOid: H.slice(0, 12)})}));
  assert.equal(r.verdict, 'reject');
  assert.ok(r.reasons.some(x => x.includes('40자리')));
});

test('3. 다른 커밋의 PASS만 있으면 거절한다', () => {
  const f = fixture(); f.review('pass', OTHER);
  const r = f.gate();
  assert.equal(r.verdict, 'reject'); assert.equal(r.reviewResult, '다름');
});

test('3. 같은 커밋 검수가 changes이면 거절한다', () => {
  const f = fixture(); f.review('pass', H); f.review('changes', H);
  const r = f.gate();
  assert.equal(r.verdict, 'reject'); assert.equal(r.reviewResult, '같은 커밋 검수 changes');
});

test('3. 검수가 없으면 거절한다', () => {
  const f = fixture();
  assert.equal(f.gate().verdict, 'reject');
});

test('4. requiredChecks가 없거나 비었으면 거절한다', () => {
  const f = good(fixture());
  for (const requiredChecks of [undefined, null, []]) {
    const r = f.gate(f.input({requiredChecks}));
    assert.equal(r.verdict, 'reject'); assert.ok(r.reasons.some(x => x.includes('필수 검사 없음')));
  }
});

test('4. 필수 검사에 skipping·fail이 하나라도 있으면 거절한다', () => {
  const f = good(fixture());
  for (const bucket of ['skipping', 'fail', 'pending']) {
    const r = f.gate(f.input({requiredChecks: [{name: 'a', state: 'SUCCESS', bucket: 'pass'}, {name: 'b', state: 'X', bucket}]}));
    assert.equal(r.verdict, 'reject', bucket);
  }
});

test('5. 파일 수가 changedFiles와 다르면(3,000개 초과로 잘린 경우 포함) 거절한다', () => {
  const f = good(fixture());
  const r = f.gate(f.input({pr: f.pr({changedFiles: 3000})}));
  assert.equal(r.verdict, 'reject'); assert.ok(r.reasons.some(x => x.includes('개수가 맞지 않음')));
});

test('6. 금지 경로는 무리마다 거절하고, src/cli.mjs만 바뀐 PR은 막지 않는다', () => {
  const f = good(fixture());
  for (const p of ['.github/workflows/x.yml', 'package.json', 'sub/CLAUDE.md', 'src/autopilot-guard.mjs', 'src/merge-gate.mjs', '.env.local', 'bun.lockb', 'a/AGENTS.md', 'x.pem']) {
    const r = f.gate(f.input({pr: f.pr({changedFiles: 2}), files: f.F('src/a.mjs', p)}));
    assert.equal(r.verdict, 'reject', p); assert.ok(r.reasons.some(x => x.includes('금지 경로')), p);
  }
  assert.equal(forbiddenGroup('src/cli.mjs'), null);
  const ok = f.gate(f.input({files: f.F('src/cli.mjs')}));
  assert.equal(ok.verdict, 'pass');
});

test('7. draft·CONFLICTING·UNKNOWN·MERGED는 거절한다', () => {
  const f = good(fixture());
  for (const over of [{isDraft: true}, {mergeable: 'CONFLICTING'}, {mergeStateStatus: 'UNKNOWN'}, {mergeStateStatus: 'BLOCKED'}, {state: 'MERGED'}]) {
    assert.equal(f.gate(f.input({pr: f.pr(over)})).verdict, 'reject', JSON.stringify(over));
  }
  assert.equal(f.gate(f.input({pr: f.pr({mergeStateStatus: 'HAS_HOOKS'})})).verdict, 'pass');
});

test('8. PR 저장소와 업무 origin이 다르면 거절하고, 업무가 열려 있지 않아도 거절한다', () => {
  const f = good(fixture());
  assert.equal(f.gate(f.input(), {origin: () => 'other/repo'}).verdict, 'reject');
  assert.equal(f.gate(f.input(), {origin: () => null}).verdict, 'reject');
  f.store.change('repo/w', 'update', {status: 'hold'}, {revision: f.store.get('repo/w').revision, by: '감독', note: '보류'});
  const r = f.gate();
  assert.equal(r.verdict, 'reject'); assert.ok(r.reasons.some(x => x.includes('업무가 열려 있지 않음')));
});

test('9. 정책 night-merge-forbidden·deploy-branch는 --allow가 없으면 거절하고, 그 키에 allow가 있으면 통과한다', () => {
  for (const [policy, why] of [[{deployBranch: '없음', nightMerge: '금지'}, 'night-merge-forbidden'], [{deployBranch: 'main', nightMerge: '허용'}, 'deploy-branch']]) {
    const none = good(fixture({policy}));
    const r0 = none.gate();
    assert.equal(r0.verdict, 'reject', why); assert.ok(r0.reasons.some(x => x.includes(why)));
    const allowed = good(fixture({policy, autopilot: {allow: [GH]}}));
    const r1 = allowed.gate();
    assert.equal(r1.verdict, 'pass', why); assert.equal(r1.allowApplied, why);
    assert.match(mergeGateCommand(['repo/w'], {}, {home: allowed.home, by: '슈퍼', stdin: () => allowed.input(), deps: {origin: () => GH}}).text, /kyle 허용\(--allow\)/);
    const wrongKey = good(fixture({policy, autopilot: {allow: ['other/repo']}}));
    assert.equal(wrongKey.gate().verdict, 'reject', `${why} 다른 키`);
  }
});

test('9. allow가 있어도 Autopilot이 꺼져 있으면 허용은 없다', () => {
  const f = good(fixture({policy: {deployBranch: '없음', nightMerge: '금지'}, autopilot: {allow: [GH], until: new Date(Date.now() - 1000).toISOString(), t: new Date(Date.now() - 7_200_000).toISOString()}}));
  assert.equal(f.gate().verdict, 'reject');
});

test('9. allow는 다른 조건(검수·검사)을 풀지 않는다', () => {
  const f = fixture({policy: {deployBranch: 'main', nightMerge: '허용'}, autopilot: {allow: [GH]}});
  assert.equal(f.gate().verdict, 'reject');
});

test('10. 정책 setup-needed(값 없음)·정책 파일 손상은 allow가 있어도 거절한다', () => {
  const unset = good(fixture({policy: null, autopilot: {allow: [GH]}}));
  const r = unset.gate();
  assert.equal(r.verdict, 'reject'); assert.ok(r.reasons.some(x => x.includes('setup-needed')));
  const broken = good(fixture({autopilot: {allow: [GH]}}));
  fs.writeFileSync(path.join(broken.home, 'autopilot-repo-policy.json'), '{손상');
  const r2 = broken.gate();
  assert.equal(r2.verdict, 'reject'); assert.ok(r2.reasons.some(x => x.includes('setup-needed')));
});

test('입력이 JSON이 아니거나 칸이 틀리면 사용 오류(종료 코드 2)다', () => {
  const f = good(fixture());
  for (const raw of ['not json', '{}', JSON.stringify({pr: {url: 1}}), JSON.stringify({pr: f.pr({isDraft: 'no'})}), JSON.stringify({pr: f.pr(), requiredChecks: 'x'})]) {
    assert.throws(() => f.gate(raw), e => e.exitCode === 2, raw);
  }
  assert.throws(() => mergeGate('없는키', f.input(), {home: f.home}), e => e.exitCode === 2);
});

test('14. 옛 문구 "밤 저장소 정책"이 src/와 gui/src/에 남아 있지 않다', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
  const hits = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'gui', 'src'))].filter(f => fs.readFileSync(f, 'utf8').includes('밤 저장소 정책'));
  assert.deepEqual(hits, []);
});

// ---- 검수 changes 반영 (F1~F4, F7) ----
test('F1. 빈 filename·문자열 원소·이름/상태 없는 검사는 사용 오류(종료 코드 2)다', () => {
  const f = good(fixture());
  const bad = [
    f.input({files: [{filename: '', status: 'modified'}]}),
    f.input({files: ['src/a.mjs']}),
    f.input({files: [{status: 'modified'}]}),
    f.input({requiredChecks: [{state: 'SUCCESS', bucket: 'pass'}]}),
    f.input({requiredChecks: [{name: 'ci', bucket: 'pass'}]}),
    f.input({requiredChecks: [{name: 'ci', state: 'SUCCESS', bucket: ''}]}),
    f.input({requiredChecks: ['ci']}),
  ];
  for (const raw of bad) assert.throws(() => f.gate(raw), e => e.exitCode === 2, raw.slice(0, 120));
});

test('F2. 대문자 head·앞뒤 공백 head는 맞춰 주지 않고 거절한다', () => {
  const f = good(fixture());
  for (const head of [H.toUpperCase(), ` ${H}`, `${H}\n`]) {
    const r = f.gate(f.input({pr: f.pr({headRefOid: head})}));
    assert.equal(r.verdict, 'reject', JSON.stringify(head));
    assert.ok(r.reasons.some(x => x.includes('소문자 40자리')), JSON.stringify(head));
  }
});

test('F3. rename의 옛 경로가 금지 경로면 거절하고, 옛 경로가 없는 rename도 거절한다', () => {
  const f = good(fixture());
  for (const old of ['.github/workflows/x.yml', 'package.json', 'src/autopilot-guard.mjs']) {
    const r = f.gate(f.input({files: [{filename: 'docs/moved.txt', status: 'renamed', previous_filename: old}]}));
    assert.equal(r.verdict, 'reject', old); assert.ok(r.reasons.some(x => x.includes('금지 경로')), old);
  }
  const noOld = f.gate(f.input({files: [{filename: 'docs/moved.txt', status: 'renamed'}]}));
  assert.equal(noOld.verdict, 'reject'); assert.ok(noOld.reasons.some(x => x.includes('옛 경로')));
  const fine = f.gate(f.input({files: [{filename: 'docs/b.txt', status: 'renamed', previous_filename: 'docs/a.txt'}]}));
  assert.equal(fine.verdict, 'pass');
});

test('F3. 여러 페이지로 나뉜 REST 응답을 펼쳐 개수를 맞춘다', () => {
  const f = good(fixture());
  const pages = [f.F('a.txt', 'b.txt'), f.F('c.txt')];
  assert.equal(f.gate(f.input({pr: f.pr({changedFiles: 3}), files: pages})).verdict, 'pass');
  const r = f.gate(f.input({pr: f.pr({changedFiles: 4}), files: pages}));
  assert.equal(r.verdict, 'reject'); assert.ok(r.reasons.some(x => x.includes('개수가 맞지 않음')));
  const hidden = f.gate(f.input({pr: f.pr({changedFiles: 3}), files: [f.F('a.txt'), f.F('package.json', 'c.txt')]}));
  assert.equal(hidden.verdict, 'reject', '둘째 페이지의 금지 경로도 잡힌다');
});

test('F3. 맨 위 files가 없으면 사용 오류(종료 코드 2)다', () => {
  const f = good(fixture());
  assert.throws(() => f.gate(JSON.stringify({pr: f.pr(), requiredChecks: [{name: 'ci', state: 'SUCCESS', bucket: 'pass'}]})), e => e.exitCode === 2);
  assert.throws(() => f.gate(f.input({files: 'x'})), e => e.exitCode === 2);
});

test('F4. 관문 기록의 PR 키는 소문자로 정규화되어 대소문자 다른 머지 기록과 짝지어진다', () => {
  const f = good(fixture({autopilot: {}}));
  f.gate(f.input({pr: f.pr({url: `https://github.com/ACME/App/pull/7`})}));
  assert.equal(f.notes()[0].pr, 'acme/app#7');
});

test('F7. PR 주소의 번호와 pr.number가 다르면 거절한다', () => {
  const f = good(fixture());
  const r = f.gate(f.input({pr: f.pr({number: 8})}));
  assert.equal(r.verdict, 'reject'); assert.ok(r.reasons.some(x => x.includes('pr.number')));
});

// ---- 재검수 changes 반영 (R1~R3) ----
test('R1. 파일 상태 없음·빈 상태·모르는 상태는 사용 오류(종료 코드 2)다', () => {
  const f = good(fixture());
  for (const file of [{filename: 'a.txt'}, {filename: 'a.txt', status: ''}, {filename: 'a.txt', status: '  '}, {filename: 'a.txt', status: 'weird'}, {filename: 'a.txt', status: 5}]) {
    assert.throws(() => f.gate(f.input({files: [file]})), e => e.exitCode === 2, JSON.stringify(file));
  }
  for (const status of ['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']) {
    const file = {filename: 'a.txt', status, ...(['renamed', 'copied'].includes(status) ? {previous_filename: 'b.txt'} : {})};
    assert.equal(f.gate(f.input({files: [file]})).verdict, 'pass', status);
  }
});

test('R1. copied인데 옛 경로가 없으면 거절하고, 옛 경로가 금지 경로인 copied도 거절한다', () => {
  const f = good(fixture());
  const noOld = f.gate(f.input({files: [{filename: 'a.txt', status: 'copied'}]}));
  assert.equal(noOld.verdict, 'reject'); assert.ok(noOld.reasons.some(x => x.includes('옛 경로')));
  const bad = f.gate(f.input({files: [{filename: 'a.txt', status: 'copied', previous_filename: '.github/workflows/x.yml'}]}));
  assert.equal(bad.verdict, 'reject'); assert.ok(bad.reasons.some(x => x.includes('금지 경로')));
});

test('R1. 다른 상태에 previous_filename이 붙어도 그 경로를 금지 경로로 검사한다', () => {
  const f = good(fixture());
  const r = f.gate(f.input({files: [{filename: 'a.txt', status: 'modified', previous_filename: 'package.json'}]}));
  assert.equal(r.verdict, 'reject'); assert.ok(r.reasons.some(x => x.includes('금지 경로')));
});

test('R2. 중복 filename은 changedFiles를 맞춰도 사용 오류(종료 코드 2)로 멈춘다', () => {
  const f = good(fixture());
  assert.throws(() => f.gate(f.input({pr: f.pr({changedFiles: 1}), files: f.F('a.txt', 'a.txt')})), e => e.exitCode === 2 && /겹칩니다/.test(e.message));
  assert.throws(() => f.gate(f.input({pr: f.pr({changedFiles: 1}), files: [f.F('a.txt'), f.F('a.txt')]})), e => e.exitCode === 2);
});

test('R3. merge-gate --help와 JSON 오류 안내가 {pr, files, requiredChecks} 모양을 말한다', () => {
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.mjs');
  const env = {...process.env, KADAN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mg-help-')), KADAN_NOTIFY: 'off', KADAN_WINDOW: 'none'};
  const help = spawnSync(process.execPath, [cli, 'merge-gate', '--help'], {env, encoding: 'utf8'});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /"files":<gh api --paginate --slurp/);
  assert.match(help.stdout, /requiredChecks/);
  const f = good(fixture());
  assert.throws(() => f.gate('not json'), e => e.exitCode === 2 && /"files":\[/.test(e.message));
});

test('M1. 머지 방식은 머지 커밋 → squash → rebase 순으로 허용된 첫 방식을 고르고 명령이 head·저장소를 담는다', () => {
  const f = good(fixture());
  const cases = [[[true, true, true], 'merge'], [[true, false, false], 'merge'], [[false, true, true], 'squash'], [[false, true, false], 'squash'], [[false, false, true], 'rebase']];
  for (const [[m, s, r], want] of cases) {
    const out = f.gate(f.input({repo: {mergeCommitAllowed: m, squashMergeAllowed: s, rebaseMergeAllowed: r}}));
    assert.equal(out.verdict, 'pass'); assert.equal(out.mergeMethod, want);
    assert.equal(out.mergeCommand, `gh pr merge 7 --${want} --match-head-commit ${H} -R ${GH}`);
    assert.match(mergeGateCommand(['repo/w'], {}, {home: f.home, by: '슈퍼', stdin: () => f.input({repo: {mergeCommitAllowed: m, squashMergeAllowed: s, rebaseMergeAllowed: r}}), deps: {origin: () => GH}}).text, new RegExp(`--${want} --match-head-commit ${H} -R ${GH}`));
  }
});

test('M2. 세 칸이 모두 false면 거절하고 명령을 내지 않는다', () => {
  const f = good(fixture());
  const r = f.gate(f.input({repo: {mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false}}));
  assert.equal(r.verdict, 'reject'); assert.ok(r.reasons.some(x => x.includes('허용된 머지 방식 없음')));
  assert.equal(r.mergeCommand, null); assert.equal(r.mergeMethod, null);
  assert.doesNotMatch(mergeGateCommand(['repo/w'], {}, {home: f.home, by: '슈퍼', stdin: () => f.input({repo: {mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false}}), deps: {origin: () => GH}}).text, /gh pr merge \d/);
});

test('M3. repo가 없거나 칸 타입이 틀리면 사용 오류(종료 코드 2)다', () => {
  const f = good(fixture());
  const bad = [undefined, null, 'x', [], {}, {mergeCommitAllowed: true, squashMergeAllowed: true}, {mergeCommitAllowed: 'true', squashMergeAllowed: true, rebaseMergeAllowed: true}, {mergeCommitAllowed: true, squashMergeAllowed: 1, rebaseMergeAllowed: true}];
  for (const repo of bad) assert.throws(() => f.gate(f.input({repo})), e => e.exitCode === 2, JSON.stringify(repo));
});

test('M4. src/·docs/·README.md에 --squash 고정 문구가 남지 않는다(고르는 방식 설명은 예외)', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const walk = d => fs.readdirSync(d, {withFileTypes: true}).flatMap(e => e.isDirectory() ? (e.name === 'daily' || e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
  const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'docs')), path.join(root, 'README.md')].filter(p => fs.existsSync(p) && /\.(mjs|md)$/.test(p));
  const hits = files.flatMap(p => fs.readFileSync(p, 'utf8').split('\n').map((l, i) => [p, i + 1, l]).filter(([, , l]) => /gh pr merge[^`\n]*--squash/.test(l)));
  assert.deepEqual(hits.map(([p, i]) => `${p}:${i}`), []);
});
