// kadan restart — 실행기 프로그램만 다시 띄우고 대화 기억은 유지한다(2026-10-14 [kyle]). 본체는 ../restart.mjs.
import fs from "node:fs";
import { taskIdentity } from "../task-identity.mjs";
import { CardStore } from "../card-store.mjs";
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome, readLedger } from "../ledger.mjs";
import { tmux } from "../floor-tmux.mjs";
import { currentRottieWindow } from "../restore.mjs";
import { readSettings } from "../runner-settings.mjs";
import { restartRole, MODEL_FROM_SETTINGS } from "../restart.mjs";
import { readStatusLine } from "../watch-status-line.mjs";
import { processTree, openFilesOf, processStartedAt } from "../process-tree.mjs";
import { die, sessionName } from "../cli-basics.mjs";
import { cmdRestartInfra } from "./infra-restart.mjs";
import { INFRA_RESTART_TARGETS } from "../infra-restart.mjs";
import { pendingCardsFor, closeStartedWindow, openStartedWindow, requireWindowChoice } from "../cli-start-support.mjs";

// 이 세션의 pane PID와 tmux 자리(`세션:@창.%자리`). claude의 세션 파일 tmux 필드와 같은 모양이다.
// timeout(ms)은 kadan stop의 대화 조회만 넘긴다(남은 예산). restart는 넘기지 않아 예전과 같다.
export function paneInfo(session, { timeout } = {}) {
  const result = tmux(["-N", "list-panes", "-s", "-t", `=${session}:`, "-F", "#{pane_pid}\t#{session_name}:#{window_id}.#{pane_id}"],
    undefined, timeout ? { timeout } : {});
  const lines = result.status === 0 ? result.stdout.trim().split("\n") : [];
  if (lines.length !== 1 || !lines[0]) throw new Error("tmux pane을 하나로 확인하지 못했다");
  const [panePid, location] = lines[0].split("\t");
  return { panePid, location };
}

// restart가 끄기 바로 앞에서 부른다: 화면을 다시 읽어 idle이고, 사람이 최근 입력하지 않았을 때만 통과한다.
// 하나라도 아니면 던져서 끄지 않는다. 모든 restart가 끄기 직전에 부른다(--force만 건너뜀).
export function confirmIdleBeforeStop(session, base = floor) {
  const screen = base.read(session);
  if (typeof screen !== "string") throw new Error("판정 불가: 화면을 읽지 못함");
  const kind = readStatusLine(screen).kind;
  if (kind === "working") throw new Error("working: 응답 생성 중");
  if (kind !== "idle") throw new Error("판정 불가: 입력 대기 화면이 아님");
  if (typeof base.assertHumanIdle !== "function") throw new Error("판정 불가: 사람 입력 확인 불가");
  try { base.assertHumanIdle(session); }
  catch (error) { throw new Error(error?.code === "KADAN_HUMAN_ACTIVE" ? "입력 중: 사람이 최근 입력함" : `판정 불가: ${error?.message ?? error}`); }
}

// restartRole이 쓰는 실제 의존성. `kadan claude refresh --yes`도 같은 것을 쓴다(복제하지 않는다).
// windowDeps는 시험용 주입(가짜 창 실행기 spawnFn 등)이다. 동작은 바꾸지 않는다.
export function restartDeps(home, { env = process.env, windowDeps = {} } = {}) {
  const choice = requireWindowChoice(env);
  return {
    read: () => readLedger(home),
    record: entry => appendLedger(entry, home),
    pendingCards: (entries, who) => pendingCardsFor(taskIdentity(new CardStore(home).listSummaries()).project(entries), who),
    closeWindow: (entries, name) => floor.name === "tmux" ? closeStartedWindow(currentRottieWindow(entries, name), { print: console.error }) : {},
    openWindow: ({ session: name, role: who, cwd, panePid }) =>
      process.platform === "darwin" ? openStartedWindow(name, process.platform, { ...windowDeps, choice, role: who, cwd, panePid }) : { method: "manual" },
    beforeStop: session => confirmIdleBeforeStop(session),
    paneInfo,
    processTree,
    processStartedAt,
    openFiles: openFilesOf,
    readJson: file => JSON.parse(fs.readFileSync(file, "utf8")),
  };
}

