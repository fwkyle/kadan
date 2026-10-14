// kadan init·up·adopt·autostart (HW-3-impl: cli.mjs에서 옮김)
import { runAdopt } from "../adopt.mjs";
import { runInit, runUp, ensureWatch, ensureBridge, BRIDGE_ROLE } from "../quickstart.mjs";
import { loadSecret } from "../secrets.mjs";
import { loadChatConfig, watchLockHolder } from "../discord-chat.mjs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { defaultProfilePath } from "../watch-profile.mjs";
import { readWatchProcesses } from "../watch-overview.mjs";
import { watchProcessName } from "../watch-system.mjs";
import { autostartCommand } from "../autostart.mjs";
import { floor } from "../floor.mjs";
import { ledgerHome } from "../ledger.mjs";
import { tmux } from "../floor-tmux.mjs";
import { die, sessionName, lastStartFor, recordedPid } from "../cli-basics.mjs";
import { guardedSend } from "../cli-guarded-send.mjs";
import { requireWindowChoice } from "../cli-start-support.mjs";
import { cmdStart } from "./start.mjs";
import { checkpointSecretary, resumeSecretary, withRecoveryLock } from "../secretary-resume.mjs";

export function cmdInit(_argv, flags) {
  if (flags.help) {
    console.log("사용법: kadan init [--runner codex|claude] [--no-skills]  (환경 확인 · 스킬 링크 · 실행기 선택, 처음 한 번)");
    return;
  }
  runInit({
    home: ledgerHome(),
    repoRoot: new URL("../..", import.meta.url).pathname,
    flags,
    floorName: floor.name,
  });
}

export function cmdUp(_argv, flags) {
  if (flags.help) {
    console.log("사용법: kadan up [--cmd <실행기 명령>] [--port 8790] [--hidden] [--no-prompt]  (비서 세션 + 대시보드 세션, 기본 감시 프로필이 있으면 감시기)");
    return;
  }
  if (floor.name === "tmux") requireWindowChoice();
  const result = runUp({
    home: ledgerHome(),
    flags,
    floor,
    sessionName,
    cliPath: new URL("../cli.mjs", import.meta.url).pathname,
    start: (argv, startFlags) => cmdStart(argv, startFlags),
    ...(floor.name === 'tmux' ? {
      restoreSecretary: startNew => resumeSecretary({home: ledgerHome(), floor, startNew}),
      startWatch: () => startWatchSession(ledgerHome()),
      startBridge: () => startBridgeSession(ledgerHome()),
    } : {}),
    send: ({ role, session, message, roleProfile }) => {
      const receipt=guardedSend({ floor, session, role, message, roleProfile, recordedPid: recordedPid(lastStartFor(session)) });
      console.log(`첫 지문 전송됨: ${session} (${receipt.bytes}B, 지문 ${receipt.digest}, 우편ID ${receipt.mailId}) — 입력 접수·AI 실행 미확인`);
    },
  });
  if (result.secretaryError) process.exitCode = 1;
  if (floor.name === 'tmux' && result.secretary !== 'blocked') {
    try {
      withRecoveryLock(ledgerHome(), 'kadan-비서', () => {
        for (let attempt = 0; ; attempt++) {
          try { return checkpointSecretary({home: ledgerHome(), floor}); }
          catch (error) {
            if (attempt >= 7) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
          }
        }
      });
    } catch (error) {
      console.error(`비서 대화 복원 정보 저장 확인 필요: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

// 감시기는 역할이 아니라 원장 기록 없이 tmux 세션 kadan-watch에서 돈다(사람이 띄우던 방식 그대로).
function startWatchSession(home) {
  const session = sessionName("watch");
  const node = process.execPath, cli = new URL("../cli.mjs", import.meta.url).pathname;
  const env = ["-e", `KADAN_HOME=${home}`, ...(process.env.KADAN_SOCKET ? ["-e", `KADAN_SOCKET=${process.env.KADAN_SOCKET}`] : [])];
  return ensureWatch({
    profileExists: () => fs.existsSync(defaultProfilePath(home)),
    running: () => readWatchProcesses(spawnSync, watchProcessName(home)),
    alive: () => floor.alive(session),
    create: () => {
      const result = tmux(["new-session", "-d", "-s", session, "-c", new URL("../..", import.meta.url).pathname, ...env, `'${node}' '${cli}' watch`]);
      if (result.status !== 0) throw new Error((result.stderr || "tmux new-session 실패").trim());
    },
  });
}

// 디코 다리도 감시기처럼 원장 start 기록 없이 tmux 세션 kadan-디코에서 돈다. 환경은 경로·시험용 값만 넘긴다(비밀값은 파일에서 읽는다).
const BRIDGE_ENV = ["KADAN_SOCKET", "KADAN_NOTIFY", "KADAN_DISCORD_API_BASE", "KADAN_SECRET_DISCORD_FILE", "KADAN_SECRET_DISCORD_BOT_FILE"];
function startBridgeSession(home) {
  const session = sessionName(BRIDGE_ROLE);
  const node = process.execPath, cli = new URL("../cli.mjs", import.meta.url).pathname;
  const env = ["-e", `KADAN_HOME=${home}`, ...BRIDGE_ENV.filter((k) => process.env[k]).flatMap((k) => ["-e", `${k}=${process.env[k]}`])];
  return ensureBridge({
    configured: () => {
      const bot = loadSecret(process.env, home, "discord-bot");
      if (!bot.values && bot.source !== "broken" && !bot.error) return "no-secret";
      try { loadChatConfig(process.env, home); return "ok"; } catch (error) { return `bad-config: ${error.message}`; }
    },
    lockHolder: () => watchLockHolder(home),
    alive: () => floor.alive(session),
    create: () => {
      const result = tmux(["new-session", "-d", "-s", session, "-c", new URL("../..", import.meta.url).pathname, ...env,
        `'${node}' '${cli}' discord watch --to-mail`]);
      if (result.status !== 0) throw new Error((result.stderr || "tmux new-session 실패").trim());
    },
  });
}

// 앱·터미널에서 이야기하던 AI 대화를 복제해 카단 감독 세션으로 이어 연다(2026-10-06 [kyle]).
export function cmdAdopt(argv, flags) {
  if (floor.name === "tmux" && !flags.hidden) requireWindowChoice();
  try {
    runAdopt({
      role: argv[0], flags, floor, sessionName,
      start: (startArgv, startFlags) => cmdStart(startArgv, startFlags),
      send: ({ role, session, message, roleProfile }) => {
        const receipt=guardedSend({ floor, session, role, message, roleProfile, recordedPid: recordedPid(lastStartFor(session)) });
        console.log(`첫 안내 전송됨: ${session} (${receipt.bytes}B, 지문 ${receipt.digest}, 우편ID ${receipt.mailId}) — 입력 접수·AI 실행 미확인`);
      },
    });
  } catch (error) { die(error.message, 2); }
}

// 로그인할 때 `kadan up --hidden`을 창 없이 한 번 실행하는 macOS LaunchAgent(2026-10-06 [kyle]). 되살리기(KeepAlive)는 없다.
export function cmdAutostart(argv) {
  if (process.platform !== "darwin") die("autostart는 macOS LaunchAgent용이다");
  try {
    const result = autostartCommand(argv[0], { home: ledgerHome(), cli: new URL("../cli.mjs", import.meta.url).pathname });
    if (argv[0] === "show") { console.log(`# ${result.file} (${result.installed ? "설치돼 있음" : "아직 없음"})`); console.log(result.content); return; }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { die(error.message, 2); }
}
