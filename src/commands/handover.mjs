// kadan handover와 인계 실행기 (HW-3-impl: cli.mjs에서 옮김)
import { notifyUser } from "../watch-system.mjs";
import { SecretaryMailbox } from "../secretary-mailbox.mjs";
import { Handover } from "../handover.mjs";
import { HandoverRunner } from "../handover-runner.mjs";
import { spawnSync } from "node:child_process";
import { floor } from "../floor.mjs";
import { appendLedger, ledgerHome, readLedger, resolveLedgerBy } from "../ledger.mjs";
import { sessionName, lastStartFor, recordedPid } from "../cli-basics.mjs";
import { guardedSend } from "../cli-guarded-send.mjs";
import { closeStartedWindow } from "../cli-start-support.mjs";

export function createHandoverRunner() {
  const operation = new Handover({ home: ledgerHome(), floor, readEntries: readLedger,
    record: entry => appendLedger({ ...entry, by: resolveLedgerBy({env:operation.env}) }),
    start: (role, command, cwd, roleProfile) => {
      let window = process.env.KADAN_WINDOW;
      if (!window) window = process.env.KADAN_ROTTIE_BIN ? "rottie" : "none";
      const result = spawnSync(process.execPath, [new URL("../cli.mjs", import.meta.url).pathname, "start", role, "--cmd", command,...(roleProfile?['--profile',roleProfile]:[]),"--reason","인계: 선임 실행 명령 유지"],
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

export function cmdHandover(argv, flags) {
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