// 계정 전환 재시작 표시는 `kadan claude refresh --yes --role`만 넘길 수 있다. 명령줄의 같은 이름 옵션은 버린다.
export function cliRestartFlags(flags) {
  const {accountRefresh, "account-refresh": dashed, accountSlot, "account-slot": dashedSlot, ...rest} = flags;
  return rest;
}

export const RESTART_USAGE = "사용법: kadan restart <역할> [--force] [--reason <이유>] [--expect-pid <pane PID>] [--model-from-settings]\n" +
  "       kadan restart watch|대시보드  (감시기·대시보드를 끄고 같은 명령 안에서 다시 띄운 뒤 살아났는지 확인. 옵션 없음, Autopilot 중 역할 세션에서도 가능)\n" +
  "  --model-from-settings: 원래 모델 대신 지금 실행 모델 설정(그 역할 프로필의 활성 프리셋)의 모델·강도로, 같은 대화를 이어 연다(다른 옵션은 그대로)";
// 값을 받지 않는 restart 전용 옵션(뒤 낱말을 값으로 먹지 않게 한다).
export const RESTART_BOOLEANS = [MODEL_FROM_SETTINGS];

export function cmdRestart(argv, flags) {
  flags = cliRestartFlags(flags);
  const role = argv[0];
  if (!role) die(RESTART_USAGE);
  // 화면 '다시 띄우기'가 넘기는 환경값(KADAN_RESTART_*)이 있는 감시기·대시보드 호출은 끄기 전에 거절한다(대시보드가 자기 자신을 끄는 길 차단, 세대 대조·이유를 버리지 않는다).
  if (INFRA_RESTART_TARGETS.includes(role) && (process.env.KADAN_RESTART_REASON !== undefined || process.env.KADAN_RESTART_EXPECT_PID !== undefined))
    die(`화면에서는 감시기·대시보드를 다시 띄울 수 없습니다 — 터미널에서 \`kadan restart ${role}\`를 치세요(옵션 없이)`, 2);
  // 역할 말고 낱말이 더 있으면(값 없는 옵션에 붙인 값 포함) 어느 것이 역할인지 추측하지 않는다 — 역할 선택·세션 조회 전에 끝낸다.
  if (argv.length > 1) die(`역할은 하나만 받는다(받은 낱말: ${argv.join(" ")})\n${RESTART_USAGE}`);
  if (floor.name !== "tmux") die("restart는 tmux 바닥에서만 쓴다", 2);
  // 기반 프로세스 중 감시기·대시보드만: 끄고 같은 명령 안에서 다시 띄운다(AI 역할 restart와 다른 길, 비서는 그대로 AI 역할 길).
  if (INFRA_RESTART_TARGETS.includes(role)) return cmdRestartInfra(role, flags);
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
  if (flags[MODEL_FROM_SETTINGS] !== undefined && flags[MODEL_FROM_SETTINGS] !== true) die(`--${MODEL_FROM_SETTINGS}는 값을 받지 않는다`);
  const home = ledgerHome();
  const session = sessionName(role);
  const deps = restartDeps(home);
  let result;
  try { result = restartRole({ home, role, session, flags, floor, settings: readSettings(home), deps }); }
  catch (error) { die(error.message); }
  if (result.pending.length) console.error(`${result.forced ? "--force: 안전 지점 확인 없이, " : ""}끝나지 않은 카드 ${result.pending.length}건은 그대로 이어진다: ${result.pending.join(", ")}`);
  const swap = result.modelFromSettings;
  if (swap) {
    const shown = (model, effort) => `${model} · ${effort ?? "강도 없음"}`;
    const basis = `설정 revision ${swap.revision}, 프리셋 ${swap.preset}`;
    console.log(swap.changed
      ? `설정 반영: ${shown(swap.previousModel, swap.previousEffort)} → ${shown(swap.model, swap.effort)} (${basis})`
      : `설정과 같음: 바뀐 것 없음 — ${shown(swap.model, swap.effort)} (${basis})`);
  }
  console.log(`다시 띄움: ${session} (${result.harness ?? "?"} ${result.model ?? "?"}, 대화 ${result.conversation ?? "?"}, pane PID ${result.panePid ?? "?"}, 창: ${result.window})`);
}
