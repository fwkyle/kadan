import { time } from "../ui";
// 첫 화면 '내 앞' 띠(PR1) + 결정 목록·머지 요청 목록(PR2).
// 서버(src/dashboard/front.mjs)가 센 값을 그대로 그린다. 접기와 상관없이 늘 보인다.
export type FrontData = {
  repos: { repo: string; decisions: number | null; merges: number | null; stuck: number }[];
  decisions: { id: string; repo: string; merge: boolean; requestedBy: string | null; title: string; at?: string | null; mergeInfo?: MergeInfo }[] | null;
};
// 머지 요청 줄 정보(서버 src/dashboard/autopilot-view.mjs). 결정 글·검수 기록에 있는 것만 담는다.
export type MergeInfo = {
  prs: string[]; work: string | null; reviewSha: string | null; review: string; match: string | null;
  head: string | null; ci: string | null; ciAt: string | null;
};
const waited = (at: string | null | undefined, now: number) => {
  const start = Date.parse(at ?? "");
  if (!Number.isFinite(start) || now < start) return "";
  const minutes = Math.floor((now - start) / 60000);
  return minutes < 60 ? `${Math.max(minutes, 1)}분째 기다림` : minutes < 2880 ? `${Math.floor(minutes / 60)}시간째 기다림` : `${Math.floor(minutes / 1440)}일째 기다림`;
};
// 추측으로 ✔를 붙이지 않는다: 모르는 것은 모른다고 쓰고, 같음은 서버가 merge-check와 같은 규칙으로 판정했을 때만 보인다.
function MergeDetail({ d, now }: { d: Dec; now: number }) {
  const m = d.mergeInfo;
  if (!m) return null;
  const sha = m.reviewSha ? `검수 통과 SHA ${m.reviewSha.slice(0, 7)}` : m.review === "pass" ? "검수 통과 SHA 모름" : m.review;
  const same = m.match ? `커밋 ${m.match}` : "PR head 모름 — `kadan merge-check <업무> --head <SHA>`로 확인";
  const ci = m.ci ? `CI 기록: ${m.ci} (기록 ${m.ciAt ? time(m.ciAt) : "시각 모름"} · 현재 상태 미확인)` : "CI 기록 없음";
  return <small className="st-merge-detail">{[m.prs.length ? m.prs.map(p => "PR #" + p).join(", ") : null, waited(d.at, now) || null, sha, same, ci].filter(Boolean).join(" · ")}</small>;
}
const n = (value: number | null, label: string) =>
  <span className={"st-front-n" + (value ? " st-front-on" : "")}>{label} {value ?? "모름"}</span>;

type Dec = NonNullable<FrontData["decisions"]>[number];
const now = () => Date.now();
// 결정 목록과 머지 요청 목록을 따로 보인다. showRepo: 모든 저장소를 모아 볼 때만 저장소 이름을 붙인다.
export function FrontLists({decisions, showRepo}: {decisions: FrontData["decisions"]; showRepo: boolean}) {
  if (!decisions) return null;
  const list = (items: Dec[], id: string, title: string, empty: string) => <section id={id} className="st-front-sub" aria-label={title}>
    <h3>{title} <span className="st-cnt">{items.length}건</span></h3>
    {items.length === 0 ? <p className="st-front-empty">{empty}</p> : <ul className="st-front-decs">{items.map(d => <li key={d.id} className="st-front-dec">
      <span className="st-front-tag">{d.merge ? "머지 요청" : "결정"}{showRepo ? " · " + d.repo : ""}</span>
      <span>{d.title}</span>
      <MergeDetail d={d} now={now()}/>
      <a href={"#decision-" + encodeURIComponent(d.id)}>답하기</a>
    </li>)}</ul>}
  </section>;
  return <>
    {list(decisions.filter(d => !d.merge), "status-front-decisions", "내 결정 대기", "답할 결정이 없습니다.")}
    {list(decisions.filter(d => d.merge), "status-front-merges", "머지 요청", "머지 요청이 없습니다.")}
  </>;
}
export default function StatusFront({front}: {front?: FrontData | null}) {
  if (!front) return null;
  const quiet = front.repos.length === 0 && front.decisions !== null;
  return <section id="status-front" className="st-front" aria-label="내 앞">
    <h2>내 앞 · 저장소별</h2>
    {front.decisions === null && <p className="st-error" role="alert">결정 기록을 읽지 못해 결정·머지 수를 모릅니다.</p>}
    {quiet ? <p className="st-front-empty">지금 내 앞에 확인할 결정·머지 요청·막힌 일이 없습니다.</p>
      : front.repos.length > 0 && <ul className="st-front-repos">{front.repos.map(r => <li key={r.repo} className="st-front-repo">
          <strong>{r.repo}</strong>{n(r.decisions, "확인 필요")}{n(r.merges, "머지 요청")}{n(r.stuck, "막힘")}
        </li>)}</ul>}
    <FrontLists decisions={front.decisions} showRepo/>
  </section>;
}
