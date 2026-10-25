// Why: 감시 요약도 매 순회 과거 이력을 검증했다. 시작에는 전체를 검증하고 이후에는 새 revision만 읽는다.
// 10배 과거 이력에서도 정상 조회는 heads 수와 새 사건에 비례한다. 카드 이력은 유한한 판정 요약으로 둔다.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CardStore} from './card-store.mjs';
import {WorkStore} from './work-store.mjs';
import {advanceWatchWorkSummary} from './work-watch-summary.mjs';
import {advanceCardHistoryFacts} from './card-history-facts.mjs';
import {databaseIdentity, storageMode, transaction} from './storage.mjs';

const OPEN = new Set(['assigned', 'ready', 'draft']);
const errorFor = kind => new Error(kind === 'cards' ? '카드 이력 손상' : '업무 이력 손상');

// reader는 감시 프로세스 하나가 소유한다. 전역 홈별 Map을 만들지 않아 임시 홈도 계속 남지 않는다.
function reader(home, kind, store) {
  let state = null;
  const stats = {full: 0, changed: 0, unchanged: 0, rows: 0};
  const pattern = kind === 'cards' ? 'cards/*/*/events.jsonl' : 'works/*/events.jsonl';
  const keyOf = stream => stream.slice(6, -13);

  function cardRow(latest, facts) {
    const dir = store.dir(latest.key), row = {...latest, path:path.join(dir, 'card.md')};
    delete row.history;delete row.watchHistorySummary;
    if (OPEN.has(latest.status)) row.watchHistorySummary = facts;
    if (latest.artifactLayout === 'card-v1') {
      row.resultPath = path.resolve(dir, 'result.md');row.evidenceDir = path.resolve(dir, 'evidence');
    }
    return row;
  }

  function initialCards(db, heads) {
    const rows = new Map(), facts = new Map(), seqs = new Map();
    const query = db.prepare(`SELECT e.stream,e.seq,e.payload,
      json_type(e.payload,'$.revision') AS revision_type FROM events e JOIN heads h USING(stream)
      WHERE h.stream GLOB ? ORDER BY e.stream,e.seq`);
    for (const row of query.iterate(pattern)) {
      const key = keyOf(row.stream), value = JSON.parse(row.payload);
      const seq = (seqs.get(row.stream) ?? 0) + 1;
      if (!value || row.seq !== seq || row.revision_type !== 'integer' ||
          value.key !== key || value.revision !== seq) throw errorFor(kind);
      facts.set(key, advanceCardHistoryFacts(facts.get(key), rows.get(key), value));
      rows.set(key, value);seqs.set(row.stream, seq);
    }
    const list = heads.map(head => {
      const key = keyOf(head.stream), latest = rows.get(key);
      if (!latest || seqs.get(head.stream) !== head.seq) throw errorFor(kind);
      const row = cardRow(latest, facts.get(key));rows.set(key, row);return row;
    });
    return {rows, facts, seqs, list};
  }

  function readSnapshot(db, identity) {
    // head를 바꿔도 원본 끝 행과 다르면 거절한다. payload는 JS로 복사하지 않는다.
    // heads만 읽어 (순번, payload 지문)을 기억한 값과 비교한다. 끝 행과 events의 대조는 처음·파일 교체 뒤
    // 전체, 그 밖에는 순번이나 지문이 달라진 스트림만 한다. payload는 JS에 보관하지 않는다.
    // 한계: 같은 순번·같은 head인 채 과거 events만 고친 손상은 시작·파일 교체 때만 잡힌다.
    const heads = [], prints = new Map();
    for (const row of db.prepare('SELECT stream, seq, payload FROM heads WHERE stream GLOB ? ORDER BY stream')
      .iterate(pattern)) {
      heads.push({stream: row.stream, seq: row.seq});
      prints.set(row.stream, `${row.seq}:${createHash('sha256').update(row.payload).digest('base64')}`);
    }
    const streams = new Set(heads.map(h => h.stream));
    if (state?.identity !== identity || heads.some(h => h.seq < (state?.seqs.get(h.stream) ?? 0))
        || (state && [...state.seqs.keys()].some(s => !streams.has(s)))) state = null;
    const unverified = state ? heads.filter(h => state.prints.get(h.stream) !== prints.get(h.stream)) : heads;
    if (unverified.length) {
      const bad = db.prepare(`SELECT count(*) AS n FROM json_each(?) c JOIN heads h ON h.stream=c.value
        LEFT JOIN events e ON e.stream=h.stream AND e.seq=h.seq WHERE coalesce(h.payload=e.payload,0)=0`)
        .get(JSON.stringify(unverified.map(h => h.stream)));
      if (bad.n) throw errorFor(kind);
    }
    if (!state) {
      if (kind === 'cards') state = {identity, prints, ...initialCards(db, heads)};
      else {
        const rows = store.listWatch();
        state = {identity, prints, seqs: new Map(heads.map(h => [h.stream, h.seq])),
          rows: new Map(rows.map(row => [row.key, row])), list: rows};
      }
      stats.full++;
      stats.rows += heads.reduce((n, h) => n + h.seq, 0);
      return state.list;
    }
    const changed = heads.filter(h => h.seq !== state.seqs.get(h.stream));
    if (!changed.length) { stats.unchanged++; state.prints = prints; return state.list; }
    // 검증·요약이 모두 성공하기 전에는 이전 상태/순번을 바꾸지 않는다.
    const rows = new Map(state.rows), seqs = new Map(state.seqs);
    const facts = state.facts ? new Map(state.facts) : null;
    const query = db.prepare('SELECT seq,payload FROM events WHERE stream=? AND seq>? ORDER BY seq');
    let count = 0;
    for (const head of changed) {
      const key = keyOf(head.stream), previous = rows.get(key), added = [];
      let seq = seqs.get(head.stream) ?? 0, latest = previous, summary = facts?.get(key);
      const previousSeq = seq;
      // key 형식도 기존 상세 조회와 같은 경로 검사를 거친다.
      if (kind === 'cards') store.dir(key);
      else if (!/^[\p{L}\p{N}_-]+\/[\p{L}\p{N}_-]+$/u.test(key)) throw errorFor(kind);
      for (const row of query.iterate(head.stream, seq)) {
        const event = JSON.parse(row.payload);
        if (row.seq !== ++seq || event.key !== key || event.revision !== seq
            || (kind === 'works' && (!Array.isArray(event.executions) || !Array.isArray(event.mailRefs)))) {
          throw errorFor(kind);
        }
        if (kind === 'cards') {
          summary = advanceCardHistoryFacts(summary, latest, event);latest = event;
        } else added.push(event);
        count++;
      }
      if (seq !== head.seq || seq === previousSeq) throw errorFor(kind);
      if (kind === 'works') rows.set(key, advanceWatchWorkSummary(previous, added));
      else {
        facts.set(key, summary);rows.set(key, cardRow(latest, summary));
      }
      seqs.set(head.stream, seq);
    }
    const list = heads.map(h => rows.get(keyOf(h.stream)));
    state = {identity, prints, rows, seqs, list, ...(facts ? {facts} : {})};
    stats.changed += changed.length; stats.rows += count;
    return list;
  }

  return {
    read() {
      try {
        if (storageMode(home) === 'none') { state = null; return store.listWatch(); }
        const identity = databaseIdentity(home);
        const value = transaction(home, db => readSnapshot(db, identity), {readOnly: true});
        if (identity !== databaseIdentity(home)) throw new Error('조회 중 저장소 파일 교체: 다시 읽어야 합니다');
        return value;
      } catch (error) { state = null; throw error; }
    },
    info: () => ({...stats, streams: state?.seqs.size ?? 0}),
    reset: () => { state = null; },
  };
}

export function createWatchStoreReaders(home) {
  return {
    cards: reader(home, 'cards', new CardStore(home)),
    works: reader(home, 'works', new WorkStore(home)),
  };
}
