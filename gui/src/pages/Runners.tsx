import { useContext, useEffect, useId, useState } from "react";
import { save, useResource } from "../resource";
import { ownPart } from "../runner-draft";
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
  favorites?: Choice[];
};
const label = (c: Choice) =>
  [c.runner, c.model, c.effort].filter(Boolean).join(" / ");
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
  // 감시 AI는 이 실행기만 고를 수 있고, 1순위 포함 최대 maxAttempts개를 자동으로 차례로 시도한다.
  watch?: { runner: string; maxAttempts: number };
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
          <div className="table-scroll runners-summary">
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
          <p className="muted">
            감시 AI만 예외입니다. 감시기가 스스로 부르므로, 1순위가 시간 초과·호출
            실패로 응답하지 못하면 대체 후보를 차례로 자동 시도합니다(1순위 포함 최대{" "}
            {data.watch?.maxAttempts ?? 3}개, 시도마다 5분 상한). 비워 두면 감시 프로필의
            KADAN_JUDGE_MODEL을 씁니다.
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
          <Favorites settings={data.settings} />
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
  // 감시 AI는 watch-judge.sh가 codex exec로 부르므로 그 실행기만 보여 준다. 판정은 서버가 다시 한다.
  const runners =
    role === "watch" && data.watch
      ? [data.watch.runner]
      : Object.keys(data.catalog);
  const applyNote =
    role === "watch" ? "다음 감시 호출부터 적용됩니다." : "다음 발령부터 적용됩니다.";
  const initial = () =>
    fallback
      ? { runner: runners[0] || "", model: "", effort: "" }
      : settings.presets[settings.activePreset].roles[role] || {
          runner: runners[0] || "",
          model: "",
          effort: "",
        };
  const [choice, setChoice] = useState<Choice>(initial),
    [revision, setRevision] = useState(settings.revision),
    [base, setBase] = useState(() => ownPart(settings, role, fallback)),
    [reason, setReason] = useState(""),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    context.draft(id, dirty || busy);
    return () => context.draft(id, false);
  }, [id, context.draft, dirty, busy]);
  useEffect(() => {
    if (busy) return;
    const part = ownPart(settings, role, fallback);
    if (!dirty) {
      setChoice(initial());
      setRevision(settings.revision);
      setBase(part);
    } else if (part === base) setRevision(settings.revision);
  }, [settings, dirty, busy, base]);
  const spec = data.catalog[choice.runner],
    efforts = spec?.models.find((m) => m.model === choice.model)?.efforts || [];
  const change = (next: Choice) => {
    setChoice(next);
    setDirty(true);
  };
  const list = settings.presets[settings.activePreset].fallback?.[role] || [];
  const favorites = settings.favorites || [];
  const blockedFor = (model: string) =>
    settings.blocked?.find(
      (b) => b.model === model && (!b.roles || b.roles.includes(role)),
    );
  // 즐겨찾기 한 번 누르면 세 칸을 채우고, 이유가 비어 있으면 이유도 채운다(2026-09-27 [kyle]: 매번 세 칸 고르기가 번거로웠다).
  const pick = (fav: Choice) => {
    change({
      runner: fav.runner,
      model: fav.model,
      effort: data.catalog[fav.runner]?.needsEffort ? fav.effort || "" : "",
    });
    if (!reason.trim()) setReason("즐겨찾기: " + label(fav));
  };
  const usable = (fav: Choice) =>
    runners.includes(fav.runner) &&
    Boolean(
      data.catalog[fav.runner]?.models.some((m) => m.model === fav.model),
    ) && !blockedFor(fav.model);
  const favoriteIndex = favorites.findIndex(
      (f) =>
        f.runner === choice.runner &&
        f.model === choice.model &&
        (f.effort || "") === (choice.effort || ""),
    ),
    isFavorite = favoriteIndex >= 0;
  const addFavorite = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await save(
        "/runners/favorite",
        {
          op: "add",
          ...choice,
          effort: choice.effort || "",
          reason: "즐겨찾기 추가",
          revision: String(settings.revision),
        },
        context.token,
      );
      // 즐겨찾기만 바뀌었으므로, 최신 기준으로 작성 중이던 칸은 새 버전으로 이어서 저장할 수 있다.
      if (saved.result.revision && revision === settings.revision)
        setRevision(saved.result.revision);
      context.notice("즐겨찾기에 넣었습니다: " + label(choice));
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="action-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const submitter = (event.nativeEvent as SubmitEvent).submitter,
          details = event.currentTarget.closest("details");
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
          if (fallback || op !== "add")
            context.notice("저장했습니다. " + applyNote);
          else {
            // 저장한 값이 위 요약표에 바로 보이도록 바꾸기 칸을 접고 표로 올린다(2026-09-27 [kyle]: 칸이 펼쳐진 채라 바뀐 게 안 보였다).
            context.notice(
              `${data.roles[role]} 실행 모델을 ${label(choice)}(으)로 저장했습니다. ${applyNote}`,
            );
            if (details) details.open = false;
            document
              .querySelector(".runners-summary")
              ?.scrollIntoView({ block: "nearest" });
          }
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
          작성하는 사이 다른 곳에서 이 {fallback ? "대체 후보 목록" : "역할의 값"}이
          바뀌었습니다
          {!fallback &&
            `(지금 값: ${
              settings.presets[settings.activePreset].roles[role]
                ? label(settings.presets[settings.activePreset].roles[role])
                : "미설정"
            })`}
          . 이대로는 저장되지 않습니다.{" "}
          <button
            type="button"
            onClick={() => {
              setDirty(false);
              setReason("");
              setError(null);
            }}
          >
            지금 값 불러오기
          </button>
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
              {runners.map((r) => (
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
          {favorites.length > 0 && (
            <label className="favorite-pick">
              즐겨찾기
              <select
                value={String(favoriteIndex)}
                onChange={(e) => {
                  const fav = favorites[Number(e.target.value)];
                  if (fav) pick(fav);
                }}
              >
                <option value="-1">즐겨찾기에서 고르기</option>
                {favorites.map((fav, i) => {
                  const blocked = blockedFor(fav.model);
                  return (
                    <option key={i} value={i} disabled={!usable(fav)}>
                      ★ {label(fav)}
                      {blocked
                        ? " · 차단: " + blocked.reason
                        : usable(fav)
                          ? ""
                          : runners.includes(fav.runner)
                            ? " · 지금 목록에 없는 모델"
                            : " · 이 역할에서 못 쓰는 실행기"}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
        </div>
        <ErrorMessage error={spec?.error || null} />
        {choice.model && (
          <p>
            바뀔 명령:{" "}
            <code>
              {role === "watch"
                ? `KADAN_JUDGE_MODEL=${choice.model} KADAN_JUDGE_EFFORT=${choice.effort || "max"} watch-judge.sh (codex exec)`
                : spec?.spawn
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
        {!fallback && (
          <button
            type="button"
            onClick={addFavorite}
            disabled={!choice.model || isFavorite}
          >
            {isFavorite ? "★ 즐겨찾기에 있음" : "☆ 이 조합 즐겨찾기"}
          </button>
        )}
      </fieldset>
      <ErrorMessage error={error} />
    </form>
  );
}

// 즐겨찾기 관리: 목록 보기와 삭제. 추가는 각 역할의 '이 조합 즐겨찾기' 버튼으로 한다.
function Favorites({ settings }: { settings: Settings }) {
  const context = useContext(AppContext),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const list = settings.favorites || [];
  const remove = async (i: number) => {
    setBusy(true);
    setError(null);
    try {
      await save(
        "/runners/favorite",
        {
          op: "remove:" + (i + 1),
          reason: "즐겨찾기 삭제",
          revision: String(settings.revision),
        },
        context.token,
      );
      context.notice("즐겨찾기에서 뺐습니다: " + label(list[i]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>즐겨찾기 관리 ({list.length}개)</summary>
      {list.length ? (
        <ul>
          {list.map((fav, i) => (
            <li key={i}>
              {label(fav)}{" "}
              <button type="button" disabled={busy} onClick={() => remove(i)}>
                삭제
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          아직 없습니다. 역할 바꾸기 칸에서 조합을 고르고 '이 조합 즐겨찾기'를
          누르세요.
        </p>
      )}
      <ErrorMessage error={error} />
    </details>
  );
}
