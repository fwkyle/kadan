// Why: "슈퍼감독이 누구인가"를 관계표의 위치(상위가 @user)로만 알아보면, 비서가 세운 슈퍼감독이나 총괄 아래의
// 레포 슈퍼감독을 놓친다. 시작할 때 기록한 프로필(roleProfile)을 기준으로 삼고, 프로필 기록이 하나도 없는
// 옛 역할만 예전 기준(상위가 @user)으로 본다. "최상위인가"(위치)를 묻는 곳은 이 함수를 쓰지 않는다.
const roleOf = e => e.role ?? String(e.session ?? '').replace(/^kadan-/, '');

// 역할별로 roleProfile을 기록한 가장 최근 start의 프로필. 프로필 기록이 있는 start가 없는 역할은 맵에 없다.
export function superProfiles(entries) {
  const profiles = new Map();
  for (const e of entries ?? []) {
    if (e?.kind !== 'start' || typeof e.roleProfile !== 'string' || !e.roleProfile) continue;
    profiles.set(roleOf(e), e.roleProfile);
  }
  return profiles;
}

const asMap = value => value instanceof Map ? value : new Map(Object.entries(value ?? {}));

// profiles가 null이면(원장을 못 읽음) 프로필을 모르므로 예전 기준으로 돌아간다.
export function isSuperRole(role, parents, profiles = null) {
  const table = asMap(parents);
  if (profiles?.has(role)) return profiles.get(role) === 'super';
  return table.get(role) === '@user';
}

// 자기 자신부터 위로 올라가며 처음 만나는 슈퍼감독. 관계표에 없거나 끊기거나 순환이면 null.
export function nearestSuper(role, parents, profiles = null) {
  const table = asMap(parents);
  let r = role;
  for (let i = 0; i < 64 && typeof r === 'string'; i++) {
    if (!table.has(r)) return null;
    if (isSuperRole(r, table, profiles)) return r;
    r = table.get(r);
  }
  return null;
}
