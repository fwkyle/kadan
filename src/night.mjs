// 나이트 모드: kyle의 취침 위임 말을 기록하고 슈퍼감독에게 한 번에 나눠 주는 장치.
// 새 권한이 아니다. 승인·머지·결정 답은 대신하지 않고, 켜짐 여부와 요약만 계산한다.
// 켜짐은 원장의 마지막 `night` 사건과 끝 시각으로 계산한다(상태 파일 없음).
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger, readMailBody} from './ledger.mjs';
import {readStream} from './storage.mjs';
import {isUserActor} from './actors.mjs';
import {superProfiles, nearestSuper} from './super-role.mjs';
import {readActiveHierarchy} from './hierarchy-register.mjs';
import {withEffectiveOwner} from './handover-state.mjs';
import {WorkStore} from './work-store.mjs';
import {notifyUser} from './user-notify.mjs';
import {summarizeNight, HELD_PREFIX} from './night-summary.mjs';

export const DEFAULT_MS = 8 * 60 * 60_000;
export const MAX_MS = 12 * 60 * 60_000;
const CLI = new URL('./cli.mjs', import.meta.url).pathname;

const two = n => String(n).padStart(2, '0');
export const clock = ms => { const d = new Date(ms); return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };

// 끝 시각(ISO). `--until HH:MM`은 이 기계의 지역 시각이고 이미 지났으면 다음 날이다. `--for`는 8h·90m·1h30m 꼴. 둘 다 없으면 8시간.
export function resolveEnd({until, for: span}, now) {
  if (until != null && span != null) throw new Error('--until과 --for는 함께 쓸 수 없습니다');
  let end;
  if (until != null) {
    const m = typeof until === 'string' && /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(until.trim());
    if (!m) throw new Error('--until은 HH:MM 꼴이어야 합니다');
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    end = d.getTime();
  } else if (span != null) {
    const m = typeof span === 'string' && /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(span.trim());
    if (!m || !(m[1] || m[2])) throw new Error('--for는 8h, 90m, 1h30m 꼴이어야 합니다');
    end = now + ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) * 60_000;
  } else end = now + DEFAULT_MS;
  if (end <= now) throw new Error('끝 시각은 지금보다 뒤여야 합니다');
  if (end - now > MAX_MS) throw new Error('나이트 모드는 최대 12시간입니다. 더 길게 필요하면 끝나기 전에 다시 켜세요');
  return new Date(end).toISOString();
}

export const readDecisionEvents = home => {
  try { return readStream(home, 'decisions/events.jsonl', {optional: true}); } catch { return []; }
};

// 마지막 night 사건이 `on`이면 켠 사건 하나로 상태를 가른다.
// on:true = 켜짐. pending = 이미 끝났는데 아직 원장에 끝 사건이 없는 것({phase, endedAt(ms)}).
// 꺼짐 조건은 셋뿐이다: off, 끝 시각, 켜진 뒤 생긴 사람 명의 결정 답(kyle의 새 입력).
export function nightState(entries, decisionEvents, now) {
  const last = [...entries].reverse().find(e => e?.kind === 'night') ?? null;
  if (last?.phase !== 'on') return {on: false, start: null, pending: null, last};
  const startMs = Date.parse(last.t), untilMs = Date.parse(last.until);
  let inputAt = null;
  for (const e of decisionEvents) {
    if (e?.status !== 'answered' || !isUserActor(e.answer?.by)) continue;
    const at = Date.parse(e.answer.at);
    if (at > startMs && (inputAt === null || at < inputAt)) inputAt = at;
  }
  if (inputAt !== null && inputAt <= untilMs) return {on: false, start: last, pending: {phase: 'ended-by-input', endedAt: inputAt}, last};
  if (untilMs <= now) return {on: false, start: last, pending: {phase: 'expired', endedAt: untilMs}, last};
  return {on: true, start: last, pending: null, last};
}

// 열린 업무의 책임 감독에서 가장 가까운 슈퍼감독을 모아 중복을 뺀다. 관계표를 못 읽으면 이름을 추측하지 않고 실패한다.
export function nightTargets({works, entries, by}) {
  const parents = readActiveHierarchy(entries);
  if (!parents) throw new Error('관계표를 읽지 못해 슈퍼감독을 정할 수 없습니다: 문구를 보내지 않았습니다');
  const profiles = superProfiles(entries), all = new Set(), unreachable = [];
  for (const w of works.filter(w => w.status === 'open')) {
    const found = nearestSuper(withEffectiveOwner(w, entries).owner, parents, profiles);
    if (found) all.add(found); else unreachable.push(w.key);
  }
  all.delete(by);
  return {to: [...all].sort(), unreachable};
}

