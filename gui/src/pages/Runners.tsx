import { useContext, useEffect, useId, useState } from "react";
import { save, useResource } from "../resource";
import type { Stamp } from "../types";
import {
  ActionForm,
  AppContext,
  ErrorMessage,
  Freshness,
  JsonValue,
  Loading,
} from "../ui";
type Choice = { runner: string; model: string; effort?: string };
type Settings = {
  revision: number;
  activePreset: string;
  presets: Record<
    string,
    {
      label?: string;
      roles: Record<string, Choice>;
      fallback?: Record<string, Choice[]>;
    }
  >;
  blocked?: { model: string; roles?: string[]; reason: string }[];
};
type RunnersData = Stamp & {
  settings: Settings | null;
  roles: Record<string, string>;
  commands: Record<string, string>;
  catalog: Record<
    string,
    {
      spawn: string;
      needsEffort: boolean;
      error?: string;
      models: { model: string; efforts: string[] }[];
    }
  >;
  history: unknown[];
};
export default function Runners() {
  const resource = useResource<RunnersData>("runners"),
    data = resource.data;
  return (
    <section>
      <h1>실행 모델</h1>
      <p>다음 작업에 사용할 AI 도구·모델·강도를 역할별로 설정합니다. 변경은 다음 발령부터 적용됩니다.</p>
      <p className="muted">현재 열린 AI 창은 유지됩니다. 현재 실행 중인 모델은 <a href="#sessions">담당자 상태</a>에서 확인하세요.</p>
      <ErrorMessage error={resource.error} />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : !data.settings ? (
        <p>
          실행 모델 설정이 없습니다.{" "}
          <code>kadan runners init --reason 이유</code>로 먼저 설정하세요.
        </p>
      ) : (
        <>
          <p>
            활성 프리셋 <strong>{data.settings.activePreset}</strong> · 버전{" "}
            {data.settings.revision}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>역할</th>
                  <th>지금 값</th>
                  <th>발령 때 채워질 명령</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.roles).map(([role, label]) => {
                  const current =
                    data.settings!.presets[data.settings!.activePreset].roles[
                      role
                    ];
                  return (
                    <tr key={role}>
                      <th>{label}</th>
                      <td>
                        {current
                          ? [current.runner, current.model, current.effort]
                              .filter(Boolean)
                              .join(" / ")
                          : "미설정"}
                      </td>
                      <td>
                        <code>{data.commands[role]}</code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <h2>모델·대체 후보 변경</h2>
          <p className="muted">
            대체 후보(폴백)는 원인이 확인된 쿼터·로그인·모델 오류에만 사용합니다. 자동
            전환은 없습니다.
          </p>
          {Object.entries(data.roles).map(([role, label]) => (
            <details key={role}>
              <summary>{label} 바꾸기</summary>
              <RunnerForm data={data} settings={data.settings!} role={role} />
              <RunnerForm
                data={data}
                settings={data.settings!}
                role={role}
                fallback
              />
            </details>
          ))}
          <details>
            <summary>프리셋 전환</summary>
            <ActionForm
              revision={data.settings.revision}
              spec={{
                action: "/runners/preset",
                title: "프리셋 전환",
                fields: [
                  {
                    name: "preset",
                    label: "프리셋",
                    value: data.settings.activePreset,
                    type: "select",
                    options: Object.entries(data.settings.presets).map(
                      ([name, s]) => [name, s.label || name],
                    ),
                    required: true,
                  },
                  {
                    name: "reason",
                    label: "바꾸는 이유",
                    value: "",
                    type: "text",
                    options: null,
                    required: true,
                  },
                ],
              }}
            />
          </details>
          <details>
            <summary>최근 변경</summary>
            {data.history.map((h, i) => (
              <JsonValue key={i} value={h} />
            ))}
          </details>
        </>
      )}
    </section>
  );
}
function RunnerForm({
  data,
  settings,
  role,
  fallback = false,
}: {
  data: RunnersData;
  settings: Settings;
  role: string;
  fallback?: boolean;
}) {
  const context = useContext(AppContext),
    id = useId();
  const initial = () =>
    fallback
      ? { runner: Object.keys(data.catalog)[0] || "", model: "", effort: "" }
      : settings.presets[settings.activePreset].roles[role] || {
          runner: Object.keys(data.catalog)[0] || "",
          model: "",
          effort: "",
        };
  const [choice, setChoice] = useState<Choice>(initial),
    [revision, setRevision] = useState(settings.revision),
    [reason, setReason] = useState(""),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    context.draft(id, dirty || busy);
    return () => context.draft(id, false);
  }, [id, context.draft, dirty, busy]);
  useEffect(() => {
    if (!dirty && !busy) {
      setChoice(initial());
      setRevision(settings.revision);
    }
  }, [settings, dirty, busy]);
  const spec = data.catalog[choice.runner],
    efforts = spec?.models.find((m) => m.model === choice.model)?.efforts || [];
  const change = (next: Choice) => {
    setChoice(next);
    setDirty(true);
  };
  const list = settings.presets[settings.activePreset].fallback?.[role] || [];
  return (
    <form
      className="action-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const op =
          submitter instanceof HTMLButtonElement ? submitter.value : "add";
        if ((!fallback || op === "add") && !choice.model) {
          setError("모델을 고르세요.");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await save(
            fallback ? "/runners/fallback" : "/runners/set",
            {
              ...choice,
              effort: choice.effort || "",
              role,
              reason,
              revision: String(revision),
              op,
            },
            context.token,
          );
          setDirty(false);
          setReason("");
          context.draft(id, false);
          context.notice("저장했습니다. 다음 발령부터 적용됩니다.");
        } catch (e) {
          setError(e instanceof Error ? e.message : "저장 실패");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{fallback ? "대체 후보 순서" : "기본 실행 모델"}</h3>
      {dirty && revision !== settings.revision && (
        <p className="warning">
          작성 중 설정이 변경됐습니다. 입력을 유지하며 이전 버전으로의 저장은
          거부합니다.
        </p>
      )}
      <fieldset disabled={busy}>
        {fallback && (
          <ol>
            {list.map((item, i) => (
              <li key={i}>
                {[item.runner, item.model, item.effort]
                  .filter(Boolean)
                  .join(" / ")}{" "}
                <button name="op" value={"up:" + (i + 1)} disabled={i === 0}>
                  위로
                </button>
                <button
                  name="op"
                  value={"down:" + (i + 1)}
                  disabled={i === list.length - 1}
                >
                  아래로
                </button>
                <button name="op" value={"remove:" + (i + 1)}>
                  삭제
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="toolbar">
          <label>
            실행기
            <select
              value={choice.runner}
              onChange={(e) =>
                change({ runner: e.target.value, model: "", effort: "" })
              }
            >
              {Object.keys(data.catalog).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            모델
            <select
              value={choice.model}
              onChange={(e) =>
                change({
                  ...choice,
                  model: e.target.value,
                  effort:
                    spec?.models.find((m) => m.model === e.target.value)
                      ?.efforts[0] || "",
                })
              }
            >
              <option value="">모델 고르기</option>
              {choice.model &&
                !spec?.models.some((m) => m.model === choice.model) && (
                  <option>{choice.model}</option>
                )}
              {spec?.models.map((m) => {
                const blocked = settings.blocked?.find(
                  (b) =>
                    b.model === m.model && (!b.roles || b.roles.includes(role)),
                );
                return (
                  <option
                    key={m.model}
                    value={m.model}
                    disabled={Boolean(blocked)}
                  >
                    {m.model}
                    {blocked ? " · 차단: " + blocked.reason : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            추론 강도
            <select
              disabled={!spec?.needsEffort}
              value={choice.effort || ""}
              onChange={(e) => change({ ...choice, effort: e.target.value })}
            >
              <option value="">
                {spec?.needsEffort ? "강도 고르기" : "해당 없음"}
              </option>
              {efforts.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
        </div>
        <ErrorMessage error={spec?.error || null} />
        {choice.model && (
          <p>
            바뀔 명령:{" "}
            <code>
              {spec?.spawn
                .replaceAll("{model}", choice.model)
                .replaceAll("{effort}", choice.effort || "")}
            </code>
          </p>
        )}
        <label>
          바꾸는 이유
          <input
            required
            maxLength={500}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setDirty(true);
            }}
          />
        </label>
        <button className="primary" value="add">
          {busy ? "저장 중…" : fallback ? "대체 후보 추가" : "실행 모델 저장"}
        </button>
      </fieldset>
      <ErrorMessage error={error} />
    </form>
  );
}
