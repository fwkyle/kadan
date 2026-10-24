import { useContext, useState } from "react";
import { save, useResource } from "../resource";
import { patchLocation } from "../navigation";
import type { Mail, Paged, Stamp } from "../types";
import {
  AppContext,
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
    <details data-fresh={`mail:${mail.mailId ?? mail.digest}:${mail.replyStatus ?? ""}:${mail.status ?? ""}`} onToggle={(e) => setOpen(e.currentTarget.open)}>
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
      Paged<Mail> & {
        roles: string[];
        waiting: number;
        unread: number;
        previousGenerationUnread: number;
        nextCursor?: string | null;
        previousCursor?: string | null;
      }
    >("mail?" + url.searchParams),
    data = resource.data;
  return (
    <section>
      <h1>우편함</h1>
      <p>담당자 사이의 질문·답변과 전달 기록입니다. 내가 답할 요청은 <a href="#decisions">내 결정</a>에서 확인하세요.</p>
      <p className="muted">담당자 간 답변 대기 {data?.waiting ?? "모름"}건 · 이전 세대 미확인{" "}
        {data?.previousGenerationUnread ?? "모름"}건(같은 이름을 새 세션이 다시 쓰기 전 우편, 현재 미확인 수에 넣지 않음)
      </p>
      <Filters
        url={url}
        pageKey="mailPage"
        resetKeys={["mailCursor"]}
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
              ["1", "읽음 기록 없음"],
              ["previous", "이전 세대 미확인"],
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
            onPage={(page) => patchLocation({
              mailPage: String(page),
              mailCursor: page === 1 ? null : page === data.page + 1
                ? data.nextCursor ?? null : page === data.page - 1 ? data.previousCursor ?? null : null,
            })}
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
  const resource = useResource<Paged<Event> & {
    nextCursor?: string | null;
    previousCursor?: string | null;
  }>("ledger?" + url.searchParams),
    data = resource.data;
  return (
    <section>
      <h1>활동 기록</h1>
      <p>누가 언제 지시·답변·상태 변경을 남겼는지 확인합니다.</p>
      <Filters
        url={url}
        pageKey="logPage"
        resetKeys={["logCursor"]}
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
            onPage={(page) => patchLocation({
              logPage: String(page),
              logCursor: page === 1 ? null :
                page > data.page ? data.nextCursor ?? null : data.previousCursor ?? null,
            })}
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
// 살아 있는 역할 줄의 '다시 띄우기'(2026-10-15 [kyle]). 이유를 적어야 보낼 수 있고, 화면이 본 세대 표시(최근 시작의
// pane PID)를 함께 보내 서버가 CLI로 그 사이 다시 띄워졌는지 대조한다. 거절·실패는 CLI 메시지를 그대로 보이고
// 자동으로 다시 시도하지 않는다. 브라우저 confirm/alert는 쓰지 않는다.
function RestartCell({
  role,
  generation,
}: {
  role: string;
  generation: string | null;
}) {
  const { token, readOnly } = useContext(AppContext),
    [open, setOpen] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [outcome, setOutcome] = useState<{ ok: boolean; pending?: boolean; text: string } | null>(
      null,
    );
  if (!generation || readOnly) return <td></td>;
  const submit = async () => {
    const text = reason.trim();
    if (!text) {
      setOutcome({ ok: false, text: "다시 띄우는 이유를 적어 주세요." });
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const saved = await save(
        "/roles/restart",
        { role, reason: text, expectPid: generation },
        token,
      );
      setOutcome({
        ok: !saved.result.pending,
        pending: !!saved.result.pending,
        text: saved.result.output || "다시 띄웠습니다.",
      });
      setOpen(false);
      setReason("");
    } catch (error) {
      setOutcome({
        ok: false,
        text: error instanceof Error ? error.message : "다시 띄우기 실패",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <td className="restart-cell">
      {!open && (
        <button
          type="button"
          disabled={busy || !token}
          onClick={() => {
            setOutcome(null);
            setOpen(true);
          }}
        >
          다시 띄우기
        </button>
      )}
      {open && (
        <form
          className="restart-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void submit();
          }}
        >
          <input
            name="reason"
            required
            placeholder="이유 (필수)"
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
          <button type="submit" disabled={busy || !reason.trim()}>
            {busy ? "다시 띄우는 중…" : "실행"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setReason("");
            }}
          >
            취소
          </button>
        </form>
      )}
      {outcome && (
        <small
          className={outcome.pending ? "restart-pending" : outcome.ok ? "restart-ok" : "restart-fail"}
          role="status"
        >
          {outcome.text}
        </small>
      )}
    </td>
  );
}

export function Sessions({ url }: { url: URL }) {
  const resource = useResource<
      Stamp & {
        known: boolean;
        hidden: number;
        roles: {
          role: string;
          harness: string;
          model: string;
          life: { state: string; pidState: string; recordedPid: string | null };
        }[];
      }
    >("sessions"),
    data = resource.data,
    aliveOnly = url.searchParams.get("alive") === "1",
    alive = data?.roles.filter((r) => r.life.state === "alive") ?? [],
    rows = data && aliveOnly && data.known ? alive : (data?.roles ?? []);
  return (
    <section id="sessions" className="sessions-section">
      <h2>담당자 상태 · 지금 열린 창</h2>
      <p className="muted">열린 AI 창과 아직 안 닫힌 카드를 맡은 담당, 시작할 때 기록한 실행 도구·모델입니다. 작업의 진행·완료는 <a href="/?collection=work#dashboard">워크</a>에서 확인하세요.</p>
      {data && (
        <div className="segmented" aria-label="담당 보기">
          <button aria-pressed={!aliveOnly} onClick={() => patchLocation({ alive: null }, undefined, true)}>
            전체 {data.roles.length}
          </button>
          <button aria-pressed={aliveOnly} onClick={() => patchLocation({ alive: "1" }, undefined, true)}>
            생존만 {data.known ? alive.length : "모름"}
          </button>
        </div>
      )}
      {data && data.hidden > 0 && (
        <p className="muted">창이 닫혔고 맡은 카드도 끝난 담당 {data.hidden}명은 숨겼습니다.</p>
      )}
      <ErrorMessage
        error={
          resource.error || (data && !data.known ? "현재 세션 상태 모름" : null)
        }
      />
      {/* 수집 시각·새로 읽기 줄은 실행 모델 화면이 한 번만 그린다(절마다 그리면 바닥에 두 줄). */}
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
                <th>다시 띄우기</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
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
                  <RestartCell
                    role={r.role}
                    generation={
                      r.life.state === "alive" ? r.life.recordedPid : null
                    }
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
