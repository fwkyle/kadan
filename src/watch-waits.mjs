// 답 대기와 열린 결정을 감시에 알려 주는 순수 함수 모음 (2026-11-02, 감독이 kyle 결정을 기다리는 동안의 정체 알림 반복 방지).
// 파일·원장을 읽지 않는다. 순회마다 한 번 읽은 결정 목록과 waits를 받아 메모리에서만 거른다.
import {taskIdentity} from './task-identity.mjs';

// 결정 목록을 못 읽은 것(null)과 열린 결정이 없는 것([])을 구분한다.
export const decisionList = raw => Array.isArray(raw) ? raw : null;

// 감독 requester가 kyle에게 올린 열린 결정. 거름 근거가 아니라 AI가 판단하는 문맥이다(업무가 달라도 싣는다).
export function openDecisionContext(decisions, requester) {
  if (decisions === null) return null;
  if (!requester) return [];
  return decisions.filter(d => d?.status === 'open' && d.requestedBy === requester).map(d => ({
    id: d.id, question: String(d.question ?? '').slice(0, 200), options: d.options, recommendation: d.recommendation,
    at: d.at, work: d.work ?? null, card: d.card ?? null
  }));
}

// AI 입력에 붙일 필드. 못 읽었으면 null과 읽지 못함 표시를 함께 싣는다.
export function decisionFields(decisions, requester) {
  const openDecisions = openDecisionContext(decisions, requester);
  return openDecisions === null ? {openDecisions: null, openDecisionsUnread: true} : {openDecisions};
}

// 카드 하나가 명확히 걸린 답 대기 항목. ids에 taskId·카드 key·카드 id·소속 업무가 들어 있어야 한다.
// asker가 있는 항목(질문 우편)은 그 실행의 작업자가 물은 것일 때만 센다: 작업자가 답할 쪽이면 작업자의 할 일이다.
export function waitsOfCard(waits, card, taskId, works, role) {
  const ids = new Set([taskId, card.key, card.id, ...(works ?? []).filter(w => (w.executions ?? []).some(x => x.key === card.key)).map(w => `work:${w.key}`)]
    .filter(Boolean));
  return (waits ?? []).filter(w => w.ids?.some(id => ids.has(id)) && (w.asker == null || w.asker === role));
}

// AI 입력용 요약(질문 본문은 싣지 않는다). 못 읽었으면 null.
export function waitFields(waits, waitsRead, card, taskId, works, role) {
  if (!waitsRead) return {waits: null, waitsUnread: true};
  return {waits: waitsOfCard(waits, card, taskId, works, role).map(w => ({kind: w.kind ?? 'user-turn', ref: w.ref ?? null, answerer: w.answerer}))};
}

// progress 후보에서 뺄 카드 key 집합. waits를 못 읽었으면 아무것도 빼지 않는다.
export function waitingCardKeys(cards, works, waits, waitsRead, roleOf) {
  const keys = new Set();
  if (!waitsRead || !waits?.length) return keys;
  const identity = taskIdentity(cards);
  for (const card of cards) {
    const role = roleOf(card);
    if (role && waitsOfCard(waits, card, identity.taskIdFor(card), works, role).length) keys.add(card.key);
  }
  return keys;
}
