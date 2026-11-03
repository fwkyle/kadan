// 감독별·프로젝트별 칸반 화면(읽기 전용). 계산은 src/dashboard-kanban.mjs, 여기는 자료를 모아 넘기고 ?owner=·?group= 만 읽는다.
import { registeredCenterWorks } from "../center-wall.mjs";
import { isExecution } from "../human-brief.mjs";
import { effectiveWorkOwner } from "../handover-state.mjs";
import { superProfiles } from "../super-role.mjs";
import { buildKanban } from "../dashboard-kanban.mjs";
import { repoOfRow, repoOfDecision } from "./repo-view.mjs";

export function kanbanData(snapshot, url, stamp, m) {
  const entries = snapshot.entries ?? [];
  const works = (registeredCenterWorks(snapshot).works ?? []).map((w) => ({ ...w, owner: effectiveWorkOwner(w, entries) }));
  const profiles = snapshot.ledgerLines === null ? null : superProfiles(entries);
  const executions = m.rows.filter((r) => r.kind !== "work");
  const owner = url.searchParams.get("owner");
  // 기본 묶음은 프로젝트별(PR2). 감독별은 ?group=owner. 옛 ?group=project 주소도 그대로 프로젝트별이다.
  const group = url.searchParams.get("group") === "owner" ? "owner" : "project";
  // ?repo=<저장소>: 그 저장소 판만. 카드·워크·결정을 먼저 거른다(조율 카드 lookup은 결정 출처 찾기용이라 그대로).
  const repo = url.searchParams.get("repo") || null;
  const inRepo = (r) => !repo || repoOfRow(r) === repo;
  const decisions = snapshot.decisionError ? null : snapshot.decisions ?? [];
  const kanban = buildKanban({
    rows: executions.filter(isExecution).filter(inRepo),
    // 조율 카드는 판에 올리지 않지만 열린 결정의 출처로는 찾아야 한다.
    lookup: executions,
    works: works.filter(inRepo),
    decisions: repo && decisions ? decisions.filter((d) => repoOfDecision(d) === repo) : decisions,
    hierarchy: m.hierarchy,
    profiles,
    group,
    only: group === "project" && owner ? owner : null,
  });
  return {
    ...stamp,
    // 감독 고르기 목록은 거르기 전 전체 판으로 만든다(프로젝트별 보기에서는 판이 저장소라 감독 목록을 따로 모은다).
    owners: group === "project" ? kanban.supervisors : kanban.boards.map((b) => b.label),
    owner: owner || null,
    repo,
    ...kanban,
    boards: owner && group === "owner" ? kanban.boards.filter((b) => b.label === owner) : kanban.boards,
    workError: m.workError ?? null,
    decisionError: snapshot.decisionError ?? null,
  };
}
