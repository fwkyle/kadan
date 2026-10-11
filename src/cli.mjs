#!/usr/bin/env node
import { findDoneMarkers, diffDoneMarkers } from "./done-marker.mjs";
import { taskIdentity } from "./task-identity.mjs";
import { readLedgerState, projectLedger } from "./ledger-domains.mjs";
import { captureRuntimeVersion } from "./runtime-version.mjs";
import { WatchAI } from "./watch-ai.mjs";
import { cycleReads } from "./watch-reads.mjs";
import { watchReportCommand, watchAILabel } from "./watch-report.mjs";
import { notifyUser } from "./watch-system.mjs";
import { storageCommand } from "./storage-migration.mjs";
import { assertWritable, storageVersion } from "./storage.mjs";
import { SecretaryMailbox } from "./secretary-mailbox.mjs";
import { inboxCommand } from "./mailbox.mjs";
import { attachWatchOverview } from "./watch-overview.mjs";
import { PROFILE_FILE } from "./watch-cycle.mjs";
import {
  defaultProfilePath,
  readWatchProfile,
  applyWatchProfile,
  watchStartupWarnings,
} from "./watch-profile.mjs";
import { decisionCommand, DecisionStore } from "./decisions.mjs";
import { seniorCommand } from "./senior.mjs";
import { runnersCommand } from "./runners-command.mjs";
import { CardStore } from "./card-store.mjs";
import { cardCommand, closeCardAfterDone } from "./card-command.mjs";
import { runAdopt } from "./adopt.mjs";
import { hierarchyCommand } from "./hierarchy-prune.mjs";
import { workCommand } from "./work-command.mjs";
import { runInit, runUp } from "./quickstart.mjs";
import { autostartCommand } from "./autostart.mjs";
import { WorkStore } from "./work-store.mjs";
import { buildCardCenter } from "./card-center.mjs";
import { Handover } from "./handover.mjs";
import { HandoverRunner } from "./handover-runner.mjs";
import { slotCommand } from "./review-slots.mjs";
import { limitCommand } from "./heavy-limit.mjs";
import { parseHierarchy } from "./hierarchy.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { floor } from "./floor.mjs";
import {
  appendLedger,
  ledgerBy,
  ledgerHome,
  ledgerPath,
  readLedger,
  resolveLedgerBy,
} from "./ledger.mjs";
import {
  removeRottieWindow,
  showRottieWindow,
  SOCKET,
  buildOrcaCreateArgv,
  buildRottieCreateArgv,
  buildTmuxCreateArgv,
  capturePane,
  ensureTmuxConf,
  openWindow,
  parseRottieCreateResult,
  tmux,
  tmuxConfPath,
  tmuxConfText,
  hasSession,
} from "./floor-tmux.mjs";
import { buildRottieFloorCreateArgv } from "./floor-rottie.mjs";
import { currentRottieWindow, planRestore, runRestore } from "./restore.mjs";
import { buildWallSnapshot, createWallServer, renderWallHtml, withWaitSnapshots } from "./wall.mjs";
import {
  buildJudgeInput,
  parseJudgeVerdict,
  applyJudgeVerdict,
  judgeDue,
  assessRoles,
  assessResources,
  routeAlert,
  dedupAlerts,
  disconnectKind,
} from "./watch.mjs";
import { deliverResolution, formatAlertBody, runWatch } from "./watch-runner.mjs";
import { executeJudge } from "./watch-judge.mjs";
import { collectResources } from "./watch-resource.mjs";
import { assessSupervisorIdle, buildIdleNudge } from "./watch-supervisor.mjs";
import {
  recentSends,
  die,
  sessionName,
  stripAnsi,
  tailLines,
  lastStartFor,
  recordedPid,
  normalizeFloorRead,
  parseFlags,
} from "./cli-basics.mjs";
import { startDisplay } from "./cli-family.mjs";
import { buildTree, renderTree } from "./cli-tree.mjs";
import { guardedSend, collectCardFiles } from "./cli-guarded-send.mjs";
import {
  parsePlanCard,
  planCards,
  confirmDone,
  runWaitLoop,
  waitScreenDone,
} from "./cli-wait-done.mjs";
import {
  requireWindowChoice,
  inspectRottieStartPreflight,
  pendingCardsFor,
  buildStopLedgerEntry,
  closeStartedWindow,
} from "./cli-start-support.mjs";
import { cmdStart } from "./commands/start.mjs";
import { cmdSend } from "./commands/send.mjs";

export {findDoneMarkers,diffDoneMarkers} from './done-marker.mjs';
// kadan 코어 — 원장 + DONE 마커 감시. 바닥 호출은 floor 객체만 통한다.


export {
  recentSends,
  sessionName,
  stripAnsi,
  tailLines,
  digest,
  parseFlags,
} from "./cli-basics.mjs";
export { dutyHead, modelFamily, startDisplay, familyConflictAlerts } from "./cli-family.mjs";
export { cardRound, renderRound, buildTree, renderTree } from "./cli-tree.mjs";
export {
  guardedSend,
  extractCardPath,
  collectCardFiles,
  mailPreview,
} from "./cli-guarded-send.mjs";
export {
  waitSnapshotPath,
  formatWaitSnapshot,
  parsePlanCard,
  planCards,
  confirmDone,
  screenDoneResult,
  runWaitLoop,
  waitScreenDone,
} from "./cli-wait-done.mjs";
export {
  resolveWindowChoice,
  listRunningRottieBins,
  inspectHiddenStartPolicy,
  inspectRottieStartPreflight,
  describeStartCmd,
  buildStartLedgerEntry,
  pendingCardsFor,
  buildStopLedgerEntry,
  openStartedWindow,
  closeStartedWindow,
} from "./cli-start-support.mjs";
export { doneHintFor } from "./commands/send.mjs";

