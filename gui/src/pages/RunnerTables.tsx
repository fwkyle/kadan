import { useContext, useState } from "react";
import { save } from "../resource";
import { AppContext, ErrorMessage } from "../ui";

export type RunnerCatalog = Record<
  string,
  {
    spawn: string;
    catalog?: boolean;
    canListModels?: boolean;
    table?: Record<string, string>;
    conversation?: string;
    models: { model: string; efforts: string[] }[];
  }
>;
type Listed = { model: string; name: string; registered: boolean };
const TABLE_LABELS: [string, string][] = [
  ["resume", "다시 열기(resume)"],
  ["fork", "갈라 열기(fork)"],
  ["exec", "한 번 호출(exec)"],
  ["execField", "답 필드(execField)"],
  ["version", "버전 확인(version)"],
  ["update", "업데이트(update)"],
  ["listModels", "모델 목록 명령(listModels)"],
];

// 실행기마다 모델 등록·삭제와 명령 표 편집. 저장 검사는 서버의 공통 함수가 한다.
export function RunnerTables({ catalog, revision }: { catalog: RunnerCatalog; revision: number }) {
  return (
    <>
      <h2>실행기 모델·명령 표</h2>
      <p className="muted">
        실행기마다 고를 수 있는 모델을 등록·삭제하고, 다시 열기·한 번 호출 같은 명령 표를 고칩니다. 쓰고 있는 모델은 지울 수 없습니다.
      </p>
      {Object.entries(catalog).map(([name, spec]) => (
        <details key={name} className="runner-table">
          <summary>
            {name} · 모델 {spec.catalog ? "codex 목록 파일을 따름" : `${spec.models.length}개`}
          </summary>
          {spec.catalog ? (
            <p className="muted">codex 목록 파일을 따릅니다. 모델은 직접 등록·삭제하지 않습니다.</p>
          ) : (
            <Models name={name} spec={spec} revision={revision} />
          )}
          <TableForm name={name} spec={spec} revision={revision} />
        </details>
      ))}
      <NewRunner revision={revision} />
    </>
  );
}

function useSaver() {
  const context = useContext(AppContext);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const run = async (action: string, fields: Record<string, string>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await save(action, fields, context.token);
      context.notice(done);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, setBusy, run, context };
}

