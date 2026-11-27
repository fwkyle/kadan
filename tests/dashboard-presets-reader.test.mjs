import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createWallServer} from '../src/wall.mjs';
import {createDashboardReaders} from '../src/commands/tree-wall.mjs';
import {createDashboardPresetsReader} from '../src/dashboard-presets-reader.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {appendStream, createDatabase, writeStorageMarker} from '../src/storage.mjs';

const SECRET_COMMAND = 'demo-launch --private-flag';
const seat = (runner, model, effort) => ({runner, model, ...(effort === undefined ? {} : {effort})});

function baseSettings() {
  return {
    version: 1, revision: 118, activePreset: 'B',
    runners: {demo: {spawn: `${SECRET_COMMAND} {model} {effort}`, models: []},
      plain: {spawn: `${SECRET_COMMAND} {model}`, models: []}},
    presets: {
      B: {label: '값싼 병렬판', roles: {
        conductor: seat('demo', 'conductor-1', 'high'), worker: seat('demo', 'worker-1', 'high'),
        'worker-hard': seat('demo', 'hard-1', 'high'), reviewer: seat('demo', 'reviewer-1', 'high'),
        watch: seat('demo', 'watch-1', 'max'), super: seat('demo', 'super-1', 'high'),
      }, fallback: {
        reviewer: [seat('demo', 'reviewer-2', 'high')], watch: [seat('demo', 'watch-2', 'max')],
        'worker-hard': [seat('demo', 'hard-2', 'high'), seat('plain', 'hard-3')], worker: [],
      }},
      'B-agy': {roles: {worker: seat('plain', 'worker-9'),
        reviewer: {...seat('demo', 'reviewer-9'), effort: null}}},
    },
  };
}

function writeSettings(home, value) {
  fs.writeFileSync(path.join(home, 'runner-settings.json'),
    typeof value === 'string' ? value : JSON.stringify(value));
}

function makeHome(settings = baseSettings()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-presets-'));
  createDatabase(home);
  writeStorageMarker(home, 'sqlite');
  if (settings) writeSettings(home, settings);
  return home;
}

// main의 WorkStore는 presetAuto를 쓰지 않고, 완료·없는 프리셋 상태도 만들기 번거로워 다음 판을 직접 붙인다.
function amend(home, key, fields) {
  const {history, ...latest} = new WorkStore(home).get(key);
  appendStream(home, `works/${key}/events.jsonl`,
    {...latest, ...fields, revision: latest.revision + 1, at: new Date().toISOString()});
}

function makeWork(home, id, owner, fields = {}) {
  new WorkStore(home).create({key: `demo/${id}`, title: `업무 ${id}`, goal: '목표', scope: '범위',
    acceptance: '조건', owner, repoPath: home});
  if (Object.keys(fields).length) amend(home, `demo/${id}`, fields);
}

const urlOf = (...sessions) => {
  const url = new URL('http://localhost/api/dashboard/presets');
  for (const session of sessions) url.searchParams.append('session', session);
  return url;
};
const worksOf = (result, session) => result.sessions.find(item => item.session === session).works;

async function serve(home, options = {}) {
  let collected = 0;
  const loader = () => {collected++;throw new Error('프리셋 조회가 화면 수집을 불렀음');};
  const server = createWallServer(loader, {home, warmAfterMs: 0, ...options});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = (target, {method = 'GET', headers = {}} = {}) => new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port, method, path: target,
      headers: {host: `127.0.0.1:${port}`, ...headers}}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error', reject);
    request.end();
  });
  return {call, collected: () => collected, close: () => server.close()};
}
const pathOf = (...sessions) => {
  const url = urlOf(...sessions);
  return url.pathname + url.search;
};

test('설정은 순서·활성 표시·네 자리와 대체 후보만 싣고 실행 명령은 싣지 않는다', () => {
  const home = makeHome();
  const result = createDashboardPresetsReader(home, {now: () => 0})(urlOf());
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    collectedAt: '1970-01-01T00:00:00.000Z',
    settings: {
      revision: 118, activePreset: 'B', compare: {enabled: false, presets: []},
      presets: [
        {name: 'B', label: '값싼 병렬판', active: true, roles: {
          conductor: seat('demo', 'conductor-1', 'high'), worker: seat('demo', 'worker-1', 'high'),
          'worker-hard': seat('demo', 'hard-1', 'high'),
          reviewer: seat('demo', 'reviewer-1', 'high'),
        }, fallback: {
          'worker-hard': [seat('demo', 'hard-2', 'high'), seat('plain', 'hard-3')],
          reviewer: [seat('demo', 'reviewer-2', 'high')],
        }},
        // 설명이 없으면 이름을 쓴다. 강도는 설정 값 그대로(없으면 생략, null이면 null).
        {name: 'B-agy', label: 'B-agy', active: false, roles: {
          conductor: null, worker: seat('plain', 'worker-9'), 'worker-hard': null,
          reviewer: {runner: 'demo', model: 'reviewer-9', effort: null},
        }, fallback: {}},
      ],
    },
    sessions: [],
  });
  assert.equal(JSON.stringify(result).includes(SECRET_COMMAND), false);
});

