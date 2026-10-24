// Why: 감시의 미확인 알림 후보를 현재 우편 상태표에서 읽고 같은 원장 수집과 연결한다.
// 10배 과거에도 후보 보관은 현재 미확인 수에 비례한다. 원장 배열/재알림 이력 순회는 아직 남는다.
import {withMailboxView, mailReminderCandidates} from './mail-view.mjs';

export function createWatchMailReader(home, readEntries) {
  const snapshots = new WeakMap();
  let last = null;
  return {
    readEntries() {
      // 조회 DB 잠금 다음 원본 snapshot. 실제 전송/OS 조회 전에 두 트랜잭션을 닫는다.
      const value = withMailboxView(home, (store, info) => {
        const key = JSON.stringify([info.mailGeneration, info.mailStateVersion, info.mailCount]);
        return {raw:readEntries(), key,
          letters:last?.key === key ? last.letters : mailReminderCandidates(store)};
      });
      // commit 실패 때는 이전 정상 후보로 대체하지 않는다.
      if (last?.raw === value.raw && last.key === value.key) return last.entries;
      // 사건 없이 사용자 이름 설정만 달라져도 이미 내준 수집의 후보를 바꾸지 않는다.
      const entries = snapshots.has(value.raw) ? value.raw.slice() : value.raw;
      snapshots.set(entries, value.letters);
      last = {...value, entries};
      return entries;
    },
    letters(entries) {
      const value = snapshots.get(entries);
      if (!value) throw new Error('감시 우편과 원장 수집 버전이 다릅니다');
      return value;
    },
  };
}
