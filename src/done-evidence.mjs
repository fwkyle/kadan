// '그 발령 이후, 그 카드의 DONE 증거가 있는가'를 가리는 공용 판정. 감시기 완료 판정(watch-roles)과
// 시작보고 누락 경보(watch-start-report)가 함께 쓴다. 따로 두면 서로 달라진다(같은 개념 감사 4행).
import { findDoneMarkers, diffDoneMarkers } from "./done-marker.mjs";
import { hookDoneSince } from "./stop-hook-spool.mjs";
import { ledgerHome } from "./ledger.mjs";

// dispatches: Map(카드 키 -> 발령 send 기록). 발령마다 t(전달 시각)·baselineMarkers·confirmedResult를 본다.
// taskKey(id): 마커의 카드 id를 dispatches 키로 푼다. 풀지 못하면 null.
// home: 훅 증거 폴더. 비우면 원장 홈이며, 발령이 있을 때만 읽는다.
// unscoped: 카드 조회를 쓰지 않는 옛 호출은 발령 없는 화면의 마지막 마커도 후보로 본다.
export function doneEvidence({ dispatches, screen, home, role, taskKey, unscoped = false, hookRows }) {
  const markers = findDoneMarkers(screen ?? ""), fresh = new Set();
  for (const [key, dispatch] of dispatches) {
    const newer = diffDoneMarkers(dispatch.baselineMarkers ?? [], markers,
      marker => JSON.stringify([taskKey(marker.taskId), marker.result]));
    for (const marker of newer) {
      if (taskKey(marker.taskId) === key && marker.result !== dispatch.confirmedResult) fresh.add(marker);
    }
  }
  // 빠른 길: 실행기가 턴을 마칠 때 훅이 남긴 증거가 발령 뒤에 있으면 화면 대신 그것을 쓴다. 없으면 화면 판정이다.
  // 증거는 같은 역할·같은 카드·그 발령(send) 뒤 시각이어야 한다.
  let hookMarker = null;
  for (const [key, dispatch] of dispatches) {
    const found = hookDoneSince({home: home ?? ledgerHome(), role, since: dispatch.t,
      taskMatches: id => taskKey(id) === key, rows: hookRows}).at(-1);
    if (found && found.result !== dispatch.confirmedResult &&
        (!hookMarker || Date.parse(found.at) > Date.parse(hookMarker.at))) hookMarker = found;
  }
  const screenMarker = unscoped && dispatches.size === 0 ? markers.at(-1) : markers.findLast(marker => fresh.has(marker));
  const marker = hookMarker ? { taskId: hookMarker.taskId, result: hookMarker.result } : screenMarker;
  return { marker: marker ?? null, source: marker ? (hookMarker ? "hook" : "screen") : null };
}
