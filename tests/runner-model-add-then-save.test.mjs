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

// 재검수(2026-11-18): 화면의 "이미 있는 이름" 검사는 화면이 읽은 목록 기준이라, 방금 등록한 이름을 목록을 다시 읽기 전에
// 또 등록하면 같은 이름의 강도 목록이 교체됐다. 보장은 서버가 한다: newOnly=1이면 설정 잠금 안에서 저장 직전 목록으로 거절한다.
test('newOnly=1: 방금 등록한 이름을 다시 등록하면 서버가 거절하고 목록·설정·원장이 그대로다. 칸이 없으면 기존 교체 동작', async () => {
  const home = fixture();
  const server = createWallServer(() => ({center: null, entries: readLedger(home), tree: [],
    ledgerLines: 0, collectedAt: new Date()}), {home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const add = fields => fetch(base + '/runners/model-add', {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, runner: 'agy', reason: '시험', ...fields})});
    const models = () => readSettings(home).runners.agy.models;
    const file = () => fs.readFileSync(path.join(home, 'runner-settings.json'), 'utf8');
    // 화면이 보내는 그대로: 첫 등록은 새 이름이라 성공한다.
    const first = await add({model: 'm-twice', efforts: 'low,high', revision: '1', newOnly: '1'});
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal((await first.json()).result.revision, 2);
    // 목록을 다시 읽기 전에 같은 이름·옛 강도 목록으로 또 등록(재검수 재현). 버전은 서버와 같은 2다.
    const before = file(), ledgerBefore = readLedger(home).length;
    const again = await add({model: 'm-twice', efforts: 'low', revision: '2', newOnly: '1'});
    assert.equal(again.status, 409);
    assert.match(await again.text(), /이미 등록된 모델 — 목록에서 고르세요/);
    assert.deepEqual(models().find(m => m.model === 'm-twice'), {model: 'm-twice', efforts: ['low', 'high']}, '강도 목록 불변');
    assert.equal(readSettings(home).revision, 2, 'revision 불변');
    assert.equal(file(), before, '설정 파일 바이트 불변');
    assert.equal(readLedger(home).length, ledgerBefore, '원장 불변');
    // 앞뒤 공백 같은 이름도 아니고 정확히 같은 이름이므로 걸린다. 다른 새 이름은 계속 등록된다.
    const other = await add({model: 'm-other', efforts: 'low', revision: '2', newOnly: '1'});
    assert.equal(other.status, 200, await other.clone().text());
    // 칸 값이 이상하면 조용히 넘기지 않고 거절한다.
    const bad = await add({model: 'm-bad', efforts: 'low', revision: '3', newOnly: 'yes'});
    assert.equal(bad.status, 409);
    assert.match(await bad.text(), /새 이름만 값이 올바르지 않다/);
    assert.equal(models().some(m => m.model === 'm-bad'), false);
    // 칸이 없으면 지금처럼 같은 이름의 강도 목록을 교체한다(고급 설정 표의 기존 동작 그대로).
    const replace = await add({model: 'm-twice', efforts: 'low', revision: '3'});
    assert.equal(replace.status, 200, await replace.clone().text());
    assert.deepEqual(models().find(m => m.model === 'm-twice'), {model: 'm-twice', efforts: ['low']});
    assert.equal(readSettings(home).revision, 4);
    // newOnly=''도 칸이 없는 것과 같다.
    const empty = await add({model: 'm-twice', efforts: 'low,high', revision: '4', newOnly: ''});
    assert.equal(empty.status, 200, await empty.clone().text());
    assert.deepEqual(models().find(m => m.model === 'm-twice').efforts, ['low', 'high']);
  } finally { server.close(); }
});

test('newOnly=1이어도 codex(목록 파일 실행기)는 기존 거절 문구가 먼저 나온다', async () => {
  const home = fixture();
  const server = createWallServer(() => ({center: null, entries: [], tree: [], ledgerLines: 0, collectedAt: new Date()}),
    {home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const res = await fetch(base + '/runners/model-add', {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, runner: 'codex', model: 'x-1', efforts: '', reason: '시험', revision: '1', newOnly: '1'})});
    assert.equal(res.status, 409);
    assert.match(await res.text(), /모델 목록 파일을 쓴다/);
  } finally { server.close(); }
});
