import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { cardUrl, navigate } from "./navigation";
import { save } from "./resource";
import { radioChecked } from "./form-state";
import type { SaveResult } from "./resource";
import type { Field, FormSpec, Row } from "./types";

const dateFormat = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export const time = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? dateFormat.format(new Date(value))
    : "시각 모름";
export const AppContext = createContext<{
  token: string;
  draft: (key: string, dirty: boolean) => void;
  notice: (text: string) => void;
}>({ token: "", draft: () => {}, notice: () => {} });
export function CardLink({
  row,
  children,
}: {
  row: Pick<Row, "key" | "title">;
  children?: ReactNode;
}) {
  return <a href={cardUrl(row.key)}>{children || row.title}</a>;
}
// 신호 맥박(2026-10-07): 마지막 신호가 최근일수록 빨리 뛴다. 2분 안 빠름, 15분 안 보통, 1시간 안 느림, 그보다 오래면 멈춤.
// 줄을 훑기만 해도 어디가 살아 있는지 보인다. 움직임은 화면 합성만 쓰는 크기·투명도(::after)라 상시 켜 두어도 가볍다.
export function Pulse({ at }: { at?: string | null }) {
  const age = at && Number.isFinite(Date.parse(at)) ? Date.now() - Date.parse(at) : Infinity;
  if (!Number.isFinite(age)) return null;
  const tier = age < 2 * 60_000 ? "fast" : age < 15 * 60_000 ? "mid" : age < 60 * 60_000 ? "slow" : "still";
  return <i className={"pulse pulse-" + tier} aria-hidden="true" />;
}
export function Health({
  row,
}: {
  row: Pick<Row, "healthKind" | "healthLabel" | "healthReason">;
}) {
  return (
    <span className={"health " + row.healthKind} title={row.healthReason}>
      {row.healthLabel || "모름"}
    </span>
  );
}
export function ErrorMessage({
  error,
  retry,
}: {
  error: string | null;
  retry?: () => void;
}) {
  return error ? (
    <div className="error" role="alert">
      {error}
      {retry && <button onClick={retry}>다시 읽기</button>}
    </div>
  ) : null;
}
export function Loading() {
  return (
    <p className="empty" role="status">
      자료를 읽는 중입니다.
    </p>
  );
}
export function Freshness({
  collectedAt,
  refreshing,
  error,
  refresh,
  footer = true,
}: {
  collectedAt?: string;
  refreshing: boolean;
  error: string | null;
  refresh: (force?: boolean) => void;
  footer?: boolean;
}) {
  const [, tick] = useState(0);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (footer) setTarget(document.getElementById("dashboard-freshness"));
  }, [footer]);
  useEffect(() => {
    const timer = setInterval(() => tick((x) => x + 1), 15000);
    return () => clearInterval(timer);
  }, []);
  const age = collectedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(collectedAt)) / 60000))
    : null;
  const content = (
    <div className="freshness" role="status">
      <span>
        {refreshing
          ? "갱신 중"
          : error
            ? "갱신 실패 · 이전 자료"
            : age !== null && age >= 1
              ? `${age}분 전 자료`
              : "최신 수집 자료"}{" "}
        · {time(collectedAt)}
      </span>
      <button onClick={() => refresh(true)} disabled={refreshing}>
        새로 읽기
      </button>
    </div>
  );
  return footer && target ? createPortal(content, target) : content;
}
export function Facts({
  items,
}: {
  items: [string, string | null | undefined][];
}) {
  return (
    <dl className="facts">
      {items.map(([label, value], i) => (
        <div key={label + i}>
          <dt>{label}</dt>
          <dd>{value || "미기록"}</dd>
        </div>
      ))}
    </dl>
  );
}
// Only HTML produced by the server's existing escaped document/summary renderers belongs here.
export function DocumentContent({ html }: { html: string }) {
  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
export function JsonValue({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
export function Pages({
  page,
  pages,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {total.toLocaleString()}건 · {page}/{pages}쪽
      </span>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        이전
      </button>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}>
        다음
      </button>
    </div>
  );
}

export function ActionForm({
  spec,
  entityKey,
  revision,
  onSaved,
  onDirtyChange,
}: {
  spec: FormSpec;
  entityKey?: string;
  revision?: number;
  onSaved?: (result: SaveResult) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const context = useContext(AppContext),
    id = useId();
  const initial = () =>
    Object.fromEntries(spec.fields.map((f) => [f.name, String(f.value ?? "")]));
  const [values, setValues] = useState(initial),
    [touched, setTouched] = useState<Record<string, boolean>>({}),
    [baseRevision, setRevision] = useState(revision),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    context.draft(id, dirty || busy);
    return () => context.draft(id, false);
  }, [context.draft, id, dirty, busy]);
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, dirty, busy]);
  useEffect(() => {
    if (
      !dirty &&
      !busy &&
      (revision === undefined ||
        baseRevision === undefined ||
        revision >= baseRevision)
    ) {
      setValues(
        Object.fromEntries(
          spec.fields.map((f) => [f.name, String(f.value ?? "")]),
        ),
      );
      setRevision(revision);
    }
  }, [spec, revision, baseRevision, dirty, busy]);
  const mainFieldCount =
    spec.action === "/cards/update"
      ? 3
      : spec.action === "/works/update"
        ? 4
        : spec.fields.length;
  const renderField = (field: Field) =>
    field.type === "hidden" ? (
      <input
        key={field.name}
        type="hidden"
        name={field.name}
        value={values[field.name] || ""}
        readOnly
      />
    ) : field.type === "radio" ? (
      <fieldset className="radio-options" key={field.name}>
        <legend>{field.label}</legend>
        {field.options?.map(([value, label]) => <label key={value} className={value === field.recommendedValue ? "recommended" : undefined}>
          <input type="radio" name={field.name} value={value} checked={radioChecked(values, touched, field.name, value)}
            onChange={() => { setValues({ ...values, [field.name]: value }); setTouched({ ...touched, [field.name]: true }); setDirty(true); }}/>
          <span className="radio-label">{label}</span>
          {value === field.recommendedValue && <span className="recommendation-badge">추천</span>}
        </label>)}
      </fieldset>
    ) : (
      <label key={field.name} htmlFor={id + field.name}>
        {field.label}
        {field.type === "textarea" ? (
          <textarea
            id={id + field.name}
            name={field.name}
            rows={3}
            required={field.required}
            value={values[field.name] || ""}
            onChange={(event) => {
              setValues({ ...values, [field.name]: event.target.value });
              setDirty(true);
            }}
          />
        ) : field.type === "select" ? (
          <select
            id={id + field.name}
            name={field.name}
            value={values[field.name] || ""}
            required={field.required}
            onChange={(event) => {
              setValues({ ...values, [field.name]: event.target.value });
              setDirty(true);
            }}
          >
            {field.options?.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id + field.name}
            name={field.name}
            type={field.type}
            required={field.required}
            value={values[field.name] || ""}
            onChange={(event) => {
              setValues({ ...values, [field.name]: event.target.value });
              setDirty(true);
            }}
          />
        )}
      </label>
    );
  return (
    <form
      className="action-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || spec.disabled) return;
        setBusy(true);
        setError(null);
        try {
          const result = await save(
            spec.action,
            {
              ...values,
              ...(entityKey ? { key: entityKey } : {}),
              ...(baseRevision !== undefined
                ? { revision: String(baseRevision) }
                : {}),
            },
            context.token,
          );
          setDirty(false);
          context.draft(id, false);
          setRevision(result.result.revision);
          context.notice("저장했습니다.");
          if (onSaved) onSaved(result);
          else if (spec.action.endsWith("/create"))
            navigate(result.location, false, true);
        } catch (error) {
          setError(error instanceof Error ? error.message : "저장 실패");
        } finally {
          setBusy(false);
        }
      }}
    >
      {dirty && revision !== baseRevision && (
        <p className="warning">
          작성 중 원본이 변경됐습니다. 현재 작성 내용은 유지합니다. 저장 전 최신
          기록을 확인하세요.
        </p>
      )}
      <fieldset disabled={busy || spec.disabled}>
        {spec.fields.slice(0, mainFieldCount).map(renderField)}
        {spec.fields.length > mainFieldCount && (
          <details>
            <summary>카드 구체화·상태 변경</summary>
            {spec.fields.slice(mainFieldCount).map(renderField)}
          </details>
        )}
        <button type="submit" className="primary">
          {busy ? "저장 중…" : spec.title}
        </button>
      </fieldset>
      {spec.disabled && (
        <p>
          현재 상태에서는 저장할 수 없습니다. 최신 상태와 남은 실행을
          확인하세요.
        </p>
      )}
      <ErrorMessage error={error} />
      {dirty && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setDirty(false);
            setRevision(revision);
            setError(null);
          }}
        >
          작성 취소·최신값으로
        </button>
      )}
      {!spec.action.startsWith("/decisions/") && (
        <p className="muted">
          등록·수정은 기록만 남깁니다. 담당 배정과 발령은 별도입니다.
        </p>
      )}
    </form>
  );
}

