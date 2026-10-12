// kadan wait (HW-3-impl: cli.mjs에서 옮김)
import { floor } from "../floor.mjs";
import { ledgerHome, readLedger } from "../ledger.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import { runWaitLoop } from "../cli-wait-done.mjs";

export function cmdWait(argv, flags) {
  const role = argv[0];
  if (!role) {
    die("사용법: kadan wait <역할> [--timeout 초] [--quiet 초] [--interval 초]");
  }
  const session = sessionName(role);
  if (!floor.alive(session)) die(`세션 없음: ${session}`);
  const interval = (Number(flags.interval) || 2) * 1000;
  const timeout = (Number(flags.timeout) || 600) * 1000;
  const quietMs = (Number(flags.quiet) || 120) * 1000;

  const lastSend = readLedger()
    .filter((entry) => entry.kind === "send" && entry.session === session)
    .at(-1);
  let result;
  try {
    result = runWaitLoop({
      floor,
      session,
      role,
      intervalMs: interval,
      timeoutMs: timeout,
      quietMs,
      since: lastSend?.outputCursor,
      baselineMarkers: lastSend?.baselineMarkers,
      snapshotHome: ledgerHome(),
    });
  } catch (error) {
    die(error.message, error.exitCode || 1);
  }
  if (result.code === 0) {
    for (const marker of result.markers) {
      console.log(`완료 마커: taskId=${marker.taskId} 결과=${marker.result}`);
    }
  } else if (result.reason === "gap") {
    console.log(
      `출력 누락 보고: ${result.gap.from}→${result.gap.to}, 마커를 놓쳤을 수 있음 — 사람 확인 필요`
    );
  } else if (result.reason === "quiet") {
    console.log(
      `정지 보고: ${Math.round(quietMs / 1000)}초간 출력 없음, 마커 없음 — 사람 확인 필요`
    );
  } else {
    console.log("제한 시간 도달: 아직 진행 중일 수 있음");
  }
  process.exit(result.code);
}
