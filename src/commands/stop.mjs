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
  const session = sessionName(role);
  // 내부용: 자기 세션 종료를 넘겨받은 분리된 프로세스. 일반 stop보다 힘이 세지 않다 — 역할은 명령 인자에서, 세션·주인·PID는
  // 원장과 바닥에서 다시 정하고, 끄기는 stopRole의 같은 확인을 거친다(self-stop.mjs). 자기 세션 판정은 하지 않는다(고리 없음).
  if (flags["self-stop-tail"] !== undefined) {
    let body;
    try { body = JSON.parse(flags["self-stop-tail"]); } catch { die(STOP_USAGE); }
    const result = runSelfStopTail(body, { role, session, home });
    if (!result.ok || result.windowIncomplete) process.exitCode = 1;
    return;
  }
  const result = stopRole({ role, session, home, selfStop: createSelfStop(home) });
  // 세션을 끈 뒤의 예외(창 정리·원장 기록)는 예전처럼 그대로 올린다.
  if (result.error) throw result.error;
  if (!result.ok) die(result.message, result.code);
  if (result.windowIncomplete) process.exitCode = 1;
}
