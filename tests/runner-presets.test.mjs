// 기본 프리셋(설치 감지)과 프리셋 관리(add·rename·remove). 격리 홈·가짜 감지·가짜 codex 목록만 쓰고 실제 CLI는 부르지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPreset, explainChain, initSettings, launchFor, readSettings, removePreset, renamePreset, setActivePreset, setFallback, setRole, setRunnerModel, watchJudgeChain,
} from '../src/runner-settings.mjs';
import {seniorCommand} from '../src/senior.mjs';
import {runnersCommand} from '../src/runners-command.mjs';

const example = new URL('../skills/kadan-conductor/references/agent-runners.example.json', import.meta.url).pathname;
// 시험용 이름은 지어낸 것이다. 기본 프리셋은 목록의 이름을 그대로 옮길 뿐 이름을 알지 못한다.
const levels = names => names.map(effort => ({effort}));
const fakeModels = [
  {slug: 'fake-hidden-1', visibility: 'hide', default_reasoning_level: 'low', supported_reasoning_levels: levels(['low'])},
  {slug: 'fake-model-1', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: levels(['low', 'medium', 'high'])},
  {slug: 'fake-model-2', visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: levels(['low'])},
];

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-presets-'));
  fs.copyFileSync(example, path.join(dir, 'agent-runners.json'));
  return dir;
}
const records = () => { const list = []; return {list, record: e => list.push(e)}; };
function init(installed, readCodexModels = () => ({models: fakeModels})) {
  const dir = home(), {list, record} = records(), notes = [];
  const value = initSettings(dir, {by: 'kyle', reason: '시험', record, detect: {installed, readCodexModels, notes}});
  return {dir, list, value, notes, roles: value.presets['기본'].roles};
}
const noCache = () => { throw new Error('ENOENT'); };
const meta = (revision, extra = {}) => ({revision, by: 'kyle', reason: '시험', record: () => {}, ...extra});

test('기본 프리셋: codex만 — 목록의 첫 보이는 모델로 작업자·일반감독·슈퍼감독을 채우고 검수자는 비운다', () => {
  const r = init(['codex']);
  assert.deepEqual(Object.keys(r.value.runners), ['codex']);
  const expected = {runner: 'codex', model: 'fake-model-1', effort: 'medium'};
  assert.deepEqual(r.roles, {worker: expected, conductor: expected, super: expected});
  assert.equal(r.roles.reviewer, undefined);
  assert.ok(r.notes.some(n => /검수자/.test(n)));
  assert.ok(!r.notes.some(n => /claude/.test(n)));
  assert.match(launchFor(r.value, 'worker').cmd, /--model fake-model-1 .*model_reasoning_effort="medium"/);
});

test('기본 프리셋: claude만 — 실행기만 등록하고 역할은 모두 비우며 runners model 안내를 낸다', () => {
  const r = init(['claude']);
  assert.deepEqual(Object.keys(r.value.runners), ['claude']);
  assert.deepEqual(r.roles, {});
  assert.ok(r.notes.some(n => /runners model claude/.test(n)));
  assert.ok(r.notes.some(n => /검수자/.test(n)));
});

test('기본 프리셋: 둘 다 — codex 역할만 채우고 claude는 비우며 안내한다', () => {
  const r = init(['codex', 'claude']);
  assert.deepEqual(Object.keys(r.value.runners).sort(), ['claude', 'codex']);
  assert.deepEqual(Object.keys(r.roles).sort(), ['conductor', 'super', 'worker']);
  assert.ok(r.notes.some(n => /runners model claude/.test(n)));
});

test('기본 프리셋: 둘 다 없음 — 거절하고 설정 파일을 만들지 않는다', () => {
  const dir = home(), {list, record} = records();
  assert.throws(() => initSettings(dir, {by: 'kyle', reason: '시험', record, detect: {installed: [], notes: []}}), /PATH에서 찾지 못했다/);
  assert.equal(fs.existsSync(path.join(dir, 'runner-settings.json')), false);
  assert.equal(list.length, 0);
});

