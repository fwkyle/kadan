import {createHash} from 'node:crypto';

// 실행기 입력 큐의 명시 배너만 감지한다. 일반 프롬프트·승인 질문·진행 중·완료 마커 뒤 화면은 대상이 아니다.
export const QUEUE_BANNER = 'Press Enter to send queued messages now';
const doneMarker = /^\s*KADAN:DONE\s+\S+\s+(?:ok|failed)\s*$/mu;
const progressMark = /Thinking|Working|esc to interrupt|Running tool|Executing|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/u;
const approvalPrompt = /\[Y\/n\]|\[y\/N\]|\(y\/n\)|\(Y\/n\)|\bAllow\b|\bApprove\b|Do you want to|승인|허용하시겠|계속할까요/iu;
const placeholder = /Ask (Devin|Codex|Claude|me)|Ask anything|무엇이든/iu;

// 큐 배너가 있으면 배너~화면 끝의 지문과 안전 차단 이유를 돌려준다. unsafe가 있으면 Enter를 보내지 않는다.
export function queuedInputBanner(screen) {
  if (typeof screen !== 'string') return null;
  const lines = screen.split('\n');
  const index = lines.findLastIndex(line => line.includes(QUEUE_BANNER));
  if (index < 0) return null;
  const tail = lines.slice(index + 1).join('\n');
  // 지문은 화면 전체를 해시한다. 같은 화면의 반복 전송만 막고, 위쪽 내용이 바뀐 새 배너는 새 사건으로 본다.
  const fingerprint = createHash('sha256').update(screen.trim()).digest('hex');
  if (doneMarker.test(tail) || progressMark.test(tail)) return null;
  if (approvalPrompt.test(tail)) return {fingerprint, unsafe: '승인 질문이 함께 표시됨'};
  const partial = lines.slice(index + 1).find(line => /^\s*[›>❯]\s*\S/u.test(line) && !placeholder.test(line));
  if (partial) return {fingerprint, unsafe: '입력창에 미완성 텍스트가 있음'};
  return {fingerprint, unsafe: null};
}

// 안전 조건이 모두 맞을 때 같은 세션에 빈 Enter를 지문당 1회만 보낸다.
// 실패·불안전은 재시도하지 않고 이유를 구분해 감독 경보를 1회 만든다.
export class QueueResume {
  constructor({record, sendEnter = null, readScreen = null, probeCount = 3, probeIntervalMs = 800, sleep = ms => new Promise(r => setTimeout(r, ms))}) {
    this.record = record; this.sendEnter = sendEnter; this.readScreen = readScreen;
    this.probeCount = probeCount; this.probeIntervalMs = probeIntervalMs; this.sleep = sleep;
    this.alerts = [];
  }

