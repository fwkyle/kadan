// 비서가 다시 뜰 때(재개·자동 시작·restart) 로티 탭을 하나만 붙인다 (2026-11-13 [kyle]).
// 판정은 하나다: 기계 설정이 rottie이고 로티가 실제로 살아 있을 때만 연다. 폴백 체인이 아니다.
// 실패·시간 초과·로티 없음·모름은 모두 "열지 않음"이고 비서 시작은 그대로 성공이다(숨김으로 기록).
// 로티 호출은 status·terminal show/create/remove뿐이라 앱을 앞으로 가져오지 않는다(assertRottieArgv).
import {spawnSync} from 'node:child_process';
import {readWindowSetting} from './window-setting.mjs';
import {rottieConnectivity, showRottieWindow, removeRottieWindow, openWindow} from './floor-tmux.mjs';
import {currentRottieWindow} from './restore.mjs';

const ALIVE_STATES = new Set(['running', 'created']);
// 로티가 "이 탭은 끝났다"고 확정해 주는 상태만 교체한다. unknown·빈 값·처음 보는 값은 모르는 것이라 열지 않는다.
const DEAD_STATES = new Set(['exited']);
export const TAB_CALL_TIMEOUT_MS = 5000; // 로티 호출 한 번의 상한. 1분마다 도는 길이라 짧게 둔다.

const bounded = (run = spawnSync) => (bin, args, options) => run(bin, args, {...options, timeout: TAB_CALL_TIMEOUT_MS});

// 열지 말지만 정한다(읽기 전용). 이유 낱말은 시험·로그용이다.
// auto: `kadan up --auto`로 불렸다(launchd 전용 인자). 이때만 KADAN_WINDOW=none(FORCE 유무 무관)을 "로티가 없을 수 있다"로 읽는다.
// `--auto` 없이 사람이 셸에서 정한 KADAN_WINDOW=none은 FORCE가 있어도 존중한다. 사람이 셸에서 `kadan up --auto`를 직접 치면 launchd와 구별되지 않아 같은 취급이다.
export function planSecretaryTab({env = process.env, auto = false, setting, entries, session, connect, show}) {
  if (setting?.window !== 'rottie' || !setting.rottieBin) return {open: false, reason: 'setting-not-rottie'};
  // `up --auto`는 launchd만 부른다. 운영에 깔린 옛 plist는 KADAN_WINDOW=none만 있고 FORCE가 없으므로 FORCE는 보지 않는다
  // (2026-11-13 실측: FORCE를 요구해 보조 경로가 운영에서 한 번도 안 돌았다). `--auto` 없는 사람의 none은 그대로 존중한다.
  const forced = env.KADAN_WINDOW === 'none' && auto;
  if (env.KADAN_WINDOW && env.KADAN_WINDOW !== 'rottie' && !forced) {
    return {open: false, reason: `env-window-${env.KADAN_WINDOW}`};
  }
  const connection = connect(setting.rottieBin);
  if (!connection.ok) return {open: false, reason: 'rottie-unavailable', connection};
  const current = currentRottieWindow(entries, session);
  if (!current) return {open: true, connection};
  // 이을 탭이 있으면 그 탭이 살아 있는지 로티에 묻는다. 모르면 열지 않는다(탭 둘이 되는 쪽이 틀린 방향).
  const shown = show(current.rottieTerminalId);
  if (shown.ok) {
    if (ALIVE_STATES.has(shown.state)) return {open: false, reason: 'tab-alive', connection};
    return DEAD_STATES.has(shown.state)
      ? {open: true, connection, replace: {terminalId: current.rottieTerminalId, state: shown.state}}
      : {open: false, reason: 'tab-unknown', connection};
  }
  return shown.code === 'ROTTIE_TERMINAL_NOT_FOUND'
    ? {open: true, connection, replace: {terminalId: current.rottieTerminalId, state: '없음'}}
    : {open: false, reason: 'tab-unknown', connection};
}

