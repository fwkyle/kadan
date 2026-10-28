// 우편 상세·우편 목록·원장 화면(DS-1-impl: dashboard-api.mjs에서 옮김).
import { taskIdentity } from "../task-identity.mjs";
import { filterMail } from "../dashboard-inbox.mjs";
import { isUnreadLetter } from "../mailbox-state.mjs";
import { isPreviousGenerationUnread } from "../mail-generation.mjs";
import {
  ledgerView,
  filterLedgerRows,
  isWatchRoutine,
  ledgerOriginal,
  eventLabel,
  eventSummary,
} from "../ledger-table.mjs";
import { letters, bodyOf, mailRow, page } from "./shared.mjs";
import { stripStoredHeader } from "../mail-header.mjs";

export function mailBodyData(snapshot, url, stamp) {
  const m = letters(snapshot).find(
    (m) => (m.mailId || m.digest) === url.searchParams.get("id"),
  );
  if (!m)
    throw Object.assign(new Error("편지를 찾을 수 없습니다"), {
      status: 404,
    });
  const body = bodyOf(snapshot, m);
  return {
    ...stamp,
    mail: mailRow(m, taskIdentity(snapshot.center?.cards || [])),
    body,
    error: body === null ? "본문 없음 또는 읽기 불가" : null,
  };
}

export function mailData(snapshot, url, stamp) {
  const all = letters(snapshot),
    filtered = filterMail(all, url, { bodyOf: (m) => bodyOf(snapshot, m) })
      .slice()
      .reverse();
  const selected = page(filtered, url, "mailPage"),
    identity = taskIdentity(snapshot.center?.cards || []);
  return {
    ...stamp,
    ...selected,
    items: selected.items.map((m) => ({
      ...mailRow(m, identity),
      preview:
        m.preview ||
        String(stripStoredHeader(bodyOf(snapshot, m), m) || "")
          .replace(/\s+/g, " ")
          .slice(0, 120),
    })),
    roles: [
      ...new Set(
        all
          .flatMap((m) => [
            m.currentSender || m.by,
            m.currentRecipient || m.role,
          ])
          .filter(Boolean),
      ),
    ].sort(),
    waiting: all.filter((m) => m.replyStatus === "waiting").length,
    unread: all.filter(isUnreadLetter).length,
    previousGenerationUnread: all.filter(isPreviousGenerationUnread).length,
  };
}

export function ledgerData(snapshot, url, stamp) {
  letters(snapshot); // Fail visibly when the shared ledger could not be read.
  const all = ledgerView(
    snapshot.entries || [],
    snapshot.home,
    url.searchParams.get("ledgerDomain") || "all",
    snapshot.ledgerState,
  );
  const filtered = filterLedgerRows(all, {
    kind: url.searchParams.get("ledgerKind") || "",
    card: url.searchParams.get("ledgerCard") || "",
    role: url.searchParams.get("ledgerRole") || "",
    date: url.searchParams.get("ledgerDate") || "",
  })
    .filter(
      (e) =>
        url.searchParams.get("ledgerRoutine") === "1" || !isWatchRoutine(e),
    )
    .slice()
    .reverse();
  const selected = page(filtered, url, "logPage");
  return {
    ...stamp,
    ...selected,
    items: selected.items.map((e) => ({
      at: e.t,
      kind: e.kind,
      label: eventLabel(e),
      summary: eventSummary(e),
      by: e.by || "모름",
      target: e.role || e.to || e.board || "모름",
      card: e.executionKey || null,
      original: ledgerOriginal(e),
    })),
  };
}
