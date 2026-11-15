// Why: 주소 추가의 증분 상태를 지름길 없는 전체 재생과 같은 모양으로 비교한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDatabase, writeStorageMarker, appendStream} from '../../src/storage.mjs';
import {appendLedger} from '../../src/ledger.mjs';
import {ledgerViewPath} from '../../src/ledger-view-store.mjs';
import {createWatchMailReader} from '../../src/watch-mail-reader.mjs';
import {createWatchReplayMetrics} from '../../src/watch-replay-metrics.mjs';
import {createLedgerArraySweep} from '../../src/watch-sweep.mjs';
import {taskIdentity, taskConnectionError} from '../../src/task-identity.mjs';

export const at = '2026-01-01T00:00:00Z';
export const card = (id = 'one', repo = 'fixture') => ({key: `${repo}/${id}`, id});
export const start = {kind: 'start', role: 'fixture-worker', session: 'kadan-fixture-worker', panePid: 1, t: at};
export const question = {kind: 'send', role: start.role, by: 'fixture-boss', mailId: 'fixture-question',
  session: start.session, taskId: 'one', executionKey: 'fixture/one',
  workKey: 'fixture/work', expectReply: true, t: at};
export function fixture(events = [start, question], cards = [card()]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-address-add-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');
  for (const entry of events) appendStream(home, 'ledger.jsonl', entry);
  const state = {home, cards, metrics: createWatchReplayMetrics()};
  state.reader = createWatchMailReader(home, null, {readCards: () => state.cards,
    readWorks: () => [], readRoles: () => [start.role], metrics: state.metrics});
  state.edit = fn => {
    const db = new DatabaseSync(ledgerViewPath(home));
    try { return fn(db); } finally { db.close(); }
  };
  state.append = entry => appendLedger({t: at, ...entry}, home);
  state.read = () => {
    const raw = state.reader.readEntries(), projected = state.reader.project(raw, state.cards);
    const expected = taskIdentity(state.cards).project(raw).filter(entry => !taskConnectionError(entry));
    assert.deepEqual(projected, expected);
    return {raw, projected, saved: capture(home)};
  };
  state.sweep = () => createLedgerArraySweep({access: state.reader.sweepAccess, chunkRows: 3}).full();
  state.first = state.read();state.metrics.clear();
  return state;
}

const tables = ['views', 'watch_mail_completions', 'mail_current', 'mail_refs', 'mail_ids',
  'mail_sender_roles', 'mail_transfers', 'mail_reminders', 'mail_done_refs', 'mail_generation',
  'mail_cards', 'mail_role_counts', 'watch_role_sessions', 'watch_role_dispatches',
  'watch_work_last', 'watch_work_sent', 'watch_work_transfers'];
export function capture(home) {
  const db = new DatabaseSync(ledgerViewPath(home), {readOnly: true});
  try {
    const rows = {};
    for (const table of tables) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      const where = cols.some(col => col.name === 'domain') ? " WHERE domain='watch'" : '';
      const order = cols.filter(col => col.pk).sort((a, b) => a.pk - b.pk).map(col => col.name).join(',');
      rows[table] = db.prepare(`SELECT * FROM ${table}${where} ORDER BY ${order}`).all();
    }
    const meta = {};
    for (const table of ['watch_mail_projection', 'mail_view_meta', 'watch_role_meta', 'watch_work_meta']) {
      const where = table === 'mail_view_meta' ? "domain='watch'" : 'id=1';
      meta[table] = JSON.parse(db.prepare(`SELECT value FROM ${table} WHERE ${where}`).get().value);
    }
    return {rows, meta};
  } finally { db.close(); }
}
export const stable = saved => ({rows: saved.rows, meta: Object.fromEntries(
  Object.entries(saved.meta).map(([table, {generation, revision, ...meta}]) => [table, meta]),
)});
export function fullEquivalent(state, actual = state.read()) {
  state.edit(db => db.exec('DELETE FROM watch_mail_projection'));
  const full = state.read();
  assert.deepEqual(stable(actual.saved), stable(full.saved));
  assert.deepEqual(actual.projected, full.projected);
  return full;
}
export function replayIs(state, skipped, full) {
  const {replay} = state.metrics.snapshot();
  assert.equal(replay.projection.skipped, skipped);
  for (const key of ['projection', 'mail', 'role', 'work']) assert.equal(replay[key].full, full, key);
}
