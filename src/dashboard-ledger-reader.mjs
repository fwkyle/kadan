// Why: 활동 기록은 카드·세션 수집 없이 SQL에서 한 쪽만 읽는다.
import {withLedgerView, sourceViewValues} from './ledger-view.mjs';
import {metaGet} from './ledger-view-store.mjs';
import {ledgerWhere} from './ledger-view-filters.mjs';
import {domainProjector} from './ledger-domains.mjs';
import {ledgerOriginal, eventLabel, eventSummary} from './ledger-table.mjs';
import {pageQueryKey as fingerprint, encodePageCursor as encode, decodePageCursor as decode,
  invalidPageCursor as invalidCursor} from './dashboard-page-cursor.mjs';

const PAGE_SIZE = 50;
const FROM = 'FROM views v JOIN filters f USING(position)';

function queryPage(db, info, source, url) {
  const rawDomain = url.searchParams.get('ledgerDomain');
  const filters = {
    domain:['tasks', 'mail', 'system'].includes(rawDomain) ? rawDomain : null,
    kind:url.searchParams.get('ledgerKind') || '',
    card:url.searchParams.get('ledgerCard') || '',
    role:url.searchParams.get('ledgerRole') || '',
    date:url.searchParams.get('ledgerDate') || '',
    routine:url.searchParams.get('ledgerRoutine') === '1',
  };
  const query = fingerprint(filters), where = ledgerWhere(filters);
  let cursor = decode(url.searchParams.get('logCursor'));
  const reset = Boolean(cursor && (cursor.g !== info.generation || cursor.q !== query));
  if (reset) cursor = null;
  if (!db) return {items:[], page:1, pages:1, total:0, pageSize:PAGE_SIZE,
    nextCursor:null, previousCursor:null, cursorReset:reset};
  if (filters.domain && metaGet(db, 'legacyBad')) throw new Error('과거 원장 손상: 기록 확인 불가');
  if (metaGet(db, 'mailboxError')) throw new Error(metaGet(db, 'mailboxError'));
  if (cursor && cursor.anchor > info.position) throw invalidCursor();
  const anchor = cursor?.anchor ?? info.position;
  if (filters.date) {
    const beforeDate = ledgerWhere({...filters, date:'', routine:true});
    if (db.prepare(`SELECT 1 ${FROM} WHERE ${beforeDate.sql}
      AND f.date='!range' AND v.position<=? LIMIT 1`).get(...beforeDate.params, anchor)) {
      throw new RangeError('Invalid time value');
    }
  }
  let total;
  if (where.simple) {
    const counts = JSON.parse(metaGet(db, 'counts') ?? '{}')[filters.domain ?? ''];
    total = counts?.[filters.routine ? 'total' : 'visible'] ?? 0;
    if (anchor < info.position) total -= db.prepare(`SELECT count(*) AS n ${FROM}
      WHERE ${where.sql} AND v.position>?`).get(...where.params, anchor).n;
  } else total = db.prepare(`SELECT count(*) AS n ${FROM}
    WHERE ${where.sql} AND v.position<=?`).get(...where.params, anchor).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  let page = cursor?.page ?? (reset ? 1 : Math.max(1, Number.parseInt(url.searchParams.get('logPage'), 10) || 1));
  page = Math.min(page, pages);
  let edge = cursor?.edge ?? anchor + 1;
  const ascending = cursor?.direction === 'after';
  if (!cursor && page > 1) {
    // 예전 숫자 쪽 링크는 위치 정수만 건너뛰어 호환한다. 새 이전/다음 링크에는 이 순회가 없다.
    let remaining = (page - 1) * PAGE_SIZE;
    for (const row of db.prepare(`SELECT v.position ${FROM} WHERE ${where.sql}
      AND v.position<=? ORDER BY v.position DESC`).iterate(...where.params, anchor)) {
      edge = row.position;
      if (--remaining === 0) break;
    }
  }
  const direction = ascending ? '>' : '<', order = ascending ? 'ASC' : 'DESC';
  const rows = db.prepare(`SELECT r.stream,r.seq,v.position ${FROM}
    JOIN source_rows r USING(position) WHERE ${where.sql}
    AND v.position<=? AND v.position${direction}? ORDER BY v.position ${order} LIMIT ?`)
    .all(...where.params, anchor, edge, PAGE_SIZE);
  if (ascending) rows.reverse();
  const project = domainProjector(filters.domain);
  const token = (position, direction, page) => encode({v:1, g:info.generation, q:query,
    anchor, edge:position, direction, page});
  return {
    page, pages, total, pageSize:PAGE_SIZE, cursorReset:reset,
    previousCursor:page > 1 && rows.length ? token(rows[0].position, 'after', page - 1) : null,
    nextCursor:page < pages && rows.length ? token(rows.at(-1).position, 'before', page + 1) : null,
    items:sourceViewValues(source, rows).map((value, index) =>
      (rows[index].stream === 'ledger.jsonl' ? project.legacy([value]) : project.rows([value]))[0]),
  };
}

export function createDashboardLedgerReader(home, {runtime = null, now = Date.now} = {}) {
  return url => {
    const page = withLedgerView(home, (db, info, source) => queryPage(db, info, source, url));
    return {collectedAt:new Date(now()).toISOString(), runtime, ...page,
      items:page.items.map(entry => ({at:entry.t, kind:entry.kind, label:eventLabel(entry),
        summary:eventSummary(entry), by:entry.by || '모름',
        target:entry.role || entry.to || entry.board || '모름', card:entry.executionKey || null,
        original:ledgerOriginal(entry)}))};
  };
}
