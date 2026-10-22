// 프리셋 내보내기·가져오기(PR1b). 격리 홈 두 개·가짜 실행기·가짜 codex 목록만 쓰고 실제 CLI·모델은 부르지 않는다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPreset, initSettings, readSettings, renamePreset, setFallback, setRole, setRunnerModel, setFavorites,
} from '../src/runner-settings.mjs';
import {exportPreset, findPrivate, importPreset} from '../src/runner-export.mjs';
import {runnersCommand} from '../src/runners-command.mjs';

const example = new URL('../skills/kadan-conductor/references/agent-runners.example.json', import.meta.url).pathname;
const levels = names => names.map(effort => ({effort}));
// 시험용 이름은 지어낸 것이다.
const fakeModels = [
  {slug: 'fake-model-1', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: levels(['low', 'medium', 'high'])},
];
const readCodexModels = () => ({models: fakeModels});
const privateText = {
  users: ['', 'Users', 'x'].join('/'), home: ['', 'home', 'x'].join('/'), tilde: '~/notes',
  email: 'someone@example.test', token: ['sk', '-', 'abcdefghij1234567890klmn'].join(''),
};

const records = () => { const list = []; return {list, record: e => list.push(e)}; };
const meta = (revision, extra = {}) => ({revision, by: 'kyle', reason: '시험', record: () => {}, readCodexModels, ...extra});
const ledgerOf = dir => path.join(dir, 'runner-settings.json');
const patch = (dir, fn) => {
  const value = JSON.parse(fs.readFileSync(ledgerOf(dir), 'utf8'));
  fn(value);
  fs.writeFileSync(ledgerOf(dir), JSON.stringify(value, null, 2) + '\n');
};

// 홈 만들기. claudeModels: claude에 등록할 모델 {모델: [강도]}, null이면 claude 실행기를 등록하지 않는다.
function makeHome(claudeModels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-export-'));
  fs.copyFileSync(example, path.join(dir, 'agent-runners.json'));
  initSettings(dir, {by: 'kyle', reason: '시험', record: () => {}, detect: {installed: claudeModels ? ['codex', 'claude'] : ['codex'], readCodexModels, notes: []}});
  let revision = 1;
  for (const [model, efforts] of Object.entries(claudeModels ?? {}))
    setRunnerModel(dir, {runner: 'claude', model, efforts: efforts.join(','), ...meta(revision++)});
  return {dir, revision: () => readSettings(dir).revision};
}

// 홈 A: 작업자 codex, 검수자 claude(low), 작업자 대체 후보 claude(high), 일반감독 대체 후보 claude 둘째 모델.
function sender() {
  const a = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  setRole(a.dir, {role: 'reviewer', runner: 'claude', model: 'fake-claude-1', effort: 'low', ...meta(a.revision())});
  setFallback(a.dir, {role: 'worker', items: [{runner: 'claude', model: 'fake-claude-1', effort: 'high'}], ...meta(a.revision())});
  setFallback(a.dir, {role: 'conductor', items: [{runner: 'claude', model: 'fake-claude-2', effort: 'medium'}], ...meta(a.revision())});
  return a;
}
const exported = () => JSON.parse(JSON.stringify(exportPreset(sender().dir, {name: '기본'})));

// 거절은 설정 파일·revision·원장이 그대로여야 한다.
function assertRejected(dir, data, pattern, extra = {}) {
  const before = fs.readFileSync(ledgerOf(dir)), {list, record} = records();
  assert.throws(() => importPreset(dir, {data, ...meta(readSettings(dir).revision, {record}), ...extra}), pattern);
  assert.deepEqual(fs.readFileSync(ledgerOf(dir)), before);
  assert.equal(list.length, 0);
}
const messageOf = (dir, data, extra = {}) => {
  try { importPreset(dir, {data, ...meta(readSettings(dir).revision), ...extra}); } catch (error) { return error.message; }
  return assert.fail('거절되어야 한다');
};

