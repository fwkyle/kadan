// kadan watch와 감시 편지 보내기 (HW-3-impl: cli.mjs에서 옮김)
import { captureRuntimeVersion } from "../runtime-version.mjs";
import { WatchAI } from "../watch-ai.mjs";
import { cycleReads } from "../watch-reads.mjs";
import { notifyUser } from "../watch-system.mjs";
import { storageVersion } from "../storage.mjs";
import { PROFILE_FILE } from "../watch-cycle.mjs";
import {
  defaultProfilePath,
  readWatchProfile,
  applyWatchProfile,
  watchStartupWarnings,
} from "../watch-profile.mjs";
import { DecisionStore } from "../decisions.mjs";
import { CardStore } from "../card-store.mjs";
import { WorkStore } from "../work-store.mjs";
import { parseHierarchy } from "../hierarchy.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome, readLedger } from "../ledger.mjs";
import { runWatch } from "../watch-runner.mjs";
import { die, sessionName, lastStartFor, recordedPid } from "../cli-basics.mjs";
import { guardedSend } from "../cli-guarded-send.mjs";

// 해소 우편이 없으므로(2026-10-05 [kyle]) 경보를 받은 감독은 행동 전에 지금 상태를 스스로 확인한다.
export const WATCH_ALERT_FOOTER='행동 전 지금 상태를 확인하라(감독 템플릿의 현황 확인 절차). 풀렸으면 따로 알리지 않는다.';
export function sendWatchMessage(role,message) {
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

export function cmdWatch(argv, flags) {
  const usage =
    "사용법: kadan watch [--profile <JSON파일>] [--interval 초] [--stall 횟수] [--stall-after 분] [--start-report-after 분] " +
    "[--completion-grace 분] [--idle 분] [--route <판>=<역할>]... [--super <역할>] [--hierarchy <JSON파일>] [--user-notify] " +
    "[--judge-cmd <셸 명령>] [--judge-cooldown 분]\n  --profile: 정식 명령을 담은 JSON({flags,env}). 직접 준 옵션이 우선. " +
    "옵션이 하나도 없고 $KADAN_HOME/" + PROFILE_FILE + "이 있으면 자동 적용.";
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
