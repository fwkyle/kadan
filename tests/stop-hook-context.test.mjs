import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compactReminder, lastCompactBoundary, reminderText, lookupExecutions} from '../src/stop-hook-context.mjs';
import {scenario} from './helpers/responsibility-scenario.mjs';
import {CardStore} from '../src/card-store.mjs';

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
const found = async () => ['kadan/exec-1'];

test('압축 직후 첫 Stop: claude·codex 경계 모두 카드 주소를 한 번만 안내한다', async () => {
  for (const boundary of [claudeBoundary('b1', NOW - 5000), codexBoundary('w1', NOW - 5000)]) {
    const {file, env} = setup([{type: 'user'}, boundary, {type: 'assistant'}]);
    assert.equal(await compactReminder(stop(file), env, {lookup: found, now}), reminderText(['kadan/exec-1']));
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

test('새 경계를 처음 본 Stop이 결과와 무관하게 기회를 소모한다(찾지 못함·조회 실패·마커 응답)', async () => {
  for (const [lookup, message] of [[async () => [], '규칙'], [async () => { throw new Error('busy'); }, '규칙'], [found, 'KADAN:DONE exec-1 ok']]) {
    const {file, env} = setup([claudeBoundary('b1', NOW - 5000)]);
    assert.equal(await compactReminder(stop(file, {last_assistant_message: message}), env, {lookup, now}), null);
    assert.equal(await compactReminder(stop(file), env, {lookup: found, now}), null); // 같은 압축의 두 번째 Stop은 막지 않는다
  }
});

test('미완료 실행이 여럿이면 하나의 안내에 모두 적는다', async () => {
  const {file, env} = setup([claudeBoundary('b1', NOW - 5000)]);
  const text = await compactReminder(stop(file), env, {lookup: async () => ['kadan/exec-1', 'kadan/exec-2'], now});
  assert.match(text, /`kadan\/exec-1`, `kadan\/exec-2`/);
  assert.doesNotMatch(text, /KADAN:DONE/);
});

test('개인 실행기와 훅 재호출은 기회를 소모하지 않는다', async () => {
  const {file, env, home} = setup([claudeBoundary('b1', NOW - 5000)]);
  assert.equal(await compactReminder(stop(file), {KADAN_HOME: home}, {lookup: found, now}), null);
  assert.equal(await compactReminder(stop(file, {stop_hook_active: true}), env, {lookup: found, now}), null);
  assert.equal(fs.existsSync(path.join(home, 'stop-hook')), false);
  assert.ok(await compactReminder(stop(file), env, {lookup: found, now}));
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

test('실제 원장 조회: 발령된 역할은 현재 실행 하나를 찾고, 발령 전·다른 역할·원장 없음에는 비어 있다', () => {
  const s = scenario({run() {}});
  const store = new CardStore(s.home);
  assert.deepEqual(lookupExecutions(s.home, 'r-작업자'), []); // 아직 발령(assigned) 전
  store.update(s.execution, {status: 'assigned', board: 'b', role: 'r-작업자', scope: '범위', rallyId: 'r1', rallyTitle: 't', rallyRound: '1', rallyStep: 'implementation'}, {revision: store.get(s.execution).revision, note: '발령'});
  assert.deepEqual(lookupExecutions(s.home, 'r-작업자'), [s.execution]);
  assert.deepEqual(lookupExecutions(s.home, 'r-감독'), []);
  assert.deepEqual(lookupExecutions(tmp(), 'r-작업자'), []); // 원장이 없으면 빈 배열(fail-open)
});
