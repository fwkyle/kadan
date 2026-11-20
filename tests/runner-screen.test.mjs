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
