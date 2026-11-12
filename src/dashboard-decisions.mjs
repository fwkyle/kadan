// 대시보드가 읽는 결정 기록(decisions/events.jsonl) 판독기.
// 수집마다 두 번, 요청마다 한 번 흐름 전체를 다시 읽던 것을, 흐름이 바뀌었을 때만 읽게 한다.
// 기억은 나이로 재사용하지 않는다. 호출마다 DB 파일 식별값과 그 흐름의 머리 줄(마지막 순번·마지막 줄 원문)을
// 확인해 직전과 같을 때만 기억한 줄을 돌려준다. 결정이 추가·답변·취소되면 머리 줄이 바뀌어 바로 다시 읽는다.
// 사건 추가 없이 줄이 바뀐 경우(날 SQL·같은 파일 덮어쓰기)는 10분마다(DERIVED_MAX_AGE_MS)의 전체 읽기가 잡는다.
// 읽기 실패·읽는 도중 DB 파일 교체는 기억을 버리고 오류로 끝낸다(다시 시도하지 않는다. dashboard-data-versions.mjs와 같은 규칙).
// 결정을 쓰는 길(DecisionStore의 요청·답변·취소)은 이 판독기를 쓰지 않고 늘 DB를 읽는다.
// 결정 수가 10배여도 변경 없는 호출은 머리 줄 한 줄만 읽는다. 바뀐 호출은 지금처럼 흐름 전체(결정 줄 수)를 읽는다.
import {databaseIdentity, readStream, storageMode, storageSnapshot} from './storage.mjs';
import {DERIVED_MAX_AGE_MS} from './wall-snapshot-cache.mjs';

const STREAM = 'decisions/events.jsonl';
// 기억한 줄은 여러 호출이 함께 본다. 호출부가 고쳐 쓰면 바로 드러나게 얼린다.
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

export function createDashboardDecisionsReader(home, {now = () => Date.now()} = {}) {
  // identity: DB 파일 식별값, seq·payload: 흐름 머리 줄(흐름이 없으면 null), rows: 흐름의 모든 줄, fullAt: 읽은 시각.
  let state = null;
  // rows: events에서 읽은 결정 줄 수, full: 흐름 전체를 읽은 횟수. 머리 줄 확인은 세지 않는다. 응답에는 싣지 않는다.
  const stats = {rows: 0, full: 0};

  return {
    read() {
      try {
        // 저장소가 없으면 기억하지 않고 지금처럼 빈 목록을 돌려준다.
        if (storageMode(home) === 'none') {state = null;return readStream(home, STREAM, {optional: true});}
        return storageSnapshot(home, db => {
          const identity = databaseIdentity(home);
          const head = db.prepare('SELECT seq,payload FROM heads WHERE stream=?').get(STREAM);
          const seq = head?.seq ?? null, payload = head?.payload ?? null;
          let next = state;
          if (!state || state.identity !== identity || state.seq !== seq || state.payload !== payload
              || now() - state.fullAt >= DERIVED_MAX_AGE_MS) {
            const rows = readStream(home, STREAM, {optional: true});
            stats.rows += rows.length;stats.full++;
            next = {identity, seq, payload, rows: freeze(rows), fullAt: now()};
          }
          // 읽는 도중 파일이 교체됐으면 옛 줄에 새 식별값이 붙는다. 기억하지 않고 오류로 끝내 다음 호출이 전체를 읽게 한다.
          if (databaseIdentity(home) !== identity) throw new Error('조회 중 저장소 파일 교체: 다시 읽어야 합니다');
          state = next;
          return next.rows;
        });
      } catch (error) {state = null;throw error;}
    },
    info: () => ({...stats, cached: state ? state.rows.length : 0}),
  };
}

// 프로세스가 보는 홈은 하나라 판독기도 하나만 둔다(홈이 바뀌면 새로 만든다).
let shared = null;
// 결정 흐름의 모든 줄(저장 순서). 돌려준 배열과 줄은 얼려 있다. 바뀌지 않았으면 직전과 같은 배열이다.
export function dashboardDecisionRows(home) {
  if (shared?.home !== home) shared = {home, reader: createDashboardDecisionsReader(home)};
  return shared.reader.read();
}
// 시험·측정이 읽은 줄 수를 확인하는 값. 아직 읽은 적이 없으면 null.
export const dashboardDecisionsInfo = () => shared?.reader.info() ?? null;
