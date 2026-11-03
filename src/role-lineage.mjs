// 역할 노드마다 "이 역할이 대체한 이전 세대" 식별자 목록(supersedes)을 만든다.
// Why: 로티는 재부팅 복원 때 옛 역할 탭을 숨기려 하는데, restart·adopt·handover는 새 대화나 새 pane을 써서
//   "같은 pane·같은 대화" 기준에 걸리지 않는다. 옛 → 새 교체 관계를 원장에 이미 적힌 값으로 내준다.
//   로티는 이 목록으로 옛 탭을 지우므로, 엉뚱한 값이 들어가는 쪽이 빠지는 쪽보다 나쁘다.
// 새 원장 기록도, 원장 추가 읽기도 없다. tree가 이미 읽은 사건 배열을 한 번 훑는다(start·adopt·handover만 본다).
//
// 사슬 규칙: "지금 그 역할의 마지막 start"에서 출발해 명시적 연결만 따라 거슬러 올라간다. 연결되지 않은 과거는 담지 않는다.
//   - restart: start의 restartOf 지문 → 그 지문의 옛 start
//   - adopt: 사슬 위 start 이후~같은 역할의 다음 start 이전에 받은 adopt accepted의 sourceTerminalId
//   - handover: 사슬 위 start 이후~다음 start 이전에 그 역할로 들어온 handover의 from 역할이 그 시점에 가진 마지막 start (거기서 다시 거슬러 올라감)
// 이름이 같아도 위 연결이 없으면 남이다. 새 독립 start는 빈 목록에서 시작한다.
import { startDigest } from "./secretary-resume.mjs";

export const LINEAGE_LIMIT = 10;

const text = (value) => (value == null || value === "" ? null : String(value));

// 옛 start 하나에서 로티가 대조할 값만 꺼낸다. 원장에 없으면 null이다(추측하지 않는다).
function identifiers(start, conversation) {
  return {
    rottieTerminalId: text(start?.rottieTerminalId),
    panePid: text(start?.panePid),
    // fork의 conversationRef는 부모 대화라서 이 세션의 대화가 아니다. resume일 때만 쓴다.
    conversation: text(conversation ?? (start?.conversationMode === "resume" ? start.conversationRef : null)),
  };
}
const hasAny = ({ rottieTerminalId, panePid, conversation }) => [rottieTerminalId, panePid, conversation].some((value) => value !== null);

// 마지막으로 order보다 앞에 있는 start의 위치(없으면 -1). starts는 order 오름차순이다.
function lastBefore(starts, order) {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid].order < order) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// 사건을 한 번 훑어 start 구간별 색인을 만들고(비용: 사건 수에 비례), 역할마다 사슬을 올라간다(길이 상한 10).
// 반환: { chains: Map<역할, [{source, rottieTerminalId, panePid, conversation}]>, current: Map<역할, 마지막 start> }
export function buildLineage(entries) {
  const startsByRole = new Map(); // 역할 → [{ entry, order }]
  const byDigest = new Map(); // 지문 → { entry, role, index }
  const seenHandover = new Set();
  entries.forEach((entry, order) => {
    if (entry?.kind === "start" && entry.role) {
      if (!startsByRole.has(entry.role)) startsByRole.set(entry.role, []);
      const list = startsByRole.get(entry.role);
      // adopts·handovers: 이 start 이후~같은 역할의 다음 start 이전에 받은 사건. 훑으며 직전 start에 한 번만 붙인다.
      list.push({ entry, order, adopts: [], handovers: [] });
      byDigest.set(startDigest(entry), { role: entry.role, index: list.length - 1 });
    } else if (entry?.kind === "adopt" && entry.phase === "accepted" && entry.role) {
      startsByRole.get(entry.role)?.at(-1).adopts.push({ order, terminal: text(entry.sourceTerminalId) });
    } else if (entry?.kind === "handover" && ["transferred", "complete"].includes(entry.phase)
      && entry.from && entry.to && !seenHandover.has(entry.handoverId ?? order)) {
      seenHandover.add(entry.handoverId ?? order);
      startsByRole.get(entry.to)?.at(-1).handovers.push({ order, from: entry.from });
    }
  });

  const chainOf = (role) => {
    const found = [];
    const visited = new Set();
    // 대기열: 아직 따라가지 않은 사슬 위 start. 상한 10개를 모으면 멈춘다.
    const queue = [{ role, index: startsByRole.get(role).length - 1 }];
    for (let head = 0; head < queue.length && found.length < LINEAGE_LIMIT; head++) {
      const { role: r, index } = queue[head];
      const list = startsByRole.get(r);
      const node = list[index];
      if (visited.has(node)) continue; // 순환(같은 start가 다시 나옴)
      visited.add(node);
      if (node.entry.restartOf) {
        const old = byDigest.get(node.entry.restartOf);
        // 옛 start는 같은 역할의 앞선 start여야 한다.
        if (old && old.role === r && old.index < index) {
          found.push({ order: node.order, item: { source: "restart", ...identifiers(list[old.index].entry, text(node.entry.restartConversation)) } });
          queue.push({ role: r, index: old.index });
        }
      }
      for (const adopt of node.adopts) {
        found.push({ order: adopt.order, item: { source: "adopt", rottieTerminalId: adopt.terminal, panePid: null, conversation: null } });
      }
      for (const handover of node.handovers) {
        const fromList = startsByRole.get(handover.from);
        const at = fromList ? lastBefore(fromList, handover.order) : -1;
        if (at < 0) continue;
        found.push({ order: handover.order, item: { source: "handover", ...identifiers(fromList[at].entry, null) } });
        queue.push({ role: handover.from, index: at });
      }
    }
    return found.filter(({ item }) => hasAny(item)).sort((a, b) => b.order - a.order)
      .slice(0, LINEAGE_LIMIT).map(({ item }) => item);
  };

  const chains = new Map();
  const current = new Map();
  for (const [role, list] of startsByRole) {
    current.set(role, list.at(-1).entry);
    const chain = chainOf(role);
    if (chain.length) chains.set(role, chain);
  }
  return { chains, current };
}

// 현재 살아 있는 세대의 값은 옛 세대 목록에서 뺀다(로티가 살아 있는 탭을 지우지 않게).
// liveRoles: tree 역할 노드({role, life}). 세 값이 모두 null이 된 항목은 뺀다.
// restart는 같은 대화를 이어 쓰므로 conversation은 대개 현재와 겹쳐 null이 된다.
export function lineageFor(built, liveRoles = []) {
  const pids = new Set();
  const terminals = new Set();
  const conversations = new Set();
  for (const live of liveRoles) {
    const start = built.current.get(live.role);
    const own = identifiers(start, null);
    for (const [set, value] of [[pids, own.panePid], [pids, text(live.life?.currentPid)],
      [terminals, own.rottieTerminalId], [conversations, own.conversation]]) {
      if (value !== null) set.add(value);
    }
  }
  const result = new Map();
  for (const [role, chain] of built.chains) {
    const kept = chain.map((item) => ({
      ...item,
      rottieTerminalId: terminals.has(item.rottieTerminalId) ? null : item.rottieTerminalId,
      panePid: pids.has(item.panePid) ? null : item.panePid,
      conversation: conversations.has(item.conversation) ? null : item.conversation,
    })).filter(hasAny);
    if (kept.length) result.set(role, kept);
  }
  return result;
}

// 반환: Map<역할, [{source, rottieTerminalId, panePid, conversation}]> 가까운 것(최근 교체)부터, 역할당 최대 10개.
export const roleLineage = (entries, liveRoles = []) => lineageFor(buildLineage(entries), liveRoles);
