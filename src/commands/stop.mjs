// kadan stop (HW-3-impl: cli.mjs에서 옮김). 본체는 ../role-stop.mjs — 여기는 인자·출력·종료 코드만 맡는다.
import { ledgerHome } from "../ledger.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import { stopRole } from "../role-stop.mjs";
import { createSelfStop, runSelfStopTail } from "../self-stop.mjs";

export const STOP_USAGE = "사용법: kadan stop <역할>";

export function cmdStop(argv, flags = {}) {
  const role = argv[0];
  if (!role) die(STOP_USAGE);
  const home = ledgerHome();
  // 내부용: 자기 세션 종료를 넘겨받은 분리된 프로세스. 자기 세션 판정을 하지 않는다(다시 넘기는 고리가 없다).
  if (typeof flags["self-stop-tail"] === "string") {
    const result = runSelfStopTail(JSON.parse(flags["self-stop-tail"]), { home });
    if (!result.ok || result.windowIncomplete) process.exitCode = 1;
    return;
  }
  const result = stopRole({ role, session: sessionName(role), home, selfStop: createSelfStop(home) });
  // 세션을 끈 뒤의 예외(창 정리·원장 기록)는 예전처럼 그대로 올린다.
  if (result.error) throw result.error;
  if (!result.ok) die(result.message, result.code);
  if (result.windowIncomplete) process.exitCode = 1;
}
