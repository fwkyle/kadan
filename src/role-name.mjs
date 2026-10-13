// Why: 역할 이름이 `슈퍼감독`·`비서`·`rottie-RH-작업자`처럼 섞이면 어느 저장소의 누구인지 이름만으로 알 수 없다.
// 새 이름은 `<레포명>-<역할>` 또는 `<레포명>-<주제>-<역할>`로 짓도록 안내만 한다(거절하지 않는다).
import {execFileSync} from 'node:child_process';
import path from 'node:path';

// 시작 폴더가 속한 git 주 저장소 이름. worktree면 주 저장소 기준이다. git 밖이거나 알 수 없으면 null.
export function repoNameFor(cwd, run = execFileSync) {
  try {
    const common = String(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})).trim();
    if (!common || path.basename(common) !== '.git') return null;
    return path.basename(path.dirname(common)) || null;
  } catch { return null; }
}

export const roleNameRule = '<레포명>-<역할> 또는 <레포명>-<주제>-<역할> (예: kadan-슈퍼감독, rottie-RH-감독, kadan-역할주소-작업자)';

// 새 이름(과거 start 기록이 없는 이름)만 본다. 비서 프로필은 대상이 아니다. 판단할 수 없으면 경고하지 않는다.
export function roleNameWarning({role, profile, cwd, repo = repoNameFor(cwd)}) {
  if (profile === 'secretary' || !repo || role.startsWith(`${repo}-`)) return null;
  return `역할 이름 규칙: '${role}'은 '${repo}-'로 시작하지 않는다. 권장 형식 ${roleNameRule}. 거절하지 않고 그대로 시작한다.`;
}
