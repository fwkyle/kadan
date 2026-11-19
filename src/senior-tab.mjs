// 시니어 따라 보기 탭 — 로티에 읽기 전용 탭을 띄워 진행 출력을 보여 준다(2026-10-16 [kyle]).
// 헤드리스 호출의 탭은 호출이 끝나면 닫는다. 대화형 호출의 탭은 세션과 함께 남겨 두고(2026-11-19 [kyle]) 그 세션을 끌 때
// (정리 명령·남긴 세션 내보내기) 닫는다(closeKeptTab).
// 탭은 꾸밈이다: 어떤 실패도 던지지 않고 건너뜀 사유로 돌려준다. 역할이 아니므로 KADAN_ROLE·kadan-* 이름·start 원장 사건을 쓰지 않는다.
// 로티 호출은 rottie-cli의 runRottie 길목(운영 로티 보호 포함)을 그대로 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {effectiveWindow} from './window-setting.mjs';
import {assertNotLiveRottie} from './live-floor-guard.mjs';
import {parseRottieCreateEvidence, runRottie} from './rottie-cli.mjs';

// 'on'이면 켜고 'off'면 끈다. 없으면 SENIOR_TAB_DEFAULT_ON을 따른다.
// 로티 terminal create에는 포커스를 끄는 옵션이 없다. 2026-10-16 실측(docs/senior.md)에서 로티가 맨 앞으로 오지 않아 기본은 켬이다.
// 로티가 앞으로 오는 것이 확인되면 false로 바꿔 실패 닫힘(자동 열기 끔)으로 돌린다.
// 로티에 포커스 없는 create 옵션이 생기면 buildSeniorTabCreateArgv에 그 옵션을 붙인다.
export const SENIOR_TAB_ENV = 'KADAN_SENIOR_TAB';
export const SENIOR_TAB_DEFAULT_ON = true;

