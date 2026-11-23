// 늦게 뜬 슈퍼감독에게 켜진 Autopilot을 알리는 길(2026-11-23 kyle: "새 세션을 연다거나 이럴 때 허점").
// 켜짐 우편은 켤 때 열린 업무가 있던 슈퍼감독에게만 갔다. 그 뒤에 새로 뜨거나(첫 안내) 업무를 받은 슈퍼감독은 켜진 줄 모른다.
// 전달 기록은 `autopilot` 사건을 건드리지 않는다: autopilot 사건에 phase를 더하면 autopilotState의 "마지막 사건" 계산이 꺼짐으로 읽힌다.
// 옛 on 사건은 고치지 않고(append-only) 따로 `autopilot-delivery` 사건을 더한다. 같은 켜짐(onAt = on 사건 시각)에 같은 역할은 한 번만 보낸다.
// 상주 경로가 아니다: 첫 안내 때 한 번, `kadan autopilot deliver` 한 번에 원장을 한 번 읽는다(감시기 새 주기 없음).
import {buildAutopilotMessage, endOf, storedDecideAfterMs} from './autopilot.mjs';

export const DELIVERY_KIND = 'autopilot-delivery';

// 이 켜짐(on 사건)에 켤 때 받았거나(on.to) 늦게 받은 역할. 전달이 확실히 안 갔다고 기록된 것은 받지 못한 것으로 본다.
export function receivedRoles(entries, on) {
  const roles = new Set(on?.to ?? []);
  for (const e of entries) if (e?.kind === DELIVERY_KIND && e.onAt === on?.t && e.role && e.delivery !== 'not-sent') roles.add(e.role);
  return roles;
}

export const lateRoles = (entries, on) => [...receivedRoles(entries, on)].filter(role => !(on?.to ?? []).includes(role)).sort();

// 켜진 on 사건이 이 역할에게 줄 우편 본문. 켤 때 보낸 것과 같은 글이다(금지 목록 포함): 한 줄만 주면 금지 규칙 없이 켜진 줄만 아는 세션이 생긴다.
export function lateMessage(on, role) {
  const end = endOf(on);
  return buildAutopilotMessage({
    text: on.text, quote: on.quote ?? '', viaChat: on.viaChat === true, by: on.by,
    untilMs: end.kind === 'at' ? end.ms : null, level: on.level, allow: on.allow,
    isWingman: Boolean(on.wingman) && on.wingman === role, decideAfterMs: storedDecideAfterMs(on),
  });
}

// 전달 사건. by는 보낸 쪽, via는 첫 안내(start) 또는 deliver 명령.
export function deliveryEvent({on, role, via, by, result, now}) {
  return {kind: DELIVERY_KIND, onAt: on.t, role, via, by, delivery: result.ok ? 'ok' : (result.delivery ?? 'unknown'),
    ...(result.mailId ? {mailId: result.mailId} : {}), t: new Date(now).toISOString()};
}
