import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWallServer} from '../src/wall.mjs';
import {DEFAULT_FAMILIES, readSettings} from '../src/runner-settings.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {compareReport} from '../src/compare-report.mjs';

test('비교 화면: CLI와 같은 검사·사건·보고서, 출처·토큰·버전 보호', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-screen-'));
  const choice = model => ({runner: 'codex', model});
  const roles = {worker: choice('gpt-test'), reviewer: choice('claude-test')};
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({version: 1, revision: 1,
    activePreset: 'A', families: DEFAULT_FAMILIES,
    runners: {codex: {spawn: 'codex --model {model}',
      models: ['gpt-test', 'claude-test'].map(model => ({model, efforts: []}))}},
    presets: {A: {roles}, B: {roles: {worker: roles.reviewer, reviewer: roles.worker}},
      Empty: {roles: {}}, Same: {roles: {worker: roles.worker, reviewer: roles.worker}}}}));
  const server = createWallServer(() => ({center: null, entries: readLedger(home), tree: [],
    ledgerLines: 0, collectedAt: new Date()}), {home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const {token} = await (await fetch(base + '/api/dashboard/session')).json();
    const post = (fields = {}, origin = base) => fetch(base + '/runners/compare', {
      method: 'POST', headers: {accept: 'application/json', origin},
      body: new URLSearchParams({token, mode: 'on', presets: JSON.stringify(['A', 'B']),
        reason: '시험', revision: String(readSettings(home).revision), ...fields}),
    });
    for (const [fields, pattern] of [
      [{presets: '["missing"]'}, /없는 프리셋/], [{presets: '["Empty"]'}, /역할 값 없음/],
      [{presets: '["Same"]'}, /같은 계열/], [{presets: '[]'}, /비교 설정 손상/],
      [{revision: '99'}, /설정이 바뀌었다/], [{reason: ''}, /이유/], [{mode: 'bad'}, /on 또는 off/],
    ]) {
      const before = fs.readFileSync(path.join(home, 'runner-settings.json'));
      const res = await post(fields);
      assert.equal(res.status, 409); assert.match(await res.text(), pattern);
      assert.deepEqual(fs.readFileSync(path.join(home, 'runner-settings.json')), before);
      assert.equal(readLedger(home).length, 0);
    }
    assert.equal((await post({token: ''})).status, 403);
    assert.equal((await post({}, 'http://elsewhere.invalid')).status, 403);
    assert.equal((await post()).status, 200);
    const epoch = readSettings(home).compare.enabledAt;
    for (const name of ['A', 'B']) appendLedger({kind: 'compare-pick', pickId: name, epoch,
      preset: name, ...readSettings(home).presets[name].roles}, home);
    const state = await (await fetch(base + '/runners/compare')).json();
    assert.deepEqual(state.picks, {A: 1, B: 1});
    const report = await (await fetch(base + '/runners/compare-report')).json();
    assert.equal(report.groups.length, 2);
    const stripTime = ({asOf, ...rest}) => rest;
    assert.deepEqual(stripTime(report), stripTime(compareReport(home)));
    const cli = spawnSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname,
      'runners', 'report', '--json'], {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8'});
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(stripTime(report), stripTime(JSON.parse(cli.stdout)));
    assert.equal((await fetch(base + '/runners/compare-report?since=bad')).status, 409);
    assert.equal((await post({presets: '["B","A"]'})).status, 200);
    assert.deepEqual(readSettings(home).compare.presets, ['B', 'A']);
    assert.notEqual(readSettings(home).compare.enabledAt, epoch);
    assert.equal((await post({mode: 'off'})).status, 200);
    assert.equal(readSettings(home).compare.enabled, false);
    assert.deepEqual(readLedger(home).filter(e => e.kind === 'runner-settings').map(e => e.action),
      ['compare', 'compare', 'compare']);
  } finally {
    await new Promise(r => server.close(r));
    const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
    assert.equal(listeners.stdout.trim(), '');
    console.log(`검증 서버 종료: PID ${process.pid}, 127.0.0.1:${port}, LISTEN 없음`);
  }
});
