// Why: 감시의 우편 후보·답변 대기·최근 문맥을 같은 원장 수집의 상태표에서 읽는다.
// 10배 과거에도 후보 보관은 현재 미확인/답 대기 수와 역할당 12개다. 원장 배열은 아직 남는다.
import {withWatchMailboxViews, mailReminderCandidates, mailWaitingLetters,
  mailRecentLetters} from './mail-view.mjs';
import {rememberMailboxQueries} from './mailbox-queries.mjs';
import {taskIdentity, taskConnectionError, projectedCompletionKey} from './task-identity.mjs';
import {createWatchLedgerView, readWatchRows} from './watch-ledger-view.mjs';
import {withLedgerView} from './ledger-view.mjs';
import {domainProjector} from './ledger-domains.mjs';
import {openDatabase, storageMode} from './storage.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {applyWatchWorkState} from './watch-work-state.mjs';
import {captureWatchScopeFacts, rememberWatchScopeFacts, sameWatchCards} from './watch-scope-facts.mjs';
import {applyWatchRoleState} from './watch-role-state.mjs';
import {captureWatchRoleState, rememberWatchRoleState, sameRoleCards} from './watch-role-facts.mjs';

const stateKey = info => info && JSON.stringify([
  info.mailGeneration, info.mailStateVersion, info.mailCount,
]);
const project = (entries, cards) => taskIdentity(cards).project(entries).filter(e => !taskConnectionError(e));

// 같은 카드 배열에서 원문이 앞 수집의 뒤로 이어 붙은 것이면 새 사건만 해석해 이어 붙인다(별칭 뒤 최초 완료 규칙 포함).
// 앞 수집과 이어짐이 확인되지 않으면 처음부터 다시 해석한다. 결과는 project()와 같다.
function createProjectionMemo() {
  let memo = null;
  // 카드 객체가 제자리에서 바뀔 수 있으므로 배열 동일성이 아니라 주소 해석에 쓰는 key·id 내용을 비교한다.
  const sameCards = (previous, cards) => previous.length === cards.length &&
    previous.every(([key, id], index) => key === cards[index].key && id === cards[index].id);
  const extends_ = (previous, entries) => entries.length >= previous.raw.length &&
    (previous.raw.length === 0 || (entries[0] === previous.raw[0] &&
      entries[previous.raw.length - 1] === previous.raw[previous.raw.length - 1]));
  return (entries, cards) => {
    if (memo && sameCards(memo.addresses, cards) && extends_(memo, entries)) {
      if (entries.length === memo.raw.length) return memo.out.slice(); // 이미 내준 배열에 상태표가 붙어 있으므로 새 배열을 준다
      const added = [], identity = taskIdentity(cards);
      for (let index = memo.raw.length; index < entries.length; index++) {
        const entry = identity.projectEntry(entries[index]), key = projectedCompletionKey(entry);
        if (key !== null) {
          if (memo.seen.has(key)) continue;
          memo.seen.add(key);
        }
        if (!taskConnectionError(entry)) added.push(entry);
      }
      memo = {addresses:memo.addresses, raw:entries, seen:memo.seen, out:memo.out.concat(added)};
      return memo.out;
    }
    const identity = taskIdentity(cards), seen = new Set(), out = [];
    for (const raw of entries) {
      const entry = identity.projectEntry(raw), key = projectedCompletionKey(entry);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      if (!taskConnectionError(entry)) out.push(entry);
    }
    memo = {addresses:cards.map(card => [card.key, card.id]), raw:entries, seen, out};
    return out;
  };
}

