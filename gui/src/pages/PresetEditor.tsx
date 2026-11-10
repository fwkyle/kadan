import {useContext, useEffect, useId, useState} from 'react';
import {save} from '../resource';
import {AppContext, ErrorMessage} from '../ui';
import {HARD_ROLE, clearPreset, presetSaveFields, presetStamp, stagePreset} from '../preset-draft';
import {RunnerForm} from './RunnerForm';
import type {Choice, RunnersData, Settings} from './Runners';

// 어려운 일 작업자 자리: 폴백 목록이 없고, 비우면 작업자와 같은 값으로 띄운다. 비우기도 저장 전까지는 변경안이다.
export function HardSlot({draft, clear}: {draft: Settings; clear: () => void}) {
  const value = draft.presets[draft.activePreset].roles[HARD_ROLE] as Choice | undefined;
  return <div className="action-form">
    <p>{value ? `지금 값: ${[value.runner, value.model, value.effort].filter(Boolean).join(' / ')}`
      : '비어 있음 — 작업자와 같은 값으로 띄웁니다'}</p>
    <p className="muted">어려움 카드를 맡길 작업자를 <code>kadan start 역할 --profile worker --difficulty hard</code>로 띄울 때 쓰는 값입니다. 대체 후보는 없습니다.</p>
    <button type="button" disabled={!value} onClick={clear}>비우기</button>
  </div>;
}

export function PresetEditor({data, settings}: {data: RunnersData; settings: Settings}) {
  const context = useContext(AppContext), id = useId();
  const [draft, setDraft] = useState(settings), [base, setBase] = useState(presetStamp(settings));
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]), [reset, setReset] = useState(0);
  const dirty = presetStamp(draft) !== base;
  const locked = settings.compare?.enabled && settings.compare.presets.includes(settings.activePreset);
  const conflict = dirty && presetStamp(settings) !== base;
  useEffect(() => {
    context.draft(id, dirty || busy);
    return () => context.draft(id, false);
  }, [context.draft, id, dirty, busy]);
  useEffect(() => {
    if (busy) return;
    if (!dirty) { setDraft(settings); setBase(presetStamp(settings)); }
    // 다른 프리셋·모델 목록·즐겨찾기만 바뀌었으면 최신 revision으로 이어 쓴다.
    else if (presetStamp(settings) === base) setDraft(old => ({...old, revision: settings.revision}));
  }, [settings, busy, dirty, base]);
  return <div style={{wordBreak: 'keep-all', overflowWrap: 'break-word', textWrap: 'pretty'}}>
    <p>여러 역할의 모델·대체 후보를 고친 뒤 <strong>프리셋 저장</strong>을 한 번 누르세요.
      저장 전에는 실행 모델 설정이 바뀌지 않습니다.</p>
    {locked && <p className="warning">비교 모드 중 — 먼저 끄기</p>}
    <fieldset disabled={busy || conflict || locked}>
      {Object.entries(data.roles).map(([role, label]) => <details key={`${reset}:${role}`}>
        <summary>{label} 바꾸기</summary>
        {role !== 'senior' && <RunnerForm data={data} settings={draft} role={role}
          stage={(r, f, c, op) => setDraft(stagePreset(draft, r, f, c, op))} />}
        {role === HARD_ROLE ? <HardSlot draft={draft} clear={() => setDraft(clearPreset(draft, HARD_ROLE))} />
          : <RunnerForm data={data} settings={draft} role={role} fallback
            stage={(r, f, c, op) => setDraft(stagePreset(draft, r, f, c, op))} />}
      </details>)}
    </fieldset>
    {conflict && <p className="warning">다른 곳에서 이 프리셋이 바뀌었습니다. 최신 값을 불러온 뒤 다시 고르세요.</p>}
    <form className="action-form" onSubmit={async event => {
      event.preventDefault();
      if (busy || !dirty || conflict || locked) return;
      setBusy(true); setError(null);
      try {
        const saved = await save('/runners/preset-save', presetSaveFields(draft, reason), context.token);
        setWarnings(saved.result.warnings ?? []);
        setBase(presetStamp(draft)); setReason('');
        context.notice('프리셋을 저장했습니다. 다음 발령부터 적용됩니다.');
      } catch (e) { setError(e instanceof Error ? e.message : '저장 실패'); }
      finally { setBusy(false); }
    }}>
      <label>바꾸는 이유<input required maxLength={500} value={reason}
        disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      <button className="primary" disabled={busy || !dirty || conflict || locked}>
        {busy ? '저장 중…' : '프리셋 저장'}
      </button>
      <button type="button" disabled={busy} onClick={() => {
        setDraft(settings); setBase(presetStamp(settings)); setReason(''); setError(null);
        setReset(n => n + 1);
      }}>지금 값 불러오기</button>
    </form>
    <ErrorMessage error={error} />
    {warnings.map(message => <p className="warning" key={message}>{message}</p>)}
  </div>;
}
