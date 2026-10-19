import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compactReminder, lastCompactBoundary, reminderText} from '../src/stop-hook-context.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-compact-hook-'));
const NOW = Date.parse('2026-10-19T06:00:00.000Z');
const now = () => NOW;
const iso = ms => new Date(ms).toISOString();
const claudeBoundary = (id, at) => ({type: 'system', subtype: 'compact_boundary', uuid: id, timestamp: iso(at)});
const codexBoundary = (id, at) => ({timestamp: iso(at), type: 'compacted', payload: {window_id: id, message: ''}});
function setup(rows) {
  const home = tmp(), file = path.join(home, 't.jsonl');
  fs.writeFileSync(file, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  return {home, file, env: {KADAN_ROLE: 'r', KADAN_HOME: home}};
}
const stop = (file, extra = {}) => JSON.stringify({hook_event_name: 'Stop', session_id: 's1', transcript_path: file, last_assistant_message: '규칙을 따르겠습니다', stop_hook_active: false, ...extra});
const found = async () => 'kadan/exec-1';

test('압축 직후 첫 Stop: claude·codex 경계 모두 카드 주소를 한 번만 안내한다', async () => {
  for (const boundary of [claudeBoundary('b1', NOW - 5000), codexBoundary('w1', NOW - 5000)]) {
    const {file, env} = setup([{type: 'user'}, boundary, {type: 'assistant'}]);
    assert.equal(await compactReminder(stop(file), env, {lookup: found, now}), reminderText('kadan/exec-1'));
    assert.equal(await compactReminder(stop(file), env, {lookup: found, now}), null); // 같은 압축에는 두 번 안 한다
  }
});

test('새 압축 경계는 다시 안내한다', async () => {
  const {file, env} = setup([claudeBoundary('b1', NOW - 9000)]);
  assert.ok(await compactReminder(stop(file), env, {lookup: found, now}));
  fs.appendFileSync(file, JSON.stringify(claudeBoundary('b2', NOW - 1000)) + '\n');
  assert.ok(await compactReminder(stop(file), env, {lookup: found, now}));
});

test('개인 실행기·재호출·완료 마커·옛 경계·경계 없음·경로 이상은 안내하지 않는다', async () => {
  const {file, env} = setup([claudeBoundary('b1', NOW - 5000)]);
  const call = (raw, e = env, lookup = found) => compactReminder(raw, e, {lookup, now});
  assert.equal(await call(stop(file), {KADAN_HOME: env.KADAN_HOME}), null);
  assert.equal(await call(stop(file, {stop_hook_active: true})), null);
  assert.equal(await call(stop(file, {hook_event_name: 'SessionStart'})), null);
  assert.equal(await call(stop(file, {last_assistant_message: '끝\nKADAN:DONE exec-1 ok'})), null);
  assert.equal(await call(stop(file, {transcript_path: null})), null);
  assert.equal(await call(stop(file, {transcript_path: 'rel/t.jsonl'})), null);
  assert.equal(await call(stop(path.join(env.KADAN_HOME, 'none.jsonl'))), null);
  assert.equal(await call('not json'), null);
  const old = setup([claudeBoundary('b0', NOW - 2 * 3600 * 1000)]);
  assert.equal(await call(stop(old.file), old.env), null);
  const none = setup([{type: 'user'}, {type: 'assistant'}]);
  assert.equal(await call(stop(none.file), none.env), null);
});

test('현재 실행을 못 찾거나 조회가 실패하면 안내하지 않고, 실패 뒤에는 선점도 남기지 않는다', async () => {
  const {file, env} = setup([claudeBoundary('b1', NOW - 5000)]);
  assert.equal(await compactReminder(stop(file), env, {lookup: async () => null, now}), null);
  assert.equal(await compactReminder(stop(file), env, {lookup: async () => { throw new Error('busy'); }, now}), null);
  assert.ok(await compactReminder(stop(file), env, {lookup: found, now})); // 앞의 실패가 기회를 소모하지 않았다
});

test('마지막 경계가 모호하면 옛 경계로 대신하지 않는다', () => {
  const {file} = setup([claudeBoundary('b1', NOW - 5000), {type: 'system', subtype: 'compact_boundary', timestamp: iso(NOW)}]);
  assert.equal(lastCompactBoundary(file), null);
});

test('실제 훅 프로세스: 원장이 없으면 출력 없이 종료 0', () => {
  const {file, env} = setup([claudeBoundary('b1', Date.now() - 1000)]);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'stop-hook.mjs');
  const run = spawnSync(process.execPath, [script], {input: stop(file), env: {...process.env, ...env}, encoding: 'utf8'});
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
});
