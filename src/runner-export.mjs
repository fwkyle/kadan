// 프리셋 한 벌 내보내기·가져오기(PR1b). 파일에는 프리셋(roles·fallback·label)과 쓰는 실행기 이름만 담고,
// 실행기 명령 틀·경로·계정·revision·즐겨찾기는 싣지 않는다. 가져오기는 프리셋 한 벌만 더하고 받는 쪽 전역 규칙은 바꾸지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {
  EXPLAIN_MAX_ATTEMPTS, SETTINGS_ROLES, assertSeniorShape, change, checkChoice, checkNewPresetName, checkPresetFamilies,
  findBlocked, readSettings, runnerChoices, seniorList,
} from './runner-settings.mjs';

export const EXPORT_FORMAT = 'kadan-runner-export';
export const EXPORT_VERSION = 1;
const MAX_IMPORT_BYTES = 1024 * 1024;

// 내보내기에 실리면 안 되는 개인정보 꼴. 걸린 값은 출력하지 않고 칸 이름과 종류만 알린다.
const PRIVATE_PATTERNS = [
  ['개인 경로(사용자 폴더)', new RegExp(['', 'Users', ''].join('/'))], ['개인 경로(/home/)', /\/home\//], ['홈 경로(~/)', /~\//],
  ['홈 변수($HOME)', /\$\{?HOME\b/], ['윈도 경로', /[A-Za-z]:\\/], ['이메일', /[^\s@]+@[^\s@]+\.[^\s@]+/],
  ['토큰 꼴', /\b(?:sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_-]{10,}/],
];

// 값 전체(키 포함)를 훑어 개인정보 꼴이 있는 칸을 찾는다. 반환: [{at, kind}]
export function findPrivate(value, at = '$') {
  const hits = [];
  const scan = (text, where) => { for (const [kind, re] of PRIVATE_PATTERNS) if (re.test(text)) hits.push({at: where, kind}); };
  const walk = (v, where) => {
    if (typeof v === 'string') scan(v, where);
    else if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [key, item] of Object.entries(v)) {
      scan(key, `${where}.${key}(키)`);
      walk(item, `${where}.${key}`);
    }
  };
  walk(value, at);
  return hits;
}
const describeHits = hits => hits.map(h => `${h.at}(${h.kind})`).join(', ');

const pickChoice = ({runner, model, effort}) => ({runner, model, ...(effort != null ? {effort} : {})});

// 프리셋의 모든 값 자리: 역할 값(시니어는 목록)과 대체 후보. where는 사람이 읽는 위치.
function slots(preset) {
  const out = [];
  for (const [role, value] of Object.entries(preset.roles ?? {})) {
    const list = role === 'senior' ? seniorList(value) : [value];
    list.forEach((v, i) => out.push({role, value: v, where: role === 'senior' ? `senior ${i + 1}번` : role}));
  }
  for (const [role, list] of Object.entries(preset.fallback ?? {}))
    list.forEach((v, i) => out.push({role, value: v, where: `${role} 대체 후보 ${i + 1}번`}));
  return out;
}

let kadanVersion;
function currentVersion() {
  if (kadanVersion === undefined) {
    try { kadanVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null; }
    catch { kadanVersion = null; }
  }
  return kadanVersion;
}

// 프리셋 한 벌을 내보낼 값으로 만든다. 설정·원장은 읽기만 한다. 개인정보 꼴이 있으면 파일이 될 값을 돌려주지 않고 거절한다.
export function exportPreset(home, {name, now = () => new Date()}) {
  const settings = readSettings(home);
  if (!settings) throw new Error('실행 모델 설정이 없다 — kadan runners init 먼저');
  if (typeof name !== 'string' || !Object.hasOwn(settings.presets, name)) throw new Error(`없는 프리셋: ${name ?? '(없음)'}`);
  const preset = settings.presets[name];
  const roles = Object.fromEntries(Object.entries(preset.roles ?? {}).map(([role, value]) =>
    [role, role === 'senior' ? seniorList(value).map(pickChoice) : pickChoice(value)]));
  const fallback = Object.fromEntries(Object.entries(preset.fallback ?? {}).map(([role, list]) => [role, list.map(pickChoice)]));
  const used = slots({roles, fallback}).map(s => s.value.runner);
  const out = {
    format: EXPORT_FORMAT, version: EXPORT_VERSION, createdAt: now().toISOString(), kadanVersion: currentVersion(),
    preset: {name, label: preset.label ?? name, roles, fallback},
    runners: Object.keys(settings.runners).filter(r => used.includes(r)),
    families: settings.families ?? {},
    blocked: (settings.blocked ?? []).map(({model, roles: only, reason}) => ({model, ...(only ? {roles: only} : {}), reason})),
  };
  const hits = findPrivate(out, 'export');
  if (hits.length)
    throw new Error(`내보내기 중단: 개인정보 꼴이 있어 파일을 만들지 않았다 — ${describeHits(hits)}. 해당 칸을 고친 뒤 다시 내보낸다`);
  return out;
}

// --out 파일 쓰기. KADAN_HOME 안과 이미 있는 파일은 거절한다.
export function writeExportFile(home, out, text) {
  const target = path.resolve(out);
  const real = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  const homeReal = fs.existsSync(home) ? fs.realpathSync(home) : path.resolve(home);
  const rel = path.relative(homeReal, real);
  if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) throw new Error(`KADAN_HOME 안에는 내보내기 파일을 쓰지 않는다: ${real}`);
  try { fs.writeFileSync(real, text, {flag: 'wx'}); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`이미 있는 파일이라 덮어쓰지 않는다: ${real}`);
    throw error;
  }
  return real;
}

