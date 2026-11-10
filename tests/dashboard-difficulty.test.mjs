// 난이도 칸 PR 3: 대시보드의 어려운 일 작업자 줄(설정 응답·화면 저장)과 카드 어려움 표시, 보류 카드의 난이도 변경(N1).
// 모델 이름은 모두 가짜. 설정·카드는 격리 홈에만 쓰고, 서버는 127.0.0.1 임시 포트로 띄워 시험이 닫는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWallServer} from '../src/wall.mjs';
import {DEFAULT_FAMILIES, readSettings} from '../src/runner-settings.mjs';
import {runnersData} from '../src/dashboard/settings.mjs';
import {RUNNER_ROLE_LABELS} from '../src/runner-settings-wall.mjs';
import {readLedger} from '../src/ledger.mjs';
import {CardStore} from '../src/card-store.mjs';
import {buildKanban} from '../src/dashboard-kanban.mjs';
import {dashboardFixture} from './helpers/dashboard-fixture.mjs';

// 화면 초안 시험(gui/tests/hard-slot.test.ts)과 같은 자료 파일. 저장 본문 글자는 그쪽이 "초안이 만든다"를, 이쪽이 "서버가 받아 이 설정이 된다"를 단언한다.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/difficulty-preset-save.json', import.meta.url), 'utf8'));
const MODELS = ['gpt-test', 'gpt-test2', 'gpt-hard', 'claude-test', 'claude-hard'];

function makeHome(which) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-difficulty-'));
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({version: 1, ...fixture.settings[which],
    families: DEFAULT_FAMILIES,
    runners: {codex: {spawn: 'codex --model {model}', models: MODELS.map(model => ({model, efforts: []}))}}}));
  return home;
}

async function withServer(home, run) {
  const server = createWallServer(() => ({center: null, entries: readLedger(home), tree: [], ledgerLines: 0,
    collectedAt: new Date()}), {home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = (fields) => fetch(base + '/runners/preset-save', {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, ...fields})});
    await run({post, base});
  } finally {
    await new Promise(r => server.close(r));
    const l = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
    assert.equal(l.stdout.trim(), '');
  }
}

for (const c of fixture.cases) {
  test(`화면 저장(고정 자료): ${c.name}`, async () => {
    const home = makeHome(c.from);
    await withServer(home, async ({post}) => {
      const response = await post(c.fields);
      assert.equal(response.status, 200, await response.clone().text());
    });
    const saved = readSettings(home);
    assert.equal(saved.revision, 4);
    assert.deepEqual(saved.presets.A.roles['worker-hard'] ?? null, c.expectHard);
    assert.equal(Object.hasOwn(saved.presets.A.roles, 'worker-hard'), c.expectHard !== null, '빈 값 키를 남기지 않는다');
    assert.equal(saved.presets.A.fallback?.['worker-hard'], undefined);
    // 가져오기 코드가 빈 fallback 객체를 덧붙이는 것은 기존 동작이다. 그 밖의 칸은 본문 그대로다.
    const {fallback, ...rest} = saved.presets.A;
    assert.deepEqual(fallback ?? {}, {});
    assert.deepEqual(rest, JSON.parse(c.fields.value));
  });
}

test('화면 저장: 검수자와 같은 계열 값은 거절되고 설정 파일·revision·원장이 그대로다', async () => {
  const home = makeHome('empty');
  const file = path.join(home, 'runner-settings.json'), before = fs.readFileSync(file);
  const value = JSON.parse(fixture.cases[2].fields.value);
  value.roles['worker-hard'] = {runner: 'codex', model: 'claude-hard'}; // 검수자(claude-test)와 같은 계열
  await withServer(home, async ({post}) => {
    const response = await post({...fixture.cases[2].fields, value: JSON.stringify(value)});
    assert.equal(response.status, 409);
    assert.match(await response.text(), /같은 계열|계열/);
  });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(readSettings(home).revision, 3); assert.equal(readLedger(home).length, 0);
});

