// Why: 일이 끝난 역할 세션이 꺼지지 않고 쌓인다. 화면이 기준 시간(기본 12시간) 넘게 그대로이고 맡은 일이 없는 역할을
// "정리 후보"로 골라 그 역할의 직속 상위 감독에게 묶음 우편 한 통으로 알린다. **아무것도 끄지 않는다** — 끌지는 받은 감독이 정한다
// (2026-11-13 kyle 결정). kyle에게는 알리지 않고 대시보드에 후보 수만 보인다.
//
// 판정의 원칙: 모르면 후보가 아니다. 읽기 실패·모양이 다른 기록·확인 못 한 조건은 모두 "후보 아님 + 이유"다.
//  - 후보: 작업자·검수자·일반감독 프로필의 살아 있는 세션 가운데, 화면 지문이 기준 시간 넘게 같고(idle-screen-clock.mjs)
//    끝나지 않은 카드가 없고(일반감독은 책임진 끝나지 않은 업무도 없고), 아래 "빼는 조건"에 하나도 걸리지 않는 역할.
//  - 빼는 조건: 슈퍼감독·비서·기반 프로세스·프로필 기록 없음, 열린 사용자 결정, 답 대기(보냈거나 받을 차례), 안 읽은 보관 우편,
//    진행 중 인계, 업무의 차례, 살아 있는 하위가 있는 감독, 응답 생성 중·최근 사람 입력, 살아 있는 상위 없음(kyle을 울리지 않는다).
//  - 다시 열 수 없는 세션은 빼지 않고 줄에 "reopen 불가(이유)"로 적는다.
//  - 끄기 파일(idle-roles.off)은 우편만 막는다. 화면 표본은 계속 쌓여, 켜기 전에 --dry-run으로 목록을 먼저 볼 수 있다.
//  - 같은 역할은 기준 시간에 한 번만 알린다. 근거는 보낸 우편이다: 원장의 send(보낸 쪽 idle-roles) 본문에서 역할을 다시 읽는다.
//    전달 여부가 불명확했던 시도만 상태 파일에 적어 한 시간마다 되풀이하지 않는다.
//
// 비용(한 번 실행): 살아 있는 세션마다 화면 읽기 1번 + 상태 파일 1번. 기준 시간을 넘긴 세션이 하나도 없으면 여기서 끝난다(원장을 읽지 않는다).
// 넘긴 세션이 있으면 원장 읽기 1번 + 카드 요약 1번 + 업무 목록 1번 + 결정 목록 1번 + 관계표 1번, 보낼 우편마다 우편 명령 1번(그 안에서 원장 1번).
// 원장이 10배면 그 읽기들이 약 10배다(지금 약 1초 → 약 10초). 그래서 감시 주기 안에서 돌지 않고 한 시간에 한 번만 돈다.
import fs from 'node:fs';
import path from 'node:path';
import {CardStore} from './card-store.mjs';
import {WorkStore} from './work-store.mjs';
import {DecisionStore} from './decisions.mjs';
import {readLedger, readMailBody} from './ledger.mjs';
import {taskIdentity} from './task-identity.mjs';
import {sessionOwner, assertSessionOwner} from './session-ownership.mjs';
import {pendingCardsFor} from './cli-start-support.mjs';
import {withEffectiveOwner} from './handover-state.mjs';
import {TARGETS} from './revive.mjs';
import {mailboxLetters} from './mailbox-state.mjs';
import {readActiveHierarchy} from './hierarchy-register.mjs';
import {hierarchyRoute, isDescendant, USER_RECIPIENT} from './hierarchy.mjs';
import {confirmIdleBeforeStop, paneInfo} from './commands/restart.mjs';
import {stopConversationFields, lookupDeps, launchStart} from './role-conversation.mjs';
import {launchIdentityOf} from './ai-identity.mjs';
import {runnerTemplate} from './runner-table.mjs';
import {readSettings} from './runner-settings.mjs';
import {sendAutopilotMail} from './autopilot.mjs';
import {readIdleHours} from './idle-roles-setting.mjs';
import {observeScreens, readIdleState, writeIdleState} from './idle-screen-clock.mjs';

