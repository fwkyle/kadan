// kadan restart — 실행기 프로그램만 다시 띄우고 대화 기억은 유지한다(2026-10-14 [kyle]). 본체는 ../restart.mjs.
import fs from "node:fs";
import { taskIdentity } from "../task-identity.mjs";
import { CardStore } from "../card-store.mjs";
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome, readLedger } from "../ledger.mjs";
import { tmux } from "../floor-tmux.mjs";
import { currentRottieWindow } from "../restore.mjs";
import { readSettings } from "../runner-settings.mjs";
import { restartRole } from "../restart.mjs";
import { processTree, openFilesOf } from "../process-tree.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import { pendingCardsFor, closeStartedWindow, openStartedWindow, requireWindowChoice } from "../cli-start-support.mjs";

// 이 세션의 pane PID와 tmux 자리(`세션:@창.%자리`). claude의 세션 파일 tmux 필드와 같은 모양이다.
function paneInfo(session) {
  const result = tmux(["-N", "list-panes", "-s", "-t", `=${session}:`, "-F", "#{pane_pid}\t#{session_name}:#{window_id}.#{pane_id}"]);
  const lines = result.status === 0 ? result.stdout.trim().split("\n") : [];
  if (lines.length !== 1 || !lines[0]) throw new Error("tmux pane을 하나로 확인하지 못했다");
  const [panePid, location] = lines[0].split("\t");
  return { panePid, location };
}

export function cmdRestart(argv, flags) {
  const role = argv[0];
  if (!role) die("사용법: kadan restart <역할> [--force]");
  if (floor.name !== "tmux") die("restart는 tmux 바닥에서만 쓴다", 2);
  const home = ledgerHome();
  const session = sessionName(role);
  const choice = requireWindowChoice();
  const deps = {
    read: () => readLedger(home),
    record: entry => appendLedger(entry, home),
    pendingCards: (entries, who) => pendingCardsFor(taskIdentity(new CardStore(home).listSummaries()).project(entries), who),
    closeWindow: (entries, name) => floor.name === "tmux" ? closeStartedWindow(currentRottieWindow(entries, name), { print: console.error }) : {},
    openWindow: ({ session: name, role: who, panePid }) =>
      process.platform === "darwin" ? openStartedWindow(name, process.platform, { choice, role: who, panePid }) : { method: "manual" },
    paneInfo,
    processTree,
    openFiles: openFilesOf,
    readJson: file => JSON.parse(fs.readFileSync(file, "utf8")),
  };
  let result;
  try { result = restartRole({ home, role, session, flags, floor, settings: readSettings(home), deps }); }
  catch (error) { die(error.message); }
  if (result.forced) console.error(`--force: 끝나지 않은 카드 ${result.pending.length}건을 두고 다시 띄웠다: ${result.pending.join(", ")}`);
  console.log(`다시 띄움: ${session} (${result.harness ?? "?"} ${result.model ?? "?"}, 대화 ${result.conversation ?? "?"}, pane PID ${result.panePid ?? "?"}, 창: ${result.window})`);
}
