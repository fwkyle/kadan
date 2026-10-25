// 실행 모델 화면 PR3: 프리셋 만들기·이름 바꾸기·삭제·내보내기·가져오기 서버 경로. 격리 홈·127.0.0.1 임시 포트만 쓴다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWallServer} from '../src/wall.mjs';
import {DEFAULT_FAMILIES, readSettings} from '../src/runner-settings.mjs';
import {exportPreset, MAX_UPLOAD_BYTES} from '../src/runner-export.mjs';
import {readLedger} from '../src/ledger.mjs';

const choice = model => ({runner: 'codex', model});
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-screen-'));
  const preset = {label: '시험', roles: {worker: choice('gpt-test'), reviewer: choice('claude-test')}};
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({version: 1, revision: 1,
    activePreset: 'A', families: DEFAULT_FAMILIES,
    runners: {codex: {spawn: 'codex --model {model}',
      models: ['gpt-test', 'claude-test'].map(model => ({model, efforts: []}))}},
    presets: {A: preset, B: {roles: {worker: choice('gpt-test'), reviewer: choice('claude-test')}}}}));
  return home;
}

async function withServer(home, run) {
  const server = createWallServer(() => ({center: null, entries: readLedger(home), tree: [],
    ledgerLines: 0, collectedAt: new Date()}), {home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = (route, fields = {}, origin = base) => fetch(base + route, {
      method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin},
      body: new URLSearchParams({token, reason: '시험', ...fields}),
    });
    await run({post, token, base});
  } finally {
    await new Promise(r => server.close(r));
    const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
    assert.equal(listeners.stdout.trim(), '');
    console.log(`검증 서버 종료: PID ${process.pid}, 127.0.0.1:${port}, lsof LISTEN 없음`);
  }
}
const revisionOf = home => String(readSettings(home).revision);
const actions = home => readLedger(home).filter(e => e.kind === 'runner-settings').map(e => e.action);

test('만들기·이름 바꾸기·삭제: CLI와 같은 거절 규칙과 원장 사건', async () => {
  const home = fixture();
  await withServer(home, async ({post}) => {
    const fail = async (route, fields, pattern) => {
      const before = fs.readFileSync(path.join(home, 'runner-settings.json')), n = readLedger(home).length;
      const res = await post(route, {revision: revisionOf(home), ...fields});
      assert.equal(res.status, 409, route);
      assert.match(await res.text(), pattern);
      assert.deepEqual(fs.readFileSync(path.join(home, 'runner-settings.json')), before);
      assert.equal(readLedger(home).length, n);
    };
    await fail('/runners/preset-add', {preset: 'add'}, /쓸 수 없다/);
    await fail('/runners/preset-add', {preset: '__proto__'}, /쓸 수 없다/);
    await fail('/runners/preset-add', {preset: 'B'}, /이미 있는 프리셋/);
    await fail('/runners/preset-add', {preset: 'C', from: 'nope'}, /복사할 프리셋이 없다/);
    await fail('/runners/preset-add', {preset: 'C', reason: ''}, /이유/);
    await fail('/runners/preset-add', {preset: 'C', revision: '99'}, /설정이 바뀌었다/);
    await fail('/runners/preset-remove', {preset: 'A'}, /활성 프리셋은 지울 수 없다/);
    await fail('/runners/preset-rename', {from: 'nope', preset: 'Z'}, /없는 프리셋/);
    await fail('/runners/preset-rename', {from: 'A', preset: 'B'}, /이미 있는 프리셋/);
    assert.equal((await post('/runners/preset-add', {preset: 'C', revision: revisionOf(home)})).status, 200);
    assert.deepEqual(Object.keys(readSettings(home).presets), ['A', 'B', 'C']);
    assert.equal(readSettings(home).presets.C.label, 'A 복사');
    assert.equal(readSettings(home).activePreset, 'A', '만들어도 활성은 그대로');
    assert.equal((await post('/runners/preset-rename', {from: 'C', preset: 'D', revision: revisionOf(home)})).status, 200);
    assert.equal((await post('/runners/preset-rename', {from: 'A', preset: 'AA', revision: revisionOf(home)})).status, 200);
    assert.equal(readSettings(home).activePreset, 'AA', '활성 이름 바꾸기는 활성도 따라간다');
    assert.equal((await post('/runners/preset-remove', {preset: 'D', revision: revisionOf(home)})).status, 200);
    assert.deepEqual(Object.keys(readSettings(home).presets), ['AA', 'B']);
    assert.deepEqual(actions(home), ['preset-add', 'preset-rename', 'preset-rename', 'preset-remove']);
  });
});