const shellWord = value => /^[A-Za-z0-9_@%+:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`;
// 복구 근거: 호출 폴더의 tab.json. create 전에 키를 먼저 쓰고 결과가 나올 때마다 갱신한다(동기). 쓰기 실패는 삼킨다.
// 사람은 이 key로 로티에서 그 탭을 직접 닫는다. 제목·키로 목록을 뒤져 자동으로 지우지는 않는다.
export function writeTabState(dir, state) {
  try {
    const file = path.join(dir, 'tab.json');
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 처음 쓴다 */ }
    fs.writeFileSync(file, JSON.stringify({...prev, ...state, at: new Date().toISOString()}), {mode: 0o600});
  } catch { /* 꾸밈이다 */ }
}

const reasonOf = error => error?.code || error?.message || String(error);

export function seniorTabEnabled(env) {
  const value = env[SENIOR_TAB_ENV];
  return value === 'on' ? true : value === 'off' ? false : SENIOR_TAB_DEFAULT_ON;
}

export function buildSeniorTabCreateArgv({card, adviceId, command, suffix}) {
  return ['terminal', 'create', '--workspace', card.repoPath, '--title', `시니어 · ${card.key}${suffix ? ` · ${suffix}` : ''}`,
    '--command', command, '--idempotency-key', `kadan-senior-${adviceId}`, '--json'];
}

export function seniorAttachCommand(seat) {
  return `tmux -L ${shellWord(seat.socket)} attach -r -t ${shellWord('=' + seat.session)}`;
}

// 열린 탭은 같은 call(argv)로 닫는다. 생성 여부를 모르면 복구용 키만 남긴다.
export function openSeniorTab({home, env, card, adviceId, dir, seat, followScript,
  parentPid = process.pid, rottie, suffix}) {
  try {
    if (!seniorTabEnabled(env)) return {tab: 'skipped', tabReason: 'tab-off'};
    const setting = effectiveWindow(env, home);
    if (setting.window.value !== 'rottie') return {tab: 'skipped', tabReason: 'window-none'};
    const bin = setting.rottieBin.value;
    if (!bin) return {tab: 'skipped', tabReason: 'rottie-bin-missing'};
    // 가드는 KADAN_HOME으로 기본 홈 여부를 가린다. 호출자가 env에 안 넣었어도 이번 호출의 홈으로 판정한다.
    const runEnv = {...env, KADAN_ROTTIE_BIN: bin, KADAN_HOME: home};
    assertNotLiveRottie(runEnv);
    const call = rottie ?? (argv => runRottie(argv, spawnSync, runEnv));
    const command = seat ? seniorAttachCommand(seat) : `/bin/bash ${shellWord(followScript)} ${shellWord(dir)} ${parentPid}`;
    // workspace가 로티에 열려 있지 않으면(ROTTIE_WORKSPACE_NOT_OPEN) 새로 추가하지 않고 건너뛴다.
    const argv = buildSeniorTabCreateArgv({card, adviceId, command, suffix});
    const key = argv[argv.indexOf('--idempotency-key') + 1];
    writeTabState(dir, {key, state: 'creating'});
    let envelope;
    try { envelope = call(argv); } catch (error) {
      // skipped는 생성이 없었다고 확실할 때만(typed 오류이면서 effect none)이다. JSON 응답 없이 끝난 경우는
      // 종료 코드·신호와 무관하게 탭이 생겼을 수 있으므로 unknown이다. 제목으로 뒤져 지우지 않고 키만 남긴다.
      if (error?.effect === 'none' && error?.code !== 'ROTTIE_JSON_PARSE') {
        writeTabState(dir, {state: 'skipped', reason: reasonOf(error)});
        return {tab: 'skipped', tabReason: reasonOf(error)};
      }
      writeTabState(dir, {state: 'unknown', reason: reasonOf(error)});
      return {tab: 'unknown', tabReason: reasonOf(error), tabKey: key};
    }
    try {
      const id = parseRottieCreateEvidence(envelope).rottieTerminalId;
      writeTabState(dir, {state: 'opened', rottieTerminalId: id});
      return {tab: 'opened', rottieTerminalId: id, call, tabKey: key};
    } catch (error) {
      writeTabState(dir, {state: 'unknown', reason: reasonOf(error)});
      return {tab: 'unknown', tabReason: reasonOf(error), tabKey: key};
    }
  } catch (error) {
    return {tab: 'skipped', tabReason: reasonOf(error)};
  }
}

// 닫고, 닫힌 탭이 목록에 남아 있으면 자기가 만든 탭만 remove한다. 실패해도 던지지 않는다.
export function closeSeniorTab(opened) {
  const {call, rottieTerminalId: id} = opened;
  const target = ['--terminal', id, '--json'];
  try {
    call(['terminal', 'close', ...target]);
  } catch (error) {
    return {tab: 'close-failed', tabReason: reasonOf(error)};
  }
  // show가 NOT_FOUND일 때만 사라진 것이다. 다른 오류는 남았는지 모르므로 자기 id를 remove해 본다(재시도는 없다).
  let reason = 'removed-after-close';
  try { call(['terminal', 'show', ...target]); } catch (error) {
    if (error?.code === 'ROTTIE_TERMINAL_NOT_FOUND') return {tab: 'closed'};
    reason = `removed-after-show-error: ${reasonOf(error)}`;
  }
  try {
    call(['terminal', 'remove', ...target]);
    return {tab: 'closed', tabReason: reason};
  } catch (error) {
    return {tab: 'close-failed', tabReason: `remove: ${reasonOf(error)}`};
  }
}

// ---- 닫을 탭 표지 ----
// 남겨 둔 탭은 연 호출이 끝난 뒤에 닫는다. 그 세션이 이미 없어도(내보낼 때 닫지 못함·재부팅) 다음 정리 명령이 탭을 찾을 수 있게,
// 홈의 작은 폴더(`senior-open-tabs/`)에 탭마다 표지 파일 하나를 둔다. 원장·advice 폴더 전체를 훑지 않는다.
//  - 만든다: 대화형 호출이 탭을 열었을 때, 그리고 닫으려다 닫지 못했을 때(건너뜀·실패). 지운다: 닫혔을 때만.
//  - 파일 하나가 탭 하나라 여러 호출이 동시에 써도 서로 덮어쓰지 않는다(목록 파일 하나를 읽고-고쳐-쓰지 않는다).
// 표지는 찾는 실마리일 뿐이다: 닫는 탭 id는 그 호출 폴더의 tab.json에서 읽고, 표지의 id와 같을 때만 닫는다.
export const OPEN_TABS_DIR = 'senior-open-tabs';
// 다시 닫아 볼 수 있는 탭 상태: 열려 있거나, 닫으려다 실패했다.
const RETRYABLE = new Set(['opened', 'close-failed']);
const markerFile = (home, dir) => path.join(home, OPEN_TABS_DIR, `${path.basename(path.dirname(dir))}--${path.basename(dir)}.json`);

function readTabState(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'tab.json'), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}
// 닫아 볼 수 있는 자기 탭 id. 없으면 null.
function closableId(state) {
  return state && RETRYABLE.has(state.state) && typeof state.rottieTerminalId === 'string' && state.rottieTerminalId ? state.rottieTerminalId : null;
}

export function rememberOpenTab(home, dir, id) {
  try {
    const file = markerFile(home, dir);
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    fs.writeFileSync(file, JSON.stringify({dir, rottieTerminalId: id, at: new Date().toISOString()}) + '\n', {mode: 0o600});
  } catch { /* 꾸밈이다: 표지를 못 써도 호출·정리는 그대로 간다 */ }
}
export function forgetOpenTab(home, dir) {
  try { fs.unlinkSync(markerFile(home, dir)); } catch { /* 없으면 지울 것이 없다 */ }
}

// 표지 목록(읽기만 한다). 줄마다 {file, dir, id, status, why?}.
//  pending — 닫아 볼 탭이다: 호출 폴더가 이 홈의 advice/ 아래이고, 표지 이름이 그 폴더에서 나온 이름이며, tab.json의 탭 id가 표지와 같다
//  stale   — 이미 닫혔거나 탭 기록이 없다(표지만 남음)
//  invalid — 믿을 수 없는 표지(깨진 글·다른 홈·이름 불일치·탭 id 불일치). 닫지 않는다
export function listOpenTabs(home) {
  const folder = path.join(home, OPEN_TABS_DIR), root = path.join(home, 'advice') + path.sep;
  let names;
  try { names = fs.readdirSync(folder).filter(name => name.endsWith('.json')).sort(); } catch { return []; }
  return names.map(name => {
    const file = path.join(folder, name);
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {file, dir: null, id: null, status: 'invalid', why: 'marker-unreadable'}; }
    const dir = typeof value?.dir === 'string' ? value.dir : null, id = typeof value?.rottieTerminalId === 'string' ? value.rottieTerminalId : null;
    const bad = why => ({file, dir, id, status: 'invalid', why});
    if (!dir || !path.isAbsolute(dir) || !path.resolve(dir).startsWith(root)) return bad('marker-outside-home');
    if (markerFile(home, dir) !== file) return bad('marker-name-differs');
    const state = readTabState(dir);
    if (!state || !RETRYABLE.has(state.state)) return {file, dir, id, status: 'stale'};
    if (!id || closableId(state) !== id) return bad('tab-id-differs');
    return {file, dir, id, status: 'pending'};
  });
}

// 남겨 둔 탭 닫기(정리 명령·남긴 세션 내보내기). 탭을 연 호출은 이미 끝났으므로 호출 폴더의 tab.json에 적힌 자기 탭 id로 닫는다.
// 탭을 여는 스위치(KADAN_SENIOR_TAB)·창 설정과 무관하다: 그 값은 '새 탭을 열지'이고, 전에 연 자기 탭을 치우는 일과는 다르다
// (카단 pane 안의 감독은 KADAN_WINDOW=none을 물려받는다). 필요한 것은 로티 실행 파일과 운영 로티 보호(기본이 아닌 홈은 거절)뿐이다.
// 반환: 닫을 탭이 없으면 null, 닫았으면 {tab: 'closed'}, 못 닫았으면 {tab: 'close-skipped'|'close-failed', tabReason}. 던지지 않는다.
// 닫히면 표지를 지우고, 닫지 못하면 표지를 남겨(없으면 만들어) 다음 정리 명령이 다시 찾게 한다. 제목·키로 목록을 뒤져 지우지 않는다.
export function closeKeptTab({home, env, dir, rottie}) {
  const state = readTabState(dir), id = closableId(state);
  if (!id) { if (state && !RETRYABLE.has(state.state)) forgetOpenTab(home, dir); return null; }
  let result;
  try {
    const bin = effectiveWindow(env, home).rottieBin.value;
    if (!bin) result = {tab: 'close-skipped', tabReason: 'rottie-bin-missing'};
    else {
      const runEnv = {...env, KADAN_ROTTIE_BIN: bin, KADAN_HOME: home};
      assertNotLiveRottie(runEnv);
      result = closeSeniorTab({call: rottie ?? (argv => runRottie(argv, spawnSync, runEnv)), rottieTerminalId: id});
      // 실패해도 탭 id는 tab.json에 그대로 남는다(상태만 close-failed) — 다음에 다시 닫아 본다.
      writeTabState(dir, {state: result.tab, reason: result.tabReason});
    }
  } catch (error) {
    result = {tab: 'close-skipped', tabReason: reasonOf(error)};
  }
  if (result.tab === 'closed') forgetOpenTab(home, dir);
  else rememberOpenTab(home, dir, id);
  return result;
}

// 정리 명령의 탭 훑기: 표지가 가리키는 탭 가운데 세션 없이 남은 것을 닫는다. seen은 이번 정리가 본 세션들의 호출 폴더다
// (그 탭은 세션 줄에서 다뤘거나, 살아 있는 세션의 것이라 그대로 둔다). 소켓의 세션 목록에 없는 호출 폴더의 탭이 세션 없이 남은 탭이다.
// dryRun이면 무엇을 닫을지만 돌려주고 표지·탭 기록을 바꾸지 않는다. 반환: 줄마다 {dir, id, action: tab-closed|tab-would-close|tab-left, why?, tab?}.
export function sweepOpenTabs({home, env, rottie, seen, dryRun = false}) {
  const rows = [];
  for (const entry of listOpenTabs(home)) {
    if (entry.status === 'stale') { if (!dryRun) { try { fs.unlinkSync(entry.file); } catch { /* 이미 없다 */ } } continue; }
    if (entry.status === 'invalid') { rows.push({dir: entry.dir, id: entry.id, action: 'tab-left', why: entry.why}); continue; }
    if (seen.has(entry.dir)) continue;
    if (dryRun) { rows.push({dir: entry.dir, id: entry.id, action: 'tab-would-close'}); continue; }
    const tab = closeKeptTab({home, env, dir: entry.dir, rottie});
    rows.push(tab?.tab === 'closed' ? {dir: entry.dir, id: entry.id, action: 'tab-closed', tab}
      : {dir: entry.dir, id: entry.id, action: 'tab-left', why: tab ? `${tab.tab}: ${tab.tabReason}` : 'no-open-tab', ...(tab ? {tab} : {})});
  }
  return rows;
}

// 호출 도중(탭 생성 중 포함) TERM/INT를 받으면 탭을 닫고 신호 관례 코드로 나간다. 해제 함수를 돌려준다.
// onSignal은 닫은 뒤 상태·원장을 남기는 자리다. 어느 쪽이 실패해도 원래 신호 종료 코드는 지킨다.
export function closeOnSignal(close, exit = code => process.exit(code), onSignal = () => {}) {
  const handle = (signal, code) => () => {
    try { close(); } catch { /* 종료 코드를 지킨다 */ }
    try { onSignal(signal); } catch { /* 종료 코드를 지킨다 */ }
    exit(code);
  };
  const handlers = {SIGTERM: handle('SIGTERM', 143), SIGINT: handle('SIGINT', 130)};
  for (const [signal, handler] of Object.entries(handlers)) process.once(signal, handler);
  return () => { for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler); };
}
