// kadan stop (HW-3-impl: cli.mjs에서 옮김)
import { taskIdentity } from "../task-identity.mjs";
import { CardStore } from "../card-store.mjs";
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome, readLedger } from "../ledger.mjs";
import { tmux } from "../floor-tmux.mjs";
import { currentRottieWindow } from "../restore.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import {
  pendingCardsFor,
  buildStopLedgerEntry,
  closeStartedWindow,
} from "../cli-start-support.mjs";

export function cmdStop(argv) {
  const role = argv[0];
  if (!role) die("사용법: kadan stop <역할>");
  const session = sessionName(role);
  if (!floor.alive(session)) die(`세션 없음: ${session}`);
  const pending = pendingCardsFor(taskIdentity(new CardStore(ledgerHome()).listSummaries()).project(readLedger()), role);
  if (pending.length > 0) {
    console.log(
      `미확정 카드 ${pending.length}건: ${pending.join(", ")} — 종료하면 화면이 사라진다. 확인했으면 kadan done ${role} <카드id> <ok|failed>`
    );
  }
  try {
    floor.stop(session);
  } catch (error) {
    die(error.message);
  }
  const windowFields = floor.name === "tmux" ? closeStartedWindow(currentRottieWindow(readLedger(), session), {print:console.error}) : {};
  appendLedger({ ...buildStopLedgerEntry({ role, session }), ...windowFields });
  if (windowFields.rottieWindowClosed === false || windowFields.rottieWindowRemoved === false) {
    console.error(`세션은 종료됨: ${session} · 로티 탭 정리 미완료: ${windowFields.rottieTerminalId} — ${windowFields.rottieWindowError ?? windowFields.rottieRemoveError}`);
    process.exitCode = 1;
    return;
  }
  console.log(`종료됨: ${session}`);
}
