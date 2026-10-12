// kadan read·log·attach (HW-3-impl: cli.mjs에서 옮김)
import { watchAILabel } from "../watch-report.mjs";
import { floor } from "../floor.mjs";
import { ledgerBy, readLedger } from "../ledger.mjs";
import { openWindow } from "../floor-tmux.mjs";
import { die, sessionName, stripAnsi, tailLines, normalizeFloorRead } from "../cli-basics.mjs";
import { requireWindowChoice } from "../cli-start-support.mjs";

export function cmdRead(argv, flags) {
  const role = argv[0];
  if (!role) die("사용법: kadan read <역할> [--lines N]");
  const session = sessionName(role);
  if (!floor.alive(session)) die(`세션 없음: ${session}`);
  const lines = Number(flags.lines ?? 30);
  if (!Number.isInteger(lines) || lines < 1) {
    die("--lines는 1 이상의 정수여야 한다");
  }
  const output = tailLines(
    stripAnsi(normalizeFloorRead(floor.read(session)).text),
    lines
  );
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

export function renderLogEntry(entry) {
  const subject =
    entry.kind === "done"
      ? entry.role ?? entry.session ?? entry.broken ?? ""
      : `${ledgerBy(entry)} → ${entry.role ?? entry.session ?? entry.broken ?? ""}`;
  const extra =
    entry.kind === "send"
      ? `${entry.taskId ?? "(카드 없음)"}  지문=${entry.digest} ${entry.bytes}B`
      : entry.kind === "done"
        ? `taskId=${entry.taskId} ${entry.result}`
        : entry.kind === "start"
          ? `PID=${entry.panePid ?? entry.rottiePid ?? "?"} 창=${entry.window}`
          : entry.kind === "window"
            ? `탭=${entry.rottieTerminalId} (옛 탭 ${entry.restoredFrom} ${entry.oldState})`
          : entry.kind.startsWith('watch-ai-')
            ? `${watchAILabel(entry.source)} ${entry.verdict ?? entry.reason ?? entry.delivery ?? ''}`
            : "";
  return `${entry.t ?? "???"}  ${entry.kind.padEnd(5)}  ${subject}  ${extra}`;
}

export function cmdLog() {
  for (const entry of readLedger().slice(-30)) {
    console.log(renderLogEntry(entry));
  }
}

export function cmdAttach(argv) {
  const role = argv[0];
  if (!role) die("사용법: kadan attach <역할>");
  const session = sessionName(role);
  if (!floor.alive(session)) die(`세션 없음: ${session}`);
  if (["rottie", "herdr"].includes(floor.name)) {
    console.log(floor.attach(session));
    return;
  }
  const windowChoice = requireWindowChoice();
  if (process.platform !== "darwin") {
    console.log(`macOS가 아니어서 창을 열지 않는다 — 직접: ${floor.attach(session)}`);
    return;
  }
  const window = openWindow(session, process.platform, {
    choice: windowChoice,
    role,
    panePid: floor.pid(session),
  });
  const name = window ? window.method : null;
  if (!name) console.log(`창 열기 실패 — 직접: ${floor.attach(session)}`);
  else console.log(`창 열림(${name}): ${session}`);
}
