// Why: 과거 중복 방지 키의 실제 크기를 관측해 막연한 메모리 누수 추측을 피한다.
// 10배 이력에서도 5분 기록마다 모음당 1,000개·256KiB까지만 잰다. JS 힙 크기는 아니다.
import {processCollectionInfo} from './process-collections.mjs';

export function collectionStats(collection) {
  const stored = processCollectionInfo(collection);
  if (!(collection instanceof Map) && !(collection instanceof Set) && !stored) return null;
  let sampledEntries = 0, serializedBytes = 0, truncated = false;
  for (const value of collection) {
    if (sampledEntries >= 1000 || serializedBytes >= 256 * 1024) break;
    let size;
    try { size = Buffer.byteLength(JSON.stringify(value) ?? 'null'); }
    catch { truncated = true; break; } // 계측 실패가 정상 주기 기록까지 막지 않게 한다.
    const remaining = 256 * 1024 - serializedBytes;
    serializedBytes += Math.min(size, remaining);
    if (size > remaining) truncated = true;
    sampledEntries++;
  }
  return {entries: collection.size, sampledEntries, serializedBytes,
    complete: !truncated && sampledEntries === collection.size,
    ...(stored ? {storage:stored.storage, retainedEntries:stored.retainedEntries} : {})};
}

export function watchResourceStats({mail, explain, restoredChecked, userPosts}) {
  return {
    mail: mail ? Object.fromEntries(['reserved', 'attempted', 'heldLogged', 'written', 'suppressed']
      .map(key => [key, collectionStats(mail[key])])) : null,
    explain: explain ? {
      handled: collectionStats(explain.handled), attempted: collectionStats(explain.attempted),
      queue: explain.queue?.info?.() ?? null, active: Boolean(explain.active),
      staleQueued: explain.staleQueued ?? 0,
    } : null,
    restoredChecked: collectionStats(restoredChecked), userPosts: collectionStats(userPosts),
  };
}

export function memoryMegabytes(memory) {
  return Object.fromEntries(['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']
    .filter(key => Number.isFinite(memory[key])).map(key => [key, memory[key] / 2 ** 20]));
}
