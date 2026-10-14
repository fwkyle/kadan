// 사용자 알림(디스코드) 기계 설정 — 비밀 파일의 "경로"만 KADAN_HOME에 고정한다(주소·ID는 복사하지 않는다).
// 읽는 순서는 환경변수 KADAN_NOTIFY_ENV_FILE > 이 설정 > 없음(= 시스템 알림만)이다.
// 비밀 파일은 보낼 때마다 읽고 KEY=VALUE 줄만 직접 해석한다(셸 실행·source 금지). 형식·원자적 쓰기는 window-setting.mjs와 같다.
import fs from 'node:fs';
import path from 'node:path';

export const NOTIFY_SETTING_FILE = 'notify-setting.json';
export const NOTIFY_ENV_VAR = 'KADAN_NOTIFY_ENV_FILE';

export const notifySettingPath = home => path.join(home, NOTIFY_SETTING_FILE);

const REPO_NAME = /^[\w.-]+$/;

export function readNotifySetting(home) {
  const file = notifySettingPath(home);
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
  const repos = value?.repos ?? {};
  const bad = !value || value.version !== 1 || (value.discord && !path.isAbsolute(value.discord.envFile ?? ''))
    || typeof repos !== 'object' || Array.isArray(repos)
    || Object.entries(repos).some(([name, v]) => !REPO_NAME.test(name) || !path.isAbsolute(v?.envFile ?? ''));
  if (bad) throw new Error(`알림 설정 손상: ${file}`);
  return value;
}

function writeSetting(home, value) {
  fs.mkdirSync(home, {recursive: true});
  const file = notifySettingPath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

// repo가 없으면 기본 비밀 파일, 있으면 그 레포 전용 비밀 파일 경로를 고정한다. 둘 다 경로만 저장한다.
export function setNotifySetting(home, {envFile, repo, now = () => new Date().toISOString()}) {
  if (typeof envFile !== 'string' || !path.isAbsolute(envFile)) throw new Error('--env-file에는 비밀 파일의 절대경로가 필요하다');
  if (repo !== undefined && (typeof repo !== 'string' || !REPO_NAME.test(repo))) throw new Error('--repo에는 레포 이름이 필요하다 (예: kadan)');
  const old = readNotifySetting(home) ?? {version: 1};
  const value = {...old, version: 1, updatedAt: now()};
  if (repo === undefined) value.discord = {envFile};
  else value.repos = {...(old.repos ?? {}), [repo]: {envFile}};
  writeSetting(home, value);
  return value;
}

// 손상된 파일도 지울 수 있어야 복구가 된다 — 검증과 제거를 분리한다. repo를 주면 그 레포 설정만 지운다.
export function unsetNotifySetting(home, {repo} = {}) {
  const file = notifySettingPath(home);
  if (!fs.existsSync(file)) return null;
  let before;
  try { before = readNotifySetting(home); } catch { before = null; }
  if (repo === undefined || !before) { fs.rmSync(file); return before ?? {discord: {envFile: '(손상된 설정)'}}; }
  if (!before.repos?.[repo]) return null;
  const {[repo]: gone, ...rest} = before.repos;
  const next = {...before, repos: rest, updatedAt: new Date().toISOString()};
  if (!Object.keys(rest).length) delete next.repos;
  if (!next.discord && !next.repos) fs.rmSync(file); else writeSetting(home, next);
  return gone;
}

// 기본 비밀 파일 경로: 환경변수 KADAN_NOTIFY_ENV_FILE > 기계 설정 > 없음. 설정이 손상됐으면 던지지 않고 사유를 돌려준다.
export function effectiveNotifyEnvFile(env, home) {
  if (env[NOTIFY_ENV_VAR]) return {envFile: env[NOTIFY_ENV_VAR], source: 'env', error: null};
  try {
    const setting = readNotifySetting(home);
    return setting?.discord ? {envFile: setting.discord.envFile, source: 'setting', error: null} : {envFile: null, source: 'default', error: null};
  } catch (error) { return {envFile: null, source: 'broken', error: error.message}; }
}

// 이 알림이 쓸 비밀 파일. 레포별 설정이 있으면 그 파일(없는 레포·레포 모름이면 기본 파일).
// 레포별 파일은 읽기 오류가 나도 기본 웹훅으로 내려가지 않는다 — 다른 채널로 새지 않게 호출 쪽이 시스템 알림으로 내린다.
export function resolveNotifyTarget(env, home, repo) {
  const base = effectiveNotifyEnvFile(env, home);
  if (!repo) return {...base, repo: null, fallbackEnvFile: base.envFile};
  try {
    const entry = readNotifySetting(home)?.repos?.[repo];
    if (entry) return {envFile: entry.envFile, source: 'repo', repo, error: null, fallbackEnvFile: base.envFile};
  } catch (error) { return {envFile: null, source: 'broken', repo, error: error.message, fallbackEnvFile: null}; }
  return {...base, repo: null, fallbackEnvFile: base.envFile};
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

// 보낼 때 비밀 파일을 읽는다. 반환의 reason에는 주소·ID를 넣지 않는다.
export function readDiscordSecrets(envFile, {optionalUser = false} = {}) {
  let text;
  try { text = fs.readFileSync(envFile, 'utf8'); } catch (error) {
    return {error: `설정 오류: 비밀 파일을 읽을 수 없다(${error.code ?? 'ERR'})`};
  }
  const values = parseEnvText(text);
  const webhook = values.DISCORD_WEBHOOK_URL, userId = values.DISCORD_USER_ID;
  if (!webhook) return {error: '설정 오류: 비밀 파일에 DISCORD_WEBHOOK_URL이 없다'};
  if (!userId && !optionalUser) return {error: '설정 오류: 비밀 파일에 DISCORD_USER_ID가 없다'};
  let url;
  try { url = new URL(webhook); } catch { return {error: '설정 오류: DISCORD_WEBHOOK_URL 형식이 잘못됐다'}; }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return {error: '설정 오류: DISCORD_WEBHOOK_URL은 https여야 한다'};
  if (userId && !/^\d{1,25}$/.test(userId)) return {error: '설정 오류: DISCORD_USER_ID는 숫자여야 한다'};
  return {webhook, userId};
}
