// kadan read·log·attach (HW-3-impl: cli.mjs에서 옮김)
import { watchAILabel } from "../watch-report.mjs";
import { floor } from "../floor.mjs";
import { ledgerBy, readLedger, appendLedger, ledgerHome } from "../ledger.mjs";
import {withRecoveryLock} from "../secretary-resume.mjs";
import { openWindow } from "../floor-tmux.mjs";
import path from "node:path";
import { die, digest, lastStartFor, sessionName, stripAnsi, tailLines, normalizeFloorRead } from "../cli-basics.mjs";
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
    stripAnsi(normalizeFloorRead((floor.readView ?? floor.read).call(floor, session)).text),
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
  if (floor.name === "herdr") {
    console.log(floor.attach(session));
    return;
  }
  const windowChoice = requireWindowChoice();
  if (process.platform !== "darwin") {
    console.log(`macOS가 아니어서 창을 열지 않는다 — 직접: ${floor.attach(session)}`);
    return;
  }
  const cwd = attachWindowCwd(lastStartFor(session));
  const window = withRecoveryLock(ledgerHome(), session, () => {
    const pid = floor.pid(session);
    const result = openWindow(session, process.platform, {
      choice: windowChoice, role, cwd, panePid: pid,
      conflictKeySuffix: `attach-${digest(cwd)}`,
    });
    if (result?.rottieTerminalId && String(lastStartFor(session)?.panePid) === String(pid)
      && String(floor.pid(session)) === String(pid)) {
      appendLedger({kind: 'window', role, session, cwd, panePid: pid,
        rottieTerminalId: result.rottieTerminalId});
    }
    return result;
  });
  const name = window ? window.method : null;
  if (!name) console.log(`창 열기 실패 — 직접: ${floor.attach(session)}`);
  else console.log(`창 열림(${name}): ${session}`);
}

// 창(로티 탭)은 역할이 시작한 폴더로 연다. 붙이는 사람의 현재 폴더로 열면 다른 프로젝트 밑에 묶인다.
export function attachWindowCwd(start, fallback = process.cwd()) {
  const cwd = start?.cwd;
  return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : fallback;
}
