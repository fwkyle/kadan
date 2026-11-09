// Why: 서버 전체 손실에서만 직전 감독을 복원한다. 개별 역할 사망은 기존대로 사람이 판단한다.
// 10배 데이터: 정상 주기는 list-sessions 한 번과 고정 크기 상태. 손실 때만 원장·대화 파일을 훑는다.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readReviveState} from './revive.mjs';
import {restoreCommand} from './server-restore-command.mjs';
import {readServerSessions} from './server-sessions.mjs';

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

// 생존 근거는 up --auto의 세션 관찰뿐이다. start는 실행 명령·프로필을 찾는 데만 쓴다.
export function restoreCandidates(entries, parents, snapshot) {
  const latest = new Map();
  for (const entry of entries) {
    if (entry.kind === 'start' && entry.role && entry.session) {
      latest.set(entry.session, entry);
    }
  }
  const children = new Set(Object.values(parents));
  const found = [];
  for (const session of new Set(snapshot.sessions)) {
    if (['kadan-비서', 'kadan-대시보드', 'kadan-디코', 'kadan-watch'].includes(session)) continue;
    const start = latest.get(session), role = start?.role ?? session.slice('kadan-'.length);
    if (entries.some(e => e.kind === 'stop' && (e.session === session || e.role === role)
      && (!Number.isFinite(Date.parse(e.t)) || Date.parse(e.t) > Date.parse(snapshot.observedAt)))) continue;
    if (!start) {
      found.push({role, session, result: 'skipped', reason: '시작 기록 없음'});
      continue;
    }
    if (start.floor && start.floor !== 'tmux') continue;
    const profile = start.roleProfile ?? (children.has(start.role)
      ? (parents[start.role] === '@user' ? 'super' : 'conductor') : null);
    if (!['super', 'conductor'].includes(profile)) continue;
    // 옛 이름 정규화 충돌이나 다른 주소를 같은 역할로 되살리지 않는다.
    if (!/^[\p{L}\p{N}\p{Extended_Pictographic}_-]+$/u.test(start.role)
      || start.session !== `kadan-${start.role}`) continue;
    found.push({start, profile, role, session, observedAt: snapshot.observedAt});
  }
  return found;
}

function readState(home) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(home), 'utf8'));
    if (!Number.isFinite(state.attemptedAt)) throw new Error('bad state');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Object.assign(new Error('서버 복원 상한 상태 손상'), {restoreReason: '서버 복원 상한 상태 손상'});
  }
}

function writeState(home, state) {
  const file = statePath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

// 최초 관찰이 missing인 주기에서만, 기반 프로세스를 실행한 뒤 호출한다.
export function prepareServerRestore({home, read, hierarchy, bootTime, projectsDir,
  now = Date.now(), id = randomUUID()}) {
  if (fs.existsSync(path.join(home, 'server-restore.off'))) return null;
  const saved = readState(home);
  const observed = readServerSessions(home, now);
  if (saved?.snapshotKey === observed.key) return null;
  const plan = {id, now, items: [], attempted: false, blocked: observed.reason};
  if (!observed.snapshot || observed.reason === '세션 관찰 시각이 미래') {
    writeState(home, {attemptedAt: saved?.attemptedAt ?? 0, id, snapshotKey: observed.key});
    return plan;
  }
  let entries;
  try {
    entries = read();
    if (!Array.isArray(entries) || entries.some(entry => entry.broken)) throw new Error('invalid');
  } catch {
    throw Object.assign(new Error('복원 원장 조회 실패'), {restoreReason: '복원 원장 조회 실패'});
  }
  const candidates = restoreCandidates(entries, hierarchy(entries) ?? {}, observed.snapshot);
  if (!candidates.length && !observed.reason) return null;
  const reviveState = readReviveState(home);
  const last = Math.max(saved?.attemptedAt ?? 0, ...entries
    .filter(e => e.kind === 'revive' && e.reason === 'server-loss' && e.attempted === true)
    .map(e => Date.parse(e.t)).filter(Number.isFinite));
  const boot = bootTime();
  const blocked = reviveState.corrupt ? '되살리기 상태 손상'
    : !Number.isFinite(boot) || boot < 0 ? '시스템 부팅 시각 불명'
    : boot > Date.parse(observed.snapshot.observedAt) ? '세션 관찰 이후 재부팅됨'
    : observed.reason ? observed.reason
    : last > 0 && now - last < RESTORE_WINDOW_MS ? '60분 복원 상한' : null;
  const items = candidates.map(base => {
    if (base.result) return base;
    const {start} = base;
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
  writeState(home, {attemptedAt: attempted ? now : (saved?.attemptedAt ?? 0), id,
    snapshotKey: observed.key});
  return {id, now, items, attempted, blocked};
}

export function finishServerRestore(plan, {startRole, send, notify, record}) {
  if (!plan) return null;
  const count = plan.items.filter(item => !item.result).length;
  if (count) notify(`서버 통째 종료 감지 — 감독 ${count}명 복원 시작`, {ring: true});
  const results = [];
  for (const item of plan.items) {
    const result = {role: item.role, session: item.session,
      ...(item.transcript ? {transcript: {path: item.transcript.path, mtime: item.transcript.mtime}} : {})};
    if (item.result) {
      Object.assign(result, {result: 'skipped', reason: item.reason});
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
  ...(results.length ? [] : [`${plan.blocked ?? '확인된 복원 후보 없음'} — 수동 확인 필요`])].join('\n');
  // 원장 쓰기 실패를 숨긴 채 성공 알림을 보내지 않는다. 손실당 결과 사건 하나만 남긴다.
  const event = {kind: 'revive', reason: 'server-loss', by: 'autostart', restoreId: plan.id,
    t: new Date(plan.now).toISOString(), attempted: plan.attempted,
    candidateBasis: 'server-sessions-snapshot', blocked: plan.blocked, results};
  record(event);
  notify(message, {ring: true});
  return event;
}

function shellQuote(value) { return `'${value.replace(/'/g, `'"'"'`)}'`; }
