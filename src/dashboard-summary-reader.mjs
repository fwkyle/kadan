// Why: 상단 숫자를 읽으려고 본문·자원·카드 판정·화면 모델까지 계산하지 않는다.
// 10배 이력에서 정상 조회는 현재 heads와 새 사건만 읽는다. 원장 상시 보관은 별도 개선 대상이다.
import {createWatchStoreReaders} from './watch-store-cache.mjs';
import {readLedgerIncremental} from './ledger-incremental.mjs';
import {databaseIdentity, storageMode, storageSnapshot, streamHeads} from './storage.mjs';
import {DecisionStore} from './decisions.mjs';
import {withMailboxView, mailboxWaitingCount} from './mail-view.mjs';
import {buildTree} from './cli-tree.mjs';
import {createTreeInputCache} from './dashboard-tree-inputs.mjs';

export function createDashboardSummaryReader(home, {listSessions, runtime = null, now = Date.now}) {
  const stores = createWatchStoreReaders(home);
  const treeInputs = createTreeInputCache();
  let decisionCache, countCache, treeCache;
  return () => {
    const errors = [];
    // 조회 DB 잠금 뒤 원본 snapshot을 연다. OS 조회·트리 계산 전에 둘 다 닫는다.
    const data = withMailboxView(home, store => storageSnapshot(home, () => {
      const entries = readLedgerIncremental(home);
      const waiting = mailboxWaitingCount(store);
      const cards = stores.cards.read(), works = stores.works.read();
      const heads = streamHeads(home, ['decisions/events.jsonl']);
      const identity = storageMode(home) === 'none' ? 'none' : databaseIdentity(home);
      const key = JSON.stringify([identity, heads.get('decisions/events.jsonl') ?? null]);
      let decisions = null;
      try {
        if (decisionCache?.key !== key) decisionCache = {key, rows: new DecisionStore(home).list()};
        decisions = decisionCache.rows;
      } catch (error) { decisionCache = null; errors.push(error.message); }
      return {entries, waiting, cards, works, decisions};
    }), {domain:'mailbox'});
    const {cards, works, entries, waiting, decisions} = data;
    const treeEntries = treeInputs(entries).entries;
    if (countCache?.cards !== cards || countCache?.works !== works) {
      const linked = new Set(works.flatMap(work => work.executions.map(e => e.key)));
      countCache = {cards, works, value: {work: works.length, executions: cards.length,
        unlinked: cards.filter(card => !linked.has(card.key)).length}};
    }
    let secretary = null;
    try {
      const sessions = listSessions().filter(s => s.alive !== false);
      const key = JSON.stringify(sessions.map(s => [s.session, s.pid ?? null]));
      if (treeCache?.entries !== treeEntries || treeCache?.cards !== cards || treeCache?.key !== key) {
        const alive = Object.fromEntries(sessions.map(s => [s.session, s]));
        const tree = buildTree(treeEntries, alive, cards);
        treeCache = {entries: treeEntries, cards, key,
          secretary: tree.some(b => b.roles.some(r => r.role === '비서' && r.life.state === 'alive'))};
      }
      secretary = treeCache.secretary;
    } catch (error) { errors.push(`생존 못 읽음(죽음이 아니라 모름): ${error.message}`); }
    return {collectedAt: new Date(now()), runtime, secretary,
      decisions: decisions?.filter(d => d.status === 'open').length ?? null,
      waiting, counts: countCache.value, errors};
  };
}
