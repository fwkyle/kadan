#!/usr/bin/env node
import { findDoneMarkers, diffDoneMarkers } from "./done-marker.mjs";
import { taskIdentity } from "./task-identity.mjs";
import { readLedgerState, projectLedger } from "./ledger-domains.mjs";
import { captureRuntimeVersion } from "./runtime-version.mjs";
import { watchReportCommand, watchAILabel } from "./watch-report.mjs";
import { notifyUser } from "./watch-system.mjs";
import { storageCommand } from "./storage-migration.mjs";
import { assertWritable } from "./storage.mjs";
import { SecretaryMailbox } from "./secretary-mailbox.mjs";
import { inboxCommand } from "./mailbox.mjs";
import { attachWatchOverview } from "./watch-overview.mjs";
import { defaultProfilePath } from "./watch-profile.mjs";
import { decisionCommand } from "./decisions.mjs";
import { seniorCommand } from "./senior.mjs";
import { runnersCommand } from "./runners-command.mjs";
import { CardStore } from "./card-store.mjs";
import { cardCommand } from "./card-command.mjs";
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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
import { requireWindowChoice, closeStartedWindow } from "./cli-start-support.mjs";
import { cmdStart } from "./commands/start.mjs";
import { cmdSend } from "./commands/send.mjs";
import { cmdPlan } from "./commands/plan.mjs";
import { cmdDone } from "./commands/done.mjs";
import { cmdWait } from "./commands/wait.mjs";
import { sendWatchMessage, cmdWatch } from "./commands/watch.mjs";
import { cmdStop } from "./commands/stop.mjs";
import { cmdRestore } from "./commands/restore.mjs";

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
  WATCH_ALERT_FOOTER,
  WATCH_MAIL_HUMAN_IDLE_MS,
  sendWatchMailReminder,
  sendWatchNudge,
  watchMailHold,
} from "./commands/watch.mjs";

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
