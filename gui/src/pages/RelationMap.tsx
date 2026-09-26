import { useState } from "react";
import type { Row } from "../types";
import { CardLink, Health } from "../ui";
function Cards({ rows }: { rows: Row[] }) {
  const [limit, setLimit] = useState(40);
  return (
    <>
      <div className="status-cards">
        {rows.slice(0, limit).map((row) => (
          <article className="work-tile" key={row.key}>
            <Health row={row} />
            <h3>
              <CardLink row={row} />
            </h3>
            <p>{row.flowLabel || row.purpose}</p>
            <small>
              {row.turnLabel} · {row.model}
            </small>
          </article>
        ))}
      </div>
      {rows.length > limit && (
        <button onClick={() => setLimit((n) => n + 40)}>
          다음 40장 · 남은 {rows.length - limit}장
        </button>
      )}
    </>
  );
}
export default function RelationMap({
  rows,
  works,
  parents,
  byRole,
}: {
  rows: Row[];
  works: Row[];
  parents: Record<string, string> | null;
  byRole: boolean;
}) {
  if (!byRole) {
    const cards = rows.filter((r) => r.kind !== "work"),
      visible = new Set(
        rows.filter((r) => r.kind === "work").map((r) => r.key),
      ),
      linked = new Map<string, Row[]>();
    for (const row of cards) {
      const key = row.parentWorkKey || "";
      if (!linked.has(key)) linked.set(key, []);
      linked.get(key)!.push(row);
    }
    const known = new Set(works.map((w) => w.key)),
      free = cards.filter((c) => !known.has(c.parentWorkKey || ""));
    return (
      <div className="relation-map">
        <p className="muted">업무 아래에 조건에 맞는 실행을 표시합니다.</p>
        {works
          .filter((w) => visible.has(w.key) || linked.has(w.key))
          .map((w) => (
            <details key={w.key} open>
              <summary>
                <CardLink row={w} /> · {w.flowPhase}
              </summary>
              <Cards rows={linked.get(w.key) || []} />
            </details>
          ))}
        {!!free.length && (
          <details open>
            <summary>연결 전 실행 · {free.length}장</summary>
            <Cards rows={free} />
          </details>
        )}
      </div>
    );
  }
  const byOwner = new Map<string, Row[]>();
  for (const row of rows) {
    const role = row.owner || "";
    if (!byOwner.has(role)) byOwner.set(role, []);
    byOwner.get(role)!.push(row);
  }
  const known = new Set([...byOwner.keys()].filter(Boolean));
  for (const role of [...known]) {
    const visited = new Set([role]);
    let parent = parents?.[role];
    while (parent && parent !== "@user" && !visited.has(parent)) {
      visited.add(parent);
      known.add(parent);
      parent = parents?.[parent];
    }
  }
  const children = new Map<string, string[]>();
  for (const role of known) {
    const parent = parents?.[role],
      key = parent && known.has(parent) && parent !== role ? parent : "";
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(role);
  }
  const render = (role: string, path: Set<string>) => {
    if (path.has(role)) return null;
    const next = new Set([...path, role]);
    return (
      <details open key={role}>
        <summary>
          {role || "담당 미배정"} · 카드 {byOwner.get(role)?.length || 0}장
        </summary>
        <Cards rows={byOwner.get(role) || []} />
        {children.get(role)?.map((child) => render(child, next))}
      </details>
    );
  };
  return (
    <div className="relation-map">
      <p className="muted">
        {parents
          ? "등록된 직속 상위에 따라 역할을 연결합니다."
          : "관계표를 읽지 못해 담당별로 묶었습니다."}
      </p>
      {(children.get("") || [...known]).map((role) => render(role, new Set()))}
      {byOwner.has("") && render("", new Set())}
    </div>
  );
}
