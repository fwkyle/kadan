// Why: 상위가 kadan stop으로 일부러 끈 세션은 죽음 경보 대상이 아니다. 감독·작업자·검수자 감시가 같은 판정을 쓴다.
// 세션별 마지막 수명 사건(start·stop). 원장 꼬리만 이어 읽는다: 처음 한 번만 앞에서부터 훑고 이후는 새로 붙은 사건만 본다.
// 원장이 10배면 처음 한 번의 훑기만 10배이고 주기마다 드는 비용은 그대로다. 죽은 세션이 범위에 있을 때만 부른다.
// 일부러 끈 것 = 마지막 수명 사건이 stop이고 restart: true가 아니다. 그 뒤 start가 있으면(reopen 포함) 마지막이 start라 해당 없다.
export class LifecycleTail {
  last = new Map();
  scanned = 0;
  intendedStop(entries, session) {
    if (entries.length < this.scanned) { this.last.clear();this.scanned = 0; }
    for (; this.scanned < entries.length; this.scanned++) {
      const e = entries[this.scanned];
      if (e?.kind === 'start' || e?.kind === 'stop') this.last.set(e.session, e);
    }
    const e = this.last.get(session);
    return e?.kind === 'stop' && e.restart !== true;
  }
}
