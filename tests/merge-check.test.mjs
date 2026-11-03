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
import {appendLedger} from '../src/ledger.mjs';
import {mergeCheck, formatMergeCheck} from '../src/merge-check.mjs';
import {leaseShaFor} from '../src/review-sha.mjs';

// Why: 머지 직전에 검수가 본 커밋과 PR head가 같은지 사람 눈으로만 맞추던 것을 나란히 표시한다(표시만, 관문 아님).
const A = 'a'.repeat(40), B = 'b'.repeat(40);

// 검수 SHA는 카드의 원본 저장소(repoPath)의 자리 묶음에서만 가져온다 → 시험도 진짜 git 저장소가 필요하다.
function gitRepo(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  assert.equal(spawnSync('git', ['-C', dir, 'init', '--quiet'], {encoding: 'utf8'}).status, 0);
  return dir;
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-merge-check-'));
  const repoDir = gitRepo('kadan-mc-repo-');
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new WorkStore(home), cards = new CardStore(home);
  store.create({key: 'repo/w', title: '업무', goal: '결과', scope: '범위', acceptance: '조건', owner: '감독', repoPath: repoDir});
  const addReview = round => {
    store.change('repo/w', 'execute', {title: `검수${round}`, body: `# 검수\n\n## 읽고 시작할 것\n- ${home}/AGENTS.md — 규칙\n`, phase: 'review', round: String(round)}, {revision: store.get('repo/w').revision, by: '감독', note: '검수 등록'});
    const key = store.get('repo/w').executions.at(-1).key;
    cards.update(key, {status: 'assigned', scope: '범위', board: 'b', role: 'rv-test', rallyId: 'w', rallyTitle: '업무', rallyRound: String(round), rallyStep: 'review'},
      {revision: cards.get(key).revision, by: '감독', note: '발령', manual: true});
    return key;
  };
  const report = (key, outcome, flags = {}) => {
    const card = cards.get(key);
    fs.writeFileSync(card.resultPath, `검수 결과 ${key}`);
    return cardCommand(['report', key], {revision: card.revision, outcome, ...flags}, {home, by: 'rv-test'});
  };
  // pool: 자리 묶음 폴더 이름, poolRepo: 그 묶음의 원본 저장소(repo.json). 기본은 카드의 저장소.
  const lease = (name, sha, at = new Date().toISOString(), {pool = 'repo-12345678', poolRepo = repoDir} = {}) => {
    const dir = path.join(home, 'review-slots', pool);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'repo.json'), JSON.stringify({repo: poolRepo}));
    fs.writeFileSync(path.join(dir, `${name}.lease.json`), JSON.stringify({for: name.split('@')[0], sha, at, slot: name}));
  };
  return {home, repoDir, store, cards, addReview, report, lease, check: head => mergeCheck('repo/w', {head}, {home})};
}

test('card report --sha: 준 값을 given으로 저장한다', () => {
  const f = fixture(), key = f.addReview(1);
  const saved = f.report(key, 'pass', {sha: A.toUpperCase().slice(0, 12)});
  assert.equal(saved.result.reviewedSha, A.slice(0, 12));
  assert.equal(saved.result.reviewedShaSource, 'given');
});

test('--sha 없이 report: 그 카드 이름으로 빌린 임차 기록의 커밋을 slot으로 저장한다', () => {
  const f = fixture(), key = f.addReview(1), id = key.split('/')[1];
  f.lease(`${id}@slot-1`, B);
  f.lease('다른카드@slot-2', A);
  const saved = f.report(key, 'pass');
  assert.equal(saved.result.reviewedSha, B);
  assert.equal(saved.result.reviewedShaSource, 'slot');
});

test('다른 저장소의 같은 카드 id 임차는 검수 SHA로 쓰지 않는다', () => {
  const f = fixture(), key = f.addReview(1), id = key.split('/')[1];
  const other = gitRepo('kadan-mc-other-');
  f.lease(`${id}@slot-1`, B, undefined, {pool: 'beta-pool', poolRepo: other});
  const saved = f.report(key, 'pass');
  assert.equal(saved.result.reviewedSha, null);
  assert.equal(saved.result.reviewedShaSource, null);
  assert.equal(f.check(B).result, '검수 SHA 없음');
});

