// Why: 업무 마감의 자동 닫기(work-card-close.mjs)와 소급 닫기(work-card-backfill.mjs)는 실패한 실행 카드도 저장 상태
// done으로 닫는다. 목록에서는 의도대로 끝난 카드지만, 티키타카 묶음·단계는 원장의 실패를 그대로 실패로 보여야 한다.
// 사람이 손으로 완료한 카드는 그 결정이 과거 실행보다 앞서므로(card-center.mjs) 건드리지 않는다. 둘을 가르는 것은
// 닫기가 남기는 상태 이유의 머리뿐이라, 쓰는 쪽과 판정하는 쪽이 이 파일 하나를 같이 써서 어긋나지 않게 한다.
export const CLOSE_WORDS=Object.freeze({done:'완료',cancelled:'취소'});
const CLOSE_PHRASES=Object.freeze({auto:'마감으로 자동 닫음',backfill:'마감 소급 정리로 닫음'});
const RESULT_LEAD=' · 원장 결과 ';

// 닫기 메모의 머리. 뒤에 원장 결과(ok|failed)와 실행별 결과가 붙는다. kind는 auto|backfill, workStatus는 done|cancelled.
export const closeNoteHead=(kind,workKey,workStatus)=>`업무 ${workKey} ${CLOSE_WORDS[workStatus]} ${CLOSE_PHRASES[kind]}${RESULT_LEAD}`;

const CLOSE_REASON=new RegExp(`^업무 \\S+ (?:${Object.values(CLOSE_WORDS).join('|')}) `
  +`(?:${Object.values(CLOSE_PHRASES).join('|')})${RESULT_LEAD}`);
// 상태 이유는 상태가 바뀔 때만 새로 적혀, 닫은 뒤 메모를 남겨도 남고 다시 발령했다가 손으로 완료하면 사라진다.
const closedByWork=card=>card.status==='done'&&CLOSE_REASON.test(card.statusReason??'');

// 티키타카 묶음에 넣을 카드. 닫기 때문에 완료로 보이는 실패 카드는 닫기 전 표시 규칙(실패한 실행이 있으면 failed)으로
// 읽는다. 사본만 바꾸므로 카드 목록의 표시 상태·묶음 판정은 그대로다.
export const rallyCard=card=>card.displayState==='done'&&closedByWork(card)&&(card.runs??[]).some(r=>r.state==='failed')
  ?{...card,displayState:'failed'}:card;
