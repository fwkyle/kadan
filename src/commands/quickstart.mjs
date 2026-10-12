// kadan init·up·adopt·autostart (HW-3-impl: cli.mjs에서 옮김)
import { runAdopt } from "../adopt.mjs";
import { runInit, runUp } from "../quickstart.mjs";
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
    console.log("사용법: kadan up [--cmd <실행기 명령>] [--port 8790] [--hidden] [--no-prompt]  (비서 세션 + 대시보드 세션)");
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
