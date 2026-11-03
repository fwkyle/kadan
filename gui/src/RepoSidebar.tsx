import { useEffect, useState } from "react";
import { useResource } from "./resource";
import { repoSwitchUrl } from "./repo-nav";

export type SidebarRepo = { repo: string; decisions: number | null; merges: number | null; super: string | null };

// 사이드 탭(PR2): '전체' + 저장소마다 한 줄 + ⚑ 결정 대기 수 · ⇡ 머지 요청 수.
// 목록과 수는 status 응답의 sidebar 칸에서 온다(새 API 없음). 좁은 폭에서는 접히는 상단 선택으로 바뀐다.
const badge = (mark: string, label: string, n: number | null) =>
  n === 0 ? null : <span className="dw-side-badge" title={label}>{mark} {n ?? "?"}</span>;
const WIDE = "(min-width: 800px)";
export default function RepoSidebar({ url, repo }: { url: URL; repo: string | null }) {
  const resource = useResource<{ sidebar?: SidebarRepo[] }>("status" + (repo ? "?repo=" + encodeURIComponent(repo) : ""));
  const list = resource.data?.sidebar ?? [];
  const [open, setOpen] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const query = matchMedia(WIDE), sync = () => setOpen(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  // 좁은 화면에서는 저장소를 고르면(주소의 repo가 바뀌면) 선택 목록을 접어 본문을 보이게 한다.
  useEffect(() => { if (!matchMedia(WIDE).matches) setOpen(false); }, [repo]);
  const rows = repo && !list.some((r) => r.repo === repo) ? [...list, { repo, decisions: 0, merges: 0, super: null }] : list;
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
                <span className="dw-side-name">{r.repo}</span>
                {badge("⚑", "결정 대기", r.decisions)}{badge("⇡", "머지 요청", r.merges)}
                {r.super && <small className="dw-side-super">{r.super}</small>}
              </a>
            </li>
          ))}
        </ul>
        {!resource.data && !resource.error && <p className="dw-side-note">불러오는 중…</p>}
        {resource.error && <p className="dw-side-note">저장소 목록을 읽지 못했습니다.</p>}
      </details>
    </aside>
  );
}
