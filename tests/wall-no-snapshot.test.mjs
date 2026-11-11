import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createWallServer} from '../src/wall.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {initSettings, setRole} from '../src/runner-settings.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {createRunnerSettingsHistory} from '../src/runner-settings-history.mjs';
import {wallCache} from '../src/wall-snapshot-cache.mjs';
import {TEAM, AUD, EMAIL, HOST, makeKey, sign} from './helpers/access-jwt-fixture.mjs';

// PR-A: runners·create·decisions는 공유 수집 없이 답하고, 수집을 쓰지 않는 조회는 미리 수집을 걸지 않는다.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-nosnap-cache-'));
process.env.KADAN_CODEX_MODELS_CACHE = path.join(cacheDir, 'models_cache.json');
fs.writeFileSync(process.env.KADAN_CODEX_MODELS_CACHE, JSON.stringify({models: [
  {slug: 'gpt-6-sol', supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({effort}))},
  {slug: 'gpt-6-astra', supported_reasoning_levels: ['low', 'medium'].map(effort => ({effort}))}]}));

const emptySnapshot = () => ({center: null, centerError: null, collectedAt: new Date().toISOString(), entries: [], ledgerLines: 0, error: null, resources: null, tree: []});
const start = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sqliteHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-nosnap-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite'); process.env.KADAN_HOME = home; wallCache.clear();
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex -p lite --model {model} -c model_reasoning_effort="{effort}"'}]}));
  return home;
};
const record = home => entry => appendLedger(entry, home);
// 설정을 만들고 runner-settings 사건을 count건(init 포함) 쌓는다.
function seedSettings(home, count) {
  initSettings(home, {by: 'kyle', reason: '시작', record: record(home)});
  for (let revision = 1; revision < count; revision++) {
    setRole(home, {role: 'worker', runner: 'codex', model: revision % 2 ? 'gpt-6-sol' : 'gpt-6-astra', effort: 'low', revision, by: 'kyle', reason: '변경 ' + revision, record: record(home)});
  }
}
// 이전 방식(공유 수집에서 거른 entries)으로 같은 화면을 만든다. 수집 시각만 다르다.
const oldWay = (home, url, extra = {}) => dashboardData({home, collectedAt: 'T', runtime: null, entries: readLedger(home), error: null, centerError: null, ...extra}, new URL('http://x' + url));
const same = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'collectedAt' ? undefined : v));
const getJson = async (base, url) => { const r = await fetch(base + url); return {status: r.status, headers: r.headers, body: JSON.parse(await r.text())}; };
const never = counter => () => { counter.n++; throw new Error('공유 수집을 부르면 안 된다'); };

