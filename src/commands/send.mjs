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
      '[--mailbox] [--expect-reply] [--reply-to <우편ID>] [--reply-final] [--raw] <메시지...> ' +
      '(메시지 생략 시 표준 입력). 우편 전용이며 --task는 금지, --execution으로 발령하지 않습니다.';
  }
  if (command === 'dispatch') {
    return '사용법: kadan dispatch <역할> --task <카드ID> [--work <업무키>] ' +
      '[--execution <실행키>] [--allow-old-runner <이유>] [--raw] <지시...> ' +
      '(지시 생략 시 표준 입력). 카드 발령 전용이며 질문·답장·저장 우편은 mail을 사용하세요.';
  }
  return '사용법: kadan send <역할> [--task <카드id>] [--work <업무키>] ' +
    '[--execution <실행키>] [--allow-old-runner <이유>] [--raw] [--mailbox] ' +
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
  if((role==='비서'||flags.mailbox)&&flags.task)throw new Error('저장 우편은 작업 발령이 아닙니다. --task를 사용하지 마세요');
  const argText = argv.slice(1).join(" ");
  const input = argText || fs.readFileSync(0, "utf8");
  const message = flags.raw || argText ? input : input.replace(/\n+$/, "");
  if (!message) die("보낼 메시지가 비어 있다");
  if(role==='비서'||flags.mailbox===true){
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
    const peer = taskId == null && isPeerSuperMail(entries, readActiveHierarchy(entries), by, recipient);
    if (peer && flags.raw) throw new Error('슈퍼 간 우편은 입력 보호를 거쳐 전달하거나 보관해 안전하게 알립니다. --raw 없이 보내세요');
    const peerStore = () => {
      const stored = new Mailbox(ledgerHome(), recipient).send({
        by, message, category:flags['mail-kind'] || 'report', ...mailContext,
      });
      console.log(JSON.stringify({...stored, wake:'watch-required',
        note:'우편 보관됨. 감시기가 안전한 입력 대기 때 알립니다. 저장은 착수·완료가 아닙니다.'}));
    };
    const expectedPid=recordedPid(lastStartFor(session));
    // 슈퍼 간 우편도 바로 넣되 감시기와 같은 입력 보호를 붙인다(2026-10-13 [kyle]). 시작 기록이 없거나
    // 세션이 없거나 보호에 걸리면 넣지 않고 지금처럼 보관해 감시기에 맡긴다.
    if (peer && !expectedPid) return peerStore();
    if (recipient!==role && !expectedPid) {
      const error=new Error(`답장 수신 책임자 ${recipient}의 시작 기록/PID가 없습니다`);
      error.delivery='not-sent';throw error;
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
      // 붙여넣기 전에 멈춘 실패(입력 보호·세션 없음·PID 변경 등 delivery=not-sent)만 보관으로 돌린다.
      // 전달이 됐거나 불명확하면(sent·unknown) 중복 방지를 위해 그대로 실패다.
      if (peer && error.delivery === 'not-sent' && error.code !== 'KADAN_MAIL_RECIPIENT_CHANGED') return peerStore();
      // 슈퍼 간이 아닌 일반 우편도 사람 입력·복사 모드 보류만 보관한다(종료 0). 보낸 AI가 --mailbox로 우회해
      // 알림이 묻히는 것을 막고, 저장 전용 우편은 감시기가 다음 순회에 알린다. 세션 없음·PID 변경·발령·--raw·sent/unknown은 그대로 실패다.
      if (!peer && command === 'mail' && taskId == null && flags.raw !== true
        && isStorableMailHold(error)) return peerStore();
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

// 완료 통지를 보낸 작업자가 화면 DONE을 빠뜨리는 일이 잦다(2026-09-23 밤 작업자 10명 중 5명, 2026-09-24 kimi 검수자).
// 완성된 마커는 쓰지 않는다 — 보낸 쪽 화면에 찍혀 입력 에코처럼 완료로 오판된다(잠긴 규칙 6).
export function doneHintFor(pending) {
  if (!pending?.length) return null;
  return `이 작업을 끝냈다면 응답 마지막 줄에 완료 표시를 출력하라 — 형식 KADAN:DONE <카드id> <ok|failed>, 열린 카드 id: ${pending.join(", ")}`;
}
