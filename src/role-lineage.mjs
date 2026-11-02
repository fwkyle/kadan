// 역할 노드마다 "이 역할이 대체한 이전 세대" 식별자 목록(supersedes)을 만든다.
// Why: 로티는 재부팅 복원 때 옛 역할 탭을 숨기려 하는데, restart·adopt·handover는 새 대화나 새 pane을 써서
//   "같은 pane·같은 대화" 기준에 걸리지 않는다. 옛 → 새 교체 관계를 원장에 이미 적힌 값으로 내준다.
// 새 원장 기록도, 원장 추가 읽기도 없다. tree가 이미 읽은 사건 배열을 한 번 훑는다(start·adopt·handover만 본다).
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

// 반환: Map<역할, [{source, rottieTerminalId, panePid, conversation}]> 가까운 것(최근 교체)부터, 역할당 최대 10개.
export function roleLineage(entries) {
  const startsByRole = new Map();
  const items = new Map();
  const seenHandover = new Set();
  const add = (role, order, item) => {
    if (!role || !hasAny(item)) return;
    if (!items.has(role)) items.set(role, []);
    items.get(role).push({ order, item });
  };
  entries.forEach((entry, order) => {
    if (entry?.kind === "start" && entry.role) {
      if (entry.restartOf) {
        // restartOf = 옛 start 사건의 지문. 같은 역할의 앞선 start 중 지문이 같은 것을 찾는다.
        const earlier = startsByRole.get(entry.role) ?? [];
        const old = [...earlier].reverse().find((start) => startDigest(start) === entry.restartOf);
        if (old) add(entry.role, order, { source: "restart", ...identifiers(old, text(entry.restartConversation)) });
      }
      if (!startsByRole.has(entry.role)) startsByRole.set(entry.role, []);
      startsByRole.get(entry.role).push(entry);
    } else if (entry?.kind === "adopt" && entry.phase === "accepted") {
      add(entry.role, order, { source: "adopt", rottieTerminalId: text(entry.sourceTerminalId), panePid: null, conversation: null });
    } else if (entry?.kind === "handover" && ["transferred", "complete"].includes(entry.phase)
      && entry.from && entry.to && !seenHandover.has(entry.handoverId ?? order)) {
      seenHandover.add(entry.handoverId ?? order);
      const last = startsByRole.get(entry.from)?.at(-1);
      add(entry.to, order, { source: "handover", ...identifiers(last, null) });
    }
  });
  return new Map([...items].map(([role, list]) => [role,
    list.sort((a, b) => b.order - a.order).slice(0, LINEAGE_LIMIT).map(({ item }) => item)]));
}
