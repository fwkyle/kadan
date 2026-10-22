// kadan init·up·adopt·autostart (HW-3-impl: cli.mjs에서 옮김)
import { ADOPT_USAGE, runAdopt } from "../adopt.mjs";
import { runInit, runUp, ensureWatch, ensureBridge, bridgeStatus, BRIDGE_ROLE } from "../quickstart.mjs";
import { loadSecret } from "../secrets.mjs";
import { loadChatConfig, watchLockInfo } from "../discord-chat.mjs";
import {conversationFile, readConversationPermissions} from '../adopt-permissions.mjs';
import {captureSource, sourceAgent, checkLaunchPermissions} from '../adopt-process.mjs';
import {prepareTransfer, acceptTransfer, transferStatus} from '../adopt-transfer.mjs';
import {notifyAdoption} from '../adopt-notice.mjs';
import {startAdoptMonitor} from '../adopt-monitor.mjs';
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { defaultProfilePath } from "../watch-profile.mjs";
import { readWatchProcesses } from "../watch-overview.mjs";
import { watchProcessName } from "../watch-system.mjs";
import { autostartCommand, describeStale } from "../autostart.mjs";
import { floor } from "../floor.mjs";
import { notifyUser } from "../user-notify.mjs";
import { readBridgeExit } from "../discord-bridge-exit.mjs";
import { acquireReviveLock, lockWaitMs, reclaimLog, changedOutput, clearForUp, finishRevive, prepareRevive } from "../revive.mjs";
import { appendLedger, ledgerHome } from "../ledger.mjs";
import { tmux, paneState, captureTail } from "../floor-tmux.mjs";
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
    console.log("사용법: kadan up [--cmd <실행기 명령>] [--port 8790] [--hidden] [--no-prompt] [--auto]  (비서 세션 + 대시보드 세션, 기본 감시 프로필이 있으면 감시기, 디코 비밀값이 있으면 다리)");
    console.log("  --auto: launchd가 1분마다 부르는 자동 실행. 사람이 kadan stop으로 끈 대상·1시간 3번 상한에 걸린 대상은 건너뛰고, 바뀐 것이 있을 때만 출력한다. --auto 없이 친 up은 그 멈춤을 모두 푼다");
    return;
  }
  const home = ledgerHome();
  const auto = flags.auto === true;
  if (auto && floor.name !== "tmux") die("--auto는 tmux 바닥에서만 쓴다", 2);
  if (floor.name === "tmux") requireWindowChoice();
  // 자동 실행과 손으로 친 up이 겹치지 않게 한다. 자동은 이번 회차를 건너뛰고, 사람은 잠시 기다린다.
  const release = floor.name === "tmux" ? acquireReviveLock(home, { waitMs: auto ? 0 : lockWaitMs(), onReclaim: reclaimLog }) : () => {};
  if (!release) {
    if (auto) return;
    die("다른 kadan up이 돌고 있습니다(자동 실행일 수 있음). 잠시 뒤 다시 치세요", 1);
  }
  try { runUpOnce({ home, flags, auto }); } finally { release(); }
}

