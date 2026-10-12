// kadan restore (HW-3-impl: cli.mjs에서 옮김)
import { floor } from "../floor.mjs";
import { appendLedger, readLedger, resolveLedgerBy } from "../ledger.mjs";
import { removeRottieWindow, showRottieWindow, openWindow, tmux } from "../floor-tmux.mjs";
import { planRestore, runRestore } from "../restore.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import { requireWindowChoice, inspectRottieStartPreflight } from "../cli-start-support.mjs";

export function cmdRestore(argv, flags) {
  if (floor.name !== "tmux") die("restore는 tmux 바닥에서만 쓴다 — 로티 바닥은 데몬과 함께 에이전트도 끝난다", 2);
  const choice = requireWindowChoice();
  if (choice.kind !== "rottie") die(`restore는 KADAN_WINDOW=rottie에서만 쓴다 (지금 ${choice.kind})`, 2);
  const preflight = inspectRottieStartPreflight({ floorName: floor.name });
  if (!preflight.ok) die(preflight.message, 2);
  if (preflight.switched) console.error(`로티 경로 자동 교정: ${preflight.switched.from ?? "(없음)"} → ${preflight.switched.to} (켜진 로티 1개, 연결 확인)`);
  const bin = process.env.KADAN_ROTTIE_BIN;
  const plan = planRestore({
    sessions: floor.list(),
    entries: readLedger(),
    only: argv.length ? argv.map(sessionName) : null,
    show: (terminalId) => showRottieWindow({ bin, terminalId }),
  });
  if (plan.error) die(`${plan.error} — 아무것도 복구하지 않았다`);
  if (flags["dry-run"]) {
    for (const item of plan.items) {
      console.log(item.action === "restore"
        ? `복구 대상: ${item.session} (옛 탭 ${item.oldTerminalId} ${item.oldState})`
        : `건너뜀: ${item.session} — ${item.reason}`);
    }
    return;
  }
  const { failed } = runRestore({
    items: plan.items,
    open: (item) => openWindow(item.session, process.platform, {
      choice, role: item.role, cwd: item.cwd, panePid: item.pid, idempotencyKey: item.idempotencyKey,
    }),
    remove: (terminalId) => removeRottieWindow({ bin, terminalId }),
    record: (entry) => appendLedger({ ...entry, by: resolveLedgerBy({ env: process.env }) }),
    print: console.log,
  });
  if (failed) process.exitCode = 1;
}
