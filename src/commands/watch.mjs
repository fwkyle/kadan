// kadan watch와 감시 편지 보내기 (HW-3-impl: cli.mjs에서 옮김)
import { captureRuntimeVersion } from "../runtime-version.mjs";
import { WatchAI } from "../watch-ai.mjs";
import { ExplainAI } from "../explain-ai.mjs";
import { cycleReads } from "../watch-reads.mjs";
import { createProcessCollections } from "../process-collections.mjs";
import { notifyUser, watchProcessName } from "../watch-system.mjs";
import { storageVersion } from "../storage.mjs";
import { PROFILE_FILE } from "../watch-cycle.mjs";
import {
  defaultProfilePath,
  readWatchProfile,
  applyWatchProfile,
  watchStartupWarnings,
  watchRouteNameWarnings,
} from "../watch-profile.mjs";
import { DecisionStore } from "../decisions.mjs";
import { createWatchStoreReaders } from "../watch-store-cache.mjs";
import { createWatchMailReader } from "../watch-mail-reader.mjs";
import { parseHierarchy } from "../hierarchy.mjs";
import { pruneHierarchy } from "../hierarchy-prune.mjs";
import { watchNightExpiry } from "../night.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome } from "../ledger.mjs";
import { runWatch } from "../watch-runner.mjs";
import { die, sessionName, lastStartFor, recordedPid } from "../cli-basics.mjs";
import { guardedSend } from "../cli-guarded-send.mjs";
import { HUMAN_IDLE_MS, forcedIdleMsFor, humanIdleMsFor } from "../notification-guard.mjs";
import { NotifyHoldTracker } from "../watch-notify-hold.mjs";
import { WATCH_ALERT_FOOTER } from "../watch-notice-format.mjs";

export { WATCH_ALERT_FOOTER };
// 입력 보호로 밀린 횟수는 tracker가 받는 창 단위로 센다. 5번 연속이면 guardFor가 입력 보호를 뺀다(슈퍼감독 창은 30초만 본다).
function guardedWatchSend(tracker,args,role,guard) {
  const {send,...rest}=args;
  try {
    const receipt=send({...rest,notificationGuard:tracker?tracker.guardFor(role,guard):guard});
    tracker?.delivered(role,receipt);
    return receipt;
  } catch (error) {
    // 붙여넣기는 됐고 기록만 실패한 경우도 전달이다.
    if (error.delivery==='sent') tracker?.delivered(role); else tracker?.heldIfGuard(role,error);
    throw error;
  }
}

export function sendWatchMessage(role,message,{selectedFloor=floor,readStart=lastStartFor,send=guardedSend,tracker=null,overlap=false}={}) {
  if (role==='@user') {
    const failure=notifyUser(message,spawnSync,{kind:'alert',ring:true,...(overlap?{overlap:true}:{})}).error;  // 이 길의 @user는 모두 경보(감시 AI 직행·RED 겹알림, 일반 감시기)라서 울린다.
    if (failure) { const error=new Error('사용자 알림 실패'); error.delivery='not-sent'; throw error; }
    return;
  }
  const session=sessionName(role);
  const start=readStart(session);
  // 감시 경보 우편은 기록용이다: 경보는 상태 변화로 닫히지 수신자 ack로 닫히지 않으므로 읽음 확인 안내를 붙이지 않고
  // 미확인 우편 재알림 대상에서도 뺀다(2026-10-05 [kyle] 소음 줄이기). 해소 우편도 없으므로 받는 쪽이 행동 전에
  // 지금 상태를 확인한다(감독 템플릿의 현황 확인 절차).
  return guardedWatchSend(tracker,{send,floor:selectedFloor,session,role,message:/^할 일:/mu.test(message)?message:`${message}\n할 일: ${WATCH_ALERT_FOOTER}`,
    source:'watch',recordedPid:recordedPid(start),notificationOnly:true,omitInstructions:true},role,{humanIdleMs:humanIdleMsFor(start)});
}

