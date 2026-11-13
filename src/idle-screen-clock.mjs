// Why: "이 역할 화면이 언제부터 그대로인가"를 잰다. 쉬는 역할을 정리 후보로 고르는 기준 시계다(idle-roles.mjs).
// tmux의 창 활동 시각은 쓰지 않는다: 쉬는 claude 화면이 글자는 그대로인 채 30분마다 다시 그려져 그 시각이 계속 움직였다
// (2026-11-13 운영 실측). 출력 기록 파일의 수정 시각도 쓰지 않는다: 64KB 버퍼가 찰 때만 써져서 쉬는 것처럼 틀린다.
// 대신 한 시간에 한 번 화면 글자의 지문을 떠서 지난번과 비교하고, 지문이 지금 값이 된 시각을 작은 상태 파일에 적는다.
//  - 저절로 바뀌는 줄은 지문에서 뺀다: 입력칸 아래 바닥글(모델·ctx %·권한 줄·알림), codex 상태 줄, 쉬는 동안 자동 압축 안내 줄.
//    입력칸 모양을 확인하지 못한 화면은 아무것도 빼지 않는다(덜 고르는 쪽).
//  - 모르면 "방금 바뀜"이다: 처음 본 세션, 프로세스가 바뀐 세션, 상태 파일이 없거나 깨진 경우는 모두 지금부터 다시 센다.
//    화면을 읽지 못한 세션은 시각을 내지 않고(후보에서 빠진다) 상태에서도 지운다.
//  - 정밀도는 표본 주기(1시간)다. 표본 사이에 바뀌었다가 같은 글자로 돌아온 화면은 못 본다.
// 비용: 살아 있는 세션마다 화면 읽기 1번(호출자가 넘긴 read) + 상태 파일 읽기·쓰기 1번. 원장을 읽지 않는다.
// 세션이 10배면 화면 읽기도 10배다. 상태 파일은 살아 있는 세션 수만큼의 줄이고 매번 통째로 다시 쓴다(사라진 세션의 줄은 없어진다).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {composerIndex} from './ghost-text.mjs';

export const IDLE_STATE_FILE = 'idle-roles-state.json';
const STATE_VERSION = 1;
const CLAUDE_RULE = /^─{3,}\s*$/u;
// claude 2.1.323 실측: `⏺ Compacted while idle, before the prompt cache expired · turn off with "idleCompaction": false in settings.json`
const IDLE_COMPACTION = /^\s*⏺\s+Compacted while idle\b/u;

// 지문에 넣을 글자. 끝의 빈 줄, 확인된 입력칸 아래 바닥글, 자동 압축 안내 줄을 뺀다.
export function stableScreenText(screen) {
  const lines = String(screen ?? '').split('\n');
  while (lines.length && lines.at(-1).trim() === '') lines.pop();
  const composer = composerIndex(lines);
  let kept = lines;
  if (composer >= 0) {
    // claude: 입력 줄 아래 가로줄까지 남긴다. codex: 입력 줄까지 남긴다(그 아래는 빈 줄 + 상태 줄·단축키 줄).
    const end = CLAUDE_RULE.test(lines[composer + 1] ?? '') ? composer + 2 : composer + 1;
    kept = lines.slice(0, end);
  }
  return kept.filter(line => !IDLE_COMPACTION.test(line)).join('\n');
}

export const screenDigest = screen => createHash('sha256').update(stableScreenText(screen)).digest('hex').slice(0, 32);

export const idleStatePath = home => path.join(home, IDLE_STATE_FILE);
// candidates: 마지막 실행이 고른 후보 요약(대시보드·show가 수만 센다). 끄기 파일로 판정을 건너뛴 실행 뒤에는 null(모름)이다.
const emptyState = () => ({version: STATE_VERSION, lastRunAt: null, sessions: {}, attempts: {}, candidates: null, candidatesAt: null});

// 못 읽거나 모양이 다르면 빈 상태다(모두 지금부터 다시 센다). 던지지 않는다.
export function readIdleState(home) {
  try {
    const value = JSON.parse(fs.readFileSync(idleStatePath(home), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STATE_VERSION) return emptyState();
    const plainObject = v => v && typeof v === 'object' && !Array.isArray(v);
    if (!plainObject(value.sessions)) return emptyState();
    return {version: STATE_VERSION, lastRunAt: Number.isFinite(value.lastRunAt) ? value.lastRunAt : null,
      sessions: value.sessions, attempts: plainObject(value.attempts) ? value.attempts : {},
      candidates: Array.isArray(value.candidates) ? value.candidates : null,
      candidatesAt: Number.isFinite(value.candidatesAt) ? value.candidatesAt : null};
  } catch { return emptyState(); }
}

// 임시 파일에 쓰고 이름을 바꾼다(반쯤 써진 파일을 읽지 않게).
export function writeIdleState(home, state) {
  const file = idleStatePath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  fs.writeFileSync(tmp, JSON.stringify({...state, version: STATE_VERSION}, null, 1) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

const validEntry = e => e && typeof e === 'object' && typeof e.digest === 'string' && e.digest && Number.isFinite(e.since);

// live: [{session, pid, created}] (바닥의 살아 있는 세션). read(session): 화면 글자(못 읽으면 빈 글자·예외).
// 반환: {sessions: 다음 상태의 세션 줄(살아 있고 읽힌 세션만), clocks: Map<session, {since}|{unknown: 이유}>}. 파일을 쓰지 않는다.
export function observeScreens({previous = {}, live, read, now}) {
  const sessions = {}, clocks = new Map();
  for (const item of live) {
    const {session} = item;
    let screen;
    try { screen = read(session); } catch { screen = null; }
    if (typeof screen !== 'string' || screen.trim() === '') { clocks.set(session, {unknown: '화면을 읽지 못함'}); continue; }
    const digest = screenDigest(screen);
    const identity = `${item.pid ?? ''}:${item.created ?? ''}`;
    const before = previous[session];
    const same = validEntry(before) && before.identity === identity && before.digest === digest && before.since <= now;
    const since = same ? before.since : now;
    sessions[session] = {identity, digest, since};
    clocks.set(session, {since});
  }
  return {sessions, clocks};
}
