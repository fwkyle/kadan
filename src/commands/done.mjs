// kadan done (HW-3-impl: cli.mjs에서 옮김)
import { CardStore } from "../card-store.mjs";
import { closeCardAfterDone } from "../card-command.mjs";
import { floor } from "../floor.mjs";
import { ledgerHome, readLedger } from "../ledger.mjs";
import { die, sessionName, normalizeFloorRead } from "../cli-basics.mjs";
import { confirmDone, waitScreenDone } from "../cli-wait-done.mjs";
import { WorkStore } from "../work-store.mjs";
import { refreshWorkStatus } from "../user-notify.mjs";

// 이 실행이 속한 업무 글의 상태 메시지를 맞춘다(사건 지점 1곳). 업무가 없거나 디코 설정이 없으면 아무것도 안 한다.
export function refreshWorkOfExecution(executionKey) {
  if (typeof executionKey !== "string") return;
  try {
    const home = ledgerHome();
    const work = new WorkStore(home).list().find(w => w.executions.some(x => x.key === executionKey));
    if (work) refreshWorkStatus(home, work.key);
  } catch { /* 상태 메시지 맞추기가 완료 확정을 막지 않는다 */ }
}

export function cmdDone(argv, flags = {}) {
  const [role, taskId, given, ...extra] = argv;
  const closeCard = flags["close-card"] === true, fromScreen = flags["from-screen"] === true;
  const waitSec = flags.wait === undefined ? 0 : Number(flags.wait);
  if (!role || !taskId || (fromScreen ? given : !given) || extra.length > 0 || (flags.note !== undefined && (!closeCard || typeof flags.note !== "string"))
    || (flags.wait !== undefined && (!fromScreen || !Number.isFinite(waitSec) || waitSec < 0 || waitSec > 600))) {
    die("사용법: kadan done <역할> <카드id> <ok|failed> | --from-screen [--wait <초, 최대 600>] [--close-card [--note <이유>]]", 2);
  }
  let result = given, via = null;
  if (fromScreen) {
    // 기록·전송 없이 화면만 읽는다. 표시가 없으면 실패로 닫고, 재출력 요청은 부르는 쪽이 판단한다.
    const session = sessionName(role);
    if (!floor.alive(session)) die(`세션 없음: ${session}`, 2);
    const entries = readLedger();
    const found = waitScreenDone({
      readScreen: () => normalizeFloorRead(floor.read(session)).text,
      entries, role, taskId, cards: new CardStore(ledgerHome()).listSummaries(), hookHome: ledgerHome(), waitMs: waitSec * 1000,
    });
    if (!found.result) die(`화면 완료 표시 없음: 역할=${role} 카드=${taskId}${found.dispatch ? "" : " (발령 기록 없음 — 화면 전체를 봄)"}${waitSec ? ` (${waitSec}초 대기, 화면 ${found.reads}회 확인)` : ""}`, 3);
    result = found.result;
    via = found.via ?? "screen";
  }
  if (closeCard && result !== "ok") {
    die("--close-card는 ok 완료에만 쓴다 — failed 실행은 카드를 닫지 않는다", 2);
  }
  const entry = confirmDone({
    entries: readLedger(),
    role,
    taskId,
    result,
    via,
  });
  console.log(
    `완료 확정: 역할=${entry.role} 카드=${entry.taskId} 결과=${entry.result} 확인=${entry.by}`
  );
  if (!closeCard) return refreshWorkOfExecution(entry.executionKey);
  try {
    const closed = closeCardAfterDone(entry.executionKey, { home: ledgerHome(), by: entry.by, note: flags.note });
    console.log(closed.state === "already"
      ? `카드 닫기: 이미 완료 상태라 기록하지 않음 — 카드=${closed.key} revision=${closed.revision}`
      : `카드 닫기: 카드=${closed.key} 상태=done revision=${closed.revision}`);
  } catch (error) {
    console.error(`카드 닫기 실패: ${error.message} — 실행 완료 확정은 그대로 저장됨`);
    process.exitCode = 1;
  }
  refreshWorkOfExecution(entry.executionKey);
}