// 사람이 이 시간 안에 창에서 키를 눌렀으면 입력 중으로 보고 미확인 우편 알림을 미룬다.
// 2026-09-23 [kyle]: 10분은 계속 대화하는 창의 질문 알림을 너무 늦춰 30초로 줄였다. 입력창 글 검사는 그대로다.
// 이 상수는 기본(30초)일 뿐이다. 창마다 실제로 쓰는 값은 humanIdleMsFor(start)가 고른다(슈퍼감독 2분, 2026-10-22).
export const WATCH_MAIL_HUMAN_IDLE_MS = HUMAN_IDLE_MS;

export function sendWatchMailReminder(role,message,expectedPid,{
  selectedFloor=floor,readStart=lastStartFor,send=guardedSend,tracker=null,
}={}) {
  const session=sessionName(role);
  const start=readStart(session);
  if (expectedPid == null || expectedPid === '' || String(recordedPid(start)) !== String(expectedPid)) {
    const error=new Error('미확인 우편 알림 수신 세대 변경');
    error.delivery='not-sent';
    throw error;
  }
  return guardedWatchSend(tracker,{send,floor:selectedFloor,session,role,message,source:'watch',recordedPid:expectedPid,
    notificationOnly:true,omitInstructions:true},role,{humanIdleMs:humanIdleMsFor(start)});
}

// 놀고 있음 본인 알림은 감독 창에 붙여넣는 우편이라, 사람이 그 창에서 대화 중이면 미룬다.
// 사용자가 슈퍼감독과 직접 대화하는 창에 반쯤 쓴 문장 뒤에 붙지 않게 한다(2026-10-05). 읽음 재알림도 만들지 않는다.
export function sendWatchNudge(role,message,{selectedFloor=floor,readStart=lastStartFor,send=guardedSend,tracker=null}={}) {
  const session=sessionName(role);
  const start=readStart(session);
  return guardedWatchSend(tracker,{send,floor:selectedFloor,session,role,message,source:'watch',
    recordedPid:recordedPid(start),notificationOnly:true,omitInstructions:true},role,{humanIdleMs:humanIdleMsFor(start)});
}

// 바닥이 보류 조회를 지원하지 않으면 기존처럼 보류 없이 진행한다.
// 5번 연속 밀린 창은 강제 차례다. 보호가 30초인 창은 사전 확인도 건너뛰고, 슈퍼감독 창은 마지막 입력 뒤 30초를
// 사전 확인한다(2026-10-22 [kyle] 결정 B; 값은 forcedIdleMsFor 하나가 고른다). 걸리면 입력 보호 밀림으로 세어 횟수가 유지된다.
export function watchMailHold(role,{selectedFloor=floor,readStart=lastStartFor,tracker=null}={}) {
  const session=sessionName(role);
  const humanIdleMs=humanIdleMsFor(readStart(session));
  let guard={humanIdleMs};
  if (tracker?.forced(role)) {
    // 바닥이 force 표시를 보고 같은 함수로 30초로 줄인다(전송 경로 guardFor와 같은 모양으로 넘긴다).
    if (forcedIdleMsFor(humanIdleMs)===null) return null;
    guard={humanIdleMs,force:true};
  }
  const held=selectedFloor.notificationHold?.(session,guard) ?? null;
  // 입력 보호 코드만 미룸으로 센다(herdr의 프로세스 신원 미확인 같은 다른 오류는 세지 않는다).
  if (held) tracker?.heldIfGuard(role,{...held,delivery:'not-sent'});
  return held;
}

