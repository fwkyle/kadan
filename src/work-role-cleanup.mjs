// Why: 업무를 마감하면 그 업무에서 일한 작업자·검수자 세션이 남아 쌓인다. 마감이 기록된 뒤, 안전하다고 확인된 세션만
// 하나씩 끈다. 끄기는 `kadan stop`과 같은 코어(stopRole)를 쓰고, 어떤 이유로든 확인이 안 되면 끄지 않고 이유를 남긴다.
// 호출자(CLI의 work complete)만 부른다. 대시보드 마감은 저장소 층을 직접 불러 여기를 거치지 않는다.
// 비용: 역할마다 끄기 직전에 원장·카드·업무를 다시 읽는다(대상 판정 뒤 시간이 지나므로). 역할 수 N에 비례해
// 원장 읽기 N번, 업무 목록 N번이다. 원장이 10배면 역할마다 읽는 시간도 10배 — 역할은 보통 2~4개다.
import { CardStore } from "./card-store.mjs";
import { WorkStore } from "./work-store.mjs";
import { readLedger } from "./ledger.mjs";
import { taskIdentity } from "./task-identity.mjs";
import { sessionOwner, assertSessionOwner } from "./session-ownership.mjs";
import { pendingCardsFor } from "./cli-start-support.mjs";
import { withEffectiveOwner } from "./handover-state.mjs";
import { TARGETS } from "./revive.mjs";
import { stopRole as defaultStopRole } from "./role-stop.mjs";
import { confirmIdleBeforeStop } from "./commands/restart.mjs";
import { floor as defaultFloor } from "./floor.mjs";

const STOPPABLE_PROFILES = new Set(["worker", "reviewer"]);

// 이 업무의 실행 카드에 배정된 역할(카드의 role). 이름으로 추측하지 않는다.
function assignedRoles(home, work) {
  const cards = new CardStore(home);
  const roles = new Set();
  for (const link of work.executions) {
    const role = cards.get(link.key)?.role;
    if (typeof role === "string" && role.trim()) roles.add(role.trim());
  }
  return [...roles];
}

// 한 역할을 지금 끌 수 있는가. 끌 수 없으면 {skip: 이유}, 끌 수 있으면 {pid}. 던지는 것은 모두 "확인 불가"라 끄지 않는다.
function evaluate({ home, role, session, workKey, callerRole, floor }) {
  if (TARGETS.includes(role)) return { skip: "기반 프로세스는 대상이 아님" };
  if (callerRole && role === callerRole) return { skip: "이 명령을 부른 역할 자신" };
  if (!floor.alive(session)) return { already: true };
  const entries = readLedger(home);
  const owner = sessionOwner(entries, session, role);
  if (!owner.start) return { skip: "시작 기록 없음" };
  if (!STOPPABLE_PROFILES.has(owner.start.roleProfile)) {
    return { skip: owner.start.roleProfile ? `역할 프로필이 ${owner.start.roleProfile}(작업자·검수자가 아님)` : "역할 프로필 기록 없음" };
  }
  const cards = new CardStore(home);
  for (const other of new WorkStore(home).list()) {
    if (other.key === workKey || other.status !== "open") continue;
    if (other.executions.some(x => cards.get(x.key)?.role === role)) return { skip: `다른 열린 업무 ${other.key}의 실행에 배정됨` };
  }
  const pending = pendingCardsFor(taskIdentity(cards.listSummaries()).project(entries), role);
  if (pending.length) return { skip: `미확정 카드 ${pending.length}건(${pending.slice(0, 3).join(", ")})` };
  confirmIdleBeforeStop(session, floor);
  const pid = floor.pid(session);
  assertSessionOwner(owner, pid);
  return { pid };
}

// 반환: {kept, closed:[{role,session,conversation}], skipped:[{role,reason}], already:[role], wouldClose:[role], lines:[stderr 줄], idleOwner}.
// 던지지 않는다 — 마감 결과를 바꾸지 않기 위해 모든 실패는 항목의 이유로 남긴다.
export function closeWorkRoles({ home, work, keep = false, callerRole = "", floor = defaultFloor, stopRole = defaultStopRole, warn = () => {} }) {
  const out = { kept: keep, closed: [], skipped: [], already: [], wouldClose: [], lines: [] };
  let roles = [];
  try { roles = assignedRoles(home, work); }
  catch (error) { out.skipped.push({ role: "(전체)", reason: `대상 판정 실패: ${error.message}` }); }
  for (const role of roles) {
    const session = `kadan-${role}`;
    let verdict;
    try { verdict = evaluate({ home, role, session, workKey: work.key, callerRole, floor }); }
    catch (error) { verdict = { skip: `확인 불가: ${error.message}` }; }
    if (verdict.already) { out.already.push(role); continue; }
    if (verdict.skip) { out.skipped.push({ role, reason: verdict.skip }); continue; }
    if (keep) { out.wouldClose.push(role); continue; }
    try {
      // 판정 뒤 세션이 다른 프로세스로 바뀌었으면 끄지 않는다. stopRole도 시작 기록과 한 번 더 대조한다.
      if (String(floor.pid(session)) !== String(verdict.pid)) { out.skipped.push({ role, reason: "판정 뒤 세션 프로세스가 바뀜" }); continue; }
      const result = stopRole({ role, session, home, floor, log: warn, warn });
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
