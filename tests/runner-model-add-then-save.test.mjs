import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWallServer} from '../src/wall.mjs';
import {DEFAULT_FAMILIES, readSettings} from '../src/runner-settings.mjs';
import {readLedger} from '../src/ledger.mjs';

// 바꾸기 창의 '+ 새 모델 등록'은 새 서버 경로 없이 /runners/model-add를 부른 뒤, 작성 중이던 변경안을
// 새 설정 버전으로 /runners/preset-save에 보낸다. 그 연속 호출이 실제 서버에서 409 없이 되는지 격리 홈으로 본다.
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-add-save-'));
  const choice = (runner, model, effort) => ({runner, model, ...(effort ? {effort} : {})});
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({version: 1, revision: 1,
    activePreset: 'A', families: DEFAULT_FAMILIES,
    runners: {
      codex: {spawn: 'codex --model {model}', catalog: 'codex-models-cache'},
      agy: {spawn: 'agy --model {model} --effort {effort}', models: [{model: 'm-old', efforts: ['low', 'high']}]},
    },
    presets: {A: {label: '시험', roles: {worker: choice('agy', 'm-old', 'high'), reviewer: choice('agy', 'm-old', 'high')}}}}));
  return home;
}

test('모델 등록 뒤 새 버전으로 저장하면 409 없이 되고, 옛 버전으로 저장하면 거절된다', async () => {
  const home = fixture();
  const server = createWallServer(() => ({center: null, entries: readLedger(home), tree: [],
    ledgerLines: 0, collectedAt: new Date()}), {home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(base)).text();
    const token = html.match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = (pathname, fields) => fetch(base + pathname, {
      method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, ...fields}),
    });
    // 화면이 보내는 그대로: 이유는 화면이 채워 보낸다.
    const added = await post('/runners/model-add', {runner: 'agy', model: 'm-new', efforts: 'low,high',
      reason: '바꾸기 창에서 새 모델 등록: agy / m-new', revision: '1'});
    assert.equal(added.status, 200, await added.clone().text());
    const afterAdd = (await added.json()).result.revision;
    assert.equal(afterAdd, 2, '응답이 새 설정 버전을 돌려준다(화면이 변경안에 이어 붙인다)');
    assert.deepEqual(readSettings(home).runners.agy.models.find(m => m.model === 'm-new'), {model: 'm-new', efforts: ['low', 'high']});
    // 등록 전에 이미 고쳐 둔 다른 줄(검수자)과 새 모델을 고른 작업자 줄을 한 요청으로 저장한다.
    const preset = structuredClone(readSettings(home).presets.A);
    // 모델만 바꿔도 지금 강도(high)를 유지한다(새 모델이 지원하므로).
    preset.roles.worker = {runner: 'agy', model: 'm-new', effort: 'high'};
    preset.roles.reviewer = {runner: 'agy', model: 'm-old', effort: 'high'};
    preset.fallback = {reviewer: [{runner: 'agy', model: 'm-new', effort: 'low'}]};
    const save = revision => post('/runners/preset-save',
      {preset: 'A', value: JSON.stringify(preset), revision, reason: '시험 저장'});
    const stale = await save('1');
    assert.equal(stale.status, 409, '등록 전 버전으로는 저장되지 않는다 — 화면이 새 버전을 이어 붙이는 이유');
    const ok = await save(String(afterAdd));
    assert.equal(ok.status, 200, await ok.clone().text());
    const saved = readSettings(home).presets.A;
    assert.equal(saved.roles.worker.model, 'm-new');
    assert.equal(saved.roles.worker.effort, 'high');
    assert.deepEqual(saved.fallback.reviewer, [{runner: 'agy', model: 'm-new', effort: 'low'}]);
    assert.equal(readSettings(home).revision, 3);
  } finally { server.close(); }
});

test('codex처럼 모델 목록 파일을 쓰는 실행기에는 서버도 직접 등록을 거절하고 설정은 그대로다', async () => {
  const home = fixture();
  const before = fs.readFileSync(path.join(home, 'runner-settings.json'), 'utf8');
  const server = createWallServer(() => ({center: null, entries: [], tree: [], ledgerLines: 0, collectedAt: new Date()}),
    {home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const res = await fetch(base + '/runners/model-add', {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, runner: 'codex', model: 'x-1', efforts: '', reason: '시험', revision: '1'})});
    assert.equal(res.status, 409);
    assert.match(await res.text(), /모델 목록 파일을 쓴다/);
    assert.equal(fs.readFileSync(path.join(home, 'runner-settings.json'), 'utf8'), before);
  } finally { server.close(); }
});