export function cmdWatch(argv, flags) {
  const usage =
    "사용법: kadan watch [--profile <JSON파일>] [--interval 초] [--stall 횟수] [--stall-after 분] [--start-report-after 분] " +
    "[--completion-grace 분] [--idle 분] [--route <판>=<역할>]... [--super <역할>] [--hierarchy <JSON파일>] [--hierarchy-prune off] [--user-notify] " +
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
    "hierarchy-prune",
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

  const prune = flags["hierarchy-prune"];
  if (prune != null && prune !== "off") die("watch --hierarchy-prune은 off만 쓸 수 있다(기본은 켬)", 2);
  let parents = new Map();
  if (flags.hierarchy != null) {
    try {
      if (typeof flags.hierarchy !== "string") throw new Error("파일 경로 하나가 필요하다");
      parents = parseHierarchy(JSON.parse(fs.readFileSync(flags.hierarchy, "utf8")));
    } catch (error) {
      die(`watch hierarchy 읽기 실패: ${error.message}`, 2);
    }
  }
  try {
    const liveNow = floor.list().filter((item) => item.alive !== false).map((item) => item.session);
    for (const line of watchRouteNameWarnings(routes, flags.super || null, liveNow)) console.error(line);
  } catch { /* 살아 있는 세션을 못 읽으면 경고만 건너뛴다 */ }
  const watchController=new AbortController();
  const stopWatch=()=>watchController.abort();
  process.once('SIGTERM',stopWatch);process.once('SIGINT',stopWatch);
  // 한 주기 안에서 원장이 바뀌지 않았으면 전체 읽기를 재사용한다. 감시AI 보고도 같은 읽기를 쓴다.
  const stores = createWatchStoreReaders(ledgerHome());
  let mailRoles = [];
  const mailReader = createWatchMailReader(ledgerHome(), null, {
    readCards:stores.cards.read, readWorks:stores.works.read, readRoles:() => mailRoles,
  });
  const reads=cycleReads({readEntries:mailReader.readEntries,readCards:stores.cards.read,
    readWorks:stores.works.read,version:()=>storageVersion(ledgerHome())});
  const record=entry => appendLedger({ ...entry, t: new Date().toISOString() });
  const holdTracker=new NotifyHoldTracker({record});
  const processName=watchProcessName(ledgerHome());
  const collections = createProcessCollections();
  if(processName!=='kadan-watch')console.log(`감시 프로세스 이름: ${processName}`);
  return runWatch({
    collections,
    runtime:captureRuntimeVersion(),
    floor,
    readEntries: reads.readEntries,
    readMailLetters: mailReader.letters,
    projectEntries: mailReader.project,
    rememberObservedRoles: roles => { mailRoles = roles; },
    readCards: reads.readCards,
    readWorks: reads.readWorks,
    readDecisions: () => new DecisionStore(ledgerHome()).list(),
    reads,
    startReportGraceMs: startReportMinutes*60_000,
    completionGraceMs: completionGraceMinutes*60_000,
    stallAfterMs: stallAfterMinutes*60_000,
    record,
    holdTracker,
    sendAlert: (role,message,extra)=>sendWatchMessage(role,message,{tracker:holdTracker,...extra}),
    sendNudge: (role,message)=>sendWatchNudge(role,message,{tracker:holdTracker}),
    sendMailReminder: (role,message,expectedPid)=>sendWatchMailReminder(role,message,expectedPid,{tracker:holdTracker}),
    mailHold: role=>watchMailHold(role,{tracker:holdTracker}),
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
    ai: flags['judge-cmd'] ? new WatchAI({home:ledgerHome(),floor,send:(role,message,extra)=>sendWatchMessage(role,message,{tracker:holdTracker,...extra}),readEntries:reads.readEntries,readCards:reads.readCards,readWorks:reads.readWorks}) : null,
    explain: new ExplainAI({home:ledgerHome(),print:console.log,collections}),
    hierarchyPath: flags.hierarchy ? path.resolve(flags.hierarchy) : null,
    profilePath: profileFile,
    intervalMs: intervalSeconds * 1000,
    stallN,
    routes,
    superRole: flags.super || null,
    parents,
    loadHierarchy: flags.hierarchy ? () => {
      const text = fs.readFileSync(flags.hierarchy, "utf8");
      parents = parseHierarchy(JSON.parse(text));
      return { parents, path: path.resolve(flags.hierarchy), hash: createHash("sha256").update(text).digest("hex") };
    } : null,
    pruneHierarchy: flags.hierarchy && prune !== "off"
      ? ({file, now}) => pruneHierarchy({home: ledgerHome(), floor, file, apply: true, now: () => now})
      : null,
    checkNightExpiry: ({entries, now}) => watchNightExpiry({entries, now, home: ledgerHome()}),
    idleMs: idleMinutes * 60 * 1_000,
    userNotify: flags["user-notify"] === true,
    judgeCmd: flags["judge-cmd"] || null,
    judgeCooldownMs: judgeCooldownMinutes * 60 * 1_000,
    signal:watchController.signal,
  }).finally(()=>{
    collections.close();
    process.removeListener('SIGTERM',stopWatch);process.removeListener('SIGINT',stopWatch);
  });
}
