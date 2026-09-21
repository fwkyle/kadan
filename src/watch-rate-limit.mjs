import {createHash} from 'node:crypto';

export const RETRY_DELAYS = [60_000, 120_000, 180_000];
const hardLimit = /insufficient_quota|billing_hard_limit|daily.{0,30}(quota|limit)|requests per day|\bRPD\b|credit.{0,20}(exhausted|insufficient)|잔액 부족|일일.{0,10}한도/iu;

// Only a terminal CLI error followed by an empty prompt; tool/API output is not a resume signal.
export function terminal429(screen, now) {
  if (typeof screen !== 'string') return null;
  const lines = screen.split('\n');
  const index = lines.findLastIndex(line => /^\s*[■✕×]\s*.*(?:exceeded retry limit|429 Too Many Requests)/iu.test(line));
  if (index < 0) return null;
  const tail = lines.slice(index).join('\n');
  if (!/429|Too Many Requests/iu.test(tail)) return null;
  if (/Working\s*\(|esc to interrupt|Reconnecting|Retrying|Messages to be submitted|KADAN:DONE/iu.test(tail)) return null;
  if (!/^\s*›\s*(?:Ask Codex to do anything)?\s*$/mu.test(tail)) return null;
  if (lines.slice(index).some(line => /^\s*›\s*\S/u.test(line) && !/^\s*›\s*Ask Codex to do anything\s*$/u.test(line))) return null;
  const error = tail.split(/^\s*›/mu)[0].trim();
  const retry = error.match(/Retry-After\s*:\s*([^\n]+)/iu)?.[1]?.trim();
  let afterMs = 0;
  if (retry) {
    afterMs = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now;
    if (!Number.isFinite(afterMs)) return {blocked: true};
  }
  // Include preceding error occurrences to distinguish a new failure from retained scrollback.
  const fingerprint = createHash('sha256').update(lines.slice(0,index + 1).filter(line => /^\s*[■✕×]/u.test(line)).join('\n') + error).digest('hex');
  return {blocked: hardLimit.test(error), afterMs: Math.max(0, afterMs), fingerprint};
}

export class RateLimitRetry {
  constructor({record, resume}) { this.record = record; this.resume = resume; }

  tick({observations, tasks, entries, now, fresh}) {
    const suppressed = new Set();
    this.alerts = [];
    if (!this.resume) return suppressed;
    const latest = new Map(entries.filter(e=>e.kind==='rate-limit-retry').map(e=>[e.key,e]));
    for(const last of latest.values()) {
      if(last.action==='scheduled' && (!observations.has(last.session) || !tasks.some(t=>t.role===last.role&&t.taskId===last.taskId)))
        this.record({...last, action:'cancelled', at:now, reason:'no-active-owner'});
    }
    for (const [session, seen] of observations) {
      const assigned = tasks.filter(task => task.role === seen.role);
      if (!seen.alive || !seen.pid || String(seen.pid) !== String(seen.expectedPid)) continue;
      const success = entries.findLast(e=>e.kind==='done'&&e.role===seen.role&&e.result==='ok');
      const key = `${session}:${seen.startedAt}:${seen.pid}:${success?.t ?? 'no-success'}`;
      const history = entries.filter(e => e.kind === 'rate-limit-retry' && e.key === key);
      const last = history.at(-1);
      const used = history.filter(e => e.action === 'attempt').length;
      const error = terminal429(seen.screen, now);
      const emit = (action, more = {}) => this.record({kind:'rate-limit-retry', by:'watch', key, role:seen.role,
        session, pid:seen.pid, at:now, action, ...more});
      const pending = last?.action === 'scheduled';
      const notify = reason => this.alerts.push({id:`rate-limit:${key}`,kind:'한도',level:'AMBER',
        role:seen.role,session,line:reason});
      if(assigned.length===1 && error?.blocked)notify('명시 한도/재시도 시각 확인 필요 — 자동 재개 제외');
      if (assigned.length !== 1 || !error || error.blocked) {
        if (pending) emit('cancelled', {reason:'inactive-or-screen-changed'});
        continue;
      }
      const taskId = assigned[0].taskId;
      if (pending) {
        const newInput = entries.some(e => e.kind === 'send' && e.transport !== 'mailbox' && e.role === seen.role && Date.parse(e.t) > last.at);
        if (last.taskId !== taskId || error.fingerprint !== last.fingerprint || newInput) {
          emit('cancelled', {reason:'input-changed'}); continue;
        }
        suppressed.add(session);
        if (now < last.dueAt) continue;
        // Final fresh scope/screen check immediately before the guarded send.
        if (!fresh(session, seen, taskId, error.fingerprint)) {
          emit('cancelled', {reason:'pre-send-changed'}); continue;
        }
        emit('attempt', {taskId, attempt:used + 1, fingerprint:error.fingerprint});
        try {
          this.resume(seen.role, `일시적 429 뒤 제한 재개 ${used + 1}/3입니다. 현재 실행 ${taskId}의 최신 승인과 저장 영수증부터 확인하고 미완료 지점만 이어가세요. 완료된 DB 저장·배포·도구 명령은 반복하지 마세요. 사용자 중지/상한/계정·모델을 유지하세요.`, seen.pid);
        } catch {
          emit('delivery-failed', {taskId, reason:'not-retried'});
          suppressed.delete(session);
        }
        continue;
      }
      if (used >= RETRY_DELAYS.length || last?.action === 'delivery-failed') {
        notify(last?.action==='delivery-failed'?'재개 전달 실패 — 중복 전송하지 않음':'429 제한 재개 3회 소진');
        continue;
      }
      if (last?.fingerprint === error.fingerprint) continue;
      // No new task may reset this session's retry count.
      const dueAt = now + Math.max(RETRY_DELAYS[used], error.afterMs);
      emit('scheduled', {taskId, attempt:used + 1, dueAt, fingerprint:error.fingerprint});
      suppressed.add(session);
    }
    return suppressed;
  }
}
