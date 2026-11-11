// Why: 실행 모델 설정 화면의 "최근 변경"(runner-settings 사건 최근 10건)을 읽으려고 원장 전체(공유 수집)를 기다리지 않는다.
// 처음 한 번은 흐름 끝에서부터 종류가 맞는 사건 10건만 찾고, 그 뒤에는 마지막으로 본 순번 뒤의 새 사건만 읽는다.
// 다른 프로세스(CLI `kadan runners set`)가 쓴 사건도 다음 호출에 보인다. 결과는 공유 수집의 entries에서 거른 것과 같은 객체(저장 순번 _ledgerOrder만 뺀 것)이다.
import {databaseIdentity, storageMode, storageSnapshot} from './storage.mjs';
import {ledgerStreams} from './ledger-domains.mjs';

const KEEP = 10;
const LEGACY = 'ledger.jsonl';
const KIND = 'runner-settings';
const needle = `"kind":"${KIND}"`;

function rows(db, stream, {after = null, limitNewest = false} = {}) {
  const tail = after === null ? '' : ' AND seq>?';
  const sql = `SELECT payload FROM events WHERE stream=?${tail} AND instr(payload,?)>0
    AND json_extract(payload,'$.kind')=? ORDER BY seq ${limitNewest ? 'DESC LIMIT ?' : ''}`;
  const args = [stream, ...(after === null ? [] : [after]), needle, KIND, ...(limitNewest ? [KEEP] : [])];
  const found = db.prepare(sql).all(...args).map(row => {
    const {_ledgerOrder, ...entry} = JSON.parse(row.payload);
    return entry;
  });
  return limitNewest ? found.reverse() : found;
}

// 반환 함수는 오래된 것부터 최대 10건(공유 수집의 entries와 같은 순서)을 돌려준다.
// 기억하는 값(state)은 같은 DB 파일 세대에서 읽은 식별값과 사건뿐이다: 읽기 전·후에 파일 식별값을 재서 다르면(읽는 도중 DB가 교체됨)
// 그 결과를 버리고 한 번 더 읽고, 또 다르면 오류로 끝낸다(src/ledger-incremental.mjs의 rebuild와 같은 방식).
export function createRunnerSettingsHistory(home) {
  let state = null;
  const readOnce = (identity) => storageSnapshot(home, db => {
    // 읽기 스냅샷 한 번 안에서 끝 순번과 사건을 함께 읽어, 그 사이 들어온 사건이 겹치거나 빠지지 않게 한다.
    const head = db.prepare('SELECT seq FROM heads WHERE stream=?').get(ledgerStreams.system)?.seq ?? 0;
    if (!state || state.identity !== identity || head < state.seq) {
      return {identity, seq: head, legacy: rows(db, LEGACY, {limitNewest: true}),
        system: rows(db, ledgerStreams.system, {limitNewest: true})};
    }
    if (head === state.seq) return state;
    return {...state, seq: head, system: [...state.system, ...rows(db, ledgerStreams.system, {after: state.seq})].slice(-KEEP)};
  });
  return () => {
    if (storageMode(home) === 'none') return [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const identity = databaseIdentity(home);
      const next = readOnce(identity);
      if (databaseIdentity(home) !== identity) continue;
      state = next;
      return [...state.legacy, ...state.system].slice(-KEEP);
    }
    state = null;
    throw new Error('원장 DB 파일이 읽는 도중 바뀜: 잠시 뒤 다시 시도');
  };
}
