// 늦게 뜬 슈퍼감독에게 켜진 Autopilot을 알리는 길(2026-11-23 kyle: "새 세션을 연다거나 이럴 때 허점").
// 켜짐 우편은 켤 때 열린 업무가 있던 슈퍼감독에게만 갔다. 그 뒤에 새로 뜨거나(첫 안내) 업무를 받은 슈퍼감독은 켜진 줄 모른다.
// 전달 기록은 `autopilot` 사건을 건드리지 않는다: autopilot 사건에 phase를 더하면 autopilotState의 "마지막 사건" 계산이 꺼짐으로 읽힌다.
// 옛 on 사건은 고치지 않고(append-only) 따로 `autopilot-delivery` 사건을 더한다.
// 상주 경로가 아니다: 첫 안내 때 한 번, `kadan autopilot deliver` 한 번에 원장을 한 번 읽는다(감시기 새 주기 없음).
//
// 받은 것으로 세는 것(2026-11-23 검수 반영, 수정 2에서 예약·잠금을 걷어냄):
//  - 켤 때: on.delivered에서 `ok:true` 또는 `delivery: 'sent'`(전달됨·기록 실패)인 역할만. not-sent·unknown은 받지 않은 것이다(on.to 전체가 아니다).
//  - 늦게: 이 켜짐(onAt)의 전달 사건 중 `ok`·`sent`가 하나라도 있는 역할. not-sent·unknown은 받지 않은 것이라 다시 보낸다.
// 보내기 직전에 원장을 한 번 보고 이미 받았으면 건너뛰고, 아니면 보낸 뒤 실제 결과를 기록한다. 예약·잠금은 없다:
// 순서대로 일어나는 두 번은 1건이고, 정확히 동시에 겹친 두 실행의 중복 1통은 받아들인다(숨은 누락·막힘보다 무해한 소음이 낫다).
import {buildAutopilotMessage, endOf, storedDecideAfterMs} from './autopilot.mjs';

export const DELIVERY_KIND = 'autopilot-delivery';
const COUNTED = new Set(['ok', 'sent']);

// 켤 때 실제로 전달된 역할.
const onTimeRoles = on => new Set((on?.delivered ?? []).filter(d => d?.role && (d.ok === true || d.delivery === 'sent')).map(d => d.role));
// 이 켜짐에 늦게 전달된 역할(ok·sent 사건이 있는 역할).
const lateReceived = (entries, on) => new Set(entries.filter(e => e?.kind === DELIVERY_KIND && e.onAt === on?.t && e.role && COUNTED.has(e.delivery)).map(e => e.role));

export function receivedRoles(entries, on) {
  return new Set([...onTimeRoles(on), ...lateReceived(entries, on)]);
}

// 늦게(켠 뒤) 받은 역할: status.lateDelivered. 켤 때 받은 역할은 뺀다.
export function lateRoles(entries, on) {
  const early = onTimeRoles(on);
  return [...lateReceived(entries, on)].filter(role => !early.has(role)).sort();
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

// 보낸 결과 사건: ok(전달됨)·sent(전달됨, 기록 실패)·not-sent(확실히 안 감)·unknown(갔는지 모름).
export function finishDelivery({on, role, via, by, result, now = Date.now(), record}) {
  const delivery = result.ok ? 'ok' : (result.delivery ?? 'unknown');
  record({kind: DELIVERY_KIND, onAt: on.t, role, via, by, delivery, ...(result.mailId ? {mailId: result.mailId} : {}), t: new Date(now).toISOString()});
}

// 첫 안내 전송이 던진 오류의 실제 전달 결과. 보내기 시스템이 오류에 붙인 delivery(not-sent|sent|unknown)를 그대로 쓰고 없으면 unknown(재시도 대상).
export const failedResult = error => ({ok: false, delivery: ['not-sent', 'sent', 'unknown'].includes(error?.delivery) ? error.delivery : 'unknown'});
