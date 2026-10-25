import {useContext, useState} from 'react';
import {save} from '../resource';
import {AppContext, ErrorMessage} from '../ui';
import {downloadText} from '../download';
import {pickCopySource} from '../preset-draft';
import type {Settings} from './Runners';

// 프리셋 만들기(복사)·이름 바꾸기·삭제·내보내기·가져오기. 판정은 모두 서버(CLI와 같은 함수)가 한다.
export function PresetManager({settings}: {settings: Settings}) {
  const context = useContext(AppContext);
  const names = Object.keys(settings.presets);
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState(''), [chosenFrom, setFrom] = useState(settings.activePreset);
  // 표시와 제출이 같은 값을 쓰도록 최신 목록에 맞춘다(이름 바꾸기·삭제로 고른 이름이 사라질 수 있다).
  const from = pickCopySource(names, settings.activePreset, chosenFrom);
  const [renaming, setRenaming] = useState<string | null>(null), [renameTo, setRenameTo] = useState('');
  const [file, setFile] = useState<{name: string; text: string} | null>(null);
  const [importAs, setImportAs] = useState(''), [replace, setReplace] = useState(false);
  const run = async (action: string, fields: Record<string, string>, done: string, needReason = true) => {
    if (busy) return false;
    if (needReason && !reason.trim()) { setError('바꾸는 이유를 먼저 적어 주세요.'); return false; }
    setBusy(true); setError(null);
    try {
      const saved = await save(action, {...fields, revision: String(settings.revision), reason}, context.token);
      context.notice(done.replace('{imported}', saved.result.imported ?? ''));
      return saved;
    } catch (e) { setError(e instanceof Error ? e.message : '저장 실패'); return false; }
    finally { setBusy(false); }
  };
  const exportOne = async (name: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await save('/runners/preset-export', {preset: name}, context.token);
      downloadText(saved.result.filename ?? 'kadan-preset.json', saved.result.text ?? '');
      context.notice('내보냈습니다: ' + name);
    } catch (e) { setError(e instanceof Error ? e.message : '내보내기 실패'); }
    finally { setBusy(false); }
  };
  return <details style={{wordBreak: 'keep-all', overflowWrap: 'break-word'}}>
    <summary>프리셋 관리 ({names.length}개)</summary>
    <p className="muted">프리셋에는 역할별 모델·대체 후보·설명만 담깁니다. 실행기 명령 틀은 파일에 싣지 않습니다.
      활성 프리셋은 지울 수 없고, 가져온 프리셋은 자동으로 켜지지 않습니다.</p>
    <label>바꾸는 이유 (아래 만들기·이름 바꾸기·삭제·가져오기에 공통)
      <input maxLength={500} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} /></label>
    <ul>
      {names.map(name => <li key={name}>
        <strong>{name}</strong>{name === settings.activePreset && ' (활성)'}
        {settings.presets[name].label && settings.presets[name].label !== name && ` — ${settings.presets[name].label}`}{' '}
        <button type="button" disabled={busy} onClick={() => exportOne(name)}>내보내기</button>{' '}
        <button type="button" disabled={busy} onClick={() => { setRenaming(renaming === name ? null : name); setRenameTo(''); }}>
          이름 바꾸기</button>{' '}
        <button type="button" disabled={busy || name === settings.activePreset}
          title={name === settings.activePreset ? '활성 프리셋은 지울 수 없습니다. 먼저 다른 프리셋으로 전환하세요.' : undefined}
          onClick={() => {
            if (window.confirm(`프리셋 '${name}'을 삭제할까요?`))
              void run('/runners/preset-remove', {preset: name}, '삭제했습니다: ' + name);
          }}>삭제</button>
        {renaming === name && <form className="action-form" onSubmit={async e => {
          e.preventDefault();
          if (await run('/runners/preset-rename', {from: name, preset: renameTo}, `이름을 바꿨습니다: ${name} → ${renameTo}`)) setRenaming(null);
        }}>
          <label>새 이름<input required value={renameTo} disabled={busy} onChange={e => setRenameTo(e.target.value)} /></label>
          <button disabled={busy || !renameTo}>이름 바꾸기 저장</button>
        </form>}
      </li>)}
    </ul>
    <form className="action-form" onSubmit={async e => {
      e.preventDefault();
      if (await run('/runners/preset-add', {preset: newName, from}, '만들었습니다: ' + newName)) setNewName('');
    }}>
      <h4>프리셋 만들기 (복사로 시작)</h4>
      <label>복사할 프리셋<select value={from} disabled={busy} onChange={e => setFrom(e.target.value)}>
        {names.map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <label>새 이름<input required value={newName} disabled={busy} onChange={e => setNewName(e.target.value)} /></label>
      <button disabled={busy || !newName}>만들기</button>
    </form>
    <form className="action-form" onSubmit={async e => {
      e.preventDefault();
      if (!file) return;
      const saved = await run('/runners/preset-import',
        {file: file.text, as: importAs, ...(replace ? {replace: '1'} : {})}, '가져왔습니다: {imported} (활성 프리셋은 그대로입니다)');
      if (saved) { setFile(null); setImportAs(''); setReplace(false); }
    }}>
      <h4>파일에서 가져오기</h4>
      <label>내보내기 파일(.json, 64KB 이하)<input type="file" accept="application/json,.json" disabled={busy}
        onChange={async e => {
          const picked = e.target.files?.[0];
          setError(null); setFile(null);
          if (!picked) return;
          if (picked.size > 64 * 1024) { setError(`파일이 너무 큽니다(${picked.size}바이트, 상한 65536).`); return; }
          setFile({name: picked.name, text: await picked.text()});
        }} /></label>
      <label>다른 이름으로 가져오기 (비우면 파일 안의 이름)
        <input value={importAs} disabled={busy} onChange={e => setImportAs(e.target.value)} /></label>
      <label><input type="checkbox" checked={replace} disabled={busy} onChange={e => setReplace(e.target.checked)} />
        같은 이름이 있으면 바꾸기 (기존 프리셋을 통째로 교체합니다)</label>
      <button disabled={busy || !file}>가져오기</button>
    </form>
    <ErrorMessage error={error} />
  </details>;
}