// 역할·발령 상태표(watch_role_*)의 내용 지문. 위치·세대·revision은 빼고 상태 행과 계수만 본다.
function roleStateDigest(db, meta) {
  const hash = createHash('sha256');
  const rows = sql => db.prepare(sql).all();
  hash.update(JSON.stringify(rows('SELECT key,value,rank,start_position,generation_position,dispatch_ready FROM watch_role_sessions ORDER BY key')));
  hash.update(JSON.stringify(rows('SELECT session_key,task_key,task_value,position,rank,overlay FROM watch_role_dispatches ORDER BY session_key,task_key')));
  hash.update(JSON.stringify([meta.stateVersion, meta.sessionCount, meta.dispatchCount, meta.nextRank, meta.legacyRequired]));
  return hash.digest('hex');
}
const roleMetaOf = db => {
  const saved = db.prepare('SELECT value FROM watch_role_meta WHERE id=1').get();
  return saved ? JSON.parse(saved.value) : null;
};
// 정식 reducer(applyWatchRoleState)를 그대로 쓰되 상태 행만 임시 메모리 DB에 쌓는다. 위치→사건 조회는 실제 조회 영역을 읽는다.
const scratchStoreOf = (real, db) => ({scope: 'watch', db, key: value => real.key(value), load: position => real.load(position),
  clear: () => real.clear?.(), prepare: sql => /\bFROM views\b/u.test(sql) ? real.prepare(sql) : db.prepare(sql)});