// 가져올 파일 읽기(크기 상한·JSON 검사).
export function readExportFile(file) {
  const size = fs.statSync(file).size;
  if (size > MAX_IMPORT_BYTES) throw new Error(`가져올 파일이 너무 크다(${size}바이트, 상한 ${MAX_IMPORT_BYTES})`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('가져올 파일이 JSON이 아니다'); }
}

const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);
function cleanChoice(v, where) {
  if (!isPlain(v) || typeof v.runner !== 'string' || typeof v.model !== 'string' || (v.effort != null && typeof v.effort !== 'string'))
    throw new Error(`파일 형식 오류: ${where}는 {runner, model[, effort]}여야 한다`);
  return pickChoice(v);
}

// 1단계: format·version과 모양. 모르는 칸은 버리고 알려진 칸만 새 객체로 옮긴다(파일의 객체를 그대로 저장하지 않는다).
function readExport(data) {
  if (!isPlain(data) || data.format !== EXPORT_FORMAT) throw new Error(`가져올 수 없는 파일: format이 ${EXPORT_FORMAT}이 아니다`);
  if (data.version !== EXPORT_VERSION) throw new Error(`지원하지 않는 version: ${String(data.version)} — 이 카단은 ${EXPORT_VERSION}만 읽는다`);
  const p = data.preset;
  if (!isPlain(p) || typeof p.name !== 'string' || !isPlain(p.roles)) throw new Error('파일 형식 오류: preset.name·preset.roles가 필요하다');
  if (p.label != null && (typeof p.label !== 'string' || p.label.length > 200)) throw new Error('파일 형식 오류: preset.label은 200자 이하 글이어야 한다');
  const roles = {};
  for (const [role, value] of Object.entries(p.roles)) {
    if (!SETTINGS_ROLES.includes(role)) throw new Error(`파일 형식 오류: 모르는 역할 ${role}`);
    if (role === 'senior') {
      const list = (Array.isArray(value) ? value : [value]).map((v, i) => cleanChoice(v, `roles.senior[${i}]`));
      try { assertSeniorShape(list); } catch (error) { throw new Error(`파일 형식 오류: ${error.message}`); }
      roles.senior = list;
    } else roles[role] = cleanChoice(value, `roles.${role}`);
  }
  const fallback = {};
  for (const [role, list] of Object.entries(p.fallback ?? {})) {
    if (!SETTINGS_ROLES.includes(role) || role === 'senior') throw new Error(`파일 형식 오류: 대체 후보를 둘 수 없는 역할 ${role}`);
    if (!Array.isArray(list)) throw new Error(`파일 형식 오류: fallback.${role}은 목록이어야 한다`);
    if (role === 'explain' && list.length + 1 > EXPLAIN_MAX_ATTEMPTS) throw new Error(`파일 형식 오류: 설명 AI 대체 후보는 ${EXPLAIN_MAX_ATTEMPTS - 1}개까지다`);
    if (list.length) fallback[role] = list.map((v, i) => cleanChoice(v, `fallback.${role}[${i}]`));
  }
  const families = data.families ?? {}, blocked = data.blocked ?? [], runners = data.runners ?? [];
  if (!isPlain(families) || !Object.values(families).every(v => Array.isArray(v) && v.every(x => typeof x === 'string')))
    throw new Error('파일 형식 오류: families는 {계열: [앞머리,…]}여야 한다');
  if (!Array.isArray(blocked) || !blocked.every(b => isPlain(b) && typeof b.model === 'string')) throw new Error('파일 형식 오류: blocked는 {model,…} 목록이어야 한다');
  if (!Array.isArray(runners) || !runners.every(r => typeof r === 'string')) throw new Error('파일 형식 오류: runners는 이름 목록이어야 한다');
  const hits = findPrivate(data, 'file');
  if (hits.length) throw new Error(`가져오기 거절: 파일에 개인정보 꼴이 있다 — ${describeHits(hits)}. 보낸 사람에게 고친 파일을 받는다`);
  return {
    preset: {label: p.label ?? p.name, roles, fallback}, name: p.name, families, blocked, runners,
  };
}

