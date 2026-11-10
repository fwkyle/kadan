// Why: `kadan stop`의 본체. 실패해도 프로세스를 끝내지 않고 결과를 돌려준다 — 여러 세션을 차례로 꺼야 하는 호출자
// (업무 마감 때 함께 끄기)가 한 세션의 실패로 멈추지 않게 한다. `kadan stop`의 출력·종료 코드·순서는 예전과 같다:
// 소유 확인 → 대화 번호 찾기 → 멈춤 표시 → 소유 재확인 → 끄기 → 창 정리 → 원장 기록.
// 대화 번호 찾기는 끄기 앞에서 하고, 못 찾아도 끈다(role-conversation.mjs). 찾는 동안 pane이 바뀌면 끄기 직전 소유 재확인이 막는다.
// 비용: 원장 읽기 2번(소유 확인·창 정리)은 예전과 같고, 대화 찾기는 앞의 읽기를 다시 쓴다.
import { taskIdentity } from "./task-identity.mjs";
import { CardStore } from "./card-store.mjs";
import { floor as defaultFloor } from "./floor.mjs";
import { appendLedger, readLedger } from "./ledger.mjs";
import { currentRottieWindow } from "./restore.mjs";
import { readSettings } from "./runner-settings.mjs";
import { sessionOwner, assertSessionOwner } from "./session-ownership.mjs";
import { TARGETS, acquireReviveLock, lockWaitMs, reclaimLog, legacyLog, markStopped, unmarkStopped, readReviveState } from "./revive.mjs";
import { pendingCardsFor, buildStopLedgerEntry, closeStartedWindow } from "./cli-start-support.mjs";
import { stopConversationFields, lookupDeps } from "./role-conversation.mjs";
import { paneInfo } from "./commands/restart.mjs";

// 반환: {ok: false, message, code} — 끄지 않았다. {ok: true, session, windowIncomplete, entry} — 껐고 기록했다.
// {ok: false, stopped: true, error} — 세션은 껐지만 창 정리·기록에서 예외가 났다(호출자가 다시 던지거나 보고한다).
// log는 stdout, warn은 stderr 줄이다. lookup은 시험에서 가짜 조회를 넣는 자리다.
export function stopRole({ role, session, home, floor = defaultFloor, log = console.log, warn = console.error, beforeStop = null,
  lookup = input => stopConversationFields({ ...input, deps: lookupDeps({ paneInfo }) }) }) {
  const infrastructure = TARGETS.includes(role);
  // 기반 프로세스 4개의 stop은 `kadan up --auto`와 같은 잠금 아래에서 돈다. 안 그러면 끄는 도중 자동 실행이 세션이 없는 것을 보고 되살린다.
  // 잠금을 못 잡으면 끄지 않고 안내한다(사람 명령을 조용히 무시하지 않는다).
  const release = infrastructure ? acquireReviveLock(home, { waitMs: lockWaitMs(), onReclaim: reclaimLog, onLegacy: legacyLog }) : () => {};
  if (!release) return { ok: false, code: 1, message: `자동 되살리기(kadan up --auto)가 실행 중이라 끄지 않았습니다. 잠시 뒤 다시 kadan stop ${role}를 치세요` };
  const refuse = (message) => { release(); return { ok: false, code: 1, message }; };
  if (!floor.alive(session)) return refuse(`세션 없음: ${session}`);
  const entries = readLedger(home);
  let owner;
  try {
    owner = sessionOwner(entries, session, role);
    assertSessionOwner(owner, floor.pid(session), { infrastructure });
  } catch (error) { return refuse(error.message); }
  const pending = pendingCardsFor(taskIdentity(new CardStore(home).listSummaries()).project(entries), role);
  if (pending.length > 0) {
    log(`미확정 카드 ${pending.length}건: ${pending.join(", ")} — 종료하면 화면이 사라진다. 확인했으면 kadan done ${role} <카드id> <ok|failed>`);
  }
  // 끄기 앞에서 대화 번호를 찾는다. 조회는 던지지 않게 만들어져 있지만, 끄기가 조회 때문에 막히지 않도록 한 번 더 감싼다.
  let conversation;
  try { conversation = lookup({ session, entries, floorName: floor.name, infrastructure, readSettings: () => readSettings(home) }); }
  catch { conversation = { conversationMissing: "error" }; }
  // 순서: 멈춤 표시를 먼저 저장하고 그다음 세션을 끈다. 끄기가 실패하면 표시를 이전 상태로 되돌린다
  // (세션이 그대로 살아 있으니 "끈 것"이 아니다. 오류는 사람이 본다).
  let marked = null;
  try {
    marked = markStopped(home, role);
    // 마지막 안전장치: 저장한 표시를 다시 읽어 이 대상이 실제로 stopped인지 확인한다. 아니면 끄지 않는다(끈 것이 되살아나는 일을 막는다).
    if (marked && readReviveState(home).targets?.[role]?.state !== "stopped") throw new Error("표시가 저장되지 않았다");
  } catch (error) { return refuse(`자동 되살리기 멈춤 표시 실패: ${error.message} — 끄지 않았습니다`); }
  try {
    // 선택: 끄기 직전 확인(업무 마감의 끄기만 넘긴다). 대화 번호 조회가 끝난 뒤라 그 사이의 변화를 잡는다. 던지면 끄지 않는다.
    if (beforeStop) beforeStop();
    assertSessionOwner(owner, floor.pid(session), { infrastructure });
    floor.stop(session);
  } catch (error) {
    if (marked) { try { unmarkStopped(home, role, marked); } catch { /* 표시를 못 되돌려도 오류는 알린다 */ } }
    return refuse(error.message);
  }
  try {
    const windowFields = floor.name === "tmux" ? closeStartedWindow(currentRottieWindow(readLedger(home), session), { print: warn }) : {};
    const entry = { ...buildStopLedgerEntry({ role, session }), ...conversation, ...windowFields };
    appendLedger(entry, home);
    if (windowFields.rottieWindowClosed === false || windowFields.rottieWindowRemoved === false) {
      warn(`세션은 종료됨: ${session} · 로티 탭 정리 미완료: ${windowFields.rottieTerminalId} — ${windowFields.rottieWindowError ?? windowFields.rottieRemoveError}`);
      return { ok: true, session, windowIncomplete: true, entry };
    }
    log(`종료됨: ${session}`);
    return { ok: true, session, windowIncomplete: false, entry };
  } catch (error) {
    return { ok: false, stopped: true, error, code: 1, message: error.message };
  } finally { release(); }
}