export {
  appendLedger,
  ledgerBy,
  ledgerHome,
  ledgerPath,
  readLedger,
  resolveLedgerBy,
  SOCKET,
  buildOrcaCreateArgv,
  buildRottieCreateArgv,
  buildRottieFloorCreateArgv,
  buildTmuxCreateArgv,
  capturePane,
  ensureTmuxConf,
  openWindow,
  parseRottieCreateResult,
  tmux,
  tmuxConfPath,
  tmuxConfText,
  hasSession,
  createWallServer,
  renderWallHtml,
  buildJudgeInput,
  parseJudgeVerdict,
  applyJudgeVerdict,
  judgeDue,
  assessSupervisorIdle,
  buildIdleNudge,
  assessRoles,
  assessResources,
  routeAlert,
  dedupAlerts,
  disconnectKind,
  collectResources,
  runWatch,
  formatAlertBody,
  deliverResolution,
  executeJudge,
};


function cmdPlan(argv, flags = {}) {
  const [board, ...taskIds] = argv;
  if (!board || taskIds.length === 0) {
    die('사용법: kadan plan <판> [--about "<판 설명>"] <카드id[:제목]>...', 2);
  }
  const about = typeof flags.about === "string" ? flags.about : null;
  planCards({ board, taskIds, about });
  const shown = taskIds
    .map(parsePlanCard)
    .map(card => (card.title ? `${card.taskId}(${card.title})` : card.taskId))
    .join(", ");
  console.log(`계획됨: 판=${board}${about ? ` 설명=${about}` : ""} 카드=${shown}`);
}

function cmdDone(argv, flags = {}) {
  const [role, taskId, given, ...extra] = argv;
  const closeCard = flags["close-card"] === true, fromScreen = flags["from-screen"] === true;
  const waitSec = flags.wait === undefined ? 0 : Number(flags.wait);
  if (!role || !taskId || (fromScreen ? given : !given) || extra.length > 0 || (flags.note !== undefined && (!closeCard || typeof flags.note !== "string"))
    || (flags.wait !== undefined && (!fromScreen || !Number.isFinite(waitSec) || waitSec < 0 || waitSec > 600))) {
    die("사용법: kadan done <역할> <카드id> <ok|failed> | --from-screen [--wait <초, 최대 600>] [--close-card [--note <이유>]]", 2);
  }
  let result = given;
  if (fromScreen) {
    // 기록·전송 없이 화면만 읽는다. 표시가 없으면 실패로 닫고, 재출력 요청은 부르는 쪽이 판단한다.
    const session = sessionName(role);
    if (!floor.alive(session)) die(`세션 없음: ${session}`, 2);
    const entries = readLedger();
    const found = waitScreenDone({
      readScreen: () => normalizeFloorRead(floor.read(session)).text,
      entries, role, taskId, cards: new CardStore(ledgerHome()).listSummaries(), waitMs: waitSec * 1000,
    });
    if (!found.result) die(`화면 완료 표시 없음: 역할=${role} 카드=${taskId}${found.dispatch ? "" : " (발령 기록 없음 — 화면 전체를 봄)"}${waitSec ? ` (${waitSec}초 대기, 화면 ${found.reads}회 확인)` : ""}`, 3);
    result = found.result;
  }
  if (closeCard && result !== "ok") {
    die("--close-card는 ok 완료에만 쓴다 — failed 실행은 카드를 닫지 않는다", 2);
  }
  const entry = confirmDone({
    entries: readLedger(),
    role,
    taskId,
    result,
  });
  console.log(
    `완료 확정: 역할=${entry.role} 카드=${entry.taskId} 결과=${entry.result} 확인=${entry.by}`
  );
  if (!closeCard) return;
  try {
    const closed = closeCardAfterDone(entry.executionKey, { home: ledgerHome(), by: entry.by, note: flags.note });
    console.log(closed.state === "already"
      ? `카드 닫기: 이미 완료 상태라 기록하지 않음 — 카드=${closed.key} revision=${closed.revision}`
      : `카드 닫기: 카드=${closed.key} 상태=done revision=${closed.revision}`);
  } catch (error) {
    console.error(`카드 닫기 실패: ${error.message} — 실행 완료 확정은 그대로 저장됨`);
    process.exitCode = 1;
  }
}

