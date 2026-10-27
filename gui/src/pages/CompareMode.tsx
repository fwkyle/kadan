import {useContext, useEffect, useId, useState} from 'react';
import {json, save, useResource} from '../resource';
import {cardUrl} from '../navigation';
import {AppContext, ErrorMessage} from '../ui';
import type {Choice, Settings} from './Runners';
import './CompareMode.css';

type ReportRow = {
  preset: string; worker?: Choice; picks: number; starts: number; samples: number;
  independentSamples: number; completedSamples: number; firstRoundPasses: number;
  medianRounds: number | null; medianImplementationMs: number | null;
  failed: number; inProgress: number; excluded: Record<string, number>;
  workIds: string[]; cardIds: string[];
};
type Report = {
  asOf: string; since: string | null;
  groups: {reviewer?: Choice; rows: ReportRow[]}[];
  excluded: Record<string, number>; reservationsWithoutStart: string[];
  mixed: {workId: string; presets: string[]; cardIds: string[]}[];
};
const choice = (value?: Choice) => value
  ? [value.runner, value.model, value.effort].filter(Boolean).join(' / ') : '확인 필요';
const number = (value: number | null) => value == null ? '—' : String(Math.round(value * 100) / 100);
const reasons = (value: Record<string, number>) => Object.entries(value)
  .map(([name, count]) => `${name} ${count}`).join(' · ') || '없음';
function Links({ids, work = false}: {ids: string[]; work?: boolean}) {
  return ids.length ? <ul>{ids.map(id => <li key={id}>
    <a href={cardUrl(work ? `work:${id}` : id)}>{id}</a>
  </li>)}</ul> : <>없음</>;
}

