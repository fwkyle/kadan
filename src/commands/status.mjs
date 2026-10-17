// kadan status (HW-3-impl: cli.mjs에서 옮김)
import { floor } from "../floor.mjs";
import { SOCKET } from "../floor-tmux.mjs";
import { die, lastStartFor, recordedPid } from "../cli-basics.mjs";
import { startDisplay } from "../cli-family.mjs";

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
  for (const item of sessions) {
    const recorded = recordedPid(lastStartFor(item.session));
    const pidState = !recorded
      ? "기록없음"
      : recorded === item.pid
        ? "PID일치"
        : `PID변경(${recorded}→${item.pid})`;
    const shown = startDisplay(lastStartFor(item.session));
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
