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

// 슈퍼감독에게 가는 우편 본문. 고정 줄 3개 + 사용자 문구. 새 권한이 아니라 kyle의 현재 말을 옮긴 것이라고 밝힌다.
export function buildNightMessage({text, quote, viaChat, by, untilMs}) {
  return [
    `[나이트 모드] kyle이 취침 중입니다. 끝: ${clock(untilMs)} 또는 kyle 새 입력. 새 권한이 아니라 kyle의 현재 말을 옮긴 것이며, 기존 승인 범위 안에서 스스로 판단하세요.`,
    '(1) 되돌리기 어려운 것(운영 데이터 변경·삭제, push 정책, 외부 공개, 새 의존성)은 kyle 기상 뒤로 보류합니다.',
    `(2) 보류 대상은 밤중에 decision request를 새로 올리지 말고 보류로 남깁니다: kadan mail 사람 "${HELD_PREFIX} <한 줄>". 아침 요약에 모입니다.`,
    '(3) 위임 범위 안의 일은 결정 요청을 올리지 말고 스스로 처리합니다.',
    `kyle 추가 문구: ${text}`,
    ...(viaChat ? [`kyle 채팅 원문(${by}이(가) 옮겨 적음): ${quote}`] : []),
    '감독에게 넘길 때는 위 (1)~(2) 줄을 그대로 붙이세요.',
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
