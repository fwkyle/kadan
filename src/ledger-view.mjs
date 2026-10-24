// Why: 첫 페이지를 읽기 위해 전체 과거 사건을 JS 배열로 보관하지 않는다.
// 10배 이력: 최초 재생만 N에 비례한다. 이후 적용은 새 사건, 조회는 SQL 조건/커서 범위다.
import {createHash} from 'node:crypto';
import path from 'node:path';
import {storageMode, storageSnapshot, databaseIdentity} from './storage.mjs';
import {ledgerStreams, createDomainValidator, domainProjector, legacyCorrupt,
  validateDomainEvent} from './ledger-domains.mjs';
import {isMailTransfer} from './mail-routing.mjs';
import {openLedgerView, resetLedgerView, storedValidatorState, storeSourceRow,
  metaGet, metaSet, viewDomains} from './ledger-view-store.mjs';
import {storeLedgerFilters} from './ledger-view-filters.mjs';

const LEGACY = 'ledger.jsonl';
const streams = [LEGACY, ...Object.values(ledgerStreams)];
const sha = value => createHash('sha256').update(value).digest('hex');
const BATCH_SIZE = 256;
const projectors = new Map(viewDomains.map(domain => [domain, domainProjector(domain)]));
const verified = new Map();

function headsOf(db) {
  return new Map(db.prepare(`SELECT stream,seq,payload FROM heads
    WHERE stream IN (?,?,?,?)`).all(...streams).map(row => [row.stream, row]));
}

function cacheStamp(cache) {
  return sha(JSON.stringify([
    cache.prepare("SELECT key,value FROM meta WHERE key<>'signature' ORDER BY key").all(),
    cache.prepare('SELECT * FROM cursors ORDER BY stream').all(),
    cache.prepare('SELECT * FROM last_orders ORDER BY key').all(),
    cache.prepare('SELECT max(position) AS position FROM source_rows').get(),
  ]));
}

function verifyPrefixes(source, cursors) {
  const query = source.prepare('SELECT seq,payload FROM events WHERE stream=? AND seq<=? ORDER BY seq');
  for (const stream of streams) {
    const cursor = cursors.get(stream);
    let hash = sha(''), last = 0;
    for (const row of query.iterate(stream, cursor.seq)) {
      hash = sha(hash + '\n' + row.payload);last = row.seq;
    }
    if (last !== cursor.seq || hash !== cursor.prefix_hash) return false;
  }
  return true;
}

function validCachedCounts(cache) {
  if (cache.prepare('SELECT count(*) AS n FROM source_rows').get().n !== Number(metaGet(cache, 'position'))) {
    return false;
  }
  const expected = JSON.parse(metaGet(cache, 'counts') ?? '{}');
  const counts = new Map(cache.prepare(`SELECT domain,count(*) AS total,sum(routine=0) AS visible
    FROM views GROUP BY domain`).all().map(row => [row.domain, row]));
  return viewDomains.every(domain => {
    const actual = counts.get(domain ?? ''), saved = expected[domain ?? ''];
    return (actual?.total ?? 0) === (saved?.total ?? 0) && (actual?.visible ?? 0) === (saved?.visible ?? 0);
  });
}

function needsRebuild(source, cache, identity, heads, cold) {
  if (metaGet(cache, 'identity') !== identity) return true;
  if (metaGet(cache, 'signature') !== cacheStamp(cache)) return true;
  const cursors = new Map(cache.prepare('SELECT * FROM cursors').all().map(row => [row.stream, row]));
  if (cursors.size !== streams.length) return true;
  for (const stream of streams) {
    const cursor = cursors.get(stream), head = heads.get(stream), seq = head?.seq ?? 0;
    if (!cursor || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) throw new Error('조회 캐시 위치 손상');
    if (seq < cursor.seq || stream === LEGACY && seq !== cursor.seq) return true;
    if (!cursor.seq) continue;
    const payload = seq === cursor.seq ? head.payload : source.prepare(
      'SELECT payload FROM events WHERE stream=? AND seq=?',
    ).get(stream, cursor.seq)?.payload;
    if (!payload || sha(payload) !== cursor.hash) return true;
  }
  // 프로세스 첫 조회에는 저장된 prefix 전체를 대조한다. 정상 반복에서는 끝 지문과 새 사건만 본다.
  return cold && (!validCachedCounts(cache) || !verifyPrefixes(source, cursors));
}

function* readRows(db, stream, after, prefixes) {
  // 큰 감시 관계표는 기존 readLedgerState와 똑같이 SQL에서 제외한다.
  const payload = stream === ledgerStreams.system
    ? `CASE WHEN json_extract(payload,'$.kind')='watch-ai-request'
      THEN json_remove(payload,'$.parents','$.routes') ELSE payload END` : 'payload';
  for (const row of db.prepare(`SELECT seq,payload AS raw,${payload} AS payload FROM events
    WHERE stream=? AND seq>? ORDER BY seq`).iterate(stream, after)) {
    prefixes.set(stream, sha(prefixes.get(stream) + '\n' + row.raw));
    const value = JSON.parse(row.payload);
    if (stream !== LEGACY) validateDomainEvent(stream, value);
    yield {stream, seq:row.seq, value};
  }
}

