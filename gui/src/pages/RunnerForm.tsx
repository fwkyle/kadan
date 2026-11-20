import { useContext, useEffect, useId, useState } from "react";
import { save } from "../resource";
import { EMPTY_EFFORT_NOTE, NO_EFFORT_NOTE, afterModelChange, afterRunnerChange, effortNeeded, effortProblem, forRole, listProblem } from "../effort-keep";
import { listOf, ownPart } from "../runner-draft";
import { seniorPreview } from "../runner-preview";
import { AppContext, ErrorMessage } from "../ui";
import { ModelRegister } from "./ModelRegister";
import type { Choice, Settings, RunnersData } from "./Runners";
// 서버와 같다: 작업자 역할로 막은 모델은 어려운 일 작업자 자리에서도 막힌다.
const blocks = (b: { roles?: string[] }, role: string) =>
  !b.roles || b.roles.includes(role) || (role === "worker-hard" && b.roles.includes("worker"));
const label = (c: Choice) => [c.runner, c.model, c.effort].filter(Boolean).join(" / ");
export function RunnerForm({
  data,
  settings,
  role,
  fallback = false,
  stage,
  registered,
}: {
  data: RunnersData;
  settings: Settings;
  role: string;
  fallback?: boolean;
  stage: (role: string, fallback: boolean, choice: Choice, op: string) => void;
  // 바꾸기 창에서 새 모델을 등록했을 때(등록한 선택·새 설정 버전·대체 후보 칸 여부). 주면 '+ 새 모델 등록' 칸이 생긴다.
  registered?: (role: string, fallback: boolean, choice: Choice, revision: number) => void;
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
          : role === "secretary" && data.secretary
            ? [data.secretary.runner]
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
    // 고치는 중인 줄의 자리(0부터). null이면 아래 선택 칸은 새 줄 추가용이다.
    [editing, setEditing] = useState<number | null>(null),
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
      setEditing(null);
    } else if (part === base) setRevision(settings.revision);
    // 고치는 사이 목록이 바뀌었으면 옛 번호로 다른 줄을 덮지 않게 고치던 줄을 버린다(다시 고르게 한다).
    else setEditing(null);
  }, [settings, dirty, busy, base]);
  const spec = data.catalog[choice.runner],
    listed = spec?.models.find((m) => m.model === choice.model)?.efforts,
    // 방금 등록해 아직 목록에 안 뜬 모델이면 고른 강도라도 보이게 한다.
    efforts = listed ?? (choice.effort ? [choice.effort] : []);
  const change = (next: Choice) => {
    setChoice(next);
    if (fallback) setDirty(true);
    else stage(role, false, next, 'add');
  };
  // 등록한 모델을 바로 고른 상태로 둔다. 역할 줄은 변경안에 반영하고, 대체 후보 칸은 '추가'를 눌러야 반영한다.
  const picked = (next: Choice, newRevision: number) => {
    setChoice(next);
    setRevision(newRevision);
    if (fallback) setDirty(true);
    registered?.(role, fallback, next, newRevision);
  };
  const list = listOf(settings, role) as Choice[];
  // 강도를 비운 채로는 후보로 추가하지 못하고, 지금 값·이미 있는 후보와 같은 것도 추가하지 못한다.
  const current = settings.presets[settings.activePreset].roles[role];
  // 강도가 필요한지는 서버 checkChoice와 같게 역할 기준으로 본다(설명 AI는 exec 틀). 어느 쪽 문제든 저장·후보 추가를 막는다.
  const effortSpec = forRole(spec, role);
  const problem = effortProblem(effortSpec, choice);
  const pickEffort = problem === "pick";
  const emptyList = problem === "empty";
  const effortBlocked = problem !== null;
  const duplicate = !fallback ? null : listProblem(list, choice, {
    senior: role === "senior", editing,
    current: current && !Array.isArray(current) ? (current as Choice) : null,
  });
  // 목록이 받을 수 있는 최대 줄 수(서버와 같다): 시니어는 최대 인원, 설명 AI는 1순위를 뺀 시도 수. 가득 차도 줄 고치기는 된다.
  const limit = role === "senior" ? (data.senior?.max ?? 2) : role === "explain" ? (data.explain?.maxAttempts ?? 2) - 1 : null;
  const full = limit !== null && list.length >= limit;
  const fullNote = `최대 ${limit}${role === "senior" ? "명" : "개"}까지입니다 — 줄의 '수정'으로 바꾸거나 삭제한 뒤 추가하세요.`;
  // 작성하는 사이 이 목록이 다른 곳에서 바뀌었다: 옛 목록 기준의 추가·고치기를 반영하지 않는다.
  const stale = fallback && dirty && revision !== settings.revision;
  const startEdit = (i: number) => {
    const item = list[i];
    setEditing(i);
    setError(null);
    setChoice({ runner: item.runner, model: item.model, effort: item.effort || "" });
    setDirty(true);
  };
  const cancelEdit = () => {
    setEditing(null);
    setError(null);
    setDirty(false);
  };
  const favorites = settings.favorites || [];
  const blockedFor = (model: string) =>
    settings.blocked?.find(
      (b) => b.model === model && blocks(b, role),
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
    <>
    <form
      className="action-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !fallback) return;
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const op =
          submitter instanceof HTMLButtonElement ? submitter.value : "add";
        // 값을 쓰는 조작(추가·N번 자리 바꾸기)만 선택 칸을 검사한다. 위로·아래로·삭제는 선택 칸과 무관하다.
        const writes = op === "add" || op.startsWith("replace:");
        if (writes && !choice.model) {
          setError("모델을 고르세요.");
          return;
        }
        if (writes && (effortBlocked || duplicate || stale)) {
          setError(stale ? "목록이 바뀌었습니다. 지금 값을 불러온 뒤 다시 고르세요."
            : emptyList ? EMPTY_EFFORT_NOTE : pickEffort ? "강도를 고르세요." : duplicate);
          return;
        }
        if (op === "add" && full) {
          setError(fullNote);
          return;
        }
        setBusy(true);
        setError(null);
        try {
          stage(role, fallback, choice, op);
          setDirty(false);
          setEditing(null);
          context.draft(id, false);
          context.notice("변경안에 반영했습니다. 표 아래 저장을 눌러 적용하세요.");
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
              setEditing(null);
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
              <li key={i} className={editing === i ? "is-editing" : undefined}>
                {[item.runner, item.model, item.effort]
                  .filter(Boolean)
                  .join(" / ")}{" "}
                {editing === i && <span className="pending-mark">(고치는 중) </span>}
                <button type="button" disabled={editing === i} onClick={() => startEdit(i)}>
                  수정
                </button>
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
        {editing !== null && (
          <p className="edit-target">
            <strong>{editing + 1}번 줄 고치기</strong> — 아래에서 값을 고른 뒤 <strong>{editing + 1}번 자리 바꾸기</strong>를
            누르면 같은 자리의 값만 바뀝니다(순서·다른 줄은 그대로).
          </p>
        )}
        <div className="toolbar">
          <label>
            실행기
            <select
              value={choice.runner}
              onChange={(e) =>
                change(afterRunnerChange(Object.fromEntries(Object.entries(data.catalog).map(([k, v]) => [k, forRole(v, role)!])), choice, e.target.value))
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
                change(afterModelChange(effortSpec, choice, e.target.value))
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
                    b.model === m.model && blocks(b, role),
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
          {/* 강도가 필요한지는 역할 기준(effortSpec)으로 본다. 받지 않는 실행기는 꺼진 칸 대신 안내를 보인다. */}
          {effortSpec?.needsEffort ? (
            <label>
              추론 강도
              <select
                value={choice.effort || ""}
                onChange={(e) => change({ ...choice, effort: e.target.value })}
              >
                <option value="">강도 고르기</option>
                {efforts.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
            </label>
          ) : (
            spec && <span className="muted effort-note">{NO_EFFORT_NOTE}</span>
          )}
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
        {pickEffort && (
          <p className="warning">
            이 모델은 강도를 골라야 합니다. 지금 강도를 이어 쓸 수 없어 비워 두었습니다. 강도 고르기에서 고르세요.
          </p>
        )}
        {emptyList && <p className="warning">{EMPTY_EFFORT_NOTE}</p>}
        {duplicate && <p className="muted">{duplicate}</p>}
        {fallback && full && editing === null && <p className="muted">{fullNote}</p>}
        {choice.model && (
          <p>
            바뀔 명령:{" "}
            <code>
              {role === "watch"
                ? `KADAN_JUDGE_MODEL=${choice.model} KADAN_JUDGE_EFFORT=${choice.effort || "max"} watch-judge.sh (codex exec)`
                : role === "senior"
                  ? seniorPreview(choice)
                  : role === "explain"
                    ? "실행기 표의 exec 틀로 한 번 호출 (실행기 이름은 코드에 없음)"
                    : role === "secretary"
                    ? "비서를 다시 열 때 저장된 명령의 모델·강도만 바꿈: " +
                      `--model ${choice.model}${choice.effort ? ` -c model_reasoning_effort="${choice.effort}"` : ""}`
                    : spec?.spawn
                    .replaceAll("{model}", choice.model)
                    .replaceAll("{effort}", choice.effort || "")}
            </code>
          </p>
        )}
        {fallback && <button className="primary" value={editing === null ? "add" : `replace:${editing + 1}`}
          disabled={effortBlocked || Boolean(duplicate) || stale || (editing === null && full)}>
          {busy
            ? "저장 중…"
            : editing !== null
              ? `${editing + 1}번 자리 바꾸기`
              : role === "senior"
                ? "시니어 추가"
                : "대체 후보 추가"}
        </button>}
        {fallback && editing !== null && (
          <button type="button" onClick={cancelEdit}>
            취소
          </button>
        )}
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
    {registered && (
      <ModelRegister data={data} runner={choice.runner} revision={settings.revision}
        currentEffort={choice.effort} effortRequired={effortNeeded(spec, role)} done={picked} />
    )}
    </>
  );
}

