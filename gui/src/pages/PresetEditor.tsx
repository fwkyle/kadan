import {Fragment, useContext, useEffect, useId, useState} from 'react';
import {save} from '../resource';
import {AppContext, ErrorMessage} from '../ui';
import {
  HARD_ROLE, adoptSettings, clearPreset, followSettings, presetSaveFields, presetStamp, reasonFor, stagePreset, withRegistered,
} from '../preset-draft';
import {changedRoles, effortProblems, emptyModelRoles} from '../runner-draft';
import {EMPTY_EFFORT_NOTE} from '../effort-keep';
import {RunnerForm} from './RunnerForm';
import {CommandFold, summaryCells} from './RunnerSummary';
import type {Choice, RunnersData, Settings} from './Runners';

// 어려운 일 작업자 자리의 값이 정해져 있는가(모델까지 골랐는가). 대체 후보 칸은 이때만 연다.
export const hardReady = (draft: Settings) =>
  Boolean((draft.presets[draft.activePreset].roles[HARD_ROLE] as Choice | undefined)?.model);

// 어려운 일 작업자 자리: 비우면 작업자와 같은 값으로 띄운다. 값이 있어야 대체 후보를 둘 수 있고, 비우면 대체 후보도 함께 지운다.
// 비우기도 저장 전까지는 변경안이다.
export function HardSlot({draft, clear}: {draft: Settings; clear: () => void}) {
  const value = draft.presets[draft.activePreset].roles[HARD_ROLE] as Choice | undefined;
  const count = draft.presets[draft.activePreset].fallback?.[HARD_ROLE]?.length ?? 0;
  return <div className="action-form">
    <p>{value ? `지금 값: ${[value.runner, value.model, value.effort].filter(Boolean).join(' / ')}`
      : '비어 있음 — 작업자와 같은 값으로 띄웁니다'}</p>
    <p className="muted">어려움 카드를 맡길 작업자를 <code>kadan start 역할 --profile worker --difficulty hard</code>로 띄울 때 쓰는 값입니다.
      {hardReady(draft)
        ? ' 대체 후보는 아래에서 고르고, 번호로 띄웁니다: --difficulty hard --fallback 번호. 비우면 대체 후보도 함께 지워집니다.'
        : ' 값을 정하면 대체 후보 칸이 열립니다. 값이 비어 있으면 작업자와 같아 따로 후보를 둘 수 없습니다.'}</p>
    <button type="button" disabled={!value} onClick={clear}>비우기{count ? ` (대체 후보 ${count}개도 지움)` : ''}</button>
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
  // 강도를 고르지 않았거나(조용히 낮은 강도로 저장되지 않게) 강도 목록이 빈 모델이면 서버가 거절하므로 저장하지 않는다.
  const problems = effortProblems(draft, changed, data.catalog);
  const noEffort = problems.filter(p => p.kind === 'pick').map(p => data.roles[p.role] ?? p.role);
  const emptyList = problems.filter(p => p.kind === 'empty').map(p => data.roles[p.role] ?? p.role);
  const blocked = frozen || unpicked.length > 0 || problems.length > 0;
  useEffect(() => {
    context.draft(id, dirty || busy);
    return () => context.draft(id, false);
  }, [context.draft, id, dirty, busy]);
  useEffect(() => {
    if (busy) return;
    // 버전은 올라가기만 한다: 등록 응답으로 올린 버전을 늦게 온 옛 읽기가 되돌리지 않는다(followSettings·adoptSettings).
    if (!dirty) { setDraft(old => adoptSettings(old, settings)); setBase(presetStamp(settings)); }
    // 다른 프리셋·모델 목록·즐겨찾기만 바뀌었으면 최신 revision으로 이어 쓴다.
    else if (presetStamp(settings) === base) setDraft(old => followSettings(old, settings));
  }, [settings, busy, dirty, base]);
  const stage = (r: string, f: boolean, c: Choice, op: string) => setDraft(stagePreset(draft, r, f, c, op));
  // 바꾸기 창에서 새 모델을 등록했다: 설정 버전만 올라간 것이라 고친 다른 줄은 그대로 두고 버전만 이어 쓴다.
  // 이 줄은 등록한 모델을 고른 변경안으로 만든다(대체 후보 칸은 '추가'를 눌러야 반영). 등록을 기다리는 동안 고친 줄을 잃지 않게 함수형 갱신이다.
  const registered = (role: string, fallback: boolean, choice: Choice, revision: number) =>
    setDraft(old => withRegistered(old, role, fallback, choice, revision));
  const discard = () => {
    setDraft(old => adoptSettings(old, settings)); setBase(presetStamp(settings)); setReason(''); setError(null);
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
                  : cells.value}
                  <CommandFold command={cells.command} /></td>
                <td>{listChanged
                  ? <>
                    <div>지금: <List items={cells.fallbacks} empty="없음" /></div>
                    <div><strong>바꿀 값</strong> <span className="pending-mark">(저장 전)</span>: <List items={next.fallbacks} empty="없음" /></div>
                  </>
                  : <List items={cells.fallbacks} empty={cells.note} />}</td>
              </tr>
              {isOpen && <tr className="runner-edit-row">
                <td colSpan={3}>
                  <div className="runner-edit">
                    <fieldset disabled={frozen}>
                      <legend>{label} 바꾸기</legend>
                      {role !== 'senior' && <RunnerForm key={`${reset}:${role}:base`} data={data} settings={draft}
                        role={role} stage={stage} registered={registered} />}
                      {role === HARD_ROLE && <HardSlot draft={draft} clear={() => setDraft(clearPreset(draft, HARD_ROLE))} />}
                      {(role !== HARD_ROLE || hardReady(draft)) && <RunnerForm key={`${reset}:${role}:fallback`} data={data}
                        settings={draft} role={role} fallback stage={stage} registered={registered} />}
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
      {noEffort.length > 0 && <p className="save-warn">{noEffort.map(label => `${label}: 강도를 고르세요`).join(' · ')}</p>}
      {emptyList.length > 0 && <p className="save-warn">{emptyList.map(label => `${label}: ${EMPTY_EFFORT_NOTE}`).join(' · ')}</p>}
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
