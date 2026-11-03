// 저장소 선택(PR2): status 응답을 `?repo=<저장소>`로 거르고 사이드 탭 재료를 만든다.
// 저장소 키는 카드·워크·결정 키의 첫 마디 하나뿐이다(front.mjs의 repoOfKey). 새 API·GitHub 호출 없음.
import { isMergeRequest, prNumbers } from "../dashboard-kanban.mjs";
import { repoOfKey, UNKNOWN_REPO } from "./front.mjs";

export const repoOfRow = (row) => row.repo || repoOfKey(row.key);
export const repoOfDecision = (d) => repoOfKey(d.card ?? d.work);

// 사이드 탭 목록: 행(워크·카드, 끝난 것 포함)과 열린 결정 키의 첫 마디 합집합.
// decisions가 null(결정 기록을 못 읽음)이면 결정·머지 수는 0이 아니라 모름(null)이다.
// 슈퍼감독 이름은 관계표를 아는 경우에 그 저장소 행을 가진 슈퍼감독만 적고, 모르면 null이다(추측 없음).
export function sidebarRepos({ rows, decisions, supervisors }) {
  const map = new Map();
  const slot = (repo) => {
    if (!map.has(repo)) map.set(repo, { repo, decisions: decisions === null ? null : 0, merges: decisions === null ? null : 0, super: null });
    return map.get(repo);
  };
  for (const row of rows) slot(repoOfRow(row));
  for (const d of decisions ?? []) slot(repoOfDecision(d))[isMergeRequest(d) ? "merges" : "decisions"] += 1;
  for (const item of supervisors?.items ?? [])
    for (const repo of item.repos ?? []) {
      const entry = map.get(repo);
      if (entry) entry.super = entry.super ? `${entry.super}, ${item.super}` : item.super;
    }
  return [...map.values()].sort((a, b) =>
    (a.repo === UNKNOWN_REPO) - (b.repo === UNKNOWN_REPO) || a.repo.localeCompare(b.repo, "ko"));
}

const sameDay = (iso, now) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && new Date(t).toDateString() === new Date(now).toDateString();
};
// '오늘 머지': GitHub를 부르지 않는다. 카단 기록으로 알 수 있는 것은 "오늘 답한 머지 요청 결정"뿐이다(PR 주소가 든 사용자 결정).
export function answeredMergesToday(decisions, repo, now = Date.now()) {
  if (decisions === null) return null;
  return decisions
    .filter((d) => d.status === "answered" && d.to === "@user" && prNumbers(d).length > 0 && repoOfDecision(d) === repo && sameDay(d.answer?.at, now))
    .map((d) => ({ id: d.id, prs: prNumbers(d), at: d.answer.at }));
}

// 경보는 저장소 칸이 없다. 그 저장소의 워크·카드를 맡은 역할이 받은 경보만 그 저장소 것으로 본다.
export function alertsOfRepo(allAlerts, owners) {
  if (allAlerts === null) return null;
  const items = allAlerts.items.filter((a) => owners.has(a.role) || owners.has(a.recipient));
  return { count: items.length, items: items.slice(0, 20) };
}
