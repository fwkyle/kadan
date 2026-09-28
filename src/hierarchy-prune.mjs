// Why: 끝난 역할만 관계표에서 빼고, 살아 있는 역할과 남은 책임의 보고 경로를 보존한다.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseHierarchy } from './hierarchy.mjs';
import { activeHierarchyPath, registerRoleManually } from './hierarchy-register.mjs';
import { withHierarchyLock } from './hierarchy-lock.mjs';
import { Handover } from './handover.mjs';
import { CardStore } from './card-store.mjs';
import { buildCardCenter } from './card-center.mjs';
import { WorkStore } from './work-store.mjs';
import { readLedger } from './ledger.mjs';
import { storageSnapshot, storageTransaction, storageVersion } from './storage.mjs';
import { taskIdentity, taskConnectionError, taskEventKey } from './task-identity.mjs';
import { effectiveWorkOwner, workEntries } from './handover-state.mjs';
import { finished } from './human-brief.mjs';

// 죽음 알림 처리 시간으로 입증된 값은 없다. 보수적인 기본 유예 시간이다.
export const PRUNE_GRACE_MS = 24 * 60 * 60_000;
const hash = text => createHash('sha256').update(text).digest('hex');
const pidOf = entry => entry?.panePid ?? entry?.rottiePid;

function checkedSessions(sessions) {
  if (!Array.isArray(sessions) || sessions.some(s => !s || typeof s.session !== 'string' ||
      (s.alive !== false && (s.pid == null || !String(s.pid).trim())) ||
      (s.alive === false && !['exited', 'closed'].includes(s.state)))) {
    throw new Error('생존 상태 모름: 정리하지 않음');
  }
  if (new Set(sessions.map(s => s.session)).size !== sessions.length) throw new Error('세션 중복: 생존 상태 모름');
  return new Map(sessions.map(s => [s.session, s]));
}

// 파일·프로세스 조회 없이 주어진 한 시점의 자료로만 판정한다.
export function planHierarchyPrune({ table, entries, cards, works, sessions, now = Date.now() }) {
  const parents = parseHierarchy(table), live = checkedSessions(sessions);
  if (!Array.isArray(entries) || entries.some(e => !e || e.broken) ||
      !Array.isArray(cards) || !Array.isArray(works) || !Number.isFinite(now)) {
    throw new Error('카드·업무·원장 정보 모름: 정리하지 않음');
  }
  const identity = taskIdentity(cards), required = new Map(), pending = new Map();
  const keep = (role, reason) => { if (role && !required.has(role)) required.set(role, reason); };
  const displayed = buildCardCenter({cards:cards.map(c => ({...c, history:c.history ?? []})), entries,
    tree:[], runtimeKnown:false, now}).cards;
  for (const card of displayed) {
    if (!finished({displayState:card.status}) || !finished(card)) {
      keep(card.role, '미완료 카드');
      keep(card.resolutionOwner, '미완료 카드');
    }
  }
  for (const work of works) if (!['done', 'cancelled'].includes(work.status)) {
    keep(effectiveWorkOwner(work, entries), '미완료 업무');
    keep(work.turnOwner, '미완료 업무');
  }
  for (const entry of workEntries(entries, identity)) {
    if (!['send', 'done'].includes(entry.kind) || !entry.role || !entry.taskId || entry.transport === 'mailbox') continue;
    if (taskConnectionError(entry)) { keep(entry.role, '카드 연결 모름'); continue; }
    const key = `${entry.role}\0${taskEventKey(entry)}`;
    if (entry.kind === 'send') pending.set(key, entry.role);
    else pending.delete(key);
  }
  for (const role of pending.values()) keep(role, '미완료 발령');

  const starts = new Map(), deaths = new Map();
  for (const entry of entries) {
    if (!entry.role) continue;
    if (entry.kind === 'start') {
      starts.set(entry.role, entry); deaths.delete(entry.role);
    } else if (entry.kind === 'stop' || (entry.kind === 'alert' && entry.alertKind === '죽음')) {
      // 재시작 전의 종료와 해소된 경보는 지금 세대의 사망 근거가 아니다.
      if (entry.resolved) deaths.delete(entry.role);
      else deaths.set(entry.role, entry);
    } else if (['send', 'done'].includes(entry.kind)) {
      // 이전 죽음 관측 뒤 다시 활동한 흔적이 있으면 새 종료 관측을 기다린다.
      deaths.delete(entry.role);
    }
  }
  const hasChildren = new Set(parents.values()), remove = [], retain = [];
  for (const [role, parent] of parents) {
    const session = live.get(`kadan-${role}`), start = starts.get(role), death = deaths.get(role);
    const startedAt = Date.parse(start?.t), diedAt = Date.parse(death?.t);
    let reason;
    if (session && session.alive !== false) {
      reason = pidOf(start) != null && String(pidOf(start)) === String(session.pid) ? '살아 있음' : 'PID 또는 시작 기록 모름';
    } else if (!start || pidOf(start) == null || !Number.isFinite(startedAt) || startedAt > now) reason = '시작 기록 모름';
    else if (required.has(role)) reason = required.get(role);
    else if (!Number.isFinite(diedAt) || diedAt < startedAt || diedAt > now) reason = '종료 시각 모름';
    else if (now - diedAt < PRUNE_GRACE_MS) reason = '종료 후 24시간 미경과';
    // 이번 표에서 자식이 있는 역할은 남긴다. 다음 실행 때 잎부터 다시 판정한다.
    else if (hasChildren.has(role)) reason = '하위 역할 있음';
    const row = {role, parent, ...(death ? {observedDeadAt:death.t} : {})};
    if (reason) retain.push({...row, reason}); else remove.push(row);
  }
  const removed = new Set(remove.map(r => r.role));
  const next = Object.fromEntries([...parents].filter(([role]) => !removed.has(role)));
  parseHierarchy(next);
  const reasons = {};
  for (const row of retain) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
  return {total:parents.size, removeCount:remove.length, retainCount:retain.length, reasons, remove, retain, next};
}

