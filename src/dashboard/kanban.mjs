// 감독별 칸반 화면(읽기 전용). 계산은 src/dashboard-kanban.mjs, 여기는 자료를 모아 넘기고 ?owner= 거름만 한다.
import { registeredCenterWorks } from "../center-wall.mjs";
import { isExecution } from "../human-brief.mjs";
import { effectiveWorkOwner } from "../handover-state.mjs";
import { superProfiles } from "../super-role.mjs";
import { buildKanban } from "../dashboard-kanban.mjs";

export function kanbanData(snapshot, url, stamp, m) {
  const entries = snapshot.entries ?? [];
  const works = (registeredCenterWorks(snapshot).works ?? []).map((w) => ({ ...w, owner: effectiveWorkOwner(w, entries) }));
  const profiles = snapshot.ledgerLines === null ? null : superProfiles(entries);
  const kanban = buildKanban({
    rows: m.rows.filter((r) => r.kind !== "work" && isExecution(r)),
    works,
    decisions: snapshot.decisionError ? null : snapshot.decisions ?? [],
    hierarchy: m.hierarchy,
    profiles,
  });
  const owner = url.searchParams.get("owner");
  return {
    ...stamp,
    // 감독 고르기 목록은 거르기 전 전체 판으로 만든다.
    owners: kanban.boards.map((b) => b.label),
    owner: owner || null,
    ...kanban,
    boards: owner ? kanban.boards.filter((b) => b.label === owner) : kanban.boards,
    workError: m.workError ?? null,
    decisionError: snapshot.decisionError ?? null,
  };
}
