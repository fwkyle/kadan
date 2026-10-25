// Why: 목록마다 카드 수만큼 SQL을 준비하고 이전 이력을 다시 읽지 않도록 한다.
// DB 검증은 head와 새 사건만 읽는다. 끝 행 대조는 처음·바뀐 스트림에만 한다(변경 없는 요청은 events를 건드리지 않는다).
// facts 모드(대시보드 서버): 과거 이력을 RAM에 두지 않는다. 사건을 하나씩 적용해 카드·업무마다 크기가 정해진 사실만 들고
// (card-list-facts, work-list-facts), 상세에서만 최근 revision까지 SQL로 다시 읽는다(dashboard-card-history).
// 한도를 넘거나 한도 때문에 지금 필요한 값을 잃은 카드(needsHistory)만 이력 전체를 보관해 출력이 같게 한다.
// 기본 모드는 옛 동작 그대로 모든 이력을 보관한다(시험·옛 호출자).
// 운영 대시보드는 본문 요약 모드로 지문·짧은 발췌만 보관한다. 원문은 선택한 상세에서 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {CardStore} from './card-store.mjs';
import {databaseIdentity, storageMode, transaction} from './storage.mjs';
import {summarizeCardBody} from './dashboard-card-body.mjs';
import {advanceListFacts} from './card-list-facts.mjs';
import {advanceWorkFacts} from './work-list-facts.mjs';

export function createDashboardStoreReader(home, kind, {summaryBodies = false, facts: factsMode = false} = {}) {
  const cards = new CardStore(home), pattern = `${kind}/*/*/events.jsonl`;
  const failure = () => new Error(kind === 'cards' ? '카드 이력 손상' : '업무 이력 손상');
  let identity = null, cached = new Map(), bodies = new Map();
  const stats = {rows: 0, bodies: 0, reloaded: 0};
  const needsHistory = state => factsMode && kind === 'cards' && state.facts?.needsHistory;

  // 사건 하나를 상태에 적용한다. 순번·형식 검사는 호출한 쪽이 이미 했다.
  function apply(state, value) {
    if (factsMode) {
      state.facts = kind === 'cards'
        ? advanceListFacts(state.facts, state.last, value, Date.now(), {bounded: true})
        : advanceWorkFacts(state.facts, state.last, value);
    }
    state.last = value;
    state.seq = value.revision;
    state.history?.push(value);
  }
  // 스트림의 새 사건을 다 적용한 뒤: 이력을 계속 들지 않아도 되는 카드는 놓아 준다.
  function settle(state) {
    if (!factsMode) return;
    if (!needsHistory(state)) state.history = null;
  }
  // 이전에 이력을 놓은 카드가 한도를 넘어 이력이 필요해지면 그 스트림만 처음부터 다시 읽는다(읽기 snapshot 안).
  function reload(db, stream, seq) {
    const history = [];
    for (const row of db.prepare('SELECT seq,payload FROM events WHERE stream=? AND seq<=? ORDER BY seq').iterate(stream, seq)) {
      const value = JSON.parse(row.payload);
      if (row.seq !== history.length + 1 || value.revision !== row.seq) throw failure();
      history.push(value);
    }
    if (history.length !== seq) throw failure();
    stats.reloaded++;
    return history;
  }

  function read(db) {
    const currentIdentity = databaseIdentity(home);
    const heads = [];
    // heads만 읽어 지문을 만든다. 끝 행과 events의 대조는 처음·바뀐 스트림에만 한다(아래).
    for (const row of db.prepare('SELECT stream,seq,payload FROM heads WHERE stream GLOB ? ORDER BY stream')
      .iterate(pattern)) {
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
      // 처음 보거나 순번·지문이 달라진 스트림만 끝 행을 events와 대조한다(변경 없는 요청은 events를 건드리지 않는다).
      // 한계: 같은 순번·같은 head 지문인 채 과거 events만 고친 손상은 시작·파일 교체 때만 잡힌다.
      const mismatched = db.prepare(`SELECT count(*) AS n FROM json_each(?) c
        JOIN heads h ON h.stream=c.value LEFT JOIN events e ON e.stream=h.stream AND e.seq=h.seq
        WHERE coalesce(h.payload=e.payload,0)=0`).get(JSON.stringify(changed.map(h => h.stream)));
      if (mismatched.n) throw failure();
      const starts = changed.map(h => {
        const previous = cached.get(h.stream);
        // 같은 순번의 끝 행이 교체되어도 이전 검증 결과를 이어 쓰지 않는다.
        const seq = previous && previous.seq < h.seq ? previous.seq : 0;
        // 이어 쓰는 상태는 복사한다: 이미 낸 snapshot의 사실·이력을 바꾸지 않는다.
        next.set(h.stream, seq
          ? {seq, hash: null, facts: previous.facts, last: previous.last,
            history: previous.history ? [...previous.history] : (factsMode ? null : [])}
          : {seq: 0, hash: null, facts: null, last: null, history: []});
        return {stream: h.stream, seq};
      });
      const query = db.prepare(`SELECT e.stream,e.seq,e.payload FROM json_each(?) c
        JOIN events e ON e.stream=json_extract(c.value,'$.stream')
          AND e.seq>json_extract(c.value,'$.seq') ORDER BY e.stream,e.seq`);
      let current = null;
      for (const row of query.iterate(JSON.stringify(starts))) {
        const key = row.stream.slice(6, -13), value = JSON.parse(row.payload), state = next.get(row.stream);
        if (current && current !== state) settle(current);
        current = state;
        if (kind === 'cards') cards.dir(key);
        if (!/^[\p{L}\p{N}_-]+\/[\p{L}\p{N}_-]+$/u.test(key) || row.seq !== state.seq + 1
            || value.key !== key || value.revision !== row.seq
            || kind === 'works' && (!Array.isArray(value.executions) || !Array.isArray(value.mailRefs))) {
          throw failure();
        }
        apply(state, value);stats.rows++;
      }
      if (current) settle(current);
      for (const head of changed) {
        const state = next.get(head.stream);
        if (state.seq !== head.seq || !state.last) throw failure();
        state.hash = head.hash;
        // 이전에 이력을 놓았는데 이제 필요한 카드: 이 스트림만 처음부터 읽는다.
        if (needsHistory(state) && !state.history) state.history = reload(db, head.stream, head.seq);
      }
    }
    const nextBodies = new Map();
    const list = heads.map(head => {
      const state = next.get(head.stream), latest = state.last;
      const historyFields = state.history ? {history: state.history}
        : {...(kind === 'cards' ? {listFacts: state.facts} : {workFacts: state.facts}),
          historyRef: {stream: head.stream, revision: head.seq, hash: state.hash}};
      if (kind === 'works') return {...latest, ...historyFields};
      const dir = cards.dir(latest.key), file = path.join(dir, 'card.md'), stat = fs.statSync(file);
      const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      let body = bodies.get(file);
      if (!body || body.signature !== signature || summaryBodies &&
          (body.revision !== latest.revision || body.title !== latest.title)) {
        const text = fs.readFileSync(file, 'utf8');
        const previous = body?.signature === signature ? body : undefined;
        body = {signature, revision:latest.revision, title:latest.title,
          ...(summaryBodies ? {summary:summarizeCardBody(latest, text, previous)} : {text})};
        stats.bodies++;
      }
      nextBodies.set(file, body);
      return {...latest, ...historyFields, ...(summaryBodies ? {bodySummary:body.summary} : {body:body.text}), path: file,
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
