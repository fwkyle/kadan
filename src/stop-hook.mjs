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

// 응답 전체의 코드 울타리(``` · ~~~)를 세어 마지막 줄이 열린 블록 안인지 본다. 닫는 울타리는 같은 글자, 같거나 긴 길이, 뒤에 다른 글이 없어야 한다.
function endsInsideFence(lines) {
  let open = null;
  for (const line of lines) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    // 여는 울타리. 백틱 울타리는 같은 줄 뒤에 백틱이 있으면 인라인 코드라 열지 않는다(CommonMark).
    if (!open) { if (!(m[1][0] === '`' && m[2].includes('`'))) open = m[1]; continue; }
    if (m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = null;
  }
  return open !== null;
}

// 완료로 인정하는 것은 응답의 마지막 비어 있지 않은 줄이 마커이고 열린 코드 블록 밖일 때뿐이다(2026-10-18 검수: 인용·열린 블록이 완료로 읽혔다).
// 같은 응답에 같은 실행일 수 있는 다른 결과 마커가 있으면 conflict로 표시한다 — 소비처는 그 증거를 쓰지 않고 화면 판정으로 넘어간다.
export function lastLineMarker(message) {
  const raw = message.split('\n').map(line => line.replace(/\r$/, ''));
  const lines = raw.filter(line => line.trim());
  const last = doneMarkerOf(lines.at(-1) ?? '');
  if (!last || endsInsideFence(lines)) return null;
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