export const IDLE_ROLES_OFF = 'idle-roles.off';
export const IDLE_ROLES_SENDER = 'idle-roles';
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const MAX_MAILS_PER_RUN = 5;
export const MAX_ROLES_PER_MAIL = 20;
const HOUR_MS = 60 * 60 * 1000;
const CANDIDATE_PROFILES = new Set(['worker', 'reviewer', 'conductor']);
const SESSION_PREFIX = 'kadan-';
const STOP_LINE = /끄기: kadan stop (\S+)\s*$/gmu;
const OPEN_WORK = work => !['done', 'cancelled'].includes(work.status);

export const idleRolesOff = home => fs.existsSync(path.join(home, IDLE_ROLES_OFF));

// 한 시간 문: 마지막 실행에서 한 시간이 지났을 때만 참이다. 상태 파일 하나만 읽는다. 끄기 파일이 있어도 돈다(화면 표본은 쌓는다).
export function idleRolesDue(home, now = Date.now()) {
  const last = readIdleState(home).lastRunAt;
  return !Number.isFinite(last) || last > now || now - last >= SWEEP_INTERVAL_MS;
}

// 실행 전에 "이번 시간은 돌았다"를 먼저 적는다. 도중에 실패해도 다음 분에 다시 돌지 않는다(원장 읽기를 매 분 되풀이하지 않게).
export function claimIdleRolesRun(home, now = Date.now()) {
  writeIdleState(home, {...readIdleState(home), lastRunAt: now});
}

function handoverInProgress(home, role) {
  let names = [];
  try { names = fs.readdirSync(path.join(home, 'handovers')).filter(name => name.endsWith('.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('인계 상태를 읽지 못함'); }
  for (const name of names) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(home, 'handovers', name), 'utf8')); } catch { throw new Error('인계 상태를 읽지 못함'); }
    if (typeof data?.phase !== 'string') continue; // 인수 근거 파일 등 상태 파일이 아닌 것
    if (!['complete', 'aborted'].includes(data.phase) && (data.from === role || data.to === role)) return true;
  }
  return false;
}

// 원장을 읽는 무거운 재료를 한 번만 모은다. 하나라도 못 읽으면 던진다(호출자가 전원 "확인 불가"로 처리).
function gather({home, deps, live}) {
  const entries = deps.readEntries();
  if (entries.some(entry => entry?.broken)) throw new Error('원장 손상');
  const cards = deps.cardSummaries();
  const identity = taskIdentity(cards);
  const hierarchy = deps.hierarchy(entries);
  return {
    home, entries, projected: identity.project(entries),
    works: deps.works().filter(OPEN_WORK).map(work => withEffectiveOwner(work, entries)),
    decisions: deps.decisions().filter(d => d?.status === 'open'),
    parents: hierarchy ? new Map(Object.entries(hierarchy)) : null,
    liveSessions: live.map(item => item.session),
    // 답을 기다리는 질문(감시기와 같은 범위: 기록용 알림·자동 생성 우편은 뺀다).
    waiting: mailboxLetters(entries, undefined, {view: 'waiting'}).filter(letter => !letter.notificationOnly && !letter.systemGenerated),
  };
}

