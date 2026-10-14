// Why: 같은 역할 이름을 새 대화가 다시 쓰면, 이름으로만 이어진 옛 세대의 열린 업무·카드가 새 세션의 "놀고 있음" 할 일로 잡혔다.
// 우편(mail-generation.mjs)과 같은 세대 경계를 쓴다 — 판정을 새로 만들지 않는다. 기준은 업무·카드의 생성 시각이 아니라
// "그 이름에 책임이 마지막으로 붙은 시각"(생성·재배정·확정 인계)이다. 숨기되 잃지 않는다: 계산에서만 거르고 대시보드에 건수로 보인다.
import {createMailGenerations} from './mail-generation.mjs';

export function ownerGenerations(entries) {
  const generations = createMailGenerations();
  (entries ?? []).forEach((entry, index) => generations.apply(entry, index));
  return generations;
}

// role의 현재 세대가 at(ISO 시각) 이후에 시작됐으면 그 책임은 이전 세대 소속이다. 시각을 모르면 이전 세대로 보지 않는다.
export const isPreviousOwner = (generations, role, at) => Boolean(role) && generations.isPreviousAt(role, at);
