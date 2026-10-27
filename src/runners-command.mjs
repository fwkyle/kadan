import {addPreset, blockModel, initSettings, PRESET_ACTIONS, removePreset, renamePreset, removeRunnerModel, launchFor, launchForFallback, parseFallbackSpec, readSettings, setActivePreset, setFallback, setRole, setSeniors, setFavorites, setRunner, setRunnerModel, settingsPath, watchJudgeCommand, explainCommand, PROFILE_ROLES} from './runner-settings.mjs';
import {exportPreset, importPreset, readExportFile, writeExportFile} from './runner-export.mjs';
import {seniorCommandLabel} from './senior.mjs';
import {detectRunners} from './quickstart.mjs';
import {compareState, setCompare} from './runner-compare.mjs';
import {compareReport, formatCompareReport} from './compare-report.mjs';

export const RUNNERS_USAGE = 'kadan runners show | init --reason 이유 | set <worker|reviewer|conductor|super|watch|senior|explain> --runner 실행기 --model 모델 [--effort 강도] --revision N --reason 이유 [--preset 이름] (senior는 --set "실행기:모델[:강도],…"로 최대 2명, 한 명이면 --runner/--model. 질문하면 등록된 전원에게 동시에 묻는다) | runner <실행기> [--spawn 명령틀] [--table JSON(resume·fork·exec·execField·version·update·listModels·conversation 칸. listModels는 모델 목록을 내는 명령, 자리 없음)] --revision N --reason 이유 | model <실행기> <모델> (--efforts a,b | --remove) --revision N --reason 이유 (--remove는 어디서도 안 쓰는 모델만 목록에서 뺀다) | block <모델> [--roles reviewer,...] --revision N --reason 이유 | preset <이름> --revision N --reason 이유 (활성 프리셋 전환) | preset add <이름> [--from 원본] --revision N --reason 이유 (원본, 기본은 활성 프리셋을 복사) | preset rename <옛> <새> --revision N --reason 이유 | preset remove <이름> --revision N --reason 이유 (활성 프리셋은 거절) | export <프리셋> [--out 파일] (프리셋 한 벌을 JSON으로 내보낸다. 기본은 표준 출력, --out은 KADAN_HOME 밖의 없는 파일만. 설정·원장은 바꾸지 않는다) | import <파일> [--as 이름] [--replace] --revision N --reason 이유 (프리셋 한 벌만 더한다. --replace는 기존 이름 한 벌을 교체한다. 이 기계에 없는 실행기·모델·강도가 있으면 전체 거절하고 등록 명령을 알려 준다. 활성 프리셋은 그대로) | fallback <worker|reviewer|conductor|super|watch|explain> --set "실행기:모델[:강도],…" --revision N --reason 이유 [--preset 이름] (빈 글이면 목록 비움, senior는 폴백 없음, explain은 대체 후보 1개까지) | favorite --set "실행기:모델[:강도],…" --revision N --reason 이유 (화면에서 한 번에 고르는 즐겨찾기, 빈 글이면 비움). 상세: docs/runner-settings.md';

