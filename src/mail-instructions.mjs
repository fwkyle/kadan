// 우편을 확인한 수신자가 읽음 사건만 남긴다. 조회·회신·완료에서 읽음을 추정하지 않는다.
import {isUserActor} from './actors.mjs';

export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

export function composeMailInstructions({mailId,recipient,notificationOnly=false,expectReply=false,sender,env=process.env}) {
  if (notificationOnly) return '';
  const ack=`우편 ID: ${mailId}. 내용을 확인한 수신자가 직접 읽음 확인을 기록하라.\n` +
    `KADAN_ROLE=${shellQuote(recipient)} kadan inbox ack ${shellQuote(mailId)} --role ${shellQuote(recipient)}\n` +
    '조회·답장·DONE은 자동 읽음 처리가 아니다. ack는 로컬 읽음 사건만 기록하며 회신 우편이나 추가 알림을 보내지 않는다. 읽음은 승인·착수·답변 완료·작업 완료를 뜻하지 않는다.';
  if (!expectReply || !sender) return ack;
  return ack+`\n\n질문ID: ${mailId}. 최종 답변: kadan send ${shellQuote(sender)} --reply-to ${shellQuote(mailId)} --reply-final${isUserActor(sender,env)?' --mailbox':''} <답변>. 일반 답장과 읽음은 답변 대기를 끝내지 않습니다. 수신자 또는 발신자가 인계되면 inbox read로 현재 담당과 회신 주소를 확인하라.`;
}
