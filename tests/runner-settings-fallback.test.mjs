import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {blockModel, editFallback, initSettings, launchForFallback, parseFallbackSpec, readSettings, setFallback, setRole, setRunnerModel} from '../src/runner-settings.mjs';
import {readLedger} from '../src/ledger.mjs';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const codexModels = [
  {slug:'xai/grok-4.7-build-fast', supported_reasoning_levels:['low','medium','high','xhigh'].map(effort=>({effort}))},
  {slug:'gpt-6-sol', supported_reasoning_levels:['low','medium','high'].map(effort=>({effort}))},
  {slug:'gpt-6-astra', supported_reasoning_levels:['low','medium'].map(effort=>({effort}))},
  {slug:'zai/glm-5.3', supported_reasoning_levels:['medium','high'].map(effort=>({effort}))},
  {slug:'mystery-model', supported_reasoning_levels:['medium'].map(effort=>({effort}))},
];
// 작업자 grok, 검수자 gpt, astra는 검수자 금지, devin은 강도 없는 실측 모델 하나. revision 6.
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-rs-fallback-'));
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners:[
    {id:'codex', spawn:'codex -p lite --model {model} -c model_reasoning_effort="{effort}"'},
    {id:'devin', spawn:'devin --model {model} --permission-mode dangerous'},
  ]}));
  const cache = path.join(home, 'models_cache.json');
  fs.writeFileSync(cache, JSON.stringify({models:codexModels}));
  const records = [];
  const options = {readCodexModels: () => ({models:codexModels})};
  const meta = revision => ({revision, by:'kyle', reason:'시험', record:e => records.push(e), ...options});
  initSettings(home, {by:'kyle', reason:'시작', record:e => records.push(e)});
  setRole(home, {role:'worker', runner:'codex', model:'xai/grok-4.7-build-fast', effort:'xhigh', ...meta(1)});
  setRole(home, {role:'reviewer', runner:'codex', model:'gpt-6-sol', effort:'medium', ...meta(2)});
  blockModel(home, {model:'gpt-6-astra', roles:'reviewer', ...meta(3)});
  setRunnerModel(home, {runner:'devin', model:'swe-2-max', efforts:'', ...meta(4)});
  setRole(home, {role:'conductor', runner:'codex', model:'gpt-6-sol', effort:'high', ...meta(5)});
  return {home, cache, records, meta, options};
}

test('폴백 목록 형식과 한 번 조작(추가·삭제·위로·아래로)의 번호 확인', () => {
  assert.deepEqual(parseFallbackSpec('devin:swe-2-max, codex:zai/glm-5.3:high'), [{runner:'devin', model:'swe-2-max'}, {runner:'codex', model:'zai/glm-5.3', effort:'high'}]);
  assert.deepEqual(parseFallbackSpec(''), []);
  assert.throws(() => parseFallbackSpec('codex'), /실행기:모델/);
  assert.throws(() => parseFallbackSpec('codex:a:b:c'), /실행기:모델/);
  const a = {model:'a'}, b = {model:'b'}, c = {model:'c'};
  assert.deepEqual(editFallback([a, b], {op:'add', item:c}), [a, b, c]);
  assert.deepEqual(editFallback([a, b, c], {op:'up', index:'3'}), [a, c, b]);
  assert.deepEqual(editFallback([a, b, c], {op:'down', index:'1'}), [b, a, c]);
  assert.deepEqual(editFallback([a, b, c], {op:'remove', index:'2'}), [a, c]);
  assert.throws(() => editFallback([a], {op:'remove', index:'2'}), /없는 폴백 번호: 2 — 가능: 1\.\.1/);
  assert.throws(() => editFallback([], {op:'up', index:'1'}), /없는 폴백 번호/);
  assert.throws(() => editFallback([a, b], {op:'up', index:'1'}), /위로 옮길 수 없다/);
  assert.throws(() => editFallback([a, b], {op:'down', index:'2'}), /아래로 옮길 수 없다/);
  assert.throws(() => editFallback([a], {op:'swap', index:'1'}), /알 수 없는/);
});

