import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {changedRunnerFields, initSettings, readSettings, removeRunnerModel, setFavorites, setFallback, setRole, setRunner, setRunnerModel} from '../src/runner-settings.mjs';
import {parseModelList} from '../src/runner-table.mjs';
import {listRunnerModels} from '../src/runner-model-list.mjs';
import {createCenterHandler} from '../src/center-wall.mjs';
import {readLedger} from '../src/ledger.mjs';

const codexModels = [{slug: 'gpt-6-sol', supported_reasoning_levels: [{effort: 'low'}]}];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-runner-screen-'));
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [
    {id: 'codex', spawn: 'codex --model {model} -c e="{effort}"'},
    {id: 'agy', spawn: 'agy --model {model}'},
  ]}));
  const records = [], record = e => records.push(e);
  initSettings(home, {by: 'kyle', reason: '시작', record});
  let rev = 1;
  const meta = () => ({revision: rev, by: 'kyle', reason: '시험', record});
  const step = fn => { const v = fn(meta()); rev = v.revision; return v; };
  return {home, records, meta, step, rev: () => rev};
}
const noCodex = {readCodexModels: () => ({models: codexModels})};

test('모델 삭제: 안 쓰는 모델은 지우고 사건 1줄, 쓰는 곳은 모두 적어 거절, catalog·revision 거절', () => {
  const f = fixture();
  f.step(m => setRunnerModel(f.home, {runner: 'agy', model: 'm-a', efforts: '', ...m}));
  f.step(m => setRunnerModel(f.home, {runner: 'agy', model: 'm-b', efforts: '', ...m}));
  f.step(m => setRole(f.home, {role: 'worker', runner: 'agy', model: 'm-a', ...m, ...noCodex}));
  f.step(m => setFavorites(f.home, {items: [{runner: 'agy', model: 'm-a'}], ...m}));
  const before = f.records.length;
  assert.throws(() => removeRunnerModel(f.home, {runner: 'agy', model: 'm-a', ...f.meta()}), /worker 값.*즐겨찾기 1번/);
  assert.throws(() => removeRunnerModel(f.home, {runner: 'codex', model: 'gpt-6-sol', ...f.meta()}), /목록 파일/);
  assert.throws(() => removeRunnerModel(f.home, {runner: 'agy', model: 'm-b', ...f.meta(), revision: 1}), /설정이 바뀌었다/);
  assert.equal(f.records.length, before);
  const next = f.step(m => removeRunnerModel(f.home, {runner: 'agy', model: 'm-b', ...m}));
  assert.deepEqual(next.runners.agy.models.map(m => m.model), ['m-a']);
  const last = f.records.at(-1);
  assert.equal(f.records.length, before + 1);
  assert.equal(last.action, 'model-remove');
  assert.deepEqual(last.before, {model: 'm-b', efforts: []});
  assert.equal(last.after, null);
});

test('모델 삭제: 대체 후보도 쓰는 곳으로 센다', () => {
  const f = fixture();
  f.step(m => setRunnerModel(f.home, {runner: 'agy', model: 'm-a', efforts: '', ...m}));
  f.step(m => setFallback(f.home, {role: 'worker', items: [{runner: 'agy', model: 'm-a'}], ...m, ...noCodex}));
  assert.throws(() => removeRunnerModel(f.home, {runner: 'agy', model: 'm-a', ...f.meta()}), /worker 대체 후보 1번/);
});