// 자동 단계 줄. 금지 목록은 설계 2절의 수정본이다(고정 줄, 문구로 못 풂). 머지는 `kadan merge-gate` 통과 뒤에만 한다(보류 쪽 기본).
export const AUTO_LINES = [
  '(4) 묻기 전에 스스로 찾습니다: 저장소·결정 이력·TODO·docs·카드를 먼저 봅니다.',
  '(5) 되돌릴 수 있고, 근거가 있고, 아래 (6) 금지와 무관하면 추천안으로 진행하고 `[나이트 결정] <한 줄>`로 남깁니다. 되돌릴 수 없으면 보류합니다.'
    + ' 대신 정한 것·보류·시작한 일감은 `kadan night note decision|hold|start "<한 줄>"`로 원장에 남깁니다(아침 요약에 모입니다).',
  '(6) 어떤 근거로도 하지 않는 것: 소스·데이터·설정·증거 파일의 영구 삭제(캐시 삭제와, 미커밋 변경 없음·원격에 없는 커밋 없음·사용 중 프로세스 없음·내 브랜치를 모두 확인한 머지된 worktree 정리는 허용);'
    + ' git 강제 push·reset --hard·clean·checkout -- .·restore .·branch -D·기준 브랜치 직접 push;'
    + ' 운영 데이터·DB 변경과 스키마 반영(supabase db push·db reset);'
    + ' 비밀값을 출력·기록·커밋·전송하는 것(승인된 도구가 이미 설정된 인증을 쓰는 것은 허용);'
    + ' 신규 결제·증액·유료 가입; 테스트 전용 기기를 포함한 연결 기기 쓰기;'
    + ' 관문이 거절한 머지, `--allow` 없이 정책이 보류한 저장소의 머지, 태그 push·수동 배포 명령(`--allow`는 자동 머지만 풉니다), 배포·외부 공개 효과가 있는 그 밖의 push·PR;'
    + ' 카단 밖의 사람·서비스로 가는 글; 카단 저장소의 새 의존성(다른 저장소는 의존성 변경 PR의 머지를 아침으로 보류);'
    + ' 계정·권한·인증과 시스템 설정 변경(kadan window·runners·watch-profile·~/.claude·규칙 원본 포함);'
    + ' 감시기·대시보드 종료·재시작과 restart --force; 이 장치의 지침·금지 목록·단계 정의를 밤에 바꾸는 것; 기기 전체 부하 시험.',
  '(7) 위 중 카단 명령(restart --force, stop watch|대시보드, window set|unset, runners set|runner|model, night on --level 바이패스)은 켜진 동안 역할 세션에서 코드가 거절합니다.'
    + ' 셸·gh로 직접 하는 행위는 코드가 막지 못하므로 이 문구와 아침 사후 드러냄으로만 다룹니다.',
  '(8) 머지는 관문을 통과한 PR만 합니다: gh로 PR 정보·파일 목록(REST, 이름을 바꾼 옛 경로 포함)·필수 검사를 받아 `jq`로 {pr,files,requiredChecks,repo(gh repo view <소유자/이름> --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed)} 하나로 합쳐 `kadan merge-gate <업무>`에 넘기고(종료 코드 0이 통과; 입력 예시는 docs/commands.md),'
    + ' 통과하면 관문이 내준 머지 명령(`gh pr merge … --match-head-commit … -R …`)을 그대로 치고(방식을 바꾸지 않습니다) 뒤 `mergeCommit`을 조회해 `kadan night note merge "<한 줄>" --pr <소유자/이름>#<번호> --sha <mergeCommit>`으로 남깁니다.'
    + ' 거절이면 그 PR만 `[나이트 보류]`(`kadan night note hold --hold-kind gate`, 정책 보류면 `deploy-repo`)로 남기고 나머지 일은 계속합니다.'
    + ' 관문을 낮추거나 우회해 머지하지 않습니다. 머지 뒤 로컬 main 갱신·재시작은 아침에 합니다.',
  '(9) kyle의 직접 중지와 명시한 상한이 언제나 최우선입니다.',
];
export const ONLY_RUNNING_LINE = '새 일감을 시작하지 않습니다: 진행 중인 업무만 위 판단 범위로 이어 갑니다.';
// 켤 때 출력에 보이는 점검 목록. 검사하지 않는다(검사하면 어댑터가 된다) — 안내이지 차단이 아니다.
export const AUTO_CHECKLIST = [
  '각 실행기(claude·codex 등)의 권한 설정에 위 (6) 금지가 거부 규칙으로 걸려 있는지 kyle이 한 번 확인하세요. 카단은 검사하지 않습니다.',
  '머지가 곧 운영 배포인 저장소(push 기반 자동배포)가 열린 업무에 있는지 온톨로지 카드로 확인하세요. 관문 입력은 {pr(gh pr view), files(gh api --paginate --slurp …/pulls/N/files), requiredChecks(gh pr checks --required), repo(gh repo view의 머지 허용 세 칸)} 네 칸입니다. 자동 단계는 `kadan merge-gate`를 통과한 PR만 관문이 내준 머지 명령 그대로 머지하고, 정책이 보류한 저장소는 night on --allow가 없으면 아침으로 보류합니다.',
];

