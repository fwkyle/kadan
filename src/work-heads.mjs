// 업무마다 최신 판 한 줄만 읽는다(이력을 읽지 않고 이력 검증도 하지 않는다).
// "지금 어느 열린 업무가 어느 프리셋을 쓰나"처럼 최신 값만 보는 곳이 쓴다: 프리셋 삭제·이름 변경 거절(runner-settings.mjs)과
// 다시 띄울 세션 미리 보기(relaunch-preview.mjs). 상세·변경은 WorkStore를 쓴다.
// 비용: 업무 수만큼의 줄(업무가 10배면 읽는 줄도 10배, 이력 길이와는 무관하다). 저장소를 못 읽으면 던진다.
// WorkStore를 부르지 않는 이유: work-store.mjs가 runner-settings.mjs를 읽으므로 설정 저장 층이 WorkStore를 부르면 서로 물린다.
import {storageMode, transaction} from './storage.mjs';

export function readWorkHeads(home) {
  if (storageMode(home) === 'none') return [];
  return transaction(home, db => db.prepare(
    `SELECT payload FROM heads WHERE stream GLOB 'works/*/events.jsonl' ORDER BY stream`,
  ).all().map(row => JSON.parse(row.payload)), {readOnly: true});
}

// 마감(완료·취소)되지 않은 업무. 보류(hold)도 열린 업무다.
export const isOpenWork = work => !['done', 'cancelled'].includes(work?.status);

// 이름 목록 가운데 하나를 프리셋으로 적어 둔 열린 업무.
export function openWorksUsingPresets(home, names) {
  return readWorkHeads(home).filter(work => isOpenWork(work) && names.includes(work.preset));
}
