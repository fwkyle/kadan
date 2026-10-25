// Why: 감시의 우편 후보·답변 대기·최근 문맥을 같은 원장 수집의 상태표에서 읽는다.
// 10배 과거에도 후보 보관은 현재 미확인/답 대기 수와 역할당 12개다. 원장 배열은 아직 남는다.
import {withWatchMailboxViews, mailReminderCandidates, mailWaitingLetters,
  mailRecentLetters} from './mail-view.mjs';
import {rememberMailboxQueries} from './mailbox-queries.mjs';
import {taskIdentity, taskConnectionError, projectedCompletionKey} from './task-identity.mjs';
import {createWatchLedgerView} from './watch-ledger-view.mjs';
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
