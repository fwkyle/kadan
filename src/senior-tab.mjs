// 시니어 따라 보기 탭 — 호출이 도는 동안만 로티에 읽기 전용 탭을 띄워 진행 출력을 보여 준다(2026-10-16 [kyle]).
// 탭은 꾸밈이다: 어떤 실패도 던지지 않고 건너뜀 사유로 돌려준다. 역할이 아니므로 KADAN_ROLE·kadan-* 이름·start 원장 사건을 쓰지 않는다.
// 로티 호출은 floor-rottie의 runRottie 길목(운영 로티 보호 포함)을 그대로 쓴다.
import {spawnSync} from 'node:child_process';
import {effectiveWindow} from './window-setting.mjs';
import {assertNotLiveRottie} from './live-floor-guard.mjs';
import {parseRottieCreateEvidence, runRottie} from './floor-rottie.mjs';

// 'on'이면 켜고 'off'면 끈다. 없으면 SENIOR_TAB_DEFAULT_ON을 따른다.
// 로티 terminal create에는 포커스를 끄는 옵션이 없다. 2026-10-16 실측(docs/senior.md)에서 로티가 맨 앞으로 오지 않아 기본은 켬이다.
// 로티가 앞으로 오는 것이 확인되면 false로 바꿔 실패 닫힘(자동 열기 끔)으로 돌린다.
// 로티에 포커스 없는 create 옵션이 생기면 buildSeniorTabCreateArgv에 그 옵션을 붙인다.
export const SENIOR_TAB_ENV = 'KADAN_SENIOR_TAB';
export const SENIOR_TAB_DEFAULT_ON = true;

const shellWord = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`;
const reasonOf = error => error?.code || error?.message || String(error);

export function seniorTabEnabled(env) {
  const value = env[SENIOR_TAB_ENV];
  return value === 'on' ? true : value === 'off' ? false : SENIOR_TAB_DEFAULT_ON;
}

export function buildSeniorTabCreateArgv({card, adviceId, command}) {
  return ['terminal', 'create', '--workspace', card.repoPath, '--title', `시니어 · ${card.key}`,
    '--command', command, '--idempotency-key', `kadan-senior-${adviceId}`, '--json'];
}

// 반환: {tab: 'opened'|'skipped', tabReason?, rottieTerminalId?, call?}. call(argv)는 닫을 때도 같은 환경으로 로티를 부른다.
export function openSeniorTab({home, env, card, adviceId, dir, followScript, parentPid = process.pid, rottie}) {
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
    const evidence = parseRottieCreateEvidence(call(buildSeniorTabCreateArgv({card, adviceId, command})));
    return {tab: 'opened', rottieTerminalId: evidence.rottieTerminalId, call};
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
  let lingering = true;
  try { call(['terminal', 'show', ...target]); } catch { lingering = false; }
  if (!lingering) return {tab: 'closed'};
  try {
    call(['terminal', 'remove', ...target]);
    return {tab: 'closed', tabReason: 'removed-after-close'};
  } catch (error) {
    return {tab: 'close-failed', tabReason: `remove: ${reasonOf(error)}`};
  }
}

// 호출 도중 TERM/INT를 받으면 탭을 닫고 신호 관례 코드로 나간다. 해제 함수를 돌려준다.
export function closeOnSignal(close, exit = code => process.exit(code)) {
  const handlers = {SIGTERM: () => { close(); exit(143); }, SIGINT: () => { close(); exit(130); }};
  for (const [signal, handler] of Object.entries(handlers)) process.once(signal, handler);
  return () => { for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler); };
}
