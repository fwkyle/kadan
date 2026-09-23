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

// 현재 설정으로 역할의 실행 명령을 만든다. 설정이 없거나 역할 값이 없으면 null.
export function launchFor(settings, profile) {
  const role = PROFILE_ROLES[profile];
  const value = role && settings?.presets[settings.activePreset].roles[role];
  if (!value) return null;
  const spawn = settings.runners[value.runner]?.spawn;
  if (!spawn) throw new Error(`실행 모델 설정의 실행기 틀 없음: ${value.runner}`);
  const cmd = spawn.replaceAll('{model}', value.model).replaceAll('{effort}', value.effort ?? '');
  return {cmd, role, preset: settings.activePreset, revision: settings.revision, ...value};
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
  for (const r of source.runners ?? []) if (r?.name && typeof r.spawn === 'string') {
    runners[r.name === 'claude-code' ? 'claude' : r.name] = {spawn: r.spawn, ...(r.name === 'codex' ? {catalog: 'codex-models-cache'} : {models: []})};
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
  for (const preset of Object.values(next.presets)) checkFamilies(preset.roles, next.families);
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
