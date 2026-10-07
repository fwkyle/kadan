import type { Blip } from "./radar-blips";

// 우주 테마의 레이더(2026-10-07 [kyle]). 쓸고 지나가는 빛은 회전(transform)만 써서 가볍다. 점은 관심이 필요한 담당.
const LABEL = { alert: "경보", dead: "창 없음", stuck: "막힘", stale: "오래된 미정리" } as const;
export default function Radar({ blips }: { blips: Blip[] }) {
  const summary = blips.length ? blips.map((b) => `${b.role} ${LABEL[b.kind]}`).join(", ") : "관심이 필요한 담당 없음";
  return (
    <a className="radar" href="#strategy-map" title={summary} aria-label={`레이더: ${summary}. 누르면 전략 맵`}>
      <span className="radar-sweep" aria-hidden="true" />
      {blips.map((b) => {
        const rad = (b.angle * Math.PI) / 180;
        return <span key={b.role} className={"radar-blip radar-" + b.kind} aria-hidden="true"
          style={{ left: `${50 + Math.cos(rad) * b.r * 46}%`, top: `${50 + Math.sin(rad) * b.r * 46}%` }} />;
      })}
      <span className="radar-count" aria-hidden="true">{blips.length}</span>
    </a>
  );
}
