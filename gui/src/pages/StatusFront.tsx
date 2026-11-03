// 첫 화면 '내 앞' 띠(PR1): 저장소별 kyle 확인 필요·머지 요청·막힘 수와 열린 결정 첫 줄.
// 서버(src/dashboard/front.mjs)가 센 값을 그대로 그린다. 접기와 상관없이 늘 보인다.
export type FrontData = {
  repos: { repo: string; decisions: number | null; merges: number | null; stuck: number }[];
  decisions: { id: string; repo: string; merge: boolean; requestedBy: string | null; title: string }[] | null;
};
const n = (value: number | null, label: string) =>
  <span className={"st-front-n" + (value ? " st-front-on" : "")}>{label} {value ?? "모름"}</span>;
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
    {front.decisions && front.decisions.length > 0 && <ul className="st-front-decs">{front.decisions.map(d => <li key={d.id} className="st-front-dec">
      <span className="st-front-tag">{d.merge ? "머지 요청" : "결정"} · {d.repo}</span>
      <span>{d.title}</span>
      <a href={"#decision-" + encodeURIComponent(d.id)}>답하기</a>
    </li>)}</ul>}
  </section>;
}
