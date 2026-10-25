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
function factsOnly(card, bounded = false) {
  const {history, ...rest} = card;
  let facts = null, previous = null;
  for (const row of history) {facts = advanceListFacts(facts, previous, row, NOW, {bounded});previous = row;}
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

// 나머지 소비자는 옛 식(이력 위에서 계산)을 그대로 적고 사실이 같은 값을 주는지 임의 질의로 비교한다.
const date = value => Date.parse(value) || 0;
test('중앙 상태·시작 시각·검수 재개·보류 진입·설명 메모·최근 판단·미래 시각·이력 연속성: 옛 식과 사실이 같다', () => {
  const RALLY = ['rallyId', 'rallyTitle', 'rallyRound', 'rallyStep'];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const card = generateCard(seed), history = card.history, facts = factsOnly(card).listFacts;
    const r = rng(seed * 13 + 5);
    // card-center
    const transition = history.filter((h, i) => i > 0 && h.status !== history[i - 1].status).at(-1);
    assert.equal(facts.center.transition?.at, transition?.at, `seed ${seed} 마지막 상태 전환`);
    assert.equal(facts.center.question?.revision, history.filter(h => h.noteKind === 'question').at(-1)?.revision);
    assert.equal(facts.center.answer?.revision, history.filter(h => h.noteKind === 'answer').at(-1)?.revision);
    for (let k = 0; k < 6; k++) {
      const doneAt = NOW - Math.floor(r() * 80) * 3_600_000;
      const old = history.some((h, i) => i > 0 && (Date.parse(h.at) || 0) > doneAt && (h.status !== history[i - 1].status || h.role !== history[i - 1].role));
      assert.equal(facts.center.changedAt !== null && facts.center.changedAt > doneAt, old, `seed ${seed} 완료 뒤 변경`);
      // review-flow 재개
      const resultAt = r() < 0.2 ? undefined : new Date(NOW - Math.floor(r() * 80) * 3_600_000).toISOString();
      const reopened = history.some((h, i) => i > 0 && h.status !== history[i - 1].status && ['draft', 'ready', 'assigned'].includes(h.status) && date(h.at) > date(resultAt));
      assert.equal(facts.reopenMax !== null && facts.reopenMax > date(resultAt), reopened, `seed ${seed} 결과 뒤 재개`);
    }
    // card-worktime
    assert.equal(facts.firstAssigned?.at, history.find(h => h.status === 'assigned')?.at);
    const running = history.find(h => h.activity === 'running');
    assert.deepEqual(facts.firstRunning, running ? {activityAt: running.activityAt, at: running.at, activityRole: running.activityRole} : null);
    // review-flow / operations-flow 최초 결과 당시 값
    const registered = history.find(h => h.result);
    assert.deepEqual(facts.registered, registered ? {scope: registered.scope, role: registered.role, repoPath: registered.repoPath} : null);
    // explain-events 보류 진입
    assert.equal(facts.lastHoldEntry?.at, history.findLast((h, i) => h.status === 'hold' && history[i - 1]?.status !== 'hold')?.at);
    // explain-input 마지막 다섯 메모
    const notes = history.filter(h => ['decision', 'question', 'answer'].includes(h.noteKind) && h.note).slice(-5).map(h => [h.noteKind, h.by, h.note]);
    assert.deepEqual(facts.notes.slice(-5).map(n => [n.kind, n.by, n.note]), notes);
    // rallies 최근 판단
    const oldLatest = history.filter((h, i) => !RALLY.some(k => h[k] !== history[i - 1]?.[k])).filter(h => h.noteKind === 'decision' && h.note);
    assert.deepEqual(facts.rallyDecisions.map(d => [d.at, d.note]), oldLatest.map(h => [h.at, h.note.slice(0, 240)]));
    // wall-snapshot-cache 다음 시각 경계
    for (const now of [NOW, NOW - 30 * 3_600_000, NOW + 2 * 3_600_000]) {
      let oldNext = Infinity;
      for (const h of history) for (const v of [h.at, h.activityAt]) {const t = Date.parse(v);if (t > now && t < oldNext) oldNext = t;}
      let newNext = Infinity;
      for (const t of facts.futureTimes) if (t > now && t < newNext) newNext = t;
      // 사실은 적용 시각(NOW)보다 뒤인 시각만 든다: now가 그 이후일 때 같아야 한다.
      if (now >= NOW) assert.equal(newNext, oldNext, `seed ${seed} 다음 경계`);
    }
    // operations-flow 연속성
    const oldComplete = history.length === history.at(-1).revision && history.every((h, i) => h.key === history[0].key && h.revision === i + 1);
    assert.equal(facts.n === history.at(-1).revision && facts.contiguous && facts.keyConsistent && facts.firstKey === history[0].key, oldComplete);
  }
});

test('상시 보관(한도) 모드: 한도 안의 카드는 출력이 같고, 한도를 넘거나 값을 잃은 카드는 이력 보관 표시가 선다', () => {
  let kept = 0, needing = 0;
  const RALLY = ['rallyId', 'rallyTitle', 'rallyRound', 'rallyStep'];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const card = generateCard(seed, {maxRows: 60}), bounded = factsOnly(card, true);
    if (bounded.listFacts.needsHistory) {needing++;continue;}
    kept++;
    // 크기는 이력 길이와 무관한 상수 안이다.
    assert.ok(bounded.listFacts.explicit.length <= 3 && bounded.listFacts.waitingNotes.size <= 3 && bounded.listFacts.rallyDecisions.length <= 1);
    for (const now of [NOW, NOW - 20 * 3_600_000]) {
      assert.deepEqual(currentProgressReport(bounded, now), legacyCurrentProgressReport(card, now), `seed ${seed} 진행 보고`);
      assert.deepEqual(cardTurn(bounded, now), legacyCardTurn(card, now), `seed ${seed} 차례`);
    }
    for (const displayState of ['waiting']) {
      assert.equal(waitingText({...bounded, displayState}), legacyWaitingText({...card, displayState}));
    }
    const history = card.history;
    const oldLatest = history.filter((h, i) => !RALLY.some(k => h[k] !== history[i - 1]?.[k])).filter(h => h.noteKind === 'decision' && h.note)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    assert.equal(bounded.listFacts.rallyDecisions[0]?.at, oldLatest?.at, `seed ${seed} 최근 판단`);
    assert.equal(bounded.listFacts.rallyDecisions[0]?.note, oldLatest?.note.slice(0, 240));
  }
  assert.ok(kept > SEEDS * 0.7, `한도 안의 카드가 대부분이어야 한다: ${kept} / 이력 보관 ${needing}`);
});
