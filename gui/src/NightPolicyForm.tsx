import { useContext, useState } from "react";
import { save } from "./resource";
import { AppContext } from "./ui";
import type { NightLine } from "./night-repos";
import { MERGE_CHOICES, canSave, cardHint, changesOf, confirmText, fieldsOf, initialForm, problemOf } from "./night-form";

// PR3b: github 한 줄의 정책 양식. 초기값·바뀜 판정은 카단 설정(settings) 기준이다.
// 저장은 기존 `POST /api/night/repos` 그대로. save()가 성공하면 화면 자료를 한 번 다시 읽어(줄·사이드 🌙 뱃지가 같은 자료)
// 새 타이머는 두지 않는다. 지우기는 대시보드가 받지 않으므로 CLI 안내만 둔다.
export default function NightPolicyForm({ line, nightOn }: { line: NightLine; nightOn: boolean | null }) {
  const { token, readOnly } = useContext(AppContext);
  const [form, setForm] = useState(() => initialForm(line));
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (readOnly) return null;
  const locked = nightOn === true;
  const change = changesOf(line, form);
  const problem = problemOf(change);
  const ready = canSave(change) && !locked && !busy && !!token;
  const edit = (next: Partial<typeof form>) => { setForm({ ...form, ...next }); setAsking(false); setMessage(null); };
  const submit = async () => {
    setBusy(true);
    try {
      await save("/api/night/repos", fieldsOf(line, change), token);
      setMessage({ ok: true, text: "저장했습니다." });
      setAsking(false);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "저장 실패" });
    } finally {
      setBusy(false);
    }
  };
  const deployHint = cardHint(line, "deployBranch"), mergeHint = cardHint(line, "nightMerge");
  return <form className="st-night-form" onSubmit={(e) => { e.preventDefault(); if (ready) setAsking(true); }}>
    <label>배포 브랜치
      <input type="text" value={form.deploy} placeholder="브랜치 이름 또는 없음" disabled={locked || busy}
        onChange={(e) => edit({ deploy: e.target.value })} />
    </label>
    {deployHint && <small>{deployHint}</small>}
    <label>나이트런 중 자동 머지
      <select value={form.merge} disabled={locked || busy} onChange={(e) => edit({ merge: e.target.value })}>
        <option value="">(그대로)</option>
        {MERGE_CHOICES.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    </label>
    {mergeHint && <small>{mergeHint}</small>}
    <button type="submit" disabled={!ready}>저장</button>
    {locked && <small role="status">나이트런 켜짐 동안 바꿀 수 없음</small>}
    {problem && <small role="alert" className="st-error">{problem}</small>}
    {asking && ready && <p className="st-night-confirm" role="status">
      {confirmText(line, change)}
      <button type="button" onClick={submit} disabled={busy}>확인하고 저장</button>
      <button type="button" onClick={() => setAsking(false)} disabled={busy}>취소</button>
    </p>}
    {message && <p className={message.ok ? "st-hint" : "st-error"} role={message.ok ? "status" : "alert"}>{message.text}</p>}
    <small className="st-night-clear">값 지우기: <code>kadan night repo {line.github} --clear deployBranch|nightMerge</code></small>
  </form>;
}
