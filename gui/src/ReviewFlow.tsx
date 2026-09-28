import {useState} from "react";
import type {ReviewFlow as Flow, ReviewStage} from "./types";
import {useResource} from "./resource";
import {CardLink, DocumentContent, ErrorMessage, Loading, time} from "./ui";

function Result({card}: {card: string}) {
  const resource = useResource<{html: string | null; error?: string}>(
    "review-result?card=" + encodeURIComponent(card), {pollMs: 0, staleMs: 0},
  );
  return <>
    <ErrorMessage error={resource.error || resource.data?.error || null} />
    {!resource.data && !resource.error ? <Loading /> : resource.data?.html && <DocumentContent html={resource.data.html} />}
  </>;
}

function Stage({stage, selected}: {stage: ReviewStage; selected?: string}) {
  const [open, setOpen] = useState(false);
  return <div className={"review-stage" + (stage.key === selected ? " selected" : "")}>
    <strong className={"review-outcome " + (stage.outcome || "pending")}>{stage.outcomeLabel}</strong>
    <CardLink row={stage} />
    <small>{stage.role || "담당 미배정"} · {stage.stateLabel}</small>
    {stage.resultAt && <small>결과 등록 {time(stage.resultAt)} · {stage.resultBy || "기록자 모름"}</small>}
    {stage.stale && <p className="review-warning">이후 발령·범위 변경이 있거나 시각을 확인할 수 없어 이전 결과는 현재 판정에서 제외했습니다.</p>}
    {stage.hasResult && <details onToggle={e => setOpen(e.currentTarget.open)}>
      <summary>{stage.step === "review" ? "검수 지적·근거 읽기" : "수정·구현 결과 읽기"}</summary>
      {open && <Result card={stage.key} />}
    </details>}
  </div>;
}

export function ReviewFlow({flow, selected, compact = false}: {flow: Flow; selected?: string; compact?: boolean}) {
  return <section className="review-flow" aria-label={"티키타카 · " + flow.title}>
    <header><h3>{flow.title}</h3><strong className={"review-outcome " + flow.verdict}>{flow.summary}</strong></header>
    {flow.warnings.length > 0 && <ul className="review-warning">{flow.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
    <details open={!compact} data-section="group">
      <summary>라운드별 구현·수정과 검수 · {flow.cardKeys.length}장</summary>
      <p className="muted">구현·수정과 독립검수가 한 라운드입니다. 횟수는 등록된 결과 기준이며, 실행 완료와 검수 통과는 별개입니다.</p>
      <div className="review-rounds">
        <table>
          <thead><tr><th scope="col">라운드</th><th scope="col">구현·수정</th><th scope="col">독립검수</th></tr></thead>
          <tbody>{flow.rounds.map(round => <tr key={round.number}>
            <th scope="row">{round.number}차</th>
            <td>{round.work.length ? round.work.map(stage => <Stage key={stage.key} stage={stage} selected={selected} />) : <p className="review-warning">구현·수정 연결 없음</p>}</td>
            <td>{round.review.length ? round.review.map(stage => <Stage key={stage.key} stage={stage} selected={selected} />) : <p className="muted">검수 연결 전</p>}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </section>;
}