// 슈퍼감독에게 가는 우편 본문. 고정 줄 3개 + 사용자 문구. 새 권한이 아니라 kyle의 현재 말을 옮긴 것이라고 밝힌다.
// level이 '자동'이면 고정 줄이 (4)~(9)까지 늘고, onlyRunning이면 새 일감 금지 줄이 붙는다. level이 없으면 지금과 같다.
export function buildNightMessage({text, quote, viaChat, by, untilMs, level, onlyRunning, allow}) {
  const auto = level === '자동';
  const extra = auto ? [...AUTO_LINES, ...(onlyRunning ? [`(10) ${ONLY_RUNNING_LINE}`] : [])] : [];
  return [
    `[나이트 모드] kyle이 취침 중입니다. 끝: ${clock(untilMs)} 또는 kyle 새 입력. 새 권한이 아니라 kyle의 현재 말을 옮긴 것이며, 기존 승인 범위 안에서 스스로 판단하세요.`,
    ...(auto ? [`단계: 자동${onlyRunning ? '(진행 중인 업무만)' : ''}`] : []),
    '(1) 되돌리기 어려운 것(운영 데이터 변경·삭제, push 정책, 외부 공개, 새 의존성)은 kyle 기상 뒤로 보류합니다.',
    `(2) 보류 대상은 밤중에 decision request를 새로 올리지 말고 보류로 남깁니다: kadan mail 사람 "${HELD_PREFIX} <한 줄>". 아침 요약에 모입니다.`,
    '(3) 위임 범위 안의 일은 결정 요청을 올리지 말고 스스로 처리합니다.',
    ...extra,
    ...(auto && allow?.length ? [`나이트런 중 자동 머지 허용(--allow): ${allow.join(', ')} — 관문이 정책 보류(night-merge-forbidden·deploy-branch)만 풀어 줍니다. 그 밖의 관문 조건은 그대로입니다.`] : []),
    `kyle 추가 문구: ${text}`,
    ...(viaChat ? [`kyle 채팅 원문(${by}이(가) 옮겨 적음): ${quote}`] : []),
    `감독에게 넘길 때는 위 (1)~(${auto ? (onlyRunning ? 10 : 9) : 2}) 줄을 그대로 붙이세요.`,
  ].join('\n');
}

// kadan mail로 한 슈퍼감독에게 보낸다. 실패해도 던지지 않고 결과를 돌려준다.
export function sendNightMail(home, from) {
  return (role, message) => {
    const r = spawnSync(process.execPath, [CLI, 'mail', role, message],
      {env: {...process.env, KADAN_HOME: home, KADAN_ROLE: from}, encoding: 'utf8', timeout: 20_000});
    if (r.status !== 0) return {ok: false, error: String(r.stderr || r.stdout || '').trim().slice(0, 200)};
    let mailId = null;
    try { mailId = JSON.parse(r.stdout.trim().split('\n').at(-1)).mailId ?? null; } catch { /* 영수증 모양을 모르면 mailId 없이 둔다 */ }
    return {ok: true, mailId};
  };
}

