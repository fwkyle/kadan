// 설명 AI를 부르는 사건의 목록. 새 사건 기록을 만들지 않고, 카드 중앙(card-center)·카드 이력·결정 기록에 이미 남은 사건에서
// 사건마다 안정된 ID와 시각을 뽑는다. 같은 사건은 언제 다시 읽어도 같은 ID가 나온다(그래서 사건마다 한 번만 부를 수 있다).
//   dispatch  발령: 원장 send 사건으로 시작한 실행(run.sentAt)
//   done      완료: 원장 done 사건으로 끝난 실행(run.at)
//   report    결과 등록: card report가 남긴 result.at
//   blocked   막힘: 표시 상태가 hold·failed·orphaned로 들어감, unconfirmed는 발령 뒤 유예 시간이 지난 것만
//   decision  결정: 요청 생성·답·취소
// 화면 갱신·대시보드 조회는 여기를 지나지 않는다.
import {listFactsOf} from './card-list-facts.mjs';

export const UNCONFIRMED_GRACE_MS = 10 * 60_000;
const at = value => { const t = Date.parse(value); return Number.isFinite(t) ? t : 0; };

export function cardEvents(card, decisions = [], now = Date.now()) {
  const events = [];
  const add = (kind, id, time) => { if (time > 0) events.push({key: card.key, kind, id: `${kind}:${id}`, at: time}); };
  const runs = [...(card.runs ?? [])].sort((a, b) => at(a.sentAt ?? a.at) - at(b.sentAt ?? b.at));
  const last = runs.at(-1);
  if (last?.sentAt) add('dispatch', `${last.role}:${last.sentAt}`, at(last.sentAt));
  const done = runs.filter(r => r.state === 'done').at(-1);
  if (done) add('done', `${done.role}:${done.at}`, at(done.at));
  if (card.result?.at) add('report', card.result.at, at(card.result.at));
  const state = card.displayState;
  if (state === 'hold') {
    const entered = listFactsOf(card).lastHoldEntry;
    add('blocked', `hold:${entered?.at ?? card.at}`, at(entered?.at ?? card.at));
  } else if (state === 'failed') {
    const failed = runs.filter(r => r.state === 'failed').at(-1);
    if (failed) add('blocked', `failed:${failed.role}:${failed.at}`, at(failed.at));
  } else if (['orphaned', 'unconfirmed'].includes(state) && last?.sentAt) {
    const sent = at(last.sentAt);
    if (state === 'orphaned' || now - sent >= UNCONFIRMED_GRACE_MS) add('blocked', `${state}:${last.role}:${last.sentAt}`, sent);
  }
  for (const d of decisions) {
    if (d.card !== card.key) continue;
    add('decision', `${d.id}:open`, at(d.at));
    if (d.status === 'answered') add('decision', `${d.id}:answered`, at(d.answer?.at));
    if (d.status === 'cancelled') add('decision', `${d.id}:cancelled`, at(d.cancelledAt));
  }
  return events;
}
