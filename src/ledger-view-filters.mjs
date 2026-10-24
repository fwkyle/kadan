// Why: 원장 거르기의 JS 의미를 저장할 때 한 번 계산하고 SQL로 필요한 위치만 찾는다.
import {isIncident, isWatchRoutine} from './ledger-table.mjs';

export function storeLedgerFilters(state, value, position) {
  const ms = typeof value?.t === 'string' ? Date.parse(value.t) : NaN;
  let date = null;
  if (Number.isFinite(ms)) {
    try {date = new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);} catch {date = '!range';}
  }
  const incident = Number(Boolean(isIncident(value))), routine = Number(isWatchRoutine(value));
  state.prepare('INSERT INTO filters VALUES(?,?,?,?)').run(position, incident, routine, date);
  for (const role of new Set([value?.role, value?.by, value?.to, value?.from, value?.recipient])) {
    if (typeof role === 'string') state.prepare('INSERT OR IGNORE INTO roles VALUES(?,?)').run(role, position);
  }
  const cards = [value?.taskId, value?.executionKey, value?.completionTaskId, value?.workKey, value?.key,
    ...(Array.isArray(value?.taskIds) ? value.taskIds : [])].filter(card => typeof card === 'string');
  for (const card of new Set(cards)) {
    state.prepare('INSERT OR IGNORE INTO card_refs VALUES(?,?)').run(card, position);
    state.prepare('INSERT OR IGNORE INTO short_refs VALUES(?,?)').run(card.split('/').at(-1), position);
  }
  return {incident, routine};
}

export function ledgerWhere({domain = null, kind = '', role = '', card = '', date = '', routine = false} = {}) {
  const clauses = ['v.domain=?'], params = [domain ?? ''];
  if (!routine) clauses.push('v.routine=0');
  if (kind === 'incident') clauses.push('f.incident=1');
  if (date) {clauses.push('f.date=?');params.push(date);}
  if (role) {
    clauses.push('v.position IN (SELECT position FROM roles WHERE role=?)');params.push(role);
  }
  if (card) {
    if (card.includes('/')) {
      clauses.push('v.position IN (SELECT position FROM card_refs WHERE card IN (?,?))');
      params.push(card, card.split('/').at(-1));
    } else {
      clauses.push('v.position IN (SELECT position FROM short_refs WHERE card=?)');params.push(card);
    }
  }
  return {sql:clauses.join(' AND '), params, simple:!date && !role && !card && kind !== 'incident'};
}
