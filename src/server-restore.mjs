// Why: 서버 전체 손실에서만 직전 감독을 복원한다. 개별 역할 사망은 기존대로 사람이 판단한다.
// 10배 데이터: 정상 주기는 list-sessions 한 번과 고정 크기 상태. 손실 때만 원장·대화 파일을 훑는다.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readReviveState} from './revive.mjs';
import {restoreCommand} from './server-restore-command.mjs';

export const RESTORE_WINDOW_MS = 60 * 60 * 1000;
export const RESTORE_NOTICE = '서버 통째 종료 뒤 자동 복원됨. ' +
  '직전 명령(머지·push·파일 쓰기)이 끝났는지 실제 상태로 확인하라.';
const statePath = home => path.join(home, 'server-restore-state.json');

export function serverState(result) {
  if (result?.error || result?.signal || result?.status == null) return 'unknown';
  if (result.status === 0) return 'present';
  const error = String(result.stderr ?? '').trim();
  return /^no server running on [^\n]+$/.test(error)
    || /^error connecting to [^\n]+ \(No such file or directory\)$/.test(error) ? 'missing' : 'unknown';
}

// watch-cycle는 세션 개수만 저장한다. 마지막 start 이후 stop·죽음이 없는 쪽을 보수적으로 고른다.
export function restoreCandidates(entries, parents = {}) {
  const latest = new Map(), byRole = new Map();
  for (const entry of entries) {
    if (entry.kind === 'start' && entry.role && entry.session) {
      const item = {start: entry, ended: false};
      latest.set(entry.session, item);
      byRole.set(entry.role, item);
    } else if (entry.kind === 'stop' || (entry.kind === 'alert' && entry.alertKind === '죽음')) {
      const item = latest.get(entry.session) ?? byRole.get(entry.role);
      if (item) item.ended = true;
    }
  }
  const children = new Set(Object.values(parents));
  const found = [];
  for (const {start, ended} of latest.values()) {
    if (ended || start.role === '비서' || start.session === 'kadan-비서') continue;
    if (start.floor && start.floor !== 'tmux') continue;
    const profile = start.roleProfile ?? (children.has(start.role)
      ? (parents[start.role] === '@user' ? 'super' : 'conductor') : null);
    if (!['super', 'conductor'].includes(profile)) continue;
    // 옛 이름 정규화 충돌이나 다른 주소를 같은 역할로 되살리지 않는다.
    if (!/^[\p{L}\p{N}\p{Extended_Pictographic}_-]+$/u.test(start.role)
      || start.session !== `kadan-${start.role}`) continue;
    found.push({start, profile});
  }
  return found;
}

function readState(home) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(home), 'utf8'));
    if (!Number.isFinite(state.attemptedAt) || typeof state.missing !== 'boolean') throw new Error('bad state');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('서버 복원 상한 상태 손상');
  }
}