// 되살리기 보조: 어떤 세션이 어떤 상태인지 묻고, 죽은 창을 치우고, 원장·알림을 남긴다.
function reviveOps(home) {
  const sessionOf = (target) => sessionName(target);
  return {
    sessionOf,
    exists: (session) => floor.alive(session),
    paneState: (session) => paneState(session),
    capture: (session, lines) => captureTail(session, lines),
    kill: (session) => floor.stop(session),
    applicable: (target) => {
      if (target === "watch") return fs.existsSync(defaultProfilePath(home));
      if (target === BRIDGE_ROLE) return bridgeDeps(home).configured() === "ok";
      return true;
    },
    // 살아 있는 창인데 일을 못 하는 진짜 막힘이면 이유, 아니면 null. 이런 창은 건드리지 않는다.
    stuck: (target) => {
      if (target === "watch") return readWatchProcesses(spawnSync, watchProcessName(home)).length ? null : "감시 프로세스가 없습니다";
      if (target === BRIDGE_ROLE) {
        const status = readBridgeStatus(home);
        return /^(blocked|locked): /.test(status) ? status.replace(/^\w+: /, "") : null;
      }
      return null;
    },
    // 반환 {via, reason}. 조용한 알림(ring false)은 디코로만 보내고 맥 알림으로 대신하지 않는다. 울림(ring)은 놓치면 안 되므로 대신 보낸다.
    notify: (message, { ring = false, key } = {}) => {
      const result = notifyUser(message, spawnSync, { kind: "revive", ring, ...(ring ? {} : { systemFallback: false }), ...(key ? { key, dedupWindowMs: 60 * 60 * 1000 } : {}) });
      if (result.error) console.error(`알림 실패: ${result.error}`);
      return { via: result.via, reason: result.discord?.reason ?? (result.via === "none" ? "디코 알림 설정 없음 또는 실패" : "") };
    },
    record: (entry) => { // 다리가 오류로 멈춘 적이 있으면 그 마지막 이유(시각·오류 코드)를 사건에 같이 남긴다.
      const exit = entry.target === BRIDGE_ROLE ? readBridgeExit(home) : null;
      try { appendLedger({ ...entry, ...(exit ? { lastExit: { at: exit.at, kind: exit.kind, status: exit.status, code: exit.code } } : {}), t: new Date().toISOString() }, home); } catch (error) { console.error(`원장 기록 실패: ${error.message}`); } },
  };
}

// 결과 문자열을 되살리기 결과로 옮긴다. blocked/locked 접두어는 막힘, 그 밖에 시작하지 않은 것은 실패로 본다.
const reviveResult = (value) => value === "started" || value === "restored" ? "started" : value === "reused" ? "reused" : /^(blocked|locked)/.test(value ?? "") || value === "blocked" ? "blocked" : "failed";

function runUpOnce({ home, flags, auto }) {
  const tmuxFloor = floor.name === "tmux";
  const ops = tmuxFloor ? reviveOps(home) : null;
  if (tmuxFloor && !auto) clearForUp(home);
  const prepared = tmuxFloor ? prepareRevive({ home, auto, ops }) : { skip: new Set(), pending: new Map(), lines: [] };
  const lines = [...prepared.lines];
  // 자동 실행은 매분 같은 안내(접속 주소·창 안내·이미 살아 있음)를 쓰지 않는다. 바뀐 것만 남긴다.
  const log = auto ? (line) => { if (line && !/이미 살아 있음|^대시보드: http|^비서 창:|^끄기:/.test(line)) lines.push(line); } : console.log;
  const result = runUp({
    home,
    flags,
    floor,
    sessionName,
    cliPath: new URL("../cli.mjs", import.meta.url).pathname,
    start: (argv, startFlags) => cmdStart(argv, startFlags),
    skip: prepared.skip,
    log,
    ...(tmuxFloor ? {
      restoreSecretary: startNew => resumeSecretary({home, floor, startNew}),
      startWatch: () => startWatchSession(home),
      startBridge: () => startBridgeSession(home),
    } : {}),
  });
  if (auto && prepared.pending.size) {
    lines.push(...finishRevive({ home, pending: prepared.pending, ops, results: {
      비서: reviveResult(result.secretary), 대시보드: reviveResult(result.dashboard),
      watch: reviveResult(result.watch), 디코: reviveResult(result.bridge) } }));
  }
  if (result.secretaryError && !auto) process.exitCode = 1;
  // 자동 실행은 비서를 새로 띄우거나 복원했을 때만 대화 복원 정보를 갱신한다(매분 프로세스 조회를 하지 않는다).
  const refresh = auto ? ["started", "restored"].includes(result.secretary) : result.secretary !== "blocked" && result.secretary !== "skipped";
  if (tmuxFloor && refresh) {
    try {
      withRecoveryLock(home, 'kadan-비서', () => {
        for (let attempt = 0; ; attempt++) {
          try { return checkpointSecretary({home, floor}); }
          catch (error) {
            if (attempt >= 7) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
          }
        }
      });
    } catch (error) {
      lines.push(`비서 대화 복원 정보 저장 확인 필요: ${error.message}`);
      if (!auto) { console.error(`비서 대화 복원 정보 저장 확인 필요: ${error.message}`); process.exitCode = 1; }
    }
  }
  if (auto) for (const line of changedOutput(home, lines)) console.log(`[${new Date().toISOString()}] ${line}`);
}