export function CompareMode({settings}: {settings: Settings}) {
  const context = useContext(AppContext), id = useId();
  const enabled = settings.compare?.enabled ?? false;
  const stamp = JSON.stringify(settings.compare ?? null);
  const [base, setBase] = useState(stamp);
  const [selected, setSelected] = useState(settings.compare?.presets ?? []);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [reason, setReason] = useState(''), [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false), [reportError, setReportError] = useState<string | null>(null);
  const counts = useResource<{revision: number; picks: Record<string, number>}>(
    '/runners/compare', {pollMs: 0});
  const conflict = dirty && (base !== stamp || selected.some(name => !Object.hasOwn(settings.presets, name)));
  useEffect(() => {
    if (!dirty && !busy) { setSelected(settings.compare?.presets ?? []); setBase(stamp); }
  }, [settings, stamp, dirty, busy]);
  useEffect(() => {
    context.draft(id, dirty || busy);
    return () => context.draft(id, false);
  }, [context.draft, id, dirty, busy]);
  const move = (index: number, offset: number) => {
    const next = [...selected];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    setSelected(next); setDirty(true);
  };
  const change = async (mode: 'on' | 'off') => {
    if (busy || context.readOnly || (mode === 'on' && conflict)) return;
    if (!reason.trim()) { setError('바꾸는 이유를 적어 주세요.'); return; }
    setBusy(true); setError(null);
    try {
      await save('/runners/compare', {mode, presets: JSON.stringify(selected),
        revision: String(settings.revision), reason}, context.token);
      setDirty(false); setReason(''); setReport(null);
      context.notice(mode === 'on' ? '비교 모드의 새 회차를 시작했습니다.' : '비교 모드를 껐습니다.');
    } catch (e) { setError(e instanceof Error ? e.message : '저장 실패'); }
    finally { setBusy(false); }
  };
  const loadReport = async () => {
    if (loading) return;
    setLoading(true); setReportError(null);
    try { setReport(await json<Report>('/runners/compare-report')); }
    catch (e) { setReportError(e instanceof Error ? e.message : '조회 실패'); }
    finally { setLoading(false); }
  };
  return <section className="compare-mode" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>비교 모드</h2>
    <p><strong>{enabled ? '켜짐' : '꺼짐'}</strong> · 회차 시작 시각:{' '}
      {settings.compare?.enabledAt ?? '아직 없음'}</p>
    <p>다음 작업자는 가장 적게 뽑힌 프리셋부터 고릅니다. 횟수가 같으면 목록 순서를 따릅니다.
      목록을 적용하면 새 회차를 시작합니다. 이미 열린 창은 그대로입니다.</p>
    <p>현재 목록: {settings.compare?.presets.join(' → ') || '없음'}</p>
    <p>프리셋별 뽑힌 수:{' '}{counts.data?.revision === settings.revision
      ? (settings.compare?.presets ?? []).map(name => `${name} ${counts.data!.picks[name] ?? 0}`).join(' · ') || '없음'
      : '확인 중'}</p>
    <button type="button" onClick={() => void counts.refresh(true)} disabled={counts.refreshing}>뽑힌 수 새로 읽기</button>
    <ErrorMessage error={counts.error} />
    {!context.readOnly && <>
      <fieldset disabled={busy}>
        <legend>비교할 프리셋 고르기</legend>
        {Object.keys(settings.presets).map(name => <label key={name}>
          <input type="checkbox" checked={selected.includes(name)} onChange={e => {
            setSelected(e.target.checked ? [...selected, name] : selected.filter(n => n !== name));
            setDirty(true);
          }} />{name}
        </label>)}
        <ol>{selected.map((name, index) => <li key={name}>{name}{' '}
          <button type="button" aria-label={`${name} 위로`} disabled={index === 0}
            onClick={() => move(index, -1)}>위로</button>{' '}
          <button type="button" aria-label={`${name} 아래로`} disabled={index === selected.length - 1}
            onClick={() => move(index, 1)}>아래로</button>
        </li>)}</ol>
        <label>비교 모드 바꾸는 이유<input maxLength={500} value={reason}
          onChange={e => setReason(e.target.value)} /></label>
        <button type="button" disabled={!selected.length || conflict} onClick={() => void change('on')}>
          {enabled ? '목록 적용 · 새 회차 시작' : '비교 모드 켜기'}</button>{' '}
        <button type="button" disabled={!enabled} onClick={() => void change('off')}>비교 모드 끄기</button>{' '}
        <button type="button" onClick={() => {
          setSelected(settings.compare?.presets ?? []); setBase(stamp); setDirty(false); setError(null);
        }}>현재 목록 불러오기</button>
      </fieldset>
      {conflict && <p className="warning">비교 설정이나 프리셋 목록이 바뀌었습니다. 현재 목록을 불러온 뒤 다시 고르세요.</p>}
      <ErrorMessage error={error} />
    </>}
    <h3>비교 결과</h3>
    <p>결과 보기 버튼을 누른 시점의 기록입니다. 업무당 1표본이며 검수자 묶음 사이의 순위는 매기지 않습니다.</p>
    <button type="button" disabled={loading} onClick={() => void loadReport()}>
      {loading ? '결과 읽는 중…' : '결과 보기'}</button>
    <ErrorMessage error={reportError} />
    {report && <>
      <p>조회 시각: {report.asOf} · 기간: {report.since ?? '기록 없음'} 이후</p>
      {!report.groups.length && <p>아직 비교 기록이 없습니다.</p>}
      {report.groups.map((group, index) => <section key={index}>
        <h4>검수자 {choice(group.reviewer)}</h4>
        <div className="table-scroll" tabIndex={0} role="region" aria-label={`검수자 ${choice(group.reviewer)} 결과 표`}>
          <table><thead><tr>
            {['프리셋 / 작업자', '예약', '시작', '표본', '독립', '첫 왕복 통과', '왕복 중앙',
              '구현 분 중앙', 'failed', '진행 중', '제외 사유', '업무', '카드'].map(text => <th key={text}>{text}</th>)}
          </tr></thead><tbody>{group.rows.map((row, i) => <tr key={i}>
            <th>{row.preset}<br />{choice(row.worker)}</th>
            <td>{row.picks}</td><td>{row.starts}</td><td>{row.samples}</td><td>{row.independentSamples}</td>
            <td>{row.firstRoundPasses}/{row.completedSamples}</td><td>{number(row.medianRounds)}</td>
            <td>{number(row.medianImplementationMs == null ? null : row.medianImplementationMs / 60000)}</td>
            <td>{row.failed}</td><td>{row.inProgress}</td><td>{reasons(row.excluded)}</td>
            <td><Links ids={row.workIds} work /></td><td><Links ids={row.cardIds} /></td>
          </tr>)}</tbody></table>
        </div>
      </section>)}
      <p>제외 사유 (업무 수): {reasons(report.excluded)}</p>
      <h4>혼합 군 ({report.mixed.length})</h4>
      {report.mixed.map(work => <div key={work.workId}>
        <Links ids={[work.workId]} work /><p>프리셋: {work.presets.join(' · ')}</p><Links ids={work.cardIds} />
      </div>)}
      <p>예약만 있고 시작 없음: {report.reservationsWithoutStart.length}건 (시작 중인지 실패했는지는 미확인)</p>
    </>}
  </section>;
}
