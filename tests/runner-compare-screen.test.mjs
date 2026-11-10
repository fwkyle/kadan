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
import {appendStream} from '../src/storage.mjs';
import {compareReport} from '../src/compare-report.mjs';

test('비교 화면: CLI와 같은 검사·사건·보고서, 출처·토큰·버전 보호, 꺼진 뒤에도 조합별 성과', async () => {
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
    assert.equal(report.groups.length, 0, '예약만으로는 행을 만들지 않는다');
    assert.deepEqual(report.reservationsWithoutStart, ['A', 'B']);
    // 기본 기간(최근 14일)의 시작은 조회 시각에서 나오므로 함께 뺀다.
    const stripTime = ({asOf, since, ...rest}) => rest;
    assert.deepEqual(stripTime(report), stripTime(compareReport(home)));
    const cli = spawnSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname,
      'runners', 'report', '--json'], {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8'});
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(stripTime(report), stripTime(JSON.parse(cli.stdout)));
    assert.equal((await fetch(base + '/runners/compare-report?since=bad')).status, 409);
    assert.equal((await fetch(base + '/runners/compare-report?until=bad')).status, 409);
    assert.equal((await post({presets: '["B","A"]'})).status, 200);
    assert.deepEqual(readSettings(home).compare.presets, ['B', 'A']);
    assert.notEqual(readSettings(home).compare.enabledAt, epoch);
    assert.equal((await post({mode: 'off'})).status, 200);
    assert.equal(readSettings(home).compare.enabled, false);
    assert.deepEqual(readLedger(home).filter(e => e.kind === 'runner-settings').map(e => e.action),
      ['compare', 'compare', 'compare']);
    // 비교가 꺼진 뒤의 발령(예약·비교 표시 없음)도 결과 보기에 실제 조합 행으로 나온다.
    const fable = {runner: 'claude', model: 'claude-test', effort: 'medium'};
    const sol = {runner: 'codex', model: 'gpt-test', effort: 'high'};
    const send = (id, role, extra) => appendLedger({kind: 'send', taskId: id, executionKey: `test/${id}`,
      workKey: 'test/off', role, compareMode: false, pickId: null, settingsPreset: 'B', ...extra}, home);
    send('impl', 'test-off-worker', {runnerChoice: fable, launchSource: 'settings'});
    appendLedger({kind: 'done', taskId: 'impl', executionKey: 'test/impl', role: 'test-off-worker',
      result: 'ok'}, home);
    send('review', 'test-off-reviewer', {runnerChoice: sol, launchSource: 'review-for',
      reviewFor: {role: 'test-off-worker'}});
    appendLedger({kind: 'done', taskId: 'review', executionKey: 'test/review', role: 'test-off-reviewer',
      result: 'ok'}, home);
    appendStream(home, 'works/test/off/events.jsonl', {key: 'test/off', status: 'done', executions: [
      {key: 'test/impl', phase: 'implementation', round: 1}, {key: 'test/review', phase: 'review', round: 1}]});
    appendStream(home, 'cards/test/review/events.jsonl', {key: 'test/review', result: {outcome: 'pass'}});
    const off = await (await fetch(base + '/runners/compare-report')).json();
    assert.equal(off.groups.length, 1);
    assert.deepEqual(off.groups[0].reviewer, sol);
    const [row] = off.groups[0].rows;
    assert.deepEqual([row.worker, row.launch, row.presets, row.independentSamples, row.firstRoundPasses],
      [fable, null, ['B'], 1, 1]);
    assert.deepEqual(off.unknown, {count: 0, workIds: [], unlinkedCards: []});
    assert.ok(Date.parse(off.asOf) - Date.parse(off.since) <= 14 * 86400000);
    // 화면 코드가 읽는 칸 이름이 응답에 실제로 있다(옛 칸 이름으로 빈칸을 그리지 않게).
    const screen = fs.readFileSync(new URL('../gui/src/pages/CompareMode.tsx', import.meta.url), 'utf8');
    for (const key of [...screen.matchAll(/\brow\.(\w+)/g)].map(m => m[1])) assert.ok(key in row, `row.${key}`);
    for (const key of [...screen.matchAll(/\breport\.(\w+)/g)].map(m => m[1])) assert.ok(key in off, `report.${key}`);
    for (const key of [...screen.matchAll(/report\.unknown\.(\w+)/g)].map(m => m[1])) {
      assert.ok(key in off.unknown, `report.unknown.${key}`);
    }
    assert.match(screen, /<h3>조합별 성과<\/h3>/);
    assert.match(screen, /group\.reviewer \? `\$\{row\.firstRoundPasses\}\/\$\{row\.completedSamples\}` : '검수 없음'/);
    assert.doesNotMatch(screen, /비교 결과|혼합 군|제외 사유/);
  } finally {
    await new Promise(r => server.close(r));
    const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {encoding: 'utf8'});
    assert.equal(listeners.stdout.trim(), '');
    console.log(`검증 서버 종료: PID ${process.pid}, 127.0.0.1:${port}, LISTEN 없음`);
  }
});
