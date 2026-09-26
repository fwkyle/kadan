import { useEffect, useRef, useState } from "react";
import { useResource } from "../resource";
import { patchLocation } from "../navigation";
import type { Decision, Stamp } from "../types";
import {
  ActionForm,
  CardLink,
  DocumentContent,
  ErrorMessage,
  Freshness,
  Loading,
  time,
} from "../ui";

export default function Decisions({ url }: { url: URL }) {
  const resource = useResource<Stamp & { items: Decision[] }>("decisions"),
    data = resource.data;
  const [selected, setSelected] = useState<string | null>(null),
    [previous, setPrevious] = useState(false);
  const newest = url.searchParams.get("decisionSort") === "newest";
  const items = [...(data?.items || [])].sort(
    (a, b) => (Date.parse(a.at) - Date.parse(b.at)) * (newest ? -1 : 1),
  );
  const current = items.find((d) => d.id === selected);
  return (
    <section>
      <div className="page-heading">
        <div>
          <h1>내 결정</h1>
          <p>오래 기다린 요청부터 확인합니다. 답변은 요청자에게 전달됩니다.</p>
        </div>
        <label>
          정렬
          <select
            value={newest ? "newest" : "oldest"}
            onChange={(e) => patchLocation({ decisionSort: e.target.value })}
          >
            <option value="oldest">오래된 요청부터</option>
            <option value="newest">최신 요청부터</option>
          </select>
        </label>
      </div>
      <ErrorMessage error={resource.error} />
      <Freshness collectedAt={data?.collectedAt} {...resource} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="decision-list">
            {items
              .filter((d) => d.status === "open")
              .map((d) => (
                <article key={d.id}>
                  <div>
                    <small>
                      {time(d.at)} · {d.requestedBy}
                    </small>
                    <h2>
                      <button
                        className="text-button"
                        onClick={() => setSelected(d.id)}
                      >
                        {d.question}
                      </button>
                    </h2>
                    <p>{d.reason}</p>
                    <CardLink row={{ key: d.card, title: "관련 카드" }} />
                  </div>
                  <button onClick={() => setSelected(d.id)}>결정하기</button>
                </article>
              ))}
          </div>
          {!items.some((d) => d.status === "open") && (
            <p className="empty">기다리는 결정이 없습니다.</p>
          )}
          <details
            open={previous}
            onToggle={(e) => setPrevious(e.currentTarget.open)}
          >
            <summary>
              이전 결정 {items.filter((d) => d.status !== "open").length}건
            </summary>
            {previous &&
              items
                .filter((d) => d.status !== "open")
                .map((d) => (
                  <article className="work-tile" key={d.id}>
                    <h3>{d.question}</h3>
                    <p>{d.answer?.text || d.cancelReason}</p>
                    <p>
                      {time(d.answer?.at || d.at)} ·{" "}
                      {d.status === "answered" ? "답변 완료" : "취소"} · 전달{" "}
                      {d.delivery?.status || "미기록"}
                    </p>
                    {d.delivery?.error && (
                      <p className="error">{d.delivery.error}</p>
                    )}
                    <CardLink row={{ key: d.card, title: "관련 카드" }} />
                  </article>
                ))}
          </details>
        </>
      )}
      {current && (
        <DecisionDialog
          key={current.id}
          decision={current}
          close={() => setSelected(null)}
        />
      )}
    </section>
  );
}
function DecisionDialog({
  decision,
  close,
}: {
  decision: Decision;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [dirty, setDirty] = useState(false);
  const closeGuarded = () => {
    if (!dirty || confirm("작성 중인 답변을 버리고 닫을까요?")) close();
  };
  useEffect(() => {
    const dialog = ref.current!;
    const focused = document.activeElement;
    dialog.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      if (focused instanceof HTMLElement)
        focused.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="decision-dialog"
      onCancel={(e) => {
        e.preventDefault();
        closeGuarded();
      }}
      onChange={() => setDirty(true)}
    >
      <button className="dialog-close" onClick={closeGuarded}>
        닫기
      </button>
      <small>
        {time(decision.at)} · {decision.requestedBy}
      </small>
      <h2>{decision.question}</h2>
      {decision.reasonHtml ? (
        <DocumentContent html={decision.reasonHtml} />
      ) : (
        <p>{decision.reason}</p>
      )}
      <p>
        <strong>추천</strong> {decision.recommendation}
      </p>
      <CardLink row={{ key: decision.card, title: "관련 카드 보기" }} />
      <ActionForm
        entityKey={undefined}
        revision={decision.revision}
        spec={{
          action: "/decisions/answer",
          title: "답변 저장·전달",
          disabled: decision.status !== "open",
          fields: [
            {
              name: "id",
              label: "요청 ID",
              value: decision.id,
              type: "hidden",
              options: null,
              required: true,
            },
            {
              name: "choice",
              label: "선택",
              value: "",
              type: "select",
              options: [
                ["", "직접 답변"],
                ...decision.options.map((x) => [x, x] as [string, string]),
              ],
              required: false,
            },
            {
              name: "text",
              label: "답변·추가 설명",
              value: "",
              type: "textarea",
              options: null,
              required: false,
            },
          ],
        }}
        onSaved={(result) => {
          const delivery = result.result.delivery;
          if (delivery?.status !== "sent")
            alert(
              "답변은 저장됐지만 전달 상태를 확인해야 합니다: " +
                (delivery?.error || delivery?.status || "모름"),
            );
          close();
        }}
      />
      {decision.status !== "open" && (
        <p className="warning">
          이 요청은 다른 곳에서 처리됐습니다. 작성 중인 답변을 확인한 뒤
          닫으세요.
        </p>
      )}
    </dialog>
  );
}