// 감시기·다리 세션은 프로세스가 죽어도 마지막 화면이 남게 한다(2026-10-16). `up`이 그 화면을 저장하고 치운 뒤 다시 띄운다.
const KEEP_DEAD_PANE = (session) => [";", "set-option", "-t", `=${session}:`, "remain-on-exit", "on"];

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
      const result = tmux(["new-session", "-d", "-s", session, "-c", new URL("../..", import.meta.url).pathname, ...env, `'${node}' '${cli}' watch`, ...KEEP_DEAD_PANE(session)]);
      if (result.status !== 0) throw new Error((result.stderr || "tmux new-session 실패").trim());
    },
  });
}

// 디코 다리도 감시기처럼 원장 start 기록 없이 tmux 세션 kadan-디코에서 돈다. 환경은 경로·시험용 값만 넘긴다(비밀값은 파일에서 읽는다).
const BRIDGE_ENV = ["KADAN_SOCKET", "KADAN_NOTIFY", "KADAN_DISCORD_API_BASE", "KADAN_SECRET_DISCORD_FILE", "KADAN_SECRET_DISCORD_BOT_FILE"];
function bridgeDeps(home) {
  const session = sessionName(BRIDGE_ROLE);
  return {
    configured: () => {
      const bot = loadSecret(process.env, home, "discord-bot");
      if (!bot.values && bot.source !== "broken" && !bot.error) return "no-secret";
      try { loadChatConfig(process.env, home); return "ok"; } catch (error) { return `bad-config: ${error.message}`; }
    },
    lockInfo: () => watchLockInfo(home),
    owned: (pid) => {
      const pane = floor.list().find((item) => item.session === session)?.pid;
      if (pane == null) return false;
      // 잠금 주인이 세션의 pane 프로세스이거나 그 자손인지(셸이 node를 exec하면 같고, 아니면 자손)
      let cur = pid;
      for (let depth = 0; depth < 8 && cur > 1; depth++) {
        if (String(cur) === String(pane)) return true;
        const r = spawnSync("ps", ["-o", "ppid=", "-p", String(cur)], { encoding: "utf8" });
        cur = Number(String(r.stdout).trim());
      }
      return false;
    },
    alive: () => floor.alive(session),
  };
}

// 감시 순회용 읽기 전용 확인. 세션을 만들지 않는다.
export function readBridgeStatus(home) { return bridgeStatus(bridgeDeps(home)); }

function startBridgeSession(home) {
  const session = sessionName(BRIDGE_ROLE);
  const node = process.execPath, cli = new URL("../cli.mjs", import.meta.url).pathname;
  const env = ["-e", `KADAN_HOME=${home}`, ...BRIDGE_ENV.filter((k) => process.env[k]).flatMap((k) => ["-e", `${k}=${process.env[k]}`])];
  return ensureBridge({
    ...bridgeDeps(home),
    create: () => {
      const result = tmux(["new-session", "-d", "-s", session, "-c", new URL("../..", import.meta.url).pathname, ...env,
        `'${node}' '${cli}' discord watch --to-mail`, ...KEEP_DEAD_PANE(session)]);
      if (result.status !== 0) throw new Error((result.stderr || "tmux new-session 실패").trim());
    },
  });
}

