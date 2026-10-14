// 창 선택 기계 설정 — 로티/백그라운드를 KADAN_HOME에 한 번 고정한다(2026-10-14 [kyle]).
// 이유: KADAN_WINDOW가 셸 환경변수뿐이면 값을 못 물려받은 AI 셸이 역할을 띄울 때 조용히 백그라운드로 뜬다.
// 읽는 순서는 환경변수 > 이 설정 > 기본 none이다. 값이 하나로 정해지는 우선순위이며, 실패하면 다른 창으로
// 넘어가는 폴백이 아니다. 형식과 원자적 쓰기는 runner-settings.mjs와 같은 방식(임시 파일 → rename, 0600).
import fs from 'node:fs';
import path from 'node:path';

export const WINDOW_SETTING_FILE = 'window-setting.json';
export const WINDOW_SETTING_VALUES = ['rottie', 'none'];

export const windowSettingPath = home => path.join(home, WINDOW_SETTING_FILE);

export function readWindowSetting(home) {
  const file = windowSettingPath(home);
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
  const bad = !value || value.version !== 1 || !WINDOW_SETTING_VALUES.includes(value.window)
    || (value.window === 'rottie' && !path.isAbsolute(value.rottieBin ?? ''));
  if (bad) throw new Error(`창 선택 설정 손상: ${file}`);
  return value;
}

function write(home, value) {
  fs.mkdirSync(home, {recursive: true});
  const file = windowSettingPath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

// rottie는 절대경로가 필요하다(KADAN_ROTTIE_BIN_REQUIRED와 같은 기준). 경로는 인자 > 환경변수 순으로 받는다.
export function setWindowSetting(home, {window, rottieBin, env = process.env, now = () => new Date().toISOString()}) {
  if (!WINDOW_SETTING_VALUES.includes(window)) throw new Error(`창 선택은 rottie|none만 받는다: ${window ?? '(없음)'}`);
  const value = {version: 1, window, updatedAt: now()};
  if (window === 'rottie') {
    const bin = typeof rottieBin === 'string' ? rottieBin : env.KADAN_ROTTIE_BIN;
    if (!bin || !path.isAbsolute(bin)) throw new Error('KADAN_ROTTIE_BIN_REQUIRED: rottie 고정에는 로티 실행 파일의 절대경로가 필요하다 (--rottie-bin <절대경로>)');
    value.rottieBin = bin;
  } else if (rottieBin !== undefined) throw new Error('--rottie-bin은 rottie 고정에서만 쓴다');
  write(home, value);
  return value;
}

// 설정을 지운다. 지운 값이 있었으면 돌려준다. 파일이 없으면 null.
// 손상된 파일도 지울 수 있어야 복구 안내(window unset)가 실제로 동작한다 — 검증과 제거를 분리한다.
export function unsetWindowSetting(home) {
  const file = windowSettingPath(home);
  if (!fs.existsSync(file)) return null;
  let before;
  try { before = readWindowSetting(home); } catch { before = {window: '(손상된 설정)'}; }
  fs.rmSync(file);
  return before;
}

// 지금 이 프로세스가 쓸 창 선택. 환경변수가 이기고(기존 호환, 자동 시작·대시보드 재기동의 명시 none 포함), 없으면 설정이다.
// KADAN_WINDOW와 KADAN_ROTTIE_BIN은 각각 따로 정한다. 설정이 없고 둘 다 비면 source는 'default'(= 백그라운드 none)다.
export function effectiveWindow(env, home) {
  const setting = readWindowSetting(home);
  const window = env.KADAN_WINDOW ? {value: env.KADAN_WINDOW, source: 'env'}
    : setting ? {value: setting.window, source: 'setting'} : {value: 'none', source: 'default'};
  const bin = env.KADAN_ROTTIE_BIN ? {value: env.KADAN_ROTTIE_BIN, source: 'env'}
    : setting?.rottieBin ? {value: setting.rottieBin, source: 'setting'} : {value: null, source: 'default'};
  return {window, rottieBin: bin, setting};
}

// 명령 시작 때 한 번 호출한다. 환경변수에 없는 값만 설정으로 채워, 창을 여는 모든 경로
// (start·attach·handover·restore·adopt·quickstart와 로티 호출)가 같은 값을 읽게 한다.
// 설정 파일이 깨졌으면 stderr에 알리고 설정이 없는 것으로 진행한다(send 같은 명령까지 막지 않는다).
// 창을 여는 행동(start·attach·handover·adopt·restore 등)은 손상 설정에서 windowSettingBlock으로 멈춘다.
let corruptSetting = null;
export const RECOVERY_HINT = 'kadan window unset 으로 지우거나 kadan window set rottie --rottie-bin <절대경로> | kadan window set none 으로 다시 고정한다';

export function adoptMachineWindow(env, home, {warn = line => console.error(line)} = {}) {
  let resolved;
  corruptSetting = null;
  try { resolved = effectiveWindow(env, home); } catch (error) {
    corruptSetting = {env, message: error.message};
    warn(`경고: ${error.message} — 창을 여는 명령(start·attach 등)은 멈춘다. ${RECOVERY_HINT}`);
    return {windowSource: 'default', setting: null, corrupt: true};
  }
  if (resolved.window.source === 'setting') env.KADAN_WINDOW = resolved.window.value;
  if (resolved.rottieBin.source === 'setting') env.KADAN_ROTTIE_BIN = resolved.rottieBin.value;
  return {windowSource: resolved.window.source, setting: resolved.setting, corrupt: false};
}

// 대시보드·`window show`가 보여 줄 한 줄 요약. 환경변수가 아니라 기계 설정 값 기준이다.
export function describeWindowSetting(home) {
  try {
    const setting = readWindowSetting(home);
    if (!setting) return {kind: 'unset', label: '미설정'};
    return setting.window === 'rottie'
      ? {kind: 'rottie', label: '로티', rottieBin: setting.rottieBin, updatedAt: setting.updatedAt}
      : {kind: 'none', label: '백그라운드', updatedAt: setting.updatedAt};
  } catch (error) {
    return {kind: 'broken', label: '설정 손상', error: error.message};
  }
}

// 손상 설정 때문에 창 선택을 정할 수 없으면 이유를 돌려주고, 아니면 null이다.
// 환경변수 KADAN_WINDOW가 비어 있지 않게 주어지면 그 값이 창을 정하므로 막지 않는다.
// 다만 KADAN_WINDOW=rottie인데 KADAN_ROTTIE_BIN 환경변수가 없으면 설정의 경로가 필요하므로 막는다.
export function windowSettingBlock(env = process.env) {
  if (!corruptSetting || corruptSetting.env !== env) return null;
  const needsSetting = !env.KADAN_WINDOW || (env.KADAN_WINDOW === 'rottie' && !env.KADAN_ROTTIE_BIN);
  return needsSetting ? `WINDOW_SETTING_CORRUPT: ${corruptSetting.message} — 창을 만들지 않았다. ${RECOVERY_HINT}` : null;
}
