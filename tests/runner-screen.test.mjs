// 대시보드 실행 모델 설정 화면이 쓰는 서버 쪽 값: 발령 명령 팝업 재료, 줄 고치기(제자리 교체) 저장 왕복.
// 모델 이름은 모두 가짜다. 설정·원장은 격리 홈에만 쓴다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_FAMILIES, readSettings} from '../src/runner-settings.mjs';
import {runnersCommand} from '../src/runners-command.mjs';
import {runnersData} from '../src/dashboard/settings.mjs';
import {seniorCommandLabel} from '../src/senior.mjs';

const choice = (model, effort = 'high') => ({runner: 'codex', model, effort});
const MODELS = ['gpt-norm', 'gpt-a', 'gpt-b', 'gpt-c', 'gpt-d', 'claude-rev'];

// 검수자 대체 후보 3개, 시니어 2명(codex 한 명 + 강도를 받지 않는 agy 한 명), 감시 AI 대체 후보 1개.
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-runner-screen-'));
  const settings = {version: 1, revision: 1, activePreset: 'A', families: DEFAULT_FAMILIES,
    runners: {
      codex: {spawn: 'codex --model {model} --effort {effort}', models: MODELS.map(model => ({model, efforts: ['low', 'high']}))},
      agy: {spawn: 'agy --model {model}', models: [{model: 'gem-x-high', efforts: []}, {model: 'gem-x-low', efforts: []}]},
    },
    presets: {A: {
      roles: {worker: choice('gpt-norm'), reviewer: choice('claude-rev'), watch: choice('gpt-a'),
        senior: [choice('gpt-a'), {runner: 'agy', model: 'gem-x-high'}]},
      fallback: {reviewer: [choice('gpt-a'), choice('gpt-b'), choice('gpt-c')], watch: [choice('gpt-b')]},
    }}};
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
  return {home, record: () => {}};
}