export function runnersCommand([action, role, model, extra], flags, {home, by, record, detect = detectRunners}) {
  flags = {...flags, _model: model};
  if (flags.help || !action) return RUNNERS_USAGE + '\n'
    + 'kadan runners compare on --presets A,B --revision N --reason 이유 | compare off --revision N --reason 이유'
    + ' | compare show | report [--since ISO] [--json]';
  if (action === 'report') {
    const report = compareReport(home, {since: flags.since});
    return flags.json ? report : formatCompareReport(report);
  }
  if (action === 'compare') {
    if (role === 'show') return compareState(home);
    if (!['on', 'off'].includes(role)) throw new Error('kadan runners compare on|off|show');
    return setCompare(home, {enabled: role === 'on', presets: flags.presets,
      revision: flags.revision, reason: flags.reason, by, record});
  }
  if (action === 'show') {
    const settings = readSettings(home);
    if (!settings) return {path: settingsPath(home), exists: false};
    const launch = Object.fromEntries(Object.keys(PROFILE_ROLES).map(profile => [profile, launchFor(settings, profile)?.cmd ?? null]));
    launch.watch = watchJudgeCommand(settings.presets[settings.activePreset].roles.watch);
    launch.senior = seniorCommandLabel(settings.presets[settings.activePreset].roles.senior);
    launch.explain = explainCommand(settings, settings.presets[settings.activePreset].roles.explain);
    const fallbacks = settings.presets[settings.activePreset].fallback ?? {};
    const fallback = Object.fromEntries(Object.entries(fallbacks).map(([r, list]) =>
      [r, list.map((item, i) => ({...item, cmd: r === 'watch' ? watchJudgeCommand(item) : r === 'explain' ? explainCommand(settings, item) : launchForFallback(settings, r, i + 1).cmd}))]));
    return {path: settingsPath(home), exists: true, revision: settings.revision, activePreset: settings.activePreset,
      roles: settings.presets[settings.activePreset].roles, launch, fallback, favorites: settings.favorites ?? []};
  }
  if (action === 'init') {
    // 설치된 실행기(PATH)만 등록하고 기본 프리셋을 채운다. 채우지 못한 칸은 안내(notes)로 알린다.
    const notes = [];
    const settings = initSettings(home, {by, reason: flags.reason, record, detect: {installed: detect(), notes}});
    return {...settings, notes};
  }
  if (action === 'set' && role === 'senior' && flags.set != null) {
    if (typeof flags.set !== 'string' || flags.runner != null || flags.model != null) throw new Error("시니어 목록은 --set '실행기:모델[:강도],…' 하나로만 준다(--runner/--model과 함께 쓰지 않는다)");
    return setSeniors(home, {items: parseFallbackSpec(flags.set), preset: flags.preset, revision: flags.revision, by, reason: flags.reason, record});
  }
  if (action === 'set') {
    return setRole(home, {role, runner: flags.runner, model: flags.model, effort: flags.effort, preset: flags.preset,
      revision: flags.revision, by, reason: flags.reason, record});
  }
  const meta = {revision: flags.revision, by, reason: flags.reason, record};
  if (action === 'runner') {
    // --table '{"resume":"…","conversation":{…}}': spawn 옆 선택 칸. 값이 null이면 그 칸을 비운다.
    let table;
    if (typeof flags.table === 'string') { try { table = JSON.parse(flags.table); } catch { throw new Error('--table은 JSON 글이어야 한다'); } }
    return setRunner(home, {runner: role, spawn: typeof flags.spawn === 'string' ? flags.spawn : undefined, table, ...meta});
  }
  if (action === 'model' && flags.remove) return removeRunnerModel(home, {runner: role, model: flags._model, ...meta});
  if (action === 'model') return setRunnerModel(home, {runner: role, model: flags._model, efforts: flags.efforts, ...meta});
  if (action === 'block') return blockModel(home, {model: role, roles: flags.roles, ...meta});
  if (action === 'preset' && PRESET_ACTIONS.includes(role)) {
    if (role === 'add') return addPreset(home, {name: model, from: typeof flags.from === 'string' ? flags.from : undefined, ...meta});
    if (role === 'rename') return renamePreset(home, {from: model, to: extra, ...meta});
    return removePreset(home, {name: model, ...meta});
  }
  if (action === 'preset') return setActivePreset(home, {preset: role, ...meta});
  if (action === 'export') {
    const out = exportPreset(home, {name: role});
    if (flags.out == null) return out;
    if (typeof flags.out !== 'string' || !flags.out) throw new Error('--out에는 파일 경로가 필요하다');
    return {wrote: writeExportFile(home, flags.out, JSON.stringify(out, null, 2) + '\n'), preset: out.preset.name, runners: out.runners};
  }
  if (action === 'import') {
    if (typeof role !== 'string' || !role) throw new Error('가져올 파일 경로 필요: kadan runners import <파일> …');
    if (flags.replace !== undefined && flags.replace !== true) throw new Error('--replace는 값 없이 쓴다');
    return importPreset(home, {data: readExportFile(role), as: flags.as, replace: flags.replace === true, ...meta});
  }
  if (action === 'fallback') {
    if (typeof flags.set !== 'string') throw new Error("폴백 목록 필요: --set '실행기:모델[:강도],…' (비우려면 --set '')");
    return setFallback(home, {role, items: parseFallbackSpec(flags.set), preset: flags.preset, ...meta});
  }
  if (action === 'favorite') {
    if (typeof flags.set !== 'string') throw new Error("즐겨찾기 목록 필요: --set '실행기:모델[:강도],…' (비우려면 --set '')");
    return setFavorites(home, {items: parseFallbackSpec(flags.set), ...meta});
  }
  throw new Error(RUNNERS_USAGE);
}