// 앱·터미널에서 이야기하던 AI 대화를 복제해 카단 감독 세션으로 이어 연다(2026-10-06 [kyle]).
export function cmdAdopt(argv, flags) {
  if (flags.help) {
    console.log('kadan adopt <감독> --model <모델> [--resume <대화ID> --harness claude|codex]');
    console.log('kadan adopt accept <인수ID> --summary <이어받은 목표·승인 범위와 다음 행동>');
    console.log('kadan adopt status <인수ID>');
    return;
  }
  const home = ledgerHome();
  const notice = details => {
    try {
      const receipt = notifyAdoption(home, details);
      console.log(`비서 우편함에 확인 요청 저장: ${receipt.mailId}`);
    } catch { console.error('비서 확인 요청 저장 실패. 원본 탭을 보존하고 직접 상태를 확인하세요.'); }
  };
  try {
    if (argv[0] === 'status') {
      console.log(JSON.stringify(transferStatus(home, argv[1]), null, 2));
      return;
    }
    if (argv[0] === 'accept') {
      const result = acceptTransfer({home, id: argv[1], flags, floor});
      console.log(JSON.stringify(result, null, 2));
      if (['close-failed', 'remove-failed'].includes(result.source)) process.exitCode = 1;
      return;
    }
    if (floor.name === "tmux" && !flags.hidden) requireWindowChoice();
    runAdopt({
      role: argv[0], flags, floor, sessionName,
      inherit: conversation => {
        const cwd = process.cwd();
        const file = conversationFile({...conversation, cwd});
        const sourceConversation = {...conversation, cwd, file};
        const permissions = readConversationPermissions(file, conversation.harness);
        if (conversation.harness === 'claude' && permissions.sessionId !== conversation.id) {
          throw new Error('원본 대화의 현재 권한 기록을 확인하지 못했습니다.');
        }
        if (conversation.harness === 'claude') checkLaunchPermissions(sourceAgent({conversation: sourceConversation}));
        let source = null, sourceWarning;
        try { source = captureSource({conversation: sourceConversation}); }
        catch (error) { sourceWarning = error.message; }
        return {conversation: {...conversation, cwd, file}, permissions, source, sourceWarning};
      },
      prepare: options => prepareTransfer({home, floor, ...options}),
      notice,
      monitor: id => startAdoptMonitor(home, id),
      start: (startArgv, startFlags) => cmdStart(startArgv, startFlags),
      send: ({ role, session, message, roleProfile }) => {
        const receipt = guardedSend({floor, session, role, message, roleProfile,
          recordedPid: recordedPid(lastStartFor(session))});
        console.log(`첫 안내 전송됨: ${session} (${receipt.bytes}B, 우편ID ${receipt.mailId}) — 인수 확인 대기`);
      },
    });
  } catch (error) {
    if (argv[0] !== 'status' && error.code !== ADOPT_USAGE) notice({id: error.adoptionId || (argv[0] === 'accept' ? argv[1] : undefined),
      role: process.env.KADAN_ROLE || argv[0], reason: error.message});
    die(error.message, 2);
  }
}

// 로그인 때와 60초마다 `kadan up --hidden --auto`를 창 없이 실행하는 macOS LaunchAgent(2026-10-06 [kyle], 주기는 2026-10-16). KeepAlive는 쓰지 않는다.
export function cmdAutostart(argv) {
  if (process.platform !== "darwin") die("autostart는 macOS LaunchAgent용이다");
  try {
    const result = autostartCommand(argv[0], { home: ledgerHome(), cli: new URL("../cli.mjs", import.meta.url).pathname });
    if (argv[0] === "show") { console.log(`# ${result.file} (${result.installed ? "설치돼 있음" : "아직 없음"})`); console.log(result.content); return; }
    console.log(JSON.stringify(result, null, 2));
    if (argv[0] === "status" && result.stale?.length) {
      console.error(`경고: 자동 시작 설정이 낡았다 — 쓸 수 없는 경로: ${result.stale.map(describeStale).join(", ")}. 다시 만들기: ${result.fix}`);
      process.exitCode = 1;
    }
  } catch (error) { die(error.message, 2); }
}
