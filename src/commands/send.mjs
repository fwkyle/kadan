// kadan send (HW-3-impl: cli.mjs에서 옮김)
import { taskIdentity } from "../task-identity.mjs";
import { notifyUser } from "../watch-system.mjs";
import { WorkStore } from "../work-store.mjs";
// 업무 키를 알 때만 레포 포럼 글로 간다: --work, 없으면 --execution이 속한 업무. 못 찾으면 기본 채널.
const mailWork=flags=>{if(typeof flags.work==="string")return flags.work.replace(/^work:/,"");
  if(typeof flags.execution!=="string")return undefined;
  try{return new WorkStore(ledgerHome()).list().find(w=>w.executions.some(x=>x.key===flags.execution))?.key}catch{return undefined}};
// 편지에 레포 근거가 있을 때만(--execution 키 앞부분) 첫머리에 [레포]를 붙인다. 업무 키는 notifyUser가 알아서 쓴다.
const mailRepo=flags=>typeof flags.execution==="string"&&flags.execution.includes("/")?flags.execution.split("/")[0]:undefined;
import { isUserActor } from "../actors.mjs";
import { Mailbox } from "../mailbox.mjs";
import { CardStore } from "../card-store.mjs";
import { resolveWorkMail, inferDispatchTask } from "../work-mail.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { floor } from "../floor.mjs";
import { ledgerHome, readLedger, resolveLedgerBy } from "../ledger.mjs";
import { tmux } from "../floor-tmux.mjs";
import { die, sessionName, lastStartFor, recordedPid } from "../cli-basics.mjs";
import { guardedSend } from "../cli-guarded-send.mjs";
import { pendingCardsFor } from "../cli-start-support.mjs";
import { readActiveHierarchy } from "../hierarchy-register.mjs";
import { isPeerSuperMail } from "../peer-mail.mjs";
import { HUMAN_IDLE_MS, isStorableMailHold } from "../notification-guard.mjs";

export function cmdSend(argv, flags) {
  return deliverMessage(argv, flags, 'send');
}

export function cmdMail(argv, flags) {
  return deliverMessage(argv, flags, 'mail');
}

export function cmdDispatch(argv, flags) {
  return deliverMessage(argv, flags, 'dispatch');
}

function usage(command) {
  if (command === 'mail') {
    return '사용법: kadan mail <역할> [--work <업무키>] [--execution <실행키>] ' +
      '[--expect-reply] [--reply-to <우편ID>] [--reply-final] [--raw] <메시지...> ' +
      '(메시지 생략 시 표준 입력). 우편 전용이며 --task는 금지, --execution으로 발령하지 않습니다.';
  }
  if (command === 'dispatch') {
    return '사용법: kadan dispatch <역할> --task <카드ID> [--work <업무키>] ' +
      '[--execution <실행키>] [--allow-old-runner <이유>] [--raw] <지시...> ' +
      '(지시 생략 시 표준 입력). 카드 발령 전용이며 질문·답장·저장 우편은 mail을 사용하세요.';
  }
  return '사용법: kadan send <역할> [--task <카드id>] [--work <업무키>] ' +
    '[--execution <실행키>] [--allow-old-runner <이유>] [--raw] ' +
    '[--expect-reply] [--reply-to <우편ID>] [--reply-final] <메시지...> (메시지 생략 시 표준 입력). ' +
    '기존 호환 명령입니다. --execution도 조건에 따라 발령으로 추론합니다. ' +
    '새 우편은 mail, 명시 발령은 dispatch --task를 사용하세요.';
}

