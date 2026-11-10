// kadan stop (HW-3-impl: cli.mjs에서 옮김). 본체는 ../role-stop.mjs — 여기는 인자·출력·종료 코드만 맡는다.
import { ledgerHome } from "../ledger.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import { stopRole } from "../role-stop.mjs";

export const STOP_USAGE = "사용법: kadan stop <역할>";

export function cmdStop(argv) {
  const role = argv[0];
  if (!role) die(STOP_USAGE);
  const result = stopRole({ role, session: sessionName(role), home: ledgerHome() });
  // 세션을 끈 뒤의 예외(창 정리·원장 기록)는 예전처럼 그대로 올린다.
  if (result.error) throw result.error;
  if (!result.ok) die(result.message, result.code);
  if (result.windowIncomplete) process.exitCode = 1;
}
