// 업무 글의 "상태 메시지" 본문 — WorkStore·카드·원장에서만 만든다(AI 호출 없음). 고정 틀, 2,000자 안.
// 디스코드 포럼 업무 글에 하나만 두고, 바뀔 때마다 이 본문으로 그 메시지를 고쳐 쓴다(user-notify.mjs의 refreshWorkStatus).
import {WorkStore, workPhases, endedExecution} from './work-store.mjs';
import {CardStore} from './card-store.mjs';
import {buildCardCenter, reportedActivity} from './card-center.mjs';
import {readLedger} from './ledger.mjs';
import {statusLabel} from './status-labels.mjs';

const LIMIT = 2000;
const MAX_LISTED = 8;
const WORK_STATE = {open: '열림', hold: '일시정지', done: '완료', cancelled: '취소'};
// 저장된 시작·대기 보고(card progress)는 그 시점 보고일 뿐 실시간 생존이 아니다. 문구에 '보고 기준'을 붙여 구분한다.
const REPORTED = {running: '시작함(보고 기준)', waiting: '결과 대기(보고 기준)'};
// 카드 상태 계산(card-center.mjs)과 같은 reportedActivity 판정이다. 생존은 모르므로 alive:false. 조건을 못 채우면 '발령됨'(statusLabel).
const stateText = card => {
  if (!card) return '카드 없음';
  const reported = card.displayState === 'unconfirmed' ? reportedActivity(card, card.runs ?? [], {alive: false}) : null;
  return reported ? REPORTED[reported] : statusLabel(card.displayState);
};
const cut = (text, max) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const minute = iso => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '모름');

// 반환: {content, title} 또는 업무를 못 읽으면 null(상태 메시지를 만들지 않는다).
// summary: 나중에 설명 AI 요약 한 줄이 들어갈 자리. 지금은 비워 둔다.
export function buildWorkStatus(home, workKey, {summary = ''} = {}) {
  let work, running = [], hidden = 0, failed = 0;
  try {
    work = new WorkStore(home).get(workKey);
    const center = buildCardCenter({cards: new CardStore(home).list(), entries: readLedger(home), tree: [], runtimeKnown: false});
    // 열린 실행 판정은 업무 완료 확인(work-store.mjs)과 같은 endedExecution이다: 원장 결과 failed로 끝난 실행은 열려 있지 않다.
    const all = work.executions.map(x => ({x, card: center.cards.find(c => c.key === x.key)}));
    const open = all.filter(({card}) => !card || card.ambiguous || !endedExecution(card));
    failed = all.filter(({card}) => card?.displayState === 'failed').length;
    hidden = Math.max(0, open.length - MAX_LISTED);
    running = open.slice(0, MAX_LISTED).map(({x, card}) =>
      `- ${workPhases[x.phase] ?? x.phase} ${x.round}라운드 · ${cut(card?.role || '역할 미정', 60)} · ${stateText(card)}`);
  } catch { return null; }
  const lines = [
    `**업무 상태** · ${work.key}`,
    `제목: ${cut(work.title, 150)}`,
    `상태: ${WORK_STATE[work.status] ?? work.status} · revision ${work.revision}`,
    running.length ? `열린 실행 ${running.length + hidden}건:\n${running.join('\n')}${hidden ? `\n- 외 ${hidden}건` : ''}` : '열린 실행: 없음',
    ...(failed ? [`실패로 끝난 실행: ${failed}건`] : []),
    `현재 차례: ${cut(work.turnOwner, 100) || '없음'}`,
    `다음 행동: ${cut(work.nextAction, 300) || '없음'}`,
    ...(summary ? [`요약: ${cut(summary, 300)}`] : []),
    `책임 감독: ${cut(work.owner, 100)}`,
    `갱신: ${minute(work.at)}`,
  ];
  return {content: lines.join('\n').slice(0, LIMIT), title: work.title ?? ''};
}
