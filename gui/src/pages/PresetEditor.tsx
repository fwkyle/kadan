import {Fragment, useContext, useEffect, useId, useState} from 'react';
import {save} from '../resource';
import {AppContext, ErrorMessage} from '../ui';
import {
  HARD_ROLE, clearPreset, presetSaveFields, presetStamp, reasonFor, stagePreset,
} from '../preset-draft';
import {changedRoles, emptyModelRoles} from '../runner-draft';
import {RunnerForm} from './RunnerForm';
import {summaryCells} from './RunnerSummary';
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

const sameList = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

function List({items, empty}: {items: string[]; empty: string}) {
  return items.length ? <ol>{items.map((item, i) => <li key={i}>{item}</li>)}</ol> : <>{empty}</>;
}

// '다음 발령의 실행 모델' 표 = 편집기. 표와 편집 칸이 초안 하나를 같이 본다(저장 전 충돌 판정도 하나).
// 고칠 곳은 표의 '지금 값'(= 활성 프리셋)이라 저장도 활성 프리셋에 한다. 새 저장소·서버 경로는 없다.
export function PresetEditor({data, settings, initialOpen = []}: {
  data: RunnersData; settings: Settings; initialOpen?: string[];
}) {
  const context = useContext(AppContext), id = useId();
  const [draft, setDraft] = useState(settings), [base, setBase] = useState(presetStamp(settings));
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]), [reset, setReset] = useState(0);
  // 편집 칸을 여는 것만으로는 초안이 바뀌지 않는다(열린 줄 이름만 따로 든다).
  const [open, setOpen] = useState<string[]>(initialOpen);
  const dirty = presetStamp(draft) !== base;
  const locked = Boolean(settings.compare?.enabled && settings.compare.presets.includes(settings.activePreset));
  const conflict = dirty && presetStamp(settings) !== base;
  const frozen = busy || conflict || locked;
  const changed = changedRoles(settings, draft, Object.keys(data.roles));
  // 모델을 안 고른 초안은 서버까지 보내지 않고 저장 줄에서 알린다.
  const unpicked = emptyModelRoles(draft, Object.keys(data.roles)).map(role => data.roles[role] ?? role);
  const blocked = frozen || unpicked.length > 0;
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
  const stage = (r: string, f: boolean, c: Choice, op: string) => setDraft(stagePreset(draft, r, f, c, op));
  const discard = () => {
    setDraft(settings); setBase(presetStamp(settings)); setReason(''); setError(null);
    setOpen([]); setReset(n => n + 1);
  };
  const toggle = (role: string) => setOpen(old => old.includes(role) ? old.filter(r => r !== role) : [...old, role]);
  return <div style={{wordBreak: 'keep-all', overflowWrap: 'break-word', textWrap: 'pretty'}}>
    <p className="muted">역할 줄의 <strong>바꾸기</strong>로 값을 고른 뒤 표 아래 <strong>저장</strong>을 한 번 누르세요.
      저장 전에는 실행 모델 설정이 바뀌지 않습니다.</p>
    {locked && <p className="warning">비교 모드 중 — 먼저 끄기</p>}
    <div className="table-scroll runners-summary">
      <table>
        <thead>
          <tr>
            <th>역할</th>
            <th>지금 값</th>
            <th>대체 후보 (순서대로)</th>
            <th>발령 때 채워질 명령</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data.roles).map(([role, label]) => {
            const cells = summaryCells(data, role), next = summaryCells(data, role, draft);
            const edited = changed.includes(role), isOpen = open.includes(role);
            const listChanged = edited && !sameList(cells.fallbacks, next.fallbacks);
            return <Fragment key={role}>
              <tr className={edited ? 'is-changed' : undefined}>
                <th>{label}<br />
                  <button type="button" className="row-edit" aria-expanded={isOpen}
                    disabled={!isOpen && frozen} onClick={() => toggle(role)}>
                    {isOpen ? '닫기' : '바꾸기'}
                  </button>
                </th>
                <td>{edited && cells.value !== next.value
                  ? <>{cells.value} → <strong>{next.value}</strong> <span className="pending-mark">(저장 전)</span></>
                  : cells.value}</td>
                <td>{listChanged
                  ? <>
                    <div>지금: <List items={cells.fallbacks} empty="없음" /></div>
                    <div><strong>바꿀 값</strong> <span className="pending-mark">(저장 전)</span>: <List items={next.fallbacks} empty="없음" /></div>
                  </>
                  : <List items={cells.fallbacks} empty={cells.note} />}</td>
                <td><code>{cells.command}</code></td>
              </tr>
              {isOpen && <tr className="runner-edit-row">
                <td colSpan={4}>
                  <div className="runner-edit">
                    <fieldset disabled={frozen}>
                      <legend>{label} 바꾸기</legend>
                      {role !== 'senior' && <RunnerForm key={`${reset}:${role}:base`} data={data} settings={draft}
                        role={role} stage={stage} />}
                      {role === HARD_ROLE ? <HardSlot draft={draft} clear={() => setDraft(clearPreset(draft, HARD_ROLE))} />
                        : <RunnerForm key={`${reset}:${role}:fallback`} data={data} settings={draft} role={role}
                          fallback stage={stage} />}
                    </fieldset>
                  </div>
                </td>
              </tr>}
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
    {dirty && <div className="runner-save-bar"><form className="runner-save-row" onSubmit={async event => {
      event.preventDefault();
      if (blocked) return;
      setBusy(true); setError(null);
      try {
        const labels = changed.map(role => data.roles[role] ?? role);
        const saved = await save('/runners/preset-save', presetSaveFields(draft, reasonFor(reason, labels)), context.token);
        setWarnings(saved.result.warnings ?? []);
        setBase(presetStamp(draft)); setReason(''); setOpen([]); setReset(n => n + 1);
        context.notice('저장했습니다. 다음 발령부터 적용됩니다.');
      } catch (e) { setError(e instanceof Error ? e.message : '저장 실패'); }
      finally { setBusy(false); }
    }}>
      <p className="save-title"><strong>{changed.length ? `바꾼 것 ${changed.length}줄` : '바꾼 것 있음'} — 아직 저장 전</strong></p>
      <button className="primary" disabled={blocked}>{busy ? '저장 중…' : '저장'}</button>
      <button type="button" disabled={busy} onClick={discard}>되돌리기</button>
      <p className="muted save-note">프리셋 <strong>{settings.activePreset}</strong>에 저장됩니다. 다음 발령부터 적용되고 열린 창은 그대로입니다.</p>
      {conflict && <p className="save-warn">다른 곳에서 이 프리셋이 바뀌었습니다. 되돌리기로 최신 값을 불러온 뒤 다시 고르세요.</p>}
      {unpicked.length > 0 && <p className="save-warn">{unpicked.map(label => `${label}: 모델을 고르세요`).join(' · ')}</p>}
      <details className="save-reason"><summary>바꾸는 이유 적기 (선택)</summary>
        <input aria-label="바꾸는 이유" maxLength={500} value={reason} disabled={busy}
          placeholder="비우면 바꾼 역할 이름으로 채웁니다" onChange={event => setReason(event.target.value)} />
      </details>
    </form>
    <ErrorMessage error={error} /></div>}
    {!dirty && <ErrorMessage error={error} />}
    {warnings.map(message => <p className="warning" key={message}>{message}</p>)}
  </div>;
}
