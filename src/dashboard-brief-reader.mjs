// 설명은 현재 줄만 보관한다. 첫 조회에 과거 줄을 검증하고 이후에는 새 줄만 검증한다.
// 직전 조회 뒤 새 사건이 없으면 heads·events 줄을 읽지 않는다(마지막 사건 번호 한 줄만 확인한다).
// 새 사건이 있으면 그 사건이 가리킨 설명 흐름과 처음 보는 key만 아래 검증 절차로 읽는다.
// 흐름이 없는 key도 "없음"으로 기억한다. 나중에 흐름이 생기면 새 사건으로 잡힌다.
// heads와 events 끝 줄의 대조는 처음·바뀐 흐름·10분마다(DERIVED_MAX_AGE_MS)의 전체 확인 때 한다.
// 원장이 10배여도 변경 없는 조회는 요청한 key 수만큼 메모리만 훑고, 변경 있는 조회는 새 사건 수에 비례한다.
import {databaseIdentity, storageMode, transaction} from './storage.mjs';
import {DERIVED_MAX_AGE_MS} from './wall-snapshot-cache.mjs';

export function createDashboardBriefReader(home, {now = () => Date.now()} = {}) {
  // cached: 흐름 이름 → 상태 또는 null(흐름 없음). 직전 조회가 요청한 key만 든다.
  // rowid: cached가 반영한 마지막 사건 번호, fullAt: 마지막 전체 확인 시각.
  let identity = null, cached = new Map(), rowid = 0, fullAt = 0;
  // rows: 검증하며 읽은 설명 줄, asked: heads에 물은 흐름 수, heads: heads에서 읽은 줄,
  // events: 새 사건을 찾으며 events에서 읽은 줄, full: 전체 확인 횟수.
  // 마지막 사건 번호 확인(max(rowid))은 세지 않는다. 응답에는 싣지 않는다.
  const stats = {rows: 0, asked: 0, heads: 0, events: 0, full: 0};
  const forget = () => {cached = new Map();identity = null;};

  function readHeads(db, streams) {
    if (!streams.length) return [];
    stats.asked += streams.length;
    const heads = db.prepare(`SELECT h.stream,h.seq,h.payload,e.payload AS original
      FROM json_each(?) wanted JOIN heads h ON h.stream=wanted.value
      LEFT JOIN events e ON e.stream=h.stream AND e.seq=h.seq`).all(JSON.stringify(streams));
    stats.heads += heads.length;
    return heads;
  }
  // 직전 조회 뒤 새 사건이 가리킨 설명 흐름 이름.
  function changedSince(db, after) {
    const changed = new Set();
    for (const row of db.prepare('SELECT stream FROM events WHERE rowid>?').iterate(after)) {
      stats.events++;
      if (row.stream.endsWith('/briefs.jsonl')) changed.add(row.stream);
    }
    return changed;
  }

  return {
    read(keys) {
      try {
        if (storageMode(home) === 'none') {forget();return new Map();}
        return transaction(home, db => {
          const currentIdentity = databaseIdentity(home);
          const currentRowid = db.prepare('SELECT max(rowid) AS v FROM events').get().v ?? 0;
          const streams = keys.map(key => `cards/${key}/briefs.jsonl`);
          // 전체 확인: 요청한 흐름을 모두 heads에서 다시 읽는다. DB 파일이 바뀌었거나 사건 번호가 뒤로 갔으면 기억도 버린다.
          let known = cached, full = false, changed = null;
          if (identity !== currentIdentity || currentRowid < rowid) {known = new Map();full = true;}
          else if (now() - fullAt >= DERIVED_MAX_AGE_MS) full = true;
          else if (currentRowid > rowid) changed = changedSince(db, rowid);
          let wanted = full ? streams : streams.filter(s => !known.has(s) || changed?.has(s));
          let heads = readHeads(db, wanted);
          if (heads.some(h => h.seq < (known.get(h.stream)?.seq ?? 0))) {
            known = new Map();
            if (!full) {full = true;wanted = streams;heads = readHeads(db, wanted);}
          }
          if (full) stats.full++;
          const next = new Map(), stale = [];
          for (const head of heads) {
            const previous = known.get(head.stream) ?? undefined;
            if (previous?.seq === head.seq && previous.payload === head.payload
                && head.payload === head.original) {next.set(head.stream, previous);continue;}
            const reuse = previous && previous.seq < head.seq;
            next.set(head.stream, {seq: reuse ? previous.seq : 0, payload: head.payload,
              error: head.payload !== head.original || (reuse && previous.error), brief: null});
            stale.push({stream: head.stream, seq: reuse ? previous.seq : 0});
          }
          if (stale.length) {
            const query = db.prepare(`SELECT e.stream,e.seq,e.payload FROM json_each(?) c
              JOIN events e ON e.stream=json_extract(c.value,'$.stream')
                AND e.seq>json_extract(c.value,'$.seq') ORDER BY e.stream,e.seq`);
            for (const row of query.iterate(JSON.stringify(stale))) {
              const state = next.get(row.stream), value = JSON.parse(row.payload);
              state.error ||= row.seq !== state.seq + 1 || value?.key !== row.stream.slice(6, -13)
                || !value?.sourceHash;
              state.seq = row.seq;state.brief = value;stats.rows++;
            }
          }
          for (const head of heads) {
            const state = next.get(head.stream);
            state.error ||= state.seq !== head.seq || !state.brief;
          }
          // 이번에 읽은 흐름은 새 값(없으면 null), 읽지 않은 흐름은 기억한 값을 쓴다. 요청하지 않은 key는 버린다.
          const read = new Set(wanted), remembered = new Map(), result = new Map();
          for (const stream of streams) {
            const value = read.has(stream) ? next.get(stream) ?? null : known.get(stream);
            remembered.set(stream, value);
            if (value) {
              result.set(stream.slice(6, -13), {brief: value.error ? null : value.brief,
                error: value.error ? '설명 기록을 읽을 수 없습니다' : null});
            }
          }
          // 읽는 도중 파일이 교체됐으면 기억하지 않는다. 수집은 바깥 읽기 연결 안에서 돌아 다시 읽어도 옛 파일이라 재시도하지 않는다.
          if (currentIdentity !== databaseIdentity(home)) throw new Error('조회 중 저장소 파일 교체');
          cached = remembered;identity = currentIdentity;rowid = currentRowid;
          if (full) fullAt = now();
          return result;
        }, {readOnly: true});
      } catch (error) {forget();throw error;}
    },
    info: () => {
      let streams = 0;
      for (const value of cached.values()) if (value) streams++;
      return {...stats, streams};
    },
  };
}
