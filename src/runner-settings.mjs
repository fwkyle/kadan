// 실행 모델 설정 — 역할별 실행기·모델·강도의 기계용 기준(2026-09-23 [kyle] 승인 1단계).
// 사람용 설명은 agent-runners.json에 두고, 발령이 읽는 값은 이 파일 한 곳만 본다.
// 자동 라우팅·자동 폴백은 만들지 않는다. 실행기별 어댑터 대신 spawn 문자열 틀만 채운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SETTINGS_FILE = 'runner-settings.json';
// start --profile 값 → 설정의 역할 키. 비서는 실행 모델 설정 대상이 아니다.
export const PROFILE_ROLES = {worker:'worker', reviewer:'reviewer', conductor:'conductor', super:'super'};
// agent-runners.json `_계열`의 이름 앞머리 규칙. 모르는 계열끼리는 "다르다"고 보지 않는다.
export const DEFAULT_FAMILIES = {
  gpt:['gpt-','openai-codex/gpt-'], claude:['claude-','anthropic/claude-'], grok:['xai/grok-'], glm:['zai/glm-'],
  kimi:['kimi/k3'], deepseek:['command-code/deepseek-'], gemini:['google/gemini-'], 'devin-swe':['swe-'],
};
const VALUE = /^[A-Za-z0-9._/\-[\]]+$/;

export const settingsPath = home => path.join(home, SETTINGS_FILE);
export const codexModelsCachePath = () => process.env.KADAN_CODEX_MODELS_CACHE || path.join(os.homedir(), '.codex', 'models_cache.json');

export function modelFamily(model, families = DEFAULT_FAMILIES) {
  if (typeof model !== 'string') return null;
  for (const [family, prefixes] of Object.entries(families)) if (prefixes.some(p => model.startsWith(p))) return family;
  return null;
}

export function readSettings(home) {
  const file = settingsPath(home);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.version !== 1 || !Number.isInteger(value.revision) || !value.presets?.[value.activePreset]?.roles || typeof value.runners !== 'object')
    throw new Error(`실행 모델 설정 손상: ${file}`);
  return value;
}

// 실행기별 고를 수 있는 모델과 강도. codex는 모델 목록 파일, 그 밖은 설정에 적은 실측 목록만 쓴다.
export function runnerChoices(settings, runner, {readCodexModels = () => JSON.parse(fs.readFileSync(codexModelsCachePath(), 'utf8'))} = {}) {
  const spec = settings.runners[runner];
  if (!spec?.spawn) throw new Error(`등록되지 않은 실행기: ${runner}`);
  if (spec.catalog === 'codex-models-cache') {
    const list = readCodexModels();
    const models = Array.isArray(list) ? list : list?.models;
    if (!Array.isArray(models)) throw new Error('codex 모델 목록을 읽을 수 없다');
    return new Map(models.filter(m => typeof m?.slug === 'string')
      .map(m => [m.slug, (m.supported_reasoning_levels ?? []).map(l => l.effort).filter(Boolean)]));
  }
  return new Map((spec.models ?? []).map(m => [m.model, m.efforts ?? []]));
}

function checkChoice(settings, role, {runner, model, effort}, options) {
  if (![runner, model].every(v => typeof v === 'string' && VALUE.test(v)) || (effort != null && !VALUE.test(effort)))
    throw new Error('실행기·모델·강도에는 영문·숫자·./-[]만 쓴다');
  const choices = runnerChoices(settings, runner, options);
  if (!choices.has(model)) throw new Error(`${runner}에서 고를 수 없는 모델: ${model}`);
  const efforts = choices.get(model);
  const needsEffort = settings.runners[runner].spawn.includes('{effort}');
  if (needsEffort && !efforts.includes(effort)) throw new Error(`${model}이 지원하지 않는 강도: ${effort ?? '(없음)'} — 가능: ${efforts.join('/') || '없음'}`);
  if (!needsEffort && effort != null) throw new Error(`${runner}은 강도를 받지 않는다`);
  const blocked = (settings.blocked ?? []).find(b => b.model === model && (!b.roles || b.roles.includes(role)));
  if (blocked) throw new Error(`정책으로 막은 모델: ${model} — ${blocked.reason}`);
}