test('왕복: 홈 A에서 내보낸 프리셋이 같은 실행기·모델·강도를 등록한 홈 B에 그대로 더해지고 활성 프리셋·전역 규칙은 그대로다', () => {
  const a = sender(), b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  const data = JSON.parse(JSON.stringify(exportPreset(a.dir, {name: '기본'})));
  const beforeB = readSettings(b.dir), {list, record} = records();
  const result = importPreset(b.dir, {data, as: 'team', ...meta(beforeB.revision, {record})});
  const after = readSettings(b.dir), source = readSettings(a.dir).presets['기본'];
  assert.deepEqual(after.presets.team, {label: source.label, roles: source.roles, fallback: source.fallback});
  assert.equal(after.activePreset, beforeB.activePreset);
  assert.equal(after.revision, beforeB.revision + 1);
  for (const key of ['runners', 'families', 'blocked', 'favorites']) assert.deepEqual(after[key], beforeB[key], `${key}가 바뀌었다`);
  assert.deepEqual(Object.keys(after.presets), [...Object.keys(beforeB.presets), 'team']);
  assert.equal(list.length, 1);
  assert.equal(list[0].action, 'preset-import');
  assert.equal(list[0].preset, 'team');
  assert.equal(result.imported, 'team');
  assert.equal(result.activePreset, beforeB.activePreset);
  assert.equal(result.differences.identical, true);
});

