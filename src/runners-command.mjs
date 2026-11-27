import {addPreset, blockModel, initSettings, PRESET_ACTIONS, removePreset, renamePreset, removeRunnerModel, launchFor, fallbackCommands, parseFallbackSpec, readSettings, setActivePreset, setFallback, setRole, setSeniors, setFavorites, setRunner, setRunnerModel, settingsPath, watchJudgeCommand, explainCommand, launchForHard, HARD_ROLE, PROFILE_ROLES, SECRETARY_ROLE} from './runner-settings.mjs';
import {secretaryCommandLabel} from './secretary-settings.mjs';
import {exportPreset, importPreset, readExportFile, writeExportFile} from './runner-export.mjs';
import {seniorCommandLabel} from './senior.mjs';
import {detectRunners} from './quickstart.mjs';
import {compareState, setCompare} from './runner-compare.mjs';
import {compareReport, formatCompareReport} from './compare-report.mjs';
import {isUserActor} from './actors.mjs';
import {previewAfterSettingsChange, relaunchLines, settingsBefore} from './relaunch-preview.mjs';

const MAX_QUOTE = 4000;

export const RUNNERS_USAGE = 'kadan runners show | init --reason 이유 | set <worker|reviewer|conductor|super|watch|senior|explain|worker-hard|secretary> --runner 실행기 --model 모델 [--effort 강도] --revision N --reason 이유 [--preset 이름] (worker-hard는 어려운 일 작업자 자리 — 선택 칸이고 start --profile worker --difficulty hard [--fallback N]이 쓴다. 비우기: set worker-hard --clear --revision N --reason 이유(그 자리의 대체 후보도 함께 지운다). secretary는 비서 자리 — 선택 칸이고 codex만 받는다. 비서를 새로 띄울 때가 아니라 같은 대화로 다시 열 때(restart 비서·up 복원·로티 탭 복원) 저장된 명령의 모델·강도만 이 값으로 바꾼다. 대체 후보는 없고 비우기는 set secretary --clear --revision N --reason 이유. senior는 --set "실행기:모델[:강도],…"로 최대 2명, 한 명이면 --runner/--model. 질문하면 등록된 전원에게 동시에 묻는다) | runner <실행기> [--spawn 명령틀] [--table JSON(resume·fork·exec·execField·version·update·listModels·conversation 칸. listModels는 모델 목록을 내는 명령, 자리 없음)] --revision N --reason 이유 | model <실행기> <모델> (--efforts a,b | --remove) --revision N --reason 이유 (--remove는 어디서도 안 쓰는 모델만 목록에서 뺀다) | block <모델> [--roles reviewer,...] --revision N --reason 이유 | preset <이름> --revision N --reason 이유 (활성 프리셋 전환) | preset add <이름> [--from 원본] --revision N --reason 이유 (원본, 기본은 활성 프리셋을 복사) | preset rename <옛> <새> --revision N --reason 이유 | preset remove <이름> --revision N --reason 이유 (활성 프리셋은 거절) | export <프리셋> [--out 파일] (프리셋 한 벌을 JSON으로 내보낸다. 기본은 표준 출력, --out은 KADAN_HOME 밖의 없는 파일만. 설정·원장은 바꾸지 않는다) | import <파일> [--as 이름] [--replace] --revision N --reason 이유 (프리셋 한 벌만 더한다. --replace는 기존 이름 한 벌을 교체한다. 이 기계에 없는 실행기·모델·강도가 있으면 전체 거절하고 등록 명령을 알려 준다. 활성 프리셋은 그대로) | fallback <worker|worker-hard|reviewer|conductor|super|watch|explain> --set "실행기:모델[:강도],…" --revision N --reason 이유 [--preset 이름] (빈 글이면 목록 비움, senior·secretary는 폴백 없음, worker-hard는 자리가 채워져 있을 때만, explain은 대체 후보 1개까지) | favorite --set "실행기:모델[:강도],…" --revision N --reason 이유 (화면에서 한 번에 고르는 즐겨찾기, 빈 글이면 비움). 상세: docs/runner-settings.md';

