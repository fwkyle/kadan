// 현황 상단 띠의 재료. 다섯 질문(지금 도는가·막혔는가·내 결정이 있는가·흐름대로 가는가·어느 모델인가) 중
// 기존 집계(실행 묶음·결정)가 답하지 못하던 세 가지를 계산한다: 살아 있는 담당과 모델, 흐름 연결 확인, 해소 전 감시 경보.
// 판단에 쓰지 않고 화면 답변용으로만 옮긴다. 모르는 것은 null로 둔다(세션 상태 모름·원장 손상).

// 살아 있는 담당 창과 그 창을 시작할 때 기록한 실행기·모델·강도. center.models는 역할별 최근 start 기록이다.
export function liveSessions(center) {
  if (!center || !center.runtimeKnown) return null;
  const models = center.models || {};
  return (center.roles || [])
    .filter((r) => r.life?.state === "alive")
    .map((r) => {
      const m = models[r.role] || {};
      return {
        role: r.role,
        harness: m.harness || null,
        model: m.model || null,
        effort: m.effort || null,
        pidState: r.life?.pidState || null,
      };
    })
    .sort((a, b) => a.role.localeCompare(b.role, "ko"));
}

// 검수 흐름 중 연결이 깨진 묶음(라운드 누락·구현/검수 카드 미연결·같은 단계 중복). 집계가 unconfirmed인 묶음이다.
export function flowSummary(reviewFlows) {
  const flows = Array.isArray(reviewFlows) ? reviewFlows : [];
  const unconfirmed = flows
    .filter((flow) => flow.verdict === "unconfirmed")
    .map((flow) => ({ id: flow.id, title: flow.title, label: flow.label, warnings: flow.warnings || [] }));
  return { total: flows.length, unconfirmed };
}

// 슈퍼감독(관계표에서 상위가 @user인 역할)마다 한 줄. 사용자가 여러 슈퍼감독에게 위임해도 묻지 않고 진행을 보게
// (2026-10-05 [kyle]). 실행·워크·결정·경보를 담당 역할의 사슬 끝(최상위)으로 묶는다. 관계표를 모르면 null.
// 관계표에 없는 담당의 실행은 unassigned로 세어 사각을 드러낸다. 담당이 아직 없는 실행(초안·보류)은 관계표 문제가
// 아니므로 unowned로 따로 센다(2026-10-05 실측: 운영 73건 중 72건이 담당 없는 초안이라 등록하라는 안내가 헛걸음이었다).
// 역할의 사슬 끝(상위가 @user인 역할). 관계표에 없거나 끊기거나 순환이면 null.
export function supervisorOf(hierarchy, role) {
  const parents = hierarchy instanceof Map ? hierarchy : new Map(Object.entries(hierarchy ?? {}));
  let r = role;
  for (let i = 0; i < 64 && typeof r === "string"; i++) {
    const p = parents.get(r);
    if (p === "@user") return r;
    if (p == null) return null;
    r = p;
  }
  return null;
}

export function supervisorSummary({ hierarchy, rows = [], works = [], decisions = null, alerts = null, live = null }) {
  if (!hierarchy || typeof hierarchy !== "object") return null;
  const parents = new Map(Object.entries(hierarchy));
  const topOf = (role) => supervisorOf(parents, role);
  const supers = [...parents.entries()].filter(([, p]) => p === "@user").map(([r]) => r).sort((a, b) => a.localeCompare(b, "ko"));
  const bySuper = new Map(supers.map((s) => [s, { super: s, repos: new Set(), running: 0, waiting: 0, stuck: 0, openWorks: 0,
    decisions: Array.isArray(decisions) ? 0 : null, alerts: alerts ? 0 : null, lastSignal: null }]));
  let unassigned = 0, unowned = 0;
  for (const row of rows) {
    if (!row.owner) { unowned++; continue; }
    const s = bySuper.get(topOf(row.owner));
    if (!s) { unassigned++; continue; }
    if (row.repo) s.repos.add(row.repo);
    if (row.bucket === "running") s.running++;
    else if (row.bucket === "waiting") s.waiting++;
    else if (row.bucket === "stuck" || row.bucket === "stale") s.stuck++;
    const at = Date.parse(row.signalAt);
    if (Number.isFinite(at) && (!s.lastSignal || at > Date.parse(s.lastSignal))) s.lastSignal = row.signalAt;
  }
  for (const w of works) if (w.state === "running") { const s = bySuper.get(topOf(w.owner)); if (s) s.openWorks++; }
  for (const d of decisions ?? []) { const s = bySuper.get(topOf(d.requestedBy)); if (s) s.decisions++; }
  for (const a of alerts?.items ?? []) { const s = bySuper.get(topOf(a.recipient)); if (s) s.alerts++; }
  const items = [...bySuper.values()].map((s) => {
    const session = live === null ? null : live.find((l) => l.role === s.super) ?? null;
    return { ...s, repos: [...s.repos].sort(), alive: live === null ? null : Boolean(session), model: session?.model ?? null };
  });
  return { items, unassigned, unowned };
}

// 해소 전 감시 경보. 같은 id의 마지막 기록이 resolved가 아니면 열린 경보다(watch-runner seedAlertState와 같은 규칙).
// id가 없는 옛 기록은 복원 재료가 없어 세지 않는다.
// 자원·전달실패 경보는 감시기가 해소 기록을 남기지 않고 조용히 닫는다(deliverResolution의 자원 분기, 해소 루프의
// 전달실패 continue). 원장만 보면 영원히 열린 것으로 보이므로 세지 않는다.
const SILENTLY_CLOSED = new Set(["자원", "전달실패"]);
// limit은 화면에 보여 줄 항목 수다(count는 전체). 슈퍼감독별 묶기처럼 전부 필요하면 Infinity를 준다.
export function openAlerts(entries, { limit = 20 } = {}) {
  if (!Array.isArray(entries) || entries.some((e) => e?.broken)) return null;
  const latest = new Map();
  for (const e of entries) {
    if (e?.kind !== "alert" || typeof e.id !== "string" || !e.id) continue;
    latest.set(e.id, e);
  }
  const items = [...latest.values()]
    .filter((e) => e.resolved !== true && !SILENTLY_CLOSED.has(e.alertKind))
    .map((e) => ({ id: e.id, kind: e.alertKind || "", level: e.level || "", role: e.role || "", session: e.session || "", recipient: e.recipient || "", at: e.t || "" }))
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return { count: items.length, items: items.slice(0, limit) };
}