test('설정 응답: 이름표는 작업자 다음에 어려운 일 작업자가 오고, 명령은 값이 있을 때만 채운다', () => {
  assert.deepEqual(Object.keys(RUNNER_ROLE_LABELS).slice(0, 3), ['worker', 'worker-hard', 'reviewer']);
  assert.equal(RUNNER_ROLE_LABELS['worker-hard'], '어려운 일 작업자');
  const url = new URL('http://local/api/dashboard/runners');
  const empty = runnersData({home: makeHome('empty'), entries: []}, url, {});
  assert.equal(empty.roles['worker-hard'], '어려운 일 작업자');
  assert.equal('worker-hard' in empty.commands, false, '빈 자리는 명령을 만들지 않는다');
  assert.equal(empty.settings.presets.A.roles['worker-hard'], undefined);
  const filled = runnersData({home: makeHome('filled'), entries: []}, url, {});
  assert.match(filled.commands['worker-hard'], /^codex --model gpt-hard\b/);
  assert.equal(filled.commands.worker, empty.commands.worker, '다른 역할의 명령은 달라지지 않는다');
});

test('설정 파일이 없어도 응답 모양은 그대로(이름표만 한 줄 늘었다)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-difficulty-none-'));
  const data = runnersData({home, entries: []}, new URL('http://local/api/dashboard/runners'), {});
  assert.equal(data.settings, null); assert.equal(data.roles['worker-hard'], '어려운 일 작업자');
});

// 사전을 쓰는 곳 점검(화면 쪽 사용처는 gui/tests/hard-slot-render.test.ts): 옛 설정 화면은 PROFILE_ROLES를 돌아 어려운 일 줄이 생기지 않고,
// 이름표는 변경 기록의 역할 이름에만 쓰인다.
test('옛 설정 화면: 사전에 키를 더해도 편집 칸·요약 줄이 늘지 않고, 변경 기록은 새 이름표를 읽는다', async () => {
  const {renderRunnerSettings} = await import('../src/runner-settings-wall.mjs');
  const home = makeHome('filled');
  const html = renderRunnerSettings({home, token: 't', entries: [{kind: 'runner-settings', action: 'set', role: 'worker-hard', preset: 'A', t: new Date().toISOString(), by: '시험', revision: 3, reason: '시험', before: null, after: {runner: 'codex', model: 'gpt-hard'}}]});
  assert.equal((html.match(/class="rs-edit"/g) ?? []).length, 4, '편집 칸은 작업자·검수자·일반감독·슈퍼감독 4개 그대로');
  assert.equal(html.includes('data-rs-open="worker-hard"'), false);
  assert.match(html, /A 어려운 일 작업자/, '변경 기록은 새 이름표로 읽힌다');
});

test('카드 행: 어려움 카드만 difficulty가 실리고 워크·상세·칸반 응답에 나타나며, 현황 응답에는 싣지 않는다', async (t) => {
  const f = dashboardFixture({mode: 'sqlite', count: 3});
  t.after(() => f.server.close());
  const hard = f.cards.get('demo/card-1');
  f.cards.update(hard.key, {difficulty: 'hard'}, {revision: hard.revision, note: '어려운 일'});
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + f.server.address().port + '/api/dashboard/';
  const get = async route => { const r = await fetch(base + route); assert.equal(r.status, 200, route); return r.json(); };
  const work = await get('workspace?collection=executions&state=all');
  const byKey = Object.fromEntries(work.rows.map(r => [r.key, r]));
  assert.equal(byKey['demo/card-1'].difficulty, 'hard');
  // 칸이 없는 카드: 기존 관례대로 모든 행 칸이 있고 값이 없으면 null이다(이 칸 하나만 달라진다).
  assert.equal(byKey['demo/card-2'].difficulty, null);
  assert.equal('difficulty' in byKey['demo/card-3'], true);
  const detail = await get('detail?card=demo/card-1');
  assert.equal(detail.row.difficulty, 'hard');
  assert.equal((await get('detail?card=demo/card-2')).row.difficulty ?? null, null);
  const kanban = await get('kanban?group=owner');
  const marks = Object.fromEntries(kanban.boards.flatMap(b => b.lines.flatMap(l => l.cards)).map(c => [c.key, c.marks.map(m => m.label)]));
  assert.ok(marks['demo/card-1'].includes('어려움'));
  assert.equal(marks['demo/card-2'].includes('어려움'), false);
  const status = await get('status');
  for (const row of [...(status.rows ?? []), ...(status.works ?? [])]) assert.equal('difficulty' in row, false, '현황 응답은 이 칸이 필요 없다');
});