test('자기 저장소 임차가 있으면 다른 저장소의 더 최신 같은 id 임차가 덮어쓰지 못한다', () => {
  const f = fixture(), key = f.addReview(1), id = key.split('/')[1];
  const other = gitRepo('kadan-mc-other-');
  f.lease(`${id}@slot-1`, A, '2026-01-01T00:00:00Z');
  f.lease(`${id}@slot-2`, B, '2026-02-01T00:00:00Z', {pool: 'beta-pool', poolRepo: other});
  const saved = f.report(key, 'pass');
  assert.equal(saved.result.reviewedSha, A);
  assert.equal(saved.result.reviewedShaSource, 'slot');
});

test('카드의 저장소를 정할 수 없으면(git 저장소 아님) 임차에서 가져오지 않는다', () => {
  const f = fixture(), key = f.addReview(1), id = key.split('/')[1];
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mc-norepo-'));
  f.lease(`${id}@slot-1`, B, undefined, {poolRepo: notRepo});
  const card = f.cards.get(key);
  card.repoPath = notRepo; // 저장소 판정 함수만 직접 확인한다(카드 원장은 건드리지 않는다)
  assert.equal(leaseShaFor(f.home, card), null);
});

test('잘못된 명시 --sha는 임차가 있어도 경고 뒤 null로 남고 report는 성공한다', () => {
  const f = fixture(), key = f.addReview(1), id = key.split('/')[1];
  f.lease(`${id}@slot-1`, A);
  const saved = f.report(key, 'pass', {sha: 'invalid-sha'});
  assert.equal(saved.result.reviewedSha, null);
  assert.equal(saved.result.reviewedShaSource, null);
  assert.equal(saved.result.outcome, 'pass');
});

test('둘 다 없거나 형식이 틀리면 null이고 report는 성공한다', () => {
  const f = fixture(), key = f.addReview(1);
  const saved = f.report(key, 'pass', {sha: 'xyz'});
  assert.equal(saved.result.reviewedSha, null);
  assert.equal(saved.result.reviewedShaSource, null);
  assert.equal(saved.result.outcome, 'pass');
});

test('merge-check: 업무에 pass 검수가 없으면 "검수 pass 없음"(오류 아님)', () => {
  const f = fixture(), key = f.addReview(1);
  assert.equal(f.check(A).result, '검수 pass 없음');
  f.report(key, 'changes', {sha: A});
  const r = f.check(A);
  assert.equal(r.result, '검수 pass 없음');
  assert.match(formatMergeCheck(r), /검수 SHA: -/);
});

test('merge-check: pass인데 SHA 기록이 없으면 "검수 SHA 없음"', () => {
  const f = fixture(), key = f.addReview(1);
  f.report(key, 'pass');
  assert.equal(f.check(A).result, '검수 SHA 없음');
});

test('재발령으로 낡은 pass는 빠지고 최신 유효 pass가 쓰인다', () => {
  const f = fixture(), k1 = f.addReview(1);
  f.report(k1, 'pass', {sha: A});
  assert.equal(f.check(A).result, '같음');
  const k2 = f.addReview(2);
  f.report(k2, 'pass', {sha: B});
  assert.equal(f.check(B).review.key, k2, '더 최근 유효 pass를 쓴다');
  // 첫 검수를 결과 뒤에 다시 발령(원장 send)하면 낡은 결과가 되어 빠진다. 둘째도 낡게 하면 pass가 없다.
  appendLedger({kind: 'send', by: '감독', role: 'rv-test', taskId: k2.split('/')[1], executionKey: k2, digest: 'again', t: '2999-01-01T00:00:00Z'}, f.home);
  const r = f.check(A);
  assert.equal(r.review.key, k1);
  assert.equal(r.reviewSha, A);
  assert.equal(r.result, '같음');
});