  async tick({observations, tasks, cards, entries, now, fresh}) {
    this.alerts = [];
    const handled = new Set();
    if (!this.sendEnter) return handled;
    for (const [session, seen] of observations) {
      const banner = queuedInputBanner(seen.screen);
      const assigned = tasks.filter(t => t.role === seen.role);
      const key = `${session}:${seen.startedAt}:${seen.pid}:${assigned.map(t => t.taskId).join(',') || '-'}`;
      const history = entries.filter(e => e.kind === 'queue-resume' && e.key === key);
      const last = history.at(-1);
      const emit = (action, more = {}) => this.record({kind:'queue-resume', by:'watch', key, role:seen.role, session, pid:seen.pid, at:now, action, ...more});
      const alertOnce = reason => this.alerts.push({id:`queue-resume:${key}:${banner?.fingerprint ?? 'none'}`, kind:'입력큐', level:'AMBER', role:seen.role, session, line:reason});
      if (!banner) {
        // 직전 Enter로 배너가 사라졌으면 관찰 전환을 별도로 남긴다.
        if (last?.action === 'sent') emit('transition', {fingerprint:last.fingerprint, transition:'cleared'});
        continue;
      }
      if (last?.action === 'sent' && last.fingerprint !== banner.fingerprint) emit('transition', {fingerprint:last.fingerprint, transition:'screen-changed'});
      const handledFingerprint = history.findLast(e => e.fingerprint === banner.fingerprint && ['sent','not-sent','delivery-failed'].includes(e.action));
      if (handledFingerprint) {
        if (handledFingerprint.action === 'sent') alertOnce('Enter 전달 뒤 큐 배너 유지 — 자동 재시도하지 않음');
        continue;
      }
      if (banner.unsafe) { emit('not-sent', {reason:banner.unsafe, fingerprint:banner.fingerprint}); alertOnce(banner.unsafe); continue; }
      if (assigned.length === 0) { emit('not-sent', {reason:'카드 완료 또는 미발령', fingerprint:banner.fingerprint}); alertOnce('큐 배너가 보이지만 미완료 발령 카드가 없음'); continue; }
      if (assigned.length > 1) { emit('not-sent', {reason:'실행 대상 불명확', fingerprint:banner.fingerprint}); alertOnce('담당 실행이 여러 개라 자동 Enter를 보내지 않음'); continue; }
      const card = cards.find(c => c.id === assigned[0].taskId);
      if (card?.activity !== 'running') continue; // 보고 대기·미보고 상태는 조용히 둔다
      if (!seen.alive) { emit('not-sent', {reason:'죽은 pane', fingerprint:banner.fingerprint}); alertOnce('세션 없음 또는 죽은 pane'); continue; }
      if (String(seen.pid) !== String(seen.expectedPid)) { emit('not-sent', {reason:'PID 불일치', fingerprint:banner.fingerprint}); alertOnce('PID 불일치 — 사람 확인 필요'); continue; }
      if (fresh && !fresh(session, seen, assigned[0].taskId, banner.fingerprint)) {
        emit('not-sent', {reason:'전송 직전 상태 변경', fingerprint:banner.fingerprint});
        alertOnce('전송 직전 카드·세션·화면이 바뀜');
        continue;
      }
      emit('attempt', {taskId:assigned[0].taskId, fingerprint:banner.fingerprint});
      let receipt;
      try { receipt = this.sendEnter(seen.role, seen.pid) || {}; }
      catch (error) {
        const reason = error.code === 'KADAN_PANE_IN_MODE' ? 'copy mode(기록보기) 중'
          : error.code === 'KADAN_PANE_MODE_UNKNOWN' ? 'pane 모드 조회 실패' : 'Enter 전달 실패';
        emit('delivery-failed', {taskId:assigned[0].taskId, fingerprint:banner.fingerprint, reason});
        alertOnce(`${reason} — 재시도하지 않음`);
        continue;
      }
      emit('sent', {taskId:assigned[0].taskId, fingerprint:banner.fingerprint,
        keyDelivery:receipt.keyDelivery ?? 'sent', inputAcceptance:receipt.inputAcceptance ?? 'unconfirmed'});
      handled.add(session);
      // Enter 뒤 짧고 제한된 확인: 배너 소거·진행 전환만 기록하고 작업 성공으로 확대하지 않는다.
      let transition = 'none';
      for (let i = 0; i < this.probeCount && transition === 'none'; i++) {
        await this.sleep(this.probeIntervalMs);
        let screen = null;
        try { screen = this.readScreen?.(session) ?? null; } catch { screen = null; }
        if (screen == null) continue;
        const next = queuedInputBanner(screen);
        if (!next) { transition = progressMark.test(screen) ? 'progress' : 'cleared'; }
        else if (next.fingerprint !== banner.fingerprint) transition = 'banner-held';
      }
      emit('transition', {taskId:assigned[0].taskId, fingerprint:banner.fingerprint, transition});
      if (transition === 'none' || transition === 'banner-held') alertOnce('Enter 전달 뒤 진행 전환을 확인하지 못함 — 자동 재시도하지 않음');
    }
    return handled;
  }
}
