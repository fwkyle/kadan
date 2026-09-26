import { useState } from "react";
import { useResource } from "../resource";
import { patchLocation } from "../navigation";
import type { Mail, Paged, Stamp } from "../types";
import {
  CardLink,
  ErrorMessage,
  Freshness,
  JsonValue,
  Loading,
  Pages,
  time,
} from "../ui";
import { MailBody } from "./Detail";

export function MailItem({ mail }: { mail: Mail }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <time>{time(mail.t)}</time> · {mail.by || "모름"} →{" "}
        {mail.role || "모름"}
        <span className="mail-status">{mail.status}</span>
        <span className="preview">{mail.preview}</span>
        {mail.card && <span className="mail-card"><CardLink row={mail.card} /></span>}
      </summary>
      {open && <MailBody mail={mail} />}
      <small>
        {mail.mailId || mail.digest}
        {mail.replyTo && " · 원본 " + mail.replyTo} · 열람해도 읽음 처리는 하지
        않습니다.
      </small>
    </details>
  );
}
function Filters({
  url,
  fields,
  pageKey,
  resetKeys = [],
}: {
  url: URL;
  fields: {
    name: string;
    label: string;
    options?: [string, string][];
    type?: string;
  }[];
  pageKey: string;
  resetKeys?: string[];
}) {
  return (
    <form
      key={url.search}
      className="toolbar"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        patchLocation({
          ...Object.fromEntries(resetKeys.map((key) => [key, null])),
          ...Object.fromEntries(
            fields.map((f) => [f.name, String(form.get(f.name) || "")]),
          ),
          [pageKey]: null,
        });
      }}
    >
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          {f.options ? (
            <select
              name={f.name}
              defaultValue={url.searchParams.get(f.name) || ""}
            >
              {f.options.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          ) : (
            <input
              name={f.name}
              type={f.type || "text"}
              defaultValue={url.searchParams.get(f.name) || ""}
            />
          )}
        </label>
      ))}
      <button>조회</button>
    </form>
  );
}
export function Mailbox({ url }: { url: URL }) {
  const resource = useResource<
      Paged<Mail> & { roles: string[]; waiting: number; unread: number }
    >("mail?" + url.searchParams),
    data = resource.data;
  return (
    <section>
      <h1>우편함</h1>
      <p>담당자 사이의 질문·답변과 전달 기록입니다. 내가 답할 요청은 <a href="#decisions">내 결정</a>에서 확인하세요.</p>
      <p className="muted">담당자 간 답변 대기 {data?.waiting ?? "모름"}건</p>
      <Filters
        url={url}
        pageKey="mailPage"
        fields={[
          {
            name: "mailRole",
            label: "기준 역할",
            options: [
              ["", "전체"],
              ...(data?.roles || []).map((r) => [r, r] as [string, string]),
            ],
          },
          {
            name: "mailView",
            label: "보기",
            options: [
              ["all", "전체"],
              ["received", "받은 편지"],
              ["sent", "보낸 편지"],
              ["to-reply", "내가 답할 질문"],
              ["waiting", "답변 대기"],
            ],
          },
          {
            name: "mailReply",
            label: "답변",
            options: [
              ["", "전체"],
              ["waiting", "답변 대기"],
              ["answered", "답변 완료"],
              ["cancelled", "질문 취소"],
            ],
          },
          { name: "mailCard", label: "카드 주소" },
          { name: "mailQ", label: "내용 검색" },
          {
            name: "mailUnread",
            label: "읽음 상태",
            options: [
              ["", "전체"],
              ["1", "읽음 미확인"],
            ],
          },
          {
            name: "hideWatch",
            label: "감시 우편",
            options: [
              ["", "표시"],
              ["1", "숨김"],
            ],
          },
        ]}
      />
      <ErrorMessage error={resource.error} />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="mail-list">
            {data.items.map((m, i) => (
              <MailItem key={m.mailId || m.digest || i} mail={m} />
            ))}
          </div>
          {!data.items.length && (
            <p className="empty">조건에 맞는 편지가 없습니다.</p>
          )}
          <Pages
            {...data}
            onPage={(page) => patchLocation({ mailPage: String(page) })}
          />
        </>
      )}
    </section>
  );
}
type Event = {
  at: string;
  kind: string;
  label: string;
  summary: string;
  by: string;
  target: string;
  card: string | null;
  original: { text: string; omitted: number };
};
export function Ledger({ url }: { url: URL }) {
  const resource = useResource<Paged<Event>>("ledger?" + url.searchParams),
    data = resource.data;
  return (
    <section>
      <h1>활동 기록</h1>
      <p>누가 언제 지시·답변·상태 변경을 남겼는지 확인합니다.</p>
      <Filters
        url={url}
        pageKey="logPage"
        fields={[
          {
            name: "ledgerDomain",
            label: "분류",
            options: [
              ["all", "전체"],
              ["tasks", "작업원장"],
              ["mail", "우편원장"],
              ["system", "시스템원장"],
            ],
          },
          {
            name: "ledgerKind",
            label: "사건 종류",
            options: [
              ["", "전체"],
              ["incident", "사고만"],
            ],
          },
          { name: "ledgerCard", label: "카드 주소" },
          { name: "ledgerRole", label: "역할" },
          { name: "ledgerDate", label: "날짜", type: "date" },
          {
            name: "ledgerRoutine",
            label: "반복 감시",
            options: [
              ["", "숨김"],
              ["1", "표시"],
            ],
          },
        ]}
      />
      <ErrorMessage error={resource.error} />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : (
        <>
          {data.items.map((event, i) => (
            <details key={event.at + event.kind + i}>
              <summary>
                {time(event.at)} · {event.label} · {event.by} → {event.target}
                <span className="preview">{event.summary}</span>
              </summary>
              {event.card && (
                <CardLink row={{ key: event.card, title: event.card }} />
              )}
              <pre>{event.original.text}</pre>
            </details>
          ))}
          <Pages
            {...data}
            onPage={(page) => patchLocation({ logPage: String(page) })}
          />
        </>
      )}
    </section>
  );
}
type Run = {
  stateLabel: string;
  key?: string;
  title?: string;
  role?: string;
  state?: string;
  result?: string;
  at?: string;
  sentAt?: string;
};
export function Runs({ url }: { url: URL }) {
  const resource = useResource<Paged<Run> & { all: number; states: {value: string; label: string; count: number}[] }>("runs?" + url.searchParams),
    data = resource.data;
  return (
    <section>
      <h1>실행 이력</h1>
      <p>실행별 완료·실패 기록과 완료가 확인되지 않은 실행을 찾습니다.</p>
      {data && <Filters
        url={url}
        pageKey="runPage"
        resetKeys={["page"]}
        fields={[
          { name: "runState", label: "상태", options: [
            ["", `전체 ${data.all}`],
            ...data.states.map(({value,label,count}) => [value, `${label} ${count}`] as [string,string]),
          ] },
          { name: "q", label: "검색" },
        ]}
      />}
      <ErrorMessage error={resource.error} />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>시각</th>
                  <th>실행</th>
                  <th>역할</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r, i) => (
                  <tr key={i}>
                    <td>{time(r.at || r.sentAt)}</td>
                    <td>
                      {r.key ? (
                        <CardLink
                          row={{ key: r.key, title: r.title || r.key }}
                        />
                      ) : (
                        "카드 미연결"
                      )}
                    </td>
                    <td>{r.role}</td>
                    <td><span className={"run-state run-" + r.state}>{r.stateLabel}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pages
            {...data}
            onPage={(page) => patchLocation({ runPage: String(page), page: null })}
          />
        </>
      )}
    </section>
  );
}
export function Sessions() {
  const resource = useResource<
      Stamp & {
        known: boolean;
        roles: {
          role: string;
          harness: string;
          model: string;
          life: { state: string; pidState: string };
        }[];
      }
    >("sessions"),
    data = resource.data;
  return (
    <section>
      <h1>담당자 상태</h1>
      <p>현재 열린 AI 창과 시작할 때 기록한 모델을 확인합니다. 작업의 진행·완료는 <a href="/?collection=work#dashboard">업무</a>에서 확인하세요.</p>
      <p className="muted">다음 발령에 사용할 모델은 <a href="#runner-settings">실행 모델</a>에서 설정합니다.</p>
      <ErrorMessage
        error={
          resource.error || (data && !data.known ? "현재 세션 상태 모름" : null)
        }
      />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>역할</th>
                <th>생존</th>
                <th>실행 도구 · 모델</th>
              </tr>
            </thead>
            <tbody>
              {data.roles.map((r) => (
                <tr key={r.role}>
                  <td>{r.role}</td>
                  <td>
                    {!data.known
                      ? "모름"
                      : r.life.state === "alive"
                        ? r.life.pidState === "match"
                          ? "열려 있음"
                          : "PID 변경 · 확인 필요"
                        : "닫힘"}
                  </td>
                  <td>
                    {[r.harness, r.model].filter(Boolean).join(" · ") || "모름"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
