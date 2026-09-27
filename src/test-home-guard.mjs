// 시험이 실사용 원장(~/.kadan)을 쓰지 못하게 막는 공통 가드.
// node --test는 시험 파일마다 따로 프로세스를 띄워 공통 준비 파일을 강제할 수 없으므로, 원장 위치를 정하는 곳과
// 쓰기 관문에서 직접 검사한다(2026-09-27: 새 시험 첫 실행이 실사용 원장에 시험 편지 5건을 남긴 사고).
// 시험 밖에서는 아무것도 하지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function underTest({env=process.env,execArgv=process.execArgv}={}) {
  return Boolean(env.NODE_TEST_CONTEXT) || execArgv.includes('--test');
}

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function liveHomes(userHome) {
  const homes = [userHome ?? os.homedir()];
  // HOME을 바꾼 시험도 진짜 사용자 폴더를 피해 가지 못하게 계정 정보의 홈도 함께 본다.
  if (userHome === undefined) try { homes.push(os.userInfo().homedir); } catch {}
  return homes.map(home => real(path.join(home, '.kadan')));
}

export function assertTestHome(home, {env=process.env,execArgv=process.execArgv,userHome}={}) {
  if (!underTest({env,execArgv})) return;
  const hint = 'KADAN_HOME을 임시 폴더로 지정하세요(시험 파일 첫 import로 tests/helpers/isolated-home.mjs)';
  if (!home) throw new Error(`시험 중 원장 위치 없음: ${hint}`);
  if (liveHomes(userHome).includes(real(home))) throw new Error(`시험 중 실사용 원장 사용 금지(${home}): ${hint}`);
}
