// Autopilot Wingman 경로(PR F). Autopilot 단계로 켜진 동안만, 사용자에게 가던 "놀고 있음" 2단과 "정체" 경보를 Wingman 슈퍼감독에게 돌린다.
// 새 권한도 새 우편 경로도 아니다: 수신자 한 칸만 바꾸고 기존 sendAlert 경로를 그대로 쓴다. 감시기의 역할 재시작은 하지 않는다(잠긴 규칙 3·8).
// 기본 Wingman은 KADAN_HOME/autopilot-wingman.json 하나(0600, 임시 파일 + rename). Wingman을 자동으로 고르지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {USER_RECIPIENT} from './hierarchy.mjs';
import {isSupervisorActor} from './actors.mjs';
import {NO_WINGMAN, WINGMAN_BASIS, LEVEL_AUTOPILOT, HELD_PREFIX} from './autopilot-terms.mjs';

export {NO_WINGMAN, WINGMAN_BASIS};

export const WINGMAN_FILE = 'autopilot-wingman.json';
export const wingmanPath = home => path.join(home, WINGMAN_FILE);

// 저장된 기본 Wingman. 파일이 없으면 {wingman: null}, 읽지 못하면 {wingman: null, corrupt}: 못 읽어도 켜기는 막지 않는다.
export function readDefaultWingman(home) {
  const file = wingmanPath(home);
  if (!fs.existsSync(file)) return {wingman: null};
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!v || typeof v !== 'object' || v.version !== 1 || (v.wingman != null && typeof v.wingman !== 'string')) throw new Error('모양이 다름');
    return {wingman: v.wingman ?? null, ...(v.at ? {at: v.at, by: v.by} : {})};
  } catch (error) { return {wingman: null, corrupt: `${WINGMAN_FILE} 읽기 실패(${error.message})`}; }
}

function writeWingman(home, body) {
  const file = wingmanPath(home), tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({version: 1, ...body}, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

// 저장할 때는 슈퍼감독 역할 이름 꼴인지만 본다. 살아 있는지·이번 켜짐의 대상인지는 켤 때 본다.
export function setDefaultWingman(home, {wingman, by, now = Date.now()}) {
  if (typeof wingman !== 'string' || !isSupervisorActor(wingman)) throw new Error(`Wingman은 슈퍼감독 역할 이름이어야 합니다(받은 값: ${typeof wingman === 'string' ? wingman : '없음'})`);
  const before = readDefaultWingman(home).wingman;
  writeWingman(home, {wingman, at: new Date(now).toISOString(), by});
  return {wingman, before};
}

export function clearDefaultWingman(home, {by, now = Date.now()}) {
  const before = readDefaultWingman(home).wingman;
  writeWingman(home, {wingman: null, at: new Date(now).toISOString(), by});
  return {wingman: null, before};
}

// 경보 하나의 수신자를 Wingman으로 바꿀지 정한다(순수 함수). 모든 조건이 참일 때만 바꾸고, 아니면 받은 route를 그대로 돌려준다.
// autopilot: {on, level, wingman} 한 주기 스냅샷(없으면 꺼짐). liveSessions: 살아 있는 세션 이름들, null이면 조회 실패(모름 → 바꾸지 않음).
export function applyWingmanRoute({route, alert, autopilot, liveSessions}) {
  if (route?.recipient !== USER_RECIPIENT) return route;
  if (!autopilot?.on || autopilot.level !== LEVEL_AUTOPILOT || !autopilot.wingman) return route;
  if (!((alert.kind === '놀고 있음' && alert.stage === 2) || alert.kind === '정체')) return route;
  if (autopilot.wingman === alert.role) return route;
  if (liveSessions == null || !new Set(liveSessions).has(`kadan-${autopilot.wingman}`)) return route;
  return {...route, recipient: autopilot.wingman, basis: WINGMAN_BASIS};
}

// Wingman 우편에 붙는 줄. 우편으로 깨우는 데까지가 Wingman의 일이다: restart는 그 슈퍼감독의 판단이고 --force는 금지다.
export const WINGMAN_LINES = [
  'Wingman: 당신이 이번 Autopilot의 Wingman입니다. 최상위 슈퍼감독의 "놀고 있음" 2단과 "정체" 경보가 kyle 대신 당신에게 옵니다.',
  `Wingman 경보를 받으면 멈춘 슈퍼감독을 \`kadan mail\`로 깨웁니다. 15분 뒤에도 그대로면 \`kadan mail 사람 "${HELD_PREFIX} <슈퍼> 멈춤"\`을 남기고 다른 일을 계속합니다.`
    + ' 재시작(`kadan restart`)은 그 슈퍼감독 본인의 판단이며 Wingman이 하지 않습니다. `--force`는 쓰지 않고, 감시기는 재시작하지 않습니다.',
];
