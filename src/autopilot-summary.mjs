// Autopilot 요약(꺼질 때 한 번). 켜진 동안(시작~끝)의 결정 저장소·원장 기록을 세어 글 한 덩어리로 만든다.
// 순수 함수다: 읽기는 부르는 쪽이 한다. 장치는 판정하지 않고 센 것만 적는다 — 모르는 것(실제 머지)은 모른다고 적는다.
import {stripStoredHeader} from './mail-header.mjs';
import {isUserActor,isSupervisorActor} from './actors.mjs';
import {tallyNotes, cleanNoteText} from './autopilot-note.mjs';
import {WINGMAN_BASIS, HELD_PREFIX, ALLOW_LABEL, MODE, WINGMAN, NO_WINGMAN} from './autopilot-terms.mjs';

export {HELD_PREFIX};
// 알림 한 통의 글자 수 상한. 요약 글(summary.text)이 이 안에 들어오게 만든다.
export const NOTICE_LIMIT = 1800;
const HELD_LISTED = 10;
const ALLOW_SHOWN = 5;
const NOTE_ITEM = 100;
const PR_URL = /https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/;

// 줄바꿈을 공백 하나로 접고 n자에서 자른다. 원문 전체는 원장의 on 사건에 그대로 있다.
const fold = (t, n) => { const x = cleanNoteText(t); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const stamp = ms => {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const REASON = {running: '아직 켜져 있음 — 지금까지', off: 'autopilot off로 껐음', expired: '끝 시각이 되어 꺼짐', 'ended-by-input': 'kyle의 새 입력으로 꺼짐'};

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

// `kadan autopilot note`로 남긴 기록 줄. 기록이 하나도 없으면 아무 줄도 더하지 않는다(옛 요약과 같다).
// 머지 줄은 센 것만 적는다: 기록 없이 한 머지(셸·gh)는 모르므로 0이라고 단정하지 않고 GitHub에서 확인하라고 쓴다.
function noteLines(t, listN) {
  const {counts: c} = t;
  if (!t.total) return [];
  const item = x => fold(x, NOTE_ITEM);
  const ref = n => [n.pr, n.sha ? n.sha.slice(0, 7) : null].filter(Boolean).map(cleanNoteText).join(' ');
  const more = (label, list, show) => list.length > show ? [`  · ${label} 외 ${list.length - show}건`] : [];
  const lines = ['기록한 일 (kadan autopilot note)'];
  const list = (label, items, fmt) => { for (const n of items.slice(0, listN)) lines.push(`  · ${label}: ${fmt(n)}`); lines.push(...(listN ? more(label, items, listN) : [])); };

  if (c.noteDecisions) { lines.push(`- 대신 정한 결정 ${c.noteDecisions}건`); list('결정', t.decisions, n => item(n.text)); }
  const hk = c.noteHolds, parts = [['결정', hk.decision], ['관문 실패', hk.gate], ['배포 저장소', hk['deploy-repo']]].filter(([, v]) => v);
  if (parts.length) {
    lines.push(`- 보류: ${parts.map(([k, v]) => `${k} ${v}건`).join(' · ')}`);
    list('보류', t.holds.filter(n => n.holdKind !== 'deploy-repo'), n => item(n.text));
    list('배포 저장소 보류', t.holds.filter(n => n.holdKind === 'deploy-repo'), n => item(`${n.pr ? `${n.pr} — ` : ''}${n.text}${n.reason ? ` (근거: ${n.reason})` : ''}`));
  }
  if (c.gatePass || c.gateReject) {
    lines.push(`- 관문 통과 ${c.gatePass}건 · 거절 ${c.gateReject}건`);
    list('통과', t.passes, n => item(`${n.pr ? `${n.pr} — ` : ''}${n.text}`));
    list('거절', t.rejects, n => item(`${n.pr ? `${n.pr} — ` : ''}${n.reason ?? n.text}`));
  }
  // 관문 통과·거절·머지 기록이 모두 0일 때만 "기록 없음". 거절만 있으면 센 것을 그대로 쓴다(머지 기록 0건).
  if (c.merges || c.gatePass || c.gateReject) {
    const warn = c.merges > c.gatePass ? ' (통과 기록보다 머지 기록이 많음)' : '';
    lines.push(`- 관문 통과 ${c.gatePass}건 · 머지 기록 ${c.merges}건${warn} — 관문 기록 없이 한 머지는 GitHub에서 확인`);
    list('머지', t.merges, n => item(`${ref(n)} ${n.text}`.trim()));
    if (c.unmerged) { lines.push(`- 통과 후 머지 미확인 ${c.unmerged}건 — 관문은 통과했지만 같은 PR의 머지 기록이 없음(머지 못 했거나 기록 누락)`); list('미확인', t.unmerged, n => item(`${n.pr}${n.sha ? ` ${n.sha.slice(0, 7)}` : ''}`)); }
  } else lines.push('- 관문·머지 기록 없음 — 기록 없이 한 머지는 GitHub에서 확인');
  if (c.starts) { lines.push(`- 시작한 일감 ${c.starts}건`); list('일감', t.starts, n => item(`${n.work ? `${n.work} ` : ''}${n.text}`)); }
  return lines;
}

// start: 켠 autopilot 사건, endedAt: 끝 시각(ms). entries: 원장, decisionEvents: 결정 저장소 이력, readBody: 우편 지문 → 본문(없으면 null).
export function summarizeAutopilot({start, phase, endedAt, entries, decisionEvents, readBody}) {
  const startMs = Date.parse(start.t);
  const inWindow = e => { const ms = Date.parse(e.t); return ms >= startMs && ms <= endedAt; };
  const decisions = countDecisions(decisionEvents, startMs, endedAt);
  // AI 역할의 restart(stop+restart:true)와 감시기·대시보드 재시작(revive reason=restart 성공). 대시보드 재시작의 stop 줄(reason infra-restart)은 revive 줄과 겹치므로 세지 않는다.
  const restarts = entries.filter(e => inWindow(e) && ((e?.kind === 'stop' && e.restart === true && e.reason !== 'infra-restart') || (e?.kind === 'revive' && e.reason === 'restart' && e.result === 'started'))).length;
  const delivered = new Set((start.delivered ?? []).map(d => d.mailId).filter(Boolean));
  const sends = entries.filter(e => e?.kind === 'send' && inWindow(e) && !delivered.has(e.mailId));
  // 보류: 사람 우편함으로 간 `[Autopilot 보류] <한 줄>` 편지. 본문은 원장이 아니라 옆 파일에 있다.
  const held = sends.filter(e => isUserActor(e.role) && e.digest)
    .map(e => stripStoredHeader(readBody(e.digest), e)).filter(body => typeof body === 'string' && body.startsWith(HELD_PREFIX))
    .map(body => body.slice(HELD_PREFIX.length).trim().split('\n')[0].slice(0, 100));
  const tally = tallyNotes(entries.filter(e => e?.kind === 'autopilot-note' && inWindow(e)));
  // Wingman이 받은 경보: Autopilot 구간의 alert 사건 중 수신 근거가 WINGMAN_BASIS인 것을 경보 id당 한 번씩 센다(새 사건 종류 없음).
  const wingmanAlerts = new Set(entries.filter(e => e?.kind === 'alert' && e.route?.basis === WINGMAN_BASIS && e.delivered === true && inWindow(e)).map(e => e.id ?? e.requestId ?? `${e.alertKind}:${e.role}:${e.t}`)).size;
  const counts = {...decisions, restarts, mails: sends.length, held: held.length, wingmanAlerts, ...tally.counts};

  // 알림 상한 안에 제목·기간·집계가 모두 들어가야 한다. 넘치면 원문 표시를 먼저 줄이고, 그래도 넘치면 보류 상세를 뺀다(건수는 남는다).
  const render = (quoteLimit, showHeld, listN = 0) => {
    const lines = [];
    // 허용 키는 앞 5개만 보이고 나머지는 접는다. 이 첫 줄은 줄이기 단계에서 빼지 않는다.
    if (start.allow?.length) {
      const keys = start.allow.map(k => fold(k, 60)), more = keys.length - ALLOW_SHOWN;
      lines.push(`${ALLOW_LABEL}(--allow): ${keys.slice(0, ALLOW_SHOWN).join(', ')}${more > 0 ? ` 외 ${more}개 (전체: kadan autopilot status)` : ''} — kyle "${fold(start.quote, quoteLimit)}"`);
    }
    lines.push(start.viaChat
      ? `대리 위임: ${start.by}이(가) kyle의 채팅 말을 옮겨 적었습니다 — "${fold(start.quote, quoteLimit)}" (전체 원문: kadan autopilot status --text, 원장)`
      : `kyle 위임: "${fold(start.text, quoteLimit)}" (전체: kadan autopilot status --text, 원장)`);
    // Wingman 이름(없으면 "Wingman 없음")은 제목 줄 끝에 둔다. 줄이기 단계에서 빼지 않는다. 위임·허용 줄이 앞 줄이라는 기존 읽는 쪽 약속은 지킨다.
    lines.push(`${MODE} 요약 (${stamp(startMs)} ~ ${stamp(endedAt)}, ${REASON[phase] ?? phase}) · ${WINGMAN} ${start.wingman ? fold(start.wingman, 60) : NO_WINGMAN}`);
    const autopilot = [];
    if (decisions.answered) autopilot.push(`결정 답 ${decisions.answered}건`);
    if (decisions.chatRegistered) autopilot.push(`채팅 등록 ${decisions.chatRegistered}건`);
    if (decisions.cancelledByHuman) autopilot.push(`사람이 취소한 결정 ${decisions.cancelledByHuman}건`);
    if (restarts) autopilot.push(`재시작 ${restarts}건`);
    if (sends.length) autopilot.push(`우편 ${sends.length}건`);
    if (held.length) autopilot.push(`보류로 남긴 것 ${held.length}건`);
    if (wingmanAlerts) autopilot.push(`Wingman이 받은 경보 ${wingmanAlerts}건`);
    // autopilot-note 기록이 있으면 전체 "없음"이라 쓰지 않고, 비어 있는 기존 집계(결정 답·우편·재시작)만 좁혀 없음으로 쓴다.
    const noAutopilot = tally.total ? '- 결정 답·우편·재시작 없음 (아래 "기록한 일" 참고)' : '- 켜진 동안 처리한 일 없음';
    lines.push('켜진 동안 생긴 일', autopilot.length ? `- ${autopilot.join(' · ')}` : noAutopilot);
    if (showHeld) for (const item of held.slice(0, HELD_LISTED)) lines.push(`  · 보류: ${item}`);
    if (showHeld && held.length > HELD_LISTED) lines.push(`  · 그 밖 ${held.length - HELD_LISTED}건`);
    if (decisions.mergeAnswered || decisions.mergeCancelled)
      lines.push(`- 머지 관련 결정 답 ${decisions.mergeAnswered}건·취소 ${decisions.mergeCancelled}건 — 실제 머지는 GitHub에서 확인`);
    lines.push('위임으로 대신 처리한 일', decisions.cancelledBySuper
      ? `- 슈퍼감독이 대신 닫은 결정 ${decisions.cancelledBySuper}건`
      : tally.total ? '- 슈퍼감독이 대신 닫은 결정 없음 (note로 대신 정한 결정은 아래 "기록한 일" 참고)' : '- 없음');
    lines.push(...noteLines(tally, listN));
    return lines.join('\n');
  };
  // 줄이기 순서: 원문 표시 → 기록 목록 개수 → 상세 전부(건수는 남는다).
  const text = [[200, true, 5], [80, true, 5], [80, true, 2], [80, false, 0]].map(([q, h, n]) => render(q, h, n)).find(t => t.length <= NOTICE_LIMIT) ?? render(80, false, 0).slice(0, NOTICE_LIMIT); // 마지막 후보도 넘으면 자른다
  return {counts, held, text};
}
