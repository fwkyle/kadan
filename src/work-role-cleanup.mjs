// Why: 업무를 마감하면 그 업무에서 일한 작업자·검수자 세션이 남아 쌓인다. 마감이 기록된 뒤, 안전하다고 확인된 세션만
// 하나씩 끈다. 끄기는 `kadan stop`과 같은 코어(stopRole)를 쓰고, 어떤 이유로든 확인이 안 되면 끄지 않고 이유를 남긴다.
// 호출자(CLI의 work complete)만 부른다. 대시보드 마감은 저장소 층을 직접 불러 여기를 거치지 않는다.
//
// 판정의 원칙(2026-11-10 3차 검수 뒤 범위를 좁힘): 자동으로 끄는 것은 "띄운 뒤 한 번도 꺼졌다 켜지지 않았고 이어 연 것이 아닌 세션이,
// 그 start 뒤에 이 업무 실행의 실제 발령을 받았고, 인계에 관련된 적이 없을 때"뿐이다. 다시 띄웠거나 이어 열었거나 인계에 관련된 세션은
// 남기고 `kadan stop` 안내만 한다. 세대 이어짐을 증명하려는 코드는 두지 않는다(검수에서 틀리는 방향이 반복됐다). 모르면 끄지 않는다.
//  - 끄기 직전(대화 번호 조회 뒤, floor.stop 앞)에 같은 판정을 최신 원장·화면으로 다시 한다(stopRole의 beforeStop).
//  - 이름만으로 판정하는 곳(미확정 카드·다른 열린 업무·호출자 자신)은 모두 "더 많이 보호하는" 쪽으로만 틀린다.
//
// 비용: 역할 N개마다 판정을 두 번(고르기 + 끄기 직전) 한다. 판정 한 번 = 원장 읽기 1 + 원장 순회 2(띄운 start 찾기·발령 찾기)
// + 인계 순회 1 + handovers 폴더 읽기 1 + 업무 목록 1 + 카드 읽기(업무 수 × 실행 수). 원장이 10배면 판정 시간도 약 10배다.
import fs from "node:fs";
import path from "node:path";
import { CardStore } from "./card-store.mjs";
import { WorkStore } from "./work-store.mjs";
import { readLedger } from "./ledger.mjs";
import { taskIdentity } from "./task-identity.mjs";
import { sessionOwner, assertSessionOwner } from "./session-ownership.mjs";
import { pendingCardsFor } from "./cli-start-support.mjs";
import { withEffectiveOwner, effectiveCardRole } from "./handover-state.mjs";
import { TARGETS } from "./revive.mjs";
import { stopRole as defaultStopRole } from "./role-stop.mjs";
import { confirmIdleBeforeStop } from "./commands/restart.mjs";
import { floor as defaultFloor } from "./floor.mjs";
import { startConversationCertainty } from "./conversation-ref.mjs";
import { startDigest } from "./secretary-resume.mjs";

const STOPPABLE_PROFILES = new Set(["worker", "reviewer"]);
const finiteTime = t => Number.isFinite(Date.parse(t));
// 세 값: YES(증명됨) / NO(아님이 확인됨) / UNKNOWN(모름·읽기 실패·모양이 다름). 끄기는 전부 YES일 때만이다.
const YES = "yes", NO = "no", UNKNOWN = "unknown";
const str = v => typeof v === "string" && v.trim() !== "";

// 업무의 실행 카드마다 [카드, 확정 인계를 반영한 현재 담당]. 카드가 없으면 모름이라 던진다(호출자가 "끄지 않음"으로 처리).
function assignments(work, cards, entries, identity) {
  const out = [];
  for (const link of work.executions) {
    const card = cards.get(link.key);
    if (!card) throw new Error(`실행 카드를 읽지 못함: ${link.key}`);
    const role = effectiveCardRole(card, entries, identity);
    if (typeof role === "string" && role.trim()) out.push({ key: link.key, card, role: role.trim() });
  }
  return out;
}