function* domainBatches(source, cursors, prefixes) {
  const readers = Object.values(ledgerStreams).map(stream =>
    readRows(source, stream, cursors.get(stream) ?? 0, prefixes));
  try {
    const next = readers.map(reader => reader.next());
    let batch = [], completionNext = false;
    while (next.some(row => !row.done)) {
      const orders = next.filter(row => !row.done).map(row => row.value.value?._ledgerOrder);
      if (orders.some(order => !Number.isSafeInteger(order) || order < 1)) throw new Error('도메인 원장 순번 손상');
      const order = Math.min(...orders), group = [];
      for (let i = 0; i < readers.length; i++) {
        while (!next[i].done && next[i].value.value?._ledgerOrder === order) {
          group.push(next[i].value);
          if (group.length > 2) throw new Error('도메인 원장 순번 중복');
          next[i] = readers[i].next();
        }
      }
      if (completionNext && (group.length !== 1 || group[0].value.kind !== 'send' ||
        group[0].value.systemGenerated !== 'task-completion')) {
        throw new Error('도메인 원장 완료 우편 연결 손상');
      }
      batch.push(...group);
      completionNext = group.some(row => row.value?.kind === 'done' && row.value.completionMailId);
      // send/dispatch는 같은 order 전체, done은 뒤의 완료 우편까지 함께 검증한다.
      if (batch.length >= BATCH_SIZE && !completionNext) {yield batch;batch = [];}
    }
    if (batch.length) yield batch;
  } finally {
    for (const reader of readers) reader.return();
  }
}

function mailboxIntegrity(cache, state, value, legacy) {
  if (legacy && legacyCorrupt([value])) metaSet(cache, 'legacyBad', 1);
  if (legacy && (value == null || value.broken)) metaSet(cache, 'mailboxError', '원장 확인 불가 · 우편 상태 모름');
  if (legacy && value?.kind === 'send' && value.mailId && state.mailIds.has(value.mailId)) {
    metaSet(cache, 'mailboxError', '우편 원장 중복 mailId');
  }
  if (!isMailTransfer(value)) return;
  const {from, to} = value;
  if (typeof from !== 'string' || !from.trim() || typeof to !== 'string' || !to.trim() || from === to) {
    metaSet(cache, 'mailboxError', '우편 인계 역할 손상');return;
  }
  const key = state.key(value.handoverId || JSON.stringify([from, to]));
  const previous = cache.prepare('SELECT source,target FROM transfers WHERE key=?').get(key);
  if (previous && (previous.source !== from || previous.target !== to)) {
    metaSet(cache, 'mailboxError', '우편 인계 책임 충돌');return;
  }
  cache.prepare('INSERT OR IGNORE INTO transfers VALUES(?,?,?)').run(key, from, to);
}

function projectRow(state, counts, value, position, legacy) {
  const {routine} = storeLedgerFilters(state, value, position);
  for (const domain of viewDomains) {
    const projector = projectors.get(domain);
    const rows = legacy ? projector.legacy([value]) : projector.rows([value]);
    if (!rows.length) continue;
    const entry = rows[0], key = domain ?? '';
    if (entry?.kind === 'done' && entry.role && entry.taskId) {
      const done = JSON.stringify([entry.role, entry.taskId, entry.executionKey || '']);
      if (!state.prepare('INSERT OR IGNORE INTO done_seen VALUES(?,?)').run(key, done).changes) continue;
    }
    state.prepare('INSERT INTO views VALUES(?,?,?)').run(key, position, routine);
    counts[key] ??= {total:0, visible:0};
    counts[key].total++;
    if (!routine) counts[key].visible++;
  }
}