test('비교 설정은 켜짐과 목록 두 칸만 싣는다', () => {
  const home = makeHome({...baseSettings(), compare: {enabled: true, presets: ['B', 'B-agy'],
    enabledAt: new Date().toISOString(), epoch: 'e1'}});
  assert.deepEqual(createDashboardPresetsReader(home)(urlOf()).settings.compare,
    {enabled: true, presets: ['B', 'B-agy']});
});

test('세션 역할이 지금 책임진 열린 업무만 업무 키 순으로 준다', () => {
  const home = makeHome();
  const lead = 'kadan-서랍창구-감독';
  // 키 순서와 만든 순서를 다르게 둔다.
  makeWork(home, 'work-c', lead);
  makeWork(home, 'work-b', lead, {preset: 'B-agy', presetAuto: true});
  makeWork(home, 'work-a', lead, {preset: 'B', status: 'hold'});
  makeWork(home, 'work-done', lead, {preset: 'B', status: 'done'});
  makeWork(home, 'work-cancelled', lead, {preset: 'B', status: 'cancelled'});
  makeWork(home, 'work-moved', 'old-lead', {preset: 'gone'});
  makeWork(home, 'work-proto', 'new-lead', {preset: 'constructor', presetAuto: true});
  appendLedger({kind: 'handover', phase: 'transferred', from: 'old-lead', to: 'new-lead',
    handoverId: 'h1', taskIds: [], t: new Date(Date.now() + 1000).toISOString()}, home);

  const asked = [`kadan-${lead}`, 'kadan-new-lead', 'kadan-old-lead', 'kadan-idle',
    `kadan-${lead}`];
  const result = createDashboardPresetsReader(home)(urlOf(...asked));
  assert.deepEqual(result.sessions.map(item => [item.session, item.role]), [
    [`kadan-${lead}`, lead], ['kadan-new-lead', 'new-lead'], ['kadan-old-lead', 'old-lead'],
    ['kadan-idle', 'idle'],
  ]);
  const row = (id, status, preset, presetSource, presetMissing) =>
    ({key: `demo/${id}`, title: `업무 ${id}`, status, preset, presetSource, presetMissing});
  assert.deepEqual(worksOf(result, `kadan-${lead}`), [
    row('work-a', 'hold', 'B', 'explicit', false),
    row('work-b', 'open', 'B-agy', 'auto', false),
    row('work-c', 'open', null, 'default', false),
  ]);
  assert.deepEqual(worksOf(result, 'kadan-new-lead'), [
    row('work-moved', 'open', 'gone', 'explicit', true),
    row('work-proto', 'open', 'constructor', 'auto', true),
  ]);
  assert.deepEqual(worksOf(result, 'kadan-old-lead'), []);
  assert.deepEqual(worksOf(result, 'kadan-idle'), []);
});

test('규칙 밖 세션 이름은 그 칸만 오류이고 서버는 계속 답한다', async () => {
  const home = makeHome();
  makeWork(home, 'work-a', 'writer');
  const app = await serve(home);
  try {
    // 앞 네 개는 역할 이름에 남는 글자가 없어, 걸러내지 않으면 sessionName이 프로세스를 끝낸다.
    const bad = ['kadan-', 'kadan----', 'kadan-!!!', '', 'writer', 'kadan-a b', 'kadan- writer'];
    const response = await app.call(pathOf(...bad, 'kadan-writer'));
    assert.equal(response.status, 200);
    const {sessions} = JSON.parse(response.text);
    assert.deepEqual(sessions.slice(0, -1), bad.map(session =>
      ({session, role: null, works: [], error: '세션 이름 규칙 밖'})));
    assert.equal(sessions.at(-1).works.length, 1);
    assert.equal((await app.call(pathOf('kadan-writer'))).status, 200);
  } finally { app.close(); }
});

test('session은 64개까지 받고 65개는 400이다', async () => {
  const app = await serve(makeHome());
  try {
    const names = Array.from({length: 65}, (_, i) => `kadan-role-${i}`);
    const full = await app.call(pathOf(...names.slice(0, 64)));
    assert.equal(full.status, 200);
    assert.equal(JSON.parse(full.text).sessions.length, 64);
    const over = await app.call(pathOf(...names));
    assert.equal(over.status, 400);
    assert.match(over.text, /^session은 최대 64개/);
    // 상한은 중복을 합치기 전의 개수다.
    assert.equal((await app.call(pathOf(...Array(65).fill('kadan-role-0')))).status, 400);
  } finally { app.close(); }
});

