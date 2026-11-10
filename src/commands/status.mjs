// kadan status (HW-3-impl: cli.mjs에서 옮김)
import { floor } from "../floor.mjs";
import { SOCKET } from "../floor-tmux.mjs";
import { die, lastStartFor, recordedPid } from "../cli-basics.mjs";
import { startDisplay } from "../cli-family.mjs";
import { readRecoveryLedger } from "../ledger.mjs";

export function cmdStatus() {
  let sessions;
  try {
    sessions = floor.list();
  } catch (error) {
    die(error.message, error.exitCode || 1);
  }
  if (sessions.length === 0) {
    console.log(`카단 구획(${SOCKET})에 세션 없음`);
    return;
  }
  // 원장은 세션 수와 상관없이 한 번만, start·stop·window만 읽는다(세션마다 전체를 두 번 읽어 38개에 76번이었다).
  // 원장이 10배면: 읽기는 여전히 1회지만 색인이 없어 시스템 영역의 모든 행을 한 번씩 본다(시간이 행 수에 비례).
  // 좁은 읽기라 전체 읽기가 잡던 원장 손상(순번·연결)은 여기서 보고하지 않는다.
  const entries = readRecoveryLedger();
  for (const item of sessions) {
    const start = lastStartFor(item.session, entries);
    const recorded = recordedPid(start);
    const pidState = !recorded
      ? "기록없음"
      : recorded === item.pid
        ? "PID일치"
        : `PID변경(${recorded}→${item.pid})`;
    const shown = startDisplay(start);
    const modelBit = `  ${shown.harness} · ${shown.model} · ${shown.family}`;
    if (floor.name === "herdr") {
      console.log(
        `${item.session}  herdr=${item.terminalId}  상태=${item.state}  ${pidState}${modelBit}`
      );
    } else {
      console.log(
        `${item.session}  ${Number(item.attached) ? "창붙음" : "백그라운드"}  시작=${new Date(
          item.created * 1000
        ).toISOString()}  ${pidState}${modelBit}`
      );
    }
  }
}
