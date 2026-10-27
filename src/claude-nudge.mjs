// Why: 사람이 계정·한도를 조정한 뒤 한도에 멈춘 세션만 재시작 없이 이어간다.
import { buildPreview, previewRow, judgeScreen, claudeLimitMatch, screenEnd, scrubText } from './claude-refresh.mjs';
import { claudeLimitMenu, hasLimitMenuText } from './claude-limit-menu.mjs';
import { readStatusLine } from './watch-status-line.mjs';

export const NUDGE_MESSAGE = 'Claude 계정·한도 상태 변경을 확인하기 위한 재개 요청이다. ' +
  '멈춘 곳부터 이어서 진행하라. 현재 카드의 최신 승인부터 확인하라.';

function identity(entries, session) {
  return entries.findLast(entry => entry.kind === 'start' && entry.session === session)?.panePid;
}

function assertAlive(floor, session, pid) {
  if (!pid || !floor.alive(session) || String(floor.pid(session)) !== String(pid)) {
    throw new Error('생존 확인 실패: 세션 없음 또는 pane PID 불일치');
  }
}

function inputReady(screen) {
  if (typeof screen !== 'string') return false;
  const composer = screen.split('\n').findLast(line => /^\s*[❯>]/u.test(line));
  if (!composer || !/^\s*[❯>]\s*$/u.test(composer)) return false;
  return !claudeLimitMenu(screen) && !hasLimitMenuText(screen) &&
    judgeScreen(screen, 'all').verdict === 'target' && readStatusLine(screen).kind !== 'working';
}

export function runNudge({ entriesOf, floor, pendingCards, send, pressKey, roles = null,
  self = process.env.KADAN_ROLE, intervalSec = 8, sleep }) {
  if (floor.name !== 'tmux') throw new Error('claude refresh는 tmux 바닥에서만 쓴다');
  const initial = entriesOf();
  const screens = new Map();
  const reader = { ...floor, read: session => {
    const screen = floor.read(session);
    screens.set(session, screen);
    return screen;
  } };
  let rows = buildPreview({ entries: initial, floor: reader, pendingCards, self, select: 'limit' });
  if (roles) rows = roles.map(role => rows.find(row => row.role === role) ??
    { role, verdict: 'skip', reason: '살아 있는 역할이 아님' });
  const results = [];
  for (const row of rows) {
    const result = { role: row.role, outcome: 'skipped', reason: row.reason, escaped: false };
    results.push(result);
    if (row.verdict !== 'target') continue;
    const { session, role } = row;
    const pid = identity(initial, session);
    const before = screens.get(session);
    try {
      const entries = entriesOf();
      const fresh = previewRow({ entries, floor: reader, pendingCards, session, self, select: 'limit' });
      const current = screens.get(session);
      if (fresh.verdict !== 'target' || current !== before || String(identity(entries, session)) !== String(pid)) {
        result.reason = '직전 재확인에서 화면 또는 세대 변경';
        continue;
      }
      assertAlive(floor, session, pid);
      let ready = current;
      if (claudeLimitMenu(current)) {
        pressKey(session, 'Escape', { expectedPid: pid, beforeKey: () => {
          const latest = floor.read(session);
          if (latest !== current || !claudeLimitMenu(latest)) throw new Error('Escape 직전 화면 변경');
        } });
        result.escaped = true;
        ready = floor.read(session);
        if (claudeLimitMenu(ready) || hasLimitMenuText(ready)) {
          result.outcome = 'limited';
          result.reason = 'Escape 뒤에도 한도 메뉴가 남음 — 우편 안 보냄';
          continue;
        }
      }
      if (!inputReady(ready)) {
        result.reason = '빈 입력창 확인 불가 — 우편 안 보냄';
        continue;
      }
      // guardedSend가 지침을 붙이는 동안 화면이 바뀌어도 실제 밀어넣기 바로 앞에서 막는다.
      const guardedFloor = { ...floor, send: (...args) => {
        const latest = floor.read(session);
        if (latest !== ready || !inputReady(latest)) throw new Error('전송 직전 화면 변경');
        assertAlive(floor, session, pid);
        return floor.send(...args);
      } };
      send({ floor: guardedFloor, session, role, message: NUDGE_MESSAGE,
        recordedPid: pid, escaped: result.escaped });
      result.sent = true;
      sleep(intervalSec * 1000);
      assertAlive(floor, session, pid);
      const after = floor.read(session);
      result.screenEnd = screenEnd(after);
      if (claudeLimitMatch(after) || hasLimitMenuText(after)) {
        result.outcome = 'limited';
        result.reason = '재확인 화면에 한도가 남음';
      } else if (readStatusLine(after).kind !== 'unknown') {
        result.outcome = 'nudged';
        result.reason = '재확인 화면 끝에서 한도 줄·메뉴가 사라짐(계정 미확인)';
      } else {
        result.reason = '우편 전송 뒤 화면 판정 불가';
      }
    } catch (error) {
      result.reason = scrubText(String(error?.message ?? error)).slice(0, 300);
      // 전달 불명확도 재시도하지 않는다.
      if (error.delivery === 'unknown' || error.delivery === 'sent') result.outcome = 'failed';
    }
  }
  return results;
}

export function formatNudgeResult(results) {
  const labels = { nudged: '깨움', skipped: '건너뜀', limited: '그대로 한도', failed: '실패' };
  return ['한도 깨움 결과', '역할\t결과\tEscape\t이유', ...results.map(row =>
    `${row.role}\t${labels[row.outcome]}\t${row.escaped ? '1' : '0'}\t${row.reason}`)].join('\n');
}
