// Why: 과거 시작·죽음 경보 대신 실제 관찰한 세션 목록을 복원 생존 근거로 쓴다.
// 10배 데이터: 고정 크기 최신 스냅숏 한 개를 매 정상 주기 덮어쓴다. 이력을 누적하지 않는다.
import fs from 'node:fs';
import path from 'node:path';

export const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;
const fileOf = home => path.join(home, 'server-sessions.json');
const validSession = name => /^kadan-[\p{L}\p{N}\p{Extended_Pictographic}_-]+$/u.test(name);

export function writeServerSessions(home, sessions, now = Date.now()) {
  const snapshot = {observedAt: new Date(now).toISOString(),
    sessions: [...new Set(sessions.filter(validSession))]};
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const file = fileOf(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot) + '\n', {mode: 0o600});
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return snapshot;
}

export function readServerSessions(home, now) {
  let snapshot;
  try { snapshot = JSON.parse(fs.readFileSync(fileOf(home), 'utf8')); }
  catch (error) {
    return {key: 'unavailable', reason: error.code === 'ENOENT' ? '세션 관찰 기록 없음' : '세션 관찰 기록 손상'};
  }
  const observed = Date.parse(snapshot?.observedAt);
  if (!Number.isFinite(observed) || !Array.isArray(snapshot.sessions)
    || !snapshot.sessions.every(validSession)) return {key: 'invalid', reason: '세션 관찰 기록 손상'};
  const reason = observed > now ? '세션 관찰 시각이 미래'
    : now - observed > SNAPSHOT_MAX_AGE_MS ? '세션 관찰 기록이 10분보다 오래됨' : null;
  return {snapshot, key: snapshot.observedAt, reason};
}

export function describeLostSessions(loss) {
  if (Array.isArray(loss.supervisorSessions)) {
    return `직전 감독 세션: ${loss.supervisorSessions.join(', ') || '없음'}`;
  }
  if (loss.observedSessions?.length) {
    return `직전 관찰 세션(역할 종류 확인 불가): ${loss.observedSessions.join(', ')}`;
  }
  return '직전 감독 세션: 확인 불가(관찰 기록 없음 또는 손상)';
}