// 탭 하나를 열고 결과를 돌려준다. 던지지 않는다. 열지 않았거나 실패하면 {window: 'hidden'}이다.
export function openSecretaryTab({home, env = process.env, auto = false, quiet = false, entries, session, role, cwd, panePid,
  platform = process.platform, run = spawnSync, readSetting = readWindowSetting, open = openWindow}) {
  try {
    if (platform !== 'darwin') return {window: 'hidden', reason: 'not-darwin'};
    const spawnFn = bounded(run);
    const setting = readSetting(home);
    const plan = planSecretaryTab({env, auto, setting, entries, session,
      connect: bin => rottieConnectivity({bin, spawnFn}),
      show: terminalId => showRottieWindow({bin: setting.rottieBin, terminalId, spawnFn})});
    if (!plan.open) return {window: 'hidden', reason: plan.reason};
    // 조용한 호출(자동 주기)은 화면에 찍지 않고 열기 함수의 구체 이유(로티 오류 코드)만 모아 돌려준다.
    const notes = [];
    const opened = open(session, platform, {choice: {kind: 'rottie'}, rottieBin: setting.rottieBin, spawnFn,
      role, cwd, panePid, ...(quiet ? {warn: message => notes.push(String(message))} : {})});
    if (!opened?.rottieTerminalId) {
      return {window: 'hidden', reason: 'open-failed', ...(notes.length ? {detail: notes.join('; ')} : {})};
    }
    if (plan.replace && plan.replace.state !== '없음') {
      // 죽은 옛 탭은 한 번 지워 본다. 실패해도 알리기만 한다(restore와 같다).
      try { removeRottieWindow({bin: setting.rottieBin, terminalId: plan.replace.terminalId, spawnFn}); } catch { /* 목록에 종료됨으로 남을 뿐 */ }
    }
    return {window: 'rottie', rottieTerminalId: opened.rottieTerminalId, reason: 'opened',
      rottieBundleId: plan.connection.bundleId, rottieConnect: 'ok',
      ...(plan.replace ? {restoredFrom: plan.replace.terminalId, oldState: plan.replace.state} : {})};
  } catch (error) {
    return {window: 'hidden', reason: `error: ${error.message}`};
  }
}

function inheritsOnlyOldTab(entries, session) {
  const own = entries.filter(e => e.session === session);
  const start = own.findLast(e => e.kind === 'start');
  return start?.window === 'hidden' && Boolean(start.rottieTerminalId)
    && !own.slice(own.lastIndexOf(start) + 1).some(e => e.kind === 'window' && e.rottieTerminalId);
}

// 로티 없이 숨김으로 뜬 비서에 로티가 뜬 뒤 탭을 한 번 붙인다(`up --auto` 주기에서). 탭 기록이 이미 있으면 아무것도 하지 않는다
// (사람이 닫은 탭을 다시 열지 않는다). 성공하면 window 사건 하나만 남기고, 실패는 아무것도 기록하지 않는다.
// readEntries는 함수다: 기계 설정이 rottie일 때만 원장을 읽어, 로티를 안 쓰는 기계는 매분 원장을 읽지 않는다.
export function attachHiddenSecretary({home, floor, session, readEntries, record, env = process.env, auto = true,
  open = openSecretaryTab, readSetting = readWindowSetting}) {
  try {
    if (readSetting(home)?.window !== 'rottie') return {attached: false, reason: 'setting-not-rottie'};
    const entries = readEntries();
    // 이어받은 옛 탭 ID(숨김으로 뜬 세대에 남은 것)는 탭이 있다는 뜻이 아니다. 로티에 물어 닫힌 탭이면 붙인다.
    // 이 세대에 실제로 연결한 탭(start가 rottie이거나 그 뒤 window 사건)은 사람이 닫았어도 다시 열지 않는다.
    if (currentRottieWindow(entries, session) && !inheritsOnlyOldTab(entries, session)) {
      return {attached: false, reason: 'has-tab'};
    }
    const start = entries.findLast(e => e.kind === 'start' && e.session === session);
    if (!start || entries.slice(entries.lastIndexOf(start) + 1).some(e => e.session === session && e.kind === 'stop')
      || String(floor.pid(session)) !== String(start.panePid)) return {attached: false, reason: 'generation-unclear'};
    const result = open({home, env, auto, quiet: true, entries, session, role: start.role, cwd: start.cwd, panePid: start.panePid});
    if (result.window !== 'rottie') {
      return {attached: false, reason: result.reason, ...(result.detail ? {detail: result.detail} : {})};
    }
    record({kind: 'window', role: start.role, session, rottieTerminalId: result.rottieTerminalId,
      panePid: start.panePid, by: 'autostart'});
    return {attached: true, rottieTerminalId: result.rottieTerminalId};
  } catch (error) {
    return {attached: false, reason: `error: ${error.message}`};
  }
}

// 자동 주기에서 사람이 알아야 하는 실패·건너뜀만 한 줄로 만든다. 정상 건너뜀(탭 있음·로티 없음·설정 none 등)은 null.
// 이 줄은 `up --auto`의 changedOutput(revive-state.json의 lastOutput)을 지나므로 같은 원인은 처음 한 번만 autostart.log에 남고,
// 성공이나 다른 원인이 오면 다시 한 번 남는다. 상태가 파일이라 감시기·up 재시작·launchd 새 프로세스에도 유지된다.
export function attachFailureLine(result) {
  if (!result || result.attached) return null;
  const reason = String(result.reason);
  if (reason.startsWith('env-window-')) {
    return `비서 로티 탭 붙이기 건너뜀: KADAN_WINDOW=${reason.slice('env-window-'.length)}라 자동 연결하지 않음`;
  }
  if (reason === 'rottie-unavailable') return '비서 로티 탭 붙이기 건너뜀: 로티가 응답하지 않음(켜지면 자동으로 붙임)';
  const reportable = reason === 'open-failed' || reason === 'tab-unknown' || reason.startsWith('error:');
  return reportable ? `비서 로티 탭 붙이기 실패: ${result.detail ?? result.reason}` : null;
}
