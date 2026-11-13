// 위치 인자로 본문을 준 명령의 표준 입력에 '버려질 본문 파일'이 있는지 판정한다.
// 이 명령에 직접 준 파일(`< 파일`, heredoc)은 읽기 위치가 0이다. 부모가 이미 읽은 표준 입력을 물려받았으면 0이 아니다
// (heredoc으로 띄운 스크립트가 자식을 부른 경우 등). 내용은 읽지 않는다 — 읽으면 부모의 남은 입력이 깨진다.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

// 읽기 위치만 묻는다(SEEK_CUR 0). node에는 lseek가 없어 procfs가 없는 OS(macOS)에서는 기본 설치된 perl에 묻는다.
const PERL = '/usr/bin/perl';
const PERL_TELL = 'my $p = sysseek(STDIN, 0, 1); print defined $p ? $p + 0 : ""';

// 표준 입력의 현재 읽기 위치(바이트). 알 수 없으면 null.
export function stdinOffset({readFile = fs.readFileSync, spawn = spawnSync} = {}) {
  try {
    const pos = /^pos:\s*(\d+)/m.exec(readFile('/proc/self/fdinfo/0', 'utf8'));
    if (pos) return Number(pos[1]);
  } catch { /* procfs 없음 */ }
  try {
    const result = spawn(PERL, ['-e', PERL_TELL], {stdio: [0, 'pipe', 'ignore'], encoding: 'utf8', timeout: 2000});
    return result.status === 0 && /^\d+$/.test(result.stdout) ? Number(result.stdout) : null;
  } catch { return null; }
}

// null이면 충돌 없음. 'unread-file'은 아직 아무도 읽지 않은 비어 있지 않은 파일, 'offset-unknown'은 위치를 확인하지 못한 파일이다.
// 위치를 모르면 통과시키지 않는다(본문이 조용히 버려지는 쪽보다 거절이 낫다). 파이프는 검출하지 않는다.
export function stdinBodyConflict({stat = () => fs.fstatSync(0), offset = stdinOffset} = {}) {
  let info;
  try { info = stat(); } catch { return null; }
  if (!info.isFile() || !(info.size > 0)) return null;
  const position = offset();
  if (position === null) return 'offset-unknown';
  return position === 0 ? 'unread-file' : null;
}
