// 설명은 현재 줄만 보관한다. 첫 조회에 과거 줄을 검증하고 이후에는 새 줄만 검증한다.
import {databaseIdentity, storageMode, transaction} from './storage.mjs';

export function createDashboardBriefReader(home) {
  let identity = null, cached = new Map();
  const stats = {rows: 0};
  return {
    read(keys) {
      try {
        if (storageMode(home) === 'none') {cached.clear();identity = null;return new Map();}
        return transaction(home, db => {
          const currentIdentity = databaseIdentity(home);
          const streams = keys.map(key => `cards/${key}/briefs.jsonl`);
          const heads = db.prepare(`SELECT h.stream,h.seq,h.payload,e.payload AS original
            FROM json_each(?) wanted JOIN heads h ON h.stream=wanted.value
            LEFT JOIN events e ON e.stream=h.stream AND e.seq=h.seq`).all(JSON.stringify(streams));
          if (identity !== currentIdentity || heads.some(h => h.seq < (cached.get(h.stream)?.seq ?? 0))) {
            cached = new Map();
          }
          const next = new Map(), changed = [];
          for (const head of heads) {
            const previous = cached.get(head.stream);
            if (previous?.seq === head.seq && previous.payload === head.payload
                && head.payload === head.original) {next.set(head.stream, previous);continue;}
            const reuse = previous && previous.seq < head.seq;
            next.set(head.stream, {seq: reuse ? previous.seq : 0, payload: head.payload,
              error: head.payload !== head.original || (reuse && previous.error), brief: null});
            changed.push({stream: head.stream, seq: reuse ? previous.seq : 0});
          }
          if (changed.length) {
            const query = db.prepare(`SELECT e.stream,e.seq,e.payload FROM json_each(?) c
              JOIN events e ON e.stream=json_extract(c.value,'$.stream')
                AND e.seq>json_extract(c.value,'$.seq') ORDER BY e.stream,e.seq`);
            for (const row of query.iterate(JSON.stringify(changed))) {
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
          if (currentIdentity !== databaseIdentity(home)) throw new Error('조회 중 저장소 파일 교체');
          cached = next;identity = currentIdentity;
          return new Map(heads.map(h => {
            const value = next.get(h.stream);
            return [h.stream.slice(6, -13), {brief: value.error ? null : value.brief,
              error: value.error ? '설명 기록을 읽을 수 없습니다' : null}];
          }));
        }, {readOnly: true});
      } catch (error) {cached.clear();identity = null;throw error;}
    },
    info: () => ({...stats, streams: cached.size}),
  };
}