function cmdWait(argv, flags) {
  const role = argv[0];
  if (!role) {
    die("사용법: kadan wait <역할> [--timeout 초] [--quiet 초] [--interval 초]");
  }
  const session = sessionName(role);
  if (!floor.alive(session)) die(`세션 없음: ${session}`);
  const interval = (Number(flags.interval) || 2) * 1000;
  const timeout = (Number(flags.timeout) || 600) * 1000;
  const quietMs = (Number(flags.quiet) || 120) * 1000;

  const lastSend = readLedger()
    .filter((entry) => entry.kind === "send" && entry.session === session)
    .at(-1);
  let result;
  try {
    result = runWaitLoop({
      floor,
      session,
      role,
      intervalMs: interval,
      timeoutMs: timeout,
      quietMs,
      since: lastSend?.outputCursor,
      baselineMarkers: lastSend?.baselineMarkers,
      snapshotHome: ledgerHome(),
    });
  } catch (error) {
    die(error.message, error.exitCode || 1);
  }
  if (result.code === 0) {
    for (const marker of result.markers) {
      console.log(`완료 마커: taskId=${marker.taskId} 결과=${marker.result}`);
    }
  } else if (result.reason === "gap") {
    console.log(
      `출력 누락 보고: ${result.gap.from}→${result.gap.to}, 마커를 놓쳤을 수 있음 — 사람 확인 필요`
    );
  } else if (result.reason === "quiet") {
    console.log(
      `정지 보고: ${Math.round(quietMs / 1000)}초간 출력 없음, 마커 없음 — 사람 확인 필요`
    );
  } else {
    console.log("제한 시간 도달: 아직 진행 중일 수 있음");
  }
  process.exit(result.code);
}

// 해소 우편이 없으므로(2026-10-05 [kyle]) 경보를 받은 감독은 행동 전에 지금 상태를 스스로 확인한다.
export const WATCH_ALERT_FOOTER='행동 전 지금 상태를 확인하라(감독 템플릿의 현황 확인 절차). 풀렸으면 따로 알리지 않는다.';
function sendWatchMessage(role,message) {
  if (role==='@user') {
    const failure=notifyUser(message,spawnSync);
    if (failure) { const error=new Error('사용자 알림 실패'); error.delivery='not-sent'; throw error; }
    return;
  }
  const session=sessionName(role);
  // 감시 경보 우편은 기록용이다: 경보는 상태 변화로 닫히지 수신자 ack로 닫히지 않으므로 읽음 확인 안내를 붙이지 않고
  // 미확인 우편 재알림 대상에서도 뺀다(2026-10-05 [kyle] 소음 줄이기). 해소 우편도 없으므로 받는 쪽이 행동 전에
  // 지금 상태를 확인한다(감독 템플릿의 현황 확인 절차).
  guardedSend({floor,session,role,message:`${message}\n${WATCH_ALERT_FOOTER}`,source:'watch',recordedPid:recordedPid(lastStartFor(session)),notificationOnly:true});
}

// 사람이 이 시간 안에 창에서 키를 눌렀으면 입력 중으로 보고 미확인 우편 알림을 미룬다.
// 2026-09-23 [kyle]: 10분은 계속 대화하는 창의 질문 알림을 너무 늦춰 30초로 줄였다. 입력창 글 검사는 그대로다.
export const WATCH_MAIL_HUMAN_IDLE_MS = 30_000;

export function sendWatchMailReminder(role,message,expectedPid,{
  selectedFloor=floor,readStart=lastStartFor,send=guardedSend,
}={}) {
  const session=sessionName(role);
  if (expectedPid == null || expectedPid === '' || String(recordedPid(readStart(session))) !== String(expectedPid)) {
    const error=new Error('미확인 우편 알림 수신 세대 변경');
    error.delivery='not-sent';
    throw error;
  }
  return send({floor:selectedFloor,session,role,message,source:'watch',recordedPid:expectedPid,notificationOnly:true,
    notificationGuard:{humanIdleMs:WATCH_MAIL_HUMAN_IDLE_MS}});
}

// 놀고 있음 본인 알림은 감독 창에 붙여넣는 우편이라, 사람이 그 창에서 대화 중이면 미룬다.
// 사용자가 슈퍼감독과 직접 대화하는 창에 반쯤 쓴 문장 뒤에 붙지 않게 한다(2026-10-05). 읽음 재알림도 만들지 않는다.
export function sendWatchNudge(role,message,{selectedFloor=floor,readStart=lastStartFor,send=guardedSend}={}) {
  const session=sessionName(role);
  return send({floor:selectedFloor,session,role,message,source:'watch',recordedPid:recordedPid(readStart(session)),notificationOnly:true,
    notificationGuard:{humanIdleMs:WATCH_MAIL_HUMAN_IDLE_MS}});
}

// 바닥이 보류 조회를 지원하지 않으면(rottie) 기존처럼 보류 없이 진행한다.
export function watchMailHold(role,{selectedFloor=floor}={}) {
  return selectedFloor.notificationHold?.(sessionName(role),{humanIdleMs:WATCH_MAIL_HUMAN_IDLE_MS}) ?? null;
}

