// 보내기 직전 점검(guardedSend)과 편지 카드 첨부·미리보기 (HW-3-impl: cli.mjs에서 옮김)
import { findDoneMarkers } from "./done-marker.mjs";
import { taskIdentity } from "./task-identity.mjs";
import { assertWritable, storageTransaction } from "./storage.mjs";
import {
  composeRoleInstructions,
  inferCardPhaseProfile,
  inferDispatchProfile,
} from "./role-instructions.mjs";
import { composeMailInstructions } from "./mail-instructions.mjs";
import { CardStore } from "./card-store.mjs";
import { resolveWorkMail } from "./work-mail.mjs";
import { inspectCardSendIdentity } from "./ai-identity.mjs";
import { inspectDispatchRunnerGuard } from "./dispatch-runner-guard.mjs";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { floor } from "./floor.mjs";
import {
  appendLedger,
  saveMailBody,
  readMailBody,
  ledgerHome,
  readLedger,
  resolveLedgerBy,
} from "./ledger.mjs";
import { stripAnsi, digest, recordedPid } from "./cli-basics.mjs";
import { familyConflictAlerts } from "./cli-family.mjs";

export function guardedSend({
  floor: selectedFloor,
  session,
  role,
  message,
  taskId,
  mailContext,
  roleProfile,
  raw = false,
  notificationOnly = false,
  notificationGuard,
  busyMail = false,
  source,
  allowOldRunner,
  env = process.env,
  recordedPid: expectedPid,
  record = appendLedger,
  readEntries = readLedger,
  saveBody = saveMailBody,
}) {
  assertWritable(env.KADAN_HOME||env.KADAN_LITE_HOME||ledgerHome());
  if (typeof notificationOnly !== 'boolean') throw new Error('notificationOnly는 boolean이어야 합니다');
  if (taskId != null && (typeof taskId !== "string" || !/^\S+$/.test(taskId))) {
    throw new Error("taskId는 공백 없는 한 덩어리여야 한다");
  }
  if(raw&&mailContext?.expectReply)throw new Error('--raw는 원문 보존 옵션이므로 --expect-reply와 함께 사용할 수 없습니다');
  if(taskId!=null&&mailContext?.replyFinal)throw new Error('최종 답변은 --task 발령과 함께 사용할 수 없습니다');
  const home=env.KADAN_HOME||env.KADAN_LITE_HOME||ledgerHome();
  const by=resolveLedgerBy({source,env});
  // 이번 시도의 읽기 결과만 공유한다. 전송 직전 생존·답장 수신자 확인은 따로 한다.
  let entries;
  try { entries = readEntries(); }
  catch (error) { entries = [{broken:`원장 읽기 실패: ${error.message}`}]; }
  let cards;
  const resolveReplyContext=(snapshot)=>{
    const resolved=resolveWorkMail(home,{...mailContext,taskId,by,role},snapshot);
    if (resolved.currentRecipient && resolved.currentRecipient !== role) {
      const error=new Error(`답장 수신 책임자가 ${role}에서 ${resolved.currentRecipient}(으)로 변경되었습니다. inbox read로 현재 주소를 확인하세요`);
      error.code='KADAN_MAIL_RECIPIENT_CHANGED';error.delivery='not-sent';
      throw error;
    }
    return resolved;
  };
  if(mailContext?.replyTo||mailContext?.replyFinal||mailContext?.expectReply){
    cards=new CardStore(home).listSummaries();
    mailContext=resolveReplyContext({cards,entries});
  }
  const mailId=randomUUID();
  const originalTaskId=taskId;
  if (taskId != null) {
    const store=new CardStore(home);cards??=store.listSummaries();
    const card = store.checkSend(mailContext?.executionKey||taskId,role,cards,entries);
    if (card) {
      if (taskId!==card.id&&taskId!==card.key) throw new Error('발령 대상과 실행 연결이 다릅니다');
      mailContext={...mailContext,executionKey:card.key};
      taskId=taskIdentity(cards).taskIdFor(card);
    }
  }
  const sourceCwd = entries.filter(e=>e.kind==='start'&&e.role===role&&e.cwd).at(-1)?.cwd ?? null;
  const originalCardPath = extractCardPath(message,sourceCwd);
  const composed = composeRoleInstructions({home:env.KADAN_HOME||env.KADAN_LITE_HOME||ledgerHome(),
    role,message,profile:roleProfile,raw,taskId,mailContext,entries,cards});
  message = composed.message;
  if (!raw) {
    const instructions=composeMailInstructions({mailId,recipient:role,notificationOnly,dispatch:taskId!=null,expectReply:mailContext?.expectReply===true,sender:by,env});
    if (instructions) message+=`\n\n${instructions}`;
  }
  const conflicts = familyConflictAlerts({role,session,entries,source,env});
  for (const conflict of conflicts) {
    console.error(conflict.warning);
    try { record(conflict.alert); }
    catch (error) { console.error(`원장 기록 실패: ${error.message}`); }
  }
  if (!selectedFloor.alive(session)) {
    const error = new Error(`세션 없음: ${session} — 먼저 kadan start ${role}`);
    error.code = "KADAN_SESSION_MISSING";
    error.delivery = "not-sent";
    throw error;
  }
  const currentPid = selectedFloor.pid(session);
  if (expectedPid && currentPid !== String(expectedPid)) {
    const error = new Error(
      `이름은 같은데 다른 프로세스다 (기록 ${expectedPid} / 현재 ${currentPid}). 사람 확인 필요.`
    );
    error.code = "KADAN_PID_MISMATCH";
    error.delivery = "not-sent";
    throw error;
  }
  if (!expectedPid) {
    console.error("경고: 원장에 이 세션의 시작 기록이 없다 (PID 대조 생략)");
  }
  // 카드 연결 전송은 현재 세대의 AI 신원(등록 실행기+모델)이 확인될 때만 전달한다.
  // 일반 우편·질문·답장은 taskId가 없으므로 이 경계를 거치지 않는다.
  let cardIdentity, runnerGuard;
  if (taskId != null) {
    const identity = inspectCardSendIdentity({ entries, session, currentPid });
    if (!identity.ok) {
      const error = new Error(identity.message);
      error.code = "KADAN_AI_IDENTITY_UNVERIFIED";
      error.delivery = "not-sent";
      throw error;
    }
    cardIdentity = {...identity, currentPid};
    // 작업자·검수자 기본값이 바뀐 뒤에도 떠 있는 옛 실행기·모델 세션에는 카드를 보내지 않는다(2026-09-29 [kyle]).
    // --raw는 역할 지침만 뺀다 — 지침 없이도 프로필은 같은 규칙으로 정해, 프로필이 빈 옛 시작 기록이 raw로 검사를 피하지 못하게 한다.
    const guardProfile = identity.launch.roleProfile ?? roleProfile ?? composed.metadata.profile
      ?? (raw ? inferDispatchProfile({ home, role, taskId, mailContext, entries, cards }).profile : undefined);
    // 카드 단계가 요구하는 프로필도 함께 넘긴다 — 작업자로 띄운 세션에 검수 카드를 보내지 못하게(2026-10-02 [kyle]).
    const phase = inferCardPhaseProfile({ home, role, taskId, mailContext, entries, cards });
    const phaseProfile = phase?.source === "execution-phase" ? phase.profile : undefined;
    runnerGuard = inspectDispatchRunnerGuard({ home, role, session, identity, profile: guardProfile, phaseProfile, allowOldRunner });
    if (runnerGuard.result === "reject") {
      const error = new Error(runnerGuard.message);
      error.code = "KADAN_STALE_RUNNER";
      error.delivery = "not-sent";
      throw error;
    }
    if (runnerGuard.warning) console.error(runnerGuard.warning);
  }
  if (mailContext?.replyTo) resolveReplyContext();

  let receipt;
  try {
    receipt = selectedFloor.send(session, message, {cardIdentity, notificationGuard, busyMail}) || {};
  } catch (error) {
    if (!["not-sent", "unknown"].includes(error.delivery)) error.delivery = "unknown";
    throw error;
  }
  // --raw는 우편 ID·ack 안내를 붙이지 않고 본문 전체를 창에 넣는다. 창 전달이 성공했으면 수신자 직접 ack와
  // 구분되는 전달 읽음으로 남겨 감시기 재알림 대상에서 뺀다(2026-09-27 [kyle]). 전달 불명확은 안 읽음 그대로다.
  const deliveredRead = raw && !notificationOnly && receipt.keyDelivery === "sent";
  const entry = {
    kind: "send",
    mailId,
    ...(notificationOnly?{notificationOnly:true}:{}),
    ...(deliveredRead?{deliveredRead:true}:{}),
    ...(mailContext?.expectReply?{expectReply:true}:{}),
    ...(mailContext?.replyFinal?{replyFinal:true}:{}),
    ...(mailContext?.workKey?{workKey:mailContext.workKey}:{}),
    ...(mailContext?.executionKey?{executionKey:mailContext.executionKey}:{}),
    ...(mailContext?.replyTo?{replyTo:mailContext.replyTo}:{}),
    floor: selectedFloor.name,
    ...(receipt.keyDelivery ? {keyDelivery:receipt.keyDelivery, inputAcceptance:receipt.inputAcceptance} : {}),
    role,
    session,
    roleInstructions: composed.metadata,
    originalCardPath,
    ...(composed.metadata.profile ? {roleProfile:composed.metadata.profile} : {}),
    ...(runnerGuard?.ledger ? {runnerGuard:runnerGuard.ledger} : {}),
    by: resolveLedgerBy({ source, env }),
    ...(taskId != null ? { taskId } : {}),
    ...(originalTaskId!==taskId?{rawTaskId:originalTaskId}:{}),
    bytes: Buffer.byteLength(message),
    digest: digest(message),
    ...(mailPreview(message) ? { preview: mailPreview(message) } : {}),
    ...(receipt.sequence != null ? { sequence: receipt.sequence } : {}),
    ...(receipt.enterSequence != null
      ? { enterSequence: receipt.enterSequence }
      : {}),
    ...(receipt.bodySha256 ? { bodySha256: receipt.bodySha256 } : {}),
    ...(receipt.outputCursor ? { outputCursor: receipt.outputCursor } : {}),
    ...(receipt.deliveryId ? { deliveryId: receipt.deliveryId } : {}),
    ...(receipt.terminalId ? { rottieTerminalId: receipt.terminalId } : {}),
    ...(receipt.baselineText != null
      ? {
          baselineMarkers: findDoneMarkers(stripAnsi(receipt.baselineText)),
        }
      : {}),
  };
  // 본문은 원장이 아니라 옆 파일에 둔다. 저장이 실패해도 전달은 이미 끝났으므로 막지 않는다.
  try {
    saveBody(digest(message), message);
  } catch (error) {
    console.error(`편지 본문 저장 실패(전달은 됨): ${error.message}`);
  }
  try {
    const rejection=storageTransaction(home,()=>{
      if(entry.replyFinal){
        try { resolveReplyContext(); }
        catch(error){
          // 화면 전달 뒤 경쟁에서 밀려도 그 전달 사실은 남긴다. 최종 답변으로는 인정하지 않는다.
          record({...entry,replyFinal:false,replyFinalRejected:true});
          return error;
        }
      }
      record(entry);
      return null;
    });
    if(rejection)throw rejection;
  } catch (error) {
    error.delivery = "sent";
    throw error;
  }
  return entry;
}

