import { useContext, useState } from "react";
import { save } from "./resource";
import { AppContext } from "./ui";

// 비서 항상 1개(2026-10-06 [kyle]): 비서가 꺼져 있으면 알리고, '켜기'로 kadan up --hidden을 부른다.
// 세션 상태를 모르면(null) 아무것도 보이지 않는다 — 모르는 것을 꺼짐으로 꾸미지 않는다.
export default function SecretaryNotice({ on }: { on: boolean | null | undefined }) {
  const { token, notice } = useContext(AppContext);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (on !== false) return null;
  return (
    <div className="dw-secretary" role="status">
      <span>비서가 꺼져 있습니다. 대화에서 넘긴 일과 사용자 요청을 받으려면 비서가 있어야 합니다.</span>
      <button type="button" disabled={busy || !token} onClick={async () => {
        setBusy(true);
        setError("");
        try {
          await save("/secretary/start", {}, token);
          notice("비서를 켰습니다(숨김). 창은 터미널에서 kadan attach 비서로 엽니다.");
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>{busy ? "켜는 중…" : "켜기"}</button>
      {error && <small>{error}</small>}
    </div>
  );
}
