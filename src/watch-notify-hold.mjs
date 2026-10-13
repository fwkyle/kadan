import { isNotificationHold } from './notification-guard.mjs';

// 입력 보호로 알림이 밀린 횟수를 받는 창(역할) 단위로 센다(2026-10-13 [kyle]).
// 3번 연속이면 사용자에게 알리고, 5번 연속이면 입력 보호만 건너뛰고 넣는다. 카운터는 메모리에만 두며
// 감시기를 다시 시작하면 0부터 센다.
export const NOTIFY_WARN_AT = 3;
export const NOTIFY_FORCE_AT = 5;

export const notifyHeldAlertId = role => `notify-held:${role}`;

export class NotifyHoldTracker {
  constructor({record = () => {}} = {}) {
    this.record = record;
    this.streaks = new Map(); // role -> {count, code, message, since}
    this.heldNow = new Map();
    this.sentNow = new Set();
    this.forcedNow = new Set();
  }

  // 한 주기의 시작. 이번 주기에 밀린 창·전달된 창을 새로 모은다.
  beginCycle() {
    this.heldNow = new Map();
    this.sentNow = new Set();
    this.forcedNow = new Set();
  }

  // 이 창은 이미 5번 연속 밀렸다 — 입력 보호를 건너뛰고 넣을 차례다.
  forced(role) { return (this.streaks.get(role)?.count ?? 0) >= NOTIFY_FORCE_AT; }

  // 붙여넣기 직전 검사에 넘길 값. 강제 차례면 undefined를 돌려 입력 보호만 건너뛴다.
  // 생존·PID 대조·복사 모드 확인은 guardedSend와 바닥 send가 그대로 한다.
  guardFor(role, guard) {
    if (!this.forced(role)) return guard;
    this.forcedNow.add(role);
    return undefined;
  }

  // 입력 보호에 걸려 못 넣었다. 보호 때문이 아닌 오류는 밀림으로 세지 않는다.
  held(role, error) {
    if (!role || !error) return;
    const code = error.code ?? 'KADAN_NOTIFY_HOLD';
    this.heldNow.set(role, {code, message: error.message ?? ''});
  }

  // 입력 보호 오류인지 보고 센다. 처리한 오류는 그대로 다시 던지도록 호출자가 맡는다.
  heldIfGuard(role, error) {
    if (isNotificationHold(error)) this.held(role, error);
  }

  delivered(role) {
    if (!role) return;
    this.sentNow.add(role);
    if (this.forcedNow.has(role)) {
      const streak = this.streaks.get(role);
      this.record({kind: 'watch-notify-forced', by: 'watch', role, count: streak?.count ?? NOTIFY_FORCE_AT,
        code: streak?.code ?? null, reason: streak?.message ?? null, since: streak?.since ?? null,
        t: new Date().toISOString()});
    }
  }

  // 주기 끝. 이번 주기에 밀렸고 전달은 못 한 창만 +1, 나머지는 0으로 되돌린다.
  endCycle(now) {
    for (const [role, held] of this.heldNow) {
      if (this.sentNow.has(role)) { this.streaks.delete(role); continue; }
      const previous = this.streaks.get(role);
      this.streaks.set(role, {count: (previous?.count ?? 0) + 1, code: held.code, message: held.message,
        since: previous?.since ?? new Date(now).toISOString()});
    }
    for (const role of [...this.streaks.keys()]) if (!this.heldNow.has(role)) this.streaks.delete(role);
  }

  // 3번 이상 이어진 창의 열린 경보. 사용자에게만 간다. 같은 연속 구간에서는 id가 같아 한 번만 울린다.
  // session을 달지 않는다 — 달면 작업 감시 범위 밖 역할(감독·카드 없는 창)의 경보를 감시 제외로 닫아 매 주기 다시 울린다.
  alerts() {
    return [...this.streaks].filter(([, s]) => s.count >= NOTIFY_WARN_AT).map(([role, s]) => ({
      id: notifyHeldAlertId(role), kind: '알림밀림', level: 'AMBER', role,
      holdCount: s.count, holdCode: s.code, heldSince: s.since,
    }));
  }
}
