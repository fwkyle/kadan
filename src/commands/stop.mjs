// kadan stop (HW-3-impl: cli.mjs에서 옮김)
import { taskIdentity } from "../task-identity.mjs";
import { CardStore } from "../card-store.mjs";
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome, readLedger } from "../ledger.mjs";
import { tmux } from "../floor-tmux.mjs";
import { currentRottieWindow } from "../restore.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import { TARGETS, acquireReviveLock, lockWaitMs, reclaimLog, legacyLog, markStopped, unmarkStopped, readReviveState } from "../revive.mjs";
import {
  pendingCardsFor,
  buildStopLedgerEntry,
  closeStartedWindow,
} from "../cli-start-support.mjs";

export function cmdStop(argv) {
  const role = argv[0];
  if (!role) die("사용법: kadan stop <역할>");
  const session = sessionName(role);
  const home = ledgerHome();
  // 기반 프로세스 4개의 stop은 `kadan up --auto`와 같은 잠금 아래에서 돈다. 안 그러면 끄는 도중 자동 실행이 세션이 없는 것을 보고 되살린다.
  // 잠금을 못 잡으면 끄지 않고 안내한다(사람 명령을 조용히 무시하지 않는다).
  const release = TARGETS.includes(role) ? acquireReviveLock(home, { waitMs: lockWaitMs(), onReclaim: reclaimLog, onLegacy: legacyLog }) : () => {};
  if (!release) die(`자동 되살리기(kadan up --auto)가 실행 중이라 끄지 않았습니다. 잠시 뒤 다시 kadan stop ${role}를 치세요`, 1);
  const fail = (message) => { release(); die(message); };
  if (!floor.alive(session)) fail(`세션 없음: ${session}`);
  const pending = pendingCardsFor(taskIdentity(new CardStore(home).listSummaries()).project(readLedger()), role);
  if (pending.length > 0) {
    console.log(
      `미확정 카드 ${pending.length}건: ${pending.join(", ")} — 종료하면 화면이 사라진다. 확인했으면 kadan done ${role} <카드id> <ok|failed>`
    );
  }
  // 순서: 멈춤 표시를 먼저 저장하고 그다음 세션을 끈다. 끄기가 실패하면 표시를 이전 상태로 되돌린다
  // (세션이 그대로 살아 있으니 "끈 것"이 아니다. 오류는 사람이 본다).
  let marked = null;
  try {
    marked = markStopped(home, role);
    // 마지막 안전장치: 저장한 표시를 다시 읽어 이 대상이 실제로 stopped인지 확인한다. 아니면 끄지 않는다(끈 것이 되살아나는 일을 막는다).
    if (marked && readReviveState(home).targets?.[role]?.state !== "stopped") throw new Error("표시가 저장되지 않았다");
  } catch (error) { fail(`자동 되살리기 멈춤 표시 실패: ${error.message} — 끄지 않았습니다`); }
  try {
    floor.stop(session);
  } catch (error) {
    if (marked) { try { unmarkStopped(home, role, marked); } catch { /* 표시를 못 되돌려도 오류는 알린다 */ } }
    fail(error.message);
  }
  try {
    const windowFields = floor.name === "tmux" ? closeStartedWindow(currentRottieWindow(readLedger(), session), {print:console.error}) : {};
    appendLedger({ ...buildStopLedgerEntry({ role, session }), ...windowFields });
    if (windowFields.rottieWindowClosed === false || windowFields.rottieWindowRemoved === false) {
      console.error(`세션은 종료됨: ${session} · 로티 탭 정리 미완료: ${windowFields.rottieTerminalId} — ${windowFields.rottieWindowError ?? windowFields.rottieRemoveError}`);
      process.exitCode = 1;
      return;
    }
    console.log(`종료됨: ${session}`);
  } finally { release(); }
}
