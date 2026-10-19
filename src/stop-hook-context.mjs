// 압축 뒤 현재 카드 재안내 — Stop 훅 확장(2026-10-19 [kyle] 승인 5742b360 (A), 실측 exec-2ef4e2fc).
// 대화가 압축되면 현재 실행 주소가 대체 대화에서 빠져 작업자가 멈춘다. 압축 직후 첫 Stop에서 주소를 한 번만 다시 알려 준다.
// 이 코드는 모든 역할의 Stop마다 돈다: 어떤 실패·모호함도 null(재안내 없음)로 끝낸다(fail-open). 원장에는 쓰지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {findDoneMarkers} from './done-marker.mjs';
import {spoolHome} from './stop-hook-spool.mjs';

const TAIL_BYTES = 256 * 1024; // 압축 경계는 끝 근처에 있다. 큰 기록 전체를 읽지 않는다
const FRESH_MS = 30 * 60 * 1000; // 이보다 오래된 경계는 이미 지난 일이다(훅을 처음 켠 세션의 옛 압축 방지)
const DB_WAIT_MS = '1000'; // 원장 읽기 대기 상한. 기본 15초를 쓰면 훅 제한시간(10초)을 넘긴다

const jsonLine = line => { try { const row = JSON.parse(line); return row && typeof row === 'object' ? row : null; } catch { return null; } };

// transcript 끝에서 마지막 압축 경계 하나. claude: system/compact_boundary(uuid), codex: compacted(window_id).
// 형식이 안정된 계약이 아니라서 못 읽거나 모호하면 null이다.
export function lastCompactBoundary(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath)) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // 잘린 첫 줄
    let found = null;
    for (const line of lines) {
      const row = line ? jsonLine(line) : null;
      if (!row) continue;
      const claude = row.type === 'system' && row.subtype === 'compact_boundary';
      if (!claude && row.type !== 'compacted') continue;
      const id = claude ? row.uuid : (row.window_id ?? row.payload?.window_id ?? row.timestamp);
      const at = Date.parse(row.timestamp ?? row.payload?.timestamp);
      found = typeof id === 'string' && id && Number.isFinite(at) ? {id, at} : null; // 마지막 경계가 모호하면 옛 경계로 대신하지 않는다
    }
    return found;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 닫기 실패는 무시 */ }
  }
}

// 이 역할이 지금 맡은 미완료 실행 키. 정확히 하나일 때만 돌려준다(없거나 여럿이면 null — 추측하지 않는다).
// 질문·결정 대기 중인 실행, 닫힌 업무의 실행, 이전 세대의 발령은 buildWatchScope가 이미 뺀다.
export async function currentExecutionOf(home, role) {
  process.env.KADAN_BUSY_TIMEOUT_MS = DB_WAIT_MS;
  const [{readLedger}, {CardStore}, {WorkStore}, scope, identity, handover] = await Promise.all([
    import('./ledger.mjs'), import('./card-store.mjs'), import('./work-store.mjs'),
    import('./watch-scope.mjs'), import('./task-identity.mjs'), import('./handover-state.mjs')]);
  let entries = readLedger(home);
  if (entries.some(entry => entry?.broken)) return null;
  const cards = new CardStore(home).list();
  const works = new WorkStore(home).list().map(work => handover.withEffectiveOwner(work, entries));
  entries = identity.taskIdentity(cards).project(entries).filter(entry => !identity.taskConnectionError(entry));
  const mine = scope.buildWatchScope(cards, entries, new Map(), works).entries.filter(entry => entry.role === role && entry.executionKey);
  return mine.length === 1 ? mine[0].executionKey : null;
}

export const reminderText = key => `대화가 압축됐다. 현재 맡은 실행은 \`${key}\`다. \`kadan card show ${key}\`로 최신 범위·보류·결과 경로를 다시 읽고 이어 하라. 새 작업을 만들지 말고, 이미 완료했거나 답 대기이면 그 상태를 확인하라.`;

// 재안내할 글을 돌려준다(없으면 null). 순서: 역할 → 훅 재호출 아님 → 압축 경계 → 이번 응답에 마커 없음 → 현재 실행 하나 → 경계당 1회 선점.
// 값싼 확인을 먼저 하고 원장 읽기는 압축 직후에만 한다. lookup은 시험용 주입 자리다.
export async function compactReminder(raw, env = process.env, {lookup = currentExecutionOf, now = () => Date.now()} = {}) {
  try {
    const role = env.KADAN_ROLE;
    if (!role) return null;
    const input = JSON.parse(raw);
    if (!input || input.hook_event_name !== 'Stop' || input.stop_hook_active === true) return null;
    const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
    if (findDoneMarkers(message).length) return null; // 완료를 낸 응답이다
    const boundary = lastCompactBoundary(input.transcript_path);
    if (!boundary || now() - boundary.at > FRESH_MS || boundary.at - now() > 60 * 1000) return null;
    const home = spoolHome(env);
    const dir = path.join(home, 'stop-hook', 'compact-reminders');
    const name = crypto.createHash('sha256').update(`${role}\0${input.session_id ?? ''}\0${boundary.id}`).digest('hex').slice(0, 40);
    if (fs.existsSync(path.join(dir, `${name}.json`))) return null; // 이미 안내했다
    const key = await lookup(home, role);
    if (!key) return null;
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    try { fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({role, key, boundary: boundary.id, at: new Date(now()).toISOString()}), {flag: 'wx', mode: 0o600}); }
    catch { return null; } // 다른 훅이 먼저 선점했거나 쓸 수 없으면 보내지 않는다
    return reminderText(key);
  } catch {
    return null;
  }
}
