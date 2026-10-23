#!/usr/bin/env node
import { findDoneMarkers, diffDoneMarkers } from "./done-marker.mjs";
import { taskIdentity } from "./task-identity.mjs";
import { watchReportCommand } from "./watch-report.mjs";
import { storageCommand } from "./storage-migration.mjs";
import { assertWritable } from "./storage.mjs";
import { inboxCommand } from "./mailbox.mjs";
import { decisionCommand } from "./decisions.mjs";
import { nightCommand, nightOriginalText } from "./commands/night.mjs";
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
import { cmdSend, cmdMail, cmdDispatch } from "./commands/send.mjs";
import { cmdPlan } from "./commands/plan.mjs";
import { cmdDone } from "./commands/done.mjs";
import { cmdWait } from "./commands/wait.mjs";
import { sendWatchMessage, cmdWatch } from "./commands/watch.mjs";
import { cmdStop } from "./commands/stop.mjs";
import { cmdRestore } from "./commands/restore.mjs";
import { cmdRestart } from "./commands/restart.mjs";
import { cmdClaude } from "./commands/claude.mjs";
import { cmdWindow } from "./commands/window.mjs";
import { cmdNotify } from "./commands/notify.mjs";
import { cmdStopHook } from "./commands/stop-hook.mjs";
import { cmdSecrets } from "./commands/secrets.mjs";
import { cmdDiscord } from "./commands/discord.mjs";
import { adoptMachineWindow } from "./window-setting.mjs";
import { recoveryCommand } from "./recovery.mjs";
import { formatFullHelp, formatShortHelp } from "./command-help.mjs";
import { cmdStatus } from "./commands/status.mjs";
import { cmdTree, cmdWall } from "./commands/tree-wall.mjs";
import { cmdInit, cmdUp, cmdAdopt, cmdAutostart } from "./commands/quickstart.mjs";
import { cmdDoctor } from "./commands/doctor.mjs";
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


// 사람이 읽는 한 줄은 stderr에만 낸다. stdout은 JSON 그대로라 읽는 쪽이 깨지지 않는다.
function printWorkResult(args,result){
  if(args[0]==='create'&&Number.isInteger(result?.ownerOpenWorks))
    console.error(`책임 감독 ${result.owner}의 열린 업무 ${result.ownerOpenWorks}건 (이 업무 포함)`);
  console.log(JSON.stringify(result,null,2));
}

export const COMMANDS = {
  help:(args,flags)=>console.log(flags.all?formatFullHelp():formatShortHelp()),
  hierarchy:(args,flags)=>console.log(JSON.stringify(hierarchyCommand(args,flags,{home:ledgerHome(),floor}),null,2)),
  work:async(args,flags)=>printWorkResult(args,await workCommand(args,flags,{
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
  })),
  'watch-report':(args,flags)=>console.log(JSON.stringify(watchReportCommand(args,flags,{home:ledgerHome(),floor,send:sendWatchMessage}),null,2)),
  storage:(args,flags)=>console.log(JSON.stringify(storageCommand(args,flags,{home:ledgerHome()}),null,2)),
  inbox:(args,flags)=>console.log(JSON.stringify(inboxCommand(args,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})}),null,2)),
  decision: (argv,flags) => console.log(JSON.stringify(decisionCommand(argv,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})}),null,2)),
  night: (argv,flags) => {
    const result=nightCommand(argv,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})});
    // 기본 출력은 JSON 한 덩어리다(다른 명령처럼 스크립트·대시보드가 읽는다). 줄바꿈 그대로의 원문은 status --text에서만 낸다.
    console.log(argv[0]==='status'&&flags.text===true?nightOriginalText(result):JSON.stringify(result,null,2));
  },
  senior: async (argv,flags) => {
    const result=await seniorCommand(argv,flags,{home:ledgerHome(),by:resolveLedgerBy({env:process.env})});
    if (typeof result==='string') { console.log(result); return; }
    // 모델별로 나눠 보인다: 영수증(JSON)에는 답을 빼고, 답은 칸마다 이어서 쓴다.
    const {answers,...rest}=result;
    console.log(JSON.stringify({...rest,answers:answers.map(({answer,...receipt})=>receipt)},null,2));
    for(const a of answers)console.log(`\n--- 시니어 ${a.runner}/${a.model}/${a.effort} · ${a.status} ---\n${a.answer??'(답 없음 — 증거 폴더 참고)'}`);
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
  doctor: cmdDoctor,
  start: cmdStart,
  send: cmdSend,
  mail: cmdMail,
  dispatch: cmdDispatch,
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
  restart: cmdRestart,
  claude: cmdClaude,
  window: cmdWindow,
  notify: cmdNotify,
  "stop-hook": cmdStopHook,
  secrets: cmdSecrets,
  discord: cmdDiscord,
  recovery: recoveryCommand,
};

export function main(argv) {
  const [command, ...rest] = argv;
  const fn = COMMANDS[command];
  if (!command || command === "--help") {
    console.log(formatShortHelp());
    process.exit(0);
  }
  if (!fn) {
    console.error(`모르는 명령: ${command}\n\n${formatShortHelp()}`);
    process.exit(1);
  }
  const { flags, rest: args } = parseFlags(rest, command === 'discord' && rest[0] === 'send' ? {booleans: ['quiet']} : command === 'night' ? {booleans: ['text']} : command === 'claude' ? {booleans: ['json','no-accounts','yes']} : command === 'decision' ? {booleans: ['chat']} : undefined);
  try {
    // 환경변수에 없는 창 선택·로티 경로는 기계 설정으로 채운다. window 명령은 둘을 따로 보여 주려고, 도움말은 홈을 읽을 이유가 없어 건너뛴다.
    if (command !== 'window' && command !== 'help' && !flags.help) adoptMachineWindow(process.env, ledgerHome());
    if(
      ['init','up','start','send','mail','dispatch','stop','done','plan','watch-report','restore','restart'].includes(command)||
      command==='handover'&&!['show','list'].includes(args[0])||
      command==='card'&&!['list','show'].includes(args[0])||
      command==='decision'&&!['list','show'].includes(args[0])||
      command==='night'&&['on','off'].includes(args[0])
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
