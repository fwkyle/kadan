// 화면의 완료 마커 한 줄을 읽는 공통 규칙. 여러 곳에 따로 두면 서로 달라진다(2026-09-27 [kyle]: 6곳 중 일부만 고쳐져 재출력 요청이 반복됐다).
// codex는 '• ', claude는 '⏺ '를 응답 첫 줄 앞에 붙인다. 입력 되풀이는 '›'·'❯'로 시작해 여기 걸리지 않는다.
export const DONE_LINE = /^\s*(?:[•⏺]\s+)?KADAN:DONE\s+(\S+)\s+(ok|failed)\s*$/u;

export function doneMarkerOf(line) {
  const match = String(line ?? '').match(DONE_LINE);
  return match ? {taskId: match[1], result: match[2]} : null;
}

export function findDoneMarkers(text) {
  const found = [];
  for (const line of text.split("\n")) {
    const marker = doneMarkerOf(line);
    if (marker) found.push(marker);
  }
  return found;
}

export function diffDoneMarkers(baselineMarkers, currentMarkers, keyOf = JSON.stringify) {
  const counts = new Map();
  for (const marker of baselineMarkers) {
    const key = keyOf(marker);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const fresh = [];
  for (const marker of currentMarkers) {
    const key = keyOf(marker);
    const count = counts.get(key) || 0;
    if (count > 0) counts.set(key, count - 1);
    else fresh.push(marker);
  }
  return fresh;
}