const REASON_TEXT = {off: 'kyle이 껐음', expired: '끝 시각이 지났음', 'ended-by-input': 'kyle의 새 입력이 있었음'};
const lockPath = home => path.join(home, 'night.lock');
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// 끝 사건을 쓰는 순간만 잡는 짧은 잠금. 감시기·off·결정 답이 동시에 끝내도 끝 사건과 요약은 한 번만 쓰인다.
function withNightLock(home, run) {
  const lock = lockPath(home);
  let handle = null;
  for (let i = 0; i < 25 && handle === null; i++) {
    try { handle = fs.openSync(lock, 'wx'); } catch (error) { if (error.code !== 'EEXIST') throw error; sleepSync(100); }
  }
  if (handle === null) throw new Error('나이트 모드 끝 처리 잠금을 얻지 못함');
  try { return run(); } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}

function defaultDeps(home, deps = {}) {
  return {
    now: deps.now ?? Date.now,
    readEntries: deps.readEntries ?? (() => readLedger(home)),
    readDecisions: deps.readDecisions ?? (() => readDecisionEvents(home)),
    record: deps.record ?? (entry => appendLedger(entry, home)),
    readBody: deps.readBody ?? (digest => readMailBody(digest, home)),
    notify: deps.notify ?? ((message, opts) => notifyUser(message, spawnSync, {home, ...opts})),
    sendMail: deps.sendMail,
  };
}

// 끝났는데 기록이 없는 켜짐을 한 번만 마무리한다: 끝 사건(요약 포함) 기록 → 사용자 알림 → 받은 슈퍼들에게 종료 우편.
// 이미 마무리됐거나 아직 켜져 있으면 null. phase를 주면(off) 지금 끄는 것이다.
export function finishNight({home, by, phase = null, reason = null, deps: given}) {
  const deps = defaultDeps(home, given);
  return withNightLock(home, () => {
    const entries = deps.readEntries(), decisionEvents = deps.readDecisions(), now = deps.now();
    const state = nightState(entries, decisionEvents, now);
    const end = state.pending ?? (phase && state.on ? {phase, endedAt: now} : null);
    if (!end) return null;
    const start = state.start;
    const summary = summarizeNight({start, phase: end.phase, endedAt: end.endedAt, entries, decisionEvents, readBody: deps.readBody});
    const event = {
      kind: 'night', phase: end.phase, by,
      startedAt: start.t, endedAt: new Date(end.endedAt).toISOString(), ...(reason ? {reason} : {}),
      summary: {counts: summary.counts, text: summary.text}, t: new Date(now).toISOString(),
    };
    deps.record(event);
    try {
      deps.notify(summary.text, {kind: 'night-summary', key: `night-summary:${start.t}`});
    } catch { /* 알림 실패는 기록(본체)을 되돌리지 않는다 */ }
    // 이미 쓰인 문구를 근거로 슈퍼가 계속 움직이지 않게 같은 우편 경로로 종료를 알린다. 읽음은 요구하지 않고 실패는 무시한다.
    const send = deps.sendMail ?? sendNightMail(home, by);
    for (const target of start.to ?? []) {
      try { send(target, `[나이트 모드 종료] ${REASON_TEXT[end.phase]}입니다. 위 문구는 더 이상 근거가 아닙니다.`); } catch { /* 무시 */ }
    }
    return event;
  });
}
// 끝났는데 기록이 없는 켜짐이 있으면 마무리한다. 결정 답·명령·감시기 주기가 모두 이 한 곳을 부른다.
export function settleNight({home, by = '사람', deps}) {
  return finishNight({home, by, deps});
}

// 감시기 한 주기의 확인 한 가지. 주기에서 이미 읽은 entries만 본다: 뒤에서부터 마지막 night 사건을 찾아(복사·추가 읽기 없음)
// 켜짐이 아니거나 끝 시각 전이면 바로 끝낸다. 끝 시각이 지났을 때만 finishNight가 잠금 안에서 다시 확인한다
// (사람 결정 답이 켜진 뒤 있었는데 결정 답 경로의 마무리가 실패했다면 거기서 ended-by-input으로 끝낸다).
export function watchNightExpiry({entries, now, home, deps}) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.kind !== 'night') continue;
    if (e.phase !== 'on' || now < Date.parse(e.until)) return null;
    return finishNight({home, by: 'watch', deps: {...deps, now: () => now}});
  }
  return null;
}