// 설정을 바꾼 명령 뒤에 "다시 띄워야 할 살아 있는 작업자·검수자"를 덧붙인다(막지 않는다). 발령 검사가 읽는 값이 그대로면 아무것도 붙이지 않는다.
// 바닥(floor)을 받은 호출(CLI)에서만 계산한다. 사람이 읽는 줄은 stderr, 같은 내용이 결과의 relaunchPreview 칸에 실린다.
export function runnersCommand(argv, flags, context) {
  if (!context.floor || flags.help) return runnersCommandInner(argv, flags, context);
  const before = settingsBefore(context.home);
  const result = runnersCommandInner(argv, flags, context);
  const preview = previewAfterSettingsChange(context.home, before, {floor: context.floor});
  if (!preview || !result || typeof result !== 'object') return result;
  for (const line of relaunchLines(preview)) process.stderr.write(`${line}\n`);
  return {...result, relaunchPreview: preview};
}

function runnersCommandInner([action, role, model, extra], flags, {home, by, record, detect = detectRunners}) {
  flags = {...flags, _model: model};
  // 역할 세션(사람 아님)이 --quote로 kyle 원문을 가져오면 설정 변경 사건에 원문과 viaChat을 남긴다(autopilot repo와 같은 모양). 사람 쓰기는 그대로다.
  const quote = !isUserActor(by) && typeof flags.quote === 'string' ? flags.quote.trim() : '';
  if (quote.length > MAX_QUOTE) throw new Error(`kyle 원문이 ${MAX_QUOTE}자를 넘습니다(${quote.length}자): 줄여서 다시 쓰세요`);
  if (quote && record) { const write = record; record = entry => write({...entry, quote, viaChat: true}); }
  if (flags.help || !action) return RUNNERS_USAGE + '\n'
    + 'kadan runners compare on --presets A,B --revision N --reason 이유 | compare off --revision N --reason 이유'
    + ' | compare show | report [--since ISO] [--until ISO] [--json]'
    + ' (모드와 무관하게 발령의 실제 조합별 성과. 기간을 안 주면 최근 14일)\n'
    + 'Autopilot이 켜진 동안 역할 세션은 쓰기 명령 끝에 --quote "<kyle 원문>"을 붙여야 쓸 수 있다(export --out 제외). 원문과 쓴 역할이 설정 변경 사건에 남는다.';
  if (action === 'report') {
    const report = compareReport(home, {since: flags.since, until: flags.until});
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
    launch[HARD_ROLE] = launchForHard(settings)?.cmd ?? '비어 있음 — 작업자와 같다';
    launch.watch = watchJudgeCommand(settings.presets[settings.activePreset].roles.watch);
    launch.senior = seniorCommandLabel(settings.presets[settings.activePreset].roles.senior);
    launch.explain = explainCommand(settings, settings.presets[settings.activePreset].roles.explain);
    // 비서 자리는 띄우는 명령이 아니라, 비서를 같은 대화로 다시 열 때 저장된 명령의 모델·강도를 바꾸는 값이다.
    launch[SECRETARY_ROLE] = secretaryCommandLabel(settings.presets[settings.activePreset].roles[SECRETARY_ROLE])
      ?? '비어 있음 — 저장된 명령 그대로 다시 연다';
    const fallbacks = settings.presets[settings.activePreset].fallback ?? {};
    const commands = fallbackCommands(settings);
    const fallback = Object.fromEntries(Object.entries(fallbacks).map(([r, list]) =>
      [r, list.map((item, i) => ({...item, cmd: commands[r][i]}))]));
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
    if (flags.clear !== undefined && flags.clear !== true) throw new Error('--clear는 값 없이 쓴다');
    if (flags.clear === true && (flags.runner != null || flags.model != null || flags.effort != null))
      throw new Error('--clear와 --runner/--model/--effort는 함께 쓸 수 없다');
    return setRole(home, {role, clear: flags.clear === true, runner: flags.runner, model: flags.model, effort: flags.effort, preset: flags.preset,
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