function deliverMessage(argv, flags, command) {
  if (command !== 'send' && flags.help) {
    console.log(usage(command));
    return;
  }
  const role = argv[0];
  if (!role) die(usage(command));
  // 의도 검사는 본문 읽기·우편 저장·전송보다 먼저 한다. 기존 send의 해석은 그대로 둔다.
  if (command === 'mail' && Object.hasOwn(flags, 'task')) {
    throw new Error('mail은 --task를 받지 않습니다. 작업 발령은 dispatch --task를 사용하세요');
  }
  if (command === 'dispatch') {
    if (typeof flags.task !== 'string' || !/^\S+$/.test(flags.task)) {
      throw new Error('dispatch는 --task <카드ID> 한 개가 필요합니다');
    }
    if (['expect-reply', 'reply-to', 'reply-final'].some(flag => Object.hasOwn(flags, flag))) {
      throw new Error('dispatch는 질문·답장을 받지 않습니다. mail을 사용하세요');
    }
  }
  const storeOnly=isStoreOnlyRecipient(role);
  if(storeOnly&&flags.task)throw new Error('저장 우편은 작업 발령이 아닙니다. --task를 사용하지 마세요');
  const flagWarning=mailboxFlagWarning(role,flags);
  if(flagWarning)console.error(flagWarning);
  const argText = argv.slice(1).join(" ");
  const input = argText || fs.readFileSync(0, "utf8");
  const message = flags.raw || argText ? input : input.replace(/\n+$/, "");
  if (!message) die("보낼 메시지가 비어 있다");
  if(storeOnly){
    if (flags.raw) throw new Error('저장 우편함은 --raw 대상이 아닙니다. 원문은 항상 보존됩니다');
    const by=resolveLedgerBy({env:process.env});
    const receipt=new Mailbox(ledgerHome(),role).send({
      by,message,category:flags['mail-kind']||'report',replyTo:flags['reply-to'],workKey:flags.work,
      executionKey:flags.execution,expectReply:flags['expect-reply']===true,replyFinal:flags['reply-final']===true
    });
    // 사용자 우편함에 온 편지(대시보드 질문의 답 등)는 OS 알림으로도 알린다(2026-10-07 [kyle]). 알림 실패는 저장을 막지 않는다.
    // 시험은 KADAN_NOTIFY=off로 끈다(시험을 돌릴 때마다 진짜 알림이 뜨지 않게).
    if(isUserActor(role)&&!isUserActor(by)&&process.env.KADAN_NOTIFY!=='off')
      notifyUser(`카단 · ${by}의 ${flags['reply-final']?'답':'편지'}: ${message.split('\n').find(line=>line.trim())?.trim().slice(0,120)??''}`,spawnSync,{kind:'mail',work:mailWork(flags),tagRepo:mailRepo(flags),key:receipt?.mailId?`mail:${receipt.mailId}`:undefined});
    console.log(JSON.stringify(receipt));return;
  }

  let receipt;
  try {
    // 기존 send만 --execution의 발령 추론을 유지한다. mail은 연결 주소로만 사용하며,
    // dispatch는 앞에서 검증한 명시 --task로 기존 발령 검사를 거친다.
    let taskId=flags.task;
    if(command === 'send' && taskId==null){
      const inferred=inferDispatchTask(ledgerHome(),{executionKey:flags.execution,role,replyTo:flags['reply-to'],expectReply:flags['expect-reply']===true});
      if(inferred){taskId=inferred;new CardStore(ledgerHome()).checkSend(taskId,role);console.error(`실행 연결 ${flags.execution}은(는) ${role}의 발령 카드입니다 — taskId로 기록합니다. 명시 발령은 --task <카드id>를 사용하세요`);}
    }
    const mailContext=resolveWorkMail(ledgerHome(),{
      workKey:flags.work,executionKey:flags.execution,replyTo:flags['reply-to'],taskId,
      by:resolveLedgerBy({env:process.env}),role,expectReply:flags['expect-reply']===true,replyFinal:flags['reply-final']===true
    });
    const recipient=mailContext.currentRecipient||role,session=sessionName(recipient);
    const by = resolveLedgerBy({env:process.env});
    const entries = readLedger();
    // 바로 넣을 수 없어 보관할 수 있는 우편: 발령(--task)·--raw는 보관하지 않는다.
    const storable = taskId == null && flags.raw !== true;
    // 슈퍼 간 우편만 감시기 알림과 같은 입력 보호를 붙인다(2026-10-13 [kyle]). 보관·실패 규칙은 모든 우편이 같다.
    // herdr에서는 이 보호(대기 화면 30초 안정, 응답 중 거부)가 일반 우편(응답 중에도 입력 대기열에 넣음)보다 엄격하다.
    // 모두에게 붙이면 응답 중인 수신자 앞 즉시 전달이 사라져 '바로 넣기 vs 저장 우선'(kyle 미결정)을 바꾸므로 붙이지 않았다.
    const peer = taskId == null && isPeerSuperMail(entries, readActiveHierarchy(entries), by, recipient);
    if (peer && flags.raw) throw new Error('슈퍼 간 우편은 입력 보호를 거쳐 전달하거나 보관해 안전하게 알립니다. --raw 없이 보내세요');
    const store = reason => {
      console.error(`바로 넣지 못해 보관했습니다: ${reason}`);
      const stored = new Mailbox(ledgerHome(), recipient).send({
        by, message, category:flags['mail-kind'] || 'report', ...mailContext,
      });
      console.log(JSON.stringify({...stored, wake:'watch-required',
        note:'우편 보관됨. 감시기가 안전한 입력 대기 때 알립니다. 저장은 착수·완료가 아닙니다.'}));
    };
    const expectedPid=recordedPid(lastStartFor(session));
    if (!expectedPid) {
      if (recipient!==role) {
        const error=new Error(`답장 수신 책임자 ${recipient}의 시작 기록/PID가 없습니다`);
        error.delivery='not-sent';throw error;
      }
      // 시작 기록이 없고 세션도 없으면: 아는 역할은 보관하고, 모르는 역할(오타)은 조용히 저장하지 않고 실패한다.
      if (storable && !sessionAlive(session)) {
        if (isKnownRole(entries, readActiveHierarchy(entries), role)) return store(`세션 없음: ${session}`);
        throw new Error(`알 수 없는 역할: ${role} — 시작 기록도 책임 관계도 없습니다. 역할 이름을 확인하세요`);
      }
    }
    try {
      receipt = guardedSend({
        floor,
        session,
        role:recipient,
        message,
        taskId,
        mailContext,
        raw:flags.raw===true,
        allowOldRunner:flags["allow-old-runner"],
        recordedPid: expectedPid,
        busyMail: true,
        ...(peer ? {notificationGuard:{humanIdleMs:HUMAN_IDLE_MS}} : {}),
      });
    } catch (error) {
      // 붙여넣기 전에 멈춘 실패(입력 보호 보류·세션 없음·PID 변경)는 보관으로 돌린다(종료 0).
      // 전달이 됐거나 불명확하면(sent·unknown) 중복 방지를 위해, 수신자 변경·역할 지침 오류·발령·--raw는 보관할 수 없어 그대로 실패다.
      if (storable && isStorableMailHold(error)) return store(error.message);
      throw error;
    }
  } catch (error) {
    die(error.delivery==="sent"?`전달은 됐지만 기록 반영 실패: ${error.message}. 자동 재시도하지 마세요`:error.message, error.exitCode || 1);
  }
  console.log(
    `${floor.name === "tmux" ? "키 전송됨" : "전달됨"}: ${receipt.session} (${receipt.bytes}B, 지문 ${receipt.digest}, 우편ID ${receipt.mailId})` +
    `${floor.name === "tmux" ? " — 입력 접수·AI 실행 미확인" : ""}${receipt.executionKey?` — 실행 ${receipt.executionKey}`:""}` +
    ` — 받는 쪽에 붙인 역할 지침 ${receipt.roleInstructions.status==='applied'?receipt.roleProfile:`적용 안 됨 (${receipt.roleInstructions.reason})`}`
  );
  // 보낸 쪽이 카단 역할이고 열린 카드가 있으면, 응답을 끝내기 직전 읽는 이 출력에 완료 표시 형식을 알린다.
  // 질문(--expect-reply)은 작업 중이므로 알리지 않는다. 조회 실패는 전송 결과를 바꾸지 않고 안내만 생략한다.
  const sender=process.env.KADAN_ROLE;
  if(sender&&sessionName(sender)!==receipt.session&&flags['expect-reply']!==true){
    let pending=[];
    try{pending=pendingCardsFor(taskIdentity(new CardStore(ledgerHome()).listSummaries()).project(readLedger()),sender);}catch{}
    const hint=doneHintFor(pending);
    if(hint)console.log(hint);
  }
}

