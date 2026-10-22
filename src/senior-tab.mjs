// 시니어 따라 보기 탭 — 호출이 도는 동안만 로티에 읽기 전용 탭을 띄워 진행 출력을 보여 준다(2026-10-16 [kyle]).
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

const shellWord = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`;
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

// 반환: {tab: 'opened'|'skipped', tabReason?, rottieTerminalId?, call?}. call(argv)는 닫을 때도 같은 환경으로 로티를 부른다.
export function openSeniorTab({home, env, card, adviceId, dir, followScript, parentPid = process.pid, rottie, suffix}) {
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
    const command = `/bin/bash ${shellWord(followScript)} ${shellWord(dir)} ${parentPid}`;
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
