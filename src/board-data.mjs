// kadan board의 읽기 쪽: 대시보드 HTTP(127.0.0.1)·대시보드가 꺼졌을 때의 로컬 슈퍼감독 계산·터미널 칸 화면 읽기.
// 읽기만 한다. tmux 호출은 capture-pane·display-message 두 가지뿐이다.
import { tmux } from "./floor-tmux.mjs";
import { ledgerHome } from "./ledger.mjs";
import { readLedgerIncremental } from "./ledger-incremental.mjs";
import { readActiveHierarchy } from "./hierarchy-register.mjs";
import { isSuperRole, superProfiles } from "./super-role.mjs";

const HTTP_TIMEOUT_MS = 8_000;

export function httpJson(port, fetchFn = fetch) {
  return async (path) => {
    const res = await fetchFn(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
}

// 대시보드가 꺼졌을 때만: 관계표와 시작 기록의 프로필로 슈퍼감독을 정한다(이름으로 추측하지 않는다). 저장소는 모른다.
export function localSupers(home = ledgerHome()) {
  const entries = readLedgerIncremental(home);
  const parents = readActiveHierarchy(entries);
  if (!parents) return [];
  const profiles = superProfiles(entries);
  return Object.keys(parents).filter((role) => isSuperRole(role, parents, profiles))
    .sort((a, b) => a.localeCompare(b, "ko")).map((role) => ({ role, repos: null }));
}

// 슈퍼감독 목록의 출처: 대시보드 현황(/api/dashboard/status)의 supervisors.items(프로필 기준, 저장소 포함). 실패하면 localSupers.
export async function loadSupers({ fetchJson, local }) {
  try {
    const items = (await fetchJson("/api/dashboard/status"))?.supervisors?.items;
    if (Array.isArray(items))
      return { supers: items.map((i) => ({ role: i.super, repos: i.repos?.length ? i.repos : null })), source: "dashboard" };
  } catch {}
  try { return { supers: local(), source: "local" }; } catch { return { supers: [], source: "none" }; }
}

// 대시보드 값 읽기. 하나라도 실패하면 그 값만 null(뱃지 ?)이고 나머지는 그대로 쓴다.
export async function loadDashboard({ fetchJson, night = true }) {
  const settle = async (path) => { try { return await fetchJson(path); } catch { return null; } };
  const [summary, nightRepos] = await Promise.all([settle("/api/dashboard/summary"), night ? settle("/api/night/repos") : null]);
  return { summary, nightRepos };
}

// 설명 칸의 출처: 감독 AI가 쓰는 조회. 원장을 다시 읽지 않는다. 실패는 null(모름).
export async function loadSuperStatus({ fetchJson, role }) {
  try { return await fetchJson(`/api/dashboard/status?super=${encodeURIComponent(role)}`); } catch { return null; }
}

// 터미널 칸: 고른 세션의 화면(색 유지)·크기·커서·PID. 읽기 호출 2번(display-message, capture-pane). 세션이 없으면 null.
const INFO_FORMAT = "#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag} #{pane_pid} #{pane_dead}";
export function readScreen(session, { run = tmux } = {}) {
  const info = run(["display-message", "-p", "-t", `=${session}:`, INFO_FORMAT]);
  if (info.status !== 0) return null;
  const m = /^(\d+) (\d+) (\d+) (\d+) ([01]) (\d+) ([01])$/.exec(info.stdout.trim());
  if (!m) return null;
  const shot = run(["capture-pane", "-e", "-p", "-t", `=${session}:`]);
  if (shot.status !== 0) return null;
  const [paneWidth, paneHeight, x, y, cursorFlag, pid, dead] = m.slice(1).map(Number);
  const lines = shot.stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { lines, paneWidth, paneHeight, cursor: cursorFlag ? { x, y } : null, pid: String(pid), dead: dead === 1 };
}

// 포커스에 들어갈 때 기록할 pane PID. 죽은 화면이거나 읽지 못하면 null.
export function readPanePid(session, { run = tmux } = {}) {
  const result = run(["display-message", "-p", "-t", `=${session}:`, "#{pane_pid}|#{pane_dead}"]);
  const m = result.status === 0 ? /^(\d+)\|0$/.exec(result.stdout.trim()) : null;
  return m ? m[1] : null;
}