// 실제 발령. `kadan work execute --assign --dispatch`, `kadan dispatch --task`, `kadan send --task` 세 경로가 모두 같은 모양을 남긴다
// (격리 실측): kind send + taskId(이 업무 실행으로 풀림) + executionKey + dispatchId + keyDelivery "sent" + header true(머리말 표시일 뿐, 발령 구분이 아님).
// 일반 우편은 taskId·dispatchId가 없다. 답장·알림·--raw 전달 읽음·메일함 전송·--expect-reply 발령·자동 생성 우편은 근거에서 뺀다(덜 끄는 쪽).
function isDispatch(e, identity, key, role) {
  if (e?.kind !== "send" || e.role !== role || !str(e.taskId) || !str(e.dispatchId) || e.keyDelivery !== "sent" || !finiteTime(e.t)) return false;
  if (e.notificationOnly || e.deliveredRead || e.replyTo || e.replyFinal || e.expectReply || e.systemGenerated || e.transport === "mailbox" || e.mailKind) return false;
  if (e.executionKey !== undefined && e.executionKey !== key) return false;
  const found = identity.resolve(e.taskId);
  return found.state === "resolved" && found.key === key;
}

// 끄는 대상은 "띄운 뒤 한 번도 꺼졌다 켜지지 않았고, 이어 연 것이 아닌" 세션뿐이다.
// 그 세션의 마지막 "띄운 start"를 구한다: stop 뒤의 start는 새로 띄운 것이다. stop 없이 다시 기록된 start는 "살아 있는 세션 재사용 기록"의
// 모양이 모두 확인될 때만 무시한다 — 명령(cmd)이 없고, pane PID가 띄운 start와 같고, reuseOf가 띄운 start의 지문과 같을 때(start.mjs·reuseOfFor가 남기는 모양).
// 그 밖의 start(명령이 있음, PID가 다름, reuseOf가 다른 세대를 가리킴)는 새 시작 기록이라 그 start가 새 "띄운 start"가 되고 이후 판정은 그 start 기준이다.
// reuseOf가 없는 재사용 기록은 모양을 확인할 수 없어 새 시작으로 보며, 명령이 없는 start는 띄운 방법을 알 수 없어 끄지 않는다(launchedFresh → UNKNOWN).
// stop 뒤 첫 start도 내용으로 본다(명령이 없거나 이어 연 표시가 있으면 launchedFresh가 거른다).
function isReuseRecord(e, launch) {
  const pid = e.panePid ?? e.rottiePid, first = launch.panePid ?? launch.rottiePid;
  return !str(e.cmd) && str(String(pid ?? "")) && String(pid) === String(first) && str(e.reuseOf) && e.reuseOf === startDigest(launch);
}
function launchStart(entries, role) {
  let launch = null, index = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e?.kind === "stop" && (e.role === role || e.session === `kadan-${role}`)) { launch = null; continue; }
    if (e?.kind !== "start" || e.role !== role) continue;
    if (launch && isReuseRecord(e, launch)) continue;
    launch = e; index = i;
  }
  return launch ? { state: YES, start: launch, index } : { state: UNKNOWN };
}
function launchedFresh(start) {
  if (["restartOf", "reopenOf", "restoredFrom", "secretaryResumeSource"].some(k => start[k] !== undefined && start[k] !== null && start[k] !== false)) return NO;
  if (start.inheritMail === true) return NO;
  if (!str(start.cmd)) return UNKNOWN;
  return startConversationCertainty(start.cmd) === "new" ? YES : NO;
}

// 인계: 그 역할이 선임이든 후임이든 관련된 인계 기록이 그 start 뒤에 하나라도 있으면 끄지 않는다(끝난 인계도). 원장 handover 사건과 상태 파일을 본다.
// handovers/*.json은 모양으로만 읽는다: 상태 파일(id·phase·from·to가 문자열), 인수 근거 파일(taskIds·evidencePaths 배열 + nextAction 문자열).
// 어느 쪽도 아닌 파일이 하나라도 있으면 UNKNOWN이다. 폴더가 없으면 인계가 없는 것이다.
function noRelatedHandover(home, entries, role, afterIndex) {
  for (let i = afterIndex + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e?.kind === "handover" && (e.from === role || e.to === role)) return NO;
  }
  let names = [];
  try { names = fs.readdirSync(path.join(home, "handovers")).filter(n => n.endsWith(".json")); }
  catch (error) { if (error.code !== "ENOENT") return UNKNOWN; }
  for (const name of names) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(home, "handovers", name), "utf8")); } catch { return UNKNOWN; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return UNKNOWN;
    const isState = str(data.id) && str(data.phase) && str(data.from) && str(data.to);
    const isReceipt = Array.isArray(data.taskIds) && Array.isArray(data.evidencePaths) && str(data.nextAction) && !("phase" in data);
    if (!isState && !isReceipt) return UNKNOWN;
    // 아직 끝나지 않은 인계에 묶인 역할은 그 start와 상관없이 끄지 않는다(상태 파일은 시각이 없어 start 뒤 여부를 모른다).
    if (isState && !["complete", "aborted"].includes(data.phase) && (data.from === role || data.to === role)) return NO;
  }
  return YES;
}

