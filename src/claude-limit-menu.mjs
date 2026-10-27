// Why: 한도 선택 메뉴일 때만 Escape를 허용한다. 다른 화면은 놓치는 쪽으로 판정한다.
// 출처: Claude Code 2.1.311 실행 파일의 rate-limit-options chunk, 문자열 줄 2081826.
const STOP = 'Stop and wait for limit to reset';
const WAIT = /^Wait here, then continue automatically (?:shortly|at .+|when the limit resets)$/u;
const OPTION = /^\s*(?:❯\s*)?\d+\.\s+(.+)$/u;
const BORDER = /^[\s─━╭╮╰╯│┌┐└┘┼├┤┬┴-]*$/u;

export function claudeLimitMenu(screen) {
  if (typeof screen !== 'string') return null;
  const lines = screen.split('\n');
  const title = lines.findLastIndex(line => line.trim() === 'What do you want to do?');
  if (title < 0) return null;
  // 코드 인용 안의 메뉴는 허용하지 않는다.
  if (lines.slice(0, title).filter(line => /^\s*(?:```|~~~)/u.test(line)).length % 2) return null;
  const tail = lines.slice(title + 1).filter(line => !BORDER.test(line));
  // 선택지와 취소 안내만 화면 끝에 있어야 한다. 입력창·응답·모르는 안내가 끼면 거절한다.
  // 같은 실행 파일 2057904줄의 Ee/Yt 기본 안내: Enter(confirm) + Esc(cancel).
  const footer = /^(?:(?:Enter|enter) to confirm · )?(?:Esc|esc) to cancel$/u;
  if (tail.length < 3 || !footer.test(tail.at(-1).trim())) return null;
  const options = tail.slice(0, -1).map(line => line.match(OPTION)?.[1]);
  if (options.some(value => !value) || !options.includes(STOP) || !options.some(value => WAIT.test(value))) {
    return null;
  }
  return { title, signature: lines.slice(title).join('\n') };
}

export function hasLimitMenuText(screen) {
  if (typeof screen !== 'string') return false;
  const lines = screen.split('\n');
  const composer = lines.findLastIndex(line => /^\s*❯(?:\s*$|\s+(?!\d+\.)\S)/u.test(line));
  return lines.slice(composer + 1).some(line => line.includes(STOP));
}