export function createWatchMailReader(home, readEntries = null,
  {readCards = null, readWorks = null, readRoles = () => []} = {}) {
  const snapshots = new WeakMap();
  const ledger = createWatchLedgerView();
  const projectMemo = createProjectionMemo();
  let last = null;
  return {
    readEntries() {
      const roles = [...new Set(readRoles())].sort(), roleKey = JSON.stringify(roles);
      // 조회 DB 잠금 다음 원본 snapshot. 실제 전송/OS 조회 전에 두 트랜잭션을 닫는다.
      const value = withWatchMailboxViews(home, ({raw, projected, cards}) => {
        let works = null;
        try { works = readWorks?.() ?? null; } catch { /* 기존 readWorks 오류 경계에서 보고한다. */ }
        const entries = readEntries ? readEntries() : ledger(raw.store, raw.info);
        const roleState = !readEntries && projected &&
          applyWatchRoleState(home, projected.store, projected.info, cards);
        const roleStateKey = roleState &&
          JSON.stringify([roleState.generation, roleState.revision, roleState.stateVersion]);
        const roleFacts = roleStateKey && last?.roleStateKey === roleStateKey &&
          last.cards === cards && sameRoleCards(last.roleFacts, cards) ? last.roleFacts :
          roleState && !roleState.legacyRequired ? captureWatchRoleState(projected.store, cards) : null;
        const state = !readEntries && projected &&
          applyWatchWorkState(home, projected.store, projected.info, cards);
        const factsKey = state && JSON.stringify([state.generation, state.revision, state.stateVersion]);
        const scopeFacts = factsKey && last?.factsKey === factsKey &&
          last.cards === cards && last.works === works && sameWatchCards(last.scopeFacts, cards) ? last.scopeFacts :
          state && !state.legacyRequired ? captureWatchScopeFacts(projected.store, cards, works, entries) : null;
        const key = stateKey(raw.info), projectedKey = stateKey(projected?.info);
        const sameRaw = last?.key === key, sameRoles = last?.roleKey === roleKey;
        const queries = (view, previous, same, withRecent = false) =>
          same && (!withRecent || sameRoles) ? previous : {
          waiting:same ? previous.waiting : mailWaitingLetters(view.store),
          recent:new Map(withRecent ? roles.map(role => [role, mailRecentLetters(view.store, role)]) : []),
        };
        return {raw:entries, key, projectedKey, cards, works, factsKey, scopeFacts, roleKey, roleStateKey, roleFacts,
          letters:sameRaw ? last.letters : mailReminderCandidates(raw.store),
          rawQueries:queries(raw, last?.rawQueries, sameRaw, true),
          projectedQueries:projected ? queries(projected, last?.projectedQueries,
            last?.projectedKey === projectedKey && Boolean(last?.projectedQueries)) : null};
      }, readCards);
      // commit 실패 때는 이전 정상 후보로 대체하지 않는다.
      if (last?.raw === value.raw && last.key === value.key && last.projectedKey === value.projectedKey &&
          last.cards === value.cards && last.works === value.works && last.factsKey === value.factsKey &&
          last.scopeFacts === value.scopeFacts && last.roleKey === roleKey &&
          last.roleFacts === value.roleFacts && last.roleStateKey === value.roleStateKey) return last.entries;
      // 이미 내준 수집의 판정은 뒤의 설정·카드 주소 변화로 바꾸지 않는다.
      const entries = snapshots.has(value.raw) ? value.raw.slice() : value.raw;
      rememberMailboxQueries(entries, value.rawQueries);
      last = {...value, entries};snapshots.set(entries, last);
      return entries;
    },
    // 정기 대조(watch-sweep.mjs)가 쓰는 읽기 전용 접근. 증분 상태를 들여다보고 처음부터 다시 만들 때만 쓴다.
    sweepAccess: {
      peek: () => ledger.peek(),
      newProjector: () => domainProjector(null),
      info: () => withLedgerView(home, (cache, info) => ({generation:info.generation, position:info.position})),
      total: () => withLedgerView(home, cache => {
        const counts = cache?.prepare("SELECT value FROM meta WHERE key='counts'").get()?.value;
        return counts ? JSON.parse(counts)['']?.total ?? 0 : 0;
      }),
      // 전체 재생은 원본을 **하나의 고정 읽기 snapshot**에서 읽는다(독립검수 F5). 조각마다 새 transaction을 열면 그 사이 바뀐 내용이
      // 한 지문에 섞여 실제로 없던 상태가 diff(교체 가능)로 보인다. 원본 읽기 연결 하나가 BEGIN으로 snapshot을 붙잡고, 위치→행 대응은
      // 조회 DB(append-only)에서 읽는다. 긴 읽기 transaction은 WAL 정리(checkpoint)만 늦출 뿐 쓰기를 막지 않는다.
      openSnapshot() {
        if (storageMode(home) === 'none') return null;
        const source = openDatabase(home, {readOnly: true});
        try { source.exec('BEGIN'); source.prepare('SELECT 1 FROM events LIMIT 1').get(); }
        catch (error) { source.close();throw error; }
        return {
          readChunk: (after, upTo, projector, limit) => withWatchMailboxViews(home,
            ({raw}) => readWatchRows({prepare: sql => raw.store.prepare(sql), source}, projector, after, upTo, limit)),
          close() { try { source.exec('ROLLBACK'); } finally { source.close(); } },
        };
      },
      // 열린 카드 수 불변식: 카드 읽기(증분 캐시)의 열린 카드 수 대 같은 snapshot의 카드 stream 끝 사건 상태 수.
      // '열린 상태' 집합은 watch-store-cache.mjs의 OPEN과 같다(assigned·ready·draft). 카드의 현재 상태는 마지막 사건이라
      // 정식 규칙과 SQL 집계가 갈릴 여지가 없어 넣었다(무작위 prefix 시험: tests/watch-sweep-open-cards.test.mjs).
      openCards: () => !readCards ? null : withLedgerView(home, (cache, info, source) => {
        if (!source) return null;
        const open = new Set(['assigned', 'ready', 'draft']);
        const list = readCards();
        const row = source.prepare(`SELECT count(*) AS n FROM heads WHERE stream GLOB 'cards/*/*/events.jsonl'
          AND json_extract(payload,'$.status') IN ('assigned','ready','draft')`).get();
        return {incremental: list.filter(card => open.has(card.status)).length, sql: row.n};
      }),
      // 역할·발령 상태표 대조(F7). 독자 SQL로 규칙을 다시 쓰지 않고 정식 reducer를 임시 DB에 처음부터 적용해 지문을 비교한다.
      roleState: {
        // 저렴한 대조: 행 수와 기록된 계수. 상태 행 유실을 매 바퀴 가까운 주기로 잡는다.
        counts: () => withWatchMailboxViews(home, ({projected, cards}) => {
          if (!projected || !cards) return null;
          const live = applyWatchRoleState(home, projected.store, projected.info, cards);
          const db = projected.store;
          const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
          return live && {sessions: count('watch_role_sessions'), metaSessions: live.sessionCount,
            dispatches: count('watch_role_dispatches'), metaDispatches: live.dispatchCount};
        }, readCards),
        live: () => withWatchMailboxViews(home, ({projected, cards}) => {
          if (!projected || !cards) return null;
          const live = applyWatchRoleState(home, projected.store, projected.info, cards);
          const meta = roleMetaOf(projected.store.db);
          return live && meta && {position: meta.position, generation: meta.generation, digest: roleStateDigest(projected.store.db, meta),
            cardsKey: JSON.stringify(cards.map(card => [card.key, card.id])), cards};
        }, readCards),
        // 지문 비교용 재생: 조각(위치 범위)마다 한 번씩 정식 reducer를 이어서 적용한다.
        async replay({upTo, generation, cards, chunkPositions = 2000, yieldNow}) {
          const scratch = new DatabaseSync(':memory:'), scratchHome = `${home}#sweep-role-state`;
          try {
            let position = 0;
            while (position < upTo) {
              position = Math.min(upTo, position + chunkPositions);
              withWatchMailboxViews(home, ({projected}) => {
                if (!projected) throw new Error('역할 상태 재생에 조회 영역이 없습니다');
                applyWatchRoleState(scratchHome, scratchStoreOf(projected.store, scratch), {generation, position}, cards);
              }, readCards);
              await yieldNow?.();
            }
            const meta = roleMetaOf(scratch);
            return meta && {digest: roleStateDigest(scratch, meta), position: meta.position};
          } finally { scratch.close(); }
        },
        // 교체: 상태표 메타를 지워 다음 읽기가 처음부터 다시 만들게 한다(원장·조회 DB는 건드리지 않는다).
        reset: () => withWatchMailboxViews(home, ({projected}) => { projected?.store.db.exec('DELETE FROM watch_role_meta'); }, readCards),
      },
      // 조회 DB가 적용한 영역별 마지막 순번과 원본 stream 끝 순번. 같은 snapshot에서 함께 읽는다.
      streamCursors: () => withLedgerView(home, (cache, info, source) => {
        const cursor = {}, max = {};
        if (!cache) return {cursor, max};
        for (const row of cache.prepare('SELECT stream, seq FROM cursors').all()) cursor[row.stream] = row.seq;
        const head = source.prepare('SELECT seq FROM heads WHERE stream=?');
        for (const stream of Object.keys(cursor)) max[stream] = head.get(stream)?.seq ?? 0;
        return {cursor, max};
      }),
    },
    // 교체: 증분 상태를 버려 다음 읽기가 원본에서 처음부터 다시 만들게 한다.
    resetIncremental() { ledger.reset();last = null; },
    letters(entries) {
      const value = snapshots.get(entries);
      if (!value) throw new Error('감시 우편과 원장 수집 버전이 다릅니다');
      return value.letters;
    },
    project(entries, cards) {
      const value = snapshots.get(entries);
      // 그 사이 카드가 바뀌면 받은 카드로 예전과 똑같이 해석한다. 다른 시점 SQL 상태를 섞지 않는다.
      if (!value?.projectedQueries || value.cards !== cards) return project(entries, cards);
      if (!value.projected) {
        value.projected = projectMemo(entries, cards);
        rememberMailboxQueries(value.projected, value.projectedQueries);
        rememberWatchScopeFacts(value.projected, cards, value.scopeFacts);
        rememberWatchRoleState(value.projected, cards, value.roleFacts);
      }
      return value.projected;
    },
  };
}