// 한 역할을 후보로 볼 수 있는가. {skip: 이유} 또는 {profile, recipient}. 던지는 것은 모두 "확인 불가"다.
function evaluate(ctx, {role, session}, deps) {
  const owner = sessionOwner(ctx.entries, session, role);
  if (!owner.start) return {skip: '시작 기록 없음'};
  const profile = owner.start.roleProfile;
  if (!CANDIDATE_PROFILES.has(profile)) return {skip: profile ? `프로필 ${profile}은(는) 대상이 아님` : '역할 프로필 기록 없음'};
  assertSessionOwner(owner, deps.floor.pid(session));
  const pending = pendingCardsFor(ctx.projected, role);
  if (pending.length) return {skip: `끝나지 않은 카드 ${pending.length}건(${pending.slice(0, 3).join(', ')})`};
  const owned = ctx.works.filter(work => work.owner === role);
  if (owned.length) return {skip: `책임진 끝나지 않은 업무 ${owned.length}건(${owned.slice(0, 3).map(w => `${w.key}${w.status === 'hold' ? ' 보류' : ''}`).join(', ')})`};
  const turn = ctx.works.find(work => work.turnOwner === role);
  if (turn) return {skip: `업무 ${turn.key}의 차례`};
  const decision = ctx.decisions.find(d => d.requestedBy === role);
  if (decision) return {skip: `열린 사용자 결정 ${decision.id}`};
  const asked = ctx.waiting.find(letter => letter.currentSender === role);
  if (asked) return {skip: `보낸 질문의 답 대기(${asked.currentRecipient})`};
  const owes = ctx.waiting.find(letter => letter.currentRecipient === role);
  if (owes) return {skip: `답할 질문이 있음(${owes.currentSender})`};
  const stored = mailboxLetters(ctx.entries, role, {unread: true, previousGenerations: 'exclude'}).filter(letter => letter.transport === 'mailbox');
  if (stored.length) return {skip: `안 읽은 보관 우편 ${stored.length}통`};
  if (handoverInProgress(ctx.home, role)) return {skip: '인계 진행 중'};
  if (!ctx.parents) return {skip: '관계표를 읽지 못함'};
  if (!ctx.parents.has(role)) return {skip: '관계표에 없는 역할(알릴 상위를 모름)'};
  if (profile === 'conductor') {
    const child = ctx.liveSessions.map(name => name.slice(SESSION_PREFIX.length))
      .find(other => other !== role && isDescendant(other, role, ctx.parents));
    if (child) return {skip: `살아 있는 하위 역할이 있음(${child})`};
  }
  const route = hierarchyRoute(role, ctx.parents, ctx.liveSessions);
  if (!route || route.recipient === USER_RECIPIENT) return {skip: '살아 있는 상위 감독이 없음(사용자에게는 알리지 않음)'};
  try { deps.confirmIdle(session); } catch (error) { return {skip: error.message}; }
  return {profile, recipient: route.recipient};
}

// 지금 끄면 다시 열 수 있겠는가(예상). 끌 때와 같은 조회로 대화 번호를 찾고, reopen이 거절하는 흔한 이유를 미리 본다.
// 던지지 않는다. {ok: true, conversation} 또는 {ok: false, why}.
export function reopenOutlook({session, entries, floorName, settings, lookup, exists = file => fs.statSync(file).isDirectory()}) {
  try {
    if (floorName !== 'tmux') return {ok: false, why: 'tmux 바닥이 아님'};
    const found = lookup({session, entries, floorName, readSettings: () => settings});
    if (!found.conversation) return {ok: false, why: `대화 번호를 찾지 못함: ${found.conversationMissing ?? '모름'}`};
    const start = launchStart(entries.filter(entry => entry.session === session));
    const identity = start ? launchIdentityOf(start.cmd) : {ok: false};
    if (!identity.ok) return {ok: false, why: '시작 명령에서 실행기·모델을 읽지 못함'};
    try { runnerTemplate(settings, identity.harness, 'resume'); } catch { return {ok: false, why: `설정에 ${identity.harness}의 이어 열기 명령이 없음`}; }
    let folder = false;
    try { folder = Boolean(exists(start.cwd)); } catch { /* 없으면 아래에서 불가 */ }
    if (!folder) return {ok: false, why: `작업 폴더가 없음: ${start.cwd}`};
    return {ok: true, conversation: found.conversation};
  } catch (error) { return {ok: false, why: `확인 실패: ${error.message}`}; }
}