test('폴백 저장은 항목마다 선택지·강도·정책을 검사하고 이유·revision·중복·변화 없음을 거부한다', () => {
  const f = fixture();
  const set = (role, items, revision = 6, extra = {}) => setFallback(f.home, {role, items, ...f.meta(revision), ...extra});
  assert.throws(() => set('secretary', []), /역할은/);
  assert.throws(() => set('worker', [{runner:'codex', model:'gpt-9-nowhere', effort:'low'}]), /폴백 1번: codex에서 고를 수 없는 모델/);
  assert.throws(() => set('worker', [{runner:'devin', model:'swe-2-max'}, {runner:'codex', model:'zai/glm-5.3', effort:'xhigh'}]), /폴백 2번: .*지원하지 않는 강도/);
  assert.throws(() => set('worker', [{runner:'devin', model:'swe-2-max', effort:'high'}]), /강도를 받지 않는다/);
  assert.throws(() => set('worker', [{runner:'nobody', model:'x'}]), /등록되지 않은 실행기/);
  assert.throws(() => set('reviewer', [{runner:'codex', model:'gpt-6-astra', effort:'low'}]), /정책으로 막은 모델/);
  assert.throws(() => set('worker', [{runner:'devin', model:'swe-2-max'}, {runner:'devin', model:'swe-2-max'}]), /두 번/);
  assert.throws(() => set('worker', [{runner:'devin', model:'swe-2-max'}], 5), /다시 읽고/);
  assert.throws(() => set('worker', [{runner:'devin', model:'swe-2-max'}], 6, {reason:' '}), /이유/);
  assert.throws(() => set('worker', []), /바뀐 것이 없다/);
  const saved = set('worker', [{runner:'devin', model:'swe-2-max'}]);
  assert.equal(saved.revision, 7);
  assert.deepEqual(readSettings(f.home).presets.B.fallback.worker, [{runner:'devin', model:'swe-2-max'}]);
  const event = f.records.at(-1);
  assert.deepEqual({action:event.action, role:event.role, preset:event.preset, before:event.before, after:event.after},
    {action:'fallback', role:'worker', preset:'B', before:[], after:[{runner:'devin', model:'swe-2-max'}]});
  // 빈 목록은 비운다.
  set('worker', [], 7);
  assert.equal(readSettings(f.home).presets.B.fallback.worker, undefined);
});

test('계열: 검수자 폴백↔작업자 1순위, 작업자 폴백↔검수자 1순위가 같으면 거부하고, 1순위를 바꿀 때도 기존 폴백과 대조한다', () => {
  const f = fixture();
  const set = (role, items, revision) => setFallback(f.home, {role, items, ...f.meta(revision)});
  assert.throws(() => set('reviewer', [{runner:'codex', model:'zai/glm-5.3', effort:'high'}, {runner:'codex', model:'xai/grok-4.7-build-fast', effort:'low'}], 6),
    /검수자 폴백 2번\(xai\/grok-4.7-build-fast\)이 작업자 1순위와 같은 계열\(grok\)/);
  assert.throws(() => set('worker', [{runner:'codex', model:'gpt-6-astra', effort:'low'}], 6), /작업자 폴백 1번\(gpt-6-astra\)이 검수자 1순위와 같은 계열\(gpt\)/);
  // 모르는 계열은 막지 않는다. 일반감독 폴백은 계열 규칙 대상이 아니다.
  set('reviewer', [{runner:'codex', model:'zai/glm-5.3', effort:'high'}, {runner:'codex', model:'mystery-model', effort:'medium'}], 6);
  set('conductor', [{runner:'codex', model:'xai/grok-4.7-build-fast', effort:'low'}], 7);
  // 작업자 1순위를 glm으로 바꾸면 검수자 폴백 1번과 같은 계열이라 저장하지 않는다.
  assert.throws(() => setRole(f.home, {role:'worker', runner:'codex', model:'zai/glm-5.3', effort:'high', ...f.meta(8)}), /검수자 폴백 1번\(zai\/glm-5.3\)이 작업자 1순위와 같은 계열\(glm\)/);
  assert.equal(readSettings(f.home).presets.B.roles.worker.model, 'xai/grok-4.7-build-fast');
});

test('N번째 폴백으로 실행 명령을 채우고 없는 번호는 거부한다', () => {
  const f = fixture();
  setFallback(f.home, {role:'worker', items:[{runner:'devin', model:'swe-2-max'}, {runner:'codex', model:'zai/glm-5.3', effort:'high'}], ...f.meta(6)});
  const settings = readSettings(f.home);
  const second = launchForFallback(settings, 'worker', 2);
  assert.equal(second.cmd, 'codex -p lite --model zai/glm-5.3 -c model_reasoning_effort="high"');
  assert.equal(second.fallbackIndex, 2); assert.equal(second.revision, 7); assert.equal(second.preset, 'B');
  assert.equal(launchForFallback(settings, 'worker', '1').cmd, 'devin --model swe-2-max --permission-mode dangerous');
  for (const n of [0, 3, 'x', '1.5']) assert.throws(() => launchForFallback(settings, 'worker', n), /없는 폴백 번호/);
  assert.throws(() => launchForFallback(settings, 'reviewer', 1), /비어 있다/);
  assert.throws(() => launchForFallback(settings, 'secretary', 1), /역할 프로필/);
  assert.throws(() => launchForFallback(null, 'worker', 1), /설정/);
});

