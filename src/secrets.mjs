// 비밀값 위치 규칙 — 이름별 비밀 파일(KEY=VALUE)의 "어디서 읽나"를 한 곳에서 정한다.
// 읽는 순서는 환경변수 > 기계 설정($KADAN_HOME/secrets-setting.json) > 기본 위치($KADAN_HOME/secrets/<이름>.env)다.
// 디코 알림은 옛 환경변수 KADAN_NOTIFY_ENV_FILE과 옛 설정 파일(notify-setting.json의 discord.envFile)도 그대로 읽는다.
// 값은 저장·출력하지 않는다. 오류·표시에는 이름·경로·키 이름만 쓴다. 파일은 읽을 때마다 KEY=VALUE 줄만 직접 해석한다(셸 실행 금지).
import fs from 'node:fs';
import path from 'node:path';

// 이름 목록은 여기 한 곳이다. 알 수 없는 이름은 거절한다.
export const SECRET_NAMES = ['discord', 'discord-bot', 'explain-ai'];
export const SECRETS_DIR = 'secrets';
export const SECRETS_SETTING_FILE = 'secrets-setting.json';
export const LEGACY_DISCORD_ENV_VAR = 'KADAN_NOTIFY_ENV_FILE';

export const secretsDirPath = home => path.join(home, SECRETS_DIR);
export const secretsSettingPath = home => path.join(home, SECRETS_SETTING_FILE);
export const defaultSecretPath = (home, name) => path.join(secretsDirPath(home), `${name}.env`);
export const secretEnvVar = name => `KADAN_SECRET_${name.toUpperCase().replace(/-/g, '_')}_FILE`;

export function assertSecretName(name) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`알 수 없는 비밀 이름: ${name ?? '(없음)'} — 가능한 이름: ${SECRET_NAMES.join(', ')}`);
}

// KEY=VALUE 줄만 읽는다. 따옴표 한 겹과 앞의 export, # 주석 줄 정도만 다룬다. 치환·명령 실행은 없다.
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// --- 기계 설정: 이름 → 절대경로. 형식과 원자적 쓰기는 window-setting.mjs와 같다(임시 파일 → rename, 0600). ---
export function readSecretsSetting(home) {
  const file = secretsSettingPath(home);
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
  const files = value?.files;
  const bad = !value || value.version !== 1 || !files || typeof files !== 'object' || Array.isArray(files)
    || Object.entries(files).some(([name, p]) => !SECRET_NAMES.includes(name) || typeof p !== 'string' || !path.isAbsolute(p));
  if (bad) throw new Error(`비밀 위치 설정 손상: ${file}`);
  return value;
}

