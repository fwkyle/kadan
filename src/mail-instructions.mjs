// 우편을 확인한 수신자가 읽음 사건만 남긴다. 조회·회신·완료에서 읽음을 추정하지 않는다.
// 예외: --raw는 이 안내를 붙이지 않으므로 창 전달 성공(keyDelivery=sent)을 전달 읽음(deliveredRead)으로 남긴다.
// 전달 읽음은 수신자 직접 ack와 구분해 표시한다(2026-09-27 [kyle]).
// 발령 우편(--task)에도 읽음 확인 안내를 붙이지 않는다(2026-10-05 [kyle] 소음 줄이기). 착수 보고(card progress)가
// 읽음의 자리를 대신하고, 미착수는 시작보고누락 경보가 잡는다. 답을 기다리는 발령(--expect-reply)은 질문이므로 예외 없이 둘 다 붙는다.
import {isUserActor} from './actors.mjs';

export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

export function composeMailInstructions({mailId,recipient,notificationOnly=false,dispatch=false,expectReply=false,sender,env=process.env}) {
  if (notificationOnly) return '';
  const ack=dispatch&&!expectReply?'':`우편 ID: ${mailId}. 내용을 확인한 수신자가 직접 읽음 확인을 기록하라.\n` +
    `KADAN_ROLE=${shellQuote(recipient)} kadan inbox ack ${shellQuote(mailId)} --role ${shellQuote(recipient)}\n` +
    '조회·답장·DONE은 자동 읽음 처리가 아니다. ack는 로컬 읽음 사건만 기록하며 회신 우편이나 추가 알림을 보내지 않는다. 읽음은 승인·착수·답변 완료·작업 완료를 뜻하지 않는다.';
  if (!expectReply || !sender) return ack;
  const reply=`질문ID: ${mailId}. 최종 답변: kadan send ${shellQuote(sender)} --reply-to ${shellQuote(mailId)} --reply-final${isUserActor(sender,env)?' --mailbox':''} <답변>. 일반 답장과 읽음은 답변 대기를 끝내지 않습니다. 수신자 또는 발신자가 인계되면 inbox read로 현재 담당과 회신 주소를 확인하라.`;
  return [ack,reply].filter(Boolean).join('\n\n');
}
