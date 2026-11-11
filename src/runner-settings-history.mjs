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
export function createRunnerSettingsHistory(home) {
  let state = null;
  return () => {
    if (storageMode(home) === 'none') return [];
    // 읽기 스냅샷 한 번 안에서 끝 순번과 사건을 함께 읽어, 그 사이 들어온 사건이 겹치거나 빠지지 않게 한다.
    return storageSnapshot(home, db => {
      const identity = databaseIdentity(home);
      const head = db.prepare('SELECT seq FROM heads WHERE stream=?').get(ledgerStreams.system)?.seq ?? 0;
      if (!state || state.identity !== identity || head < state.seq) {
        state = {identity, seq: head, legacy: rows(db, LEGACY, {limitNewest: true}),
          system: rows(db, ledgerStreams.system, {limitNewest: true})};
      } else if (head > state.seq) {
        state.system = [...state.system, ...rows(db, ledgerStreams.system, {after: state.seq})].slice(-KEEP);
        state.seq = head;
      }
      return [...state.legacy, ...state.system].slice(-KEEP);
    });
  };
}