test('설정 없음과 설정 읽기 실패를 구분하고 파일 내용은 오류에 싣지 않는다', () => {
  const home = makeHome(null);
  makeWork(home, 'work-a', 'writer', {preset: 'B'});
  makeWork(home, 'work-b', 'writer');
  const read = createDashboardPresetsReader(home);
  const absent = read(urlOf('kadan-writer'));
  assert.equal(absent.settings, null);
  assert.equal('settingsError' in absent, false);
  assert.deepEqual(absent.sessions[0].works.map(w => [w.presetSource, w.presetMissing]),
    [['explicit', true], ['default', false]]);

  for (const broken of [`{"spawn": ${SECRET_COMMAND}`,
    JSON.stringify({version: 1, revision: 1, activePreset: 'none', presets: {}, runners: {}}),
    JSON.stringify({...baseSettings(), presets: {...baseSettings().presets, empty: null}}),
    'null']) {
    writeSettings(home, broken);
    const damaged = read(urlOf('kadan-writer'));
    assert.equal(damaged.settings, null, broken);
    assert.ok(damaged.settingsError, broken);
    assert.equal(damaged.settingsError.includes('\n'), false);
    assert.equal(damaged.settingsError.includes('demo-launch'), false, damaged.settingsError);
    assert.deepEqual(damaged.sessions[0].works.map(w => [w.preset, w.presetMissing]),
      [['B', false], [null, false]]);
  }
});

test('kadan wall과 같은 읽기 연결은 화면 수집·업무 전체 읽기 없이 답하고 304를 준다', async t => {
  const home = makeHome();
  makeWork(home, 'work-a', 'writer', {preset: 'B'});
  const {loadPresets} = createDashboardReaders(home, {listSessions: () => []});
  const app = await serve(home, {loadPresets});
  for (const method of ['list', 'listLatest', 'get']) {
    t.mock.method(WorkStore.prototype, method, () => {throw new Error(`${method} 호출`);});
  }
  try {
    const target = pathOf('kadan-writer');
    const first = await app.call(target);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(first.headers['cache-control'], 'private, no-cache');
    const etag = first.headers.etag;
    assert.match(etag, /^W\//);
    await new Promise(resolve => setTimeout(resolve, 30));
    const again = await app.call(target, {headers: {'if-none-match': etag}});
    assert.equal(again.status, 304);
    assert.equal(again.text, '');
    assert.equal((await app.call(target + '&fresh=1', {headers: {'if-none-match': etag}})).status,
      200);

    // 상태가 바뀌면 같은 ETag로도 새 본문을 받는다.
    t.mock.restoreAll();
    amend(home, 'demo/work-a', {preset: 'B-agy'});
    const changed = await app.call(target, {headers: {'if-none-match': etag}});
    assert.equal(changed.status, 200);
    assert.equal(JSON.parse(changed.text).sessions[0].works[0].preset, 'B-agy');
    writeSettings(home, {...baseSettings(), revision: 119});
    const resaved = await app.call(target,
      {headers: {'if-none-match': changed.headers.etag}});
    assert.equal(JSON.parse(resaved.text).settings.revision, 119);
    // 미리 수집(warmAfterMs 0)도 걸리지 않는다.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(app.collected(), 0);
  } finally { app.close(); }
});

test('접근 규칙은 다른 읽기 GET과 같다', async () => {
  const app = await serve(makeHome());
  try {
    const target = pathOf();
    assert.equal((await app.call(target, {method: 'POST'})).status, 405);
    assert.equal((await app.call(target,
      {headers: {'sec-fetch-site': 'cross-site'}})).status, 403);
    assert.equal((await app.call(target,
      {headers: {origin: 'http://other.example'}})).status, 403);
    assert.equal((await app.call(target, {headers: {host: 'other.example'}})).status, 403);
    assert.equal((await app.call(target)).status, 200);
  } finally { app.close(); }
});

test('업무 이력이 손상되면 빈 목록이 아니라 503이다', async () => {
  const home = makeHome();
  appendStream(home, 'works/demo/broken/events.jsonl', {key: 'demo/broken', revision: 7});
  const app = await serve(home);
  try {
    const response = await app.call(pathOf('kadan-writer'));
    assert.equal(response.status, 503);
    assert.match(response.text, /^저장소 확인 불가: /);
  } finally { app.close(); }
});