test('runners·create·decisions는 공유 수집을 부르지 않고 1초 안에 200으로 답한다', async () => {
  const home = sqliteHome(); const loads = {n: 0};
  const server = createWallServer(never(loads), {home, cacheSec: 10, warmAfterMs: 20, gui: true});
  const base = await start(server);
  try {
    for (const url of ['/api/dashboard/runners', '/api/dashboard/create?kind=work', '/api/dashboard/decisions', '/api/dashboard/decisions?past=1&page=1', '/api/dashboard/decisions?id=none']) {
      const t0 = Date.now(); const r = await getJson(base, url);
      assert.equal(r.status, 200, url); assert.ok(Date.now() - t0 < 1000, url);
      assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
    await wait(150);
    assert.equal(loads.n, 0, '세 주소는 공유 수집을 한 번도 부르지 않고 미리 수집도 걸지 않는다');
  } finally { server.close(); }
});

test('전후 본문이 같다: 설정 없음·설정 있음(변경 이력 10건 초과)·결정 목록·한 건·지난 결정', async () => {
  for (const events of [0, 14]) {
    const home = sqliteHome(); if (events) seedSettings(home, events);
    const decisions = new DecisionStore(home).list();
    const server = createWallServer(never({n: 0}), {home, cacheSec: 10, gui: true});
    const base = await start(server);
    try {
      for (const url of ['/api/dashboard/runners', '/api/dashboard/create?kind=work', '/api/dashboard/create?kind=card', '/api/dashboard/decisions', '/api/dashboard/decisions?past=1&page=1', '/api/dashboard/decisions?id=none']) {
        const r = await getJson(base, url);
        const extra = url.includes('decisions') ? {decisions, decisionError: null} : {};
        assert.deepEqual(same(r.body), same(oldWay(home, url, extra)), `${events}건 ${url}`);
      }
      if (events) {
        const body = (await getJson(base, '/api/dashboard/runners')).body;
        assert.equal(body.history.length, 10, '변경 이력은 최근 10건');
        assert.ok(body.history.every(e => e.kind === 'runner-settings' && !('_ledgerOrder' in e)));
        assert.ok(body.history[0].revision > body.history.at(-1).revision, '최근 것이 앞');
      }
    } finally { server.close(); }
  }
});

test('변경 이력은 다른 프로세스가 쓴 새 사건도 다음 호출에 보이고 처음 10건과 이어 읽은 결과가 전체 읽기와 같다', () => {
  const home = sqliteHome(); seedSettings(home, 12);
  const read = createRunnerSettingsHistory(home);
  const expected = () => readLedger(home).filter(e => e.kind === 'runner-settings').slice(-10);
  assert.deepEqual(read(), expected());
  assert.deepEqual(read(), expected(), '바뀐 게 없을 때 같은 결과');
  setRole(home, {role: 'worker', runner: 'codex', model: 'gpt-6-sol', effort: 'high', revision: 12, by: 'kyle', reason: '새 사건', record: record(home)});
  appendLedger({kind: 'alert', alertKind: 'x', level: 'info', by: 'watch'}, home); // 종류가 다른 사건은 섞이지 않는다
  assert.deepEqual(read(), expected());
  assert.equal(read().at(-1).reason, '새 사건');
  assert.deepEqual(createRunnerSettingsHistory(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-nosnap-none-')))(), [], '저장소가 없는 홈은 빈 목록');
});

test('decisions 읽기 오류는 지금과 같은 decisionError 모양으로 돌려준다', async () => {
  const home = sqliteHome();
  const original = DecisionStore.prototype.list;
  DecisionStore.prototype.list = function () { throw new Error('결정 기록 손상 시험'); };
  const server = createWallServer(never({n: 0}), {home, cacheSec: 10, gui: true});
  const base = await start(server);
  try {
    // 이전 방식: 수집 쪽이 decisionError를 싣고 decisionsData가 그 메시지로 던지면 서버 바깥 catch가 503 글로 돌려줬다. 지금도 같은 상태코드·글·헤더다.
    assert.throws(() => oldWay(home, '/api/dashboard/decisions', {decisions: [], decisionError: '결정 기록 손상 시험'}), /결정 기록 손상 시험/);
    const r = await fetch(base + '/api/dashboard/decisions');
    assert.equal(r.status, 503);
    assert.equal(await r.text(), '저장소 확인 불가: 결정 기록 손상 시험');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  } finally { DecisionStore.prototype.list = original; server.close(); }
});

test('수집을 쓰지 않는 조회는 미리 수집을 걸지 않고, 공유 수집으로 답하는 조회는 적중이어도 건다', async () => {
  const home = sqliteHome(); let loads = 0;
  const server = createWallServer(() => { loads++; return emptySnapshot(); }, {home, cacheSec: 10, warmAfterMs: 40, gui: true});
  const base = await start(server);
  try {
    for (const url of ['/runners/compare', '/runners/compare-report', '/api/autopilot/repos', '/api/operations-flow', '/api/dashboard/runners', '/api/dashboard/create', '/api/dashboard/decisions']) {
      await (await fetch(base + url)).text();
    }
    await wait(250);
    assert.equal(loads, 0, '수집을 쓰지 않는 조회는 미리 수집을 걸지 않는다');
    await (await fetch(base + '/api/cards')).text(); assert.equal(loads, 1);
    for (let i = 0; i < 50 && loads < 2; i++) await wait(20);
    assert.equal(loads, 2, '공유 수집으로 답하는 조회는 미리 수집을 건다');
  } finally { server.close(); }
});

test('응답 캐시 적중도 미리 수집을 다시 건다(공유 수집으로 나온 응답)', async () => {
  const home = sqliteHome(); let loads = 0;
  const server = createWallServer(() => { loads++; return emptySnapshot(); }, {home, cacheSec: 10, warmAfterMs: 300, gui: true});
  const base = await start(server);
  try {
    await (await fetch(base + '/api/cards')).text(); assert.equal(loads, 1);
    await wait(150);
    const hit = await fetch(base + '/api/cards'); await hit.text(); assert.equal(hit.headers.get('x-kadan-cache'), 'hit');
    await wait(200); // 처음 예약(300ms)이었다면 이미 돌았을 시각. 적중이 다시 걸었으면 아직이다.
    assert.equal(loads, 1, '적중이 예약을 다시 걸어 아직 돌지 않았다');
    for (let i = 0; i < 40 && loads < 2; i++) await wait(25);
    assert.equal(loads, 2);
  } finally { server.close(); }
});

test('?fresh=1은 세 주소에서도 응답 캐시와 공유 수집을 비우고, fresh 없는 조회는 비우지 않는다', async () => {
  const home = sqliteHome(); let loads = 0;
  const server = createWallServer(() => { loads++; return emptySnapshot(); }, {home, cacheSec: 30, warmAfterMs: 3_600_000, gui: true});
  const base = await start(server);
  try {
    await (await fetch(base + '/api/cards')).text(); assert.equal(loads, 1);
    await (await fetch(base + '/api/dashboard/runners')).text();
    await (await fetch(base + '/api/cards')).text(); assert.equal(loads, 1, 'fresh 없는 runners는 수집을 비우지 않는다');
    for (const url of ['/api/dashboard/runners?fresh=1', '/api/dashboard/create?fresh=1', '/api/dashboard/decisions?fresh=1']) {
      await (await fetch(base + '/api/cards')).text();
      const before = loads;
      await (await fetch(base + url)).text();
      await (await fetch(base + '/api/cards')).text();
      assert.equal(loads, before + 1, url + ' 뒤 다음 수집 조회는 새로 읽는다');
    }
  } finally { server.close(); }
});

test('원격·교차 출처 판정은 세 주소에서 그대로다(POST 405, 교차 사이트 403, 원격 설정 꺼짐이면 외부 Host 403)', async () => {
  const home = sqliteHome();
  const server = createWallServer(never({n: 0}), {home, cacheSec: 0, gui: true});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = (method, url, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path: url, headers: {host: `127.0.0.1:${port}`, ...headers}}, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  try {
    for (const url of ['/api/dashboard/runners', '/api/dashboard/create', '/api/dashboard/decisions']) {
      assert.equal(await call('POST', url), 405, url + ' POST');
      assert.equal(await call('GET', url, {'sec-fetch-site': 'cross-site'}), 403, url + ' 교차 사이트');
      assert.equal(await call('GET', url, {origin: 'https://evil.example'}), 403, url + ' 다른 출처');
      assert.equal(await call('GET', url, {host: HOST}), 403, url + ' 외부 Host(원격 꺼짐)');
      assert.equal(await call('GET', url), 200, url);
    }
  } finally { server.close(); }
});

test('원격이 켜진 서버에서 세 주소는 Access 토큰 없는 외부 Host를 거부한다', async () => {
  const key = makeKey();
  const certs = http.createServer((request, response) => { response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({keys: [key.jwk]})); });
  await new Promise(resolve => certs.listen(0, '127.0.0.1', resolve));
  const home = sqliteHome();
  const server = createWallServer(never({n: 0}), {home, cacheSec: 0, gui: true, remote: {host: HOST, team: TEAM, aud: AUD, email: EMAIL},
    remoteOptions: {certsUrl: `http://127.0.0.1:${certs.address().port}/cdn-cgi/access/certs`}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = (url, headers) => new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: url, headers}, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  try {
    for (const url of ['/api/dashboard/runners', '/api/dashboard/create', '/api/dashboard/decisions']) {
      assert.notEqual(await call(url, {host: HOST}), 200, url + ' 토큰 없는 외부 Host');
      assert.equal(await call(url, {host: HOST, 'cf-access-jwt-assertion': sign(key)}), 200, url + ' 유효한 토큰');
    }
  } finally { server.close(); certs.close(); }
});