// 3단계: 이 기계에 없는 실행기·모델·강도를 전부 모으고, 고치는 명령을 붙인다. 모은 게 없으면 null.
function missingReport(next, preset, readCodexModels) {
  const runnerLines = new Map(), needs = new Map(), gaps = [], other = [];
  const choicesOf = new Map();
  const rank = {runner: 0, model: 1, effort: 2};
  const need = (runner, model, why, where, effort, have) => {
    const key = `${runner}\0${model}`;
    const item = needs.get(key) ?? {runner, model, why, where: [], efforts: new Set(have ?? [])};
    item.where.push(where);
    if (effort != null) item.efforts.add(effort);
    if (rank[why] < rank[item.why]) item.why = why;
    needs.set(key, item);
  };
  for (const {role, value, where} of slots(preset)) {
    const spec = next.runners[value.runner];
    if (!spec?.spawn) {
      runnerLines.set(value.runner, [...(runnerLines.get(value.runner) ?? []), where]);
      need(value.runner, value.model, 'runner', where, value.effort);
      continue;
    }
    if (!choicesOf.has(value.runner)) {
      try { choicesOf.set(value.runner, runnerChoices(next, value.runner, readCodexModels ? {readCodexModels} : {})); }
      catch (error) { choicesOf.set(value.runner, null); gaps.push(`${value.runner}: ${error.message} — ${spec.catalog ? 'codex를 한 번 실행해 모델 목록을 만든 뒤' : '목록을 확인한 뒤'} 다시`); }
    }
    const choices = choicesOf.get(value.runner);
    if (!choices) continue;
    if (!choices.has(value.model)) {
      if (spec.catalog) gaps.push(`${where}: ${value.runner} 모델 목록에 ${value.model}이 없다 — ${value.runner}를 최신으로 올려 한 번 실행해 목록을 갱신한 뒤 다시`);
      else need(value.runner, value.model, 'model', where, value.effort);
      continue;
    }
    const template = role === 'explain' ? spec.exec : spec.spawn;
    const takesEffort = typeof template === 'string' && template.includes('{effort}');
    const efforts = choices.get(value.model);
    if (takesEffort && value.effort != null && !efforts.includes(value.effort)) {
      if (spec.catalog) gaps.push(`${where}: ${value.runner}/${value.model}에 강도 ${value.effort}가 없다 — ${value.runner}를 최신으로 올려 목록을 갱신한 뒤 다시`);
      else need(value.runner, value.model, 'effort', where, value.effort, efforts);
      continue;
    }
    try { checkChoice(next, role, value, readCodexModels ? {readCodexModels} : {}, {checkBlocked: false}); }
    catch (error) { other.push(`${where}: ${error.message}`); }
  }
  if (!runnerLines.size && !needs.size && !gaps.length && !other.length) return null;
  const lines = ['가져오기 거절: 이 기계에 아직 없는 것이 있다. 설정은 바뀌지 않았다. 아래를 모두 등록한 뒤 import를 다시 실행한다 (N은 그때그때 kadan runners show의 revision)'];
  for (const [runner, where] of runnerLines)
    lines.push(`- 등록되지 않은 실행기: ${runner} (쓰는 곳: ${where.join(', ')})`,
      `  → kadan runners runner ${runner} --spawn '<명령 틀>' --revision N --reason <이유>`);
  for (const item of needs.values()) {
    const efforts = [...item.efforts];
    const label = {runner: '모델 등록(실행기 등록 뒤)', model: '등록되지 않은 모델', effort: '등록되지 않은 강도'}[item.why];
    lines.push(`- ${label}: ${item.runner}/${item.model} (쓰는 곳: ${item.where.join(', ')})`,
      `  → kadan runners model ${item.runner} ${item.model} --efforts ${efforts.length ? efforts.join(',') : '<강도,…>'} --revision N --reason <이유>`);
  }
  for (const g of gaps) lines.push(`- ${g}`);
  for (const o of other) lines.push(`- ${o}`);
  return lines.join('\n');
}

