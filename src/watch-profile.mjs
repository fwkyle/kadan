import fs from 'node:fs';
import path from 'node:path';
import {PROFILE_FILE} from './watch-cycle.mjs';

// 감시기 정식 명령을 한 파일에 둔다. 맨 `kadan watch`로 다시 띄우다가 관계 파일·AI 판정을
// 잃어버린 사고(2026-09-12)를 막기 위한 진입점이며, 새 옵션이나 권한을 만들지 않는다.
// 형식: {"flags":{"route":["판=역할"],"super":"역할","hierarchy":"경로","judge-cmd":"명령",...},"env":{"KADAN_JUDGE_MODEL":"..."}}
export const PROFILE_FLAGS = new Set(['interval','stall','stall-after','start-report-after','completion-grace','idle','route','super','hierarchy','wake','wake-every','user-notify','judge-cmd','judge-cooldown']);
const PATH_FLAGS = new Set(['hierarchy']);

export function defaultProfilePath(home) { return path.join(home, PROFILE_FILE); }

export function readWatchProfile(file, readFile = f => fs.readFileSync(f, 'utf8')) {
 let parsed;
 try { parsed = JSON.parse(readFile(file)); }
 catch (error) { throw new Error(`감시 프로필 읽기 실패: ${file} (${error.message})`); }
 if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`감시 프로필 형식 오류: ${file}`);
 const flags = parsed.flags ?? {}, env = parsed.env ?? {};
 if (typeof flags !== 'object' || Array.isArray(flags) || typeof env !== 'object' || Array.isArray(env)) throw new Error(`감시 프로필 형식 오류: flags·env는 객체여야 합니다 (${file})`);
 const unknown = Object.keys(flags).find(name => !PROFILE_FLAGS.has(name));
 if (unknown) throw new Error(`감시 프로필이 모르는 옵션: --${unknown} (${file})`);
 const base = path.dirname(path.resolve(file)), resolved = {};
 for (const [name, value] of Object.entries(flags)) {
  if (value === null || value === undefined) continue;
  if (name === 'user-notify') { if (value !== true) throw new Error(`감시 프로필 user-notify는 true만 허용 (${file})`); resolved[name] = true; continue; }
  const list = Array.isArray(value) ? value : [value];
  if (list.some(v => typeof v !== 'string' && typeof v !== 'number')) throw new Error(`감시 프로필 옵션 값은 문자열·숫자여야 합니다: --${name} (${file})`);
  const values = list.map(v => PATH_FLAGS.has(name) ? path.resolve(base, String(v)) : String(v));
  resolved[name] = Array.isArray(value) ? values : values[0];
 }
 for (const [key, value] of Object.entries(env)) if (typeof value !== 'string') throw new Error(`감시 프로필 env 값은 문자열이어야 합니다: ${key} (${file})`);
 return {file: path.resolve(file), flags: resolved, env};
}

// CLI에서 직접 준 옵션이 우선이고, 프로필은 빈 자리만 채운다. 적용한 옵션 이름을 돌려준다.
export function applyWatchProfile(flags, profile, env = process.env) {
 const applied = [];
 for (const [name, value] of Object.entries(profile.flags)) {
  if (Object.hasOwn(flags, name)) continue;
  flags[name] = value; applied.push('--' + name);
 }
 for (const [key, value] of Object.entries(profile.env)) {
  if (env[key] !== undefined && env[key] !== '') continue;
  env[key] = value; applied.push(key);
 }
 return applied;
}

// 사람이 읽을 경고. 원장·대시보드가 아니라 시작한 터미널에 남긴다.
export function watchStartupWarnings(flags, {profileFile = null, defaultProfile = null, exists = () => false} = {}) {
 const lines = [];
 if (!flags.hierarchy) lines.push('경고: --hierarchy 없음 — 직속 관계와 상신 경로를 적용하지 않습니다.');
 if (!flags['judge-cmd']) lines.push('경고: --judge-cmd 없음 — 작업 감시AI·감독 관찰AI를 호출하지 않습니다.');
 if (lines.length && !profileFile && defaultProfile && exists(defaultProfile)) lines.push(`안내: 저장된 감시 프로필이 있습니다. kadan watch --profile ${defaultProfile}`);
 return lines;
}
