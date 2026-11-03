// 첫 화면 '내 앞' 띠(PR1) + 결정 목록·머지 요청 목록(PR2).
// 서버(src/dashboard/front.mjs)가 센 값을 그대로 그린다. 접기와 상관없이 늘 보인다.
export type FrontData = {
  repos: { repo: string; decisions: number | null; merges: number | null; stuck: number }[];
  decisions: { id: string; repo: string; merge: boolean; requestedBy: string | null; title: string }[] | null;
};
const n = (value: number | null, label: string) =>
  <span className={"st-front-n" + (value ? " st-front-on" : "")}>{label} {value ?? "모름"}</span>;

type Dec = NonNullable<FrontData["decisions"]>[number];
// 결정 목록과 머지 요청 목록을 따로 보인다. showRepo: 모든 저장소를 모아 볼 때만 저장소 이름을 붙인다.
export function FrontLists({decisions, showRepo}: {decisions: FrontData["decisions"]; showRepo: boolean}) {
  if (!decisions) return null;
  const list = (items: Dec[], id: string, title: string, empty: string) => <section id={id} className="st-front-sub" aria-label={title}>
    <h3>{title} <span className="st-cnt">{items.length}건</span></h3>
    {items.length === 0 ? <p className="st-front-empty">{empty}</p> : <ul className="st-front-decs">{items.map(d => <li key={d.id} className="st-front-dec">
      <span className="st-front-tag">{d.merge ? "머지 요청" : "결정"}{showRepo ? " · " + d.repo : ""}</span>
      <span>{d.title}</span>
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