test('칸반 표시: hard 행에만 어려움 표시가 붙고 다른 표시 뒤에 온다', () => {
  const now = Date.parse('2026-11-10T12:00:00Z'), at = new Date(now - 60000).toISOString();
  const row = (key, extra = {}) => ({key, title: key, owner: '작업자', repo: 'r', state: 'hold', bucket: 'hold', signalAt: at, at, ...extra});
  const result = buildKanban({rows: [row('r/a', {difficulty: 'hard'}), row('r/b')], hierarchy: {작업자: '감독A', 감독A: '@user'}, now});
  const cards = Object.fromEntries(result.boards.flatMap(b => b.lines.flatMap(l => l.cards)).map(c => [c.key, c.marks.map(m => m.label)]));
  assert.deepEqual(cards['r/a'], ['일시정지', '어려움']);
  assert.deepEqual(cards['r/b'], ['일시정지']);
  const all = Object.fromEntries(result.boards.flatMap(b => b.lines.flatMap(l => l.cards)).map(c => [c.key, c]));
  assert.equal(all['r/a'].difficulty, 'hard');
  assert.equal(Object.hasOwn(all['r/b'], 'difficulty'), false, '보통 카드에는 키가 없다');
});

test('N1: 보류(archived) 카드의 난이도는 바꿀 수 있고, done·cancelled·superseded는 여전히 거절한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-difficulty-n1-'));
  const store = new CardStore(home);
  const rally = {rallyId: 'rally', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'implementation'};
  const make = id => {
    const card = store.create({repo: 'r', id, repoPath: home, body: '# 카드'});
    return store.update(card.key, {status: 'assigned', role: 'r', board: 'r', scope: '범위', ...rally}, {revision: card.revision, note: '배정'});
  };
  const archive = card => store.update(card.key, {status: 'archived'}, {revision: card.revision, note: '보류'});
  // 보류 카드: hard/normal 변경이 된다.
  let held = archive(make('n1a'));
  held = store.update(held.key, {difficulty: 'hard'}, {revision: held.revision, note: '어려움으로'});
  assert.equal([held.status, held.difficulty].join('/'), 'archived/hard');
  held = store.update(held.key, {difficulty: 'normal'}, {revision: held.revision, note: '보통으로'});
  assert.equal(held.difficulty, undefined);
  // 보류에서 빠져나오며 난이도를 함께 바꾸는 경우: 현재 상태가 보류이므로 한 번에 된다.
  held = archive(make('n1b'));
  const back = store.update(held.key, {status: 'assigned', difficulty: 'hard'}, {revision: held.revision, note: '되살리며 어려움'});
  assert.equal([back.status, back.difficulty].join('/'), 'assigned/hard');
  // 닫힌 셋은 거절한다.
  for (const status of ['done', 'cancelled', 'superseded']) {
    const card = make('n1-' + status);
    const closed = store.update(card.key, {status, ...(status === 'superseded' ? {replacedByText: '다른 카드'} : {})}, {revision: card.revision, note: '닫음'});
    assert.throws(() => store.update(closed.key, {difficulty: 'hard'}, {revision: closed.revision, note: '시도'}), /닫힌 카드/, status);
  }
});
