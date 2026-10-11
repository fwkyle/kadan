#!/usr/bin/env node
import { findDoneMarkers, diffDoneMarkers } from "./done-marker.mjs";
import { taskIdentity } from "./task-identity.mjs";
import { watchReportCommand } from "./watch-report.mjs";
import { notifyUser } from "./watch-system.mjs";
import { storageCommand } from "./storage-migration.mjs";
import { assertWritable } from "./storage.mjs";
import { SecretaryMailbox } from "./secretary-mailbox.mjs";
import { inboxCommand } from "./mailbox.mjs";
import { decisionCommand } from "./decisions.mjs";
import { seniorCommand } from "./senior.mjs";
import { runnersCommand } from "./runners-command.mjs";
import { CardStore } from "./card-store.mjs";
import { cardCommand } from "./card-command.mjs";
import { hierarchyCommand } from "./hierarchy-prune.mjs";
import { workCommand } from "./work-command.mjs";
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
import { createWallServer, renderWallHtml } from "./wall.mjs";
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
  sessionName,
  stripAnsi,
  lastStartFor,
  recordedPid,
  normalizeFloorRead,
  parseFlags,
} from "./cli-basics.mjs";
import { guardedSend } from "./cli-guarded-send.mjs";
import { closeStartedWindow } from "./cli-start-support.mjs";
import { cmdStart } from "./commands/start.mjs";
import { cmdSend } from "./commands/send.mjs";
import { cmdPlan } from "./commands/plan.mjs";
import { cmdDone } from "./commands/done.mjs";
import { cmdWait } from "./commands/wait.mjs";
import { sendWatchMessage, cmdWatch } from "./commands/watch.mjs";
import { cmdStop } from "./commands/stop.mjs";
import { cmdRestore } from "./commands/restore.mjs";
import { cmdStatus } from "./commands/status.mjs";
import { cmdTree, cmdWall } from "./commands/tree-wall.mjs";
import { cmdInit, cmdUp, cmdAdopt, cmdAutostart } from "./commands/quickstart.mjs";
import { cmdRead, cmdLog, cmdAttach } from "./commands/inspect.mjs";

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
export { renderLogEntry } from "./commands/inspect.mjs";

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
