// 사용자 알림(디스코드) 기계 설정 — 비밀 파일의 "경로"만 KADAN_HOME에 고정한다(주소·ID는 복사하지 않는다).
// 읽는 순서는 환경변수 KADAN_NOTIFY_ENV_FILE > 이 설정 > 없음(= 시스템 알림만)이다.
// 비밀 파일은 보낼 때마다 읽고 KEY=VALUE 줄만 직접 해석한다(셸 실행·source 금지). 형식·원자적 쓰기는 window-setting.mjs와 같다.
import fs from 'node:fs';
import path from 'node:path';

export const NOTIFY_SETTING_FILE = 'notify-setting.json';
export const NOTIFY_ENV_VAR = 'KADAN_NOTIFY_ENV_FILE';

export const notifySettingPath = home => path.join(home, NOTIFY_SETTING_FILE);

export function readNotifySetting(home) {
  const file = notifySettingPath(home);
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
  if (!value || value.version !== 1 || !path.isAbsolute(value.discord?.envFile ?? '')) throw new Error(`알림 설정 손상: ${file}`);
  return value;
}

export function setNotifySetting(home, {envFile, now = () => new Date().toISOString()}) {
  if (typeof envFile !== 'string' || !path.isAbsolute(envFile)) throw new Error('--env-file에는 비밀 파일의 절대경로가 필요하다');
  const value = {version: 1, discord: {envFile}, updatedAt: now()};
  fs.mkdirSync(home, {recursive: true});
  const file = notifySettingPath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
  return value;
}

// 손상된 파일도 지울 수 있어야 복구가 된다 — 검증과 제거를 분리한다.
export function unsetNotifySetting(home) {
  const file = notifySettingPath(home);
  if (!fs.existsSync(file)) return null;
  let before;
  try { before = readNotifySetting(home); } catch { before = {discord: {envFile: '(손상된 설정)'}}; }
  fs.rmSync(file);
  return before;
}

// 비밀 파일 경로: 환경변수 KADAN_NOTIFY_ENV_FILE > 기계 설정 > 없음. 설정이 손상됐으면 던지지 않고 사유를 돌려준다.
export function effectiveNotifyEnvFile(env, home) {
  if (env[NOTIFY_ENV_VAR]) return {envFile: env[NOTIFY_ENV_VAR], source: 'env', error: null};
  try {
    const setting = readNotifySetting(home);
    return setting ? {envFile: setting.discord.envFile, source: 'setting', error: null} : {envFile: null, source: 'default', error: null};
  } catch (error) { return {envFile: null, source: 'broken', error: error.message}; }
}

// 레포 이름 → 비밀 파일 키 접미사. 대문자로 바꾸고 영숫자가 아닌 글자는 `_`로 (my-app → MY_APP).
export const repoKeySuffix = repo => String(repo).toUpperCase().replace(/[^A-Z0-9]/g, '_');

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

// 레포별 웹훅 키 이름 목록(값은 읽어도 돌려주지 않는다). show용.
export function listRepoWebhookKeys(envFile) {
  try { return Object.keys(parseEnvText(fs.readFileSync(envFile, 'utf8'))).filter(k => k.startsWith('DISCORD_WEBHOOK_URL_')).sort(); } catch { return []; }
}

function checkedUrl(value) {
  let url;
  try { url = new URL(value); } catch { return '형식이 잘못됐다'; }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? null : 'https여야 한다';
}

// 보낼 때 비밀 파일을 읽는다. 반환의 오류 문구에는 주소·ID를 넣지 않는다.
// 기본 웹훅(DISCORD_WEBHOOK_URL)과 사용자 ID는 필수, 레포별 웹훅(DISCORD_WEBHOOK_URL_<레포>)은 repo를 줄 때 있으면 함께 돌려준다.
// 레포 키가 있는데 형식이 틀리면 기본 웹훅으로 내려가지 않고 오류다(잘못된 채널로 새지 않게).
export function readDiscordSecrets(envFile, {repo} = {}) {
  let text;
  try { text = fs.readFileSync(envFile, 'utf8'); } catch (error) {
    return {error: `설정 오류: 비밀 파일을 읽을 수 없다(${error.code ?? 'ERR'})`};
  }
  const values = parseEnvText(text);
  const webhook = values.DISCORD_WEBHOOK_URL, userId = values.DISCORD_USER_ID;
  if (!webhook) return {error: '설정 오류: 비밀 파일에 DISCORD_WEBHOOK_URL이 없다'};
  if (!userId) return {error: '설정 오류: 비밀 파일에 DISCORD_USER_ID가 없다'};
  const bad = checkedUrl(webhook);
  if (bad) return {error: `설정 오류: DISCORD_WEBHOOK_URL ${bad}`};
  if (!/^\d{1,25}$/.test(userId)) return {error: '설정 오류: DISCORD_USER_ID는 숫자여야 한다'};
  const out = {webhook, userId};
  if (repo) {
    const key = `DISCORD_WEBHOOK_URL_${repoKeySuffix(repo)}`;
    if (values[key]) {
      const badRepo = checkedUrl(values[key]);
      if (badRepo) return {error: `설정 오류: ${key} ${badRepo}`};
      out.repoWebhook = values[key];
    }
  }
  return out;
}