test('내보낸 파일: 형식 머리·프리셋·쓰는 실행기 이름만 있고 명령 틀·revision·즐겨찾기·conversation·경로는 없다', () => {
  const a = sender();
  setFavorites(a.dir, {items: [{runner: 'claude', model: 'fake-claude-1', effort: 'low'}], ...meta(a.revision())});
  const data = exportPreset(a.dir, {name: '기본', now: () => new Date('2026-01-02T03:04:05Z')});
  assert.equal(data.format, 'kadan-runner-export');
  assert.equal(data.version, 1);
  assert.equal(data.createdAt, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(Object.keys(data.preset), ['name', 'label', 'roles', 'fallback']);
  assert.deepEqual(data.runners, ['codex', 'claude']);
  const text = JSON.stringify(data);
  for (const bad of ['spawn', 'revision', 'favorites', 'conversation', 'resume', '{model}', os.homedir()]) assert.ok(!text.includes(bad), `파일에 ${bad}가 있다`);
});

test('export는 설정 파일과 원장을 바꾸지 않는다', () => {
  const a = sender(), before = fs.readFileSync(ledgerOf(a.dir)), {list, record} = records();
  exportPreset(a.dir, {name: '기본'});
  runnersCommand(['export', '기본'], {}, {home: a.dir, by: 'kyle', record});
  assert.deepEqual(fs.readFileSync(ledgerOf(a.dir)), before);
  assert.equal(list.length, 0);
});

test('export: 없는 프리셋은 거절한다', () => {
  assert.throws(() => exportPreset(sender().dir, {name: 'nope'}), /없는 프리셋/);
  assert.throws(() => exportPreset(sender().dir, {name: '__proto__'}), /없는 프리셋/);
});

for (const [kind, text] of Object.entries(privateText)) {
  test(`export 개인정보 검사: label에 ${kind}가 있으면 파일을 만들지 않고 칸 이름만 알린다(값은 출력하지 않는다)`, () => {
    const a = sender(), out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-out-')), 'preset.json');
    patch(a.dir, v => { v.presets['기본'].label = `내 설정 ${text}`; });
    let message;
    try { runnersCommand(['export', '기본'], {out}, {home: a.dir, by: 'kyle', record: () => {}}); } catch (error) { message = error.message; }
    assert.match(message, /preset\.label/);
    assert.ok(!message.includes(text), '메시지에 값이 그대로 나왔다');
    assert.equal(fs.existsSync(out), false);
  });
}

test('export 개인정보 검사: 차단 사유·계열 규칙 같은 다른 자유 글자도 본다', () => {
  const a = sender();
  patch(a.dir, v => { v.blocked = [{model: 'fake-x', reason: `메모 ${privateText.users}`}]; });
  assert.throws(() => exportPreset(a.dir, {name: '기본'}), /blocked\[0\]\.reason/);
  patch(a.dir, v => { v.blocked = []; v.families = {fam: [privateText.email]}; });
  assert.throws(() => exportPreset(a.dir, {name: '기본'}), /families\[0\]\[0\]/);
});

test('--out: 명시한 경로에만 쓰고 KADAN_HOME 안·이미 있는 파일·없는 폴더는 거절한다', () => {
  const a = sender(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-out-'));
  const run = out => runnersCommand(['export', '기본'], {out}, {home: a.dir, by: 'kyle', record: () => {}});
  const out = path.join(dir, 'preset.json');
  const result = run(out);
  assert.equal(result.wrote, fs.realpathSync(dir) + '/preset.json');
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(written.preset.name, '기본');
  assert.throws(() => run(out), /덮어쓰지 않는다/);
  assert.throws(() => run(path.join(a.dir, 'export.json')), /KADAN_HOME 안/);
  assert.throws(() => run(path.join(a.dir, 'sub', '..', 'export.json')), /KADAN_HOME 안/);
  assert.throws(() => run(path.join(dir, 'missing', 'x.json')));
  assert.equal(fs.existsSync(path.join(a.dir, 'export.json')), false);
});

test('CLI 왕복: export 표준 출력 값을 파일로 두고 import --as로 가져온다', () => {
  const a = sender(), b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-out-')), 'preset.json');
  fs.writeFileSync(file, JSON.stringify(runnersCommand(['export', '기본'], {}, {home: a.dir, by: 'kyle', record: () => {}}), null, 2));
  const cache = path.join(path.dirname(file), 'models_cache.json');
  fs.writeFileSync(cache, JSON.stringify({models: fakeModels}));
  const prev = process.env.KADAN_CODEX_MODELS_CACHE;
  process.env.KADAN_CODEX_MODELS_CACHE = cache;
  try {
    const out = runnersCommand(['import', file], {as: 'team', revision: readSettings(b.dir).revision, reason: '시험'}, {home: b.dir, by: 'kyle', record: () => {}});
    assert.equal(out.imported, 'team');
    assert.match(out.next, /kadan runners preset team/);
    assert.ok(readSettings(b.dir).presets.team.roles.reviewer);
    assert.throws(() => runnersCommand(['import', file], {as: 'team2', revision: readSettings(b.dir).revision}, {home: b.dir, by: 'kyle', record: () => {}}), /이유가 필요하다/);
  } finally { if (prev === undefined) delete process.env.KADAN_CODEX_MODELS_CACHE; else process.env.KADAN_CODEX_MODELS_CACHE = prev; }
});

test('거절: 실행기도 모델도 없는 새 기계 — 빠진 것을 전부 나열하고 그대로 칠 명령과 "다시"를 붙인다', () => {
  const b = makeHome(null);
  const message = messageOf(b.dir, exported(), {as: 'team'});
  assert.match(message, /등록되지 않은 실행기: claude/);
  assert.match(message, /kadan runners runner claude --spawn/);
  assert.match(message, /kadan runners model claude fake-claude-1 --efforts low,high --revision N --reason/);
  assert.match(message, /kadan runners model claude fake-claude-2 --efforts medium --revision N --reason/);
  assert.match(message, /쓰는 곳: .*reviewer.*worker 대체 후보 1번/);
  assert.match(message, /import를 다시/);
  assertRejected(b.dir, exported(), /등록되지 않은 실행기/, {as: 'team'});
});

test('거절: 실행기는 있는데 모델이 없다 — 모델 명령을 전부 나열한다', () => {
  const b = makeHome({'fake-claude-1': ['low', 'high']});
  const message = messageOf(b.dir, exported(), {as: 'team'});
  assert.ok(!/등록되지 않은 실행기/.test(message));
  assert.match(message, /등록되지 않은 모델: claude\/fake-claude-2/);
  assert.match(message, /kadan runners model claude fake-claude-2 --efforts medium/);
  assertRejected(b.dir, exported(), /등록되지 않은 모델/, {as: 'team'});
});

test('거절: 모델은 있는데 강도가 없다 — 있던 강도에 더한 명령을 알려 준다', () => {
  const b = makeHome({'fake-claude-1': ['low'], 'fake-claude-2': ['medium']});
  const message = messageOf(b.dir, exported(), {as: 'team'});
  assert.match(message, /등록되지 않은 강도: claude\/fake-claude-1/);
  assert.match(message, /kadan runners model claude fake-claude-1 --efforts low,high/);
  assertRejected(b.dir, exported(), /등록되지 않은 강도/, {as: 'team'});
});

test('거절: codex 모델 목록에 없는 모델은 목록 갱신을 안내하고 읽을 수 없으면 그 이유를 말한다', () => {
  const b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  const data = exported();
  data.preset.roles.worker.model = 'fake-model-9';
  const message = messageOf(b.dir, data, {as: 'team'});
  assert.match(message, /codex 모델 목록에 fake-model-9이 없다/);
  assertRejected(b.dir, data, /갱신/, {as: 'team'});
  const unreadable = messageOf(b.dir, exported(), {as: 'team', readCodexModels: () => { throw new Error('ENOENT'); }});
  assert.match(unreadable, /codex: ENOENT/);
});

test('거절: 받는 쪽 계열 규칙에 걸리면 파일의 규칙이 아니라 받는 쪽 규칙으로 거절한다', () => {
  const b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  patch(b.dir, v => { v.families = {same: ['fake-claude-', 'fake-model-']}; });
  const data = exported();
  data.families = {};
  assertRejected(b.dir, data, /계열 규칙에 걸린다.*같은 계열\(same\)/, {as: 'team'});
});

test('거절: 받는 쪽 차단 모델이 쓰이면 거절하고 사유를 보여 준다', () => {
  const b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  patch(b.dir, v => { v.blocked = [{model: 'fake-claude-1', roles: ['reviewer'], reason: '시험 차단'}]; });
  const data = exported();
  data.blocked = [];
  assertRejected(b.dir, data, /막은 모델이 있다 — reviewer: fake-claude-1 \(시험 차단\)/, {as: 'team'});
});

test('거절: 이름 충돌은 --as를 안내하고, 새 이름 검사(__proto__·예약어·이름 규칙)를 그대로 지난다', () => {
  const b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  const data = exported();
  // 이름이 이미 있으면(양쪽 다 기본 프리셋 '기본') --as 안내가 나온다.
  assertRejected(b.dir, data, /이미 있는 프리셋: 기본 \(가져오려던 이름: 기본\) — 다른 이름으로 가져오려면 --as/);
  addPreset(b.dir, {name: 'team', ...meta(b.revision())});
  assertRejected(b.dir, data, /이미 있는 프리셋: team \(가져오려던 이름: team\) — 다른 이름으로 가져오려면 --as/, {as: 'team'});
  for (const name of ['__proto__', 'constructor', 'prototype', 'add', 'rename', 'remove']) assertRejected(b.dir, data, /쓸 수 없다/, {as: name});
  assertRejected(b.dir, data, /영문·한글·숫자/, {as: 'bad name!'});
  assertRejected(b.dir, data, /영문·한글·숫자/, {as: '팀 용'});
  assertRejected(b.dir, data, /영문·한글·숫자/, {as: '$팀용'});
  assertRejected(b.dir, data, /--as에는/, {as: true});
  const hostile = JSON.parse(JSON.stringify(data).replace('"name":"기본"', '"name":"__proto__"'));
  assert.equal(hostile.preset.name, '__proto__');
  assertRejected(b.dir, hostile, /쓸 수 없다/);
  assert.equal(Object.getPrototypeOf(readSettings(b.dir).presets), Object.prototype);
});

test('거절: 잘못된 format·version·모양', () => {
  const b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  const data = exported();
  assertRejected(b.dir, {...data, format: 'other'}, /format이 kadan-runner-export이 아니다/, {as: 'team'});
  assertRejected(b.dir, {...data, version: 2}, /지원하지 않는 version — 이 카단은 1만/, {as: 'team'});
  assertRejected(b.dir, {...data, version: undefined}, /지원하지 않는 version/, {as: 'team'});
  assertRejected(b.dir, null, /가져올 수 없는 파일/, {as: 'team'});
  assertRejected(b.dir, {...data, preset: {...data.preset, roles: {nobody: data.preset.roles.worker}}}, /모르는 역할 roles\[0\]/, {as: 'team'});
  assertRejected(b.dir, {...data, preset: {...data.preset, roles: {worker: {runner: 'codex'}}}}, /roles\.worker/, {as: 'team'});
  assertRejected(b.dir, {...data, preset: {...data.preset, fallback: {senior: []}}}, /대체 후보를 둘 수 없는 역할 fallback\.senior/, {as: 'team'});
  assertRejected(b.dir, {...data, families: []}, /families/, {as: 'team'});
});

test('거절: 가져올 파일에 개인정보 꼴이 있으면 칸 이름만 알리고 거절한다', () => {
  const b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  const data = exported();
  data.preset.label = `메모 ${privateText.users}`;
  const message = messageOf(b.dir, data, {as: 'team'});
  assert.match(message, /file\.preset\.label/);
  assert.ok(!message.includes(privateText.users));
  assertRejected(b.dir, data, /개인정보 꼴/, {as: 'team'});
});

test('전역 규칙 불변: 파일의 families·blocked가 달라도 적용하지 않고 차이만 보고한다', () => {
  const b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  patch(b.dir, v => { v.families = {mine: ['mine-'], shared: ['a-']}; v.blocked = [{model: 'only-here', reason: '로컬'}]; });
  const before = readSettings(b.dir);
  const data = exported();
  data.families = {shared: ['b-'], theirs: ['theirs-']};
  data.blocked = [{model: 'only-file', reason: '파일'}];
  data.runners = ['codex', 'ghost'];
  const result = importPreset(b.dir, {data, as: 'team', ...meta(before.revision)});
  const after = readSettings(b.dir);
  for (const key of ['runners', 'families', 'blocked', 'favorites', 'activePreset']) assert.deepEqual(after[key], before[key], `${key}가 바뀌었다`);
  assert.deepEqual(result.differences, {
    families: {onlyInFile: ['theirs'], onlyHere: ['mine'], different: ['shared']},
    blocked: {onlyInFile: ['only-file'], onlyHere: ['only-here']},
    runners: {notRegisteredHere: ['ghost']},
    identical: false,
  });
});

test('가져온 프리셋은 활성화하지 않는다: 쓰려면 사람이 preset 명령으로 바꾼다', () => {
  const a = sender(), b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  const result = importPreset(b.dir, {data: exportPreset(a.dir, {name: '기본'}), as: 'team', ...meta(b.revision())});
  assert.equal(readSettings(b.dir).activePreset, '기본');
  assert.match(result.next, /kadan runners preset team --revision \d+/);
});

test('이전 revision으로 가져오면 다른 변경을 덮지 않고 거절한다', () => {
  const a = sender(), b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  const stale = b.revision();
  addPreset(b.dir, {name: 'other', ...meta(stale)});
  assert.throws(() => importPreset(b.dir, {data: exportPreset(a.dir, {name: '기본'}), as: 'team', ...meta(stale)}), /설정이 바뀌었다/);
  assert.equal(readSettings(b.dir).presets.team, undefined);
});

test('한글 이름: 기본을 내보내 다른 홈에 --as 없이 가져오고(이름 충돌 없을 때), --as 팀용도 된다', () => {
  const a = sender(), b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  const data = JSON.parse(JSON.stringify(exportPreset(a.dir, {name: '기본'})));
  assert.equal(data.preset.name, '기본');
  // 받는 홈의 기본 프리셋 이름을 먼저 바꿔 충돌을 없앤다.
  renamePreset(b.dir, {from: '기본', to: '개인용', ...meta(b.revision())});
  const result = importPreset(b.dir, {data, ...meta(b.revision())});
  assert.equal(result.imported, '기본');
  assert.deepEqual(readSettings(b.dir).presets['기본'].roles, readSettings(a.dir).presets['기본'].roles);
  assert.equal(readSettings(b.dir).activePreset, '개인용');
  assert.equal(importPreset(b.dir, {data, as: '팀용', ...meta(b.revision())}).imported, '팀용');
  assert.match(result.next, /kadan runners preset 기본 --revision/);
});

test('한글 이름 CLI: 내보낸 파일의 preset.name과 --out 파일에 한글이 깨지지 않는다', () => {
  const a = sender(), out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-out-')), 'p.json');
  runnersCommand(['export', '기본'], {out}, {home: a.dir, by: 'kyle', record: () => {}});
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).preset.name, '기본');
});

