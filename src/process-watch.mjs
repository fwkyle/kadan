// 카단 tmux 서버 아래 프로세스를 세션(역할)별로 묶어 메모리를 보고, 선을 넘으면 경보 하나를 낸다.
// 수집은 ps 1회 + tmux list-panes 1회. 명령줄(args)은 읽지 않는다 — comm의 파일 이름만 쓴다.
// 서버 밖으로 부모가 바뀐 프로세스(launchd 입양)와 herdr 바닥은 세지 못한다.

export const DIRECT_GROUP = "서버 직속";
const KINDS = ["claude", "codex", "node", "python", "bash", "gzip", "split"];
const LEAK_AGE_SEC = 24 * 3600;
const LEAK_RSS_KB = 50 * 1024;
const TOP_PROCESSES = 3;
const TOP_SESSIONS = 3;

// 시작값. 설정(runner-settings.json의 processWatch)이 비거나 잘못되면 키별로 이 값으로 돈다.
export const DEFAULT_THRESHOLDS = Object.freeze({
  totalGb: 12,
  processGb: 1,
  python: 30,
  node: 30,
});

export function processThresholds(settings) {
  const given = settings && typeof settings === "object" ? settings.processWatch : null;
  const out = { ...DEFAULT_THRESHOLDS };
  if (!given || typeof given !== "object") return out;
  for (const key of Object.keys(out)) {
    const value = given[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

// [[dd-]hh:]mm:ss → 초. 못 읽으면 null.
export function parseEtime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text ?? "");
  if (!match) return null;
  const [, d = "0", h = "0", m, s] = match;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s);
}

const baseName = (comm) => comm.slice(comm.lastIndexOf("/") + 1);

export function kindOf(name) {
  const lower = name.toLowerCase();
  if (/^python[\d.]*$/.test(lower)) return "python";
  return KINDS.includes(lower) ? lower : "기타";
}

// pid ppid rss etime comm(줄 끝까지: 경로에 공백이 있을 수 있다)
export function parsePs(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const name = baseName(match[5]);
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      ageSec: parseEtime(match[4]),
      name,
      kind: kindOf(name),
    });
  }
  return rows;
}

// "#{pid} #{session_name} #{pane_pid}" — 세션 이름에 공백이 있어도 앞뒤 숫자로 자른다.
export function parsePanes(text) {
  const panes = [];
  let serverPid = null;
  for (const line of String(text ?? "").split("\n")) {
    const match = /^(\d+) (.+) (\d+)$/.exec(line.trim());
    if (!match) continue;
    serverPid ??= Number(match[1]);
    panes.push({ session: match[2], panePid: Number(match[3]) });
  }
  return { serverPid, panes };
}

const emptyKinds = () => Object.fromEntries([...KINDS, "기타"].map((kind) => [kind, 0]));
const mb = (kb) => Math.round(kb / 1024);

function newGroup(session) {
  return { session, count: 0, rssKb: 0, kinds: emptyKinds(), leak: 0, procs: [] };
}

// 서버 PID에서 자식 지도를 따라 한 번만 내려간다(O(n)). 가장 가까운 pane PID 조상이 세션이다.
export function buildSnapshot(rows, serverPid, panes) {
  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const paneSession = new Map(panes.map((pane) => [pane.panePid, pane.session]));
  const groups = new Map();
  const seen = new Set();
  const stack = [];
  const server = byPid.get(serverPid);
  if (server) stack.push([server, null]);
  while (stack.length) {
    const [row, inherited] = stack.pop();
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    const session = paneSession.get(row.pid) ?? inherited;
    const label = session ?? DIRECT_GROUP;
    let group = groups.get(label);
    if (!group) groups.set(label, (group = newGroup(label)));
    group.count += 1;
    group.rssKb += row.rssKb;
    group.kinds[row.kind] += 1;
    if (row.ageSec != null && row.ageSec > LEAK_AGE_SEC && row.rssKb < LEAK_RSS_KB) group.leak += 1;
    group.procs.push({ pid: row.pid, name: row.name, rssKb: row.rssKb });
    for (const child of children.get(row.pid) ?? []) stack.push([child, session]);
  }
  const sessions = [...groups.values()]
    .map((group) => ({
      session: group.session,
      count: group.count,
      rssMb: mb(group.rssKb),
      kinds: group.kinds,
      leak: group.leak,
      big: group.procs
        .sort((a, b) => b.rssKb - a.rssKb)
        .slice(0, TOP_PROCESSES)
        .map((proc) => ({ pid: proc.pid, name: proc.name, rssMb: mb(proc.rssKb) })),
    }))
    .sort((a, b) => b.rssMb - a.rssMb);
  const kinds = emptyKinds();
  let count = 0, rssMb = 0, leak = 0;
  for (const group of sessions) {
    count += group.count;
    rssMb += group.rssMb;
    leak += group.leak;
    for (const kind of Object.keys(kinds)) kinds[kind] += group.kinds[kind];
  }
  const biggest = sessions
    .flatMap((group) => group.big.map((proc) => ({ ...proc, session: group.session })))
    .sort((a, b) => b.rssMb - a.rssMb)
    .slice(0, 5);
  return { count, rssMb, kinds, leak, biggest, sessions };
}