test('parseModelList: 첫 낱말만 읽고 규칙 밖 줄·중복은 버린다', () => {
  const out = 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nFetching available models...\n\n모델!\tx\ngemini-3.8-flash-medium\tdup\nb/c[1]\n';
  assert.deepEqual(parseModelList(out), [
    {model: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)'}, {model: 'Fetching', name: 'available models...'}, {model: 'b/c[1]', name: ''}]);
});

test('listModels 칸은 자리를 받지 않고, 칸이 없으면 목록을 불러오지 않는다', async () => {
  const f = fixture();
  assert.throws(() => setRunner(f.home, {runner: 'agy', table: {listModels: 'agy models {model}'}, ...f.meta()}), /자리/);
  await assert.rejects(() => listRunnerModels(f.home, 'agy'), /listModels 미지원/);
  await assert.rejects(() => listRunnerModels(f.home, 'codex'), /목록 파일/);
});

function withScript(f, body) {
  const script = path.join(f.home, 'list.sh');
  fs.writeFileSync(script, body, {mode: 0o700});
  f.step(m => setRunner(f.home, {runner: 'agy', table: {listModels: script}, ...m}));
  return script;
}

test('목록 불러오기: 가짜 명령 출력을 읽고, 설정·원장은 그대로이며, 등록 여부를 표시한다', async () => {
  const f = fixture();
  withScript(f, '#!/bin/sh\necho "Fetching available models..." >&2\nprintf "m-a\\tModel A\\nm-b\\tModel B\\n"\n');
  f.step(m => setRunnerModel(f.home, {runner: 'agy', model: 'm-a', efforts: '', ...m}));
  const settings = fs.readFileSync(path.join(f.home, 'runner-settings.json'), 'utf8'), n = f.records.length;
  const res = await listRunnerModels(f.home, 'agy');
  assert.deepEqual(res.models, [{model: 'm-a', name: 'Model A', registered: true}, {model: 'm-b', name: 'Model B', registered: false}]);
  assert.equal(fs.readFileSync(path.join(f.home, 'runner-settings.json'), 'utf8'), settings);
  assert.equal(f.records.length, n);
});

test('목록 불러오기: 시간 초과·출력 초과는 끝내고 남은 프로세스가 없다', async () => {
  const f = fixture();
  const marker = `kadan-list-${process.pid}-${Date.now()}`;
  withScript(f, `#!/bin/sh\n# ${marker}\nsleep 30 &\nwait\n`);
  await assert.rejects(() => listRunnerModels(f.home, 'agy', {timeoutMs: 400}), /안에 목록이 오지 않아/);
  withScript(f, `#!/bin/sh\n# ${marker}\nyes aaaaaaaaaa\n`);
  await assert.rejects(() => listRunnerModels(f.home, 'agy', {maxBytes: 2048}), /넘어 끝냈다/);
  await new Promise(r => setTimeout(r, 1200));
  const ps = spawnSync('ps', ['-axo', 'command']).stdout.toString();
  assert.equal(ps.split('\n').filter(l => l.includes(marker)).length, 0);
});

test('changedRunnerFields: 바뀐 칸만 남기고 없는 칸을 지우는 null은 버린다', () => {
  const before = {spawn: 'a {model}', exec: 'a exec {model}', conversation: {kind: 'open-file', pattern: '(x)'}};
  assert.equal(changedRunnerFields(before, {table: {exec: 'a exec {model}', version: null, conversation: {kind: 'open-file', pattern: '(x)'}}}), null);
  assert.deepEqual(changedRunnerFields(before, {spawn: 'b {model}', table: {exec: null, update: 'a up'}}), {spawn: 'b {model}', table: {exec: null, update: 'a up'}});
});

async function serve(home) {
  const center = createCenterHandler(home);
  const server = http.createServer((req, res) => center.handle(req, res, new URL(req.url, 'http://x')).then(h => { if (!h) { res.writeHead(404); res.end(); } }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, token = center.token) => fetch(base + p, {method: 'POST', headers: {Accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({...body, ...(token ? {token} : {})})});
  return {server, base, post, center};
}

test('화면 경로: 목록 불러오기는 토큰·POST일 때만 실행되고, 표 저장은 CLI와 같은 결과·같은 거절이다', async () => {
  const f = fixture(), counter = path.join(f.home, 'count');
  withScript(f, `#!/bin/sh\necho x >> "${counter}"\necho m-z\n`);
  const {server, base, post} = await serve(f.home);
  try {
    assert.equal((await fetch(base + '/runners/models-list')).status, 404);
    assert.equal((await post('/runners/models-list', {runner: 'agy'}, '')).status, 403);
    assert.equal(fs.existsSync(counter), false);
    const ok = await post('/runners/models-list', {runner: 'agy'});
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).result.models, [{model: 'm-z', name: '', registered: false}]);
    assert.equal(fs.readFileSync(counter, 'utf8'), 'x\n');

    // 화면 표 저장 == CLI(setRunner) 저장
    const cli = fixture();
    const table = {exec: 'agy -p {prompt}', version: 'agy --version'};
    setRunner(cli.home, {runner: 'agy', table, ...cli.meta()});
    const rev = readSettings(f.home).revision, n = readLedger(f.home).length;
    const saved = await post('/runners/runner', {runner: 'agy', table: JSON.stringify({...table, resume: null}), reason: '화면', revision: String(rev)});
    assert.equal(saved.status, 200, await saved.clone().text());
    const a = readSettings(f.home).runners.agy, b = readSettings(cli.home).runners.agy;
    assert.equal(a.exec, b.exec); assert.equal(a.version, b.version); assert.equal(a.resume, undefined);
    const event = readLedger(f.home).at(-1);
    assert.deepEqual(Object.keys(event.after).sort(), Object.keys(a).sort());
    assert.equal(readLedger(f.home).length, n + 1);

    // 잘못된 틀은 같은 메시지로 거절
    const cases = [{resume: 'agy --model {model} x'}, {exec: 'agy "{prompt}"'}, {version: 'agy {nope}'}, {conversation: {kind: 'bad'}}];
    for (const bad of cases) {
      let expected; try { setRunner(cli.home, {runner: 'agy', table: bad, ...cli.meta(), revision: readSettings(cli.home).revision}); } catch (e) { expected = e.message; }
      const res = await post('/runners/runner', {runner: 'agy', table: JSON.stringify(bad), reason: '나쁨', revision: String(readSettings(f.home).revision)});
      assert.equal(res.status, 409);
      assert.equal(await res.text(), expected);
    }
    // 바뀐 것이 없으면 거절(거짓 변경 없음)
    const same = await post('/runners/runner', {runner: 'agy', table: JSON.stringify({exec: 'agy -p {prompt}'}), reason: '같음', revision: String(readSettings(f.home).revision)});
    assert.equal(same.status, 409);
    // 모델 등록·삭제도 같은 경로
    let r = readSettings(f.home).revision;
    assert.equal((await post('/runners/model-add', {runner: 'agy', model: 'm-z', efforts: 'low', reason: '등록', revision: String(r)})).status, 200);
    r += 1;
    assert.equal((await post('/runners/model-remove', {runner: 'agy', model: 'm-z', reason: '삭제', revision: String(r)})).status, 200);
    assert.deepEqual(readSettings(f.home).runners.agy.models, []);
  } finally { server.close(); }
});
