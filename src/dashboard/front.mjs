// 첫 화면 '내 앞' 띠 재료(PR1). 저장소별로 kyle 확인 필요 결정·머지 요청·막힘을 센다.
// 새 호출 없이 status가 이미 가진 결정·행을 쓴다(GitHub·칸반을 부르지 않는다).
import { isMergeRequest } from "../dashboard-kanban.mjs";

export const UNKNOWN_REPO = "저장소 모름";

// 카드·워크 키의 첫 마디가 저장소다(src/decisions.mjs:99와 같은 규칙). `work:` 접두어는 떼고,
// 슬래시가 없거나 첫 마디가 비면 모른다. PR2(저장소 선택)도 이 함수를 쓴다.
export function repoOfKey(key) {
  const text = String(key ?? "").replace(/^work:/, "");
  const head = text.includes("/") ? text.split("/")[0].trim() : "";
  return head || UNKNOWN_REPO;
}

const firstLine = (text) => String(text ?? "").split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
const cut = (text, n) => (text.length > n ? text.slice(0, n - 1) + "…" : text);

// decisions: 열린 결정 목록(null이면 읽지 못함). stoppedRows: 막힌·오래된 미확정 실행 행.
export function frontStrip({ decisions, stoppedRows }) {
  const repos = new Map();
  const slot = (repo) => {
    if (!repos.has(repo)) repos.set(repo, { repo, decisions: 0, merges: 0, stuck: 0 });
    return repos.get(repo);
  };
  const items = [];
  for (const d of decisions ?? []) {
    if (d.status !== "open") continue;
    const repo = repoOfKey(d.card ?? d.work);
    const merge = isMergeRequest(d);
    slot(repo)[merge ? "merges" : "decisions"] += 1;
    items.push({ id: d.id, repo, merge, requestedBy: d.requestedBy ?? null, at: d.at ?? null,
      title: cut(d.questionTitle ?? firstLine(d.question), 120) });
  }
  for (const row of stoppedRows) slot(row.repo || repoOfKey(row.key)).stuck += 1;
  const list = [...repos.values()].sort((a, b) =>
    (b.decisions + b.merges + b.stuck) - (a.decisions + a.merges + a.stuck) || a.repo.localeCompare(b.repo, "ko"));
  return { repos: list, decisions: decisions === null ? null : items };
}
