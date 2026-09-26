import { useEffect, useRef, useState } from "react";
import { usePaneScroll } from "../scroll";
import { useResource } from "../resource";
import type { DetailData, Mail } from "../types";
import {
  ActionForm,
  CardLink,
  DocumentContent,
  ErrorMessage,
  Facts,
  Freshness,
  Health,
  Loading,
  time,
} from "../ui";
import { patchLocation } from "../navigation";

export function MailBody({ mail }: { mail: Mail }) {
  const resource = useResource<{ body: string | null; error?: string }>(
    "mail-body?id=" + encodeURIComponent(mail.mailId || mail.digest || ""),
    { pollMs: 0, staleMs: 60_000 },
  );
  return (
    <>
      <ErrorMessage error={resource.error || resource.data?.error || null} />
      {resource.data ? (
        <pre>{resource.data.body || "본문 없음"}</pre>
      ) : (
        <Loading />
      )}
    </>
  );
}
export default function Detail({ card }: { card: string }) {
  const params = new URL(location.href).searchParams,
    tab = params.get("tab");
  const scroll = usePaneScroll("detail:" + card),
    panel = useRef<HTMLElement | null>(null);
  const resource = useResource<DetailData>(
    "detail?card=" + encodeURIComponent(card),
  );
  const [query, setQuery] = useState(""),
    [documentView, setDocumentView] = useState(
      params.get("detailView") === "document",
    ),
    [expanded, setExpanded] = useState(params.get("expanded") === "1");
  const data = resource.data;
  useEffect(() => {
    if (!data || !tab) return;
    const target = panel.current?.querySelector<HTMLDetailsElement>(
      `details[data-section="${tab.replace(/[^a-z-]/g, "")}"]`,
    );
    if (target) target.open = true;
  }, [data?.key, tab]);
  return (
    <aside
      ref={(element) => {
        panel.current = element;
        scroll.ref(element);
      }}
      onScroll={scroll.onScroll}
      className={"detail-panel" + (expanded ? " expanded" : "")}
      aria-label="카드 상세"
      onClick={(event) => {
        const button = (event.target as Element).closest("[data-read-tab]");
        const section = button?.getAttribute("data-read-tab");
        if (section) {
          const target = event.currentTarget.querySelector<HTMLDetailsElement>(
            `details[data-section="${section}"]`,
          );
          if (target) {
            target.open = true;
            target.scrollIntoView({ block: "nearest" });
          }
        }
      }}
    >
      <div className="detail-actions">
        <button
          onClick={() =>
            patchLocation(
              {
                detail: "0",
                expanded: null,
                card: null,
                ...(params.get("layout") === "split"
                  ? { layout: "table" }
                  : {}),
              },
              "dashboard",
            )
          }
        >
          목록으로
        </button>
        <button onClick={() => setExpanded((x) => !x)}>
          {expanded ? "나란히 보기" : "상세 확대"}
        </button>
        <button
          aria-pressed={documentView}
          onClick={() => setDocumentView((x) => !x)}
        >
          {documentView ? "표형으로 보기" : "문서형으로 보기"}
        </button>
      </div>
      <ErrorMessage
        error={resource.error}
        retry={() => void resource.refresh(true)}
      />
      {!data ? (
        <Loading />
      ) : (
        <article className={documentView ? "document-view" : ""}>
          <div className="eyebrow">
            {data.kind === "work" ? "업무" : "실행"} ·{" "}
            {data.row.board || data.row.repo} · 버전 {data.revision}
          </div>
          <h2>{data.title}</h2>
          <Health row={data.row} />
          <p>{data.row.healthReason}</p>
          <Freshness collectedAt={data.collectedAt} {...resource} />
          <nav className="inline-nav">
            <a href={"/?mailCard=" + encodeURIComponent(data.key) + "#mailbox"}>
              이 카드의 우편 {data.mailTotal}건
            </a>
            <a
              href={
                "/?ledgerCard=" +
                encodeURIComponent(data.key) +
                "&ledgerRoutine=1#ledger"
              }
            >
              이 카드의 사건
            </a>
          </nav>
          <Facts
            items={[
              ["현재 차례", data.row.turnLabel],
              ["다음 행동", data.row.next],
              [
                "최근 실행 신호",
                `${data.row.signalLabel || "없음"} · ${time(data.row.signalAt)}`,
              ],
            ]}
          />
          {data.summaryHtml && <DocumentContent html={data.summaryHtml} />}
          <details open={documentView} data-section="work">
            <summary>작업 내용·완료 조건</summary>
            {data.instructions ? (
              <>
                <label>
                  작업 지시 검색
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <DocumentContent html={data.instructions.prefixHtml} />
                {data.instructions.sections
                  .filter((s) =>
                    (s.title + s.content)
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((s, i) => (
                    <details key={s.title + i} open={documentView || undefined}>
                      <summary>{s.label}</summary>
                      <DocumentContent html={s.html} />
                    </details>
                  ))}
                <details>
                  <summary>지시문 원문</summary>
                  <pre>{data.instructions.body}</pre>
                </details>
              </>
            ) : (
              <Facts items={data.facts} />
            )}
          </details>
          <details>
            <summary>기록 남기기</summary>
            {data.forms.map((form) => (
              <details key={form.action}>
                <summary>{form.title}</summary>
                <ActionForm
                  spec={form}
                  entityKey={data.key}
                  revision={data.revision}
                />
              </details>
            ))}
          </details>
          {data.report && (
            <details data-section="evidence">
              <summary>결과·검수</summary>
              <h3>작업자 보고</h3>
              <p>
                {data.report.state === "reported"
                  ? `${data.report.by} · ${time(data.report.at)}`
                  : data.report.state === "unknown"
                    ? "보고 확인 불가"
                    : "현재 발령 이후의 보고 없음"}
              </p>
              {data.report.state === "reported" && (
                <DocumentContent html={data.report.html} />
              )}
              <h3>역할별 실행 결과</h3>
              {data.runs?.map((r, i) => (
                <p key={i}>
                  {r.role} · {r.state} · {time(r.at)}
                </p>
              ))}
              <p className="muted">
                실행 완료는 검수 통과나 배포 완료를 뜻하지 않습니다.
              </p>
            </details>
          )}
          {data.executions && (
            <details>
              <summary>업무 안의 실행 {data.executions.length}건</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>라운드</th>
                      <th>단계</th>
                      <th>실행</th>
                      <th>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.executions.map((execution, i) => (
                      <tr key={execution.key + i}>
                        <td>{execution.round}</td>
                        <td>{execution.phase}</td>
                        <td>
                          <CardLink
                            row={{
                              key: execution.key,
                              title: execution.row?.title || execution.key,
                            }}
                          />
                        </td>
                        <td>
                          {execution.row ? (
                            <Health row={execution.row} />
                          ) : (
                            "상태 모름"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <details>
            <summary>인박스 · 최근 {data.mail.length}통</summary>
            {data.mail.map((mail, i) => (
              <DetailMail key={mail.mailId || mail.digest || i} mail={mail} />
            ))}
            <a href={"/?mailCard=" + encodeURIComponent(data.key) + "#mailbox"}>
              연결된 편지 모두 보기
            </a>
          </details>
          <details data-section="history">
            <summary>기술 정보·변경 이력</summary>
            <Facts items={data.facts} />
            {data.related && (
              <details>
                <summary>티키타카 연결 기록</summary>
                {data.related.map((c) => (
                  <p key={c.key}>
                    <CardLink row={c} /> · {c.rallyRound}라운드 · {c.rallyStep}{" "}
                    · {c.displayState}
                  </p>
                ))}
              </details>
            )}
            {data.history.map((h, i) => (
              <details key={i}>
                <summary>
                  {time(h.at)} · {h.kind || h.action || "기록"} ·{" "}
                  {h.by || "모름"}
                </summary>
                {h.transition && <p>{h.transition}</p>}
                {h.turn && <p>{h.turn}</p>}
                <pre>
                  {[h.note, h.progress, h.nextAction, h.result]
                    .filter(Boolean)
                    .join("\n")}
                </pre>
              </details>
            ))}
          </details>
        </article>
      )}
    </aside>
  );
}
function DetailMail({ mail }: { mail: Mail }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {time(mail.t)} · {mail.by} → {mail.role}
        <span className="muted">{mail.preview}</span>
      </summary>
      <p>{mail.status}</p>
      {open && <MailBody mail={mail} />}
    </details>
  );
}
