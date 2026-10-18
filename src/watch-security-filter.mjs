import {createHash} from 'node:crypto';

const BOTTOM_LINES = 16;
const NOTICE = /^\s*[ⓘℹ■✕×]\s*This content can['’]t be shown\s*$/iu;
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
  // 입력창 위에는 빈 줄만, 아래에는 상태줄 정도만 있어야 한다. 사용자 입력이 든 › 줄은 새 입력이다.
  if (tail.slice(0, composer).some(line => line.trim() !== '')) return null;
  if (tail.some(line => /^\s*›\s*\S/u.test(line) && !COMPOSER.test(line))) return null;
  if (/Working\s*\(|esc to interrupt|Reconnecting|Retrying|Messages to be submitted|KADAN:DONE/iu.test(lines.slice(index).join('\n'))) return null;
  // 화면 위쪽에 남은 같은 알림 수를 지문에 넣어 새로 찍힌 알림과 스크롤백을 구분한다.
  const earlier = lines.slice(0, index).filter(line => NOTICE.test(line)).length;
  const fingerprint = createHash('sha256').update(`${earlier}\n${block.join('\n')}`).digest('hex').slice(0, 16);
  return {fingerprint, line: block[0].trim()};
}