function writeState(home, state) {
  const file = statePath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

// 같은 서버 부재가 이어지면 통지도 한 번만 한다. 서버 재생성을 관찰한 뒤 다음 손실을 받는다.
export function settleServerRestore(home, listSessions) {
  if (serverState(listSessions()) !== 'present') return;
  const state = readState(home);
  if (state?.missing) writeState(home, {...state, missing: false});
}

// revive 잠금 안, 기반 프로세스를 띄우기 전에 호출한다. 평소에는 원장을 읽지 않는다.
export function prepareServerRestore({home, listSessions, read, hierarchy, uptime, projectsDir,
  now = Date.now(), id = randomUUID()}) {
  if (fs.existsSync(path.join(home, 'server-restore.off'))) return null;
  let state;
  try { state = serverState(listSessions()); } catch { state = 'unknown'; }
  if (state === 'unknown') throw new Error('tmux 서버 존재 조회 실패 — 자동 실행 중단');
  const saved = readState(home);
  if (state !== 'missing') {
    if (saved?.missing) writeState(home, {...saved, missing: false});
    return null;
  }
  if (saved?.missing) return null;
  const entries = read();
  if (!Array.isArray(entries) || entries.some(entry => entry.broken)) throw new Error('복원 원장 조회 실패');
  const candidates = restoreCandidates(entries, hierarchy(entries) ?? {});
  if (!candidates.length) return null; // 첫 설치·직전 감독 없음은 서버 손실 복원이 아니다.
  const reviveState = readReviveState(home);
  const last = Math.max(saved?.attemptedAt ?? 0, ...entries
    .filter(e => e.kind === 'revive' && e.reason === 'server-loss' && e.attempted === true)
    .map(e => Date.parse(e.t)).filter(Number.isFinite));
  const seconds = uptime();
  const blocked = reviveState.corrupt ? '되살리기 상태 손상'
    : !Number.isFinite(seconds) || seconds < 0 ? '시스템 가동 시간 불명'
    : seconds < 600 ? '재부팅 뒤 10분 미만'
    : last > 0 && now - last < RESTORE_WINDOW_MS ? '60분 복원 상한' : null;
  const items = candidates.map(({start, profile}) => {
    const base = {role: start.role, session: start.session, start, profile};
    const stopped = reviveState.targets[start.role]?.state === 'stopped';
    const reason = stopped ? '수동 정지' : blocked;
    // 건너뛰는 경우에도 확인 가능한 명령은 수동 안내에 쓴다. 실행 허용과는 별개다.
    try {
      return {...base, ...restoreCommand({start, projectsDir, now}),
        ...(reason ? {result: 'skipped', reason} : {})};
    }
    catch (error) {
      // 파일 오류의 원문에는 파일 내용·명령이 섞일 수 있어 시스템 오류는 코드만 남긴다.
      return {...base, result: 'skipped', reason: [reason, error.code ?? error.message].filter(Boolean).join(' · ')};
    }
  });
  const attempted = items.some(item => !item.result);
  // 먼저 예약한다. 시작 중 프로세스가 죽어도 다음 손실에서 상한을 잃지 않는다.
  writeState(home, {attemptedAt: attempted ? now : (saved?.attemptedAt ?? 0), id, missing: true});
  return {id, now, items, attempted, blocked};
}

export function finishServerRestore(plan, {startRole, send, notify, record, baseError = false}) {
  if (!plan) return null;
  const results = [];
  for (const item of plan.items) {
    const result = {role: item.role, session: item.session,
      ...(item.transcript ? {transcript: {path: item.transcript.path, mtime: item.transcript.mtime}} : {})};
    if (item.result || baseError) {
      Object.assign(result, {result: 'skipped', reason: item.reason ?? '기반 프로세스 시작 실패'});
    } else {
      try {
        const started = startRole(item, plan.id);
        Object.assign(result, {result: 'started', hidden: Boolean(started?.hidden)});
        try { send(item.role, RESTORE_NOTICE); result.mail = 'accepted'; }
        catch { result.mail = 'failed'; }
      } catch { Object.assign(result, {result: 'failed', reason: '역할 시작 실패 — 자동 재시도 없음'}); }
    }
    if (result.result !== 'started') {
      result.manual = item.command
        ? `cd ${shellQuote(item.start.cwd)} && kadan start '${item.role}'` +
          ` --cmd ${shellQuote(item.command)} --profile ${item.profile} --reason server-restore --no-prompt`
        : `kadan read '${item.role}' — 대화 ID·작업 폴더 확인 뒤 start --cmd '<실행기 resume 명령>' --no-prompt`;
    }
    results.push(result);
  }
  const message = ['tmux 서버 전체 손실 복원 결과', ...results.map(item =>
    `${item.role}: ${item.result}${item.reason ? ` (${item.reason})` : ''}` +
    `${item.hidden ? ` · kadan attach '${item.role}'로 열기` : ''}` +
    `${item.mail === 'failed' ? ' · 복원 안내 전달 실패, 직전 명령 완료 여부 직접 확인' : ''}` +
    `${item.manual ? `\n수동: ${item.manual}` : ''}`),
  ...(results.length ? [] : ['확인된 복원 후보 없음'])].join('\n');
  // 원장 쓰기 실패를 숨긴 채 성공 알림을 보내지 않는다. 손실당 결과 사건 하나만 남긴다.
  const event = {kind: 'revive', reason: 'server-loss', by: 'autostart', restoreId: plan.id,
    t: new Date(plan.now).toISOString(), attempted: plan.attempted,
    candidateBasis: 'last-start-without-stop-or-death', results};
  record(event);
  notify(message, {ring: true});
  return event;
}

function shellQuote(value) { return `'${value.replace(/'/g, `'"'"'`)}'`; }
