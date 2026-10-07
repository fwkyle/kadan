import { useResource } from "./resource";

// 우주 테마의 교신 로그(2026-10-07 [kyle]): 화면 아래로 최근 사건이 관제 무전처럼 흐른다. 활동 기록 API의 최신 12건.
// 마우스를 올리면 멈춘다. 움직임 줄이기 설정이면 흐르지 않고 첫 줄들만 보인다.
type Event = { at: string; label: string; by: string; target: string; kind: string };
const hhmm = (at: string) => (Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }) : "--:--");

export default function Comms() {
  const ledger = useResource<{ items: Event[] }>("ledger?logPage=1");
  const items = (ledger.data?.items ?? []).slice(0, 12);
  if (!items.length) return null;
  const line = items.map((e) => `${hhmm(e.at)} ${e.by} → ${e.target} · ${e.label}`);
  return (
    <div className="comms" role="log" aria-label="최근 교신(활동 기록)">
      <span className="comms-tag">COMMS</span>
      <div className="comms-window">
        <div className="comms-track" style={{ animationDuration: `${Math.max(40, line.join("").length / 6)}s` }}>
          {[0, 1].map((copy) => <span key={copy} aria-hidden={copy === 1 || undefined}>{line.map((text, i) => <span key={i} className="comms-item">{text}</span>)}</span>)}
        </div>
      </div>
    </div>
  );
}