export function checkFamilies(roles, families = DEFAULT_FAMILIES) {
  const worker = modelFamily(roles.worker?.model, families), reviewer = modelFamily(roles.reviewer?.model, families);
  if (worker && worker === reviewer) throw new Error(`작업자와 검수자가 같은 계열(${worker})이다 — 자기 검수가 된다`);
}

// 프리셋 하나의 계열 확인: 1순위끼리, 그리고 검수자 폴백↔작업자 1순위·작업자 폴백↔검수자 1순위(3단계).
// 1순위를 바꿀 때도 같은 확인을 거치므로 기존 폴백과 충돌하는 저장은 거부된다.
function checkPresetFamilies(preset, families = DEFAULT_FAMILIES) {
  checkFamilies(preset.roles, families);
  const pairs = [['reviewer', 'worker', '검수자', '작업자'], ['worker', 'reviewer', '작업자', '검수자']];
  for (const [role, other, label, otherLabel] of pairs) {
    const primary = modelFamily(preset.roles?.[other]?.model, families);
    if (!primary) continue;
    (preset.fallback?.[role] ?? []).forEach((item, i) => {
      if (modelFamily(item.model, families) === primary)
        throw new Error(`${label} 폴백 ${i + 1}번(${item.model})이 ${otherLabel} 1순위와 같은 계열(${primary})이다 — 자기 검수가 된다`);
    });
  }
}

// 현재 설정으로 역할의 실행 명령을 만든다. 설정이 없거나 역할 값이 없으면 null.
export function launchFor(settings, profile) {
  const role = PROFILE_ROLES[profile];
  const value = role && settings?.presets[settings.activePreset].roles[role];
  if (!value) return null;
  return {cmd: fill(settings, value), role, preset: settings.activePreset, revision: settings.revision, ...value};
}

function fill(settings, value) {
  const spawn = settings.runners[value.runner]?.spawn;
  if (!spawn) throw new Error(`실행 모델 설정의 실행기 틀 없음: ${value.runner}`);
  return spawn.replaceAll('{model}', value.model).replaceAll('{effort}', value.effort ?? '');
}

// 활성 프리셋 역할의 N번째(1부터) 폴백으로 실행 명령을 만든다. 자동으로 고르지 않고 번호를 받은 경우에만 쓴다.
export function launchForFallback(settings, profile, n) {
  const role = PROFILE_ROLES[profile];
  if (!role || !settings) throw new Error('폴백 발령에는 실행 모델 설정과 역할 프로필이 필요하다');
  const list = settings.presets[settings.activePreset].fallback?.[role] ?? [];
  const index = Number(n);
  if (!Number.isInteger(index) || index < 1 || index > list.length)
    throw new Error(`없는 폴백 번호: ${n} — 가능: ${list.length ? `1..${list.length}` : '없음(폴백 목록이 비어 있다)'}`);
  const value = list[index - 1];
  return {cmd: fill(settings, value), role, preset: settings.activePreset, revision: settings.revision, fallbackIndex: index, ...value};
}

// 'runner:model[:effort],…' → 폴백 항목 목록. 값에는 ':'·','가 들어갈 수 없다(VALUE). 빈 글은 빈 목록.
export function parseFallbackSpec(text) {
  return String(text ?? '').split(',').map(v => v.trim()).filter(Boolean).map(part => {
    const [runner, model, effort, ...extra] = part.split(':');
    if (!runner || !model || extra.length) throw new Error(`폴백 항목 형식은 실행기:모델[:강도]: ${part}`);
    return {runner, model, ...(effort ? {effort} : {})};
  });
}

// 대시보드의 한 번 조작(추가·삭제·위로·아래로). 번호는 1부터.
export function editFallback(list, {op, index, item}) {
  const next = [...(list ?? [])];
  if (op === 'add') return [...next, item];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 1 || i > next.length) throw new Error(`없는 폴백 번호: ${index} — 가능: ${next.length ? `1..${next.length}` : '없음'}`);
  if (op === 'remove') next.splice(i - 1, 1);
  else if (op === 'up' || op === 'down') {
    const j = op === 'up' ? i - 2 : i;
    if (j < 0 || j >= next.length) throw new Error(`${i}번은 더 ${op === 'up' ? '위로' : '아래로'} 옮길 수 없다`);
    [next[i - 1], next[j]] = [next[j], next[i - 1]];
  } else throw new Error(`알 수 없는 폴백 조작: ${op}`);
  return next;
}

