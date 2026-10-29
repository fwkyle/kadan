// Why: 역할 원본 이름·현재 세대·PID를 함께 대조하여 다른 세션에 입력하거나 종료하지 않는다.
const deny = (code, message) => {
  const error = new Error(message);
  Object.assign(error, {code, delivery:'not-sent'});
  throw error;
};

export function sessionOwner(entries, session, role) {
  let start = null, ended = false, revive = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!revive && e.kind === 'revive' && e.target === role && e.result === 'started') revive = e;
    if (e.session !== session) continue;
    if (e.kind === 'stop') ended = true;
    if (e.kind === 'start') { start = e; break; }
  }
  if (start?.role != null && start.role !== role) {
    deny('KADAN_ROLE_COLLISION',
      `역할 이름 충돌: ${role}의 주소 ${session}은 ${start.role}의 시작 기록입니다. 원본 역할 이름을 확인하세요`);
  }
  return {role, session, start:ended ? null : start, revive:ended ? null : revive};
}

export function assertSessionOwner(owner, currentPid, {infrastructure=false} = {}) {
  const {start, revive, session} = owner;
  const expectedPid = start?.panePid ?? start?.rottiePid;
  // 기반 프로세스는 revive로 살아나 start/PID가 없을 수 있다. stop만 이 예외를 선택한다.
  if (infrastructure && (revive || !expectedPid)) return null;
  assertSessionPid(expectedPid, currentPid, session);
  return String(expectedPid);
}

export function assertSessionPid(expectedPid, currentPid, session) {
  if (expectedPid == null || !/^\d+$/.test(String(expectedPid)) || Number(expectedPid) <= 0) {
    deny('KADAN_PID_MISSING', `시작 PID 기록 없음: ${session} — 시작 기록과 현재 세션을 확인하세요`);
  }
  if (String(currentPid) !== String(expectedPid)) {
    deny('KADAN_PID_MISMATCH',
      `이름은 같은데 다른 프로세스다 (기록 ${expectedPid} / 현재 ${currentPid}). 시작 기록과 현재 세션을 확인하세요`);
  }
}
