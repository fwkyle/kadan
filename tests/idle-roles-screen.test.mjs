import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWallServer} from '../src/wall.mjs';
import {DEFAULT_FAMILIES, readSettings} from '../src/runner-settings.mjs';
import {readLedger} from '../src/ledger.mjs';
import {writeIdleState} from '../src/idle-screen-clock.mjs';
import {idleRolesSummary, readIdleHours, IDLE_ROLES_OFF} from '../src/idle-roles-setting.mjs';
import {renderRunnerSettings} from '../src/runner-settings-wall.mjs';
import {runnersData} from '../src/dashboard/settings.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';

// Why: 사람이 대시보드 설정 화면에서 "쉬는 역할 기준 시간"을 바꾼다. 명령(kadan idle-roles set)과 같은 검사·같은 원장 사건이어야 하고,
// 화면은 후보 수만 보인다(작은 상태 파일에서 읽는다).
function settingsFile(home, extra = {}) {
  const choice = model => ({runner: 'codex', model});
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({version: 1, revision: 1, activePreset: 'A', families: DEFAULT_FAMILIES,
    runners: {codex: {spawn: 'codex --model {model}', models: ['gpt-test', 'claude-test'].map(model => ({model, efforts: []}))}},
    presets: {A: {roles: {worker: choice('gpt-test'), reviewer: choice('claude-test')}}}, ...extra}));
}

test('설정 화면: 기준 시간 바꾸기 — 범위·revision·이유·출처·토큰을 지키고, 사람 명의의 원장 사건이 남는다', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-screen-'));
  settingsFile(home);
  const server = createWallServer(() => ({center: null, entries: readLedger(home), tree: [], ledgerLines: 0, collectedAt: new Date(), home}), {home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const {token} = await (await fetch(base + '/api/dashboard/session')).json();
    const post = (fields = {}, origin = base) => fetch(base + '/runners/idle-hours', {
      method: 'POST', headers: {accept: 'application/json', origin},
      body: new URLSearchParams({token, hours: '6', reason: '시험', revision: String(readSettings(home).revision), ...fields}),
    });
    for (const [fields, pattern] of [
      [{hours: '0'}, /1~168 사이의 정수/], [{hours: '169'}, /1~168 사이의 정수/], [{hours: '1.5'}, /1~168 사이의 정수/],
      [{hours: ''}, /1~168 사이의 정수/], [{revision: '99'}, /설정이 바뀌었다/], [{reason: ''}, /이유/],
    ]) {
      const before = fs.readFileSync(path.join(home, 'runner-settings.json'));
      const res = await post(fields);
      assert.equal(res.status, 409, JSON.stringify(fields)); assert.match(await res.text(), pattern);
      assert.deepEqual(fs.readFileSync(path.join(home, 'runner-settings.json')), before);
      assert.equal(readLedger(home).length, 0);
    }
    assert.equal((await post({token: ''})).status, 403);
    assert.equal((await post({}, 'http://elsewhere.invalid')).status, 403);
    const ok = await post();
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.revision, 2);
    assert.deepEqual(readIdleHours(home), {hours: 6, source: 'setting', revision: 2});
    const event = readLedger(home).find(e => e.kind === 'runner-settings');
    assert.deepEqual({action: event.action, by: event.by, reason: event.reason, before: event.before, after: event.after},
      {action: 'idle-hours', by: '사람', reason: '시험', before: null, after: 6});

    // 설정 화면 데이터: 기준 시간과 범위, 후보 수(상태 파일), 우편 끔 여부.
    const runners = () => runnersData({home, entries: readLedger(home)}, new URL('http://local/api/dashboard/runners'), {});
    let data = runners();
    assert.deepEqual({hours: data.idleRoles.hours, source: data.idleRoles.source, min: data.idleRoles.min, max: data.idleRoles.max,
      candidates: data.idleRoles.candidates, mailOff: data.idleRoles.mailOff}, {hours: 6, source: 'setting', min: 1, max: 168, candidates: null, mailOff: false});
    assert.equal(data.history[0].action, 'idle-hours');
    writeIdleState(home, {lastRunAt: Date.now(), sessions: {}, attempts: {}, candidatesAt: Date.now(),
      candidates: [{role: 'a', profile: 'worker', since: 1, recipient: 'b'}, {role: 'c', profile: 'reviewer', since: 1, recipient: 'b'}]});
    fs.writeFileSync(path.join(home, IDLE_ROLES_OFF), '');
    data = runners();
    assert.equal(data.idleRoles.candidates, 2);
    assert.equal(data.idleRoles.mailOff, true);
  } finally { await new Promise(r => server.close(r)); }
});

test('현황 화면 데이터: 후보 수만 간다. 한 번도 돌지 않았으면 모름(null)이다', async t => {
  const f = dashboardFixture({mode: 'sqlite'});
  t.after(() => f.server.close());
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  const status = async () => (await fetch(`http://127.0.0.1:${f.server.address().port}/api/dashboard/status`)).json();
  assert.equal((await status()).idleCandidates, null);
  writeIdleState(f.home, {lastRunAt: Date.now(), sessions: {}, attempts: {}, candidatesAt: Date.now(),
    candidates: [{role: 'a', profile: 'worker', since: 1, recipient: 'b'}]});
  assert.equal((await status()).idleCandidates, 1);
});

test('요약: 설정 파일이 없거나 깨졌거나 값이 범위 밖이면 기본 12시간, 후보 수는 모름', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-summary-'));
  assert.deepEqual({hours: idleRolesSummary(home).hours, source: idleRolesSummary(home).source, candidates: idleRolesSummary(home).candidates, lastRunAt: idleRolesSummary(home).lastRunAt},
    {hours: 12, source: 'default', candidates: null, lastRunAt: null});
  fs.writeFileSync(path.join(home, 'runner-settings.json'), '{');
  assert.equal(idleRolesSummary(home).hours, 12);
  for (const bad of [0, 169, 1.5, '6', null]) {
    settingsFile(home, {idleRoleHours: bad});
    assert.deepEqual(readIdleHours(home), {hours: 12, source: 'default', revision: 1}, JSON.stringify(bad));
  }
  settingsFile(home, {idleRoleHours: 24});
  assert.equal(readIdleHours(home).hours, 24);
});

test('옛 서버 화면의 최근 변경 표: 기준 시간 변경을 사람이 읽는 말로 보인다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-wall-'));
  settingsFile(home);
  const html = renderRunnerSettings({home, entries: [
    {kind: 'runner-settings', action: 'idle-hours', by: '사람', reason: '더 빨리', before: null, after: 6, revision: 2, t: '2026-11-13T00:00:00Z'},
    {kind: 'runner-settings', action: 'idle-hours', by: '사람', reason: '다시', before: 6, after: 24, revision: 3, t: '2026-11-13T01:00:00Z'}]});
  assert.match(html, /쉬는 역할 기준 시간<\/td><td>기본값 → 6시간/);
  assert.match(html, /쉬는 역할 기준 시간<\/td><td>6시간 → 24시간/);
});
