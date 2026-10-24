// Why: 목록마다 카드 수만큼 SQL을 준비하고 이전 이력을 다시 읽지 않도록 한다.
// DB 검증은 head와 새 사건만 읽는다. 상세 호환을 위해 이력은 보관하며 변경된 이력 배열은 복사한다.
// 이력이 10배면 최초 복구·보관 메모리·변경 카드의 배열 복사는 늘어난다. 현재 상태 투영은 별도 작업이다.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CardStore} from './card-store.mjs';
import {databaseIdentity, storageMode, transaction} from './storage.mjs';

export function createDashboardStoreReader(home, kind) {
  const cards = new CardStore(home), pattern = `${kind}/*/*/events.jsonl`;
  const failure = () => new Error(kind === 'cards' ? '카드 이력 손상' : '업무 이력 손상');
  let identity = null, cached = new Map(), bodies = new Map();
  const stats = {rows: 0, bodies: 0};

  function read(db) {
    const currentIdentity = databaseIdentity(home);
    const heads = [];
    for (const row of db.prepare(`SELECT h.stream,h.seq,h.payload,h.payload=e.payload AS valid
      FROM heads h LEFT JOIN events e ON e.stream=h.stream AND e.seq=h.seq
      WHERE h.stream GLOB ? ORDER BY h.stream`).iterate(pattern)) {
      if (!row.valid) throw failure();
      heads.push({stream: row.stream, seq: row.seq,
        hash: createHash('sha256').update(row.payload).digest('hex')});
    }
    const streams = new Set(heads.map(h => h.stream));
    if (identity !== currentIdentity || heads.some(h => h.seq < (cached.get(h.stream)?.seq ?? 0))
        || [...cached.keys()].some(s => !streams.has(s))) cached = new Map();
    const changed = heads.filter(h => {
      const previous = cached.get(h.stream);
      return !previous || previous.seq !== h.seq || previous.hash !== h.hash;
    });
    const next = new Map(cached);
    if (changed.length) {
      const starts = changed.map(h => {
        const previous = cached.get(h.stream);
        // 같은 순번의 끝 행이 교체되어도 이전 검증 결과를 이어 쓰지 않는다.
        const seq = previous && previous.seq < h.seq ? previous.seq : 0;
        next.set(h.stream, {seq, history: seq ? [...previous.history] : []});
        return {stream: h.stream, seq};
      });
      const query = db.prepare(`SELECT e.stream,e.seq,e.payload FROM json_each(?) c
        JOIN events e ON e.stream=json_extract(c.value,'$.stream')
          AND e.seq>json_extract(c.value,'$.seq') ORDER BY e.stream,e.seq`);
      for (const row of query.iterate(JSON.stringify(starts))) {
        const key = row.stream.slice(6, -13), value = JSON.parse(row.payload), state = next.get(row.stream);
        if (kind === 'cards') cards.dir(key);
        if (!/^[\p{L}\p{N}_-]+\/[\p{L}\p{N}_-]+$/u.test(key) || row.seq !== state.seq + 1
            || value.key !== key || value.revision !== row.seq
            || kind === 'works' && (!Array.isArray(value.executions) || !Array.isArray(value.mailRefs))) {
          throw failure();
        }
        state.history.push(value);state.seq = row.seq;stats.rows++;
      }
      for (const head of changed) {
        const state = next.get(head.stream);
        if (state.seq !== head.seq || !state.history.length) throw failure();
        state.hash = head.hash;
      }
    }
    const nextBodies = new Map();
    const list = heads.map(head => {
      const {history} = next.get(head.stream), latest = history.at(-1);
      if (kind === 'works') return {...latest, history};
      const dir = cards.dir(latest.key), file = path.join(dir, 'card.md'), stat = fs.statSync(file);
      const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      let body = bodies.get(file);
      if (!body || body.signature !== signature) {
        body = {signature, text: fs.readFileSync(file, 'utf8')};stats.bodies++;
      }
      nextBodies.set(file, body);
      return {...latest, history, body: body.text, path: file,
        ...(latest.artifactLayout === 'card-v1'
          ? {resultPath: path.resolve(dir, 'result.md'), evidenceDir: path.resolve(dir, 'evidence')} : {})};
    });
    if (currentIdentity !== databaseIdentity(home)) throw new Error('조회 중 저장소 파일 교체: 다시 읽어야 합니다');
    identity = currentIdentity;cached = next;bodies = nextBodies;
    return list;
  }
  return {
    read() {
      try {
        if (storageMode(home) === 'none') {cached.clear();bodies.clear();identity = null;return [];}
        return transaction(home, read, {readOnly: true});
      } catch (error) {cached.clear();bodies.clear();identity = null;throw error;}
    },
    info: () => ({...stats, streams: cached.size}),
  };
}
