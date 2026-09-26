import { useState } from "react";
import { useResource } from "../resource";
import { cardUrl, patchLocation } from "../navigation";
import type { Stamp } from "../types";
import {
  CardLink,
  ErrorMessage,
  Facts,
  Freshness,
  JsonValue,
  Loading,
  Pages,
  time,
} from "../ui";
type Followup = {
  state: string;
  label: string;
  owner: string;
  next: string;
  at: string;
};
type Work = {
  key: string;
  title: string;
  owner: string;
  status: string;
  at: string;
  goal: string;
  scope: string;
  acceptance: string;
  progress: string;
  nextAction: string;
  result: string;
};
type FlowMail = {
  ref: string;
  at: string;
  by: string;
  to: string;
  replyStatus: string;
  read: boolean;
};
type Flow = Stamp & {
  work: Work;
  followup: Followup;
  automatic: unknown;
  executions: {
    key: string;
    title: string;
    phase: string;
    round: number;
    role: string;
    status: string;
    reportState: string;
    signals: unknown[];
  }[];
  handovers: unknown[] | null;
  mail: {
    total: number | null;
    pages: number | null;
    page: number;
    items: FlowMail[];
  };
  errors: string[];
  history: unknown[];
};
export default function Operations({ url }: { url: URL }) {
  const resource = useResource<
      Stamp & { works: (Work & { followup: Followup })[] }
    >("/api/operations-flow"),
    data = resource.data,
    key =
      url.searchParams.get("flowWork") ||
      url.searchParams.get("work") ||
      data?.works[0]?.key;
  return (
    <section>
      <nav className="inline-nav" aria-label="상위 화면">
        <a href={key ? cardUrl("work:" + key) : "/?collection=work#dashboard"}>{key ? "업무 상세로" : "업무 목록으로"}</a>
      </nav>
      <h1>업무 진행 이력</h1>
      <p>업무의 약속부터 실행·검수·인계·우편까지 연결해서 봅니다.</p>
      <ErrorMessage error={resource.error} />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <label>
            업무
            <select
              value={key || ""}
              onChange={(e) =>
                patchLocation({ flowWork: e.target.value, flowPage: null })
              }
            >
              {data.works.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.title} · {w.followup.label}
                </option>
              ))}
            </select>
          </label>
          {key ? (
            <FlowDetail
              key={key}
              workKey={key}
              page={url.searchParams.get("flowPage") || "1"}
            />
          ) : (
            <p>등록된 업무가 없습니다.</p>
          )}
        </>
      )}
    </section>
  );
}
function FlowDetail({ workKey, page }: { workKey: string; page: string }) {
  const resource = useResource<Flow>(
      "/api/operations-flow?" + new URLSearchParams({ work: workKey, page }),
    ),
    data = resource.data;
  return (
    <>
      <ErrorMessage error={resource.error} />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <h2>
            <CardLink
              row={{ key: "work:" + data.work.key, title: data.work.title }}
            />
          </h2>
          {data.errors.map((e) => (
            <ErrorMessage key={e} error={e} />
          ))}
          <Facts
            items={Object.entries({
              목표: data.work.goal,
              범위: data.work.scope,
              "완료 조건": data.work.acceptance,
              진척: data.work.progress,
              "다음 행동": data.followup?.next || data.work.nextAction,
              담당: data.followup?.owner || data.work.owner,
              상태: data.followup?.label || data.work.status,
            })}
          />
          <h3>실행·검수</h3>
          <ol className="flow-timeline">
            {data.executions.map((e, i) => (
              <li key={e.key + i}>
                <small>
                  {e.round}라운드 · {e.phase} · {e.role || "미배정"}
                </small>
                <h4>
                  <CardLink row={e} />
                </h4>
                <p>
                  카드 {e.status || "모름"} · 실행 결과 {e.reportState}
                </p>
                <details>
                  <summary>완료 신호</summary>
                  <JsonValue value={e.signals} />
                </details>
              </li>
            ))}
          </ol>
          <details>
            <summary>자동 연결·후속 근거</summary>
            <JsonValue value={data.automatic} />
          </details>
          <details>
            <summary>인계 기록</summary>
            {data.handovers === null ? (
              <p>인계 상태 모름</p>
            ) : (
              data.handovers.map((h, i) => <JsonValue key={i} value={h} />)
            )}
          </details>
          <h3>연결된 우편</h3>
          {data.mail.items.map((m) => (
            <FlowLetter key={m.ref} workKey={workKey} mail={m} />
          ))}
          {data.mail.total === null ? (
            <p>우편 상태 모름</p>
          ) : (
            <Pages
              total={data.mail.total}
              page={data.mail.page}
              pages={data.mail.pages || 1}
              onPage={(p) => patchLocation({ flowPage: String(p) })}
            />
          )}
          <details>
            <summary>업무 변경 이력</summary>
            {data.history.map((h, i) => (
              <JsonValue key={i} value={h} />
            ))}
          </details>
        </>
      )}
    </>
  );
}
function FlowLetter({ workKey, mail }: { workKey: string; mail: FlowMail }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {time(mail.at)} · {mail.by} → {mail.to} · {mail.replyStatus}
      </summary>
      {open && <FlowBody workKey={workKey} reference={mail.ref} />}
    </details>
  );
}
function FlowBody({
  workKey,
  reference,
}: {
  workKey: string;
  reference: string;
}) {
  const resource = useResource<{ body: string }>(
    "/api/operations-flow/mail?" +
      new URLSearchParams({ work: workKey, ref: reference }),
    { pollMs: 0, staleMs: 60_000 },
  );
  return (
    <>
      <ErrorMessage error={resource.error} />
      {resource.data ? <pre>{resource.data.body}</pre> : <Loading />}
    </>
  );
}
