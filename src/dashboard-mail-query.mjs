// Why: 우편 조건과 한 쪽만 SQL로 고르고, 본문 검색 파일은 DB snapshot 밖에서 읽는다.
import {withMailboxView} from './mail-view.mjs';
import {mailMatchesText} from './dashboard-inbox.mjs';
import {storedMailLetter, mailStateSelect, mailStateFrom, mailStateJoins, previousMailExpression,
  decodeMailValue} from './mail-view-store.mjs';
import {pageQueryKey, decodePageCursor, encodePageCursor, invalidPageCursor} from './dashboard-page-cursor.mjs';

const SIZE = 50;
function filtersOf(url) {
  const p = url.searchParams;
  return {role:p.get('mailRole') || '', view:p.get('mailView') || 'all', reply:p.get('mailReply') || '',
    card:(p.get('mailCard') || '').trim(), text:(p.get('mailQ') || '').trim(),
    unread:p.get('mailUnread') || '', hideWatch:p.get('hideWatch') === '1'};
}
function whereOf(store, filters) {
  const {role, view, reply, card, unread, hideWatch} = filters;
  const clauses = ['m.domain=?'], params = [store.scope];
  if (role) {
    const key = store.key(role);
    if (view === 'received' || view === 'to-reply') {clauses.push('m.recipient_key=?');params.push(key);}
    else if (view === 'sent' || view === 'waiting') {clauses.push('m.sender_key=?');params.push(key);}
    else {clauses.push('(m.recipient_key=? OR m.sender_key=?)');params.push(key, key);}
  }
  if (view === 'to-reply' || view === 'waiting') clauses.push("m.reply_status='waiting'");
  if (reply) {clauses.push('m.reply_status=?');params.push(reply);}
  if (unread === '1' || unread === 'previous') {
    clauses.push('m.read=0 AND m.notification=0', `(${previousMailExpression})=${unread === '1' ? 0 : 1}`);
  }
  if (hideWatch) clauses.push('m.by_watch=0');
  if (card) {
    clauses.push(`EXISTS (SELECT 1 FROM mail_cards c WHERE c.domain=m.domain AND c.position=m.position
      AND ${card.includes('/') ? 'c.card IN (?,?)' : 'c.short_id=?'})`);
    params.push(...(card.includes('/') ? [card, card.split('/').at(-1)] : [card]));
  }
  return {sql:clauses.join(' AND '), params, simple:clauses.length === 1};
}

function statistics(store) {
  const waiting = store.prepare(`SELECT count(*) AS n FROM mail_current
    WHERE domain=? AND reply_status='waiting'`).get(store.scope).n;
  // 통계가 없는 새 캐시에서도 전체 우편 대신 미확인 우편의 색인만 순회한다.
  const unread = store.prepare(`SELECT count(*) AS n,sum(${previousMailExpression}) AS previous
    FROM mail_current m INDEXED BY mail_read ${mailStateJoins}
    WHERE m.domain=? AND m.read=0 AND m.notification=0`).get(store.scope);
  const roles = store.prepare(`SELECT value FROM mail_role_counts WHERE domain=? ORDER BY first_rank`)
    .all(store.scope).map(row => decodeMailValue(row.value)).filter(Boolean).sort();
  return {waiting, unread:unread.n - (unread.previous ?? 0), previousGenerationUnread:unread.previous ?? 0, roles};
}

function context(store, info, url) {
  const filters = filtersOf(url), query = pageQueryKey(filters);
  let cursor = decodePageCursor(url.searchParams.get('mailCursor'));
  if (cursor && (!Number.isSafeInteger(cursor.state) || cursor.state < 0)) throw invalidPageCursor();
  const reset = Boolean(cursor && (cursor.g !== info.mailGeneration || cursor.q !== query ||
    cursor.state !== info.mailStateVersion));
  if (reset) cursor = null;
  if (cursor && cursor.anchor > info.position) throw invalidPageCursor();
  return {filters, query, cursor, reset, info, anchor:cursor?.anchor ?? info.position,
    wanted:cursor?.page ?? (reset ? 1 : Math.max(1, Number.parseInt(url.searchParams.get('mailPage'), 10) || 1)),
    edge:cursor?.edge ?? info.position + 1, ascending:cursor?.direction === 'after',
    where:store ? whereOf(store, filters) : null,
    statistics:store ? statistics(store) : {waiting:0, unread:0, previousGenerationUnread:0, roles:[]}};
}

