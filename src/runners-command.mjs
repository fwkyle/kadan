import {blockModel, initSettings, launchFor, launchForFallback, parseFallbackSpec, readSettings, setActivePreset, setFallback, setRole, setFavorites, setRunner, setRunnerModel, settingsPath, watchJudgeCommand, PROFILE_ROLES} from './runner-settings.mjs';
import {seniorCommandLabel} from './senior.mjs';

export const RUNNERS_USAGE = 'kadan runners show | init --reason 이유 | set <worker|reviewer|conductor|super|watch|senior> --runner 실행기 --model 모델 [--effort 강도] --revision N --reason 이유 [--preset 이름] | runner <실행기> --spawn 명령틀 --revision N --reason 이유 | model <실행기> <모델> --efforts a,b --revision N --reason 이유 | block <모델> [--roles reviewer,...] --revision N --reason 이유 | preset <이름> --revision N --reason 이유 | fallback <worker|reviewer|conductor|super|watch> --set "실행기:모델[:강도],…" --revision N --reason 이유 [--preset 이름] (빈 글이면 목록 비움, senior는 폴백 없음) | favorite --set "실행기:모델[:강도],…" --revision N --reason 이유 (화면에서 한 번에 고르는 즐겨찾기, 빈 글이면 비움). 상세: docs/runner-settings.md';

export function runnersCommand([action, role, model], flags, {home, by, record}) {
  flags = {...flags, _model: model};
  if (flags.help || !action) return RUNNERS_USAGE;
  if (action === 'show') {
    const settings = readSettings(home);
    if (!settings) return {path: settingsPath(home), exists: false};
    const launch = Object.fromEntries(Object.keys(PROFILE_ROLES).map(profile => [profile, launchFor(settings, profile)?.cmd ?? null]));
    launch.watch = watchJudgeCommand(settings.presets[settings.activePreset].roles.watch);
    launch.senior = seniorCommandLabel(settings.presets[settings.activePreset].roles.senior);
    const fallbacks = settings.presets[settings.activePreset].fallback ?? {};
    const fallback = Object.fromEntries(Object.entries(fallbacks).map(([r, list]) =>
      [r, list.map((item, i) => ({...item, cmd: r === 'watch' ? watchJudgeCommand(item) : launchForFallback(settings, r, i + 1).cmd}))]));
    return {path: settingsPath(home), exists: true, revision: settings.revision, activePreset: settings.activePreset,
      roles: settings.presets[settings.activePreset].roles, launch, fallback, favorites: settings.favorites ?? []};
  }
  if (action === 'init') return initSettings(home, {by, reason: flags.reason, record});
  if (action === 'set') {
    return setRole(home, {role, runner: flags.runner, model: flags.model, effort: flags.effort, preset: flags.preset,
      revision: flags.revision, by, reason: flags.reason, record});
  }
  const meta = {revision: flags.revision, by, reason: flags.reason, record};
  if (action === 'runner') return setRunner(home, {runner: role, spawn: flags.spawn, ...meta});
  if (action === 'model') return setRunnerModel(home, {runner: role, model: flags._model, efforts: flags.efforts, ...meta});
  if (action === 'block') return blockModel(home, {model: role, roles: flags.roles, ...meta});
  if (action === 'preset') return setActivePreset(home, {preset: role, ...meta});
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