export function readPruneSnapshot(home) {
  return storageSnapshot(home, () => ({entries:readLedger(home), cards:new CardStore(home).listSummaries(),
    works:new WorkStore(home).list(), version:storageVersion(home)}));
}

function assertNoOpenHandover(home, file) {
  const dir = path.join(home, 'handovers');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (['complete', 'aborted'].includes(state.phase)) continue;
    if (typeof state.hierarchy !== 'string') throw new Error('인계 관계표 모름: 정리하지 않음');
    if (fs.realpathSync(state.hierarchy) === file) throw new Error(`열린 인계가 있어 정리 불가: ${state.id}`);
  }
}

export function pruneHierarchy({home, floor, file, apply = false, now = Date.now,
  readSnapshot = () => readPruneSnapshot(home)}) {
  const initial = readSnapshot();
  const target = file ?? activeHierarchyPath(initial.entries);
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('관계표 절대경로를 확인할 수 없음');
  const resolved = fs.realpathSync(target);
  const inspect = snapshot => {
    const original = fs.readFileSync(resolved, 'utf8');
    const plan = planHierarchyPrune({...snapshot, table:JSON.parse(original), sessions:floor.list({strict:true}), now:now()});
    return {snapshot, original, plan};
  };
  const result = ({plan, original}, applied, backup = null) => {
    const {next, ...report} = plan;
    return {file:resolved, applied, backup, sourceHash:hash(original), graceHours:24, ...report};
  };
  if (!apply) return result(inspect(initial), false);
  // 인계는 이미 이 잠금으로 begin/finish/abort 전체를 보호한다. 그 안에서 등록 잠금을 잡는다.
  // 따라서 열린 인계를 확인한 직후 새 인계가 끼어들거나, 동시에 등록한 줄이 사라지지 않는다.
  return new Handover({home}).locked(() => withHierarchyLock(resolved, () => {
    assertNoOpenHandover(home, resolved);
    const current = inspect(readSnapshot());
    if (!file && fs.realpathSync(activeHierarchyPath(current.snapshot.entries)) !== resolved) throw new Error('활성 관계표 변경: 새로 미리 보세요');
    if (!current.plan.removeCount) return result(current, false);
    const trash = path.join(home, '.trash');
    fs.mkdirSync(trash, {recursive:true, mode:0o700});
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const backup = path.join(trash, `${path.basename(resolved)}.before-prune-${stamp}-${randomUUID()}`);
    fs.writeFileSync(backup, current.original, {flag:'wx', mode:0o600});
    // SQLite는 마지막 확인과 파일 교체 동안 새 발령·카드 변경이 끼어들지 못하게 한다.
    // JSONL에서는 저장소를 다시 읽어 달라졌으면 중단한다.
    return storageTransaction(home, () => {
      if (current.snapshot.version != null) {
        if (storageVersion(home) !== current.snapshot.version) throw new Error('판정 중 원장·카드 변경: 적용하지 않음');
      } else if (JSON.stringify(readSnapshot()) !== JSON.stringify(current.snapshot)) {
        throw new Error('판정 중 원장·카드 변경: 적용하지 않음');
      }
      const live = checkedSessions(floor.list({strict:true}));
      if (current.plan.remove.some(r => live.get(`kadan-${r.role}`)?.alive !== false && live.has(`kadan-${r.role}`))) {
        throw new Error('정리 대상 역할이 다시 살아남: 적용하지 않음');
      }
      if (fs.readFileSync(resolved, 'utf8') !== current.original) throw new Error('관계표 변경: 적용하지 않음');
      parseHierarchy(current.plan.next);
      const temporary = `${resolved}.prune-${randomUUID()}`;
      fs.writeFileSync(temporary, `${JSON.stringify(current.plan.next, null, 2)}\n`, {flag:'wx', mode:0o600});
      fs.renameSync(temporary, resolved);
      return result(current, true, backup);
    });
  }));
}

export function hierarchyCommand(args, flags, {home, floor}) {
  if (flags.help) return {usage:'kadan hierarchy prune [--file /절대경로/관계표.json] [--apply] | kadan hierarchy add <역할> <상위|@user> — prune 기본은 미리 보기'};
  // 사람이 직접 띄워 자동 등록이 빠진 역할을 표에 더한다. 기존 줄은 덮어쓰지 않는다.
  if (args[0] === 'add') {
    if (args.length !== 3 || Object.keys(flags).length) {
      throw new Error('사용법: kadan hierarchy add <역할> <상위|@user>');
    }
    return registerRoleManually({ role: args[1], parent: args[2], home });
  }
  if (args.length !== 1 || args[0] !== 'prune' || Object.keys(flags).some(k => !['file', 'apply'].includes(k)) ||
      (flags.apply !== undefined && flags.apply !== true) || (flags.file !== undefined && typeof flags.file !== 'string')) {
    throw new Error('사용법: kadan hierarchy prune [--file /절대경로/관계표.json] [--apply] | kadan hierarchy add <역할> <상위|@user>');
  }
  return pruneHierarchy({home, floor, file:flags.file, apply:flags.apply === true});
}
