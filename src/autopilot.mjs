// Autopilot: kyle의 자리 비움 위임 말을 기록하고 슈퍼감독에게 한 번에 나눠 주는 장치.
// 새 권한이 아니다. 승인·머지·결정 답은 대신하지 않고, 켜짐 여부와 요약만 계산한다.
// 켜짐은 원장의 마지막 `autopilot` 사건과 끝 시각(있을 때만)으로 계산한다(상태 파일 없음).
// 단계표(꺼짐·Cruise·Autopilot·완전자율)는 docs/autopilot-levels.md 한 곳에 있다.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger, readMailBody} from './ledger.mjs';
import {readStream} from './storage.mjs';
import {superProfiles, nearestSuper} from './super-role.mjs';
import {readActiveHierarchy} from './hierarchy-register.mjs';
import {withEffectiveOwner} from './handover-state.mjs';
import {WorkStore} from './work-store.mjs';
import {notifyUser} from './user-notify.mjs';
import {summarizeAutopilot, HELD_PREFIX} from './autopilot-summary.mjs';
import {WINGMAN_LINES} from './autopilot-wingman.mjs';
import {MAIL_DELIVERY_EXIT_ENV, mailDeliveryOf} from './mail-delivery-exit.mjs';
import {MODE, LEVEL_CRUISE, LEVEL_AUTOPILOT, LEVEL_FULL, LEVEL_LABEL, ALLOW_LABEL} from './autopilot-terms.mjs';

const CLI = new URL('./cli.mjs', import.meta.url).pathname;

const two = n => String(n).padStart(2, '0');
export const clock = ms => { const d = new Date(ms); return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };

export const NO_END_TEXT = '끝 없음(직접 끌 때까지)';

// 끝 시각(ISO). `--until HH:MM`은 이 기계의 지역 시각이고 이미 지났으면 다음 날이다. `--for`는 8h·90m·1h30m 꼴.
// 둘 다 없으면 끝 시각이 없다(null): 직접 끌 때까지 켜져 있다. 상한도 없다.
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
  } else return null;
  if (end <= now) throw new Error('끝 시각은 지금보다 뒤여야 합니다');
  return new Date(end).toISOString();
}

export const readDecisionEvents = home => {
  try { return readStream(home, 'decisions/events.jsonl', {optional: true}); } catch { return []; }
};

// 원장 on 사건의 끝 시각 칸. 칸이 **없을 때만**(`'until' in event`가 거짓) 끝 없음(직접 끌 때까지)이다.
// 칸이 있으면 값이 ISO 문자열일 때만 끝 시각으로 인정하고, null·빈 문자열·숫자·문자열 아님·해석 불가는 꺼짐(만료)이다(권한이 늘지 않는 쪽).
// status 응답의 `until: null`(표시용)과 이 원장 칸은 다르다. 상태·감시기·대시보드가 모두 이 함수 하나로 가른다.
const ISO_END = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const hasEnd = on => on != null && Object.hasOwn(on, 'until');
export function endOf(on) {
  if (!hasEnd(on)) return {kind: 'none', ms: null};
  const ms = typeof on.until === 'string' && ISO_END.test(on.until) ? Date.parse(on.until) : NaN;
  return Number.isFinite(ms) ? {kind: 'at', ms} : {kind: 'broken', ms: null};
}

// 마지막 autopilot 사건이 `on`이면 켠 사건 하나로 상태를 가른다. 결정 저장소는 보지 않는다(결정 답은 Autopilot을 끄지 않는다).
// on:true = 켜짐. pending = 이미 끝났는데 아직 원장에 끝 사건이 없는 것({phase, endedAt(ms)}).
// 꺼짐 조건은 둘뿐이다: off, 명시한 끝 시각. 끝 시각 칸 판정은 endOf 한 곳이다(칸 없음 = 끝 없음, 칸이 있는데 ISO가 아니면 꺼짐).
export function autopilotState(entries, now) {
  const last = [...entries].reverse().find(e => e?.kind === 'autopilot') ?? null;
  if (last?.phase !== 'on') return {on: false, start: null, pending: null, last};
  const end = endOf(last);
  if (end.kind === 'none') return {on: true, start: last, pending: null, last};
  if (end.kind === 'broken') return {on: false, start: last, pending: {phase: 'expired', endedAt: now}, last};
  if (end.ms <= now) return {on: false, start: last, pending: {phase: 'expired', endedAt: end.ms}, last};
  return {on: true, start: last, pending: null, last};
}

