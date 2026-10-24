// Why: 감시/우편 사건 때문에 바뀌지 않은 카드·업무 이력을 다시 읽지 않는다.
// 전체 이력이 10배여도 버전 조회는 현재 스트림 heads만 본다(카드/업무 수에는 비례).
import path from 'node:path';
import {createHash} from 'node:crypto';
import {databaseIdentity, storageMode, storageSnapshot, storageVersion} from './storage.mjs';
import {cardFilesFingerprint} from './wall-snapshot-cache.mjs';

export function dashboardDataVersions(home) {
  if (storageMode(home) === 'none') return {all: null, cards: null, works: null};
  return storageSnapshot(home, db => {
    const identity = `${path.resolve(home)}|${databaseIdentity(home)}`;
    const hashes = {cards: createHash('sha256'), works: createHash('sha256')};
    // GLOB의 고정 접두어는 heads의 stream 기본키 범위로 조회한다. 본문/이력은 읽지 않는다.
    const query = db.prepare('SELECT stream,seq FROM heads WHERE stream GLOB ? ORDER BY stream');
    for (const kind of ['cards', 'works']) {
      for (const row of query.iterate(`${kind}/*/events.jsonl`)) hashes[kind].update(JSON.stringify(row));
    }
    const files = cardFilesFingerprint(home);
    return {all: `${identity}|${storageVersion(home)}|${files}`,
      cards: `${identity}|${hashes.cards.digest('hex')}|${files}`,
      works: `${identity}|${hashes.works.digest('hex')}`};
  });
}