test('CLI: runners fallback·show와 start --fallback N (이유 필수, --cmd 함께 불가, 없는 번호 거부, 기록)', () => {
  const f = fixture();
  const socket = `runner-fallback-test-${process.pid}-${Date.now()}`;
  const env = {...process.env, KADAN_HOME:f.home, KADAN_SOCKET:socket, KADAN_FLOOR:'tmux', KADAN_WINDOW:'none', KADAN_CODEX_MODELS_CACHE:f.cache, KADAN_ROLE:'시험-슈퍼'};
  delete env.KADAN_LITE_HOME;
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {env, encoding:'utf8', timeout:15000});
  const ok = (...args) => { const p = run(...args); assert.equal(p.status, 0, p.stderr); return p.stdout; };
  const alive = name => spawnSync('tmux', ['-L', socket, 'has-session', '-t', `=kadan-${name}`]).status === 0;
  try {
    assert.match(run('runners', 'fallback', 'worker', '--revision', '6', '--reason', '시험').stderr, /--set/);
    ok('runners', 'fallback', 'worker', '--set', 'devin:swe-2-max,codex:zai/glm-5.3:high', '--revision', '6', '--reason', '1순위 쿼터 대비');
    const shown = JSON.parse(ok('runners', 'show'));
    assert.deepEqual(shown.fallback.worker.map(x => x.cmd), ['devin --model swe-2-max --permission-mode dangerous', 'codex -p lite --model zai/glm-5.3 -c model_reasoning_effort="high"']);
    const event = readLedger(f.home).filter(e => e.kind === 'runner-settings').at(-1);
    assert.equal(event.action, 'fallback'); assert.equal(event.by, '시험-슈퍼'); assert.equal(event.reason, '1순위 쿼터 대비');

    // 거부 경우는 세션을 만들지 않는다.
    const refused = [
      [['--fallback', '2'], /--reason/],
      [['--fallback', '2', '--reason', '429', '--cmd', 'cat'], /함께 쓸 수 없다|--reason/],
      [['--fallback', '3', '--reason', '429'], /없는 폴백 번호: 3 — 가능: 1\.\.2/],
      [['--fallback', '0', '--reason', '429'], /번호가 필요/],
      [['--fallback', '--reason', '429'], /번호가 필요/],
    ];
    for (const [flags, pattern] of refused) {
      const p = run('start', 'rs-fb-no', '--hidden', '--profile', 'worker', ...flags);
      assert.notEqual(p.status, 0, flags.join(' ')); assert.match(p.stderr, pattern);
      assert.equal(alive('rs-fb-no'), false);
    }
    const noProfile = run('start', 'rs-fb-no', '--hidden', '--fallback', '1', '--reason', '429');
    assert.notEqual(noProfile.status, 0); assert.match(noProfile.stderr, /--profile/);

    // 가짜 실행기로 실제 세션을 띄워 2번 폴백 명령이 쓰였는지 본다.
    const fake = path.join(f.home, 'fake-codex');
    fs.writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n', {mode:0o755});
    const file = path.join(f.home, 'runner-settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.runners.codex.spawn = `${fake} --model {model} -c model_reasoning_effort="{effort}"`;
    fs.writeFileSync(file, JSON.stringify(settings));
    ok('start', 'rs-fb-ok', '--hidden', '--profile', 'worker', '--fallback', '2', '--reason', '1순위 429 확인');
    assert.equal(alive('rs-fb-ok'), true);
    const start = readLedger(f.home).filter(e => e.kind === 'start' && e.role === 'rs-fb-ok').at(-1);
    assert.equal(start.launchSource, 'fallback'); assert.equal(start.fallbackIndex, 2);
    assert.equal(start.fallbackReason, '1순위 429 확인'); assert.equal(start.settingsRevision, 7); assert.equal(start.settingsPreset, 'B');
    assert.equal(start.cmd, `${fake} --model zai/glm-5.3 -c model_reasoning_effort="high"`);
    assert.equal(start.settingsCmd, `${fake} --model xai/grok-4.7-build-fast -c model_reasoning_effort="xhigh"`);
    // 이미 떠 있는 세션에는 폴백을 쓰지 않는다.
    const reuse = run('start', 'rs-fb-ok', '--hidden', '--profile', 'worker', '--fallback', '1', '--reason', '다시');
    assert.notEqual(reuse.status, 0); assert.match(reuse.stderr, /이미 살아 있음/);
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});
