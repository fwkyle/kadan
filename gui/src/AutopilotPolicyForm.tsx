import { useContext, useState } from "react";
import { save } from "./resource";
import { AppContext } from "./ui";
import type { AutopilotLine } from "./autopilot-repos";
import { MERGE_CHOICES, canSave, cardHint, changesOf, confirmText, fieldsOf, forgetSaved, initialForm, problemOf, rememberSaved, savedNote } from "./autopilot-form";

// PR3b: github 한 줄의 정책 양식. 초기값·바뀜 판정은 카단 설정(settings) 기준이다.
// 저장은 기존 `POST /api/autopilot/repos` 그대로. save()가 성공하면 화면 자료를 한 번 다시 읽어(줄·사이드 🌙 뱃지가 같은 자료)
// 새 타이머는 두지 않는다. 지우기는 대시보드가 받지 않으므로 CLI 안내만 둔다.
export default function AutopilotPolicyForm({ line, autopilotOn }: { line: AutopilotLine; autopilotOn: boolean | null }) {
  const { token, readOnly } = useContext(AppContext);
  const [form, setForm] = useState(() => initialForm(line));
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // 성공 문구는 저장 뒤 다시 그려져도(양식이 새로 만들어져도) 남도록 모듈 바깥 기록에서 읽는다.
  const [okNote, setOkNote] = useState(() => savedNote(line.github));
  if (readOnly) return null;
  const locked = autopilotOn === true;
  const change = changesOf(line, form);
  const problem = problemOf(change);
  const ready = canSave(change) && !locked && !busy && !!token;
  const edit = (next: Partial<typeof form>) => { setForm({ ...form, ...next }); setAsking(false); setMessage(null); forgetSaved(line.github); setOkNote(null); };
  const submit = async () => {
    setBusy(true);
    try {
      await save("/api/autopilot/repos", fieldsOf(line, change), token);
      rememberSaved(line.github);
      setOkNote(savedNote(line.github));
      setMessage(null);
      setAsking(false);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "저장 실패" });
    } finally {
      setBusy(false);
    }
  };
  const deployHint = cardHint(line, "deployBranch"), mergeHint = cardHint(line, "nightMerge");
  return <form className="st-autopilot-form" onSubmit={(e) => { e.preventDefault(); if (ready) setAsking(true); }}>
    <label>배포 브랜치
      <input type="text" value={form.deploy} placeholder="브랜치 이름 또는 없음" disabled={locked || busy}
        onChange={(e) => edit({ deploy: e.target.value })} />
    </label>
    {deployHint && <small>{deployHint}</small>}
    <label>Autopilot 중 자동 머지
      <select value={form.merge} disabled={locked || busy} onChange={(e) => edit({ merge: e.target.value })}>
        <option value="">(그대로)</option>
        {MERGE_CHOICES.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    </label>
    {mergeHint && <small>{mergeHint}</small>}
    <button type="submit" disabled={!ready}>저장</button>
    {locked && <small role="status">Autopilot 켜짐 동안 바꿀 수 없음</small>}
    {problem && <small role="alert" className="st-error">{problem}</small>}
    {asking && ready && <p className="st-autopilot-confirm" role="status">
      {confirmText(line, change)}
      <button type="button" onClick={submit} disabled={busy}>확인하고 저장</button>
      <button type="button" onClick={() => setAsking(false)} disabled={busy}>취소</button>
    </p>}
    {okNote && !message && <p className="st-hint" role="status">{okNote}</p>}
    {message && <p className={message.ok ? "st-hint" : "st-error"} role={message.ok ? "status" : "alert"}>{message.text}</p>}
    <small className="st-autopilot-clear">값 지우기: <code>kadan autopilot repo {line.github} --clear deployBranch|nightMerge</code></small>
  </form>;
}
