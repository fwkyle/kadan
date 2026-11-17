// 휴지통 경로 — 카단이 "지우지 않고 옮기는" 파일의 자리를 한 곳에서 정한다.
// 기본은 $KADAN_HOME/.trash(날짜 폴더 없음)로 예전과 같다. 이 기계에서만 다른 자리(예: 공용 휴지통)를 쓰고 싶으면
// 환경변수 KADAN_TRASH_DIR 또는 기계 설정(trash-setting.json)으로 바꾼다. 공개 레포라 개인 경로는 코드에 없다.
// 읽는 순서는 환경변수 > 기계 설정 > 기본이며 값 하나로 정해진다. 위 값이 잘못되면 아래 값으로 넘어가지 않고 거절한다
// (조용히 기본 자리로 옮기면 파일이 두 곳에 나뉜다). 매 호출 때 읽고 캐시하지 않아 명령 한 번으로 적용된다.
// 명시로 정한 자리에는 <자리>/<YYYY-MM-DD>/ 폴더를 붙인다(로컬 날짜). 기본 자리에는 붙이지 않는다.
// 옮기기는 같은 디스크 안의 link+unlink만 한다(아래 moveToTrash). 실패(다른 디스크·같은 이름·권한)하면 복사로 우회하지 않고 던진다 —
// 부르는 쪽은 원본을 건드리는 다음 단계(새 상태 쓰기·표시 파일 삭제·설치 제거)를 하지 않는다.
// 형식과 원자적 쓰기는 window-setting.mjs와 같은 방식(임시 파일 → rename, 0600)이다.
import fs from 'node:fs';
import path from 'node:path';

export const TRASH_ENV = 'KADAN_TRASH_DIR';
export const TRASH_SETTING_FILE = 'trash-setting.json';
export const trashSettingPath = home => path.join(home, TRASH_SETTING_FILE);
export const TRASH_RECOVERY_HINT = 'kadan trash clear --reason <이유> 로 지우거나 kadan trash set <절대경로> --reason <이유> 로 다시 정한다';

// 절대경로만 받는다. 빈 글·상대경로·"~" 글자 그대로(셸이 풀지 않은 것)·NUL 문자는 거절한다.
function checkDir(value, where) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`TRASH_DIR_INVALID: ${where}이(가) 비어 있다`);
  if (value.includes('\0')) throw new Error(`TRASH_DIR_INVALID: ${where}에 NUL 문자가 있다`);
  if (value === '~' || value.startsWith('~/')) throw new Error(`TRASH_DIR_INVALID: ${where}의 ~는 풀리지 않는다 — 절대경로를 쓴다: ${value}`);
  if (!path.isAbsolute(value)) throw new Error(`TRASH_DIR_INVALID: ${where}은(는) 절대경로여야 한다: ${value}`);
  return path.normalize(value);
}