function result(ctx, rows, total) {
  const pages = Math.max(1, Math.ceil(total / SIZE)), page = Math.min(ctx.wanted, pages);
  const cursor = (edge, direction, page) => encodePageCursor({v:1, g:ctx.info.mailGeneration, q:ctx.query,
    anchor:ctx.anchor, edge, direction, page, state:ctx.info.mailStateVersion});
  return {...ctx.statistics, page, pages, total, pageSize:SIZE, cursorReset:ctx.reset,
    items:rows.map(row => row.mail),
    previousCursor:page > 1 && rows.length ? cursor(rows[0].position, 'after', page - 1) : null,
    nextCursor:page < pages && rows.length ? cursor(rows.at(-1).position, 'before', page + 1) : null};
}

function sqlPage(store, ctx) {
  if (!store) return result(ctx, [], 0);
  const {where, anchor, ascending} = ctx;
  const total = where.simple ? ctx.info.mailCount - store.prepare(`SELECT count(*) AS n FROM mail_current
    WHERE domain=? AND position>?`).get(store.scope, anchor).n
    : store.prepare(`SELECT count(*) AS n ${mailStateFrom} WHERE ${where.sql} AND m.position<=?`)
      .get(...where.params, anchor).n;
  const page = Math.min(ctx.wanted, Math.max(1, Math.ceil(total / SIZE)));
  let edge = ctx.edge;
  if (!ctx.cursor && page > 1) {
    let remaining = (page - 1) * SIZE;
    for (const row of store.prepare(`SELECT m.position ${mailStateFrom} WHERE ${where.sql}
      AND m.position<=? ORDER BY m.position DESC`).iterate(...where.params, anchor)) {
      edge = row.position;if (--remaining === 0) break;
    }
  }
  const rows = store.prepare(`${mailStateSelect} WHERE ${where.sql}
    AND m.position<=? AND m.position${ascending ? '>' : '<'}?
    ORDER BY m.position ${ascending ? 'ASC' : 'DESC'} LIMIT ?`).all(...where.params, anchor, edge, SIZE);
  if (ascending) rows.reverse();
  return result(ctx, rows.map(row => ({position:row.position, mail:storedMailLetter(store, row)})), total);
}

const assertSameState = (ctx, info) => {
  if (ctx.info.mailGeneration !== info.mailGeneration || ctx.info.mailStateVersion !== info.mailStateVersion) {
    throw new Error('검색 중 우편 상태가 바뀌었습니다. 다시 조회해 주세요');
  }
};
function textPage(home, ctx, bodyOf) {
  let before = ctx.anchor + 1, total = 0, selected = [], tail = [];
  const start = (ctx.wanted - 1) * SIZE;
  while (true) {
    const batch = withMailboxView(home, (store, info) => {
      assertSameState(ctx, info);
      if (!store) return [];
      const where = whereOf(store, ctx.filters);
      return store.prepare(`${mailStateSelect} WHERE ${where.sql} AND m.position<?
        ORDER BY m.position DESC LIMIT 256`).all(...where.params, before)
        .map(row => ({position:row.position, mail:storedMailLetter(store, row)}));
    });
    if (!batch.length) break;
    before = batch.at(-1).position;
    // 파일 검색은 트랜잭션을 닫은 뒤 실행한다. 선택/마지막 쪽 외의 과거 객체는 보관하지 않는다.
    for (const row of batch) {
      if (!mailMatchesText(row.mail, ctx.filters.text, bodyOf)) continue;
      tail.push(row);if (tail.length > SIZE) tail.shift();
      if (!ctx.cursor && total >= start && total < start + SIZE) selected.push(row);
      if (ctx.cursor && (ctx.ascending ? row.position > ctx.edge : row.position < ctx.edge)) {
        if (ctx.ascending) {selected.push(row);if (selected.length > SIZE) selected.shift();}
        else if (selected.length < SIZE) selected.push(row);
      }
      total++;
    }
  }
  if (!ctx.cursor && ctx.wanted > Math.max(1, Math.ceil(total / SIZE))) selected = tail.slice(-(total % SIZE || SIZE));
  return result(ctx, selected, total);
}

export function queryDashboardMail(home, url, {bodyOf, readCards}) {
  let ctx, cards;
  const page = withMailboxView(home, (store, info) => {
    ctx = context(store, info, url);
    if (ctx.filters.text) return null;
    const value = sqlPage(store, ctx);cards = readCards();return value;
  });
  if (page) return {page, cards};
  const searched = textPage(home, ctx, bodyOf);
  cards = withMailboxView(home, (_store, info) => {assertSameState(ctx, info);return readCards();});
  return {page:searched, cards};
}

export function queryDashboardMailBody(home, url, readCards) {
  return withMailboxView(home, (store) => {
    const row = store?.prepare(`${mailStateSelect} WHERE m.domain=? AND m.address=?
      ORDER BY m.position LIMIT 1`).get(store.scope, store.key(url.searchParams.get('id')));
    if (!row) throw Object.assign(new Error('편지를 찾을 수 없습니다'), {status:404});
    return {mail:storedMailLetter(store, row), cards:readCards()};
  });
}
