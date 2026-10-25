import {useContext, useEffect, useId, useState} from 'react';
import {save} from '../resource';
import {AppContext, ErrorMessage} from '../ui';
import {presetSaveFields, presetStamp, stagePreset} from '../preset-draft';
import {RunnerForm} from './RunnerForm';
import type {RunnersData, Settings} from './Runners';

export function PresetEditor({data, settings}: {data: RunnersData; settings: Settings}) {
  const context = useContext(AppContext), id = useId();
  const [draft, setDraft] = useState(settings), [base, setBase] = useState(presetStamp(settings));
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]), [reset, setReset] = useState(0);
  const dirty = presetStamp(draft) !== base;
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
    <fieldset disabled={busy || conflict}>
      {Object.entries(data.roles).map(([role, label]) => <details key={`${reset}:${role}`}>
        <summary>{label} 바꾸기</summary>
        {role !== 'senior' && <RunnerForm data={data} settings={draft} role={role}
          stage={(r, f, c, op) => setDraft(stagePreset(draft, r, f, c, op))} />}
        <RunnerForm data={data} settings={draft} role={role} fallback
          stage={(r, f, c, op) => setDraft(stagePreset(draft, r, f, c, op))} />
      </details>)}
    </fieldset>
    {conflict && <p className="warning">다른 곳에서 이 프리셋이 바뀌었습니다. 최신 값을 불러온 뒤 다시 고르세요.</p>}
    <form className="action-form" onSubmit={async event => {
      event.preventDefault();
      if (busy || !dirty || conflict) return;
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
      <button className="primary" disabled={busy || !dirty || conflict}>
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