function cmdWatch(argv, flags) {
  const usage =
    "사용법: kadan watch [--profile <JSON파일>] [--interval 초] [--stall 횟수] [--stall-after 분] [--start-report-after 분] [--completion-grace 분] [--idle 분] [--route <판>=<역할>]... [--super <역할>] [--hierarchy <JSON파일>] [--user-notify] [--judge-cmd <셸 명령>] [--judge-cooldown 분]\n  --profile: 정식 명령을 담은 JSON({flags,env}). 직접 준 옵션이 우선. 옵션이 하나도 없고 $KADAN_HOME/" + PROFILE_FILE + "이 있으면 자동 적용.";
  if (flags.help) {
    console.log(usage);
    return;
  }
  if (argv.length > 0) die(usage, 2);
  const allowed = new Set([
    "profile",
    "interval",
    "stall",
    "stall-after",
    "start-report-after",
    "completion-grace",
    "idle",
    "route",
    "super",
    "hierarchy",
    "user-notify",
    "judge-cmd",
    "judge-cooldown",
  ]);
  const unknown = Object.keys(flags).find((name) => !allowed.has(name));
  if (unknown) die(`watch가 모르는 옵션: --${unknown}`, 2);
  if (flags.profile === true || Array.isArray(flags.profile)) die("watch --profile에는 파일 하나가 필요하다", 2);
  const defaultProfile = defaultProfilePath(ledgerHome());
  const profileFile = flags.profile ? path.resolve(flags.profile) : Object.keys(flags).length === 0 && fs.existsSync(defaultProfile) ? defaultProfile : null;
  let profile = null;
  if (profileFile) {
    try { profile = readWatchProfile(profileFile); } catch (error) { die(error.message, 2); }
    delete flags.profile;
    const applied = applyWatchProfile(flags, profile);
    console.log(`감시 프로필 적용: ${profileFile}${applied.length ? " (" + applied.join(", ") + ")" : " (적용한 옵션 없음)"}`);
    for (const line of profile.retired ?? []) console.error(`안내: 감시 프로필의 없어진 옵션을 무시한다 — ${line}. 프로필에서 지워도 된다.`);
  }
  for (const line of watchStartupWarnings(flags, {profileFile, defaultProfile, exists: fs.existsSync})) console.error(line);

  const intervalSeconds = flags.interval == null ? 60 : Number(flags.interval);
  const stallAfterMinutes=flags["stall-after"]==null?5:Number(flags["stall-after"]);
  const startReportMinutes=flags["start-report-after"]==null?5:Number(flags["start-report-after"]);
  if(!Number.isFinite(stallAfterMinutes)||stallAfterMinutes<=0||!Number.isFinite(startReportMinutes)||startReportMinutes<=0)die("감시 시간은 0보다 큰 분이어야 한다",2);
  const completionGrace = flags['completion-grace'];
  const completionGraceMinutes = completionGrace == null ? 15 : Number(completionGrace);
  if (completionGrace === true || Array.isArray(completionGrace) ||
      !Number.isFinite(completionGraceMinutes) || completionGraceMinutes < 0) {
    die("watch --completion-grace는 0 이상의 분이어야 한다", 2);
  }
  const stallN = flags.stall == null ? 2 : Number(flags.stall);
  // 감독 멈춤: --idle 분 뒤 본인에게, 그 두 배가 되면 상위에게(2026-10-05 [kyle] 결정으로 30분 → 15분).
  const idleMinutes = flags.idle == null ? 15 : Number(flags.idle);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    die("watch --interval은 0보다 큰 초여야 한다", 2);
  }
  if (!Number.isInteger(stallN) || stallN <= 0) {
    die("watch --stall은 1 이상의 정수여야 한다", 2);
  }
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) {
    die("watch --idle은 0보다 큰 분이어야 한다", 2);
  }
  if (flags.super === true || Array.isArray(flags.super)) {
    die("watch --super에는 역할 하나가 필요하다", 2);
  }
  if (flags["judge-cmd"] === true || Array.isArray(flags["judge-cmd"])) {
    die("watch --judge-cmd에는 셸 명령 하나가 필요하다", 2);
  }
  const judgeCooldownMinutes =
    flags["judge-cooldown"] == null ? 5 : Number(flags["judge-cooldown"]);
  if (!Number.isFinite(judgeCooldownMinutes) || judgeCooldownMinutes <= 0) {
    die("watch --judge-cooldown은 0보다 큰 분이어야 한다", 2);
  }

  const routeValues =
    flags.route == null
      ? []
      : Array.isArray(flags.route)
        ? flags.route
        : [flags.route];
  const routes = new Map();
  for (const value of routeValues) {
    if (typeof value !== "string" || !/^[^-=\s][^=\s]*=[^=\s]+$/.test(value)) {
      die(`잘못된 watch route: ${String(value)} (예: w1=w1-감독)`, 2);
    }
    const [board, role] = value.split("=");
    routes.set(board, role);
  }

  let parents = new Map();
  if (flags.hierarchy != null) {
    try {
      if (typeof flags.hierarchy !== "string") throw new Error("파일 경로 하나가 필요하다");
      parents = parseHierarchy(JSON.parse(fs.readFileSync(flags.hierarchy, "utf8")));
    } catch (error) {
      die(`watch hierarchy 읽기 실패: ${error.message}`, 2);
    }
  }
  const watchController=new AbortController();
  const stopWatch=()=>watchController.abort();
  process.once('SIGTERM',stopWatch);process.once('SIGINT',stopWatch);
  // 한 주기 안에서 원장이 바뀌지 않았으면 전체 읽기를 재사용한다. 감시AI 보고도 같은 읽기를 쓴다.
  const reads=cycleReads({readEntries:()=>readLedger(),readCards:()=>new CardStore(ledgerHome()).list(),
    readWorks:()=>new WorkStore(ledgerHome()).list(),version:()=>storageVersion(ledgerHome())});
  return runWatch({
    runtime:captureRuntimeVersion(),
    floor,
    readEntries: reads.readEntries,
    readCards: reads.readCards,
    readWorks: reads.readWorks,
    readDecisions: () => new DecisionStore(ledgerHome()).list(),
    reads,
    startReportGraceMs: startReportMinutes*60_000,
    completionGraceMs: completionGraceMinutes*60_000,
    stallAfterMs: stallAfterMinutes*60_000,
    record: entry => appendLedger({ ...entry, t: new Date().toISOString() }),
    sendAlert: sendWatchMessage,
    sendNudge: sendWatchNudge,
    sendMailReminder: sendWatchMailReminder,
    mailHold: watchMailHold,
    resume429: (role,message,expectedPid) => {
      const session=sessionName(role);
      if(String(recordedPid(lastStartFor(session)))!==String(expectedPid))throw new Error('429 재개 세대 변경');
      guardedSend({floor,session,role,message,source:'watch',recordedPid:expectedPid});
    },
    sendQueueEnter: typeof floor.sendEnter==='function' ? (role,expectedPid) => {
      const session=sessionName(role);
      if(String(recordedPid(lastStartFor(session)))!==String(expectedPid))throw new Error('입력 큐 재개 세대 변경');
      return floor.sendEnter(session);
    } : null,
    ai: flags['judge-cmd'] ? new WatchAI({home:ledgerHome(),floor,send:sendWatchMessage,readEntries:reads.readEntries,readCards:reads.readCards,readWorks:reads.readWorks}) : null,
    hierarchyPath: flags.hierarchy ? path.resolve(flags.hierarchy) : null,
    profilePath: profileFile,
    intervalMs: intervalSeconds * 1000,
    stallN,
    routes,
    superRole: flags.super || null,
    parents,
    loadHierarchy: flags.hierarchy ? () => {
      const text = fs.readFileSync(flags.hierarchy, "utf8");
      return { parents: parseHierarchy(JSON.parse(text)), path: path.resolve(flags.hierarchy), hash: createHash("sha256").update(text).digest("hex") };
    } : null,
    idleMs: idleMinutes * 60 * 1_000,
    userNotify: flags["user-notify"] === true,
    judgeCmd: flags["judge-cmd"] || null,
    judgeCooldownMs: judgeCooldownMinutes * 60 * 1_000,
    signal:watchController.signal,
  }).finally(()=>{process.removeListener('SIGTERM',stopWatch);process.removeListener('SIGINT',stopWatch);});
}

