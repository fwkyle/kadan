// kadan send (HW-3-impl: cli.mjs에서 옮김)
import { taskIdentity } from "../task-identity.mjs";
import { notifyUser } from "../watch-system.mjs";
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

export function cmdSend(argv, flags) {
  const role = argv[0];
  if (!role) {
    die("사용법: kadan send <역할> [--task <카드id>] [--work <업무키>] [--execution <실행키>] [--allow-old-runner <이유>] " +
      "[--raw] [--mailbox] [--expect-reply] [--reply-to <우편ID>] [--reply-final] <메시지...> (메시지 생략 시 표준 입력). " +
      "--task는 작업 발령이고 --work·--execution은 우편의 연결 주소다");
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
      notifyUser(`카단 · ${by}의 ${flags['reply-final']?'답':'편지'}: ${message.split('\n').find(line=>line.trim())?.trim().slice(0,120)??''}`,spawnSync);
    console.log(JSON.stringify(receipt));return;
  }

  let receipt;
  try {
    // --execution만 쓴 발령은 taskId 없이 기록되어 감시에서 빠진다. 수신 역할의 발령 카드로
    // 확인될 때만 taskId를 추론해 채운다. 답장·다른 담당의 실행 연결은 그대로 둔다.
    let taskId=flags.task;
    if(taskId==null){
      const inferred=inferDispatchTask(ledgerHome(),{executionKey:flags.execution,role,replyTo:flags['reply-to'],expectReply:flags['expect-reply']===true});
      if(inferred){taskId=inferred;new CardStore(ledgerHome()).checkSend(taskId,role);console.error(`실행 연결 ${flags.execution}은(는) ${role}의 발령 카드입니다 — taskId로 기록합니다. 명시 발령은 --task <카드id>를 사용하세요`);}
    }
    const mailContext=resolveWorkMail(ledgerHome(),{
      workKey:flags.work,executionKey:flags.execution,replyTo:flags['reply-to'],taskId,
      by:resolveLedgerBy({env:process.env}),role,expectReply:flags['expect-reply']===true,replyFinal:flags['reply-final']===true
    });
    const recipient=mailContext.currentRecipient||role,session=sessionName(recipient);
    const expectedPid=recordedPid(lastStartFor(session));
    if (recipient!==role && !expectedPid) {
      const error=new Error(`답장 수신 책임자 ${recipient}의 시작 기록/PID가 없습니다`);
      error.delivery='not-sent';throw error;
    }
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
    });
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