function writeSetting(home, value) {
  fs.mkdirSync(home, {recursive: true});
  const file = secretsSettingPath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

export function setSecretFile(home, name, file, {now = () => new Date().toISOString()} = {}) {
  assertSecretName(name);
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('--file에는 비밀 파일의 절대경로가 필요하다');
  // 손상된 설정 위에는 쓰지 않는다 — 먼저 unset으로 지워야 한다.
  const files = {...(readSecretsSetting(home)?.files ?? {}), [name]: file};
  const value = {version: 1, files, updatedAt: now()};
  writeSetting(home, value);
  return value;
}

// 이름 하나의 고정을 푼다. 디코는 옛 알림 설정(notify-setting.json)도 함께 푼다(안 그러면 지운 경로가 되살아난다).
// 손상된 파일도 지울 수 있어야 복구가 된다 — 검증과 제거를 분리한다.
export function unsetSecretFile(home, name) {
  assertSecretName(name);
  let removed = false;
  const file = secretsSettingPath(home);
  if (fs.existsSync(file)) {
    let setting = null;
    try { setting = readSecretsSetting(home); } catch { /* 손상: 파일째 지운다 */ }
    if (!setting) { fs.rmSync(file); removed = true; }
    else if (name in setting.files) {
      const {[name]: _, ...rest} = setting.files;
      if (Object.keys(rest).length) writeSetting(home, {...setting, files: rest});
      else fs.rmSync(file);
      removed = true;
    }
  }
  if (name === 'discord') {
    const legacy = path.join(home, LEGACY_NOTIFY_SETTING_FILE);
    if (fs.existsSync(legacy)) { fs.rmSync(legacy); removed = true; }
  }
  return removed;
}

// 옛 알림 설정 파일(notify-setting.json)은 그대로 읽는다. 운영 홈에 이미 있는 고정이 새 코드로도 끊기지 않게 하려는 호환이다.
// 새로 쓰지 않고(고정은 secrets-setting.json), 읽을 때 변환해 쓴다 — 파일을 옮기거나 지우는 이행 작업이 필요 없다.
export const LEGACY_NOTIFY_SETTING_FILE = 'notify-setting.json';
export function readLegacyNotifySetting(home) {
  const file = path.join(home, LEGACY_NOTIFY_SETTING_FILE);
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
  if (!value || value.version !== 1 || !path.isAbsolute(value.discord?.envFile ?? '')) throw new Error(`알림 설정 손상: ${file}`);
  return value;
}

// --- 위치 찾기. 설정이 손상됐으면 던지지 않고 source:'broken'과 사유를 돌려준다. ---
// 반환: {name, path, source:'env'|'setting'|'default'|'broken', via, exists, error}
//   via: 값을 준 곳의 사람용 이름(환경변수 이름 또는 설정 파일 이름).
export function resolveSecret(env, home, name) {
  assertSecretName(name);
  const done = (p, source, via) => ({name, path: p, source, via, exists: fs.existsSync(p), error: null});
  const broken = error => ({name, path: null, source: 'broken', via: null, exists: false, error});
  const envNames = [secretEnvVar(name), ...(name === 'discord' ? [LEGACY_DISCORD_ENV_VAR] : [])];
  for (const key of envNames) {
    const v = env[key];
    if (!v) continue;
    if (!path.isAbsolute(v)) return broken(`환경변수 ${key}에는 절대경로가 필요하다`);
    return done(v, 'env', key);
  }
  try {
    const setting = readSecretsSetting(home);
    if (setting?.files[name]) return done(setting.files[name], 'setting', SECRETS_SETTING_FILE);
    if (name === 'discord') {
      const legacy = readLegacyNotifySetting(home);
      if (legacy) return done(legacy.discord.envFile, 'setting', LEGACY_NOTIFY_SETTING_FILE);
    }
  } catch (error) { return broken(error.message); }
  return done(defaultSecretPath(home, name), 'default', `${SECRETS_DIR}/${name}.env`);
}

const modeText = mode => '0' + (mode & 0o777).toString(8);

// 파일이 600보다, (기본 위치라면) 폴더가 700보다 넓으면 경고 한 줄씩. 막지는 않는다. 링크는 가리키는 실제 파일 기준이다.
export function permissionWarnings(file, {checkDir = false} = {}) {
  const warnings = [];
  try {
    const mode = fs.statSync(file).mode;
    if (mode & 0o077) warnings.push(`권한 경고: ${file} 권한이 ${modeText(mode)}라 600보다 넓다 — chmod 600 권장`);
  } catch { /* 없는 파일은 읽을 때 따로 알린다 */ }
  if (checkDir) {
    const dir = path.dirname(file);
    try {
      const mode = fs.statSync(dir).mode;
      if (mode & 0o077) warnings.push(`권한 경고: ${dir} 권한이 ${modeText(mode)}라 700보다 넓다 — chmod 700 권장`);
    } catch { /* 폴더가 없으면 건너뜀 */ }
  }
  return warnings;
}

// 비밀 파일 하나를 읽어 KEY=VALUE로 돌려준다(심볼릭 링크는 그대로 따라간다). 오류에는 값이 없다.
export function readSecretValues(file, {checkDir = false} = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    return {error: `비밀 파일을 읽을 수 없다(${error.code ?? 'ERR'})`, values: null, warnings: []};
  }
  return {error: null, values: parseEnvText(text), warnings: permissionWarnings(file, {checkDir})};
}

// 이름으로 찾고 읽는다. 기본 위치에 파일이 없는 것은 오류가 아니라 "아직 안 만듦"이다(values:null, error:null).
export function loadSecret(env, home, name) {
  const where = resolveSecret(env, home, name);
  if (where.error) return {...where, values: null, warnings: []};
  if (where.source === 'default' && !where.exists) return {...where, values: null, warnings: []};
  const read = readSecretValues(where.path, {checkDir: where.source === 'default'});
  return {...where, ...read};
}

// kadan secrets init / kadan init: 빈 secrets/ 폴더를 700으로 만든다. 값 파일은 만들지 않는다. 이미 있으면 권한을 바꾸지 않는다.
export function initSecretsDir(home) {
  const dir = secretsDirPath(home);
  if (fs.existsSync(dir)) return {dir, created: false};
  fs.mkdirSync(home, {recursive: true});
  fs.mkdirSync(dir, {mode: 0o700});
  fs.chmodSync(dir, 0o700);
  return {dir, created: true};
}