test('발령 명령 팝업 재료: 대체 후보 명령은 kadan runners show와 같은 값이고 시니어는 한 명씩 줄로 온다', () => {
  const f = makeHome();
  const data = runnersData({home: f.home, entries: []}, new URL('http://127.0.0.1/'), {});
  const shown = runnersCommand(['show'], {}, f);
  assert.deepEqual(Object.keys(data.fallbackCommands).sort(), ['reviewer', 'watch']);
  for (const role of ['reviewer', 'watch'])
    assert.deepEqual(data.fallbackCommands[role], shown.fallback[role].map(item => item.cmd));
  assert.equal(data.fallbackCommands.reviewer.length, 3);
  assert.match(data.fallbackCommands.reviewer[1], /^codex --model gpt-b --effort high/);
  assert.match(data.fallbackCommands.watch[0], /^KADAN_JUDGE_MODEL=gpt-b /);
  // 시니어: 줄 목록을 ' + '로 이으면 표·show의 한 줄 글과 같다. agy 줄에는 senior.sh·max가 없다.
  assert.equal(data.seniorCommands.length, 2);
  assert.equal(data.seniorCommands.join(' + '), seniorCommandLabel(readSettings(f.home).presets.A.roles.senior));
  assert.equal(data.seniorCommands.join(' + '), data.commands.senior);
  assert.equal(shown.launch.senior, data.commands.senior);
  assert.match(data.seniorCommands[0], /senior\.sh \(codex exec/);
  assert.doesNotMatch(data.seniorCommands[1], /senior\.sh|max|exec/);
});

// 화면의 줄 고치기는 초안의 N번 자리만 바꾼 프리셋 한 벌을 /runners/preset-save로 한 번 보낸다(새 서버 경로 없음).
// 대체 후보 줄에 cmd는 저장되지 않는다 — runners show가 조회 때 runner/model/effort로 만든다. 그래서 고친 뒤에도 둘은 같은 값이다.
test('줄 고치기 저장 왕복: 2번만 바뀌고 1·3번은 그대로, show의 cmd가 고친 값과 일치하며, 옛 revision·중복·없는 강도는 거절되고 파일은 그대로다', async () => {
  const f = makeHome();
  const {createWallServer} = await import('../src/wall.mjs');
  const {readLedger} = await import('../src/ledger.mjs');
  const server = createWallServer(() => ({center: null, entries: readLedger(f.home), tree: [],
    ledgerLines: 0, collectedAt: new Date()}), {home: f.home, cacheSec: 0});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(f.home, 'runner-settings.json');
  try {
    const token = (await (await fetch(base)).text()).match(/name="token" value="([a-f0-9]+)"/)[1];
    const post = (preset, revision = readSettings(f.home).revision) => fetch(base + '/runners/preset-save', {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: base},
      body: new URLSearchParams({token, preset: 'A', value: JSON.stringify(preset), reason: '줄 고치기', revision: String(revision)})});
    // 화면 초안과 같은 조작: 검수자 대체 후보 2번 자리의 값만 바꾼다.
    const edited = structuredClone(readSettings(f.home).presets.A);
    edited.fallback.reviewer[1] = choice('gpt-d', 'low');
    const ok = await post(edited);
    assert.equal(ok.status, 200);
    const saved = readSettings(f.home);
    assert.equal(saved.revision, 2, '쓰기는 한 번');
    assert.deepEqual(saved.presets.A.fallback.reviewer, [choice('gpt-a'), choice('gpt-d', 'low'), choice('gpt-c')]);
    assert.deepEqual(saved.presets.A.fallback.watch, [choice('gpt-b')], '다른 역할 목록은 그대로');
    const shown = runnersCommand(['show'], {}, f).fallback.reviewer;
    assert.deepEqual(shown.map(({cmd, ...item}) => item), [choice('gpt-a'), choice('gpt-d', 'low'), choice('gpt-c')]);
    assert.equal(shown[1].cmd.startsWith('codex --model gpt-d --effort low'), true, shown[1].cmd);
    assert.equal(shown[0].cmd.startsWith('codex --model gpt-a --effort high'), true);
    assert.equal(shown[2].cmd.startsWith('codex --model gpt-c --effort high'), true);
    assert.equal(Object.hasOwn(saved.presets.A.fallback.reviewer[1], 'cmd'), false, 'cmd는 설정 파일에 저장하지 않는다');

    // 시니어(가득 찬 2명)도 같은 길로 한 자리만 고친다.
    const seniors = structuredClone(saved.presets.A);
    seniors.roles.senior[1] = {runner: 'agy', model: 'gem-x-low'};
    assert.equal((await post(seniors)).status, 200);
    assert.deepEqual(readSettings(f.home).presets.A.roles.senior, [choice('gpt-a'), {runner: 'agy', model: 'gem-x-low'}]);

    // 리비전 충돌: 옛 revision으로 보내면 409, 파일은 글자 그대로다.
    const before = fs.readFileSync(file, 'utf8');
    const stale = structuredClone(readSettings(f.home).presets.A);
    stale.fallback.reviewer[0] = choice('gpt-norm');
    const refused = await post(stale, readSettings(f.home).revision - 1);
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /^설정이 바뀌었다/, '화면이 이 글로 리비전 거절을 알아본다');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    // 실패하면 줄이 그대로 남는다: 다른 줄과 같은 값(중복)·모델이 지원하지 않는 강도·시니어 실행기+모델 중복.
    const dup = structuredClone(readSettings(f.home).presets.A); dup.fallback.reviewer[1] = choice('gpt-a');
    const badEffort = structuredClone(readSettings(f.home).presets.A); badEffort.fallback.reviewer[1] = choice('gpt-d', 'max');
    const dupSenior = structuredClone(readSettings(f.home).presets.A); dupSenior.roles.senior[1] = choice('gpt-a', 'low');
    for (const preset of [dup, badEffort, dupSenior]) assert.equal((await post(preset)).status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), before, '거절된 저장은 파일을 바꾸지 않는다');
  } finally {
    await new Promise(r => server.close(r));
  }
});