test('같음·다름 출력, 짧은 SHA 앞부분 일치, 다름도 표시만 한다', () => {
  const f = fixture(), key = f.addReview(1);
  f.report(key, 'pass', {sha: A});
  assert.equal(f.check(A.slice(0, 7)).result, '같음');
  const diff = f.check(B);
  assert.equal(diff.result, '다름');
  const text = formatMergeCheck(diff);
  assert.ok(text.startsWith('!! 다름'));
  assert.match(text, /SHA 출처: given/);
  assert.match(text, /표시만/);
  assert.equal(f.check(A.slice(0, 6) + 'f').result, '다름');
});

test('잘못된 --head 형식은 종료 코드 2 오류', () => {
  const f = fixture();
  for (const head of [undefined, 'zzzzzzz', 'abc12', true]) {
    assert.throws(() => f.check(head), e => e.exitCode === 2);
  }
});

// 한 업무에 PR이 둘 이상이면 나중 PR의 검수가 앞 PR의 검수를 덮으면 안 된다(PR C 전제).
test('두 PR의 pass 검수가 있으면 각 head가 자기 검수와 같음', () => {
  const f = fixture(), k1 = f.addReview(1), k2 = f.addReview(2);
  f.report(k1, 'pass', {sha: A});
  f.report(k2, 'pass', {sha: B});
  const a = f.check(A), b = f.check(B);
  assert.equal(a.result, '같음');
  assert.equal(a.review.key, k1);
  assert.equal(b.result, '같음');
  assert.equal(b.review.key, k2);
});

test('같은 SHA에 pass 뒤 changes면 changes, changes 뒤 pass면 같음', () => {
  const f = fixture(), k1 = f.addReview(1), k2 = f.addReview(2);
  f.report(k1, 'pass', {sha: A});
  f.report(k2, 'changes', {sha: A});
  const r = f.check(A);
  assert.equal(r.result, '같은 커밋 검수 changes');
  assert.equal(r.review.key, k2);
  assert.ok(formatMergeCheck(r).startsWith('!! 같은 커밋 검수 changes'));
  const g = fixture(), g1 = g.addReview(1), g2 = g.addReview(2);
  g.report(g1, 'changes', {sha: A});
  g.report(g2, 'pass', {sha: A});
  assert.equal(g.check(A).result, '같음');
});

test('어떤 검수 SHA와도 안 맞으면 다름 + pass SHA 목록(최근 것부터)', () => {
  const f = fixture(), k1 = f.addReview(1), k2 = f.addReview(2);
  f.report(k1, 'pass', {sha: A});
  f.report(k2, 'pass', {sha: B});
  const r = f.check('c'.repeat(40));
  assert.equal(r.result, '다름');
  assert.deepEqual(r.passShas.map(p => p.sha), [B, A]);
  const text = formatMergeCheck(r);
  assert.ok(text.startsWith('!! 다름'));
  assert.ok(text.includes(`${B}  ${k2}`) && text.includes(`${A}  ${k1}`));
});

test('짧은 head가 서로 다른 두 검수 SHA에 맞으면 모호', () => {
  const f = fixture(), k1 = f.addReview(1), k2 = f.addReview(2);
  const a1 = 'abc1234' + '1'.repeat(33), a2 = 'abc1234' + '2'.repeat(33);
  f.report(k1, 'pass', {sha: a1});
  f.report(k2, 'pass', {sha: a2});
  const r = f.check('abc1234');
  assert.equal(r.result, '모호');
  assert.ok(formatMergeCheck(r).startsWith('!! 모호'));
  assert.equal(f.check(a1).result, '같음', '긴 head로는 구분된다');
  // 같은 커밋의 짧은/긴 기록은 모호가 아니다
  const g = fixture(), g1 = g.addReview(1), g2 = g.addReview(2);
  g.report(g1, 'pass', {sha: A.slice(0, 12)});
  g.report(g2, 'pass', {sha: A});
  assert.equal(g.check(A.slice(0, 7)).result, '같음');
});