test('기본 프리셋: codex는 있는데 모델 목록이 없으면 등록만 하고 역할은 비우며 이름을 지어 넣지 않는다', () => {
  const r = init(['codex'], noCache);
  assert.deepEqual(Object.keys(r.value.runners), ['codex']);
  assert.deepEqual(r.roles, {});
  assert.ok(r.notes.some(n => /모델 목록/.test(n) && /runners set worker/.test(n)));
  // 보이는 모델이 하나도 없는 목록도 같다.
  const hiddenOnly = init(['codex'], () => ({models: [fakeModels[0]]}));
  assert.deepEqual(hiddenOnly.roles, {});
  assert.ok(hiddenOnly.notes.some(n => /고를 수 있는 모델이 없다/.test(n)));
});

test('기본 프리셋: 감지 대상이 아닌 실행기는 파일에 적힌 대로 등록한다', () => {
  const dir = home();
  fs.writeFileSync(path.join(dir, 'agent-runners.json'), JSON.stringify({runners: [
    {id: 'codex', spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'},
    {id: 'other-tool', spawn: 'other-tool --model {model}'},
    {id: 'claude-code', spawn: 'claude --model {model} --effort {effort}'},
  ]}));
  const value = initSettings(dir, {by: 'kyle', reason: '시험', record: () => {}, detect: {installed: ['codex'], readCodexModels: () => ({models: fakeModels}), notes: []}});
  assert.deepEqual(Object.keys(value.runners).sort(), ['codex', 'other-tool']);
});

test('이미 설정이 있는 홈(프리셋 B)에 init하면 거절하고 파일은 그대로다', () => {
  const dir = home();
  initSettings(dir, {by: 'kyle', reason: '시작', record: () => {}});
  addPreset(dir, {name: 'B', ...meta(1)});
  setActivePreset(dir, {preset: 'B', ...meta(2)});
  const file = path.join(dir, 'runner-settings.json');
  const before = fs.readFileSync(file);
  const {list, record} = records();
  assert.throws(() => initSettings(dir, {by: 'kyle', reason: '다시', record, detect: {installed: ['codex'], readCodexModels: () => ({models: fakeModels}), notes: []}}), /이미 있다/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(list.length, 0);
  assert.equal(readSettings(dir).activePreset, 'B');
});

test('절반만 채운 프리셋(검수자 없음)은 계열 검사가 받아 주어 다른 변경도 저장된다', () => {
  const r = init(['codex']);
  const next = addPreset(r.dir, {name: 'copy1', ...meta(1)});
  assert.equal(next.revision, 2);
  assert.equal(next.presets.copy1.roles.reviewer, undefined);
});

test('CLI: runners init은 감지 함수를 쓰고 안내(notes)를 함께 돌려준다', () => {
  const dir = home(), {record} = records();
  const prev = process.env.KADAN_CODEX_MODELS_CACHE;
  const cache = path.join(dir, 'models_cache.json');
  fs.writeFileSync(cache, JSON.stringify({models: fakeModels}));
  process.env.KADAN_CODEX_MODELS_CACHE = cache;
  try {
    const out = runnersCommand(['init'], {reason: '시험'}, {home: dir, by: 'kyle', record, detect: () => ['codex']});
    assert.equal(out.presets['기본'].roles.worker.model, 'fake-model-1');
    assert.ok(Array.isArray(out.notes) && out.notes.length > 0);
  } finally { if (prev === undefined) delete process.env.KADAN_CODEX_MODELS_CACHE; else process.env.KADAN_CODEX_MODELS_CACHE = prev; }
});

test('공개 잠금: init이 만드는 프리셋·실행기에는 개인 경로·계정·비공개 공급자 접두어가 없다', () => {
  const r = init(['codex', 'claude']);
  // families(계열 규칙표)는 DEFAULT_FAMILIES의 몫이라 범위 밖이다. 기본 프리셋과 실행기 틀만 본다.
  const text = JSON.stringify({presets: r.value.presets, runners: r.value.runners, blocked: r.value.blocked});
  for (const bad of [['', 'Users', ''].join('/'), '~/', '$HOME', os.homedir(), 'zai/', 'xai/', 'kimi/', 'command-code/', 'google/', 'anthropic/', 'openai-codex/'])
    assert.ok(!text.includes(bad), `기본값에 ${bad}가 있다`);
  // 역할 값의 모델은 모두 (가짜) 목록에서 온 이름이다.
  const known = new Set(fakeModels.map(m => m.slug));
  for (const value of Object.values(r.roles)) assert.ok(known.has(value.model));
});

test('preset add: 활성 프리셋을 복사해 새 프리셋을 만들고 활성은 그대로, revision·원장이 한 줄 늘어난다', () => {
  const r = init(['codex']);
  const {list, record} = records();
  const next = addPreset(r.dir, {name: 'fast', ...meta(1, {record})});
  assert.equal(next.revision, 2);
  assert.equal(next.activePreset, '기본');
  assert.deepEqual(next.presets.fast.roles, next.presets['기본'].roles);
  assert.equal(next.presets.fast.label, '기본 복사');
  next.presets.fast.roles.worker.model = 'changed';
  assert.equal(readSettings(r.dir).presets.fast.roles.worker.model, 'fake-model-1', '복사는 깊은 복사다');
  assert.equal(list.length, 1);
  assert.deepEqual({action: list[0].action, preset: list[0].preset, from: list[0].from, revision: list[0].revision}, {action: 'preset-add', preset: 'fast', from: '기본', revision: 2});
  // --from으로 다른 원본을 고른다.
  addPreset(r.dir, {name: 'fast2', from: 'fast', ...meta(2)});
  assert.equal(readSettings(r.dir).presets.fast2.label, 'fast 복사');
});

test('preset add 반례: 이름 규칙 위반·이미 있는 이름·예약어·없는 원본·이유 없음·옛 revision', () => {
  const r = init(['codex']);
  for (const name of ['빠 름', 'a b', '', undefined, 'x;y', 'x$y', '빠름!', 'ㅂㅏ', '$(x)한글']) assert.throws(() => addPreset(r.dir, {name, ...meta(1)}), /영문·한글·숫자/, String(name));
  assert.throws(() => addPreset(r.dir, {name: '기본', ...meta(1)}), /이미 있는/);
  addPreset(r.dir, {name: 'one', ...meta(1)});
  assert.throws(() => addPreset(r.dir, {name: 'one', ...meta(2)}), /이미 있는/);
  for (const name of ['add', 'rename', 'remove']) assert.throws(() => addPreset(r.dir, {name, ...meta(2)}), /쓸 수 없다/);
  assert.throws(() => addPreset(r.dir, {name: 'two', from: 'nope', ...meta(2)}), /복사할 프리셋이 없다/);
  assert.throws(() => addPreset(r.dir, {name: 'two', ...meta(2, {reason: ' '})}), /이유/);
  assert.throws(() => addPreset(r.dir, {name: 'two', ...meta(1)}), /다시 읽고/);
  assert.equal(readSettings(r.dir).revision, 2, '실패한 시도는 저장되지 않는다');
});

test('preset rename: 이름을 바꾸고 활성 프리셋이면 활성 이름도 따라간다. 반례는 거절한다', () => {
  const r = init(['codex']);
  const {list, record} = records();
  addPreset(r.dir, {name: 'one', ...meta(1)});
  const renamed = renamePreset(r.dir, {from: 'one', to: 'two', ...meta(2, {record})});
  assert.deepEqual(Object.keys(renamed.presets), ['기본', 'two']);
  assert.equal(renamed.revision, 3);
  assert.deepEqual({action: list[0].action, before: list[0].before, after: list[0].after}, {action: 'preset-rename', before: 'one', after: 'two'});
  const active = renamePreset(r.dir, {from: '기본', to: 'main', ...meta(3)});
  assert.equal(active.activePreset, 'main');
  assert.ok(launchFor(active, 'worker'), '이름이 바뀐 활성 프리셋으로 계속 읽힌다');
  assert.throws(() => renamePreset(r.dir, {from: 'nope', to: 'x', ...meta(4)}), /없는 프리셋/);
  assert.throws(() => renamePreset(r.dir, {from: 'two', to: 'main', ...meta(4)}), /이미 있는/);
  assert.throws(() => renamePreset(r.dir, {from: 'two', to: '빠 름', ...meta(4)}), /영문·한글·숫자/);
  assert.throws(() => renamePreset(r.dir, {from: 'two', to: 'remove', ...meta(4)}), /쓸 수 없다/);
});

test('preset remove: 활성이 아닌 프리셋을 지우고 원장에 지운 내용을 남긴다. 활성·없는 이름은 거절한다', () => {
  const r = init(['codex']);
  const {list, record} = records();
  addPreset(r.dir, {name: 'one', ...meta(1)});
  assert.throws(() => removePreset(r.dir, {name: '기본', ...meta(2)}), /활성 프리셋은 지울 수 없다/);
  assert.throws(() => removePreset(r.dir, {name: 'nope', ...meta(2)}), /없는 프리셋/);
  const next = removePreset(r.dir, {name: 'one', ...meta(2, {record})});
  assert.deepEqual(Object.keys(next.presets), ['기본']);
  assert.equal(next.revision, 3);
  assert.equal(list[0].action, 'preset-remove');
  assert.equal(list[0].before.roles.worker.model, 'fake-model-1');
  assert.equal(list[0].after, null);
});

test('CLI 꼴: preset add·rename·remove와 기존 preset <이름> 전환이 함께 동작한다', () => {
  const r = init(['codex']);
  const run = (argv, flags) => runnersCommand(argv, {reason: '시험', ...flags}, {home: r.dir, by: 'kyle', record: () => {}});
  assert.equal(run(['preset', 'add', 'one'], {revision: 1}).presets.one.label, '기본 복사');
  assert.ok(run(['preset', 'add', 'two'], {revision: 2, from: 'one'}).presets.two);
  assert.ok(run(['preset', 'rename', 'two', 'three'], {revision: 3}).presets.three);
  assert.equal(run(['preset', 'one'], {revision: 4}).activePreset, 'one');
  assert.equal(run(['preset', 'remove', '기본'], {revision: 5}).presets['기본'], undefined);
  assert.throws(() => run(['preset', 'remove', 'one'], {revision: 6}), /활성 프리셋은 지울 수 없다/);
});

test('set --preset <없던 이름>은 지금도 프리셋을 만든다(tests/runner-settings-wall.test.mjs가 기대는 동작이라 유지)', () => {
  const r = init(['codex']);
  const next = setRole(r.dir, {role: 'worker', runner: 'codex', model: 'fake-model-2', effort: 'low', preset: 'auto', readCodexModels: () => ({models: fakeModels}), ...meta(1)});
  assert.equal(next.presets.auto.roles.worker.model, 'fake-model-2');
});

test('비워 둔 감시 AI·시니어·설명 AI는 조용히 깨지지 않는다: 감시는 프로필 모델, 시니어는 분명한 오류, 설명은 꺼짐', async () => {
  const r = init(['codex']);
  // 감시 AI: 순서가 없으면 null이고, watch-ai.mjs가 [null]로 한 번 부른다(judgeSource: 'profile', 감시 프로필의 KADAN_JUDGE_MODEL).
  assert.equal(watchJudgeChain(r.value), null);
  // 설명 AI: 순서가 없으면 null이고, 설명기는 아무것도 하지 않는다.
  assert.equal(explainChain(r.value), null);
  // 시니어: 외부 호출·증거 폴더 전에 설정 없음 오류로 끝난다.
  const calls = [];
  await assert.rejects(
    seniorCommand(['kadan/none'], {question: '질문'}, {home: r.dir, by: 'x-슈퍼감독', readSettings: () => r.value, spawn: () => { calls.push('spawn'); }}),
    /시니어 모델 설정 없음 — kadan runners set senior/);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(r.dir, 'advice')), false);
});

