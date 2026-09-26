import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useResource } from "../resource";
import { cardUrl, navigate, patchLocation } from "../navigation";
import type { Row, Paged, Stamp, Summary } from "../types";
import {
  CardLink,
  ErrorMessage,
  Freshness,
  Health,
  Loading,
  Pages,
  time,
} from "../ui";
import RelationMap from "./RelationMap";
import { usePaneScroll } from "../scroll";
const Detail = lazy(() => import("./Detail"));
const stateLabels: Record<string, string> = {
  running: "작업 중",
  waiting: "결과 대기",
  unconfirmed: "발령됨",
  orphaned: "세션 확인 필요",
  failed: "실패 기록",
  hold: "보류",
  draft: "초안",
  ready: "발령 가능",
  assigned: "배정",
  done: "완료",
  cancelled: "취소",
  superseded: "대체됨",
  archived: "보관",
};
type WorkspaceData = Stamp &
  Omit<Paged<Row>, "items"> & {
    rows: Row[];
    facets: Record<string, string[]>;
    presets: Record<string, number>;
    hierarchy: Record<string, string> | null;
    workRows?: Row[];
    doneButOpen: { key: string; title: string; revision: number }[];
  };
type Column = {
  key: string;
  label: string;
  render: (row: Row) => React.ReactNode;
};
const baseColumns: Column[] = [
  {
    key: "title",
    label: "카드 · 목적",
    render: (row) => (
      <>
        <CardLink row={row} />
        <small title={row.purpose || row.summary}>{row.id || row.key}</small>
      </>
    ),
  },
  {
    key: "healthLabel",
    label: "실행 흐름",
    render: (row) => <Health row={row} />,
  },
  {
    key: "signalAt",
    label: "최근 실행 신호",
    render: (row) => <span title={row.signalLabel}>{time(row.signalAt)}</span>,
  },
  { key: "flowLabel", label: "티키타카", render: (row) => row.flowLabel },
  {
    key: "turnLabel",
    label: "현재 차례",
    render: (row) => <span title={row.turnReason}>{row.turnLabel}</span>,
  },
  {
    key: "model",
    label: "실행 모델",
    render: (row) => <span title={row.modelTitle}>{row.model || "—"}</span>,
  },
];
type ColumnPrefs = {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
};
function readColumns(): ColumnPrefs {
  try {
    const value = JSON.parse(
      localStorage.getItem("kadan.react.columns") || "null",
    );
    if (
      Array.isArray(value?.order) &&
      Array.isArray(value.hidden) &&
      value.widths &&
      typeof value.widths === "object"
    )
      return value;
  } catch {}
  return { order: [], hidden: [], widths: {} };
}