function cmdStop(argv) {
  const role = argv[0];
  if (!role) die("사용법: kadan stop <역할>");
  const session = sessionName(role);
  if (!floor.alive(session)) die(`세션 없음: ${session}`);
  const pending = pendingCardsFor(taskIdentity(new CardStore(ledgerHome()).listSummaries()).project(readLedger()), role);
  if (pending.length > 0) {
    console.log(
      `미확정 카드 ${pending.length}건: ${pending.join(", ")} — 종료하면 화면이 사라진다. 확인했으면 kadan done ${role} <카드id> <ok|failed>`
    );
  }
  try {
    floor.stop(session);
  } catch (error) {
    die(error.message);
  }
  const windowFields = floor.name === "tmux" ? closeStartedWindow(currentRottieWindow(readLedger(), session), {print:console.error}) : {};
  appendLedger({ ...buildStopLedgerEntry({ role, session }), ...windowFields });
  if (windowFields.rottieWindowClosed === false || windowFields.rottieWindowRemoved === false) {
    console.error(`세션은 종료됨: ${session} · 로티 탭 정리 미완료: ${windowFields.rottieTerminalId} — ${windowFields.rottieWindowError ?? windowFields.rottieRemoveError}`);
    process.exitCode = 1;
    return;
  }
  console.log(`종료됨: ${session}`);
}

