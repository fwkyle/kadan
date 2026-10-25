// Why: OS를 읽기 전에 확정한 현재 역할 상태만 보관하고 다음 수집의 SQL 값과 섞지 않는다.
import {decodeMailValue} from './mail-view-store.mjs';
import {loadRoleDispatch} from './watch-role-state.mjs';

const snapshots = new WeakMap();

export function sameRoleCards(facts, cards) {
  return Boolean(facts) && Array.isArray(cards) && cards.length === facts.inputs.length &&
    facts.inputs.every(([card, key, id], index) => card === cards[index] &&
      Object.is(key, card.key) && Object.is(id, card.id));
}

export function captureWatchRoleState(store, cards) {
  const facts = {inputs:cards.map(card => [card, card.key, card.id]),
    starts:new Map(), generations:new Map(), dispatches:new Map()};
  const rows = store.prepare('SELECT * FROM watch_role_sessions ORDER BY rank').all();
  for (const row of rows) {
    const session = decodeMailValue(row.value);
    if (row.start_position) facts.starts.set(session, store.load(row.start_position));
    if (row.generation_position) facts.generations.set(session, store.load(row.generation_position));
    if (!row.dispatch_ready) continue;
    const items = store.prepare(`SELECT * FROM watch_role_dispatches
      WHERE session_key=? ORDER BY rank`).all(row.key);
    facts.dispatches.set(session, new Map(items.map(item =>
      [decodeMailValue(item.task_value), loadRoleDispatch(store, item)])));
  }
  return facts;
}

export function rememberWatchRoleState(entries, cards, facts) {
  if (facts) snapshots.set(entries, {length:entries.length, cards, facts});
}

export function watchRoleState(entries, cards) {
  const value = snapshots.get(entries);
  if (value?.length !== entries.length || value.cards !== cards || !sameRoleCards(value.facts, cards)) return null;
  return {...value.facts, dispatches:new Map([...value.facts.dispatches].map(([session, items]) =>
    [session, new Map([...items].map(([key, entry]) => [key, {...entry}]))]))};
}
