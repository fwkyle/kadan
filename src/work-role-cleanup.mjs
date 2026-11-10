// Why: 업무를 마감하면 그 업무에서 일한 작업자·검수자 세션이 남아 쌓인다. 마감이 기록된 뒤, 안전하다고 확인된 세션만
// 하나씩 끈다. 끄기는 `kadan stop`과 같은 코어(stopRole)를 쓰고, 어떤 이유로든 확인이 안 되면 끄지 않고 이유를 남긴다.
// 호출자(CLI의 work complete)만 부른다. 대시보드 마감은 저장소 층을 직접 불러 여기를 거치지 않는다.
//
// 판정의 원칙(2026-11-10 독립검수 F1~F3): 역할 "이름"이 아니라 "이 업무의 발령을 받은 지금 세대"를 끈다.
//  - 대상 역할은 확정 인계를 반영한 현재 담당(effectiveCardRole)이다. 인계 상태를 못 읽으면 끄지 않는다.
//  - 세션의 지금 책임 세대 안에 이 업무 실행의 발령(또는 인계 수신) 기록이 있어야 한다. 세대 경계는 우편·책임이 쓰는
//    mail-generation.mjs와 같다(같은 대화 resume·restart·reopen은 이어지고 새 대화·fork는 끊긴다).
//  - 끄기 직전(대화 번호 조회 뒤, floor.stop 앞)에 같은 판정을 최신 원장·화면으로 다시 한다(stopRole의 beforeStop).
// 이름만으로 판정하는 곳(미확정 카드·다른 열린 업무·호출자 자신)은 모두 "더 많이 보호하는" 쪽으로만 틀린다.
//
// 비용: 역할 N개마다 판정을 두 번(고르기 + 끄기 직전) 한다. 판정 한 번 = 원장 1회 + 업무 목록 1회 + 카드 읽기
// (업무 수 × 실행 수) + 세대 계산(원장 길이에 비례). 원장이 10배면 역할마다 판정 시간도 약 10배다. 역할은 보통 2~4개.
import { CardStore } from "./card-store.mjs";
import { WorkStore } from "./work-store.mjs";
import { readLedger } from "./ledger.mjs";
import { taskIdentity } from "./task-identity.mjs";
import { sessionOwner, assertSessionOwner } from "./session-ownership.mjs";
import { pendingCardsFor } from "./cli-start-support.mjs";
import { withEffectiveOwner, effectiveCardRole } from "./handover-state.mjs";
import { createMailGenerations } from "./mail-generation.mjs";
import { TARGETS } from "./revive.mjs";
import { stopRole as defaultStopRole } from "./role-stop.mjs";
import { confirmIdleBeforeStop } from "./commands/restart.mjs";
import { floor as defaultFloor } from "./floor.mjs";

const STOPPABLE_PROFILES = new Set(["worker", "reviewer"]);
const finiteTime = t => Number.isFinite(Date.parse(t));

// 업무의 실행 카드마다 [카드, 확정 인계를 반영한 현재 담당]. 읽기 실패는 던진다(호출자가 "끄지 않음"으로 처리).
function assignments(work, cards, entries, identity) {
  const out = [];
  for (const link of work.executions) {
    const card = cards.get(link.key);
    if (!card) continue;
    const role = effectiveCardRole(card, entries, identity);
    if (typeof role === "string" && role.trim()) out.push({ key: link.key, card, role: role.trim() });
  }
  return out;
}

// 이 역할이 이 실행을 "받은" 시각들: 그 역할 앞으로 간 발령(send)과, 그 역할이 인계받은 확정 인계 시각.
function receivedTimes(entries, identity, key, role) {
  const times = [];
  for (const e of entries) {
    if (e.kind === "send" && e.role === role && (e.executionKey === key || (e.taskId && identity.resolve(e.taskId).key === key))) times.push(e.t);
    if (e.kind === "handover" && e.phase === "transferred" && e.to === role
      && e.taskIds?.some(id => { const found = identity.resolve(id); return found.state === "resolved" && found.key === key; })) times.push(e.t);
  }
  return times.filter(finiteTime);
}

// 한 역할을 지금 끌 수 있는가. 끌 수 없으면 {skip: 이유}, 이미 꺼져 있으면 {already}, 끌 수 있으면 {pid}.
// 던지는 것은 모두 "확인 불가"라 호출자가 끄지 않는다. 매번 최신 원장·카드·업무·화면을 읽는다.
function evaluate({ home, role, session, work, callerRole, floor }) {
  if (TARGETS.includes(role)) return { skip: "기반 프로세스는 대상이 아님" };
  if (callerRole && role === callerRole) return { skip: "이 명령을 부른 역할 자신" };
  if (!floor.alive(session)) return { already: true };
  const entries = readLedger(home);
  if (entries.some(e => e.broken)) return { skip: "원장 손상: 인계 상태를 읽지 못함" };
  const owner = sessionOwner(entries, session, role);
  if (!owner.start) return { skip: "시작 기록 없음" };
  if (!STOPPABLE_PROFILES.has(owner.start.roleProfile)) {
    return { skip: owner.start.roleProfile ? `역할 프로필이 ${owner.start.roleProfile}(작업자·검수자가 아님)` : "역할 프로필 기록 없음" };
  }
  const cards = new CardStore(home), identity = taskIdentity(cards.listSummaries());
  // 이 업무의 발령을 받은 지금 세대인가(F1). 이름이 같아도 새 대화로 다시 뜬 세션은 이 업무와 무관하다.
  const mine = assignments(work, cards, entries, identity).filter(a => a.role === role);
  if (!mine.length) return { skip: "이 업무의 현재 담당이 아님(인계 반영)" };
  const generations = createMailGenerations();
  entries.forEach((e, index) => generations.apply(e, index));
  const inCurrentGeneration = mine.some(a => receivedTimes(entries, identity, a.key, role).some(t => !generations.isPreviousAt(role, t)));
  if (!inCurrentGeneration) return { skip: "이 업무의 발령을 받은 대화 세대가 아님" };
  // 다른 열린 업무(F2): 원문 담당과 인계 반영 담당 어느 쪽이든 이 역할이면 보호한다.
  for (const other of new WorkStore(home).list()) {
    if (other.key === work.key || other.status !== "open") continue;
    if (other.executions.some(x => { const card = cards.get(x.key); return card && (card.role === role || effectiveCardRole(card, entries, identity) === role); })) {
      return { skip: `다른 열린 업무 ${other.key}의 실행에 배정됨` };
    }
  }
  const pending = pendingCardsFor(identity.project(entries), role);
  if (pending.length) return { skip: `미확정 카드 ${pending.length}건(${pending.slice(0, 3).join(", ")})` };
  confirmIdleBeforeStop(session, floor);
  const pid = floor.pid(session);
  assertSessionOwner(owner, pid);
  return { pid: String(pid) };
}

