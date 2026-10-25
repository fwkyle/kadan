import { useContext, useEffect, useId, useState } from "react";
import { save } from "../resource";
import { listOf, ownPart } from "../runner-draft";
import { AppContext, ErrorMessage } from "../ui";
import type { Choice, Settings, RunnersData } from "./Runners";
const label = (c: Choice) => [c.runner, c.model, c.effort].filter(Boolean).join(" / ");
export function RunnerForm({
  data,
  settings,
  role,
  fallback = false,
  stage,
}: {
  data: RunnersData;
  settings: Settings;
  role: string;
  fallback?: boolean;
  stage: (role: string, fallback: boolean, choice: Choice, op: string) => void;
}) {
  const context = useContext(AppContext),
    id = useId();
  // 감시 AI는 watch-judge.sh가, 시니어는 senior.sh가 codex exec로 부르므로 그 실행기만 보여 준다. 판정은 서버가 다시 한다.
  const runners =
    role === "watch" && data.watch
      ? [data.watch.runner]
      : role === "senior" && data.senior
        ? data.senior.runners
        : role === "explain" && data.explain
          ? data.explain.runners
          : Object.keys(data.catalog);
  const initial = () =>
    fallback
      ? { runner: runners[0] || "", model: "", effort: "" }
      : (settings.presets[settings.activePreset].roles[role] as Choice | undefined) || {
          runner: runners[0] || "",
          model: "",
          effort: "",
        };
  const [choice, setChoice] = useState<Choice>(initial),
    [revision, setRevision] = useState(settings.revision),
    [base, setBase] = useState(() => ownPart(settings, role, fallback)),
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
    if (fallback) setDirty(true);
    else stage(role, false, next, 'add');
  };
  const list = listOf(settings, role) as Choice[];
  const favorites = settings.favorites || [];
  const blockedFor = (model: string) =>
    settings.blocked?.find(
      (b) => b.model === model && (!b.roles || b.roles.includes(role)),
    );
  // 즐겨찾기로 세 칸을 함께 채운다. 프리셋 저장 전까지는 화면의 변경안이다.
  const pick = (fav: Choice) => {
    change({
      runner: fav.runner,
      model: fav.model,
      effort: data.catalog[fav.runner]?.needsEffort ? fav.effort || "" : "",
    });
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
        if (busy || !fallback) return;
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
          stage(role, fallback, choice, op);
          setDirty(false);
          context.draft(id, false);
          context.notice("변경안에 반영했습니다. 프리셋 저장을 눌러 적용하세요.");
        } catch (e) {
          setError(e instanceof Error ? e.message : "저장 실패");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>
        {role === "senior"
          ? `등록된 시니어 (최대 ${data.senior?.max ?? 2}명, 전원에게 동시에 묻습니다)`
          : fallback
            ? "대체 후보 순서"
            : "기본 실행 모델"}
      </h3>
      {dirty && revision !== settings.revision && (
        <p className="warning">
          작성하는 사이 다른 곳에서 이 {fallback ? "대체 후보 목록" : "역할의 값"}이
          바뀌었습니다
          {!fallback &&
            `(지금 값: ${
              settings.presets[settings.activePreset].roles[role]
                ? label(settings.presets[settings.activePreset].roles[role] as Choice)
                : "미설정"
            })`}
          . 이대로는 저장되지 않습니다.{" "}
          <button
            type="button"
            onClick={() => {
              setDirty(false);
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
                  effort: spec?.needsEffort
                    ? spec.models.find((m) => m.model === e.target.value)?.efforts[0] || "" : "",
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
                : role === "senior"
                  ? `KADAN_SENIOR_MODEL=${choice.model} KADAN_SENIOR_EFFORT=${choice.effort || "max"} senior.sh (${choice.runner} exec, 저장소 읽기 전용)`
                  : role === "explain"
                    ? "실행기 표의 exec 틀로 한 번 호출 (실행기 이름은 코드에 없음)"
                    : spec?.spawn
                    .replaceAll("{model}", choice.model)
                    .replaceAll("{effort}", choice.effort || "")}
            </code>
          </p>
        )}
        {fallback && <button className="primary" value="add">
          {busy
            ? "저장 중…"
            : role === "senior"
              ? "시니어 추가"
              : fallback
                ? "대체 후보 추가"
                : "변경안에 반영"}
        </button>}
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

