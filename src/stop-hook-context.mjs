// 압축 뒤 현재 카드 재안내 — Stop 훅 확장(2026-10-19 [kyle] 승인 5742b360 (A), 실측 exec-2ef4e2fc).
// 대화가 압축되면 현재 실행 주소가 대체 대화에서 빠져 작업자가 멈춘다. 압축 직후 첫 Stop에서 주소를 한 번만 다시 알려 준다.
// 이 코드는 모든 역할의 Stop마다 돈다: 어떤 실패·모호함도 null(재안내 없음)로 끝낸다(fail-open). 원장에는 쓰지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {findDoneMarkers} from './done-marker.mjs';
import {spoolHome} from './stop-hook-spool.mjs';

const TAIL_BYTES = 256 * 1024; // 압축 경계는 끝 근처에 있다. 큰 기록 전체를 읽지 않는다
const FRESH_MS = 30 * 60 * 1000; // 이보다 오래된 경계는 이미 지난 일이다(훅을 처음 켠 세션의 옛 압축 방지)
// 원장 조회 전체 상한. 넘기면 재안내 없이 통과한다(훅 제한시간은 10초). 카드는 1초를 제안했으나 실제 원장(원장 5.6만 줄)
// 조회가 부하 20에서 1.9~2.9초라 1초면 거의 항상 포기한다 → 3초로 두고 결과에 실측과 함께 보고한다.
const LOOKUP_MS = 3000;
const DB_WAIT_MS = '800'; // 원장 잠금 대기 상한. 기본 15초는 훅 제한시간을 넘긴다

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

// 이 역할이 지금 맡은 미완료 실행 키 목록(없으면 빈 배열). 닫힌 업무·이전 세대·`waiting` 활동은 buildWatchScope가 이미 뺀다.
// 열린 질문(우편 답 대기)이 붙은 실행도 뺀다. 우편 상태를 못 읽으면 hasOpenQuestion이 true라 빠진다(재안내하지 않는 쪽).
export async function currentExecutionsOf(home, role) {
  const [{readLedger}, {CardStore}, {WorkStore}, scope, identity, handover, status] = await Promise.all([
    import('./ledger.mjs'), import('./card-store.mjs'), import('./work-store.mjs'), import('./watch-scope.mjs'),
    import('./task-identity.mjs'), import('./handover-state.mjs'), import('./watch-status-line.mjs')]);
  let entries = readLedger(home);
  if (entries.some(entry => entry?.broken)) return [];
  const cards = new CardStore(home).listSummaries();
  const works = new WorkStore(home).list().map(work => handover.withEffectiveOwner(work, entries));
  entries = identity.taskIdentity(cards).project(entries).filter(entry => !identity.taskConnectionError(entry));
  return scope.buildWatchScope(cards, entries, new Map(), works).entries
    .filter(entry => entry.role === role && entry.executionKey && !status.hasOpenQuestion(entries, role, entry.t))
    .map(entry => entry.executionKey);
}

// 훅 안에서 원장 읽기에 시간 상한을 둔다: 동기 SQLite 호출은 중간에 끊을 수 없어 자식 프로세스로 돌려 제한시간에 죽인다.
// 시간 초과·실패·이상한 출력은 모두 빈 배열이다(재안내 없음).
export function lookupExecutions(home, role, timeoutMs = LOOKUP_MS) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'lookup', role],
    {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 20});
  if (run.status !== 0) return [];
  try { const keys = JSON.parse(run.stdout); return Array.isArray(keys) ? keys.filter(k => typeof k === 'string') : []; } catch { return []; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === 'lookup') {
  process.env.KADAN_BUSY_TIMEOUT_MS = DB_WAIT_MS;
  try { process.stdout.write(JSON.stringify(await currentExecutionsOf(spoolHome(), process.argv[3]))); process.exit(0); } catch { process.exit(1); }
}

export const reminderText = keys => {
  const list = keys.map(key => `\`${key}\``).join(', ');
  const show = keys.map(key => `\`kadan card show ${key}\``).join(', ');
  return `대화가 압축됐다. 현재 맡은 실행은 ${list}다. ${show}로 최신 범위·보류·결과 경로를 다시 읽고 이어 하라. 새 작업을 만들지 말고, 이미 완료했거나 답 대기이면 그 상태를 확인하라.`;
};

// 재안내할 글을 돌려준다(없으면 null). 순서: 역할 → 훅 재호출 아님 → 압축 경계 → 경계당 1회 선점(결과와 무관) → 마커 없음 → 신선함 → 현재 실행.
// 새 경계를 처음 본 Stop에서 결과와 상관없이 기회를 소모한다(감독 결정): 마커·답 대기·대상 없음이어도 같은 압축에 두 번째 기회는 없다.
// 값싼 확인을 먼저 하고 원장 읽기는 압축 직후에만 한다. lookup은 시험용 주입 자리다.
export async function compactReminder(raw, env = process.env, {lookup = lookupExecutions, now = () => Date.now()} = {}) {
  try {
    const role = env.KADAN_ROLE;
    if (!role) return null;
    const input = JSON.parse(raw);
    if (!input || input.hook_event_name !== 'Stop' || input.stop_hook_active === true) return null;
    const boundary = lastCompactBoundary(input.transcript_path);
    if (!boundary) return null;
    const home = spoolHome(env);
    const dir = path.join(home, 'stop-hook', 'compact-reminders');
    const name = crypto.createHash('sha256').update(`${role}\0${input.session_id ?? ''}\0${boundary.id}`).digest('hex').slice(0, 40);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    try { fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({role, boundary: boundary.id, at: new Date(now()).toISOString()}), {flag: 'wx', mode: 0o600}); }
    catch { return null; } // 이미 안내했거나 다른 훅이 먼저 선점했다
    const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
    if (findDoneMarkers(message).length) return null; // 완료를 낸 응답이다
    if (now() - boundary.at > FRESH_MS || boundary.at - now() > 60 * 1000) return null; // 훅을 처음 켠 세션의 옛 압축
    const keys = await lookup(home, role);
    return Array.isArray(keys) && keys.length ? reminderText(keys) : null;
  } catch {
    return null;
  }
}