// 숫자가 바뀌면 0.6초 동안 굴러가듯 바꾼다(2026-10-07 모션). 움직임 줄이기 설정이면 바로 바꾼다.
export function Roll({ value }: { value: number }) {
  const [shown, setShown] = useState(value), from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value || matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(value); return; }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 600);
      setShown(Math.round(start + (value - start) * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <b className={shown !== value ? "rolling" : undefined}>{shown}</b>;
}

// 작은 활동 선 그래프(2026-10-07): 최근 1시간을 5분 칸으로 센 사건 수. 다 0이면 흐린 평평한 선.
export function Spark({ values, width = 48, height = 14 }: { values?: number[] | null; width?: number; height?: number }) {
  if (!values?.length) return null;
  const max = Math.max(1, ...values), step = width / Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 1 - (v / max) * (height - 3)).toFixed(1)}`).join(" ");
  const total = values.reduce((a, b) => a + b, 0);
  return <svg className={"spark" + (total ? "" : " spark-idle")} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`최근 1시간 활동 ${total}건`}>
    <polyline points={points} />
  </svg>;
}

// 지금 테마의 꾸밈(우주 등). 테마 버튼이 html의 data-skin을 바꾸면 따라 바뀐다.
export function useSkin() {
  const read = () => (typeof document === "undefined" ? undefined : document.documentElement.dataset.skin);
  const [skin, setSkin] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setSkin(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    return () => observer.disconnect();
  }, []);
  return skin;
}
