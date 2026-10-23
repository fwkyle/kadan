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

// restartRole이 쓰는 실제 의존성. `kadan claude refresh --yes`도 같은 것을 쓴다(복제하지 않는다).
export function restartDeps(home) {
  const choice = requireWindowChoice();
  return {
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
}

// 계정 전환 재시작 표시는 `kadan claude refresh --yes --role`만 넘길 수 있다. 명령줄의 같은 이름 옵션은 버린다.
export function cliRestartFlags(flags) {
  const {accountRefresh, "account-refresh": dashed, accountSlot, "account-slot": dashedSlot, ...rest} = flags;
  return rest;
}

export function cmdRestart(argv, flags) {
  flags = cliRestartFlags(flags);
  const role = argv[0];
  if (!role) die("사용법: kadan restart <역할> [--force] [--reason <이유>] [--expect-pid <pane PID>]");
  if (floor.name !== "tmux") die("restart는 tmux 바닥에서만 쓴다", 2);
  // 화면(대시보드 '다시 띄우기')에서 온 값은 옵션 재해석을 막기 위해 인자가 아니라 환경변수로 들어온다(2026-10-15 2라운드).
  // 읽은 즉시 이 프로세스의 환경에서 지운다(3라운드): 지우지 않으면 마지막 역할 재시작 때 새 tmux 서버·새 역할 환경에
  // 남아 후속 CLI의 명시 옵션을 덮어쓴다(재검수 실측). 자식(tmux 서버·세션)을 만들기 전에 지워야 한다.
  const envReason = process.env.KADAN_RESTART_REASON, envExpectPid = process.env.KADAN_RESTART_EXPECT_PID;
  delete process.env.KADAN_RESTART_REASON;
  delete process.env.KADAN_RESTART_EXPECT_PID;
  // 명시 CLI 옵션이 환경 전달값보다 앞선다. 둘 다 있고 다르면 어느 쪽이 맞는지 모르는 채 진행하지 않고 거절한다.
  if (envReason !== undefined) {
    if (flags.reason !== undefined && flags.reason !== envReason)
      die("--reason과 KADAN_RESTART_REASON이 다르다 — 어느 쪽인지 확인하고 하나만 남긴다");
    flags = { ...flags, reason: envReason };
  }
  if (envExpectPid !== undefined) {
    if (flags["expect-pid"] !== undefined && String(flags["expect-pid"]) !== envExpectPid)
      die("--expect-pid와 KADAN_RESTART_EXPECT_PID가 다르다 — 어느 쪽인지 확인하고 하나만 남긴다");
    flags = { ...flags, "expect-pid": envExpectPid };
  }
  // 앞뒤 하이픈 등 정규화 전후가 다른 별칭은 같은 세션을 가리켜도 거절한다 — sessionName은 앞뒤 하이픈을 지우는데
  // 미해결 카드·원장 기록은 원래 문자열을 써서 보호가 갈라졌다(2026-10-15 검수). 세 곳이 같은 이름을 쓰게 정확한 이름만 받는다.
  const canonical = sessionName(role).slice("kadan-".length);
  if (canonical !== role) die(`역할 이름이 정확하지 않다('${role}'는 정규화하면 '${canonical}') — 정확한 이름으로 다시 실행한다`);
  if (flags.reason !== undefined && (typeof flags.reason !== "string" || !flags.reason.trim())) die("--reason에는 이유 글자가 필요하다(화면에서는 필수)");
  if (flags["expect-pid"] !== undefined && !/^\d+$/.test(String(flags["expect-pid"]))) die("--expect-pid는 pane PID 숫자다");
  const home = ledgerHome();
  const session = sessionName(role);
  const deps = restartDeps(home);
  let result;
  try { result = restartRole({ home, role, session, flags, floor, settings: readSettings(home), deps }); }
  catch (error) { die(error.message); }
  if (result.forced) console.error(`--force: 끝나지 않은 카드 ${result.pending.length}건을 두고 다시 띄웠다: ${result.pending.join(", ")}`);
  console.log(`다시 띄움: ${session} (${result.harness ?? "?"} ${result.model ?? "?"}, 대화 ${result.conversation ?? "?"}, pane PID ${result.panePid ?? "?"}, 창: ${result.window})`);
}