export function readTrashSetting(home) {
  const file = trashSettingPath(home);
  if (!fs.existsSync(file)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
  let dir = null;
  try { if (value?.version === 1) dir = checkDir(value.dir, 'dir'); } catch { dir = null; }
  if (!dir) throw new Error(`TRASH_SETTING_CORRUPT: 휴지통 설정 손상: ${file}`);
  return {...value, dir};
}

function write(home, value) {
  fs.mkdirSync(home, {recursive: true});
  const file = trashSettingPath(home), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

export function setTrashSetting(home, {dir, reason, now = () => new Date().toISOString()}) {
  const checked = checkDir(dir, '경로');
  if (typeof reason !== 'string' || reason.trim() === '') throw new Error('--reason이 필요하다: 왜 바꾸는지 한 줄로 적는다');
  const value = {version: 1, dir: checked, reason: reason.trim(), updatedAt: now()};
  write(home, value);
  return value;
}

// 설정을 지운다. 지운 값이 있었으면 돌려준다. 파일이 없으면 null. 손상된 파일도 지울 수 있어야 복구 안내가 동작한다.
export function clearTrashSetting(home) {
  const file = trashSettingPath(home);
  if (!fs.existsSync(file)) return null;
  let before;
  try { before = readTrashSetting(home); } catch { before = {dir: '(손상된 설정)'}; }
  fs.rmSync(file);
  return before;
}

// 로컬 날짜 YYYY-MM-DD. toISOString()은 UTC라 오전 9시 전(한국)에는 하루 어긋난다.
export function localDate(now) {
  const d = new Date(typeof now === 'function' ? now() : now);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 지금 정해진 휴지통 자리. 던질 수 있다(정해진 값이 잘못됐으면 거절).
// source: env | setting | default. dated: 날짜 폴더를 붙였는가. dir: 파일을 놓을 폴더.
export function resolveTrash(home, {env = process.env, now = Date.now} = {}) {
  if (env[TRASH_ENV] !== undefined) {
    const base = checkDir(env[TRASH_ENV], TRASH_ENV);
    return {source: 'env', dated: true, base, dir: path.join(base, localDate(now))};
  }
  const setting = readTrashSetting(home);
  if (setting) return {source: 'setting', dated: true, base: setting.dir, dir: path.join(setting.dir, localDate(now))};
  const base = path.join(home, '.trash');
  return {source: 'default', dated: false, base, dir: base};
}

// 안내 문구용 경로. 절대 던지지 않는다(자동 되살리기 알림 주기를 깨지 않게). 잘못된 설정이면 그 오류 문구를 그대로 돌려준다.
export function describeTrash(home, opts) {
  try { return resolveTrash(home, opts).dir; } catch (error) { return `(휴지통 설정 오류: ${error.message})`; }
}

// 놓을 폴더를 만들고 그 안의 이름의 최종 경로를 돌려준다. name은 하위 폴더를 가질 수 있다(autostart-<시각>/파일).
// 같은 이름이 이미 있으면 미리 거절한다(친절한 오류용). 덮어쓰지 않는 보장은 이 검사가 아니라 moveToTrash의 link 연산이 맡는다.
export function trashTarget(home, name, {env, now, mode} = {}) {
  const {dir} = resolveTrash(home, {env, now});
  const dest = path.join(dir, name);
  if (path.relative(dir, dest).startsWith('..')) throw new Error(`TRASH_DIR_INVALID: 휴지통 밖으로 나가는 이름: ${name}`);
  fs.mkdirSync(path.dirname(dest), {recursive: true, ...(mode ? {mode} : {})});
  if (fs.existsSync(dest) || isLink(dest)) throw new Error(`TRASH_EXISTS: 같은 이름이 이미 있다(덮어쓰지 않는다): ${dest}`);
  return dest;
}

function isLink(file) { try { fs.lstatSync(file); return true; } catch { return false; } }

// 파일 하나를 휴지통으로 옮긴다. 옮긴 새 경로를 돌려준다. 실패하면 원본을 그대로 두고 던진다(복사로 우회하지 않는다).
// 덮어쓰지 않는다는 보장은 사전 검사(trashTarget)가 아니라 연산에 둔다: renameSync는 목적지가 있으면 조용히 덮으므로,
// 검사와 이동 사이에 다른 실행이 같은 이름을 만들면 그 파일이 사라진다. linkSync는 목적지가 있으면 EEXIST로 원자적으로 실패한다.
// 그래서 linkSync(원본 → 목적지)가 성공한 뒤에만 원본을 unlink한다. unlink가 실패하면 두 곳에 남을 뿐 잃지 않으며 오류로 멈춘다.
// 일반 파일만 받는다(폴더는 link가 안 되고, 심볼릭 링크는 macOS에서 링크 대상을 따라가므로 거절한다).
export function moveToTrash(home, source, name, {env, now, link = fs.linkSync, unlink = fs.unlinkSync} = {}) {
  const dest = trashTarget(home, name, {env, now});
  let kind;
  try { kind = fs.lstatSync(source); } catch (error) { throw new Error(`TRASH_MOVE_FAILED: 원본을 읽지 못했다: ${source} (${error?.code ?? error?.message})`); }
  if (!kind.isFile()) throw new Error(`TRASH_NOT_FILE: 일반 파일만 옮긴다(폴더·링크는 거절, 원본 그대로): ${source}`);
  try { link(source, dest); } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`TRASH_EXISTS: 같은 이름이 이미 있다(덮어쓰지 않는다, 원본 그대로): ${dest}`);
    if (error?.code === 'EXDEV') throw new Error(`TRASH_CROSS_DEVICE: 휴지통이 다른 디스크라 옮기지 않았다(복사로 우회하지 않는다, 원본 그대로): ${source} → ${dest}`);
    throw new Error(`TRASH_MOVE_FAILED: 옮기지 못했다(원본 그대로): ${source} → ${dest} (${error?.code ?? error?.message})`);
  }
  try { unlink(source); } catch (error) {
    throw new Error(`TRASH_SOURCE_REMAINS: 휴지통에는 넣었지만 원본을 지우지 못했다(두 곳에 남음, 잃지 않음): ${source} / ${dest} (${error?.code ?? error?.message})`);
  }
  return dest;
}
