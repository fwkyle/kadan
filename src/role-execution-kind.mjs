// 역할(세션) 노드에 붙일 executionKind: 그 역할에 지금 배정된 미완료 실행 카드의 종류.
// 새 기록을 만들지 않고 이미 읽은 카드 목록(center.cards)과 업무 목록(registeredWorks)만 한 번 훑는다.
import { statusBucket } from "./status-labels.mjs";
import { workPhases } from "./work-store.mjs";

// 카드 쪽 rallyStep(발령 때 적힌 단계)은 업무 연결이 없을 때만 쓴다. 둘 다 저장된 값이다.
const KINDS = new Set(Object.keys(workPhases));

// 미완료 = 진행 중·확인 필요 묶음. 진행 전(draft·ready·archived)과 끝(done·cancelled·superseded)은 뺀다.
const openAssigned = (card) => Boolean(card.role) && ["active", "check"].includes(statusBucket(card.displayState));

// 발령 시각: 그 역할 실행(runs)의 가장 늦은 sentAt, 없으면 카드 수정 시각.
const dispatchedAt = (card) => Math.max(
  ...card.runs.filter((run) => run.role === card.role).map((run) => Date.parse(run.sentAt) || 0),
  Date.parse(card.at) || 0,
);

// 반환: Map<역할, 'implementation'|'review'|'fix'|'research'|'release'|'other'>. 없는 역할은 맵에 없다.
export function executionKindByRole(cards, works) {
  const phaseByKey = new Map();
  for (const work of works ?? []) {
    for (const link of work.executions ?? []) if (KINDS.has(link.phase)) phaseByKey.set(link.key, link.phase);
  }
  const latest = new Map();
  for (const card of cards ?? []) {
    if (!openAssigned(card)) continue;
    const phase = phaseByKey.get(card.key) ?? (KINDS.has(card.rallyStep) ? card.rallyStep : null);
    if (!phase) continue;
    const at = dispatchedAt(card);
    const old = latest.get(card.role);
    if (!old || at >= old.at) latest.set(card.role, { at, phase });
  }
  return new Map([...latest].map(([role, { phase }]) => [role, phase]));
}
