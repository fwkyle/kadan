// 역할 이름과 무관한 직속 보고 관계. @user는 OS 알림과 watch 출력의 최종 수신자다.
export const USER_RECIPIENT = "@user";

export function parseHierarchy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("hierarchy는 역할:상위 역할 JSON 객체여야 한다");
  }
  const parents = new Map(Object.entries(value));
  for (const [role, parent] of parents) {
    if (!role || /\s/.test(role) || role === USER_RECIPIENT ||
        typeof parent !== "string" || !parent || /\s/.test(parent)) {
      throw new Error(`hierarchy 잘못된 역할/상위: ${role}`);
    }
    const visited = new Set([role]);
    let next = parent;
    while (next !== USER_RECIPIENT) {
      if (visited.has(next)) throw new Error(`hierarchy 순환: ${role}`);
      if (!parents.has(next)) throw new Error(`hierarchy 상위 미등록: ${next}`);
      visited.add(next);
      next = parents.get(next);
    }
  }
  return parents;
}

export function hierarchyRoute(role, parents, liveSessions) {
  if (!parents?.has(role)) return undefined;
  const live = new Set(liveSessions), skipped=[];
  let parent = parents.get(role);
  while (parent !== USER_RECIPIENT) {
    if (live.has(`kadan-${parent}`)) return {recipient:parent,basis:'hierarchy',skipped};
    skipped.push(parent);parent = parents.get(parent);
  }
  return {recipient:USER_RECIPIENT,basis:'hierarchy',skipped};
}
export function hierarchyRecipient(role, parents, liveSessions) {
  return hierarchyRoute(role,parents,liveSessions)?.recipient;
}

export function isDescendant(role, ancestor, parents) {
  let next = role;
  while (parents.has(next)) {
    if (next === ancestor) return true;
    next = parents.get(next);
  }
  return false;
}
