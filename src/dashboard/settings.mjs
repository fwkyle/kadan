// 새 카드 양식·결정 목록·실행 도구 설정 화면(DS-1-impl: dashboard-api.mjs에서 옮김).
import { createForm } from "../dashboard-forms.mjs";
import { decisionContent } from "../decision-wall.mjs";
import { page } from "./shared.mjs";
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
import { describeWindowSetting } from "../window-setting.mjs";

export function createData(snapshot, url, stamp) {
  return { ...stamp, form: createForm(url.searchParams.get("kind")) };
}

// 기본은 열린 결정만, 지난 결정(답변·취소)은 ?past=1&page=N 으로 나눠 받는다(2026-10-14: 140건 441KB를 매번 보냈다).
// 정렬은 ?sort=newest(기본 오래된 순), 기준은 화면에 보이는 시각(답변 시각, 없으면 요청 시각)이다.
export function decisionsData(snapshot, url, stamp) {
  if (snapshot.decisionError) throw new Error(snapshot.decisionError);
  const all = snapshot.decisions || [], withContent = (d) => ({ ...d, ...decisionContent(d) });
  if (url.searchParams.get("past") === "1") {
    const sign = url.searchParams.get("sort") === "newest" ? -1 : 1, at = (d) => Date.parse(d.answer?.at || d.at) || 0;
    const past = all.filter((d) => d.status !== "open").sort((x, y) => (at(x) - at(y)) * sign);
    const selected = page(past, url);
    return { ...stamp, ...selected, items: selected.items.map(withContent) };
  }
  return {
    ...stamp,
    items: all.filter((d) => d.status === "open").map(withContent),
    answered: all.filter((d) => d.status === "answered").length,
    past: all.filter((d) => d.status !== "open").length,
  };
}

export function runnersData(snapshot, url, stamp) {
  const settings = readSettings(snapshot.home);
  // 창 선택은 이 프로세스의 환경변수가 아니라 기계 설정(KADAN_HOME/window-setting.json) 값을 보여 준다.
  const window = describeWindowSetting(snapshot.home);
  if (!settings)
    return {
      ...stamp,
      window,
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
    window,
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
