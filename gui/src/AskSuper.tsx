import { useContext, useState } from "react";
import { save, useResource } from "./resource";
import type { Row } from "./types";
import { AppContext, time } from "./ui";
import { STATE_LABEL, type Base, type Unit } from "./strategy-map";

// 전략 맵 옆 칸의 '슈퍼감독에게 묻기'(2026-10-07 [kyle]). 받는 사람은 서버가 관계표로 정하고(슈퍼감독, 사슬이 없으면 비서),
// 화면은 미리 보여 주기만 한다. 답은 사람 우편함으로 오고 OS 알림이 뜬다. 편지는 유닛과 묶이지 않으므로
// "이 받는 사람에게 보낸 내 질문"을 상태와 함께 보여 준다.
type MailItem = { mailId: string; t: string; role: string; currentRecipient?: string; preview?: string; replyStatus: string };
const KIND = { super: "슈퍼감독", director: "감독", worker: "작업자·검수자" } as const;
const REPLY: Record<string, string> = { waiting: "답 기다리는 중", answered: "답 도착", cancelled: "질문 취소" };

export function unitContext(unit: Unit) {
  const cards = unit.rows.slice(0, 8).map((row: Row) =>
    `- ${row.key}${row.title ? ` (${row.title})` : ""}${row.healthLabel ? ` · ${row.healthLabel}` : ""}${row.signalAt ? ` · 마지막 신호 ${time(row.signalAt)}` : ""}`);
  return [
    `유닛: ${unit.role} · ${KIND[unit.kind]} · ${STATE_LABEL[unit.state]} · 직속 상위 ${unit.parent ?? "없음"} · 모델 ${unit.model ?? "모름"} · 경보 ${unit.alerts}건`,
    ...(cards.length ? ["진행 카드:", ...cards] : ["진행 카드 없음"]),
  ].join("\n");
}

export default function AskSuper({ unit, base }: { unit: Unit; base: Base }) {
  const { token, notice } = useContext(AppContext);
  const [text, setText] = useState(""),
    [withContext, setWithContext] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // 미리 보기용 받는 사람. 실제로는 서버가 같은 규칙(관계표 사슬 끝, 없으면 비서)으로 다시 정한다.
  const to = unit.kind === "super" ? unit.role : base.super ?? "비서";
  const mail = useResource<{ items: MailItem[] }>("mail?mailRole=" + encodeURIComponent("사람") + "&mailView=sent");
  const asked = (mail.data?.items ?? []).filter((m) => (m.currentRecipient || m.role) === to && m.replyStatus !== "not-requested").slice(0, 3);
  return (
    <section className="sm-ask" aria-label="슈퍼감독에게 묻기">
      <h3>{to === "비서" ? "비서에게 묻기" : "슈퍼감독에게 묻기"}</h3>
      <p className="sm-ask-to">받는 사람: <b>{to}</b>{to === "비서" && !base.super ? " (이 유닛은 슈퍼감독 사슬 밖이라 비서에게 갑니다)" : ""}</p>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim() || busy) return;
        setBusy(true);
        setError("");
        try {
          const result = await save("/ask", { unit: unit.role, text: text.trim(), context: withContext ? unitContext(unit) : "" }, token);
          notice(`${result.result.to ?? to}에게 질문을 보냈습니다. 답이 오면 알림이 뜨고 우편함에서 볼 수 있습니다.`);
          setText("");
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={4000}
          placeholder={`예: ${unit.state === "dead" ? "이 창이 왜 꺼졌어? 카드는 어떻게 할 거야?" : "지금 뭐 하는 중이야? 막힌 거 있어?"}`} />
        <label className="sm-ask-ctx"><input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} />이 유닛 정보 같이 보내기(역할·상태·카드·경보)</label>
        <button type="submit" disabled={busy || !token || !text.trim()}>{busy ? "보내는 중…" : "보내기"}</button>
        {error && <small className="sm-ask-error">{error}</small>}
      </form>
      {asked.length > 0 && <ul className="sm-ask-list">
        {asked.map((m) => <li key={m.mailId}>
          <span className={"sm-ask-status sm-ask-" + m.replyStatus}>{REPLY[m.replyStatus] ?? m.replyStatus}</span>
          <span>{(m.preview || "").replace(/^\[대시보드 질문 · [^\]]*\]\s*/, "").slice(0, 60)}</span>
          <small>{time(m.t)}</small>
        </li>)}
      </ul>}
      <a href={"/?mailRole=" + encodeURIComponent("사람") + "&mailView=received#mailbox"}>받은 답 보기(우편함)</a>
    </section>
  );
}
