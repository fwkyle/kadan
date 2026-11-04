import { useEffect, useState } from "react";
import { useResource } from "./resource";
import { repoSwitchUrl } from "./repo-nav";
import { SideNightBadge, useNightRepos } from "./NightParts";
import { groupByRepo, type NightStrip } from "./night-repos";

export type SidebarRepo = { repo: string; decisions: number | null; merges: number | null; super: string | null };

// 사이드 탭(PR2): '전체' + 저장소마다 한 줄 + ⚑ 결정 대기 수 · ⇡ 머지 요청 수.
// 목록과 수는 status 응답의 sidebar 칸에서 온다(새 API 없음). 좁은 폭에서는 접히는 상단 선택으로 바뀐다.
const badge = (mark: string, label: string, n: number | null) =>
  n === 0 ? null : <span className="dw-side-badge" title={label}>{mark} {n ?? "?"}</span>;
const WIDE = "(min-width: 800px)";
// 현황(#status) 화면에서만 status 응답을 읽는다(Status와 같은 주소라 요청이 늘지 않는다). 거기서만 슈퍼감독 이름을 알 수 있다.
function StatusSupers({ repo, onSupers }: { repo: string | null; onSupers: (names: Record<string, string>) => void }) {
  const { data } = useResource<{ sidebar?: SidebarRepo[] }>("status" + (repo ? "?repo=" + encodeURIComponent(repo) : ""));
  useEffect(() => {
    if (data?.sidebar) onSupers(Object.fromEntries(data.sidebar.flatMap((r) => (r.super ? [[r.repo, r.super]] : []))));
  }, [data, onSupers]);
  return null;
}
// 목록과 뱃지 수는 모든 화면이 이미 읽는 summary 응답의 sidebar 칸에서 온다(PR2 검수 S2). 그 밖의 화면에서는 status를 부르지 않는다.
export default function RepoSidebar({ url, repo, view, repos, night, failed }: { url: URL; repo: string | null; view: string; repos?: SidebarRepo[]; night?: NightStrip | null; failed?: boolean }) {
  const [supers, setSupers] = useState<Record<string, string>>({});
  const list = (repos ?? []).map((r) => ({ ...r, super: r.super ?? supers[r.repo] ?? null }));
  const [open, setOpen] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const query = matchMedia(WIDE), sync = () => setOpen(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  // 좁은 화면에서는 저장소를 고르면(주소의 repo가 바뀌면) 선택 목록을 접어 본문을 보이게 한다.
  useEffect(() => { if (!matchMedia(WIDE).matches) setOpen(false); }, [repo]);
  const rows = repo && !list.some((r) => r.repo === repo) ? [...list, { repo, decisions: 0, merges: 0, super: null }] : list;
  // 🌙 뱃지 재료: 페이지를 열 때 한 번만 읽는다(타이머 없음). 못 읽거나 맞는 줄이 없으면 뱃지를 달지 않는다(정책 없음으로 단정하지 않음).
  const nightRes = useNightRepos();
  const nightBy = nightRes.data ? groupByRepo(nightRes.data.repos, rows.map((r) => r.repo)).byRepo : new Map();
  // 켜짐 여부는 모든 화면이 15초마다 읽는 summary 응답의 night 칸이다. 아직 못 읽었으면 모름(null)이라 켜짐/꺼짐을 단정하지 않는다.
  const nightOn = night?.on ?? null;
  const total = (key: "decisions" | "merges") =>
    rows.some((r) => r[key] === null) ? null : rows.reduce((sum, r) => sum + (r[key] ?? 0), 0);
  return (
    <aside className="dw-side" aria-label="저장소 선택">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>저장소 · {repo ?? "전체"}</summary>
        <ul>
          <li>
            <a href={repoSwitchUrl(url, null)} data-repo-clear aria-current={repo ? undefined : "page"}>
              <span className="dw-side-name">전체</span>
              {badge("⚑", "결정 대기", total("decisions"))}{badge("⇡", "머지 요청", total("merges"))}
            </a>
          </li>
          {rows.map((r) => (
            <li key={r.repo}>
              <a href={repoSwitchUrl(url, r.repo)} aria-current={repo === r.repo ? "page" : undefined}>
                <span className="dw-side-name" title={r.repo}>{r.repo}</span>
                {badge("⚑", "결정 대기", r.decisions)}{badge("⇡", "머지 요청", r.merges)}
                <SideNightBadge lines={nightBy.get(r.repo)} on={nightOn} />
                {r.super && <small className="dw-side-super">{r.super}</small>}
              </a>
            </li>
          ))}
        </ul>
        {!repos && !failed && <p className="dw-side-note">불러오는 중…</p>}
        {failed && <p className="dw-side-note">저장소 목록을 읽지 못했습니다.</p>}
      </details>
      {view === "status" && <StatusSupers repo={repo} onSupers={setSupers} />}
    </aside>
  );
}