// 받는 쪽 전역 규칙과 파일의 규칙이 어떻게 다른지(정보만, 적용하지 않는다).
function ruleDifferences(next, file) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mine = next.families ?? {}, theirs = file.families;
  const blockKey = b => `${b.model}${b.roles ? `@${[...b.roles].sort().join(',')}` : ''}`;
  const myBlocked = new Map((next.blocked ?? []).map(b => [blockKey(b), b])), fileBlocked = new Map(file.blocked.map(b => [blockKey(b), b]));
  const diff = {
    families: {
      onlyInFile: Object.keys(theirs).filter(k => !Object.hasOwn(mine, k)),
      onlyHere: Object.keys(mine).filter(k => !Object.hasOwn(theirs, k)),
      different: Object.keys(theirs).filter(k => Object.hasOwn(mine, k) && !same(mine[k], theirs[k])),
    },
    blocked: {
      onlyInFile: [...fileBlocked.keys()].filter(k => !myBlocked.has(k)),
      onlyHere: [...myBlocked.keys()].filter(k => !fileBlocked.has(k)),
    },
    runners: {notRegisteredHere: file.runners.filter(r => !next.runners[r]?.spawn)},
  };
  diff.identical = Object.values(diff).every(group => Object.values(group).every(list => !list.length));
  return diff;
}

// 프리셋 한 벌만 더한다. 검사 순서(하나라도 걸리면 전체 거절, 저장·원장 없음): 파일 형식 → 이름 → 이 기계의 실행기·모델·강도 → 계열 → 차단.
// 활성 프리셋·실행기 표·계열 규칙·차단·즐겨찾기는 바꾸지 않는다.
export function importPreset(home, {data, as, readCodexModels, ...meta}) {
  if (as != null && typeof as !== 'string') throw new Error('--as에는 새 이름이 필요하다');
  const file = readExport(data);
  let differences;
  const next = change(home, {...meta, action: 'preset-import'}, settings => {
    const name = as ?? file.name;
    try { checkNewPresetName(settings, name); }
    catch (error) { throw new Error(`${error.message} (가져오려던 이름: ${name}) — 다른 이름으로 가져오려면 --as <새 이름>`); }
    const report = missingReport(settings, file.preset, readCodexModels);
    if (report) throw new Error(report);
    try { checkPresetFamilies(file.preset, settings.families); }
    catch (error) { throw new Error(`가져오기 거절: 이 기계의 계열 규칙에 걸린다 — ${error.message}`); }
    const blocked = slots(file.preset).map(({role, value, where}) => ({where, hit: findBlocked(settings, role, value.model), value})).filter(x => x.hit);
    if (blocked.length)
      throw new Error(`가져오기 거절: 이 기계에서 막은 모델이 있다 — ${blocked.map(b => `${b.where}: ${b.value.model} (${b.hit.reason})`).join('; ')}`);
    differences = ruleDifferences(settings, file);
    settings.presets[name] = structuredClone(file.preset);
    return {preset: name, source: file.name, after: settings.presets[name]};
  });
  const imported = as ?? file.name;
  return {imported, revision: next.revision, activePreset: next.activePreset, differences,
    next: `활성 프리셋은 그대로다. 쓰려면 kadan runners preset ${imported} --revision ${next.revision} --reason <이유>`};
}
