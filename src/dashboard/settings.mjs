// 새 카드 양식·결정 목록·실행 도구 설정 화면(DS-1-impl: dashboard-api.mjs에서 옮김).
import { createForm } from "../dashboard-forms.mjs";
import { decisionContent } from "../decision-wall.mjs";
import { withoutAuditFields } from "../decisions.mjs";
import { page } from "./shared.mjs";
import {
  readSettings,
  runnerChoices,
  launchFor,
  watchJudgeCommand,
  explainCommand,
  PROFILE_ROLES,
  WATCH_RUNNER,
  WATCH_MAX_ATTEMPTS,
  EXPLAIN_MAX_ATTEMPTS,
  SENIOR2_ALLOWED_RUNNERS,
  SENIOR2_GATE_NOTE,
} from "../runner-settings.mjs";
import { TABLE_KEYS } from "../runner-table.mjs";
import { RUNNER_ROLE_LABELS } from "../runner-settings-wall.mjs";
import { seniorCommandLabel, seniorSecondCommandLabel } from "../senior.mjs";
import { describeWindowSetting } from "../window-setting.mjs";

export function createData(snapshot, url, stamp) {
  return { ...stamp, form: createForm(url.searchParams.get("kind")) };
}

// 기본은 열린 결정만, 지난 결정(답변·취소)은 ?past=1&page=N 으로 나눠 받는다(2026-10-14: 140건 441KB를 매번 보냈다).
// 정렬은 ?sort=newest(기본 오래된 순), 기준은 요청 시각(at)이다. 전에 화면이 하던 정렬과 같다.
export function decisionsData(snapshot, url, stamp) {
  if (snapshot.decisionError) throw new Error(snapshot.decisionError);
  const all = snapshot.decisions || [];
  // 원격 답변의 감사 필드(이메일·sub·IP)는 기록에만 두고 화면 응답에는 싣지 않는다.
  const withContent = (d) => {
    return { ...withoutAuditFields(d), ...decisionContent(d) };
  };
  // ?id=<결정 ID>: 알림 링크가 연 결정 하나의 상태. 없으면 item이 null이다.
  if (url.searchParams.has("id")) {
    const found = all.find((d) => d.id === url.searchParams.get("id"));
    return { ...stamp, item: found ? withContent(found) : null };
  }
  if (url.searchParams.get("past") === "1") {
    const sign = url.searchParams.get("sort") === "newest" ? -1 : 1, at = (d) => Date.parse(d.at);
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

// 화면에 보이는 실행기 명령 표: spawn과 표 칸, conversation(JSON). catalog 실행기는 모델을 직접 등록하지 않는다.
const tableView = (spec) => ({
  spawn: spec.spawn,
  needsEffort: spec.spawn.includes("{effort}"),
  catalog: Boolean(spec.catalog),
  table: Object.fromEntries(TABLE_KEYS.map((key) => [key, spec[key] ?? ""])),
  conversation: spec.conversation ? JSON.stringify(spec.conversation, null, 2) : "",
  canListModels: !spec.catalog && typeof spec.listModels === "string" && Boolean(spec.listModels.trim()),
});

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
            ...tableView(spec),
            models: [...runnerChoices(settings, name)].map(
              ([model, efforts]) => ({ model, efforts }),
            ),
          },
        ];
      } catch (error) {
        return [
          name,
          {
            ...tableView(spec),
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
  commands.senior2 =
    seniorSecondCommandLabel(
      settings,
      settings.presets[settings.activePreset].roles.senior2,
    ) || "비어 있음 — kadan senior는 1번 자리만 부른다";
  commands.explain =
    explainCommand(settings, settings.presets[settings.activePreset].roles.explain) ||
    "미설정 — 설명 AI는 아무것도 하지 않는다";
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
    // 2번 자리는 같은 질문에 병렬로 답한다. 읽기 전용이 확인된 실행기만 열리며, 지금은 열린 실행기가 없다(막힘).
    senior2: { runners: SENIOR2_ALLOWED_RUNNERS, gate: SENIOR2_GATE_NOTE },
    // 설명 AI는 실행기 표에 exec 틀이 있는 실행기만 고를 수 있고, 1순위 포함 최대 N개를 차례로 시도한다.
    explain: {
      runners: Object.entries(settings.runners)
        .filter(([, spec]) => typeof spec.exec === "string" && spec.exec.trim())
        .map(([name]) => name),
      maxAttempts: EXPLAIN_MAX_ATTEMPTS,
    },
    roles: RUNNER_ROLE_LABELS,
    history: (snapshot.entries || [])
      .filter((e) => e.kind === "runner-settings")
      .slice(-10)
      .reverse(),
  };
}
