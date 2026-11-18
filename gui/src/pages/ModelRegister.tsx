import { useContext, useState } from "react";
import { save } from "../resource";
import { registerModel } from "../model-register";
import { AppContext, ErrorMessage } from "../ui";
import type { Choice, RunnersData } from "./Runners";

// 바꾸기 창 안 '+ 새 모델 등록'. 기존 /runners/model-add를 그대로 불러 그 실행기에 등록한다(서버 검사·거절 문구 그대로).
// 등록은 누르는 즉시 저장되는 별도 변경이고, 역할 값 변경은 표 아래 저장을 눌러야 적용된다.
// codex처럼 모델 목록을 파일에서 읽는 실행기(catalog)는 직접 등록하지 않으므로 이 칸을 그리지 않는다.
export function ModelRegister({ data, runner, revision, currentEffort, done }: {
  data: RunnersData;
  runner: string;
  revision: number;
  // 지금 고른 강도. 등록한 새 모델이 지원하면 유지한다.
  currentEffort?: string;
  done: (choice: Choice, revision: number) => void;
}) {
  const context = useContext(AppContext);
  const spec = data.catalog[runner];
  const [model, setModel] = useState(""),
    [efforts, setEfforts] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [registered, setRegistered] = useState<string | null>(null);
  if (!spec || spec.catalog) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!model.trim()) return setError("모델 이름을 적으세요.");
    setBusy(true);
    setError(null);
    try {
      // 등록으로 설정 버전이 올랐다. 작성 중인 변경안이 이 버전으로 이어서 저장되게 done으로 알린다.
      const choice = await registerModel(save, context.token, { runner, model, efforts, revision, needsEffort: spec.needsEffort, currentEffort }, done);
      setRegistered(choice.model);
      setModel("");
      setEfforts("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="model-register">
      <summary>+ 새 모델 등록 ({runner})</summary>
      <form className="action-form" onSubmit={submit}>
        <p className="muted">
          목록에 없는 모델을 <code>{runner}</code>에 등록하고 바로 고릅니다. <strong>등록은 누르는 즉시 저장</strong>되지만,
          이 줄의 값 변경은 표 아래 <strong>저장</strong>을 눌러야 적용됩니다.
        </p>
        <fieldset disabled={busy}>
          <label>
            모델 이름
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label>
            강도 목록 (쉼표, 비워도 됨)
            <input value={efforts} onChange={(e) => setEfforts(e.target.value)} placeholder="low,medium,high" />
          </label>
          <button className="primary">{busy ? "등록 중…" : "등록하고 고르기"}</button>
        </fieldset>
        {registered && !error && (
          <p className="muted">등록했고 <code>{registered}</code>을 골랐습니다. 이 값은 아직 저장 전입니다.</p>
        )}
        <ErrorMessage error={error} />
      </form>
    </details>
  );
}
