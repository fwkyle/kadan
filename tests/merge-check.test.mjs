import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {cardCommand} from '../src/card-command.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {mergeCheck, formatMergeCheck} from '../src/merge-check.mjs';

// Why: 머지 직전에 검수가 본 커밋과 PR head가 같은지 사람 눈으로만 맞추던 것을 나란히 표시한다(표시만, 관문 아님).
const A = 'a'.repeat(40), B = 'b'.repeat(40);

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-merge-check-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new WorkStore(home), cards = new CardStore(home);
  store.create({key: 'repo/w', title: '업무', goal: '결과', scope: '범위', acceptance: '조건', owner: '감독', repoPath: home});
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
  const lease = (name, sha, at = new Date().toISOString()) => {
    const dir = path.join(home, 'review-slots', 'repo-12345678');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, `${name}.lease.json`), JSON.stringify({for: name.split('@')[0], sha, at, slot: name}));
  };
  return {home, store, cards, addReview, report, lease, check: head => mergeCheck('repo/w', {head}, {home})};
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