// 비서와 사람 앞 우편은 지금처럼 저장 전용이다(받는 세션이 없다).
export const isStoreOnlyRecipient = role => role === '비서' || isUserActor(role);

// 예전 --mailbox(보내는 쪽이 고르는 저장)는 더 이상 쓰지 않는다. 거절하면 옛 지침을 가진 에이전트의 보내기가 깨지므로
// 받되 무시하고 알린다: 바로 넣기를 시도하고, 막히면 자동으로 보관한다. 비서·사람 앞은 원래 저장 전용이라 알리지 않는다.
export function mailboxFlagWarning(role, flags) {
  if (flags.mailbox === undefined || isStoreOnlyRecipient(role)) return null;
  return '--mailbox는 더 이상 쓰지 않습니다 — 바로 넣기를 시도하고, 막히면 자동으로 보관합니다';
}

// 시작 기록이 한 번이라도 있거나 활성 책임 관계(계층표)에 있는 역할만 아는 역할이다. 오타를 조용히 저장하지 않으려는 구분.
export function isKnownRole(entries, hierarchy, role) {
  const session = sessionName(role);
  if (entries.some(e => ['start', 'stop'].includes(e.kind) && (e.session === session || e.role === role))) return true;
  return hierarchy != null && (Object.hasOwn(hierarchy, role) || Object.values(hierarchy).includes(role));
}

function sessionAlive(session) {
  try { return floor.alive(session) === true; } catch { return false; }
}

// 완료 통지를 보낸 작업자가 화면 DONE을 빠뜨리는 일이 잦다(2026-09-23 밤 작업자 10명 중 5명, 2026-09-24 kimi 검수자).
// 완성된 마커는 쓰지 않는다 — 보낸 쪽 화면에 찍혀 입력 에코처럼 완료로 오판된다(잠긴 규칙 6).
export function doneHintFor(pending) {
  if (!pending?.length) return null;
  return `이 작업을 끝냈다면 응답 마지막 줄에 완료 표시를 출력하라 — 형식 KADAN:DONE <카드id> <ok|failed>, 열린 카드 id: ${pending.join(", ")}`;
}