export default function Workspace({ url }: { url: URL }) {
  const summary = useResource<Summary>("summary");
  const params = url.searchParams,
    collection =
      params.get("collection") ||
      (params.get("card") && !params.get("card")!.startsWith("work:")
        ? "executions"
        : "work"),
    layout = params.get("layout") || "table";
  const request = new URLSearchParams(params);
  request.set("collection", collection);
  for (const k of [
    "card",
    "detail",
    "tab",
    "detailView",
    "expanded",
    "fresh",
    "decisionSort",
  ])
    request.delete(k);
  const tableScroll = usePaneScroll("workspace:" + request.toString());
  const resource = useResource<WorkspaceData>(
      "workspace?" + request.toString(),
    ),
    data = resource.data;
  const [query, setQuery] = useState(params.get("q") || ""),
    [columns, setColumns] = useState(readColumns),
    [splitWidth, setSplitWidth] = useState(45);
  const resizing = useRef<{ key: string; x: number; width: number } | null>(
    null,
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem("kadan.react.columns", JSON.stringify(columns));
      } catch {}
    }, 200);
    return () => clearTimeout(timer);
  }, [columns]);
  useEffect(() => {
    setQuery(params.get("q") || "");
  }, [params.get("q")]);
  useEffect(() => {
    if (query === (params.get("q") || "")) return;
    const timer = setTimeout(
      () => patchLocation({ q: query, page: null }, undefined, true),
      180,
    );
    return () => clearTimeout(timer);
  }, [query, params.get("q")]);
  const patch = (values: Record<string, string | null>) =>
    patchLocation({ bucket: null, ...values, page: null });
  const selected = params.get("card") || "",
    opened = Boolean(selected) && params.get("detail") !== "0",
    detailKey = opened
      ? selected
      : layout === "split"
        ? selected || data?.rows[0]?.key || ""
        : "";
  const available =
    collection === "work"
      ? baseColumns.map((c) =>
          c.key === "signalAt"
            ? {
                key: "stateLabel",
                label: "업무 상태",
                render: (r: Row) => r.stateLabel,
              }
            : c,
        )
      : baseColumns;
  const ordered = [...available].sort(
    (a, b) =>
      (columns.order.indexOf(a.key) < 0 ? 99 : columns.order.indexOf(a.key)) -
      (columns.order.indexOf(b.key) < 0 ? 99 : columns.order.indexOf(b.key)),
  );
  const visible = ordered.filter(
    (c) => (c.key === "title" || !columns.hidden.includes(c.key)) && (c.key !== "model" || data?.rows.some(row => row.model)),
  );
  const width = (key: string) =>
    Math.max(
      120,
      Math.min(
        900,
        Number(columns.widths[key]) || ({title:290,healthLabel:145,signalAt:135,flowLabel:170,turnLabel:140,model:110,stateLabel:105}[key] ?? 140),
      ),
    );
  const move = (key: string, to: number) => {
    const keys = ordered.map((c) => c.key),
      from = keys.indexOf(key);
    if (from < 0) return;
    keys.splice(from, 1);
    keys.splice(Math.max(0, Math.min(keys.length, to)), 0, key);
    setColumns({ ...columns, order: keys });
  };
  const sort = (key: string) =>
    patch({
      sort: key,
      dir:
        params.get("sort") === key && params.get("dir") === "asc"
          ? "desc"
          : "asc",
    });
  return (
    <section className="workspace" data-detail-open={Boolean(detailKey)}>
      <div className="page-heading">
        <div>
          <h1>{collection === "work" ? "업무 카드" : collection === "unlinked" ? "연결 전 실행" : "실행"}</h1>
          <p>업무의 약속과 실행의 현재 상태를 함께 확인합니다.</p>
        </div>
        <a href="#work-create" className="button">
          새 업무
        </a>
      </div>
      <div className="segmented" aria-label="작업 종류">
        {[
          ["work", "업무 카드"],
          ["executions", "모든 실행"],
          ["unlinked", "연결 전 실행"],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-pressed={collection === key}
            onClick={() =>
              patch({
                collection: key,
                card: null,
                detail: "0",
                q: null,
                board: null,
                repo: null,
              })
            }
          >
            {label} <span className="count">{summary.data?.counts[key === "executions" ? "executions" : key === "unlinked" ? "unlinked" : "work"] ?? "?"}</span>
          </button>
        ))}
      </div>
      <div className="toolbar">
        <label className="search">
          검색
          <input
            type="search"
            placeholder="제목·담당·다음 행동"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {[
          ["board", "판", "board"],
          ["repo", "저장소", "repo"],
          ["health", "실행 흐름", "healthLabel"],
          ["rally", "묶음", "flowTitle"],
        ].map(([key, label, facet]) => (
          <label key={key} data-filter={key}>
            {label}
            <select
              value={params.get(key) || ""}
              onChange={(e) => patch({ [key]: e.target.value })}
            >
              <option value="">전체</option>
              {key === "health" && <option value="stuck">지금 막힌 것</option>}
              {data?.facets[facet]?.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        ))}
        <button
          onClick={() =>
            patch({
              q: null,
              repo: null,
              board: null,
              health: null,
              rally: null,
              state: null,
            })
          }
        >
          초기화
        </button>
          <details className="state-filter">
            <summary>상태 선택</summary>
            {Object.entries(stateLabels).map(([value, label]) => {
              const selectedStates =
                params.get("state") === "all"
                  ? Object.keys(stateLabels)
                  : (
                      params.get("state") ||
                      "running,waiting,unconfirmed,orphaned,failed,hold,draft,ready,assigned"
                    ).split(",");
              return (
                <label className="check" key={value}>
                  <input
                    type="checkbox"
                    checked={selectedStates.includes(value)}
                    onChange={(e) =>
                      patch({
                        state:
                          (e.target.checked
                            ? [...selectedStates, value]
                            : selectedStates.filter((x) => x !== value)
                          ).join(",") || "none",
                      })
                    }
                  />
                  {label}
                </label>
              );
            })}
          </details>
        <div className="segmented dw-layout" aria-label="보기">
          {[
            ["table", "표 보기"],
            ["split", "목록·상세"],
            ["wall", "카드 월"],
            ["map", "관계도"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={layout === value}
              onClick={() => patch({ layout: value })}
            >
              {label}
            </button>
          ))}
          <a href="#operations-flow">업무 흐름</a>
        </div>
      </div>
      <div className="workspace-tools">
        <div className="segmented" aria-label="상태">
          {[
            ["", "미완료"],
            ["running,waiting", "진행 중·대기"],
            ["draft,ready", "발령 전"],
            ["assigned,unconfirmed,orphaned,failed", "확인 필요"],
            ["done", "완료"],
            ["all", "전체"],
          ].map(([state, label]) => (
            <button
              key={state}
              aria-pressed={(params.get("state") || "") === state}
              onClick={() => patch({ state })}
            >
              {label} <span className="count">{data?.presets[state] ?? "?"}</span>
            </button>
          ))}

        </div>

      </div>
      <ErrorMessage
        error={resource.error}
        retry={() => void resource.refresh(true)}
      />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div
            className="workspace-panes"
            style={
              detailKey
                ? {
                    gridTemplateColumns: `minmax(250px, ${splitWidth}fr) minmax(320px, ${100 - splitWidth}fr)`,
                  }
                : undefined
            }
            data-detail-open={Boolean(detailKey)}
          >
            <div className="workspace-list">
              {(layout === "table" || layout === "split") && (
                <>
                  <div className="column-tools">
                    <details>
                      <summary>표 열</summary>
                      {ordered.map((c, i) => (
                        <div key={c.key} className="column-choice">
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={visible.includes(c)}
                              disabled={c.key === "title"}
                              onChange={(e) =>
                                setColumns({
                                  ...columns,
                                  hidden: e.target.checked
                                    ? columns.hidden.filter((k) => k !== c.key)
                                    : [...columns.hidden, c.key],
                                })
                              }
                            />
                            {c.label}
                          </label>
                          <button
                            aria-label={c.label + " 열 앞으로"}
                            disabled={i === 0}
                            onClick={() => move(c.key, i - 1)}
                          >
                            ←
                          </button>
                          <button
                            aria-label={c.label + " 열 뒤로"}
                            disabled={i === ordered.length - 1}
                            onClick={() => move(c.key, i + 1)}
                          >
                            →
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() =>
                          setColumns({ order: [], hidden: [], widths: {} })
                        }
                      >
                        열 초기화
                      </button>
                    </details>
                    {detailKey && (
                      <label>
                        목록 너비
                        <input
                          type="range"
                          min="25"
                          max="65"
                          value={splitWidth}
                          onChange={(e) =>
                            setSplitWidth(Number(e.target.value))
                          }
                        />
                      </label>
                    )}
                  </div>
                  <div className="table-scroll" {...tableScroll}>
                    <table
                      className="workspace-table"
                      style={{
                        tableLayout: "fixed",
                        minWidth: "100%",
                        width: visible.reduce(
                          (sum, c) => sum + width(c.key),
                          0,
                        ),
                      }}
                    >
                      <colgroup>
                        {visible.map((c) => (
                          <col key={c.key} style={{ width: width(c.key) }} />
                        ))}
                      </colgroup>
                      <thead>
                        <tr>
                          {visible.map((c) => (
                            <th
                              key={c.key}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => {
                                e.preventDefault();
                                move(
                                  e.dataTransfer.getData("text/plain"),
                                  ordered.indexOf(c),
                                );
                              }}
                              aria-sort={
                                params.get("sort") === c.key
                                  ? params.get("dir") === "asc"
                                    ? "ascending"
                                    : "descending"
                                  : "none"
                              }
                            >
                              <button
                                draggable
                                onDragStart={(e) =>
                                  e.dataTransfer.setData("text/plain", c.key)
                                }
                                onKeyDown={(e) => {
                                  if (
                                    e.altKey &&
                                    [
                                      "ArrowLeft",
                                      "ArrowRight",
                                      "Home",
                                      "End",
                                    ].includes(e.key)
                                  ) {
                                    e.preventDefault();
                                    move(
                                      c.key,
                                      e.key === "Home"
                                        ? 0
                                        : e.key === "End"
                                          ? ordered.length - 1
                                          : ordered.indexOf(c) +
                                            (e.key === "ArrowLeft" ? -1 : 1),
                                    );
                                  }
                                }}
                                onClick={() => sort(c.key)}
                              >
                                {c.label}
                                {params.get("sort") === c.key
                                  ? params.get("dir") === "asc"
                                    ? " ↑"
                                    : " ↓"
                                  : ""}
                              </button>
                              <span
                                className="column-resize"
                                role="separator"
                                tabIndex={0}
                                aria-label={c.label + " 너비"}
                                aria-orientation="vertical"
                                aria-valuemin={120}
                                aria-valuemax={900}
                                aria-valuenow={width(c.key)}
                                onPointerDown={(e) => {
                                  e.preventDefault();
                                  e.currentTarget.setPointerCapture(
                                    e.pointerId,
                                  );
                                  resizing.current = {
                                    key: c.key,
                                    x: e.clientX,
                                    width: width(c.key),
                                  };
                                }}
                                onPointerMove={(e) => {
                                  const start = resizing.current;
                                  if (start?.key === c.key)
                                    setColumns((old) => ({
                                      ...old,
                                      widths: {
                                        ...old.widths,
                                        [c.key]: Math.max(
                                          120,
                                          Math.min(
                                            900,
                                            start.width + e.clientX - start.x,
                                          ),
                                        ),
                                      },
                                    }));
                                }}
                                onPointerUp={() => {
                                  resizing.current = null;
                                }}
                                onPointerCancel={() => {
                                  resizing.current = null;
                                }}
                                onKeyDown={(e) => {
                                  if (
                                    ["ArrowLeft", "ArrowRight"].includes(e.key)
                                  ) {
                                    e.preventDefault();
                                    setColumns({
                                      ...columns,
                                      widths: {
                                        ...columns.widths,
                                        [c.key]:
                                          width(c.key) +
                                          (e.key === "ArrowLeft" ? -20 : 20),
                                      },
                                    });
                                  }
                                }}
                                onDoubleClick={() =>
                                  setColumns({
                                    ...columns,
                                    widths: { ...columns.widths, [c.key]: 0 },
                                  })
                                }
                              />
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((row) => (
                          <tr
                            key={row.key}
                            className={detailKey === row.key ? "selected" : ""}
                            onClick={(event) => {
                              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                              if ((event.target as Element).closest('a,button,input,select,textarea,summary,[contenteditable="true"]') || window.getSelection()?.toString()) return;
                              navigate(cardUrl(row.key));
                            }}
                          >
                            {visible.map((c) => (
                              <td key={c.key}>{c.render(row)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pages
                    {...data}
                    onPage={(page) => patchLocation({ page: String(page) })}
                  />
                </>
              )}
              {layout === "wall" && (
                <>
                  <label>
                    묶는 기준
                    <select
                      value={params.get("axis") || "status"}
                      onChange={(e) => patch({ axis: e.target.value })}
                    >
                      <option value="status">상태</option>
                      <option value="step">연결 단계</option>
                    </select>
                  </label>
                  <Grouped
                    rows={data.rows}
                    field={
                      params.get("axis") === "step" ? "rallyStep" : "stateLabel"
                    }
                  />
                </>
              )}
              {layout === "map" && (
                <>
                  <label>
                    관계도 기준
                    <select
                      value={params.get("root") || "work"}
                      onChange={(e) => patch({ root: e.target.value })}
                    >
                      <option value="work">업무별</option>
                      <option value="role">담당별</option>
                    </select>
                  </label>
                  <RelationMap
                    rows={data.rows}
                    works={data.workRows || []}
                    parents={data.hierarchy}
                    byRole={params.get("root") === "role"}
                  />
                </>
              )}
              {!data.rows.length && (
                <p className="empty">조건에 맞는 카드가 없습니다.</p>
              )}
            </div>
            {detailKey && (
              <Suspense fallback={<Loading />}>
                <Detail key={detailKey} card={detailKey} url={url} />
              </Suspense>
            )}
          </div>
          {!!data.doneButOpen.length && (
            <details>
              <summary>실행 끝·카드 열림 {data.doneButOpen.length}장</summary>
              <p>후속 실행이 없는지 감독이 확인한 뒤 닫습니다.</p>
              {data.doneButOpen.map((c) => (
                <p key={c.key}>
                  <CardLink row={c} />
                  <code>{`kadan card update ${c.key} --revision ${c.revision} --status done --note "실행 완료 확정 뒤 카드 닫음"`}</code>
                </p>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}
function Grouped({
  rows,
  field,
}: {
  rows: Row[];
  field: "rallyStep" | "stateLabel" | "owner" | "parentWorkKey";
}) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = row[field] || "미연결";
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return (
    <div className="board-columns">
      {[...groups].map(([key, group]) => (
        <section key={key} className="board-column">
          <h2>
            {key} <small>{group.length}</small>
          </h2>
          {group.map((row) => (
            <article className="work-tile" key={row.key}>
              <Health row={row} />
              <h3>
                <a href={cardUrl(row.key)}>{row.title}</a>
              </h3>
              <p>{row.turnLabel}</p>
              <small>{row.flowLabel}</small>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