const two = n => String(n).padStart(2, '0');
export function localStamp(ms) {
  const d = new Date(ms);
  return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function candidateLine(candidate, now) {
  const hours = Math.floor((now - candidate.since) / HOUR_MS);
  const reopen = candidate.reopen.ok ? `reopen 가능(대화 ${String(candidate.reopen.conversation).slice(0, 8)})` : `reopen 불가(${candidate.reopen.why})`;
  return `- ${candidate.role} · ${candidate.profile} · 마지막 화면 변화 ${localStamp(candidate.since)} 무렵(약 ${hours}시간 전) · ${reopen} · 끄기: kadan stop ${candidate.role}`;
}

export function bundleMessage({candidates, hours, now}) {
  return [
    `[정리 후보] 화면이 ${hours}시간 넘게 그대로이고 맡은 일이 없는 하위 역할 ${candidates.length}개입니다. 카단은 아무것도 끄지 않습니다.`,
    '더 쓰지 않을 역할은 아래 명령으로 끄고, 계속 쓸 역할은 그대로 두세요. 끈 역할은 kadan reopen <역할>로 같은 대화를 다시 엽니다(reopen 불가 표시는 다시 열 수 없음).',
    `같은 역할은 ${hours}시간 뒤에도 그대로면 다시 알립니다. 이 우편에 답장할 필요는 없습니다.`,
    ...candidates.map(candidate => candidateLine(candidate, now)),
  ].join('\n');
}

// 기준 시간 안에 이미 알린 역할: 보낸 우편(원장 send, 보낸 쪽 idle-roles)의 본문 줄에서 다시 읽는다 + 전달이 불명확했던 시도.
function recentlyNotified({entries, attempts, readBody, since}) {
  const roles = new Map();
  for (const entry of entries) {
    if (entry?.kind !== 'send' || entry.by !== IDLE_ROLES_SENDER || !entry.digest) continue;
    const at = Date.parse(entry.t);
    if (!Number.isFinite(at) || at < since) continue;
    let body = '';
    try { body = String(readBody(entry.digest) ?? ''); } catch { continue; }
    for (const match of body.matchAll(STOP_LINE)) roles.set(match[1], Math.max(roles.get(match[1]) ?? 0, at));
  }
  for (const [role, at] of Object.entries(attempts ?? {})) {
    if (Number.isFinite(at) && at >= since) roles.set(role, Math.max(roles.get(role) ?? 0, at));
  }
  return roles;
}

export function defaultDeps(home, floor) {
  return {
    floor,
    readEntries: () => readLedger(home),
    cardSummaries: () => new CardStore(home).listSummaries(),
    works: () => new WorkStore(home).list(),
    decisions: () => new DecisionStore(home).list(),
    hierarchy: entries => readActiveHierarchy(entries),
    settings: () => readSettings(home),
    hours: () => readIdleHours(home).hours,
    confirmIdle: session => confirmIdleBeforeStop(session, floor),
    lookup: input => stopConversationFields({...input, deps: lookupDeps({paneInfo})}),
    readBody: digest => readMailBody(digest, home),
    sendMail: sendAutopilotMail(home, IDLE_ROLES_SENDER),
  };
}

// 한 번 실행. dryRun이면 화면·원장을 읽기만 하고 상태 파일도 우편도 쓰지 않는다.
// 반환: {hours, live, stale, candidates:[{role, profile, since, recipient, reopen, notifiedAt?}], skipped:[{role, reason}],
//        mails:[{to, roles, message, sent, delivery?, error?}], held:[{to, roles}] (상한에 걸려 다음 실행으로 미룬 묶음), off}.
export function runIdleRoles({home, floor, now = Date.now(), dryRun = false, deps = defaultDeps(home, floor)}) {
  const off = idleRolesOff(home);
  const hours = deps.hours();
  const report = {hours, live: 0, stale: 0, candidates: [], skipped: [], mails: [], held: [], off, dryRun};
  // 화면 표본은 tmux 바닥에서만 잰다. 다른 바닥은 후보를 고르지 않는다.
  if (floor.name !== 'tmux') return {...report, unsupported: floor.name};
  const state = readIdleState(home);
  const live = floor.list({strict: true})
    .filter(item => item.session?.startsWith(SESSION_PREFIX))
    .map(item => ({...item, role: item.session.slice(SESSION_PREFIX.length)}))
    .filter(item => !TARGETS.includes(item.role));
  report.live = live.length;
  const {sessions, clocks} = observeScreens({previous: state.sessions, live, read: session => floor.read(session), now});
  const attempts = Object.fromEntries(Object.entries(state.attempts ?? {}).filter(([, at]) => Number.isFinite(at) && now - at < hours * HOUR_MS));
  const save = extra => { if (!dryRun) writeIdleState(home, {lastRunAt: now, sessions, attempts, ...extra}); };

  const stale = live.filter(item => { const clock = clocks.get(item.session); return clock?.since != null && now - clock.since >= hours * HOUR_MS; });
  report.stale = stale.length;
  // 끄기 파일이 있으면 화면 표본만 쌓고 끝낸다(원장을 읽지 않는다). --dry-run은 끄기 파일이 있어도 끝까지 판정한다.
  if (off && !dryRun) { save({candidates: null, candidatesAt: now}); return report; }
  if (!stale.length) { save({candidates: [], candidatesAt: now}); return report; }

  let ctx;
  try { ctx = gather({home, deps, live}); }
  catch (error) {
    report.skipped = stale.map(item => ({role: item.role, reason: `확인 불가: ${error.message}`}));
    save({candidates: [], candidatesAt: now});
    return report;
  }
  for (const item of stale) {
    let verdict;
    try { verdict = evaluate(ctx, item, deps); } catch (error) { verdict = {skip: `확인 불가: ${error.message}`}; }
    if (verdict.skip) { report.skipped.push({role: item.role, reason: verdict.skip}); continue; }
    report.candidates.push({role: item.role, session: item.session, profile: verdict.profile, since: clocks.get(item.session).since, recipient: verdict.recipient});
  }
  const summary = report.candidates.map(({role, profile, since, recipient}) => ({role, profile, since, recipient}));
  if (!report.candidates.length) { save({candidates: [], candidatesAt: now}); return report; }

  const notified = recentlyNotified({entries: ctx.entries, attempts, readBody: deps.readBody, since: now - hours * HOUR_MS});
  const due = new Map();
  for (const candidate of report.candidates) {
    if (notified.has(candidate.role)) { candidate.notifiedAt = notified.get(candidate.role); continue; }
    if (!due.has(candidate.recipient)) due.set(candidate.recipient, []);
    due.get(candidate.recipient).push(candidate);
  }
  let settings = null;
  try { settings = deps.settings(); } catch { /* reopen 예상만 "불가(확인 실패)"가 된다 */ }
  let sent = 0;
  for (const [to, all] of due) {
    const roles = all.slice(0, MAX_ROLES_PER_MAIL);
    if (sent >= MAX_MAILS_PER_RUN) { report.held.push({to, roles: all.map(c => c.role)}); continue; }
    for (const candidate of roles) {
      candidate.reopen = reopenOutlook({session: candidate.session, entries: ctx.entries, floorName: floor.name, settings, lookup: deps.lookup});
    }
    const message = bundleMessage({candidates: roles, hours, now});
    const mail = {to, roles: roles.map(c => c.role), message, sent: false};
    report.mails.push(mail);
    sent += 1;
    if (dryRun) continue;
    let result;
    try { result = deps.sendMail(to, message); } catch (error) { result = {ok: false, delivery: 'unknown', error: error.message}; }
    mail.sent = result.ok === true;
    if (!result.ok) {
      mail.delivery = result.delivery; mail.error = result.error;
      // 확실히 안 간 것(not-sent)은 다음 시간에 다시 보낸다. 갔을 수도 있는 것은 기준 시간 동안 다시 보내지 않는다.
      if (result.delivery !== 'not-sent') for (const role of mail.roles) attempts[role] = now;
    }
  }
  save({candidates: summary, candidatesAt: now});
  return report;
}

export function formatReport(report, now = Date.now()) {
  if (report.unsupported) return [`${report.unsupported} 바닥에서는 정리 후보를 고르지 않는다(tmux 바닥만)`];
  const lines = [`기준 ${report.hours}시간 · 살아 있는 역할 세션 ${report.live}개 · 화면이 기준 넘게 그대로인 세션 ${report.stale}개 · 정리 후보 ${report.candidates.length}개` +
    (report.dryRun ? ' · --dry-run(보내지 않음, 상태 파일도 쓰지 않음)' : '') + (report.off ? ` · ${IDLE_ROLES_OFF} 있음(자동 실행은 우편을 보내지 않고 화면 표본만 쌓는다)` : '')];
  for (const mail of report.mails) {
    lines.push('', `${report.dryRun ? '보낼' : mail.sent ? '보낸' : '못 보낸'} 우편 → ${mail.to} (${mail.roles.length}개)${mail.sent || report.dryRun ? '' : ` — ${mail.delivery ?? '실패'}: ${mail.error ?? ''}`}`, mail.message);
  }
  for (const held of report.held) lines.push('', `이번에 보내지 않음 → ${held.to}: ${held.roles.join(', ')} (한 번 실행의 우편 상한 ${MAX_MAILS_PER_RUN}통)`);
  const again = report.candidates.filter(c => c.notifiedAt);
  if (again.length) lines.push('', `이미 알린 후보(기준 시간 안): ${again.map(c => `${c.role}(${localStamp(c.notifiedAt)})`).join(', ')}`);
  if (report.skipped.length) {
    lines.push('', `화면은 그대로지만 후보가 아닌 역할 ${report.skipped.length}개:`);
    for (const item of report.skipped) lines.push(`  ${item.role} — ${item.reason}`);
  }
  return lines;
}
