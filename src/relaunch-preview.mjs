// Why: 기본 프리셋·프리셋 안 값·업무 프리셋을 바꾸면 떠 있는 작업자·검수자 가운데 일부가 "옛 세션"이 되어 다음 발령이 거절된다.
// 바꾼 바로 그 자리에서 "다시 띄워야 할 살아 있는 작업자·검수자"를 보여 준다(2026-11-27 [kyle]). 막지 않고 보여 주기만 한다.
//
// 판정은 실제 발령 거절과 같은 함수를 쓴다: 세션 값은 inspectCardSendIdentity, 기대값 대조는 inspectDispatchRunnerGuard.
// 발령이 넘기는 것과 같은 재료(업무의 프리셋, 업무 연결 여부)를 넘기므로 여기서 "다시 띄워야 함"이면 발령도 거절된다.
// 카드 한 장을 정하지 않고 보므로 카드 단계 대조(작업 카드를 검수자 세션에 보냄)는 여기서 보지 않는다.
//
// 보는 짝: (살아 있는 작업자·검수자 세션, 그 세션이 붙은 열린 업무). 붙었다는 것은 그 업무의 실행 카드에 배정됐거나
// `start --work <업무>`로 띄운 것이다. 열린 업무가 하나도 없는 세션은 "업무 밖 카드" 기준으로 한 번 본다.
//
// 비용(명령 한 번에 한 번, 상주 주기 경로가 아니다): 원장의 start·stop·window 사건 읽기 1번 + 업무마다 최신 판 한 줄
// + 열린 업무의 실행 카드마다 최신 판 한 줄 + 바닥 세션 목록 1번 + 살아 있는 작업자·검수자마다 PID 확인.
// 업무가 10배면 읽는 업무·카드 줄이 10배다(이력 길이와는 무관). 원장이 10배면 시작·종료 사건 읽기가 10배다.
import {readSettings} from './runner-settings.mjs';
import {readRecoveryLedger} from './ledger.mjs';
import {streamHeads} from './storage.mjs';
import {readWorkHeads, isOpenWork} from './work-heads.mjs';
import {inspectCardSendIdentity} from './ai-identity.mjs';
import {GUARDED_PROFILES, inspectDispatchRunnerGuard, resolveGuardPreset} from './dispatch-runner-guard.mjs';

const WATCHED_ROLES = ['worker', 'reviewer', 'worker-hard'];
const HEADS_CHUNK = 500;

// 발령 검사가 읽는 값만 뽑은 지문. 이 값이 그대로면(예: 즐겨찾기·감독 값만 바뀜) 미리 보기를 계산하지 않는다.
function dispatchBasis(settings) {
  const pick = values => Object.fromEntries(WATCHED_ROLES.map(role => [role, values?.[role] ?? null]));
  return JSON.stringify({
    active: settings.activePreset,
    presets: Object.entries(settings.presets).map(([name, preset]) => [name, pick(preset.roles), pick(preset.fallback)]),
    spawn: Object.entries(settings.runners ?? {}).map(([name, spec]) => [name, spec?.spawn ?? null]),
    compare: settings.compare?.enabled === true ? settings.compare.presets : null,
  });
}

// 바닥의 세션 목록을 한 번 읽어 생존을 본다(끄지 않은 채 사라진 옛 세션이 많아도 바닥 호출은 한 번이다).
// 목록을 못 읽으면(바닥 서버가 없음 등) 세션마다 따로 묻는다 — 발령이 쓰는 것과 같은 생존 확인이다.
function aliveCheck(floor) {
  if (typeof floor.list !== 'function') return session => floor.alive(session);
  try {
    const live = new Set(floor.list({strict: true}).filter(s => s.alive !== false).map(s => s.session));
    return session => live.has(session);
  } catch { return session => floor.alive(session); }
}

// 끄지 않은 작업자·검수자 세션 가운데 바닥에 살아 있는 것. 세션마다 자기 start·stop 기록만 묶어 둔다.
function liveSessions(entries, floor) {
  const bySession = new Map();
  for (const entry of entries) {
    if ((entry?.kind !== 'start' && entry?.kind !== 'stop') || typeof entry.session !== 'string') continue;
    if (!bySession.has(entry.session)) bySession.set(entry.session, []);
    bySession.get(entry.session).push(entry);
  }
  const live = [], alive = aliveCheck(floor);
  for (const [session, own] of bySession) {
    const last = own.at(-1);
    if (last.kind === 'stop' || !own.some(e => e.kind === 'start' && GUARDED_PROFILES.includes(e.roleProfile))) continue;
    if (!alive(session)) continue;
    live.push({session, entries: own, pid: floor.pid(session)});
  }
  return live;
}

// 열린 업무의 실행 카드에 배정된 역할: 역할 → 업무 목록. 카드는 최신 판 한 줄만 읽는다.
function assignedWorks(home, works) {
  const streamOf = key => `cards/${key}/events.jsonl`;
  const streams = [...new Set(works.flatMap(work => (work.executions ?? []).map(link => streamOf(link.key))))];
  const roles = new Map();
  for (let i = 0; i < streams.length; i += HEADS_CHUNK) {
    for (const [stream, head] of streamHeads(home, streams.slice(i, i + HEADS_CHUNK))) {
      const role = JSON.parse(head.payload).role;
      if (typeof role === 'string' && role.trim()) roles.set(stream, role.trim());
    }
  }
  const byRole = new Map();
  for (const work of works) {
    for (const link of work.executions ?? []) {
      const role = roles.get(streamOf(link.key));
      if (!role) continue;
      if (!byRole.has(role)) byRole.set(role, new Map());
      byRole.get(role).set(work.key, work);
    }
  }
  return byRole;
}