function applySource(source, cache, identity, cold) {
  const heads = headsOf(source), rebuilt = needsRebuild(source, cache, identity, heads, cold);
  if (rebuilt) resetLedgerView(cache, identity);
  const cursors = new Map(cache.prepare('SELECT stream,seq FROM cursors').all().map(row => [row.stream, row.seq]));
  const prefixes = new Map(cache.prepare('SELECT stream,prefix_hash FROM cursors').all()
    .map(row => [row.stream, row.prefix_hash]));
  for (const stream of streams) if (!prefixes.has(stream)) prefixes.set(stream, sha(''));
  const state = storedValidatorState(cache), validator = createDomainValidator([], state);
  const counts = JSON.parse(metaGet(cache, 'counts') ?? '{}');
  let position = Number(metaGet(cache, 'position')), applied = 0;
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(validator.expected) ||
    validator.expected < 1) throw new Error('조회 캐시 검증 위치 손상');
  for (const row of readRows(source, LEGACY, cursors.get(LEGACY) ?? 0, prefixes)) {
    storeSourceRow(cache, state, ++position, row);
    mailboxIntegrity(cache, state, row.value, true);
    validator.addLegacy([row.value]);
    projectRow(state, counts, row.value, position, true);
    state.clearObjects();applied++;
  }
  for (const batch of domainBatches(source, cursors, prefixes)) {
    const fresh = new Map(Object.values(ledgerStreams).map(stream => [stream, []]));
    for (const row of batch) {
      storeSourceRow(cache, state, ++position, row);
      fresh.get(row.stream).push(row.value);
      mailboxIntegrity(cache, state, row.value, false);
      projectRow(state, counts, row.value, position, false);
    }
    validator.add(fresh);
    state.clearObjects();applied += batch.length;
  }
  if (applied || rebuilt) {
    for (const stream of streams) {
      const head = heads.get(stream);
      cache.prepare(`INSERT INTO cursors VALUES(?,?,?,?) ON CONFLICT(stream)
        DO UPDATE SET seq=excluded.seq,hash=excluded.hash,prefix_hash=excluded.prefix_hash`)
        .run(stream, head?.seq ?? 0, head ? sha(head.payload) : null, prefixes.get(stream));
    }
    metaSet(cache, 'expected', validator.expected);
    metaSet(cache, 'position', position);
    metaSet(cache, 'counts', JSON.stringify(counts));
    metaSet(cache, 'signature', cacheStamp(cache));
  }
  return {generation:metaGet(cache, 'generation'), position, applied, rebuilt};
}

export function withLedgerView(home, read) {
  if (storageMode(home) === 'none') return read(null, {generation:null, position:0, applied:0, rebuilt:false});
  const cache = openLedgerView(home);
  try {
    // 캐시 쓰기 잠금을 얻은 뒤 원본 snapshot을 연다. 오래된 reader가 새 cursor를 되감지 않게 한다.
    const identity = databaseIdentity(home);
    const key = path.resolve(home), stamp = generation => JSON.stringify([identity, generation]);
    let applied;
    const result = storageSnapshot(home, source => {
      const info = applySource(source, cache, identity,
        verified.get(key) !== stamp(metaGet(cache, 'generation')));
      applied = info;
      return read(cache, info, source);
    });
    if (databaseIdentity(home) !== identity) throw new Error('원장 DB 파일이 읽는 도중 바뀜');
    cache.exec('COMMIT');
    verified.delete(key);verified.set(key, stamp(applied.generation));
    while (verified.size > 8) verified.delete(verified.keys().next().value);
    return result;
  } catch (error) {
    if (cache.isTransaction) cache.exec('ROLLBACK');
    throw error;
  } finally {cache.close();}
}

export function sourceViewValues(source, rows) {
  const plain = source.prepare('SELECT payload FROM events WHERE stream=? AND seq=?');
  const slim = source.prepare(`SELECT CASE WHEN json_extract(payload,'$.kind')='watch-ai-request'
    THEN json_remove(payload,'$.parents','$.routes') ELSE payload END AS payload
    FROM events WHERE stream=? AND seq=?`);
  return rows.map(row => {
    const query = row.stream === ledgerStreams.system ? slim : plain;
    const event = query.get(row.stream, row.seq);
    if (!event) throw new Error('원장 조회 위치의 사건을 찾을 수 없습니다');
    return JSON.parse(event.payload);
  });
}

export function readLedgerViewPage(home, {domain = null, before = null, limit = 50} = {}) {
  if (!viewDomains.includes(domain)) throw new Error('지원하지 않는 원장 영역');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('조회 개수는 1~200이어야 합니다');
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new Error('조회 위치 확인 필요');
  return withLedgerView(home, (db, info, source) => {
    if (!db) return {...info, items:[], next:null, total:0};
    if (domain && metaGet(db, 'legacyBad')) throw new Error('과거 원장 손상: 도메인 조회 불가');
    if (domain === 'mailbox' && metaGet(db, 'mailboxError')) throw new Error(metaGet(db, 'mailboxError'));
    const rows = db.prepare(`SELECT r.stream,r.seq,v.position FROM views v JOIN source_rows r USING(position)
      WHERE v.domain=? AND v.position<? ORDER BY v.position DESC LIMIT ?`)
      .all(domain ?? '', before ?? info.position + 1, limit + 1);
    const page = rows.slice(0, limit), project = projectors.get(domain);
    return {...info, items:sourceViewValues(source, page).map((value, index) => {
      const row = page[index];
      return (row.stream === LEGACY ? project.legacy([value]) : project.rows([value]))[0];
    }), next:rows.length > limit ? page.at(-1).position : null,
    total:JSON.parse(metaGet(db, 'counts') ?? '{}')[domain ?? '']?.total ?? 0};
  });
}