function Models({ name, spec, revision }: { name: string; spec: RunnerCatalog[string]; revision: number }) {
  const { busy, error, setError, setBusy, run, context } = useSaver();
  const [model, setModel] = useState(""),
    [efforts, setEfforts] = useState(""),
    [reason, setReason] = useState(""),
    [listed, setListed] = useState<Listed[] | null>(null);
  const noReason = !reason.trim();
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await save("/runners/models-list", { runner: name }, context.token);
      setListed((saved.result as unknown as { models: Listed[] }).models);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setBusy(false);
    }
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (noReason) return setError("바꾸는 이유를 적어 주세요.");
    if (await run("/runners/model-add", { runner: name, model, efforts, reason, revision: String(revision) }, `${name} 모델을 등록했습니다: ${model}`)) {
      setModel("");
      setEfforts("");
      setReason("");
      setListed(null);
    }
  };
  // 삭제도 등록처럼 사람이 이유를 적어야 한다. 이유 칸이 비어 있으면 삭제 버튼을 막고 안내한다.
  const remove = (m: string) =>
    run("/runners/model-remove", { runner: name, model: m, reason, revision: String(revision) }, `${name} 모델을 뺐습니다: ${m}`);
  return (
    <div>
      <label>
        바꾸는 이유 (필수 — 등록·삭제가 함께 씁니다)
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {noReason && <p className="muted">이유를 적으면 삭제·등록할 수 있습니다.</p>}
      <h3>등록된 모델</h3>
      <ul>
        {spec.models.map((m) => (
          <li key={m.model}>
            {m.model} <small className="muted">({m.efforts.join(", ") || "강도 없음"})</small>{" "}
            <button type="button" disabled={busy || noReason} onClick={() => remove(m.model)}>
              삭제
            </button>
          </li>
        ))}
        {!spec.models.length && <li className="muted">없음</li>}
      </ul>
      <form className="action-form" onSubmit={add}>
        <fieldset disabled={busy}>
          {spec.canListModels && (
            <p>
              <button type="button" onClick={load}>
                목록 불러오기
              </button>{" "}
              <small className="muted">실행기의 목록 명령을 20초 안에서 한 번 돌립니다. 저장하지 않습니다.</small>
            </p>
          )}
          {listed && (
            <label>
              아직 등록 안 된 모델
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">고르기</option>
                {listed.map((m) => (
                  <option key={m.model} value={m.model} disabled={m.registered}>
                    {m.model}
                    {m.name ? ` — ${m.name}` : ""}
                    {m.registered ? " · 이미 등록됨" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            모델 이름{!spec.canListModels && " (직접 적기)"}
            <input required value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label>
            강도 목록 (쉼표, 비워도 됨)
            <input value={efforts} onChange={(e) => setEfforts(e.target.value)} placeholder="low,medium,high" />
          </label>
          <button className="primary">모델 등록</button>
        </fieldset>
      </form>
      <ErrorMessage error={error} />
    </div>
  );
}

function TableForm({ name, spec, revision }: { name: string; spec: RunnerCatalog[string]; revision: number }) {
  const { busy, error, run } = useSaver();
  const initial = () => ({ spawn: spec.spawn, conversation: spec.conversation ?? "", ...Object.fromEntries(TABLE_LABELS.map(([k]) => [k, spec.table?.[k] ?? ""])) }) as Record<string, string>;
  const [draft, setDraft] = useState(initial),
    [reason, setReason] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const base = initial();
    const table: Record<string, unknown> = {};
    let parseError: string | null = null;
    for (const key of [...TABLE_LABELS.map(([k]) => k), "conversation"]) {
      if (draft[key] === base[key]) continue;
      if (draft[key].trim() === "") table[key] = null;
      else if (key === "conversation") {
        try { table[key] = JSON.parse(draft[key]); } catch { parseError = "conversation은 JSON이어야 합니다"; }
      } else table[key] = draft[key];
    }
    if (parseError) return alertError(parseError);
    const fields: Record<string, string> = { runner: name, reason, revision: String(revision), table: JSON.stringify(table) };
    if (draft.spawn !== spec.spawn) fields.spawn = draft.spawn;
    if (await run("/runners/runner", fields, `${name} 명령 표를 저장했습니다. 다음 발령부터 적용됩니다.`)) setReason("");
  };
  const [local, setLocal] = useState<string | null>(null);
  const alertError = (m: string) => setLocal(m);
  return (
    <form className="action-form" onSubmit={submit}>
      <h3>명령 표 (빈 칸으로 저장하면 그 칸을 지웁니다)</h3>
      <fieldset disabled={busy}>
        <label>
          대화형 실행(spawn) — {"{model}"} 필수
          <input value={draft.spawn} onChange={(e) => setDraft({ ...draft, spawn: e.target.value })} />
        </label>
        {TABLE_LABELS.map(([key, text]) => (
          <label key={key}>
            {text}
            <input value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
          </label>
        ))}
        <label>
          대화 찾는 법(conversation, JSON)
          <textarea rows={4} value={draft.conversation} onChange={(e) => setDraft({ ...draft, conversation: e.target.value })} />
        </label>
        <label>
          바꾸는 이유 (필수)
          <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button className="primary">{busy ? "저장 중…" : "명령 표 저장"}</button>
      </fieldset>
      <ErrorMessage error={error || local} />
    </form>
  );
}

function NewRunner({ revision }: { revision: number }) {
  const { busy, error, run } = useSaver();
  const [name, setName] = useState(""),
    [spawn, setSpawn] = useState(""),
    [reason, setReason] = useState("");
  return (
    <details>
      <summary>새 실행기 추가</summary>
      <form
        className="action-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run("/runners/runner", { runner: name, spawn, reason, revision: String(revision), table: "{}" }, `실행기를 추가했습니다: ${name}`)) {
            setName(""); setSpawn(""); setReason("");
          }
        }}
      >
        <fieldset disabled={busy}>
          <label>실행기 이름<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>대화형 실행(spawn) — {"{model}"} 필수<input required value={spawn} onChange={(e) => setSpawn(e.target.value)} /></label>
          <label>바꾸는 이유 (필수)<input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button className="primary">실행기 추가</button>
        </fieldset>
        <ErrorMessage error={error} />
      </form>
    </details>
  );
}