// 카드 id는 `card-65` 또는 `card-65:사람이 읽는 제목` 형태를 받는다. 제목과 판 설명(about)은
// 화면에서 "mp가 도대체 뭐느냐"를 없애려고 넣는다 (2026-09-06 [kyle]). 안 적으면 예전처럼 id만 남는다.
// 우편함에서 "무슨 편지였나"가 한 줄로 보이게 앞머리만 원장에 남긴다. 전문은 옆 파일에 있다.
// 편지 본문에 적힌 카드 파일 경로를 읽어 화면에서 펼친다 (2026-09-06 [kyle]).
// 아무 파일이나 읽지 않는다: 절대경로 .md, 실재하는 파일, 60KB 상한. 셋 다 맞아야 읽는다.
export function extractCardPath(text, cwd = null) {
  if (typeof text !== "string") return null;
  // 절대경로는 줄머리나 공백·따옴표 뒤에서 시작할 때만 인정한다. 그러지 않으면
  // "tasks/card.md"의 뒷부분을 "/card.md"로 잘못 문다 (2026-09-06 시험이 잡았다).
  const absolute = text.match(/(?:^|[\s"'(])(\/[^\s"']+\.md)/u)?.[1];
  if (absolute) return absolute;
  // 레포마다 카드 폴더 규칙이 다르고 상대경로로 보내기도 한다 (2026-09-06 [kyle]).
  // 그때는 그 역할이 일하던 폴더(start 원장의 cwd)를 기준으로 푼다. cwd를 모르면 포기한다.
  const relative = text.match(/(?:^|[\s"'(])([\w.@~-][\w./@~-]*\.md)/u)?.[1];
  if (!relative || !cwd) return null;
  return path.resolve(cwd, relative.replace(/^~(?=\/)/u, process.env.HOME ?? "~"));
}

const CARD_FILE_LIMIT = 60_000;

export function collectCardFiles(entries, deps = {}) {
  const readFile = deps.readFile ?? ((file) => fs.readFileSync(file, "utf8"));
  const readBody = deps.readBody ?? readMailBody;
  const files = {};
  const cwdByRole = new Map();
  for (const entry of entries ?? []) {
    if (entry?.kind === "start" && entry.role && entry.cwd) cwdByRole.set(entry.role, entry.cwd);
  }
  for (const entry of entries ?? []) {
    if (entry?.kind !== "send" || !entry.taskId || files[entry.taskId]) continue;
    // 새 영수증의 null은 원문에 경로가 없었다는 뜻이다. 첨부를 대신 카드로 읽지 않는다.
    let file;
    if (Object.hasOwn(entry,'originalCardPath')) {
      file = typeof entry.originalCardPath==='string'&&path.isAbsolute(entry.originalCardPath)&&entry.originalCardPath.endsWith('.md') ? entry.originalCardPath : null;
    } else {
      const source = (entry.digest ? readBody(entry.digest) : null) ?? entry.preview ?? "";
      file = extractCardPath(source, cwdByRole.get(entry.role) ?? null);
    }
    if (!file) continue;
    try {
      const text = readFile(file);
      files[entry.taskId] = text.length > CARD_FILE_LIMIT
        ? { path: file, text: `${text.slice(0, CARD_FILE_LIMIT)}\n… (너무 길어 잘랐다)` }
        : { path: file, text };
    } catch (error) {
      files[entry.taskId] = { path: file, error: error.code === "ENOENT" ? "파일 없음" : "못 읽음" };
    }
  }
  return files;
}

// 자동 첨부된 역할 지침 블록은 미리보기에서 뺀다. 대시보드 우편 미리보기가 마크업으로 시작해 본문이 안 보였다(2026-10-05).
const RECEIVER_INSTRUCTIONS_BLOCK = /<!--\s*kadan:receiver-instructions\s*-->[\s\S]*?(?:<!--\s*\/kadan:receiver-instructions\s*-->|$)/gu;
export function mailPreview(message, limit = 100) {
  if (typeof message !== "string") return "";
  const flat = message.replace(RECEIVER_INSTRUCTIONS_BLOCK, " ").replace(/\s+/gu, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
