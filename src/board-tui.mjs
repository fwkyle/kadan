// kadan board의 터미널 제어: 대체 화면·raw 모드·커서·괄호 붙여넣기를 켜고, 어떤 끝에서도 원래대로 돌려놓는다.
// 의존성 없이 ANSI 이스케이프만 쓴다. 복구는 여러 번 불러도 안전하다(멱등).
const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J";
const LEAVE = "\x1b[?2004l\x1b[?25h\x1b[?1049l";

export function createTerminal({ stdin = process.stdin, stdout = process.stdout } = {}) {
  let active = false;
  const state = { rawBefore: false };
  return {
    get active() { return active; },
    // 대체 화면에 들어가 키를 한 글자씩 받는다.
    enter() {
      if (active) return;
      state.rawBefore = Boolean(stdin.isRaw);
      if (stdin.setRawMode) stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      stdout.write(ENTER);
      active = true;
    },
    // raw 모드 해제·커서 복구·원래 화면 복귀. 끝, 오류, Ctrl-C(목록 포커스), SIGTERM, SIGHUP 모두 이 함수 하나로 간다.
    restore() {
      if (!active) return;
      active = false;
      try { stdout.write(LEAVE); } catch {}
      try { if (stdin.setRawMode) stdin.setRawMode(state.rawBefore); } catch {}
      try { stdin.pause(); } catch {}
    },
    write(text) { if (active) stdout.write(text); },
    size() { return { cols: stdout.columns || 80, rows: stdout.rows || 24 }; },
  };
}

export const SCREEN_SEQUENCES = { ENTER, LEAVE };