// 합성 값만 쓴다(실제 비밀값 아님). 조립해서 쓰므로 저장소 검사에도 걸리지 않는다.
const fake = {
  ghp: ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join(''),
  proj: ['sk', '-proj-', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4'].join(''),
  email: ['zed', '@', 'example', '.test'].join(''),
};

test('F1: 접두어가 붙은 토큰(prod_ghp_…, prod_sk-proj-…)과 label 중간에 낀 토큰도 내보내기를 막고, 정상 모델 이름은 통과한다', () => {
  for (const [kind, text] of [['ghp', `prod_${fake.ghp}`], ['proj', `prod_${fake.proj}`], ['mid', `메모 앞 ${fake.ghp} 메모 뒤`]]) {
    const a = sender(), out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-out-')), 'p.json');
    patch(a.dir, v => { v.presets['기본'].label = text; });
    let message;
    try { runnersCommand(['export', '기본'], {out}, {home: a.dir, by: 'kyle', record: () => {}}); } catch (error) { message = error.message; }
    assert.match(message, /preset\.label\(토큰 꼴\)/, kind);
    assert.ok(!message.includes(fake.ghp) && !message.includes(fake.proj), kind);
    assert.equal(fs.existsSync(out), false, kind);
  }
  const names = ['zai/glm-5.1-flash', 'gpt-6-1-sol', 'claude-opus-5-5', 'claude-fable-5-1', 'command-code/deepseek-v4.1-flash',
    'xai/grok-4-fast-reasoning', 'kimi/k3', 'swe-2-max', 'task-1', 'desk-model-v2', 'openai-codex/gpt-5-codex-mini'];
  assert.deepEqual(findPrivate(names.map(name => ({model: name}))), []);
});

test('F2: families 키·값에 토큰·이메일이 있어도 오류의 위치·종류만 나오고 원문은 어디에도 없다(내보내기·가져오기 둘 다)', () => {
  const a = sender(), b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  for (const secret of [fake.ghp, fake.proj, fake.email]) {
    patch(a.dir, v => { v.families = {ok: ['x-'], [secret]: ['y-']}; });
    let message;
    try { exportPreset(a.dir, {name: '기본'}); } catch (error) { message = error.message; }
    assert.match(message, /export\.families\[1\]\(키\)\(/);
    assert.ok(!message.includes(secret), '내보내기 오류에 원문이 있다');
    const data = exported();
    data.families = {[secret]: ['y-']};
    data.preset.roles = {[secret]: data.preset.roles.worker};
    const inbound = messageOf(b.dir, data, {as: 'team'});
    assert.ok(!inbound.includes(secret), '가져오기 오류에 원문이 있다');
    assert.match(inbound, /file\./);
    // 값에서 잡혀도 위치에 민감한 키 원문이 다시 들어가지 않는다.
    const viaValue = exported();
    viaValue.families = {[fake.email]: [fake.ghp]};
    assert.ok(!messageOf(b.dir, viaValue, {as: 'team'}).includes(fake.email));
  }
});

for (const bad of ['bad;echo injected', 'a b', 'x$(id)', 'x`id`']) {
  for (const key of ['runner', 'model', 'effort']) {
    test(`F3: 파일의 ${key}에 ${JSON.stringify(bad)}가 있으면 안내 명령 없이 전체 거절하고 설정·원장은 그대로다`, () => {
      const b = makeHome(null);
      const data = exported();
      data.preset.roles.reviewer[key] = bad;
      const message = messageOf(b.dir, data, {as: 'team'});
      assert.match(message, /이름 규칙 밖이다: roles\.reviewer\.\w+/);
      assert.ok(!/kadan runners/.test(message), '안내 명령이 만들어졌다');
      assert.ok(!message.includes(bad), '값 원문이 나왔다');
      assertRejected(b.dir, data, /이름 규칙 밖/, {as: 'team'});
      const inFallback = exported();
      inFallback.preset.fallback.worker[0][key] = bad;
      assertRejected(b.dir, inFallback, /이름 규칙 밖/, {as: 'team'});
    });
  }
}

// 3라운드: 앞 글자 경계 + 접두어별 모양(숫자 조건 없음), 모든 오류에서 파일 원문 비출력. 합성 값만 쓴다.
const A = n => 'A'.repeat(n);
const tokenCases = {
  'prod_ghp_': `prod_${['ghp', '_'].join('')}${A(36)}`, 'prod_sk-proj-': `prod_${['sk', '-proj-'].join('')}${A(48)}`,
  'mid ghp_': `앞 ${['ghp', '_'].join('')}${A(36)} 뒤`, github_pat_: `${['github', '_pat_'].join('')}${A(64)}`,
  gho_: `${['gho', '_'].join('')}${A(36)}`, 'xoxb-': `${['xox', 'b-'].join('')}${A(48)}`, AKIA: `${['AK', 'IA'].join('')}${A(16)}`,
  ASIA: `x/${['AS', 'IA'].join('')}${A(16)}`, AIza: `${['AI', 'za'].join('')}${A(35)}`, 'sk-ant-': `-${['sk', '-ant-'].join('')}${A(30)}`,
};

test('F1 3라운드: 숫자 없는 토큰도 앞 경계 + 접두어 모양이면 stdout·파일 모두 없이 거절한다', () => {
  for (const [kind, text] of Object.entries(tokenCases)) {
    const a = sender(), out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-out-')), 'p.json');
    patch(a.dir, v => { v.presets['기본'].label = text; });
    assert.throws(() => runnersCommand(['export', '기본'], {out}, {home: a.dir, by: 'kyle', record: () => {}}), /preset\.label\(토큰 꼴\)/, kind);
    assert.equal(fs.existsSync(out), false, kind);
    assert.throws(() => runnersCommand(['export', '기본'], {}, {home: a.dir, by: 'kyle', record: () => {}}), /토큰 꼴/, kind);
  }
});

test('F4 3라운드: 정상 이름은 오탐하지 않는다(단어 안쪽 sk-·짧은 접두어 뒤)', () => {
  const names = ['desk-customer-specific-model-v2', 'task-sk-runner', 'zai/glm-4.6', 'gpt-6-astra', 'gpt-6-luna', 'claude-sonnet-5-5',
    'claude-opus-5-5', 'gemini-4-argon-medium', 'command-code/deepseek-deepseek-v4.1-flash', 'zai/glm-5.1-flash', 'gpt-6-1-sol',
    'claude-fable-5-1', 'command-code/deepseek-v4.1-flash', 'xai/grok-4-fast-reasoning', 'kimi/k3', 'swe-2-max', 'task-1', 'desk-model-v2',
    'openai-codex/gpt-5-codex-mini'];
  assert.deepEqual(findPrivate(names.map(name => ({model: name}))), []);
});

test('F2 3라운드: 모양 오류는 roles·fallback·families 키·값·label에 무엇을 넣어도 원문 없이 칸 이름·위치만 낸다', () => {
  const b = makeHome({'fake-claude-1': ['low', 'high'], 'fake-claude-2': ['medium']});
  const words = ['QQzzmarker', ...Object.values(tokenCases), fake.email];
  for (const w of words) {
    const bad = [];
    const roleKey = exported(); roleKey.preset.roles = {[w]: roleKey.preset.roles.worker}; bad.push(roleKey);
    const fbKey = exported(); fbKey.preset.fallback = {[w]: []}; bad.push(fbKey);
    const famKey = exported(); famKey.families = {[w]: 'not-a-list'}; bad.push(famKey);
    const famVal = exported(); famVal.families = {ok: [w, 7]}; bad.push(famVal);
    const lbl = exported(); lbl.preset.label = [w]; bad.push(lbl);
    const ver = exported(); ver.version = w; bad.push(ver);
    const fmt = exported(); fmt.format = w; bad.push(fmt);
    const blk = exported(); blk.blocked = [{model: 7, reason: w}]; bad.push(blk);
    const run = exported(); run.runners = [w, 7]; bad.push(run);
    for (const data of bad) {
      const message = messageOf(b.dir, data, {as: 'team'});
      assert.ok(!message.includes(w), `원문이 오류에 나왔다: ${message}`);
    }
  }
  assert.match(messageOf(b.dir, (() => { const d = exported(); d.preset.roles = {x: d.preset.roles.worker}; return d; })(), {as: 'team'}),
    /파일 형식 오류: 모르는 역할 roles\[0\]/);
});
