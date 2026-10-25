// Why: 현재 감시 카드와 열린 업무에 필요한 책임 사실만 같은 수집에서 보관한다.
import {ownerGenerations} from './owner-generation.mjs';
import {withEffectiveOwner} from './handover-state.mjs';
import {taskIdentity} from './task-identity.mjs';
import {loadWorkEntry, workPendingKey} from './watch-work-state.mjs';

const snapshots = new WeakMap();
const cardFields = ['key', 'id', 'role', 'status', 'at'];

export function sameWatchCards(facts, cards) {
  return Boolean(facts) && facts.inputs.length === cards.length && facts.inputs.every((input, index) =>
    input[0] === cards[index] && cardFields.every((field, offset) =>
      Object.is(input[offset + 1], cards[index][field])));
}

function effectiveRole(store, card) {
  let role = card.role, position = 0;
  if (!card.key) return role;
  const time = Date.parse(card.at);
  const next = store.prepare(`SELECT target,position FROM watch_work_transfers
    WHERE task_key=? AND source=? AND position>?
    AND (?=0 OR has_time=0 OR time>=?) ORDER BY position LIMIT 1`);
  while (typeof role === 'string') {
    const found = next.get(store.key(card.key), role, position, Number(Boolean(card.at)),
      Number.isFinite(time) ? time : null);
    if (!found) break;
    role = found.target;position = found.position;
  }
  return role;
}

export function captureWatchScopeFacts(store, cards, works, rawEntries) {
  if (!store) return null;
  const facts = {cards:new Map(), bounds:new Map(), covered:new Set(), sent:new Set(),
    inputs:cards.map(card => [card, ...cardFields.map(field => card[field])])};
  const bounds = store.map('bounds');
  const includeRole = role => {
    if (!facts.bounds.has(role)) facts.bounds.set(role, bounds.get(role)?.time ?? null);
  };
  const last = store.prepare(`SELECT position,kind,overlay FROM watch_work_last
    WHERE pending_key=? ORDER BY position DESC LIMIT 1`);
  const identity = taskIdentity(cards);
  for (const card of cards) {
    if (card.status !== 'assigned') continue;
    const role = effectiveRole(store, card);
    includeRole(role);
    const row = last.get(workPendingKey(role, identity.taskIdFor(card)));
    facts.cards.set(card, {role, sent:row?.kind === 'send' ? loadWorkEntry(store, row) : null});
  }
  const sent = store.prepare('SELECT 1 FROM watch_work_sent WHERE task_key=?');
  for (const work of works ?? []) {
    if (work.status !== 'open') continue;
    const current = withEffectiveOwner(work, rawEntries);
    includeRole(current.owner);includeRole(current.turnOwner);
    for (const execution of work.executions) {
      facts.covered.add(execution.key);
      if (sent.get(store.key(execution.key))) facts.sent.add(execution.key);
    }
  }
  return facts;
}

export function rememberWatchScopeFacts(entries, cards, facts) {
  if (facts) snapshots.set(entries, {length:entries.length, cards, facts});
}

export function watchScopeFacts(entries, cards) {
  const found = snapshots.get(entries);
  return found?.length === entries.length && found.cards === cards && sameWatchCards(found.facts, cards)
    ? found.facts : null;
}

export function watchScopeGenerations(entries, facts) {
  if (!facts) return ownerGenerations(entries);
  let fallback;
  return {isPreviousAt(role, at) {
    if (!facts.bounds.has(role)) {
      fallback ??= ownerGenerations(entries);
      return fallback.isPreviousAt(role, at);
    }
    const ms = typeof at === 'number' ? at : Date.parse(at), time = facts.bounds.get(role);
    return Number.isFinite(ms) && time != null && time > ms;
  }};
}

export function watchSentTasks(works, facts) {
  if (!facts || works.some(work => work.status === 'open' &&
      work.executions.some(execution => !facts.covered.has(execution.key)))) return null;
  return facts.sent;
}
