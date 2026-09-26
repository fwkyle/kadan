import { createContext, useContext, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { cardUrl, navigate } from "./navigation";
import { save } from "./resource";
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
}: {
  collectedAt?: string;
  refreshing: boolean;
  error: string | null;
  refresh: (force?: boolean) => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((x) => x + 1), 15000);
    return () => clearInterval(timer);
  }, []);
  const age = collectedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(collectedAt)) / 60000))
    : null;
  return (
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
}: {
  spec: FormSpec;
  entityKey?: string;
  revision?: number;
  onSaved?: (result: SaveResult) => void;
}) {
  const context = useContext(AppContext),
    id = useId();
  const initial = () =>
    Object.fromEntries(spec.fields.map((f) => [f.name, String(f.value ?? "")]));
  const [values, setValues] = useState(initial),
    [baseRevision, setRevision] = useState(revision),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    context.draft(id, dirty || busy);
    return () => context.draft(id, false);
  }, [context.draft, id, dirty, busy]);
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
