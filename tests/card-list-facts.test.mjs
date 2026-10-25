import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateCard, rng, NOW} from './helpers/history-generator.mjs';
import {advanceListFacts, listFactsFromHistory} from '../src/card-list-facts.mjs';
import {currentProgressReport, waitingText} from '../src/human-brief.mjs';
import {cardTurn} from '../src/card-turn.mjs';
import {legacyCurrentProgressReport, legacyWaitingText} from './helpers/legacy/human-brief.mjs';
import {legacyCardTurn} from './helpers/legacy/card-turn.mjs';

const SEEDS = 1500;
// 목록 행처럼 이력 없이 사실만 들고 있는 카드. 사실은 사건을 하나씩 적용해 만든다(저장소 reader와 같은 방식).
function factsOnly(card) {
  const {history, ...rest} = card;
  let facts = null, previous = null;
  for (const row of history) {facts = advanceListFacts(facts, previous, row, NOW);previous = row;}
  return {...rest, listFacts: facts};
}
// 시험마다 현재 역할·시각을 바꿔 임의 since 조회를 흔든다.
function variants(card, seed) {
  const r = rng(seed * 7 + 1), out = [card];
  for (const role of ['worker', 'reviewer', 'worker2', undefined]) out.push({...card, role});
  const runs = (card.runs ?? []).map(run => ({...run, sentAt: new Date(NOW - Math.floor(r() * 30) * 3_600_000).toISOString()}));
  out.push({...card, runs}, {...card, runs, role: 'reviewer'}, {...card, activityAt: 'broken', activity: 'running', activityRole: card.role});
  return out;
}

test('진행 보고·대기 이유·차례: 사실 기반 구현이 이력 기반 옛 구현과 모든 적대 자료에서 같다', () => {
  let compared = 0, reported = 0;
  const reasons = new Map();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const card = generateCard(seed);
    for (const variant of variants(card, seed)) {
      const withFacts = factsOnly(variant);
      for (const now of [NOW, NOW - 20 * 3_600_000, NOW + 100 * 3_600_000]) {
        const expected = legacyCurrentProgressReport(variant, now);
        assert.deepEqual(currentProgressReport(variant, now), expected, `seed ${seed} 진행 보고(이력에서 만든 사실)`);
        assert.deepEqual(currentProgressReport(withFacts, now), expected, `seed ${seed} 진행 보고(증분 사실)`);
        assert.deepEqual(cardTurn(withFacts, now), legacyCardTurn(variant, now), `seed ${seed} 차례`);
        assert.deepEqual(cardTurn(variant, now), legacyCardTurn(variant, now), `seed ${seed} 차례(이력에서)`);
        compared++;reported += expected.state === 'reported' ? 1 : 0;
        reasons.set(`${expected.state}:${expected.reason}`, (reasons.get(`${expected.state}:${expected.reason}`) ?? 0) + 1);
      }
      for (const displayState of ['waiting', 'running']) {
        const probe = {...variant, displayState};
        assert.equal(waitingText(factsOnly(probe)), legacyWaitingText(probe), `seed ${seed} 대기 이유`);
      }
    }
  }
  assert.ok(reported > 2500, `보고 선택이 실제로 일어난 사례가 충분해야 한다: ${reported}/${compared}`);
  for (const reason of ['unknown:author-unknown', 'none:before-assignment', 'none:before-dispatch', 'none:no-report', 'unknown:invalid-time', 'unknown:future-time']) {
    assert.ok(reasons.get(reason) > 20, `${reason} 경로가 시험에 들어와야 한다: ${JSON.stringify([...reasons])}`);
  }
});

test('증분 사실은 이력에서 한 번에 만든 사실과 같고 이전 사실을 바꾸지 않는다', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const card = generateCard(seed), frozen = [];
    let facts = null, previous = null;
    for (const row of card.history) {
      facts = advanceListFacts(facts, previous, row, NOW);previous = row;
      frozen.push([facts, JSON.stringify(facts, (k, v) => v instanceof Map ? [...v] : v)]);
    }
    for (const [snapshot, text] of frozen) {
      assert.equal(JSON.stringify(snapshot, (k, v) => v instanceof Map ? [...v] : v), text, `seed ${seed}: 이미 낸 사실은 불변`);
    }
    assert.equal(JSON.stringify(facts, (k, v) => v instanceof Map ? [...v] : v),
      JSON.stringify(listFactsFromHistory(card.history, NOW), (k, v) => v instanceof Map ? [...v] : v));
  }
});