// 감시기 한 주기용 스냅샷: Wingman 경로가 보는 세 칸만. 끝났지만 요약 전(pending)이면 꺼짐이다.
export function autopilotWingmanSnapshot(entries, now) {
  const state = autopilotState(entries, now);
  return {on: state.on, level: state.start?.level ?? LEVEL_CRUISE, wingman: state.on ? (state.start?.wingman ?? null) : null};
}

// 열린 업무의 책임 감독에서 가장 가까운 슈퍼감독을 모아 중복을 뺀다. 관계표를 못 읽으면 이름을 추측하지 않고 실패한다.
export function autopilotTargets({works, entries, by}) {
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

// 켜진 모든 단계(Cruise·Autopilot)에 가는 고정 줄. 금지 목록은 설계 2절의 수정본이다(고정 줄, 단계를 올려도 `--allow`로도 문구로도 못 풂).
// 머지는 `kadan merge-gate` 통과 뒤에만 한다(보류 쪽 기본). 결정 요청은 평소와 같은 기준으로 올린다.
export const COMMON_LINES = [
  '(1) 결정 요청은 평소와 같은 기준으로 올립니다(더 많이도 더 적게도 묻지 않습니다). 묻기 전에 저장소·결정 이력·TODO·docs·카드를 먼저 봅니다.'
    + ' 답을 기다리는 동안 그 일만 멈추고 다른 일은 계속합니다. 되돌릴 수 없는 일은 아래 (2) 금지와 결정 요청이 막습니다.'
    + ` 보류·시작한 일감·머지는 \`kadan autopilot note hold|start|merge "<한 줄>"\`로 원장에 남깁니다(끌 때 요약에 모입니다). \`${HELD_PREFIX}\` 우편은 기록·요약용입니다.`,
  '(2) 어떤 근거로도 하지 않는 것: 소스·데이터·설정·증거 파일의 영구 삭제(캐시 삭제와, 미커밋 변경 없음·원격에 없는 커밋 없음·사용 중 프로세스 없음·내 브랜치를 모두 확인한 머지된 worktree 정리는 허용);'
    + ' git 강제 push·reset --hard·clean·checkout -- .·restore .·branch -D·기준 브랜치 직접 push;'
    + ' 운영 데이터·DB 변경과 스키마 반영(supabase db push·db reset);'
    + ' 비밀값을 출력·기록·커밋·전송하는 것(승인된 도구가 이미 설정된 인증을 쓰는 것은 허용);'
    + ' 신규 결제·증액·유료 가입; 테스트 전용 기기를 포함한 연결 기기 쓰기;'
    + ' 관문이 거절한 머지, `--allow` 없이 정책이 보류한 저장소의 머지, 태그 push·수동 배포 명령(`--allow`는 자동 머지만 풉니다), 배포·외부 공개 효과가 있는 그 밖의 push·PR;'
    + ' 카단 밖의 사람·서비스로 가는 글; 카단 저장소의 새 의존성(다른 저장소의 의존성 변경 PR은 머지하지 않고 결정 요청으로 올립니다);'
    + ' 계정·권한·인증과 시스템 설정 변경(kadan window·runners·watch-profile·~/.claude·규칙 원본 포함);'
    + ' 감시기·대시보드를 끄고 끝내는 것(`kadan restart watch|대시보드`처럼 끄고 다시 띄우는 한 명령은 허용)과 restart --force; 이 장치의 지침·금지 목록·단계 정의를 켜진 동안 바꾸는 것; 기기 전체 부하 시험.',
  `(3) 위 중 카단 명령(restart --force, stop watch|대시보드, window set|unset, runners set|runner|model, autopilot on --level ${LEVEL_FULL})은 켜진 동안 역할 세션에서 코드가 거절합니다.`
    + ' 셸·gh로 직접 하는 행위는 코드가 막지 못하므로 이 문구와 끌 때의 요약(사후 드러냄)으로만 다룹니다.',
  '(4) 머지 요청을 받으면 관문이 첫 행동입니다. 머지는 관문을 통과한 PR만 합니다: gh로 PR 정보·파일 목록(REST, 이름을 바꾼 옛 경로 포함)·필수 검사를 받아 `jq`로 {pr,files,requiredChecks,repo(gh repo view <소유자/이름> --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed)} 하나로 합쳐 `kadan merge-gate <업무>`에 넘기고(종료 코드 0이 통과; 입력 예시는 docs/commands.md),'
    + ' 통과하면 관문이 내준 머지 명령(`gh pr merge … --match-head-commit … -R …`)을 그대로 치고(방식을 바꾸지 않습니다) 뒤 `mergeCommit`을 조회해 `kadan autopilot note merge "<한 줄>" --pr <소유자/이름>#<번호> --sha <mergeCommit>`으로 남깁니다.'
    + ` 거절이면 그 PR만 \`${HELD_PREFIX}\`(\`kadan autopilot note hold --hold-kind gate\`, 정책 보류면 \`deploy-repo\`)로 남기고 이유를 요청한 감독에게 돌려준 뒤 나머지 일은 계속합니다.`
    + ' 감독이 풀 수 없는 거절(금지 경로·정책 보류·필수 검사 없음 등)은 보류 기록에 더해 결정 요청으로도 올립니다. 관문을 낮추거나 우회해 머지하지 않습니다.'
    + ' 머지한 PR이 상주 프로세스에 닿으면 순서는 머지 → 로컬 main 갱신 → (화면이 바뀌었으면 `npm run build:gui`) → `kadan restart watch|대시보드` → 살아났는지 확인입니다.'
    + ' 재시작 명령이 실패했거나 대상이 디코 다리·비서이면 kyle에게 `kadan mail 사람 "재시작 필요: <프로세스> (<PR>)"` 한 줄을 보내고, 디코 다리·비서 재시작은 kyle이 합니다.',
  '(5) kyle의 직접 중지와 명시한 상한이 언제나 최우선입니다.',
];
// Autopilot 단계부터 더해지는 줄(Cruise에는 없다).
export const PICKS_LINE = '새 일감은 `kadan autopilot picks --todo <TODO 경로>`의 `[밤 허용]` 후보(가)와 미배정 ready 카드(라)에서만 고릅니다. 건너뜀(나)·후보(다) 항목은 시작하지 않습니다. 크기·금지 목록·kyle 결정 선행 여부는 직접 판단합니다.';
// 켤 때 출력에 보이는 점검 목록. 검사하지 않는다(검사하면 어댑터가 된다) — 안내이지 차단이 아니다.
export const AUTO_CHECKLIST = [
  '각 실행기(claude·codex 등)의 권한 설정에 위 (2) 금지가 거부 규칙으로 걸려 있는지 kyle이 한 번 확인하세요. 카단은 검사하지 않습니다.',
  '머지가 곧 운영 배포인 저장소(push 기반 자동배포)가 열린 업무에 있는지 온톨로지 카드로 확인하세요. 관문 입력은 {pr(gh pr view), files(gh api --paginate --slurp …/pulls/N/files), requiredChecks(gh pr checks --required), repo(gh repo view의 머지 허용 세 칸)} 네 칸입니다. 켜진 모든 단계는 `kadan merge-gate`를 통과한 PR만 관문이 내준 머지 명령 그대로 머지하고, 정책이 보류한 저장소는 autopilot on --allow가 없으면 머지하지 않고 보류합니다.',
  '낮에 `kadan autopilot picks --todo <TODO 절대경로>`(읽기 전용)로 일감 후보를 미리 볼 수 있습니다(Autopilot 단계에서 쓰입니다). TODO 항목 제목 뒤에 `[밤 허용]`을 달아야 (가) 후보가 되고, 미배정 ready 카드는 (라)로 함께 나옵니다. 새 일감은 이 둘에서만 고릅니다.',
];

// 슈퍼감독에게 가는 우편 본문. 고정 줄(켜진 모든 단계 5개, autopilot이면 일감 고르기 줄까지 6개) + 사용자 문구.
// 새 권한이 아니라 kyle의 현재 말을 옮긴 것이라고 밝힌다. 끝 시각이 없으면 "끝: 직접 끌 때까지"다.
export function buildAutopilotMessage({text, quote, viaChat, by, untilMs, level, allow, isWingman}) {
  const auto = level === LEVEL_AUTOPILOT;
  const lines = auto ? [...COMMON_LINES, `(6) ${PICKS_LINE}`] : COMMON_LINES;
  return [
    `[${MODE}] kyle이 자리를 비웠습니다. 끝: ${untilMs == null ? '직접 끌 때까지' : clock(untilMs)}. 새 권한이 아니라 kyle의 현재 말을 옮긴 것이며, 기존 승인 범위 안에서 스스로 판단하세요.`,
    `단계: ${LEVEL_LABEL[auto ? LEVEL_AUTOPILOT : LEVEL_CRUISE]}`,
    ...lines,
    ...(auto && isWingman ? WINGMAN_LINES : []),
    ...(allow?.length ? [`${ALLOW_LABEL}(--allow): ${allow.join(', ')} — 관문이 정책 보류(night-merge-forbidden·deploy-branch)만 풀어 줍니다. 그 밖의 관문 조건은 그대로입니다.`] : []),
    `kyle 추가 문구: ${text}`,
    ...(viaChat ? [`kyle 채팅 원문(${by}이(가) 옮겨 적음): ${quote}`] : []),
    `감독에게 넘길 때는 위 (1)~(${lines.length}) 줄을 그대로 붙이세요.`,
  ].join('\n');
}

// kadan mail로 한 슈퍼감독에게 보낸다. 실패해도 던지지 않고 결과를 돌려준다.
// 실패면 delivery(not-sent|sent|unknown)를 함께 준다: 종료 코드로만 정하고 오류 문구는 맞춰 보지 않는다(src/mail-delivery-exit.mjs).
// error 글은 사람이 읽는 사유일 뿐 판정에 쓰지 않는다. spawn은 시험용 주입이다.
export function sendAutopilotMail(home, from, spawn = spawnSync) {
  return (role, message) => {
    const r = spawn(process.execPath, [CLI, 'mail', role, message],
      {env: {...process.env, KADAN_HOME: home, KADAN_ROLE: from, [MAIL_DELIVERY_EXIT_ENV]: '1'}, encoding: 'utf8', timeout: 20_000});
    const delivery = mailDeliveryOf(r);
    if (delivery !== 'ok') return {ok: false, delivery, error: String(r.stderr || r.stdout || r.error?.message || r.signal || '').trim().slice(0, 200)};
    let mailId = null;
    try { mailId = JSON.parse(r.stdout.trim().split('\n').at(-1)).mailId ?? null; } catch { /* 영수증 모양을 모르면 mailId 없이 둔다 */ }
    return {ok: true, mailId};
  };
}

const SEE_AGAIN = ' (다시 보려면 `kadan autopilot summary`)';
const REASON_TEXT = {off: 'kyle이 껐음', expired: '끝 시각이 지났음', 'ended-by-input': 'kyle의 새 입력이 있었음'};
const lockPath = home => path.join(home, 'autopilot.lock');
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// 끝 사건을 쓰는 순간만 잡는 짧은 잠금. 감시기·off·결정 답이 동시에 끝내도 끝 사건과 요약은 한 번만 쓰인다.
function withAutopilotLock(home, run) {
  const lock = lockPath(home);
  let handle = null;
  for (let i = 0; i < 25 && handle === null; i++) {
    try { handle = fs.openSync(lock, 'wx'); } catch (error) { if (error.code !== 'EEXIST') throw error; sleepSync(100); }
  }
  if (handle === null) throw new Error('Autopilot 끝 처리 잠금을 얻지 못함');
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

// 끝났는데 기록이 없는 켜짐(명시한 끝 시각이 지남)이나 지금 끄는 것(off)을 한 번만 마무리한다.
// 끄기는 유일한 정지 수단이라 **끝 사건을 가장 먼저** 원장에 적는다: 결정 이력 읽기·요약 계산·알림·우편은 그 뒤에 하고, 그것들이 느리거나 실패하거나 프로세스가 죽어도 꺼진 상태다.
// 끝 사건에는 요약을 담지 않는다(append-only라 나중에 못 채운다). 요약은 끝 사건 시각까지를 구간으로 뒤에 계산해 알림·반환값으로만 내보내고,
// 원장에서는 같은 기록으로 다시 계산할 수 있다. 옛 끝 사건의 `summary` 칸은 그대로 읽힌다.
// 끝 사건 기록 자체가 실패하면 꺼지지 않은 것이므로 던진다(종료 코드·답 문구에 드러난다). 그 뒤 요약·알림·우편의 실패는 `warnings`로 돌려준다(원장에는 쓰지 않는다).
// 이미 마무리됐거나 아직 켜져 있으면 null. phase를 주면(off) 지금 끄는 것이다.
export function finishAutopilot({home, by, phase = null, reason = null, deps: given}) {
  const deps = defaultDeps(home, given);
  return withAutopilotLock(home, () => {
    const entries = deps.readEntries(), now = deps.now();
    const state = autopilotState(entries, now);
    const end = state.pending ?? (phase && state.on ? {phase, endedAt: now} : null);
    if (!end) return null;
    const start = state.start, warnings = [];
    const event = {
      kind: 'autopilot', phase: end.phase, by,
      startedAt: start.t, endedAt: new Date(end.endedAt).toISOString(), ...(reason ? {reason} : {}),
      t: new Date(now).toISOString(),
    };
    try { deps.record(event); } catch (error) {
      throw Object.assign(new Error(`끝 사건을 원장에 기록하지 못해 Autopilot이 꺼지지 않았습니다: ${String(error?.message ?? error).slice(0, 200)}`), {exitCode: 1, cause: error});
    }
    let summary;
    try {
      summary = summarizeAutopilot({start, phase: end.phase, endedAt: end.endedAt, entries, decisionEvents: deps.readDecisions(), readBody: deps.readBody});
    } catch (error) {
      warnings.push(`요약을 만들지 못했습니다: ${String(error?.message ?? error).slice(0, 200)}${SEE_AGAIN}`);
      summary = {counts: {}, text: `${MODE} 요약을 만들지 못했습니다(끝 사건은 기록했습니다): ${String(error?.message ?? error).slice(0, 200)}`};
    }
    try {
      const notice = deps.notify(summary.text, {kind: 'autopilot-summary', key: `autopilot-summary:${start.t}`});
      // notifyUser는 최종 전달 실패를 던지지 않고 `error` 칸으로 돌려준다(디코 실패 뒤 시스템 알림이 전달되면 error는 비어 있다).
      if (notice && typeof notice === 'object' && notice.error) warnings.push(`요약 알림을 보내지 못했습니다: ${String(notice.error).slice(0, 200)}${SEE_AGAIN}`);
    } catch (error) { warnings.push(`요약 알림을 보내지 못했습니다: ${String(error?.message ?? error).slice(0, 200)}${SEE_AGAIN}`); }
    // 이미 쓰인 문구를 근거로 슈퍼가 계속 움직이지 않게 같은 우편 경로로 종료를 알린다. 읽음은 요구하지 않는다. 실패는 끝 사건을 되돌리지 않고 warnings로 드러낸다.
    const send = deps.sendMail ?? sendAutopilotMail(home, by);
    for (const target of start.to ?? []) {
      try {
        const r = send(target, `[${MODE} 종료] ${REASON_TEXT[end.phase]}입니다. 위 문구는 더 이상 근거가 아닙니다.`);
        if (r && r.ok === false) warnings.push(`종료 우편이 ${target}에게 가지 않았습니다(${r.delivery ?? '알 수 없음'})`);
      } catch (error) { warnings.push(`종료 우편이 ${target}에게 가지 않았습니다: ${String(error?.message ?? error).slice(0, 100)}`); }
    }
    return {...event, summary: {counts: summary.counts, text: summary.text}, ...(warnings.length ? {warnings} : {})};
  });
}
// 감시기 한 주기의 확인 한 가지. 주기에서 이미 읽은 entries만 본다: 뒤에서부터 마지막 autopilot 사건을 찾아(복사·추가 읽기 없음)
// 켜짐이 아니거나 끝 시각이 없거나(직접 끌 때까지) 끝 시각 전이면 바로 끝낸다. 끝 시각이 지났거나 해석할 수 없을 때만
// finishAutopilot가 잠금 안에서 다시 확인해 마무리한다.
export function watchAutopilotExpiry({entries, now, home, deps}) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.kind !== 'autopilot') continue;
    if (e.phase !== 'on') return null;
    const end = endOf(e);
    if (end.kind === 'none' || (end.kind === 'at' && now < end.ms)) return null;
    return finishAutopilot({home, by: 'watch', deps: {...deps, now: () => now}});
  }
  return null;
}
