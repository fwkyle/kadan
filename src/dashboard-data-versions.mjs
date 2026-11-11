// Why: 감시/우편 사건 때문에 바뀌지 않은 카드·업무 이력을 다시 읽지 않는다.
// 처음에는 heads의 카드·업무 흐름을 모두 읽어 (흐름 이름 → 순번)을 기억하고, 그 뒤에는 새 사건(rowid > 직전)이 가리킨 흐름만 다시 읽는다.
// 새 사건이 없으면 heads·events 줄을 읽지 않는다(마지막 사건 번호 한 줄만 확인한다). 돌려주는 세 문자열은 매번 전체를 읽던 때와 같다.
// 원장이 10배여도 변경 없는 호출은 마지막 사건 번호 확인과 카드 파일 stat뿐이고, 변경 있는 호출은 새 사건 수에 비례한다.
// (해시는 그 종류의 흐름이 바뀐 호출에서만 기억한 표로 다시 만든다. 그 비용은 카드·업무 수에 비례하고 DB는 읽지 않는다.)
import path from 'node:path';
import {createHash} from 'node:crypto';
import {databaseIdentity, storageMode, storageSnapshot} from './storage.mjs';
import {cardFilesFingerprint, DERIVED_MAX_AGE_MS} from './wall-snapshot-cache.mjs';

const KINDS = ['cards', 'works'];
const pattern = kind => `${kind}/*/events.jsonl`;

// 전체 읽기의 `ORDER BY stream`(UTF-8 바이트 순)과 같은 순서·같은 입력으로 해시를 다시 만든다.
// JS 기본 정렬은 UTF-16 단위 순이라 보충 평면 글자가 섞이면 순서가 달라진다.
function digest(streams) {
  const rows = [...streams].map(([stream, seq]) => ({stream, seq, bytes: Buffer.from(stream)}));
  rows.sort((a, b) => Buffer.compare(a.bytes, b.bytes));
  const hash = createHash('sha256');
  for (const {stream, seq} of rows) hash.update(JSON.stringify({stream, seq}));
  return hash.digest('hex');
}

export function createDashboardDataVersions(home, {now = () => Date.now()} = {}) {
  // identity: DB 파일 식별값, rowid: 반영한 마지막 사건 번호, streams: 종류별 Map(흐름 이름 → 순번),
  // digests: 종류별 해시, fullAt: 마지막 전체 읽기 시각.
  let state = null;
  // heads: heads에서 읽은 줄, events: 새 사건을 찾으며 events에서 읽은 줄, full: 전체 읽기 횟수.
  // 마지막 사건 번호 확인(max(rowid))은 세지 않는다. 응답에는 싣지 않는다.
  const stats = {heads: 0, events: 0, full: 0};

  function readAll(db, identity, rowid) {
    const streams = {}, digests = {};
    // GLOB의 고정 접두어는 heads의 stream 기본키 범위로 조회한다. 본문/이력은 읽지 않는다.
    const query = db.prepare('SELECT stream,seq FROM heads WHERE stream GLOB ? ORDER BY stream');
    for (const kind of KINDS) {
      const hash = createHash('sha256'), map = streams[kind] = new Map();
      for (const row of query.iterate(pattern(kind))) {
        hash.update(JSON.stringify(row));map.set(row.stream, row.seq);stats.heads++;
      }
      digests[kind] = hash.digest('hex');
    }
    stats.full++;
    return {identity, rowid, streams, digests, fullAt: now()};
  }

  // 새 사건이 가리킨 흐름만 heads에서 다시 읽는다. 기억한 값과 어긋나면(순번이 줄어듦) null을 돌려 전체 읽기로 보낸다.
  function advance(db, rowid) {
    const names = new Set();
    for (const row of db.prepare('SELECT stream FROM events WHERE rowid>?').iterate(state.rowid)) {
      stats.events++;names.add(row.stream);
    }
    const streams = {...state.streams}, digests = {...state.digests};
    // 카드·업무 흐름인지는 전체 읽기와 같은 GLOB이 정한다. JS 쪽 검사는 조회할 후보를 줄이는 용도다.
    const query = db.prepare(`SELECT h.stream,h.seq FROM json_each(?) c JOIN heads h ON h.stream=c.value
      WHERE h.stream GLOB ?`);
    for (const kind of KINDS) {
      const candidates = [...names].filter(s => s.startsWith(`${kind}/`) && s.endsWith('/events.jsonl'));
      if (!candidates.length) continue;
      const rows = query.all(JSON.stringify(candidates), pattern(kind));
      stats.heads += rows.length;
      if (!rows.length) continue;
      // 기억한 표를 복사해 고친다: 식별값 확인이 끝나기 전에는 상태를 바꾸지 않는다.
      const map = streams[kind] = new Map(state.streams[kind]);
      for (const row of rows) {
        if (row.seq < (map.get(row.stream) ?? 0)) return null;
        map.set(row.stream, row.seq);
      }
      digests[kind] = digest(map);
    }
    return {...state, rowid, streams, digests};
  }

  return {
    read() {
      if (storageMode(home) === 'none') {state = null;return {all: null, cards: null, works: null};}
      try {
        return storageSnapshot(home, db => {
          const fileIdentity = databaseIdentity(home);
          const rowid = db.prepare('SELECT max(rowid) AS v FROM events').get().v ?? 0;
          let next = null;
          // 같은 DB 파일이고 사건 번호가 뒤로 가지 않았고 마지막 전체 읽기가 10분 안일 때만 이어 읽는다.
          if (state && state.identity === fileIdentity && rowid >= state.rowid
              && now() - state.fullAt < DERIVED_MAX_AGE_MS) {
            next = rowid === state.rowid ? state : advance(db, rowid);
          }
          next ??= readAll(db, fileIdentity, rowid);
          const files = cardFilesFingerprint(home);
          // 읽는 도중 파일이 교체됐으면 옛 자료에 새 식별값이 붙는다. 기억하지 않고 오류로 끝내 다음 호출이 전체를 읽게 한다.
          // (수집은 바깥 읽기 연결 안에서 돌아 같은 연결로 다시 읽어도 옛 파일이다. 그래서 여기서 재시도하지 않는다.)
          if (databaseIdentity(home) !== fileIdentity) throw new Error('조회 중 저장소 파일 교체: 다시 읽어야 합니다');
          state = next;
          const identity = `${path.resolve(home)}|${fileIdentity}`;
          return {all: `${identity}|${rowid}|${files}`,
            cards: `${identity}|${next.digests.cards}|${files}`,
            works: `${identity}|${next.digests.works}`};
        });
      } catch (error) {state = null;throw error;}
    },
    info: () => ({...stats, streams: state ? state.streams.cards.size + state.streams.works.size : 0}),
  };
}

// 프로세스가 보는 홈은 하나라 판독기도 하나만 둔다(홈이 바뀌면 새로 만든다).
let shared = null;
export function dashboardDataVersions(home) {
  if (shared?.home !== home) shared = {home, reader: createDashboardDataVersions(home)};
  return shared.reader.read();
}
// 시험·측정이 읽은 줄 수를 확인하는 값. 아직 읽은 적이 없으면 null.
export const dashboardDataVersionsInfo = () => shared?.reader.info() ?? null;