test('예약 이름(__proto__·constructor·prototype·add·rename·remove)은 add·rename·숨은 생성 모두 거절하고 revision·원장·파일이 그대로다', () => {
  const r = init(['codex']);
  const file = path.join(r.dir, 'runner-settings.json');
  const before = fs.readFileSync(file);
  const {list, record} = records();
  const options = {readCodexModels: () => ({models: fakeModels})};
  const names = ['__proto__', 'constructor', 'prototype', 'add', 'rename', 'remove'];
  for (const name of names) {
    assert.throws(() => addPreset(r.dir, {name, ...meta(1, {record})}), /쓸 수 없다/, `add ${name}`);
    assert.throws(() => renamePreset(r.dir, {from: '기본', to: name, ...meta(1, {record})}), /쓸 수 없다/, `rename ${name}`);
    assert.throws(() => setRole(r.dir, {role: 'worker', runner: 'codex', model: 'fake-model-1', effort: 'low', preset: name, ...options, ...meta(1, {record})}), /쓸 수 없다/, `set ${name}`);
  }
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(list.length, 0);
  assert.equal(readSettings(r.dir).revision, 1);
  // CLI 꼴도 같다.
  assert.throws(() => runnersCommand(['preset', 'add', '__proto__'], {reason: '시험', revision: 1}, {home: r.dir, by: 'kyle', record}), /쓸 수 없다/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('이미 있는 프리셋에 쓰는 동작과 --preset A 자동 생성은 그대로다', () => {
  const r = init(['codex']);
  const options = {readCodexModels: () => ({models: fakeModels})};
  const set = (preset, revision) => setRole(r.dir, {role: 'worker', runner: 'codex', model: 'fake-model-2', effort: 'low', preset, ...options, ...meta(revision)});
  assert.equal(set('A', 1).presets.A.roles.worker.model, 'fake-model-2');
  assert.equal(set('A', 2).revision, 3, '이미 있는 이름은 다시 써도 거절하지 않는다');
  assert.equal(set('기본', 3).presets['기본'].roles.worker.model, 'fake-model-2');
});

test('없는 프리셋 이름(constructor 등)으로 폴백을 바꾸면 상속된 칸이 아니라 없는 프리셋으로 거절한다', () => {
  const r = init(['codex']);
  assert.throws(() => setFallback(r.dir, {role: 'worker', items: [], preset: 'constructor', ...meta(1)}), /없는 프리셋/);
});

test('한글 프리셋 이름: add·rename·활성 전환이 되고 원장 줄에 한글이 그대로 남는다', () => {
  const r = init(['codex']), {list, record} = records();
  addPreset(r.dir, {name: '팀용', ...meta(1, {record})});
  assert.equal(list[0].preset, '팀용');
  renamePreset(r.dir, {from: '기본', to: '개인용', ...meta(2, {record})});
  assert.equal(readSettings(r.dir).activePreset, '개인용');
  setActivePreset(r.dir, {preset: '팀용', ...meta(3, {record})});
  assert.equal(list[2].after, '팀용');
  assert.ok(JSON.parse(JSON.stringify(list[1])).after === '개인용');
  assert.throws(() => renamePreset(r.dir, {from: '팀용', to: '__proto__', ...meta(4)}), /쓸 수 없다/);
});

test('실행기·모델·강도 이름은 한글을 계속 거절한다(NAME_PATTERN 회귀)', () => {
  const r = init(['codex', 'claude']);
  assert.throws(() => setRunnerModel(r.dir, {runner: 'claude', model: '모델', efforts: 'low', ...meta(1)}), /모델 이름 필요/);
  assert.throws(() => setRunnerModel(r.dir, {runner: 'claude', model: 'fake-c', efforts: '낮음', ...meta(1)}), /강도 목록/);
  assert.throws(() => setRole(r.dir, {role: 'worker', runner: '코덱스', model: 'fake-model-1', effort: 'low', ...meta(1)}), /영문·숫자/);
});
