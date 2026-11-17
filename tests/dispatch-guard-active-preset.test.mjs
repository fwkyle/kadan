// 발령 검사의 대체 후보 대조는 1순위 기대값과 같은 '활성 프리셋'의 목록을 쓴다.
// 비교 모드를 한 번 쓰고 끈 뒤에도 settings.compare.presets 목록이 남는데, 이 목록만으로 세션의 옛 프리셋 후보를 고르면
// 활성 프리셋을 바꾼 뒤 옛 후보가 통과하고 현재 후보가 거절됐다(PR 검수 F1). 비교 모드가 켜져 있는 동안 `--for`로 뜬 검수자만 예외로 세션 프리셋을 본다
// (tests/runner-compare.test.mjs가 그 쪽을 지킨다). 모델 이름은 모두 가짜, 설정은 격리 홈에만 쓴다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_FAMILIES, HARD_ROLE, launchForFallback, readSettings, setActivePreset, setFallback,
} from '../src/runner-settings.mjs';
import {setCompare} from '../src/runner-compare.mjs';
import {inspectDispatchRunnerGuard} from '../src/dispatch-runner-guard.mjs';

const c = model => ({runner: 'codex', model, effort: 'high'});
const MODELS = ['gpt-worker', 'claude-review', 'gpt-hard', 'gpt-old', 'gpt-current'];

// 프리셋 A·B 모두 작업자·검수자·어려운 일 자리가 찬 설정. role(worker 또는 worker-hard)의 대체 후보를 저장하고 비교 A·B를 켠다.
function rig(role) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-guard-active-'));
  const roles = () => ({worker: c('gpt-worker'), reviewer: c('claude-review'), [HARD_ROLE]: c('gpt-hard')});
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify({version: 1, revision: 1, activePreset: 'A',
    families: DEFAULT_FAMILIES, runners: {codex: {spawn: 'codex --model {model} --effort {effort}',
      models: MODELS.map(model => ({model, efforts: ['high']}))}},
    presets: {A: {roles: roles()}, B: {roles: roles()}}}));
  const meta = () => ({revision: readSettings(home).revision, by: 'test', reason: '시험', record: () => {}});
  setFallback(home, {role, preset: 'A', items: [c('gpt-old'), c('gpt-current')], ...meta()});
  setFallback(home, {role, preset: 'B', items: [c('gpt-current')], ...meta()});
  setCompare(home, {enabled: true, presets: ['A', 'B'], ...meta()});
  // 비교를 켠 동안 A의 후보로 정식 시작한 세션(compareMode 없음). 시작 기록의 settingsPreset은 A다.
  const sessions = [1, 2].map(n => {
    const launch = launchForFallback(readSettings(home), role, n, 'A');
    return {harness: 'codex', model: launch.model, launch: {cmd: launch.cmd, settingsPreset: 'A', settingsRevision: launch.revision,
      launchSource: role === 'reviewer' ? 'review-for' : 'fallback', fallbackIndex: n, ...(role === HARD_ROLE ? {difficulty: 'hard'} : {})}};
  });
  const profile = role === 'reviewer' ? 'reviewer' : 'worker';
  const check = identity => inspectDispatchRunnerGuard({home, role: 'r', session: 'kadan-r', profile, phaseProfile: profile, identity});
  return {home, meta, sessions, check};
}

for (const [role, label] of [[HARD_ROLE, '어려운 일'], ['worker', '일반 작업자'], ['reviewer', '검수자']]) {
  test(`${label} 대체 후보: 비교 목록이 남은 채 활성 프리셋을 바꾸면 옛 후보는 거절, 현재 후보는 경고로 통과한다`, () => {
    const {home, meta, sessions, check} = rig(role);
    const [old, current] = sessions;
    // 비교를 켠 동안(활성 프리셋 A, 세션 프리셋도 A)은 둘 다 폴백 경고로 통과.
    assert.deepEqual([check(old).code, check(current).code], ['fallback', 'fallback']);
    setCompare(home, {enabled: false, ...meta()});
    setFallback(home, {role, preset: 'A', items: [c('gpt-old')], ...meta()});
    setActivePreset(home, {preset: 'B', ...meta()});
    const settings = readSettings(home);
    assert.deepEqual(settings.compare.presets, ['A', 'B'], '꺼도 비교 목록은 남는다(전제)');
    // (a) 옛 후보(A에만 있음): 현재 활성 프리셋 B의 후보가 아니다 → 거절.
    const a = check(old);
    assert.deepEqual([a.result, a.code], ['reject', 'runner-or-model'], JSON.stringify(a));
    // (b) 현재 후보(B의 1번): 경고로 통과하고 번호는 B 목록 기준이다.
    const b = check(current);
    assert.deepEqual([b.result, b.code], ['warn', 'fallback'], JSON.stringify(b));
    assert.equal(b.ledger.fallbackIndex, 1);
    assert.match(b.warning, role === HARD_ROLE ? /어려운 일 작업자 자리 폴백 1번/ : new RegExp(`${role} 폴백 1번`));
  });

  test(`${label} 대체 후보: 비교 모드 세션은 폴백 예외를 쓰지 않는다(세션의 프리셋 1순위만 대조)`, () => {
    const {home, sessions, check} = rig(role);
    const [old] = sessions;
    const compareSession = {...old, launch: {...old.launch, compareMode: true, pickId: 'p1', settingsPreset: 'A'}};
    const verdict = check(compareSession);
    assert.deepEqual([verdict.result, verdict.code], ['reject', 'runner-or-model'], JSON.stringify(verdict));
    assert.ok(readSettings(home).presets.A.fallback[role].some(item => item.model === 'gpt-old'), '후보 목록에는 있어도 예외가 되지 않는다');
  });
}
