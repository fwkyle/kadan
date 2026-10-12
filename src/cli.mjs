#!/usr/bin/env node
import { findDoneMarkers, diffDoneMarkers } from "./done-marker.mjs";
import { taskIdentity } from "./task-identity.mjs";
import { watchReportCommand } from "./watch-report.mjs";
import { storageCommand } from "./storage-migration.mjs";
import { assertWritable } from "./storage.mjs";
import { inboxCommand } from "./mailbox.mjs";
import { decisionCommand } from "./decisions.mjs";
import { seniorCommand } from "./senior.mjs";
import { runnersCommand } from "./runners-command.mjs";
import { CardStore } from "./card-store.mjs";
import { cardCommand } from "./card-command.mjs";
import { hierarchyCommand } from "./hierarchy-prune.mjs";
import { workCommand } from "./work-command.mjs";
import { slotCommand } from "./review-slots.mjs";
import { limitCommand } from "./heavy-limit.mjs";
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
  recordedPid,
  normalizeFloorRead,
  parseFlags,
} from "./cli-basics.mjs";
import { guardedSend } from "./cli-guarded-send.mjs";
import { cmdStart } from "./commands/start.mjs";
import { cmdSend } from "./commands/send.mjs";
import { cmdPlan } from "./commands/plan.mjs";
import { cmdDone } from "./commands/done.mjs";
import { cmdWait } from "./commands/wait.mjs";
import { sendWatchMessage, cmdWatch } from "./commands/watch.mjs";
import { cmdStop } from "./commands/stop.mjs";
import { cmdRestore } from "./commands/restore.mjs";
import { recoveryCommand } from "./recovery.mjs";
import { cmdStatus } from "./commands/status.mjs";
import { cmdTree, cmdWall } from "./commands/tree-wall.mjs";
import { cmdInit, cmdUp, cmdAdopt, cmdAutostart } from "./commands/quickstart.mjs";
import { cmdRead, cmdLog, cmdAttach } from "./commands/inspect.mjs";
import { cmdHandover } from "./commands/handover.mjs";

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
export { createHandoverRunner } from "./commands/handover.mjs";

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
  limit: async (argv,flags) => {
    const result = flags.help ? await limitCommand([],{home:ledgerHome()}) : await limitCommand(argv,{home:ledgerHome()});
    if (result != null) console.log(JSON.stringify(result,null,2));
  },
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
  recovery: recoveryCommand,
};

export function main(argv) {
  const [command, ...rest] = argv;
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(
      "사용법: kadan <init|up|adopt|autostart|plan|start|send|done|wait|watch|watch-report|stop|status|tree|wall|dashboard|" +
        "read|log|attach|restore|recovery|handover|hierarchy|work|card|decision|senior|runners|storage|inbox|slot|limit> [대상] [옵션]"
    );
    process.exit(command && command !== "--help" ? 1 : 0);
  }
  const { flags, rest: args } = parseFlags(rest);
  try {
    if(
      ['init','up','start','send','stop','done','plan','watch-report','restore'].includes(command)||
      command==='handover'&&!['show','list'].includes(args[0])||
      command==='card'&&!['list','show'].includes(args[0])||
      command==='decision'&&!['list','show'].includes(args[0])
    )assertWritable(ledgerHome());
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