// workKey를 주면 그 업무에 붙은 세션만 본다(work update --preset).
export function relaunchPreview({home, floor, workKey = null, readEntries = readRecoveryLedger}) {
  let settings, settingsError = null;
  try { settings = readSettings(home); } catch (error) { settingsError = error; }
  const readSettingsFn = () => { if (settingsError) throw settingsError; return settings; };
  const works = readWorkHeads(home).filter(work => isOpenWork(work) && (!workKey || work.key === workKey));
  const byKey = new Map(works.map(work => [work.key, work]));
  const assigned = assignedWorks(home, works);
  const out = {settingsRevision: settings?.revision ?? null, checked: 0, ok: 0, relaunch: [], fallbackOk: []};
  for (const live of liveSessions(readEntries(home), floor)) {
    const identity = inspectCardSendIdentity({entries: live.entries, session: live.session, currentPid: live.pid});
    const profile = identity.ok ? identity.launch.roleProfile : null;
    if (!GUARDED_PROFILES.includes(profile)) continue;
    const role = identity.launch.role;
    const mine = new Map(assigned.get(role) ?? []);
    const startedFor = byKey.get(identity.launch.presetWorkKey);
    if (startedFor) mine.set(startedFor.key, startedFor);
    if (workKey && !mine.size) continue;
    for (const work of mine.size ? mine.values() : [null]) {
      const workPreset = work?.preset ?? null, hasWork = Boolean(work);
      const guard = inspectDispatchRunnerGuard({home, role, session: live.session, profile, identity, workPreset, hasWork, readSettingsFn});
      out.checked++;
      const item = {
        role, session: live.session, profile, work: work?.key ?? null,
        preset: resolveGuardPreset({settings, identity, workPreset, hasWork}).preset,
        have: `${identity.harness} · ${identity.model}`,
      };
      if (guard.result === 'reject') {
        // 거절 문구는 발령 검사가 만든 것을 그대로 쓴다: 첫 줄이 이유, '조치: ' 줄이 다시 띄우는 명령이다.
        const lines = guard.message.split('\n');
        out.relaunch.push({...item, code: guard.code, reason: lines[0].replace(/^카드 발령 거절: /, ''),
          action: (lines.find(line => line.startsWith('조치: ')) ?? '').replace(/^조치: /, '').replace(/ \(의도한 예외면 [^)]*\)$/, '')});
      } else if (guard.result === 'warn' && guard.code === 'fallback') {
        out.fallbackOk.push({...item, fallbackIndex: guard.ledger.fallbackIndex});
      } else out.ok++;
    }
  }
  return out;
}

// 설정을 바꾼 뒤 부른다. before는 바꾸기 전에 읽어 둔 설정이다.
// before가 없거나(처음 만드는 init — 바뀐 것이 아니다) 발령 검사가 읽는 값이 그대로면 null,
// 계산에 실패하면 {error}를 돌려준다. 던지지 않는다 — 설정 저장은 이미 끝났다.
export function previewAfterSettingsChange(home, before, {floor, readEntries} = {}) {
  if (!floor || !before) return null;
  try {
    const after = readSettings(home);
    if (!after || dispatchBasis(before) === dispatchBasis(after)) return null;
    const preview = relaunchPreview({home, floor, ...(readEntries ? {readEntries} : {})});
    return before.activePreset !== after.activePreset
      ? {...preview, activeChanged: {from: before.activePreset, to: after.activePreset}} : preview;
  } catch (error) { return {error: error.message}; }
}

// 설정을 바꾸기 전에 읽어 둔다. 없거나 못 읽으면 null(바꾸는 명령 자체가 거절되거나 처음 만드는 경우다).
export function settingsBefore(home) {
  try { return readSettings(home); } catch { return null; }
}

// 사람이 읽는 줄(stderr). JSON 결과에는 같은 내용이 relaunchPreview 칸으로 실린다.
export function relaunchLines(preview) {
  if (!preview) return [];
  if (preview.error) return [`다시 띄울 세션 미리 보기 실패(저장은 끝났다): ${preview.error}`];
  const lines = [];
  if (preview.activeChanged) {
    const {from, to} = preview.activeChanged;
    lines.push(`기본 프리셋 ${from} → ${to}: 지금부터 만드는 업무는 ${to}에 고정된다. 이미 만든 업무는 적어 둔 프리셋 그대로다.`);
  }
  const where = item => item.work ? `업무 ${item.work}` : '열린 업무 없음(업무 밖 카드 기준)';
  const head = item => `  ${item.role}(${item.profile} · ${item.have}) — ${where(item)} · 기준 프리셋 ${item.preset ?? '모름'}`;
  if (preview.relaunch.length) {
    lines.push(`다시 띄워야 할 작업자·검수자 ${preview.relaunch.length}개(바뀐 뒤 기준 — 지금 발령하면 거절된다. 이 명령은 막지 않았다):`);
    for (const item of preview.relaunch) {
      const byWork = item.work && /--preset /.test(item.action) ? ` · --preset 대신 --work ${item.work}도 같다` : '';
      lines.push(`${head(item)}: ${item.reason} · 조치: ${item.action}${byWork}`);
    }
  }
  if (preview.fallbackOk.length) {
    lines.push(`다시 띄울 필요 없음(대체 후보) ${preview.fallbackOk.length}개:`);
    for (const item of preview.fallbackOk) lines.push(`${head(item)} 대체 후보 ${item.fallbackIndex}번`);
  }
  if (!preview.relaunch.length && !preview.fallbackOk.length) {
    lines.push(`다시 띄울 작업자·검수자 없음(살아 있는 세션·업무 짝 ${preview.checked}개 확인)`);
  } else if (preview.ok) lines.push(`그대로 쓰는 세션·업무 짝 ${preview.ok}개`);
  return lines;
}