function cmdRestore(argv, flags) {
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

function cmdStatus() {
  let sessions;
  try {
    sessions = floor.list();
  } catch (error) {
    die(error.message, error.exitCode || 1);
  }
  if (sessions.length === 0) {
    console.log(`카단 구획(${SOCKET})에 세션 없음`);
    return;
  }
  for (const item of sessions) {
    const recorded = recordedPid(lastStartFor(item.session));
    const pidState = !recorded
      ? "기록없음"
      : recorded === item.pid
        ? "PID일치"
        : `PID변경(${recorded}→${item.pid})`;
    const shown = startDisplay(lastStartFor(item.session));
    const modelBit = `  ${shown.harness} · ${shown.model} · ${shown.family}`;
    if (["rottie", "herdr"].includes(floor.name)) {
      console.log(
        `${item.session}  ${floor.name === "rottie" ? "Rottie" : "herdr"}=${item.terminalId}  상태=${item.state}  ${pidState}${modelBit}`
      );
    } else {
      console.log(
        `${item.session}  ${Number(item.attached) ? "창붙음" : "백그라운드"}  시작=${new Date(
          item.created * 1000
        ).toISOString()}  ${pidState}${modelBit}`
      );
    }
  }
}

function cmdTree(_argv, flags = {}) {
  if (!flags.legacy) {
    const snapshot=loadWallSnapshot();
    if (snapshot.centerError) die(snapshot.centerError);
    const c=snapshot.center;
    console.log(JSON.stringify({summary:c.summary,executionSummary:c.executionSummary,monitoring:c.monitoring,
      boards:c.boards.map(b=>({name:b.name,state:b.state,cards:b.cards.length,unregisteredRuns:b.runs.length,monitoring:b.monitoring})),
      pendingCards:c.cards.filter(card=>!['done','cancelled','superseded','archived'].includes(card.displayState)).map(card=>({key:card.key,state:card.displayState,workType:card.workType||'execution',board:card.board,role:card.role})),
      liveRoles:c.roles.filter(r=>r.life.state==='alive').map(r=>({role:r.role,life:r.life})),
      unregisteredRuns:c.unregistered.length},null,2)); return;
  }
  let sessions;
  try {
    sessions = floor.list();
  } catch (error) {
    die(error.message, error.exitCode || 1);
  }
  const aliveBySession = Object.fromEntries(
    sessions
      .filter((item) => item.alive !== false)
      .map((item) => [item.session, item])
  );
  console.log(renderTree(buildTree(readLedger(), aliveBySession,new CardStore(ledgerHome()).listSummaries())));
}

function loadWallSnapshot(runtime=null) {
  const collectedAt = new Date();
  const resourceSnapshot = buildWallSnapshot({ collect: () => collectResources(spawnSync) });
  const file = ledgerPath();
  let entries = [];
  let ledgerLines = null,ledgerState=null;
  const errors = [];
  try {
    ledgerState=readLedgerState(ledgerHome());
    entries = projectLedger(ledgerState);
    ledgerLines = entries.length;
  } catch (error) {
    errors.push(`원장 못 읽음(0개가 아니라 모름): ${error.message}`);
  }

  let sessions = [];
  try {
    sessions = floor.list();
  } catch (error) {
    errors.push(`생존 못 읽음(죽음이 아니라 모름): ${error.message}`);
  }
  const aliveBySession = Object.fromEntries(
    sessions
      .filter((item) => item.alive !== false)
      .map((item) => [item.session, item])
  );
  let cards=[],cardError=null;
  try {cards=new CardStore(ledgerHome()).list();}catch(error){cardError=error;}
  const tree=withWaitSnapshots(buildTree(entries,aliveBySession,cards),ledgerHome());
  let center=null, centerError=null,registeredWorks=null;
  try {
    if (ledgerLines===null) throw new Error("원장을 읽을 수 없어 카드 상태 모름");
    if(cardError)throw cardError;
    center=buildCardCenter({cards,entries,tree,runtimeKnown:!errors.some(x=>x.startsWith("생존"))});
    registeredWorks=new WorkStore(ledgerHome()).list();
    center=attachWatchOverview(center,entries,{works:registeredWorks,profilePath:fs.existsSync(defaultProfilePath(ledgerHome()))?defaultProfilePath(ledgerHome()):null});
  } catch(error) { centerError=error.message; }
  return {
    center,centerError,tree,ledgerState,registeredWorks,runtime,
    ...resourceSnapshot,
    entries,
    version: fs.existsSync(new URL("../package.json", import.meta.url)) ? JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version : "",
    mailbox: ledgerLines === null ? null : recentSends(entries),
    cardFiles: ledgerLines === null ? {} : collectCardFiles(entries),
    collectedAt,
    ledgerPath: file,
    ledgerLines,
    error: errors.length > 0 ? errors.join(" / ") : null,
  };
}

function cmdWall(_argv, flags) {
  if (flags.help) {
    console.log("사용법: kadan wall [--port 8790] [--cache-sec 초]  (모든 판: 주소 뒤에 ?all=1, 카단 판정: ?judge=1)");
    return;
  }
  const rawPort = flags.port ?? "8790";
  if (
    typeof rawPort !== "string" ||
    !/^\d+$/.test(rawPort) ||
    Number(rawPort) > 65535
  ) {
    die("--port는 0부터 65535까지의 정수여야 한다");
  }
  const cacheSec=flags['cache-sec']===undefined?10:Number(flags['cache-sec']);
  // 같은 주소를 15초마다 다시 읽는 화면을 위해 응답을 잠깐 재사용한다. 0이면 끈다.
  if(!Number.isInteger(cacheSec)||cacheSec<0)die('--cache-sec는 0 이상의 정수여야 한다');
  const runtime=captureRuntimeVersion();
  const server = createWallServer(()=>loadWallSnapshot(runtime), {home:ledgerHome(),cacheSec,gui:true});
  server.on("error", (error) => {
    console.error(`오류: 관제 화면 서버 시작 실패: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(Number(rawPort), "127.0.0.1", () => {
    const address = server.address();
    console.log(
      `관제 화면: http://127.0.0.1:${address.port} (Ctrl+C로 종료)`
    );
  });
}

function cmdInit(_argv, flags) {
  if (flags.help) {
    console.log("사용법: kadan init [--runner codex|claude] [--no-skills]  (환경 확인 · 스킬 링크 · 실행기 선택, 처음 한 번)");
    return;
  }
  runInit({
    home: ledgerHome(),
    repoRoot: new URL("..", import.meta.url).pathname,
    flags,
    floorName: floor.name,
  });
}

function cmdUp(_argv, flags) {
  if (flags.help) {
    console.log("사용법: kadan up [--cmd <실행기 명령>] [--port 8790] [--hidden] [--no-prompt]  (비서 세션 + 대시보드 세션)");
    return;
  }
  if (floor.name === "tmux") requireWindowChoice();
  runUp({
    home: ledgerHome(),
    flags,
    floor,
    sessionName,
    cliPath: new URL(import.meta.url).pathname,
    start: (argv, startFlags) => cmdStart(argv, startFlags),
    send: ({ role, session, message, roleProfile }) => {
      const receipt=guardedSend({ floor, session, role, message, roleProfile, recordedPid: recordedPid(lastStartFor(session)) });
      console.log(`첫 지문 전송됨: ${session} (${receipt.bytes}B, 지문 ${receipt.digest}, 우편ID ${receipt.mailId}) — 입력 접수·AI 실행 미확인`);
    },
  });
}

// 앱·터미널에서 이야기하던 AI 대화를 복제해 카단 감독 세션으로 이어 연다(2026-10-06 [kyle]).
function cmdAdopt(argv, flags) {
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
function cmdAutostart(argv) {
  if (process.platform !== "darwin") die("autostart는 macOS LaunchAgent용이다");
  try {
    const result = autostartCommand(argv[0], { home: ledgerHome(), cli: new URL(import.meta.url).pathname });
    if (argv[0] === "show") { console.log(`# ${result.file} (${result.installed ? "설치돼 있음" : "아직 없음"})`); console.log(result.content); return; }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { die(error.message, 2); }
}

function cmdRead(argv, flags) {
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

function cmdLog() {
  for (const entry of readLedger().slice(-30)) {
    console.log(renderLogEntry(entry));
  }
}

function cmdAttach(argv) {
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

export function createHandoverRunner() {
  const operation = new Handover({ home: ledgerHome(), floor, readEntries: readLedger,
    record: entry => appendLedger({ ...entry, by: resolveLedgerBy({env:operation.env}) }),
    start: (role, command, cwd, roleProfile) => {
      let window = process.env.KADAN_WINDOW;
      if (!window) window = process.env.KADAN_ROTTIE_BIN ? "rottie" : "none";
      const result = spawnSync(process.execPath, [new URL(import.meta.url).pathname, "start", role, "--cmd", command,...(roleProfile?['--profile',roleProfile]:[]),"--reason","인계: 선임 실행 명령 유지"],
        {cwd, env:{...process.env,KADAN_WINDOW:window},encoding:"utf8"});
      if (result.status !== 0) throw new Error(`후임 생성 실패: ${result.stderr || result.stdout}`);
    },
    send: (role,message,expectedPid) => guardedSend({floor,session:sessionName(role),role,message,env:operation.env,
      recordedPid:expectedPid ?? recordedPid(lastStartFor(sessionName(role)))}),
    closeWindow: lastStart => closeStartedWindow(lastStart,{print:console.error}),
  });
  return new HandoverRunner(operation, {notify:(target,message) => {
    if (target.transport === "mailbox") return new SecretaryMailbox(ledgerHome()).send({
      by:resolveLedgerBy({env:operation.env}), message, category:"report"});
    if (target.transport === "user") {
      if (notifyUser(message,spawnSync)) {
        const error = new Error("사용자 알림 실패"); error.delivery = "not-sent"; throw error;
      }
      return {status:"sent"};
    }
    guardedSend({floor,session:sessionName(target.role),role:target.role,message,recordedPid:target.pid,env:operation.env});
    return {status:"sent"};
  }});
}

function cmdHandover(argv, flags) {
  const usage = "kadan handover <선임> --to <후임> --at-boundary --hierarchy <절대JSON> --context <절대문서> [--source-ended] [--cmd 명령] [--cwd 절대경로] [--manual | --wait-timeout 1800 --notify 수신자] | accept <id> --receipt <절대JSON> | finish <id> [--timeout 90] | status <id> | abort <id>";
  // 공용 옵션 해석기는 건드리지 않고 --manual의 위치만 여기서 처리한다.
  if (typeof flags.manual === "string") { argv = [flags.manual,...argv]; flags = {...flags,manual:true}; }
  if (flags.help || !argv.length) { console.log(usage); return; }
  const [first,id] = argv;
  const subcommands = {accept:["receipt"],finish:["timeout"],status:[],abort:[]};
  const allowed = new Set(Object.hasOwn(subcommands,first) ? subcommands[first] : ["to","at-boundary","source-ended","hierarchy","context","cmd","cwd","manual","wait-timeout","notify"]);
  for (const key of Object.keys(flags)) if (!allowed.has(key)) throw new Error(`handover ${first}에서 사용할 수 없는 옵션: ${key}; 자동 대기는 --wait-timeout, finish 대기는 --timeout`);
  const runner = createHandoverRunner(), operation = runner.h;
  let result;
  if (["accept","finish","status","abort"].includes(first)) {
    if (!id || argv.length !== 2) throw new Error(usage);
    if (first === "finish" && flags.timeout != null && typeof flags.timeout !== "string") throw new Error("--timeout 초 필요");
    if (first === "accept") operation.accept(id,flags.receipt);
    else if (first === "finish") result = operation.finish(id,{timeout:flags.timeout==null?90:Number(flags.timeout)});
    else if (first === "abort") result = operation.abort(id);
    result = {...runner.status(id), ...(result?.waiting ? {waiting:result.waiting} : {}), ...(result?.warning ? {warning:result.warning} : {})};
  } else {
    if (argv.length !== 1) throw new Error(usage);
    if (flags.manual && (flags["wait-timeout"] != null || flags.notify != null)) throw new Error("--manual은 --wait-timeout/--notify와 함께 사용할 수 없음");
    if (flags["wait-timeout"] != null && typeof flags["wait-timeout"] !== "string") throw new Error("--wait-timeout 초 필요");
    const config = flags.manual ? null : runner.prepare(first,{waitTimeout:flags["wait-timeout"]==null?1800:Number(flags["wait-timeout"]), notify:flags.notify});
    const state = operation.begin(first,{to:flags.to,cmd:flags.cmd,cwd:flags.cwd,hierarchy:flags.hierarchy,
      context:flags.context,atBoundary:flags["at-boundary"]===true,sourceEnded:flags["source-ended"]===true});
    result = config ? runner.start(state.id,config) : runner.status(state.id);
  }
  console.log(JSON.stringify(result,null,2));
}

const COMMANDS = {
  hierarchy:(args,flags)=>console.log(JSON.stringify(hierarchyCommand(args,flags,{home:ledgerHome(),floor}),null,2)),
  work:async(args,flags)=>console.log(JSON.stringify(await workCommand(args,flags,{
    home:ledgerHome(),by:resolveLedgerBy({env:process.env}),floor,
    send:({role,pid,message,taskId,workKey,executionKey,roleProfile,transmit})=>guardedSend({
      floor:{...floor,send:(name,text,options)=>transmit(()=>floor.send(name,text,options))},
      session:sessionName(role),role,message,taskId,roleProfile,recordedPid:pid,
      mailContext:{workKey,executionKey},
    }),
    observeDone:s=>{
      const observation=normalizeFloorRead(floor.read(sessionName(s.current.role)));
      if(observation.gap)throw new Error('완료 화면 출력 누락');
      const identity=taskIdentity(new CardStore(ledgerHome()).listSummaries());
      const markers=diffDoneMarkers(findDoneMarkers(stripAnsi(s.baseline)),findDoneMarkers(stripAnsi(observation.text)))
        .filter(m=>identity.resolve(m.taskId).key===s.current.key);
      if(new Set(markers.map(m=>m.result)).size>1)throw new Error('완료 마커 충돌');
      return markers[0]?.result||null;
    },
  }),null,2)),
  'watch-report':(args,flags)=>console.log(JSON.stringify(watchReportCommand(args,flags,{home:ledgerHome(),floor,send:sendWatchMessage}),null,2)),
  storage:(args,flags)=>console.log(JSON.stringify(storageCommand(args,flags,{home:ledgerHome()}),null,2)),
  inbox:(args,flags)=>console.log(JSON.stringify(inboxCommand(args,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})}),null,2)),
  decision: (argv,flags) => console.log(JSON.stringify(decisionCommand(argv,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})}),null,2)),
  senior: async (argv,flags) => {
    const result=await seniorCommand(argv,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})});
    if (typeof result==='string') { console.log(result); return; }
    const {answer,...receipt}=result;
    console.log(JSON.stringify(receipt,null,2));
    console.log(`\n--- 자문 답변 (${receipt.model}) ---\n${answer}`);
  },
  // 옛 이름(2026-10-05 advisor→senior 개명). 이미 떠 있는 감독이 옛 지침대로 불러도 같은 명령이 돈다.
  advise: (argv,flags) => COMMANDS.senior(argv,flags),
  runners: (argv,flags) => console.log(JSON.stringify(runnersCommand(argv,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env}),
    record:entry=>appendLedger({...entry,t:new Date().toISOString()})}),null,2)),
  card: (argv,flags) => console.log(JSON.stringify(cardCommand(argv,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})}),null,2)),
  handover: cmdHandover,
  slot: async (argv,flags) => console.log(JSON.stringify(await slotCommand(argv,flags,{home:ledgerHome(),floor,sessionName}),null,2)),
  limit: async (argv,flags) => { const result = flags.help ? await limitCommand([],{home:ledgerHome()}) : await limitCommand(argv,{home:ledgerHome()}); if (result != null) console.log(JSON.stringify(result,null,2)); },
  plan: cmdPlan,
  init: cmdInit,
  up: cmdUp,
  adopt: cmdAdopt,
  autostart: cmdAutostart,
  start: cmdStart,
  send: cmdSend,
  done: cmdDone,
  wait: cmdWait,
  watch: cmdWatch,
  stop: cmdStop,
  status: cmdStatus,
  tree: cmdTree,
  wall: cmdWall,
  dashboard: cmdWall,
  read: cmdRead,
  log: cmdLog,
  attach: cmdAttach,
  restore: cmdRestore,
};

export function main(argv) {
  const [command, ...rest] = argv;
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(
      "사용법: kadan <init|up|adopt|autostart|plan|start|send|done|wait|watch|watch-report|stop|status|tree|wall|dashboard|read|log|attach|restore|handover|hierarchy|work|card|decision|senior|runners|storage|inbox|slot|limit> [대상] [옵션]"
    );
    process.exit(command && command !== "--help" ? 1 : 0);
  }
  const { flags, rest: args } = parseFlags(rest);
  try {
    if(['init','up','start','send','stop','done','plan','watch-report','restore'].includes(command)||command==='handover'&&!['show','list'].includes(args[0])||command==='card'&&!['list','show'].includes(args[0])||command==='decision'&&!['list','show'].includes(args[0]))assertWritable(ledgerHome());
    const result=fn(args, flags);
    if(result?.catch)return result.catch(error=>{
      console.error(`오류: ${error.message}`);
      process.exitCode=error.exitCode||1;
    });
  } catch (error) {
    console.error(`오류: ${error.message}`);
    process.exit(error.exitCode || 1);
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
if (isMain) main(process.argv.slice(2));
