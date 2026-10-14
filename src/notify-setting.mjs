// 사용자 알림(디스코드) 비밀 읽기. 비밀 파일의 위치 규칙(환경변수 > 기계 설정 > 기본 위치)은 secrets.mjs가 정한다.
// 이 파일에는 디코 전용 해석(readDiscordSecrets)과, 옛 알림 설정 파일(notify-setting.json) 호환만 남는다.
// 옛 알림 설정은 새 코드가 읽기만 한다(secrets.mjs resolveSecret). 쓰기(setNotifySetting)는 옛 형식 재현·복구용이다.
import fs from 'node:fs';
import path from 'node:path';
import {readLegacyNotifySetting, resolveSecret, readSecretValues, parseEnvText, LEGACY_DISCORD_ENV_VAR} from './secrets.mjs';

export {parseEnvText};

export const NOTIFY_SETTING_FILE = 'notify-setting.json';
export const NOTIFY_ENV_VAR = LEGACY_DISCORD_ENV_VAR;

export const notifySettingPath = home => path.join(home, NOTIFY_SETTING_FILE);

export const readNotifySetting = readLegacyNotifySetting;

export function setNotifySetting(home, {envFile, now = () => new Date().toISOString()}) {
  if (typeof envFile !== 'string' || !path.isAbsolute(envFile)) throw new Error('--env-file에는 비밀 파일의 절대경로가 필요하다');
  const value = {version: 1, discord: {envFile}, updatedAt: now()};
  fs.mkdirSync(home, {recursive: true});
  const file = notifySettingPath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
  return value;
}

// 비밀 파일 경로: 환경변수 > 기계 설정(옛 알림 설정 포함) > 없음. 설정이 손상됐으면 던지지 않고 사유를 돌려준다.
// 기본 위치(secrets/discord.env)는 파일이 있을 때만 경로로 본다 — 없으면 "미설정"(시스템 알림만)이다.
export function effectiveNotifyEnvFile(env, home) {
  const r = resolveSecret(env, home, 'discord');
  if (r.error) return {envFile: null, source: 'broken', error: r.error};
  if (r.source === 'default' && !r.exists) return {envFile: null, source: 'default', error: null};
  return {envFile: r.path, source: r.source, error: null};
}

// 레포 이름 → 비밀 파일 키 접미사. 대문자로 바꾸고 영숫자가 아닌 글자는 `_`로 (my-app → MY_APP).
export const repoKeySuffix = repo => String(repo).toUpperCase().replace(/[^A-Z0-9]/g, '_');

// 레포별 웹훅 키 이름 목록(값은 읽어도 돌려주지 않는다). show용.
export function listRepoWebhookKeys(envFile) {
  const {values} = readSecretValues(envFile);
  return values ? Object.keys(values).filter(k => k.startsWith('DISCORD_WEBHOOK_URL_')).sort() : [];
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
export function readDiscordSecrets(envFile, {repo, checkDir = false} = {}) {
  const {values, error, warnings} = readSecretValues(envFile, {checkDir});
  if (error) return {error: `설정 오류: ${error}`};
  const webhook = values.DISCORD_WEBHOOK_URL, userId = values.DISCORD_USER_ID;
  if (!webhook) return {error: '설정 오류: 비밀 파일에 DISCORD_WEBHOOK_URL이 없다'};
  if (!userId) return {error: '설정 오류: 비밀 파일에 DISCORD_USER_ID가 없다'};
  const bad = checkedUrl(webhook);
  if (bad) return {error: `설정 오류: DISCORD_WEBHOOK_URL ${bad}`};
  if (!/^\d{1,25}$/.test(userId)) return {error: '설정 오류: DISCORD_USER_ID는 숫자여야 한다'};
  const out = {webhook, userId, warnings};
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