// 반환: {kept, closed:[{role,session,conversation}], skipped:[{role,reason}], already:[role], wouldClose:[role], lines:[stderr 줄], idleOwner}.
// 던지지 않는다 — 마감 결과를 바꾸지 않기 위해 모든 실패는 항목의 이유로 남긴다.
export function closeWorkRoles({ home, work, keep = false, callerRole = "", floor = defaultFloor, stopRole = defaultStopRole, warn = () => {} }) {
  const out = { kept: keep, closed: [], skipped: [], already: [], wouldClose: [], lines: [] };
  let roles = [];
  try {
    const cards = new CardStore(home), entries = readLedger(home);
    if (entries.some(e => e.broken)) throw new Error("원장 손상: 인계 상태를 읽지 못함");
    roles = [...new Set(assignments(work, cards, entries, taskIdentity(cards.listSummaries())).map(a => a.role))];
  } catch (error) { out.skipped.push({ role: "(전체)", reason: `대상 판정 실패: ${error.message}` }); }
  for (const role of roles) {
    const session = `kadan-${role}`, input = { home, role, session, work, callerRole, floor };
    let verdict;
    try { verdict = evaluate(input); }
    catch (error) { verdict = { skip: `확인 불가: ${error.message}` }; }
    if (verdict.already) { out.already.push(role); continue; }
    if (verdict.skip) { out.skipped.push({ role, reason: verdict.skip }); continue; }
    if (keep) { out.wouldClose.push(role); continue; }
    // 끄기 직전 확인(F3): 대화 번호 조회가 끝난 뒤 floor.stop 앞에서 최신 원장·화면으로 같은 판정을 다시 하고,
    // 세션이 판정 때와 같은 프로세스인지 본다. 걸리거나 확인이 실패하면 던져서 끄지 않는다(stop 사건도 남기지 않는다).
    const beforeStop = () => {
      const again = evaluate(input);
      if (again.already) throw new Error("세션이 이미 없음");
      if (again.skip) throw new Error(again.skip);
      if (again.pid !== verdict.pid) throw new Error("판정 뒤 세션 프로세스가 바뀜");
    };
    try {
      const result = stopRole({ role, session, home, floor, log: warn, warn, beforeStop });
      if (result.ok) out.closed.push({ role, session, conversation: result.entry?.conversation ?? null });
      else out.skipped.push({ role, reason: result.stopped ? `껐지만 기록·창 정리 실패: ${result.message}` : result.message });
    } catch (error) { out.skipped.push({ role, reason: `끄기 실패: ${error.message}` }); }
  }
  // 책임 감독 한 줄: 인계를 반영한 현재 책임 감독의 열린 업무가 0건이면 알린다(감독 세션은 끄지 않는다).
  try {
    const entries = readLedger(home), owner = withEffectiveOwner(work, entries).owner;
    const open = new WorkStore(home).list().filter(w => w.status === "open").map(w => withEffectiveOwner(w, entries)).filter(w => w.owner === owner);
    if (open.length === 0) out.idleOwner = owner;
  } catch { /* 안내용이라 실패해도 조용히 넘어간다 */ }
  out.lines = formatLines(out);
  return out;
}

export function formatLines(out) {
  const lines = [];
  const verb = out.kept ? "꺼졌을 역할" : "끈 역할";
  const list = out.kept ? out.wouldClose.map(r => `${r}`) : out.closed.map(c => `${c.role}(대화 ${c.conversation ?? "번호 없음"} — 다시 열기: kadan reopen ${c.role})`);
  if (list.length) lines.push(`${verb} ${list.length}개${out.kept ? "(--keep-roles: 끄지 않음)" : ""}: ${list.join(", ")}`);
  if (out.skipped.length) {
    lines.push(`끄지 않은 역할 ${out.skipped.length}개:`);
    for (const s of out.skipped) lines.push(`  ${s.role} — ${s.reason} · 끄려면 kadan stop ${s.role}`);
  }
  if (out.already.length) lines.push(`이미 꺼져 있음: ${out.already.join(", ")}`);
  if (out.idleOwner) lines.push(`이 감독(${out.idleOwner})은 열린 업무 0건`);
  return lines;
}
