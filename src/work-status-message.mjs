// 업무 글의 "상태 메시지" 본문 — WorkStore·카드·원장에서만 만든다(AI 호출 없음). 고정 틀, 2,000자 안.
// 디스코드 포럼 업무 글에 하나만 두고, 바뀔 때마다 이 본문으로 그 메시지를 고쳐 쓴다(user-notify.mjs의 refreshWorkStatus).
import {WorkStore, workPhases} from './work-store.mjs';
import {CardStore} from './card-store.mjs';
import {buildCardCenter} from './card-center.mjs';
import {readLedger} from './ledger.mjs';
import {isEnded, statusLabel} from './status-labels.mjs';

const LIMIT = 2000;
const MAX_LISTED = 8;
const WORK_STATE = {open: '열림', hold: '일시정지', done: '완료', cancelled: '취소'};
const cut = (text, max) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const minute = iso => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '모름');

// 반환: {content, title} 또는 업무를 못 읽으면 null(상태 메시지를 만들지 않는다).
// summary: 나중에 설명 AI 요약 한 줄이 들어갈 자리. 지금은 비워 둔다.
export function buildWorkStatus(home, workKey, {summary = ''} = {}) {
  let work, running = [], hidden = 0;
  try {
    work = new WorkStore(home).get(workKey);
    const center = buildCardCenter({cards: new CardStore(home).list(), entries: readLedger(home), tree: [], runtimeKnown: false});
    const open = work.executions.map(x => ({x, card: center.cards.find(c => c.key === x.key)})).filter(({card}) => !card || !isEnded(card.displayState));
    hidden = Math.max(0, open.length - MAX_LISTED);
    running = open.slice(0, MAX_LISTED).map(({x, card}) =>
      `- ${workPhases[x.phase] ?? x.phase} ${x.round}라운드 · ${cut(card?.role || '역할 미정', 60)} · ${card ? statusLabel(card.displayState) : '카드 없음'}`);
  } catch { return null; }
  const lines = [
    `**업무 상태** · ${work.key}`,
    `제목: ${cut(work.title, 150)}`,
    `상태: ${WORK_STATE[work.status] ?? work.status} · revision ${work.revision}`,
    running.length ? `열린 실행 ${running.length + hidden}건:\n${running.join('\n')}${hidden ? `\n- 외 ${hidden}건` : ''}` : '열린 실행: 없음',
    `현재 차례: ${cut(work.turnOwner, 100) || '없음'}`,
    `다음 행동: ${cut(work.nextAction, 300) || '없음'}`,
    ...(summary ? [`요약: ${cut(summary, 300)}`] : []),
    `책임 감독: ${cut(work.owner, 100)}`,
    `갱신: ${minute(work.at)}`,
  ];
  return {content: lines.join('\n').slice(0, LIMIT), title: work.title ?? ''};
}
