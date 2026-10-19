import {createHash} from 'node:crypto';

const BOTTOM_LINES = 16;
// 알림 줄은 0칸에서 시작한다. 응답 본문에 인용·설명된 알림은 들여쓰기가 붙는다.
const NOTICE = /^[ⓘℹ■✕×]\s*This content can['’]t be shown\s*$/iu;
const NOTICE_WORDS = /can['’]t be shown|extra care with some cybersecurity/iu;
const FENCE = /^\s*(```|~~~)/u;
const RESPONSE_HEAD = /^\s*[•⏺]\s/u;
const COMPOSER = /^\s*›\s*(?:Ask Codex to do anything)?\s*$/u;

// codex가 보안 필터로 응답을 가리고 빈 입력창으로 돌아간 화면. 429처럼 모양으로만 판정한다:
// 알림 줄 + 바로 이어진 같은 덩어리의 cybersecurity 줄 + 그 뒤 빈 입력창, 작업 중 표시 없음.
// 보안 코드를 검수하는 정상 출력에도 낱말은 나오므로 낱말 포함 여부로는 걸지 않는다.
// 실제 화면 표본(2026-09-30 codex gpt-6.1-sol)은 tests/fixtures/security-filter-screens.json.
export function securityFilterNotice(screen) {
  if (typeof screen !== 'string') return null;
  const lines = screen.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const start = Math.max(0, lines.length - BOTTOM_LINES);
  const index = lines.findLastIndex((line, i) => i >= start && NOTICE.test(line));
  if (index < 0) return null;
  const block = [lines[index]];
  for (let i = index + 1; i < lines.length && lines[i].trim() !== ''; i++) block.push(lines[i]);
  if (!block.slice(1).some(line => /cybersecurity/iu.test(line))) return null;
  const tail = lines.slice(index + block.length);
  const composer = tail.findIndex(line => COMPOSER.test(line));
  if (composer < 0) return null;
  // 입력창 위에는 빈 줄만 있어야 한다.
  if (tail.slice(0, composer).some(line => line.trim() !== '')) return null;
  // 판정 입력창은 화면의 마지막 입력창이다. 그 뒤에는 바닥글(상태줄·안내) 몇 줄만 온다:
  // › 줄·코드 울타리·응답 머리표가 있으면 인용 안의 입력창이거나 뒤에 다른 출력이 이어진 것이다.
  const footer = tail.slice(composer + 1).filter(line => line.trim() !== '');
  if (footer.length > 3 || footer.some(line => /^\s*›/u.test(line) || FENCE.test(line) || RESPONSE_HEAD.test(line))) return null;
  // 코드 울타리 안(위에서 연 울타리가 아직 열려 있음)이면 인용이다.
  if (lines.slice(0, index).filter(line => FENCE.test(line)).length % 2 === 1) return null;
  // 위쪽 모양: 바로 위 글이 응답 본문 머리표 문단이거나 ':'로 끝나는 소개 문장이면 설명·인용이다.
  // 실제 표본은 도구 출력(A)이나 지시문 에코(B) 뒤에 알림이 온다. 애매하면 경보를 내지 않는다(정체 경로가 남는다).
  const above = lines.slice(0, index).findLast(line => line.trim() !== '');
  if (above != null && (RESPONSE_HEAD.test(above) || /[:：]\s*$/u.test(above))) return null;
  // 알림 문구가 바로 위 30줄에 또 있으면 그 문구를 이야기하는 글이다. 앞선 진짜 알림(0칸 알림 줄과 이어진 두 줄)은 뺀다:
  // 연속으로 두 번 걸린 정지는 둘 다 진짜다.
  const noticeLines = new Set();
  lines.forEach((line, i) => { if (NOTICE.test(line)) [i, i + 1, i + 2].forEach(n => noticeLines.add(n)); });
  for (let i = Math.max(0, index - 30); i < index; i++) if (!noticeLines.has(i) && NOTICE_WORDS.test(lines[i])) return null;
  if (/Working\s*\(|esc to interrupt|Reconnecting|Retrying|Messages to be submitted|KADAN:DONE/iu.test(lines.slice(index).join('\n'))) return null;
  // 화면 위쪽에 남은 같은 알림 수를 지문에 넣어 새로 찍힌 알림과 스크롤백을 구분한다.
  const earlier = lines.slice(0, index).filter(line => NOTICE.test(line)).length;
  const fingerprint = createHash('sha256').update(`${earlier}\n${block.join('\n')}`).digest('hex').slice(0, 16);
  return {fingerprint, line: block[0].trim()};
}
