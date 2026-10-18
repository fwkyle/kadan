// Stop 훅 본체 — claude(--settings)·codex(전역 hooks.json) 공용. 실행기가 턴을 마칠 때 stdin으로 JSON을 준다.
// 항상 종료 0이다(턴을 막지 않는다). KADAN_ROLE이 없거나 Stop이 아니면 아무것도 하지 않는다 — kyle 개인 실행기에는 영향이 없다.
// 마커 한 줄의 모양은 화면 판정과 같은 규칙(doneMarkerOf)이다. last_assistant_message 전체는 저장하지 않는다.
import {pathToFileURL} from 'node:url';
import {findDoneMarkers, doneMarkerOf} from './done-marker.mjs';
import {appendSpool, spoolHome} from './stop-hook-spool.mjs';

// 입력 키로 실행기를 가른다(2026-10-18 실측): codex는 turn_id·model, claude는 prompt_id·effort가 있다.
export const harnessOfInput = input => 'turn_id' in input ? 'codex' : 'prompt_id' in input ? 'claude' : 'unknown';

// 완료로 인정하는 것은 응답의 마지막 비어 있지 않은 줄이 마커일 때뿐이다(2026-10-18 검수: 응답 중간 인용이 완료로 읽혔다).
// 같은 응답에 같은 실행 ID의 다른 결과 마커가 더 있으면 conflict로 표시한다 — 소비처는 그 증거를 쓰지 않고 화면 판정으로 넘어간다.
export function lastLineMarker(message) {
  const lines = message.split('\n').map(line => line.trim()).filter(Boolean);
  const last = doneMarkerOf(lines.at(-1) ?? '');
  if (!last) return null;
  const conflict = findDoneMarkers(message).some(m => m.taskId === last.taskId && m.result !== last.result);
  return {...last, conflict};
}

export function handleStopHook(raw, env = process.env, now = () => new Date()) {
  const role = env.KADAN_ROLE;
  if (!role) return 0;
  let input;
  try { input = JSON.parse(raw); } catch { return 0; }
  if (!input || input.hook_event_name !== 'Stop' || typeof input.last_assistant_message !== 'string') return 0;
  const marker = lastLineMarker(input.last_assistant_message);
  if (!marker) return 0;
  appendSpool(spoolHome(env), {at: now().toISOString(), role, harness: harnessOfInput(input), sessionId: input.session_id ?? null,
    taskId: marker.taskId, result: marker.result, ...(marker.conflict ? {conflict: true} : {})});
  return 1;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { handleStopHook(await readStdin()); } catch { /* 훅 실패가 턴을 막지 않는다 */ }
  process.exit(0);
}