test('내보내기: CLI export와 같은 내용(createdAt만 다름), 읽기만 하고 토큰이 필요하다', async () => {
  const home = fixture();
  await withServer(home, async ({post}) => {
    const settingsBefore = fs.readFileSync(path.join(home, 'runner-settings.json'));
    const res = await post('/runners/preset-export', {preset: 'A'});
    assert.equal(res.status, 200);
    const {result} = await res.json();
    assert.equal(result.filename, 'kadan-preset-A.json');
    const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
    const out = spawnSync(process.execPath, [cli, 'runners', 'export', 'A'], {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8'});
    assert.equal(out.status, 0, out.stderr);
    const strip = ({createdAt, ...rest}) => rest;
    assert.deepEqual(strip(JSON.parse(result.text)), strip(JSON.parse(out.stdout)));
    assert.deepEqual(strip(JSON.parse(result.text)), strip(exportPreset(home, {name: 'A'})));
    assert.equal((await post('/runners/preset-export', {preset: 'nope'})).status, 409);
    assert.equal((await post('/runners/preset-export', {preset: 'A', token: ''})).status, 403);
    assert.deepEqual(fs.readFileSync(path.join(home, 'runner-settings.json')), settingsBefore);
    assert.equal(readLedger(home).length, 0);
  });
});

test('가져오기: 거절 사례는 부분 적용 없이 닫히고, 덮어쓰기는 명시일 때만, 자동 활성화 없음', async () => {
  const home = fixture();
  await withServer(home, async ({post}) => {
    const good = () => JSON.parse(JSON.stringify(exportPreset(home, {name: 'A'})));
    const send = (data, fields = {}) => post('/runners/preset-import', {
      file: typeof data === 'string' ? data : JSON.stringify(data), revision: revisionOf(home), ...fields});
    const rejected = async (data, pattern, fields) => {
      const before = fs.readFileSync(path.join(home, 'runner-settings.json')), n = readLedger(home).length;
      const res = await send(data, fields);
      assert.equal(res.status, 409);
      assert.match(await res.text(), pattern);
      assert.deepEqual(fs.readFileSync(path.join(home, 'runner-settings.json')), before, '설정 불변');
      assert.equal(readLedger(home).length, n, '원장 불변');
    };
    const unknownModel = good(); unknownModel.preset.roles.worker.model = 'ghost-model';
    await rejected(unknownModel, /등록되지 않은 모델: codex\/ghost-model/, {as: 'X'});
    const sameFamily = good(); sameFamily.preset.roles.reviewer = choice('gpt-test');
    await rejected(sameFamily, /같은 계열/, {as: 'X'});
    await rejected(good(), /이미 있는 프리셋: A/);
    await rejected(good(), /덮어쓸 프리셋이 없다/, {as: 'nope', replace: '1'});
    const leaked = good(); leaked.preset.label = ['', 'Users', 'x'].join('/');
    await rejected(leaked, /개인정보 꼴/, {as: 'X'});
    await rejected('{"format":', /JSON이 아니다/, {as: 'X'});
    await rejected({format: 'x', version: 1}, /가져올 수 없는 파일/, {as: 'X'});
    await rejected('x'.repeat(MAX_UPLOAD_BYTES + 1), /너무 크다/, {as: 'X'});
    const reserved = good(); reserved.preset.name = 'add';
    await rejected(reserved, /쓸 수 없다: \(파일의 preset\.name\)/);
    await rejected(good(), /값이 올바르지 않다/, {as: 'X', replace: 'yes'});
    assert.equal((await post('/runners/preset-import', {revision: revisionOf(home)})).status, 409, '파일 없음');
    assert.equal((await send(good(), {as: 'X', revision: '99'})).status, 409, '옛 revision');
    // 차단 모델
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'runner-settings.json'), 'utf8'));
    settings.blocked = [{model: 'claude-test', reason: '시험 차단'}];
    fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
    await rejected(good(), /막은 모델이 있다/, {as: 'X'});
    settings.blocked = []; fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
    // 성공: 새 이름으로 더하고 활성은 그대로
    const ok = await send(good(), {as: 'X'});
    assert.equal(ok.status, 200, await ok.clone().text());
    const body = (await ok.json()).result;
    assert.equal(body.imported, 'X'); assert.match(body.next, /활성 프리셋은 그대로/);
    assert.equal(readSettings(home).activePreset, 'A');
    assert.deepEqual(readSettings(home).presets.X.roles, readSettings(home).presets.A.roles);
    // 같은 이름 덮어쓰기는 replace=1일 때만
    const changed = good(); changed.preset.roles.worker = choice('claude-test'); changed.preset.roles.reviewer = choice('gpt-test');
    await rejected(changed, /이미 있는 프리셋: X/, {as: 'X'});
    assert.equal((await send(changed, {as: 'X', replace: '1'})).status, 200);
    assert.equal(readSettings(home).presets.X.roles.worker.model, 'claude-test');
    assert.equal(readSettings(home).presets.A.roles.worker.model, 'gpt-test', '다른 프리셋 불변');
    assert.deepEqual(actions(home), ['preset-import', 'preset-import']);
  });
});
