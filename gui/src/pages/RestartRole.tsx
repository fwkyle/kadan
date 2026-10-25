import { useContext, useState } from "react";
import { save } from "../resource";
import { AppContext } from "../ui";

// 살아 있는 역할의 '다시 띄우기'(2026-10-15 [kyle]). 2026-10-25 담당자 상태 표에서 전략 맵 옆 칸으로 옮겼다.
// 이유를 적어야 보낼 수 있고, 화면이 본 세대 표시(최근 시작의 pane PID)를 함께 보내 서버가 CLI로 그 사이
// 다시 띄워졌는지 대조한다. 거절·실패는 CLI 메시지를 그대로 보이고 자동으로 다시 시도하지 않는다. 브라우저 confirm/alert는 쓰지 않는다.
export function RestartRole({
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
  if (!generation || readOnly) return null;
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
    <div className="restart-cell">
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
    </div>
  );
}