function write(home, value) {
  const file = settingsPath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

// 처음 한 번 기존 agent-runners.json의 실행기 틀(runners[].spawn)만 옮겨 만든다. 역할 값은 set으로 채운다.
export function initSettings(home, {runnersFile = path.join(home, 'agent-runners.json'), by, reason, record}) {
  if (!reason?.trim()) throw new Error('이유가 필요하다 (--reason)');
  if (fs.existsSync(settingsPath(home))) throw new Error(`이미 있다: ${settingsPath(home)}`);
  const source = JSON.parse(fs.readFileSync(runnersFile, 'utf8'));
  const runners = {};
  // 실행기 이름은 agent-runners.json의 `id`에 있다(예전 예시는 `name`).
  for (const r of source.runners ?? []) {
    const name = r?.id ?? r?.name;
    if (typeof name !== 'string' || typeof r.spawn !== 'string') continue;
    runners[name === 'claude-code' ? 'claude' : name] = {spawn: r.spawn, ...(name === 'codex' ? {catalog: 'codex-models-cache'} : {models: []})};
  }
  if (!runners.codex) throw new Error('agent-runners.json에 codex 실행기 틀이 없다');
  const value = {version: 1, revision: 1, activePreset: 'B', presets: {B: {label: '값싼 병렬판', roles: {}}}, runners, families: DEFAULT_FAMILIES, blocked: []};
  write(home, value);
  record({kind: 'runner-settings', action: 'init', by, reason: reason.trim(), revision: 1, after: value});
  return value;
}

// 설정 한 곳을 고치는 공통 경로: revision 대조 → 변경 → 계열 확인 → 저장 → 원장 사건.
function change(home, {revision, by, reason, record, action}, apply) {
  if (!reason?.trim()) throw new Error('이유가 필요하다 (--reason)');
  const current = readSettings(home);
  if (!current) throw new Error('실행 모델 설정이 없다 — kadan runners init 먼저');
  if (Number(revision) !== current.revision) throw new Error(`설정이 바뀌었다(현재 revision ${current.revision}) — 다시 읽고 저장`);
  const next = structuredClone(current);
  const detail = apply(next);
  for (const preset of Object.values(next.presets)) checkPresetFamilies(preset, next.families);
  next.revision = current.revision + 1;
  write(home, next);
  record({kind: 'runner-settings', action, by, reason: reason.trim(), revision: next.revision, ...detail});
  return next;
}

// 실행기 명령 틀. codex처럼 모델 목록 파일을 쓰는 실행기는 catalog를 유지한다.
export function setRunner(home, {runner, spawn, ...meta}) {
  if (typeof runner !== 'string' || !VALUE.test(runner)) throw new Error('실행기 이름 필요');
  if (typeof spawn !== 'string' || !spawn.includes('{model}')) throw new Error('실행기 틀에는 {model}이 있어야 한다 (--spawn)');
  return change(home, {...meta, action: 'runner'}, next => {
    const before = next.runners[runner] ?? null;
    next.runners[runner] = {...(before ?? {models: []}), spawn};
    return {runner, before, after: next.runners[runner]};
  });
}

// 목록 파일이 없는 실행기의 실측 모델·강도.
export function setRunnerModel(home, {runner, model, efforts, ...meta}) {
  if (typeof model !== 'string' || !VALUE.test(model)) throw new Error('모델 이름 필요');
  const list = String(efforts ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (list.some(v => !VALUE.test(v))) throw new Error('강도 목록은 쉼표로 구분한 영문');
  return change(home, {...meta, action: 'model'}, next => {
    const spec = next.runners[runner];
    if (!spec) throw new Error(`등록되지 않은 실행기: ${runner}`);
    if (spec.catalog) throw new Error(`${runner}은 모델 목록 파일을 쓴다 — 직접 추가하지 않는다`);
    const before = spec.models.find(m => m.model === model) ?? null;
    spec.models = [...spec.models.filter(m => m.model !== model), {model, efforts: list}];
    return {runner, before, after: {model, efforts: list}};
  });
}

// 정책으로 막은 모델. roles를 비우면 모든 역할에서 막는다.
export function blockModel(home, {model, roles, ...meta}) {
  if (typeof model !== 'string' || !VALUE.test(model)) throw new Error('모델 이름 필요');
  const list = String(roles ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (list.some(r => !Object.values(PROFILE_ROLES).includes(r))) throw new Error(`역할은 ${Object.values(PROFILE_ROLES).join('|')}`);
  return change(home, {...meta, action: 'block'}, next => {
    const entry = {model, ...(list.length ? {roles: list} : {}), reason: meta.reason.trim()};
    next.blocked = [...(next.blocked ?? []).filter(b => b.model !== model), entry];
    return {after: entry};
  });
}

// 활성 프리셋 전환. 있는 프리셋만 고를 수 있고, 전환도 같은 공통 경로로 기록한다.
export function setActivePreset(home, {preset, ...meta}) {
  return change(home, {...meta, action: 'preset'}, next => {
    if (typeof preset !== 'string' || !Object.hasOwn(next.presets, preset)) throw new Error(`없는 프리셋: ${preset ?? '(없음)'}`);
    if (preset === next.activePreset) throw new Error(`이미 활성 프리셋: ${preset}`);
    const before = next.activePreset;
    next.activePreset = preset;
    return {before, after: preset};
  });
}

// 역할 하나의 값을 바꾼다. 선택지·강도·정책을 검사하고, 계열 확인과 기록은 공통 경로가 맡는다.
export function setRole(home, {role, runner, model, effort, preset, ...meta}) {
  if (!Object.values(PROFILE_ROLES).includes(role)) throw new Error(`역할은 ${Object.values(PROFILE_ROLES).join('|')}`);
  const {readCodexModels, ...rest} = meta;
  return change(home, {...rest, action: 'set'}, next => {
    const name = preset ?? next.activePreset;
    next.presets[name] ??= {label: name, roles: {}};
    const value = {runner, model, ...(effort != null ? {effort} : {})};
    checkChoice(next, role, value, readCodexModels ? {readCodexModels} : {});
    const before = next.presets[name].roles[role] ?? null;
    next.presets[name].roles[role] = value;
    return {preset: name, role, before, after: value};
  });
}

// 역할의 폴백 순서 목록 전체를 바꾼다(3단계). 항목마다 1순위와 같은 선택지·강도·정책 검사를 하고, 계열 확인은 공통 경로가 맡는다.
export function setFallback(home, {role, items, preset, ...meta}) {
  if (!Object.values(PROFILE_ROLES).includes(role)) throw new Error(`역할은 ${Object.values(PROFILE_ROLES).join('|')}`);
  if (!Array.isArray(items)) throw new Error('폴백 목록 필요');
  const {readCodexModels, ...rest} = meta;
  return change(home, {...rest, action: 'fallback'}, next => {
    const name = preset ?? next.activePreset;
    if (!next.presets[name]) throw new Error(`없는 프리셋: ${name}`);
    const list = items.map(({runner, model, effort}) => ({runner, model, ...(effort != null && effort !== '' ? {effort} : {})}));
    list.forEach((item, i) => {
      try { checkChoice(next, role, item, readCodexModels ? {readCodexModels} : {}); }
      catch (error) { throw new Error(`폴백 ${i + 1}번: ${error.message}`); }
    });
    const seen = new Set(list.map(item => JSON.stringify(item)));
    if (seen.size !== list.length) throw new Error('같은 폴백 항목이 두 번 있다');
    const before = next.presets[name].fallback?.[role] ?? [];
    if (JSON.stringify(before) === JSON.stringify(list)) throw new Error('바뀐 것이 없다');
    next.presets[name].fallback = {...(next.presets[name].fallback ?? {}), [role]: list};
    if (!list.length) delete next.presets[name].fallback[role];
    return {preset: name, role, before, after: list};
  });
}
