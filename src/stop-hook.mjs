// Stop 훅 본체 — claude(--settings)·codex(전역 hooks.json) 공용. 실행기가 턴을 마칠 때 stdin으로 JSON을 준다.
// 항상 종료 0이다(턴을 막지 않는다). KADAN_ROLE이 없거나 Stop이 아니면 아무것도 하지 않는다 — kyle 개인 실행기에는 영향이 없다.
// 마커 판정은 화면 판정과 같은 규칙(findDoneMarkers)이다. last_assistant_message 전체는 저장하지 않는다.
import {pathToFileURL} from 'node:url';
import {findDoneMarkers} from './done-marker.mjs';
import {appendSpool, spoolHome} from './stop-hook-spool.mjs';

// 입력 키로 실행기를 가른다(2026-10-18 실측): codex는 turn_id·model, claude는 prompt_id·effort가 있다.
export const harnessOfInput = input => 'turn_id' in input ? 'codex' : 'prompt_id' in input ? 'claude' : 'unknown';

export function handleStopHook(raw, env = process.env, now = () => new Date()) {
  const role = env.KADAN_ROLE;
  if (!role) return 0;
  let input;
  try { input = JSON.parse(raw); } catch { return 0; }
  if (!input || input.hook_event_name !== 'Stop' || typeof input.last_assistant_message !== 'string') return 0;
  const markers = findDoneMarkers(input.last_assistant_message);
  if (!markers.length) return 0;
  const harness = harnessOfInput(input), at = now().toISOString();
  for (const marker of markers) {
    appendSpool(spoolHome(env), {at, role, harness, sessionId: input.session_id ?? null,
      taskId: marker.taskId, result: marker.result});
  }
  return markers.length;
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
