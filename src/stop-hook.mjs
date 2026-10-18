// Stop 훅 본체 — claude(--settings)·codex(전역 hooks.json) 공용. 실행기가 턴을 마칠 때 stdin으로 JSON을 준다.
// 항상 종료 0이다(턴을 막지 않는다). KADAN_ROLE이 없거나 Stop이 아니면 아무것도 하지 않는다 — kyle 개인 실행기에는 영향이 없다.
// 마커 한 줄의 모양은 화면 판정과 같은 규칙(doneMarkerOf)이다. last_assistant_message 전체는 저장하지 않는다.
import {pathToFileURL} from 'node:url';
import {findDoneMarkers, doneMarkerOf} from './done-marker.mjs';
import {appendSpool, spoolHome} from './stop-hook-spool.mjs';

// 입력 키로 실행기를 가른다(2026-10-18 실측): codex는 turn_id·model, claude는 prompt_id·effort가 있다.
export const harnessOfInput = input => 'turn_id' in input ? 'codex' : 'prompt_id' in input ? 'claude' : 'unknown';

// 같은 실행일 수 있는가: ID 끝 조각이 같고, 저장소 접두가 한쪽에 없거나 같을 때. 훅은 현재 실행을 모르므로 넓게(보수적으로) 본다 —
// 소비처(hookTaskMatcher)가 현재 실행 기준으로 최종 판정한다. 다른 저장소의 같은 조각(a/x, b/x)은 섞지 않는다.
// 더 단순한 대안(끝 조각만 비교)은 서로 다른 저장소 카드끼리 상충으로 몰아 훅 빠른 길을 불필요하게 막는다.
export function mayBeSameRun(a, b) {
  const [ta, tb] = [String(a).split('/'), String(b).split('/')];
  if (ta.at(-1) !== tb.at(-1)) return false;
  return ta.length === 1 || tb.length === 1 || ta.slice(0, -1).join('/') === tb.slice(0, -1).join('/');
}

// 훅이 완료로 인정하는 응답 모양 — 아래를 모두 만족할 때만 쓴다. **애매하면 화면 판정으로 넘긴다**(Markdown을 정확히 해석하지 않는다):
//   1) 마지막 비어 있지 않은 줄이 마커이고 그 줄에 앞 공백이 없다(뒤 공백·CR은 허용). 들여쓴 마커는 목록·인용·코드 안일 수 있다.
//   2) 코드 울타리 후보(``` · ~~~가 줄 안 어디에 있든, 앞 공백·목록 표식·> 와 상관없이)를 줄 순서대로 훑어 '닫힘'으로 끝나고 애매함이 없다.
//      닫힘에서 후보 줄 → 열림. 열림에서 '같은 글자의 울타리(같거나 긴 길이)와 공백만 있는 줄' → 닫힘. 열림에서 그 밖의 후보(정보 문자열이 붙은 줄·다른 글자·더 짧은 울타리) → 애매함.
//      한 줄 안에서 글자 종류마다 짝이 맞는 인라인(```x```)은 후보에서 뺀다.
//   3) 같은 실행일 수 있는 다른 결과 마커가 없다(있으면 conflict로 남겨 소비처가 훅을 쓰지 않는다).
// 정상 응답(맨 끝 줄에 마커만)이 일부 화면 판정으로 넘어가는 것은 받아들인다 — 훅은 빠른 길일 뿐이고 화면 판정이 언제나 대체 경로다.
function fenceDoubtful(lines) {
  let open = null, doubtful = false;
  for (const line of lines) {
    const runs = line.match(/`{3,}|~{3,}/g);
    if (!runs) continue;
    const counts = {'`': 0, '~': 0};
    for (const run of runs) counts[run[0]] += 1;
    if (counts['`'] % 2 === 0 && counts['~'] % 2 === 0) continue; // 한 줄 안에서 짝이 맞는 인라인
    if (!open) { open = runs[0]; if (runs.length > 1) doubtful = true; continue; }
    const closing = line.trim().match(/^(`{3,}|~{3,})$/);
    if (closing && closing[1][0] === open[0] && closing[1].length >= open.length) open = null;
    else doubtful = true;
  }
  return open !== null || doubtful;
}

export function lastLineMarker(message) {
  const lines = message.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim());
  const lastLine = lines.at(-1) ?? '';
  if (!lastLine.startsWith('KADAN:DONE')) return null;
  const last = doneMarkerOf(lastLine);
  if (!last) return null;
  if (fenceDoubtful(lines)) return null;
  const conflict = findDoneMarkers(message).some(m => m.result !== last.result && mayBeSameRun(m.taskId, last.taskId));
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
