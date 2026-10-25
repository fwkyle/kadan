import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWallServer} from '../src/wall.mjs';
import {DEFAULT_FAMILIES, readSettings, setRole} from '../src/runner-settings.mjs';
import {exportPreset} from '../src/runner-export.mjs';
import {readLedger} from '../src/ledger.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-save-'));
  const choice = model => ({runner: 'codex', model});
  const preset = {label: '시험', roles: {worker: choice('gpt-test'), reviewer: choice('claude-test')}};
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({version: 1, revision: 1,
    activePreset: 'A', families: DEFAULT_FAMILIES,
    runners: {codex: {spawn: 'codex --model {model}',
      models: ['gpt-test', 'claude-test'].map(model => ({model, efforts: []}))}},
    presets: {A: preset, B: {roles: {worker: choice('gpt-test'), reviewer: choice('gpt-test')}}}}));
  return home;
}

test('A 단일 칸 수정도 B의 기존 계열 충돌과 무관하다', () => {
  const home = fixture(), records = [];
  setRole(home, {role: 'conductor', runner: 'codex', model: 'gpt-test', revision: 1,
    reason: '시험', by: '시험', record: e => records.push(e)});
  assert.equal(readSettings(home).revision, 2); assert.equal(records.length, 1);
});

test('실제 CLI import --replace는 1회 저장, 옵션 없으면 충돌 거절', () => {
  const home = fixture(), data = exportPreset(home, {name: 'A'});
  [data.preset.roles.worker, data.preset.roles.reviewer] =
    [data.preset.roles.reviewer, data.preset.roles.worker];
  const file = path.join(home, 'input.json'); fs.writeFileSync(file, JSON.stringify(data));
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const run = (...extra) => spawnSync(process.execPath,
    [cli, 'runners', 'import', file, '--revision', '1', '--reason', '교환', ...extra],
    {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8', timeout: 15000});
  assert.match(run().stderr, /이미 있는 프리셋/);
  const saved = run('--replace'); assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).revision, 2);
  assert.equal(readLedger(home).filter(e => e.kind === 'runner-settings').length, 1);
  assert.equal(readSettings(home).presets.A.roles.worker.model, 'claude-test');
});

test('실제 화면 API: 두 1순위 교환·폴백을 한 요청으로 저장, 거절 시 설정·원장 불변', async () => {
  const home = fixture();
  const server = createWallServer(() => ({center: null, entries: readLedger(home), tree: [],
    ledgerLines: 0, collectedAt: new Date()}), {home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const html = await (await fetch(base)).text();
    const token = html.match(/name="token" value="([a-f0-9]+)"/)[1];
    const preset = structuredClone(readSettings(home).presets.A);
    [preset.roles.worker, preset.roles.reviewer] = [preset.roles.reviewer, preset.roles.worker];
    preset.fallback = {worker: [{runner: 'codex', model: 'gpt-test'}]};
    const post = (fields = {}, origin = base) => fetch(base + '/runners/preset-save', {
      method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json', origin}, body: new URLSearchParams({token, preset: 'A',
        value: JSON.stringify(preset), revision: '1', reason: '한 번 교환', ...fields}),
    });
    assert.equal((await post({token: ''})).status, 403);
    assert.equal((await post({}, 'http://foreign.test')).status, 403);
    assert.equal((await post({reason: ''})).status, 409);
    assert.equal((await post({value: '{}'})).status, 409);
    assert.equal(readSettings(home).revision, 1); assert.equal(readLedger(home).length, 0);
    const response = await post(); assert.equal(response.status, 200, await response.clone().text());
    const saved = (await response.json()).result;
    assert.equal(saved.revision, 2); assert.match(saved.warnings.join(' '), /다른 계열 검수자 없음/);
    assert.deepEqual(readSettings(home).presets.A, preset);
    assert.equal(readLedger(home).length, 1);
    const before = fs.readFileSync(path.join(home, 'runner-settings.json'));
    assert.equal((await post()).status, 409, '옛 revision 거절');
    preset.roles.reviewer = preset.roles.worker;
    assert.equal((await post({revision: '2'})).status, 409, '1순위 같은 계열 거절');
    assert.deepEqual(fs.readFileSync(path.join(home, 'runner-settings.json')), before);
    assert.equal(readLedger(home).length, 1);
  } finally {
    await new Promise(r => server.close(r));
    const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
    assert.equal(listeners.stdout.trim(), '');
    console.log(`검증 서버 종료: PID ${process.pid}, 127.0.0.1:${port}, lsof LISTEN 없음`);
  }
});
