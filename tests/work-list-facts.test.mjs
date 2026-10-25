import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rng} from './helpers/history-generator.mjs';
import {advanceWorkFacts, workFactsFromHistory, workFactsOf} from '../src/work-list-facts.mjs';
import {effectiveWorkOwnership} from '../src/handover-state.mjs';

const pick = (r, list) => list[Math.floor(r() * list.length)];
function generateWork(seed) {
  const r = rng(seed), n = 1 + Math.floor(r() * 30), rows = [];
  let state = {key: 'r/work', owner: 'boss', nextAction: undefined, turnOwner: undefined};
  for (let i = 0; i < n; i++) {
    const row = {...state, revision: i + 1, at: r() < 0.1 ? 'broken' : new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString(),
      action: i === 0 ? 'create' : pick(r, ['update', 'update', 'complete', 'cancel', 'reopen']), by: pick(r, ['boss', 'worker', '사람'])};
    if (r() < 0.2) row.owner = pick(r, ['boss', 'boss2', 'worker']);
    if (r() < 0.3) row.nextAction = pick(r, [undefined, '다음 A', '다음 B']);
    if (r() < 0.2) row.turnOwner = pick(r, [undefined, 'boss', 'worker']);
    if (r() < 0.15) row.ownerAssignedAt = new Date(Date.UTC(2026, 0, 1, 0, i * 5 + 1)).toISOString();
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    rows.push(row);
    const {action, by, revision, at, ownerAssignedAt, ...carried} = row;
    state = carried;
  }
  const last = rows.at(-1);
  return {...last, history: rows};
}

// 옛 구현(ba6ab2b)의 식을 그대로 적은 기준
function legacyOwnership(work, entries) {
  const history = work.history ?? [];
  const changed = history.findLast((h, i) => i === 0 || history[i - 1].owner !== h.owner)?.at ?? work.at;
  const assigned = history.findLast(h => h.ownerAssignedAt)?.ownerAssignedAt;
  return {changed, assigned};
}

test('업무 사실: 담당 전환·명시 재지정·다음 행동 변경·열기/닫기가 옛 식과 같다', () => {
  for (let seed = 1; seed <= 1500; seed++) {
    const work = generateWork(seed), h = work.history;
    const facts = workFactsFromHistory(h);
    const old = legacyOwnership(work);
    assert.equal(facts.ownerChange?.at ?? work.at, old.changed, `seed ${seed}`);
    assert.equal(facts.ownerAssignedAt ?? undefined, old.assigned);
    const changed = h.filter((x, i, a) => x.nextAction && (!i || x.nextAction !== a[i - 1].nextAction || x.turnOwner !== a[i - 1].turnOwner)).at(-1);
    assert.equal(facts.nextActionChange?.at, changed?.at);
    assert.equal(facts.opened?.at, h.findLast(x => ['create', 'reopen'].includes(x.action))?.at);
    assert.equal(facts.ended?.at, h.findLast(x => ['complete', 'cancel'].includes(x.action))?.at);
    // 증분으로 쌓은 사실, 이력이 없는 행의 사실이 모두 같다
    let inc = null, prev = null;
    for (const row of h) {inc = advanceWorkFacts(inc, prev, row);prev = row;}
    assert.deepEqual(inc, facts);
    const {history, ...rest} = work;
    assert.deepEqual(effectiveWorkOwnership({...rest, workFacts: inc}, []), effectiveWorkOwnership(work, []), `seed ${seed} 책임자`);
    assert.equal(workFactsOf({...rest, workFacts: inc}), inc);
  }
});