// 반환 {ok:true, ...snapshot} | {ok:false, reason}. 못 읽으면 0개로 꾸미지 않는다.
export function collectProcesses(spawn, { socket }) {
  const panesResult = spawn(
    "tmux",
    ["-u", "-L", socket, "list-panes", "-a", "-F", "#{pid} #{session_name} #{pane_pid}"],
    { encoding: "utf8" },
  );
  if (panesResult?.status !== 0 || typeof panesResult.stdout !== "string") {
    return { ok: false, reason: "tmux 서버를 읽지 못함" };
  }
  const { serverPid, panes } = parsePanes(panesResult.stdout);
  if (serverPid == null) return { ok: false, reason: "tmux 서버에 pane이 없음" };
  const psResult = spawn("ps", ["-axo", "pid=,ppid=,rss=,etime=,comm="], { encoding: "utf8" });
  if (psResult?.status !== 0 || typeof psResult.stdout !== "string") {
    return { ok: false, reason: "ps를 읽지 못함" };
  }
  return { ok: true, serverPid, ...buildSnapshot(parsePs(psResult.stdout), serverPid, panes) };
}

// 넘은 기준의 집합. 주 기준(총량·한 프로세스)은 RED, 보조 기준만이면 AMBER.
export function exceededSignals(snapshot, thresholds) {
  const signals = [];
  if (snapshot.rssMb >= thresholds.totalGb * 1024) signals.push("total");
  if (snapshot.biggest[0] && snapshot.biggest[0].rssMb >= thresholds.processGb * 1024) signals.push("process");
  if (snapshot.kinds.python >= thresholds.python) signals.push("python");
  if (snapshot.kinds.node >= thresholds.node) signals.push("node");
  return signals;
}

const gb = (megabytes) => (megabytes / 1024).toFixed(1) + "G";
const SIGNAL_LABEL = { total: "합계", process: "큰 프로세스", python: "python 개수", node: "node 개수" };

// 사용자에게 가는 한 줄. PID·이름·RSS만 담는다.
export function alertText(snapshot, signals) {
  const sessions = snapshot.sessions.slice(0, TOP_SESSIONS).map((group) => {
    const big = group.big.map((proc) => `${proc.name}#${proc.pid} ${gb(proc.rssMb)}`).join(", ");
    return `${group.session} ${gb(group.rssMb)}(${group.count}개: ${big})`;
  });
  const leak = snapshot.leak ? ` · 24시간 넘게 남은 작은 프로세스 ${snapshot.leak}개` : "";
  return `카단 tmux 프로세스 ${snapshot.count}개·${gb(snapshot.rssMb)} · 넘은 기준: ${signals
    .map((signal) => SIGNAL_LABEL[signal]).join(", ")} · 상위 세션 ${sessions.join(" / ")}${leak}`;
}

// 경보 열기·닫기. 닫힐 때는 기준을 다시 넘지 않는 주기가 3번 이어져야 닫는다(자원 경보와 같은 깜빡임 방지).
// 못 읽은 주기(ok:false)는 열림도 닫힘도 세지 않는다.
export function assessProcesses(previousState, result, thresholds) {
  const previous = previousState?.processAlert ?? null;
  if (!result?.ok) {
    return { state: { processAlert: previous, normalCycles: previousState?.normalCycles ?? 0 }, alerts: previous ? [previous] : [] };
  }
  const signals = exceededSignals(result, thresholds);
  let alert = null, normalCycles = 0;
  if (signals.length) {
    alert = {
      id: "process:memory",
      kind: "프로세스",
      level: signals.includes("total") || signals.includes("process") ? "RED" : "AMBER",
      signals,
      text: alertText(result, signals),
    };
  } else if (previous) {
    normalCycles = (previousState?.normalCycles ?? 0) + 1;
    alert = normalCycles < 3 ? previous : null;
  }
  return { state: { processAlert: alert, normalCycles }, alerts: alert ? [alert] : [] };
}

// 대시보드용 잠깐 재사용. 요청마다 ps를 부르지 않는다.
export function createProcessCache(collect, { ttlMs = 15_000, now = Date.now } = {}) {
  let at = -Infinity, value = null;
  return () => {
    if (now() - at >= ttlMs) {
      at = now();
      try { value = collect(); } catch (error) { value = { ok: false, reason: error.message }; }
    }
    return value;
  };
}
