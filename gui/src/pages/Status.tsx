import { useContext } from "react";
import { useResource } from "../resource";
import type { Decision, Row, Stamp } from "../types";
import {
  CardLink,
  DocumentContent,
  ErrorMessage,
  Freshness,
  Health,
  AppContext,
  Facts,
  Loading,
  time,
} from "../ui";

type StatusData = Stamp & {
  rows: Row[];
  works: Row[];
  cleanupRequest: string;
  boards: {
    name: string;
    total: number;
    counts: Record<string, number>;
    watchHtml: string;
  }[];
  watchHtml: string;
  resources: {
    current: {
      memory: string;
      freePercent: number | null;
      swapUsed: number | null;
      load5: number | null;
    };
    ncpu: number | null;
  } | null;
  resourceError: string | null;
  workError: string | null;
  decisions: Decision[] | null;
  recent: {
    at: string;
    label: string;
    role: string;
    card: { key: string; title: string };
  }[];
};
const groups = [
  ["running", "작업 중"],
  ["waiting", "결과 대기"],
  ["stuck", "지금 막힌 것"],
  ["stale", "오래된 미정리"],
  ["planned", "발령 전"],
  ["hold", "보류"],
];
export default function Status() {
  const resource = useResource<StatusData>("status"),
    data = resource.data,
    context = useContext(AppContext);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      context.notice("질문을 복사했습니다. 전달할 곳에 붙여 넣으세요.");
    } catch {
      context.notice("복사하지 못했습니다. 카드에서 내용을 확인하세요.");
    }
  };
  return (
    <section>
      <div className="page-heading">
        <div>
          <h1>현황</h1>
          <p>실행 상태와 사람이 확인할 일을 모아 봅니다.</p>
        </div>
        <a className="button" href="#dashboard">
          작업으로
        </a>
      </div>
      <ErrorMessage error={resource.error} />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="metrics">
            {groups.map(([key, label]) => (
              <a
                key={key}
                href={
                  "/?collection=executions&state=all&bucket=" +
                  key +
                  "#dashboard"
                }
              >
                <strong>
                  {
                    data.rows.filter(
                      (r) => r.kind === "execution" && r.bucket === key,
                    ).length
                  }
                </strong>
                <span>{label}</span>
              </a>
            ))}
            <a href="#decisions">
              <strong>{data.decisions?.length ?? "모름"}</strong>
              <span>내 결정</span>
            </a>
          </div>
          <DocumentContent html={data.watchHtml} />
          <ErrorMessage error={data.workError} />
          <h2>지금 확인할 실행</h2>
          <div className="status-cards">
            {data.rows
              .filter((r) => ["stuck", "stale"].includes(r.bucket || ""))
              .slice(0, 30)
              .map((row) => (
                <article className="work-tile" key={row.key}>
                  <Health row={row} />
                  <h3>
                    <CardLink row={row} />
                  </h3>
                  <p>{row.failureReason || row.healthReason}</p>
                  <p>{row.next}</p>
                  <button
                    onClick={() =>
                      void copy(
                        `[대시보드 확인 요청] ${row.key}: ${row.healthLabel}. ${row.failureReason || row.healthReason} 후속 처리 방향과 근거를 확인해주세요.`,
                      )
                    }
                  >
                    감독에게 물을 내용 복사
                  </button>
                </article>
              ))}
          </div>
          <h2>진행 업무</h2>
          <div className="status-cards">
            {data.works
              .filter((w) => !["done", "cancelled"].includes(w.state))
              .map((w) => (
                <article className="work-tile" key={w.key}>
                  <Health row={w} />
                  <h3>
                    <CardLink row={w} />
                  </h3>
                  <p>{w.purpose}</p>
                  <p>
                    {w.turnLabel} · {w.next}
                  </p>
                  <small>{w.flowPhase}</small>
                </article>
              ))}
          </div>
          <details>
            <summary>끝난 업무</summary>
            {data.works
              .filter((w) => ["done", "cancelled"].includes(w.state))
              .map((w) => (
                <p key={w.key}>
                  <CardLink row={w} /> · {w.stateLabel}
                </p>
              ))}
          </details>
          <button onClick={() => void copy(data.cleanupRequest)}>
            오래된 미정리 정리 요청 복사
          </button>
          <h2>판별 진행</h2>
          <div className="status-cards">
            {data.boards.map((board) => (
              <article className="work-tile" key={board.name}>
                <h3>
                  <a
                    href={
                      "/?board=" +
                      encodeURIComponent(board.name) +
                      "&collection=executions&state=all#dashboard"
                    }
                  >
                    {board.name}
                  </a>
                </h3>
                <p>
                  실행 {board.total}장 · 완료 {board.counts.done || 0}장
                </p>
                <dl className="facts">
                  {Object.entries(board.counts)
                    .filter(([, n]) => n > 0)
                    .map(([key, n]) => (
                      <div key={key}>
                        <dt>
                          {groups.find(([value]) => value === key)?.[1] ||
                            { done: "완료", closed: "취소·대체·보관" }[
                              key as "done" | "closed"
                            ] ||
                            key}
                        </dt>
                        <dd>{n}</dd>
                      </div>
                    ))}
                </dl>
                <DocumentContent html={board.watchHtml} />
              </article>
            ))}
          </div>
          <h2>최근 실행 변화</h2>
          {data.recent.map((event, i) => (
            <p key={i}>
              <time>{time(event.at)}</time> · <CardLink row={event.card} /> ·{" "}
              {event.label} · {event.role}
            </p>
          ))}
          <details>
            <summary>자원 사용</summary>
            <ErrorMessage error={data.resourceError} />
            {data.resources ? (
              <Facts
                items={[
                  [
                    "메모리 여유",
                    data.resources.current.freePercent === null
                      ? "모름"
                      : data.resources.current.freePercent + "%",
                  ],
                  [
                    "스왑 사용",
                    data.resources.current.swapUsed === null
                      ? "모름"
                      : data.resources.current.swapUsed.toFixed(1) + " MB",
                  ],
                  [
                    "CPU 5분 부하",
                    data.resources.current.load5 === null
                      ? "모름"
                      : data.resources.current.load5.toFixed(2) +
                        " / " +
                        (data.resources.ncpu ?? "모름"),
                  ],
                ]}
              />
            ) : (
              <p>자원 상태 모름</p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
