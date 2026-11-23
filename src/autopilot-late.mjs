// 늦게 뜬 슈퍼감독에게 켜진 Autopilot을 알리는 길(2026-11-23 kyle: "새 세션을 연다거나 이럴 때 허점").
// 켜짐 우편은 켤 때 열린 업무가 있던 슈퍼감독에게만 갔다. 그 뒤에 새로 뜨거나(첫 안내) 업무를 받은 슈퍼감독은 켜진 줄 모른다.
// 전달 기록은 `autopilot` 사건을 건드리지 않는다: autopilot 사건에 phase를 더하면 autopilotState의 "마지막 사건" 계산이 꺼짐으로 읽힌다.
// 옛 on 사건은 고치지 않고(append-only) 따로 `autopilot-delivery` 사건을 더한다. 같은 켜짐(onAt = on 사건 시각)에 같은 역할은 한 번만 보낸다.
// 상주 경로가 아니다: 첫 안내 때 한 번, `kadan autopilot deliver` 한 번에 원장을 한 번 읽는다(감시기 새 주기 없음).
//
// 받은 것으로 세는 것(2026-11-23 검수 반영):
//  - 켤 때: on.delivered에서 `ok:true` 또는 `delivery: 'sent'`(전달됨·기록 실패)인 역할만. not-sent·unknown은 받지 않은 것이다(on.to 전체가 아니다).
//  - 늦게: 역할별로 이 켜짐(onAt)의 마지막 전달 사건이 reserved(보내는 중)·ok·sent이면 받은 것, not-sent·unknown이면 아니다.
//    reserved는 보내기 직전 예약이다: 겹친 start·deliver가 같은 역할에 두 번 보내지 않게 한다. 보내다 죽어 reserved로 남으면 받은 것으로 남는다(두 번 보내는 쪽보다 안전한 쪽).
import fs from 'node:fs';
import path from 'node:path';
import {appendLedger, readLedger} from './ledger.mjs';
import {acquireDirLock} from './dir-lock.mjs';
import {buildAutopilotMessage, endOf, storedDecideAfterMs} from './autopilot.mjs';

export const DELIVERY_KIND = 'autopilot-delivery';
const COUNTED = new Set(['reserved', 'ok', 'sent']);

// 켤 때 실제로 전달된 역할.
const onTimeRoles = on => new Set((on?.delivered ?? []).filter(d => d?.role && (d.ok === true || d.delivery === 'sent')).map(d => d.role));

// 이 켜짐의 늦은 전달 사건에서 역할별 마지막 상태.
function lateStates(entries, on) {
  const states = new Map();
  for (const e of entries) if (e?.kind === DELIVERY_KIND && e.onAt === on?.t && e.role) states.set(e.role, e.delivery);
  return states;
}

export function receivedRoles(entries, on) {
  const roles = onTimeRoles(on);
  for (const [role, delivery] of lateStates(entries, on)) if (COUNTED.has(delivery)) roles.add(role);
  return roles;
}

// 늦게(켠 뒤) 받은 역할: status.lateDelivered. 켤 때 받은 역할은 뺀다.
export function lateRoles(entries, on) {
  const early = onTimeRoles(on);
  return [...lateStates(entries, on)].filter(([role, delivery]) => COUNTED.has(delivery) && !early.has(role)).map(([role]) => role).sort();
}

// 켜진 on 사건이 이 역할에게 줄 우편 본문. 켤 때 보낸 것과 같은 글이다(금지 목록 포함): 한 줄만 주면 금지 규칙 없이 켜진 줄만 아는 세션이 생긴다.
export function lateMessage(on, role) {
  const end = endOf(on);
  return buildAutopilotMessage({
    text: on.text, quote: on.quote ?? '', viaChat: on.viaChat === true, by: on.by,
    untilMs: end.kind === 'at' ? end.ms : null, level: on.level, allow: on.allow,
    isWingman: Boolean(on.wingman) && on.wingman === role, decideAfterMs: storedDecideAfterMs(on),
  });
}

const event = ({on, role, via, by, delivery, mailId, now}) => ({
  kind: DELIVERY_KIND, onAt: on.t, role, via, by, delivery, ...(mailId ? {mailId} : {}), t: new Date(now).toISOString(),
});

// 보내기 직전 예약. 폴더 잠금(기존 dir-lock) 안에서 원장을 다시 읽어 이미 받았으면 false, 아니면 예약 사건을 적고 true.
// 잠금은 확인과 예약 한 번만 잡는다(보내는 동안은 잡지 않는다). 잠금을 못 얻으면 보내지 않는다(false, 나중에 deliver로 채운다).
export function claimDelivery(home, {on, role, via, by, now = Date.now(), readEntries = () => readLedger(home), record = entry => appendLedger(entry, home)}) {
  const lock = path.join(home, 'autopilot-delivery.lock');
  if (!acquireDirLock(lock)) return false;
  try {
    if (receivedRoles(readEntries(), on).has(role)) return false;
    record(event({on, role, via, by, delivery: 'reserved', now}));
    return true;
  } finally { fs.rmdirSync(lock); }
}

// 보낸 결과 사건: ok(전달됨)·sent(전달됨, 기록 실패)·not-sent(확실히 안 감)·unknown(갔는지 모름). 예약을 덮는다(마지막 사건이 이긴다).
export function finishDelivery({on, role, via, by, result, now = Date.now(), record}) {
  const delivery = result.ok ? 'ok' : (result.delivery ?? 'unknown');
  record(event({on, role, via, by, delivery, mailId: result.mailId, now}));
}
