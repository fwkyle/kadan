// 새 카드 양식·결정 목록·실행 도구 설정 화면(DS-1-impl: dashboard-api.mjs에서 옮김).
import { createForm } from "../dashboard-forms.mjs";
import { decisionContent } from "../decision-wall.mjs";
import {
  readSettings,
  runnerChoices,
  launchFor,
  watchJudgeCommand,
  PROFILE_ROLES,
  WATCH_RUNNER,
  WATCH_MAX_ATTEMPTS,
} from "../runner-settings.mjs";
import { RUNNER_ROLE_LABELS } from "../runner-settings-wall.mjs";
import { seniorCommandLabel } from "../senior.mjs";

export function createData(snapshot, url, stamp) {
  return { ...stamp, form: createForm(url.searchParams.get("kind")) };
}

export function decisionsData(snapshot, url, stamp) {
  if (snapshot.decisionError) throw new Error(snapshot.decisionError);
  return {
    ...stamp,
    items: (snapshot.decisions || []).map((d) => ({
      ...d,
      ...decisionContent(d),
    })),
  };
}

export function runnersData(snapshot, url, stamp) {
  const settings = readSettings(snapshot.home);
  if (!settings)
    return {
      ...stamp,
      settings: null,
      catalog: {},
      roles: RUNNER_ROLE_LABELS,
      history: [],
    };
  const catalog = Object.fromEntries(
    Object.entries(settings.runners).map(([name, spec]) => {
      try {
        return [
          name,
          {
            spawn: spec.spawn,
            needsEffort: spec.spawn.includes("{effort}"),
            models: [...runnerChoices(settings, name)].map(
              ([model, efforts]) => ({ model, efforts }),
            ),
          },
        ];
      } catch (error) {
        return [
          name,
          {
            spawn: spec.spawn,
            needsEffort: spec.spawn.includes("{effort}"),
            models: [],
            error: error.message,
          },
        ];
      }
    }),
  );
  const commands = Object.fromEntries(
    Object.keys(PROFILE_ROLES).map((role) => {
      try {
        return [role, launchFor(settings, role)?.cmd || "미설정"];
      } catch (error) {
        return [role, "모름: " + error.message];
      }
    }),
  );
  commands.watch =
    watchJudgeCommand(settings.presets[settings.activePreset].roles.watch) ||
    "미설정 — 감시 프로필의 KADAN_JUDGE_MODEL 사용";
  commands.senior =
    seniorCommandLabel(settings.presets[settings.activePreset].roles.senior) ||
    "미설정 — kadan senior가 거절한다";
  return {
    ...stamp,
    settings,
    catalog,
    commands,
    // 감시 AI는 codex만 고를 수 있고, 1순위 포함 최대 N개를 자동으로 차례로 시도한다.
    watch: { runner: WATCH_RUNNER, maxAttempts: WATCH_MAX_ATTEMPTS },
    // 시니어도 codex만 고르고(senior.sh), 폴백 없이 한 번 부른다.
    senior: { runner: WATCH_RUNNER },
    roles: RUNNER_ROLE_LABELS,
    history: (snapshot.entries || [])
      .filter((e) => e.kind === "runner-settings")
      .slice(-10)
      .reverse(),
  };
}
