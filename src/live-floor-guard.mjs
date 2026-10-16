// 운영 바닥(기본 tmux 구획·로티 창)에 기본 홈이 아닌 KADAN_HOME으로 닿는 것을 막는다.
// 이유: 시험이 만든 자식 프로세스가 KADAN_HOME만 시험 폴더로 바꾸고 KADAN_SOCKET·창 설정은 운영 값을 물려받아,
// 2026-10-16 운영 슈퍼감독 창에 가짜 결정 답변 2통이 들어갔다. 운영 원장에는 흔적이 없어 사전 차단만이 방어다.
// 기본 홈은 watchProcessName과 같은 기준(~/.kadan, 링크면 실제 경로)으로 본다.
import os from 'node:os';
import path from 'node:path';
import {watchProcessName} from './watch-system.mjs';

export const ALLOW_LIVE_FLOOR_ENV = 'KADAN_ALLOW_LIVE_FLOOR';
const DEFAULT_SOCKET = 'kadan';
const LIVE_WINDOWS = new Set(['rottie', 'orca']);

export const isDefaultHome = (home, defaultHome = path.join(os.homedir(), '.kadan')) =>
  !home || watchProcessName(home, defaultHome) === 'kadan-watch';

// 기본 홈이 아닌데 바닥의 대상이 기본값이면 이유 문장을, 아니면 null을 돌려준다.
export function liveFloorReason(env = process.env, defaultHome) {
  if (env[ALLOW_LIVE_FLOOR_ENV] === '1') return null;
  const home = env.KADAN_HOME || env.KADAN_LITE_HOME;
  if (isDefaultHome(home, defaultHome)) return null;
  const socket = env.KADAN_SOCKET || env.KADAN_LITE_SOCKET || DEFAULT_SOCKET;
  if (socket === DEFAULT_SOCKET) return `KADAN_SOCKET=${env.KADAN_SOCKET || env.KADAN_LITE_SOCKET || '(없음, 기본 kadan)'}`;
  if (LIVE_WINDOWS.has(env.KADAN_WINDOW)) return `KADAN_WINDOW=${env.KADAN_WINDOW}`;
  return null;
}

export function assertNotLiveFloor(env = process.env, defaultHome) {
  const reason = liveFloorReason(env, defaultHome);
  if (!reason) return;
  const home = env.KADAN_HOME || env.KADAN_LITE_HOME;
  const error = new Error(
    `KADAN_LIVE_FLOOR_DENIED: 기본이 아닌 KADAN_HOME=${home}으로 운영 바닥에 닿는 것을 거절한다(${reason}). ` +
    `KADAN_SOCKET을 격리 이름으로, KADAN_WINDOW=none으로 바꾸거나, 정말 필요하면 ${ALLOW_LIVE_FLOOR_ENV}=1을 준다`);
  error.code = 'KADAN_LIVE_FLOOR_DENIED';
  throw error;
}
