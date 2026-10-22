import { patchLocation } from "../navigation";
import { useResource } from "../resource";
import type { Stamp } from "../types";
import { CardLink, ErrorMessage, Freshness, Loading, Pulse, time } from "../ui";

type Mark = { kind: string; label: string };
type KanbanCard = {
  key: string; title: string; role: string; stateLabel: string; healthLabel: string;
  workTitle: string | null; marks: Mark[]; since: string | null;
};
type KanbanLine = { key: string; label: string; count: number; hidden: number; cards: KanbanCard[] };
type KanbanBoard = { owner: string | null; label: string; super: string | null; isSuper: boolean; lines: KanbanLine[] };
type KanbanData = Stamp & {
  boards: KanbanBoard[]; owners: string[]; owner: string | null; doneLimit: number;
  decisionError: string | null; workError: string | null;
};

function Card({ card, line }: { card: KanbanCard; line: string }) {
  return (
    <li className={"kb-card kb-line-" + line} data-fresh={`kb:${card.key}:${line}:${card.marks.map((m) => m.label).join("+")}`}>
      <strong className="kb-title"><CardLink row={card} /></strong>
      <small className="kb-meta">
        <Pulse at={card.since} />담당 {card.role || "미배정"} · {card.stateLabel} · {card.since ? time(card.since) : "시각 모름"}
      </small>
      {card.workTitle && <small className="kb-meta">업무 {card.workTitle}</small>}
      {card.marks.length > 0 && (
        <span className="kb-marks">{card.marks.map((m) => <span key={m.label} className={"kb-mark kb-mark-" + m.kind}>{m.label}</span>)}</span>
      )}
    </li>
  );
}

function Board({ board, foldDone }: { board: KanbanBoard; foldDone: boolean }) {
  const total = board.lines.reduce((sum, line) => sum + line.count, 0);
  return (
    <section className="kb-board" aria-label={board.label + " 판"} data-fresh={`kbb:${board.label}:${board.lines.map((l) => l.count).join(",")}`}>
      <header className="kb-board-head">
        <h2>{board.label}</h2>
        <span className="kb-board-sub">
          {board.owner === null ? "업무·관계표에 연결되지 않은 카드" : board.isSuper ? "슈퍼감독" : board.super ? `슈퍼감독 ${board.super}` : "감독"} · 카드 {total}장
        </span>
      </header>
      <div className="kb-lines">
        {board.lines.map((line) => {
          const body = (
            <>
              {line.cards.length
                ? <ul>{line.cards.map((card) => <Card key={card.key} card={card} line={line.key} />)}</ul>
                : <p className="kb-empty">없음</p>}
              {line.hidden > 0 && <p className="kb-more">나머지 {line.hidden}건</p>}
            </>
          );
          const head = <>{line.label}<span className="kb-count">{line.count}</span></>;
          // 전체 보기에서는 완료 줄을 접은 채 시작한다. 펼침 상태는 저장하지 않는다.
          return foldDone && line.key === "done"
            ? <details key={line.key} className={"kb-col kb-col-" + line.key}><summary className="kb-fold">{head}</summary>{body}</details>
            : <div key={line.key} className={"kb-col kb-col-" + line.key}><h3>{head}</h3>{body}</div>;
        })}
      </div>
    </section>
  );
}

export default function Kanban({ url }: { url: URL }) {
  const owner = url.searchParams.get("owner") || "";
  const resource = useResource<KanbanData>("kanban" + (owner ? "?owner=" + encodeURIComponent(owner) : "")), data = resource.data;
  return (
    <div className="kb-view" data-view="kanban">
      <header className="kb-lead">
        <h1>감독별 칸반</h1>
        <p>감독마다 실행 카드가 어느 단계에 있는지 봅니다. 보기 전용이며, 완료는 최근 24시간만 보입니다. 전체 보기에서는 완료 줄이 접혀 있고 눌러서 펼칩니다(감독 하나를 고르면 펼쳐 보입니다). 열린 결정은 카드가 끝났어도, 실행 카드가 없는 업무여도 보입니다. kyle 앞에 놓인 PR 머지 요청(PR 주소가 있는 결정)은 '머지 요청' 줄에, 그 밖의 결정과 막힘은 'kyle 확인 필요' 줄에 따로 보입니다.</p>
        <label className="kb-pick">감독{" "}
          <select value={owner} onChange={(e) => patchLocation({ owner: e.target.value || null }, "kanban")}>
            <option value="">전체</option>
            {(data?.owners || []).map((name) => <option key={name} value={name}>{name}</option>)}
            {owner && !(data?.owners || []).includes(owner) && <option value={owner}>{owner}</option>}
          </select>
        </label>
      </header>
      <ErrorMessage error={resource.error} retry={() => void resource.refresh(true)} />
      {data?.decisionError && <p className="error" role="alert">결정 기록을 읽지 못해 'kyle 확인 필요' 줄은 막힌 카드만 담았습니다: {data.decisionError}</p>}
      {data?.workError && <p className="error" role="alert">업무 기록을 읽지 못해 판을 관계표로만 나눴습니다: {data.workError}</p>}
      {!data ? <Loading /> : data.boards.length
        ? data.boards.map((board) => <Board key={board.label} board={board} foldDone={!owner} />)
        : <p className="empty">보여 줄 카드가 없습니다.</p>}
      <Freshness collectedAt={data?.collectedAt} {...resource} />
    </div>
  );
}
