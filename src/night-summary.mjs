// 나이트 모드 아침 요약. 켜진 동안(시작~끝)의 결정 저장소·원장 기록을 세어 글 한 덩어리로 만든다.
// 순수 함수다: 읽기는 부르는 쪽이 한다. 장치는 판정하지 않고 센 것만 적는다 — 모르는 것(실제 머지)은 모른다고 적는다.
import {isUserActor,isSupervisorActor} from './actors.mjs';

export const HELD_PREFIX = '[나이트 보류]';
// 알림 한 통의 글자 수 상한. 요약 글(summary.text)이 이 안에 들어오게 만든다.
export const NOTICE_LIMIT = 1800;
const HELD_LISTED = 10;
const PR_URL = /https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/;

// 줄바꿈을 공백 하나로 접고 n자에서 자른다. 원문 전체는 원장의 on 사건에 그대로 있다.
const fold = (t, n) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const stamp = ms => {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const REASON = {off: 'night off로 껐음', expired: '끝 시각이 되어 꺼짐', 'ended-by-input': 'kyle의 새 입력으로 꺼짐'};

// 결정 이력(같은 id의 여러 revision)에서 구간 안의 답·취소를 id당 한 번씩만 센다.
function countDecisions(events, startMs, endMs) {
  const inWindow = at => { const ms = Date.parse(at); return ms >= startMs && ms <= endMs; };
  const answered = new Map(), cancelled = new Map(), chatRegistered = new Set();
  for (const e of events) {
    if (e?.status === 'answered' && inWindow(e.answer?.at) && !answered.has(e.id)) answered.set(e.id, e);
    // 채팅 결정(--chat)의 닫힘은 취소로 세지 않는다. 등록만 "채팅 등록 N건"으로 따로 센다.
    if (e?.chat === true) { if (e.revision === 1 && inWindow(e.at)) chatRegistered.add(e.id); continue; }
    if (e?.status === 'cancelled' && inWindow(e.cancelledAt) && !cancelled.has(e.id)) cancelled.set(e.id, e);
  }
  const merge = e => PR_URL.test([e.question, e.reason, e.recommendation, ...(e.options ?? [])].join('\n'));
  const byHuman = [...cancelled.values()].filter(e => !isSupervisorActor(e.cancelledBy));
  const bySuper = [...cancelled.values()].filter(e => isSupervisorActor(e.cancelledBy));
  return {
    answered: answered.size,
    chatRegistered: chatRegistered.size,
    cancelledByHuman: byHuman.length,
    cancelledBySuper: bySuper.length,
    mergeAnswered: [...answered.values()].filter(merge).length,
    mergeCancelled: [...cancelled.values()].filter(merge).length,
  };
}

// start: 켠 night 사건, endedAt: 끝 시각(ms). entries: 원장, decisionEvents: 결정 저장소 이력, readBody: 우편 지문 → 본문(없으면 null).
export function summarizeNight({start, phase, endedAt, entries, decisionEvents, readBody}) {
  const startMs = Date.parse(start.t);
  const inWindow = e => { const ms = Date.parse(e.t); return ms >= startMs && ms <= endedAt; };
  const decisions = countDecisions(decisionEvents, startMs, endedAt);
  const restarts = entries.filter(e => e?.kind === 'stop' && e.restart === true && inWindow(e)).length;
  const delivered = new Set((start.delivered ?? []).map(d => d.mailId).filter(Boolean));
  const sends = entries.filter(e => e?.kind === 'send' && inWindow(e) && !delivered.has(e.mailId));
  // 보류: 사람 우편함으로 간 `[나이트 보류] <한 줄>` 편지. 본문은 원장이 아니라 옆 파일에 있다.
  const held = sends.filter(e => isUserActor(e.role) && e.digest)
    .map(e => readBody(e.digest)).filter(body => typeof body === 'string' && body.startsWith(HELD_PREFIX))
    .map(body => body.slice(HELD_PREFIX.length).trim().split('\n')[0].slice(0, 100));
  const counts = {...decisions, restarts, mails: sends.length, held: held.length};

  // 알림 상한 안에 제목·기간·집계가 모두 들어가야 한다. 넘치면 원문 표시를 먼저 줄이고, 그래도 넘치면 보류 상세를 뺀다(건수는 남는다).
  const render = (quoteLimit, showHeld) => {
    const lines = [];
    lines.push(start.viaChat
      ? `대리 위임: ${start.by}이(가) kyle의 채팅 말을 옮겨 적었습니다 — "${fold(start.quote, quoteLimit)}" (전체 원문: kadan night status --text, 원장)`
      : `kyle 위임: "${fold(start.text, quoteLimit)}" (전체: kadan night status --text, 원장)`);
    lines.push(`나이트 모드 요약 (${stamp(startMs)} ~ ${stamp(endedAt)}, ${REASON[phase] ?? phase})`);
    const night = [];
    if (decisions.answered) night.push(`결정 답 ${decisions.answered}건`);
    if (decisions.chatRegistered) night.push(`채팅 등록 ${decisions.chatRegistered}건`);
    if (decisions.cancelledByHuman) night.push(`사람이 취소한 결정 ${decisions.cancelledByHuman}건`);
    if (restarts) night.push(`재시작 ${restarts}건`);
    if (sends.length) night.push(`우편 ${sends.length}건`);
    if (held.length) night.push(`보류로 남긴 것 ${held.length}건`);
    lines.push('밤사이 생긴 일', night.length ? `- ${night.join(' · ')}` : '- 밤사이 처리한 일 없음');
    if (showHeld) for (const item of held.slice(0, HELD_LISTED)) lines.push(`  · 보류: ${item}`);
    if (showHeld && held.length > HELD_LISTED) lines.push(`  · 그 밖 ${held.length - HELD_LISTED}건`);
    if (decisions.mergeAnswered || decisions.mergeCancelled)
      lines.push(`- 머지 관련 결정 답 ${decisions.mergeAnswered}건·취소 ${decisions.mergeCancelled}건 — 실제 머지는 GitHub에서 확인`);
    lines.push('위임으로 대신 처리한 일', decisions.cancelledBySuper
      ? `- 슈퍼감독이 대신 닫은 결정 ${decisions.cancelledBySuper}건`
      : '- 없음');
    return lines.join('\n');
  };
  const text = [[200, true], [80, true], [80, false]].map(([q, h]) => render(q, h)).find(t => t.length <= NOTICE_LIMIT) ?? render(80, false);
  return {counts, held, text};
}
