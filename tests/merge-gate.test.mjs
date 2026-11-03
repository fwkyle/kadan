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
import {setRepoPolicy} from '../src/night-repo-policy.mjs';
import {mergeGate, mergeGateCommand, forbiddenGroup} from '../src/merge-gate.mjs';

// Why: 나이트런 중 PR을 밤에 머지해도 되는지 코드가 판정한다. 하나라도 애매하면 거절(아침으로 보류)이어야 한다.
const H = 'a'.repeat(40), OTHER = 'b'.repeat(40), GH = 'acme/app';

function fixture({policy = {deployBranch: '없음', nightMerge: '허용'}, night = null} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-merge-gate-'));
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mg-repo-')));
  assert.equal(spawnSync('git', ['-C', repoDir, 'init', '--quiet'], {encoding: 'utf8'}).status, 0);
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new WorkStore(home), cards = new CardStore(home);
  store.create({key: 'repo/w', title: '업무', goal: '결과', scope: '범위', acceptance: '조건', owner: '감독', repoPath: repoDir});
  if (policy) setRepoPolicy(home, {repo: GH, ...policy, by: 'test', record: () => {}});
  if (night) appendLedger({kind: 'night', phase: 'on', by: '사람', text: '자자', viaChat: false, until: new Date(Date.now() + 3_600_000).toISOString(), to: [], delivered: [], t: new Date().toISOString(), ...night}, home);
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
    files: [{path: 'src/a.mjs'}], changedFiles: 1, ...over});
  const PASS = [{name: 'ci', state: 'SUCCESS', bucket: 'pass'}];
  const input = (o = {}) => JSON.stringify({pr: o.pr ?? pr(), ...(Object.hasOwn(o, 'requiredChecks') ? (o.requiredChecks === undefined ? {} : {requiredChecks: o.requiredChecks}) : {requiredChecks: PASS})});
  const gate = (raw = input(), deps = {}) => mergeGate('repo/w', raw, {home, by: '슈퍼', deps: {origin: () => GH, ...deps}});
  const notes = () => readLedger(home).filter(e => e.kind === 'night-note');
  return {home, store, review, pr, input, gate, notes};
}

const good = f => { f.review('pass', H); return f; };

test('1. 모든 조건이 맞으면 통과하고, 나이트런이 켜져 있으면 gate pass를 남긴다', () => {
  const f = good(fixture({night: {}}));
  const r = f.gate();
  assert.equal(r.verdict, 'pass'); assert.deepEqual(r.reasons, []);
  assert.equal(r.pr, `${GH}#7`);
  const [n] = f.notes();
  assert.equal(f.notes().length, 1);
  assert.equal(n.noteKind, 'gate'); assert.equal(n.verdict, 'pass'); assert.equal(n.pr, `${GH}#7`); assert.equal(n.sha, H); assert.equal(n.work, 'repo/w');
});

test('1. 나이트런이 꺼져 있으면 판정만 하고 기록하지 않는다', () => {
  const f = good(fixture());
  const r = f.gate();
  assert.equal(r.verdict, 'pass'); assert.equal(r.recorded, false);
  assert.equal(f.notes().length, 0);
  const out = mergeGateCommand(['repo/w'], {}, {home: f.home, by: '슈퍼', stdin: () => f.input(), deps: {origin: () => GH}});
  assert.match(out.text, /기록 없음\(나이트런 꺼짐\)/);
});

test('1. 거절도 나이트런이 켜져 있으면 gate reject를 한 줄 남긴다', () => {
  const f = good(fixture({night: {}}));
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

test('5. 파일 목록이 잘리면 거절한다', () => {
  const f = good(fixture());
  const r = f.gate(f.input({pr: f.pr({changedFiles: 3000})}));
  assert.equal(r.verdict, 'reject'); assert.ok(r.reasons.some(x => x.includes('잘림')));
});

test('6. 금지 경로는 무리마다 거절하고, src/cli.mjs만 바뀐 PR은 막지 않는다', () => {
  const f = good(fixture());
  for (const p of ['.github/workflows/x.yml', 'package.json', 'sub/CLAUDE.md', 'src/night-guard.mjs', 'src/merge-gate.mjs', '.env.local', 'bun.lockb', 'a/AGENTS.md', 'x.pem']) {
    const r = f.gate(f.input({pr: f.pr({files: [{path: 'src/a.mjs'}, {path: p}], changedFiles: 2})}));
    assert.equal(r.verdict, 'reject', p); assert.ok(r.reasons.some(x => x.includes('금지 경로')), p);
  }
  assert.equal(forbiddenGroup('src/cli.mjs'), null);
  const ok = f.gate(f.input({pr: f.pr({files: [{path: 'src/cli.mjs'}], changedFiles: 1})}));
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
    const allowed = good(fixture({policy, night: {allow: [GH]}}));
    const r1 = allowed.gate();
    assert.equal(r1.verdict, 'pass', why); assert.equal(r1.allowApplied, why);
    assert.match(mergeGateCommand(['repo/w'], {}, {home: allowed.home, by: '슈퍼', stdin: () => allowed.input(), deps: {origin: () => GH}}).text, /kyle 허용\(--allow\)/);
    const wrongKey = good(fixture({policy, night: {allow: ['other/repo']}}));
    assert.equal(wrongKey.gate().verdict, 'reject', `${why} 다른 키`);
  }
});

test('9. allow가 있어도 나이트런이 꺼져 있으면 허용은 없다', () => {
  const f = good(fixture({policy: {deployBranch: '없음', nightMerge: '금지'}, night: {allow: [GH], until: new Date(Date.now() - 1000).toISOString(), t: new Date(Date.now() - 7_200_000).toISOString()}}));
  assert.equal(f.gate().verdict, 'reject');
});

test('9. allow는 다른 조건(검수·검사)을 풀지 않는다', () => {
  const f = fixture({policy: {deployBranch: 'main', nightMerge: '허용'}, night: {allow: [GH]}});
  assert.equal(f.gate().verdict, 'reject');
});

test('10. 정책 setup-needed(값 없음)·정책 파일 손상은 allow가 있어도 거절한다', () => {
  const unset = good(fixture({policy: null, night: {allow: [GH]}}));
  const r = unset.gate();
  assert.equal(r.verdict, 'reject'); assert.ok(r.reasons.some(x => x.includes('setup-needed')));
  const broken = good(fixture({night: {allow: [GH]}}));
  fs.writeFileSync(path.join(broken.home, 'night-repo-policy.json'), '{손상');
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
