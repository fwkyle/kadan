import {initSettings, launchFor, readSettings, setRole, settingsPath, PROFILE_ROLES} from './runner-settings.mjs';

export const RUNNERS_USAGE = 'kadan runners show | init --reason 이유 | set <worker|reviewer|conductor|super> --runner 실행기 --model 모델 [--effort 강도] --revision N --reason 이유 [--preset 이름]. 상세: docs/runner-settings.md';

export function runnersCommand([action, role], flags, {home, by, record}) {
  if (flags.help || !action) return RUNNERS_USAGE;
  if (action === 'show') {
    const settings = readSettings(home);
    if (!settings) return {path: settingsPath(home), exists: false};
    const launch = Object.fromEntries(Object.keys(PROFILE_ROLES).map(profile => [profile, launchFor(settings, profile)?.cmd ?? null]));
    return {path: settingsPath(home), exists: true, revision: settings.revision, activePreset: settings.activePreset,
      roles: settings.presets[settings.activePreset].roles, launch};
  }
  if (action === 'init') return initSettings(home, {by, reason: flags.reason, record});
  if (action === 'set') {
    return setRole(home, {role, runner: flags.runner, model: flags.model, effort: flags.effort, preset: flags.preset,
      revision: flags.revision, by, reason: flags.reason, record});
  }
  throw new Error(RUNNERS_USAGE);
}