// 한 역할을 지금 끌 수 있는가. 끌 수 없으면 {skip: 이유}, 이미 꺼져 있으면 {already}, 끌 수 있으면 {pid}.
// 던지는 것은 모두 "확인 불가"라 호출자가 끄지 않는다. 매번 최신 원장·카드·업무·화면을 읽는다. beforeStop도 이 함수를 다시 부른다.
const RESTARTED = "다시 띄우거나 이어 연 세션 — 직접 끄려면 kadan stop";
function evaluate({ home, role, session, work, callerRole, floor }) {
  if (!str(callerRole)) return { skip: "이 명령을 부른 역할을 알 수 없음" };
  if (TARGETS.includes(role)) return { skip: "기반 프로세스는 대상이 아님" };
  if (role === callerRole) return { skip: "이 명령을 부른 역할 자신" };
  if (!floor.alive(session)) return { already: true };
  const entries = readLedger(home);
  if (entries.some(e => e.broken)) return { skip: "원장 손상: 인계 상태를 읽지 못함" };
  const owner = sessionOwner(entries, session, role);
  if (!owner.start) return { skip: "시작 기록 없음" };
  if (!STOPPABLE_PROFILES.has(owner.start.roleProfile)) {
    return { skip: owner.start.roleProfile ? `역할 프로필이 ${owner.start.roleProfile}(작업자·검수자가 아님)` : "역할 프로필 기록 없음" };
  }
  const cards = new CardStore(home), identity = taskIdentity(cards.listSummaries());
  const mine = assignments(work, cards, entries, identity).filter(a => a.role === role);
  if (!mine.length) return { skip: "이 업무의 현재 담당이 아님(인계 반영)" };
  // 띄운 start: 한 번도 꺼졌다 켜지지 않았고 이어 연 것이 아니며, 지금 pane PID가 그 start의 PID다.
  const launch = launchStart(entries, role);
  if (launch.state !== YES) return { skip: RESTARTED };
  if (launchedFresh(launch.start) !== YES) return { skip: RESTARTED };
  if (!finiteTime(launch.start.t)) return { skip: "대화 세대의 시작 시각을 확정할 수 없음" };
  const launchPid = launch.start.panePid ?? launch.start.rottiePid;
  const pid = floor.pid(session);
  if (!str(String(launchPid ?? "")) || String(pid) !== String(launchPid)) return { skip: RESTARTED };
  // 그 start 뒤에 이 업무 실행의 실제 발령이 있다.
  const from = Date.parse(launch.start.t);
  const dispatched = entries.some((e, i) => i > launch.index && Date.parse(e?.t) >= from && mine.some(a => isDispatch(e, identity, a.key, role)));
  if (!dispatched) return { skip: "이 업무의 발령을 받은 대화 세대가 아님" };
  const handover = noRelatedHandover(home, entries, role, launch.index);
  if (handover !== YES) return { skip: handover === NO ? "인계에 관련된 세션 — 직접 끄려면 kadan stop" : "인계 상태를 읽지 못함" };
  // 다른 열린 업무: 종료(done·cancelled)가 아닌 모든 업무(보류 포함)를 본다. 카드를 못 읽으면 모름이라 끄지 않는다.
  for (const other of new WorkStore(home).list()) {
    if (other.key === work.key || ["done", "cancelled"].includes(other.status)) continue;
    for (const x of other.executions) {
      const card = cards.get(x.key);
      if (!card) return { skip: `다른 열린 업무 ${other.key}의 실행 카드를 읽지 못함` };
      if (card.role === role || effectiveCardRole(card, entries, identity) === role) return { skip: `다른 열린 업무 ${other.key}의 실행에 배정됨` };
    }
  }
  const pending = pendingCardsFor(identity.project(entries), role);
  if (pending.length) return { skip: `미확정 카드 ${pending.length}건(${pending.slice(0, 3).join(", ")})` };
  confirmIdleBeforeStop(session, floor);
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
