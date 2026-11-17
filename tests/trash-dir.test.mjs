import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  resolveTrash, describeTrash, moveToTrash, localDate, readTrashSetting, setTrashSetting, clearTrashSetting,
  trashSettingPath,
} from '../src/trash-dir.mjs';
import {recoverCorruptState, clearForUp, prepareRevive, readReviveState, TARGETS} from '../src/revive.mjs';
import {autostartCommand, AUTOSTART_LABEL} from '../src/autostart.mjs';
import {pruneHierarchy} from '../src/hierarchy-prune.mjs';
import {restartInfra} from '../src/infra-restart.mjs';

// 모든 시험은 임시 폴더만 쓴다. 운영 홈(~/.kadan)과 그 .trash에는 닿지 않는다.
const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `kadan-trash-${prefix}-`)));
// 로컬 시각 2026-11-17 08:00 — UTC로는 하루 전(한국 시간대)일 수 있는 시각이다.
const MORNING = new Date(2026, 10, 17, 8, 0, 0).getTime();
const DAY = '2026-11-17';
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const run = (home, args, env = {}) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8',
  env: {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    KADAN_NOTIFY: 'off', KADAN_HOME: home, ...env}});

// 다른 디스크로 옮기는 실패(EXDEV)를 흉내 낸다: 도착 경로가 prefix 안이면 던진다. 끝나면 되돌린다(비동기 본문도 받는다).
function withExdev(prefix, body) {
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).startsWith(prefix)) throw Object.assign(new Error('cross-device link not permitted'), {code: 'EXDEV'});
    return real(from, to);
  };
  const restore = () => { fs.renameSync = real; };
  let result;
  try { result = body(); } catch (error) { restore(); throw error; }
  if (typeof result?.then === 'function') return result.finally(restore);
  restore();
  return result;
}

test('경우표: 환경변수 > 기계 설정 > 기본, 명시 값에만 날짜 폴더', () => {
  const home = tmp('table'), a = tmp('envdir'), b = tmp('setdir');
  const at = env => resolveTrash(home, {env, now: () => MORNING});
  // 둘 다 없음: 지금과 같은 자리·같은 이름, 날짜 폴더 없음
  assert.deepEqual(at({}), {source: 'default', dated: false, base: path.join(home, '.trash'), dir: path.join(home, '.trash')});
  // 설정만
  setTrashSetting(home, {dir: b, reason: '시험'});
  assert.equal(at({}).dir, path.join(b, DAY));
  assert.equal(at({}).source, 'setting');
  // 환경변수가 설정보다 먼저
  assert.equal(at({KADAN_TRASH_DIR: a}).dir, path.join(a, DAY));
  assert.equal(at({KADAN_TRASH_DIR: a}).source, 'env');
  // 환경변수만(설정 없음)
  clearTrashSetting(home);
  assert.equal(at({KADAN_TRASH_DIR: a}).dir, path.join(a, DAY));
  // 기본 자리와 같은 글자를 명시해도 날짜 폴더가 붙는다(문자열 비교로 기본을 판정하지 않는다)
  const same = path.join(home, '.trash');
  assert.equal(at({KADAN_TRASH_DIR: same}).dir, path.join(same, DAY));
});

test('잘못된 값은 아래 단계로 넘어가지 않고 거절한다(빈 글·상대·~/·설정 손상)', () => {
  const home = tmp('bad'), good = tmp('good');
  setTrashSetting(home, {dir: good, reason: '시험'});
  for (const value of ['', '   ', 'relative/dir', './x', '~/trash', '~']) {
    assert.throws(() => resolveTrash(home, {env: {KADAN_TRASH_DIR: value}, now: () => MORNING}), /TRASH_DIR_INVALID/, JSON.stringify(value));
  }
  clearTrashSetting(home);
  // 설정 파일 손상: 기본 자리로 내려가지 않는다
  for (const body of ['{깨짐', JSON.stringify({version: 1, dir: 'relative'}), JSON.stringify({version: 2, dir: good}), '{"version":1}']) {
    fs.writeFileSync(trashSettingPath(home), body);
    assert.throws(() => resolveTrash(home, {env: {}, now: () => MORNING}), /TRASH_SETTING_CORRUPT/, body);
    assert.throws(() => moveToTrash(home, path.join(home, 'x'), 'x.json', {env: {}}), /TRASH_SETTING_CORRUPT/);
  }
  assert.equal(fs.existsSync(path.join(home, '.trash')), false, '손상 설정이어도 기본 자리에 만들지 않는다');
  assert.equal(clearTrashSetting(home).dir, '(손상된 설정)', '손상된 설정도 지울 수 있다');
  assert.equal(readTrashSetting(home), null);
});

test('날짜는 로컬 날짜다(UTC로 읽으면 오전 9시 전에 하루 어긋나는 시각)', () => {
  assert.equal(localDate(MORNING), DAY);
  assert.equal(localDate(() => MORNING), DAY);
  const out = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {localDate} from ${JSON.stringify(new URL('../src/trash-dir.mjs', import.meta.url).href)};`
    + `console.log(localDate(Date.parse('2026-11-16T23:30:00Z')))`], {encoding: 'utf8', env: {PATH: process.env.PATH, TZ: 'Asia/Seoul'}});
  assert.equal(out.stdout.trim(), '2026-11-17', 'KST 08:30은 17일이다(UTC 날짜는 16일)');
});

test('옮기기: 같은 이름은 덮어쓰지 않고 거절, 다른 디스크(EXDEV)는 복사로 우회하지 않고 원본 그대로', () => {
  const home = tmp('move'), dir = tmp('moved');
  const env = {KADAN_TRASH_DIR: dir};
  const src = path.join(home, 'a.json');
  fs.writeFileSync(src, 'A');
  const dest = moveToTrash(home, src, 'a.json', {env, now: () => MORNING});
  assert.equal(dest, path.join(dir, DAY, 'a.json'));
  assert.equal(fs.readFileSync(dest, 'utf8'), 'A');
  assert.equal(fs.existsSync(src), false);
  // 같은 이름
  fs.writeFileSync(src, 'B');
  assert.throws(() => moveToTrash(home, src, 'a.json', {env, now: () => MORNING}), /TRASH_EXISTS/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'A', '덮어쓰지 않았다');
  assert.equal(fs.readFileSync(src, 'utf8'), 'B', '원본 그대로');
  // 휴지통 밖으로 나가는 이름
  assert.throws(() => moveToTrash(home, src, '../escape.json', {env, now: () => MORNING}), /TRASH_DIR_INVALID/);
  // EXDEV
  withExdev(dir, () => assert.throws(() => moveToTrash(home, src, 'b.json', {env, now: () => MORNING}), /TRASH_CROSS_DEVICE/));
  assert.equal(fs.readFileSync(src, 'utf8'), 'B', 'EXDEV여도 원본 그대로');
  assert.equal(fs.existsSync(path.join(dir, DAY, 'b.json')), false, '복사하지 않았다');
});

test('안내 문구용 경로는 어떤 설정 오류에도 던지지 않고 오류 문구를 그대로 보인다', () => {
  const home = tmp('describe'), dir = tmp('describedir');
  assert.equal(describeTrash(home, {env: {}}), path.join(home, '.trash'));
  assert.equal(describeTrash(home, {env: {KADAN_TRASH_DIR: dir}, now: () => MORNING}), path.join(dir, DAY));
  assert.match(describeTrash(home, {env: {KADAN_TRASH_DIR: 'relative'}}), /휴지통 설정 오류: TRASH_DIR_INVALID/);
  fs.writeFileSync(trashSettingPath(home), '{깨짐');
  assert.match(describeTrash(home, {env: {}}), /TRASH_SETTING_CORRUPT/);
});

test('revive: 손상 상태 파일은 정해진 휴지통으로 옮기고, 옮기지 못하면 원본·표시 파일을 그대로 둔다', () => {
  const home = tmp('revive'), dir = tmp('revivedir');
  const file = path.join(home, 'revive-state.json'), marker = path.join(home, 'revive-corrupt.notified');
  fs.writeFileSync(file, '{깨짐');
  fs.writeFileSync(marker, 'sig');
  // EXDEV: 새 상태 파일을 쓰지 않고 표시 파일도 지우지 않는다
  withExdev(dir, () => assert.throws(() => recoverCorruptState(home, MORNING, {KADAN_TRASH_DIR: dir}), /TRASH_CROSS_DEVICE/));
  assert.equal(fs.readFileSync(file, 'utf8'), '{깨짐');
  assert.equal(fs.existsSync(marker), true, 'notified 파일 유지');
  // 잘못된 환경값도 같다
  assert.throws(() => recoverCorruptState(home, MORNING, {KADAN_TRASH_DIR: 'relative'}), /TRASH_DIR_INVALID/);
  assert.equal(fs.existsSync(marker), true);
  // 정상
  const moved = recoverCorruptState(home, MORNING, {KADAN_TRASH_DIR: dir});
  assert.equal(path.dirname(moved), path.join(dir, DAY));
  assert.match(path.basename(moved), /^revive-state-.*\.json$/);
  assert.equal(fs.readFileSync(moved, 'utf8'), '{깨짐');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(home, '.trash')), false, '기본 자리에는 만들지 않는다');
});

test('revive: 사람이 친 up(clearForUp)도 옮기기 실패에서 멈추고, 자동 알림 문구는 설정이 잘못돼도 던지지 않는다', () => {
  const home = tmp('reviveup'), dir = tmp('reviveupdir');
  const file = path.join(home, 'revive-state.json');
  fs.writeFileSync(file, '{깨짐');
  const before = process.env.KADAN_TRASH_DIR;
  try {
    process.env.KADAN_TRASH_DIR = dir;
    withExdev(dir, () => assert.throws(() => clearForUp(home), /TRASH_CROSS_DEVICE/));
    assert.equal(fs.readFileSync(file, 'utf8'), '{깨짐', '새 상태 파일을 쓰지 않았다');
    assert.equal(readReviveState(home).corrupt, true);
    // 자동(--auto)은 옮기지 않고 알림만 낸다. 환경 값이 잘못돼도 안내 문구가 던지지 않는다.
    process.env.KADAN_TRASH_DIR = 'relative';
    const notices = [];
    const ops = {sessionOf: t => `kadan-${t}`, exists: () => false, paneState: () => 'live', capture: () => '', kill() {},
      applicable: () => true, stuck: () => null, notify: message => { notices.push(message); return {}; }, record() {}};
    const result = prepareRevive({home, auto: true, now: MORNING, ops});
    assert.equal(result.corrupt, true);
    assert.deepEqual([...result.skip].sort(), [...TARGETS].sort());
    assert.match(notices[0], /휴지통 설정 오류/);
  } finally {
    if (before === undefined) delete process.env.KADAN_TRASH_DIR; else process.env.KADAN_TRASH_DIR = before;
  }
});

test('infra-restart: 옮기지 못하면 던지지 않고 거절하며 원본·시작을 건드리지 않는다', async () => {
  const home = tmp('infra'), dir = tmp('infradir');
  const file = path.join(home, 'revive-state.json');
  fs.writeFileSync(file, '{깨짐');
  const calls = [];
  const deps = {stop: t => calls.push(['stop', t]), start: t => { calls.push(['start', t]); return 'started'; },
    verify: async () => true, notify: () => {}, record: () => {}};
  const before = process.env.KADAN_TRASH_DIR;
  try {
    process.env.KADAN_TRASH_DIR = dir;
    const result = await withExdev(dir, () => restartInfra({home, target: 'watch', byRole: null, deps, waitMs: 20, pollMs: 5, stableMs: 5}));
    assert.equal(result.ok, false);
    assert.equal(result.result, 'refused');
    assert.match(result.message, /TRASH_CROSS_DEVICE/);
    assert.equal(calls.length, 0, '끄지도 시작하지도 않음');
    assert.equal(fs.readFileSync(file, 'utf8'), '{깨짐');
  } finally {
    if (before === undefined) delete process.env.KADAN_TRASH_DIR; else process.env.KADAN_TRASH_DIR = before;
  }
});

test('autostart remove: 정해진 휴지통으로 옮기고, 옮기지 못하면 plist를 그대로 둔다', () => {
  const root = tmp('autostart'), dir = tmp('autostartdir');
  const base = env => ({home: path.join(root, 'kadan'), userHome: root, cli: '/repo/src/cli.mjs', node: '/node/bin/node', cwd: '/work',
    env: {PATH: '/usr/bin', ...env}, now: new Date(MORNING)});
  const plist = path.join(root, 'Library', 'LaunchAgents', AUTOSTART_LABEL + '.plist');
  autostartCommand('install', base({}));
  assert.equal(fs.existsSync(plist), true);
  const options = base({KADAN_TRASH_DIR: dir});
  withExdev(dir, () => assert.throws(() => autostartCommand('remove', options), /TRASH_CROSS_DEVICE/));
  assert.equal(fs.existsSync(plist), true, 'plist 유지');
  assert.throws(() => autostartCommand('remove', base({KADAN_TRASH_DIR: 'relative'})), /TRASH_DIR_INVALID/);
  assert.equal(fs.existsSync(plist), true);
  const removed = autostartCommand('remove', options);
  assert.equal(removed.changed, true);
  assert.equal(path.dirname(path.dirname(removed.movedTo)), path.join(dir, DAY));
  assert.equal(path.basename(removed.movedTo), AUTOSTART_LABEL + '.plist');
  assert.equal(fs.existsSync(plist), false);
  assert.equal(fs.existsSync(path.join(root, 'kadan', '.trash')), false);
});

function pruneFixture() {
  const home = tmp('prune'), file = path.join(home, 'parents.json');
  const now = Date.parse('2026-09-28T12:00:00Z'), old = new Date(now - 48 * 3600_000).toISOString(), started = new Date(now - 72 * 3600_000).toISOString();
  fs.writeFileSync(file, JSON.stringify({boss: '@user', leaf: 'boss'}));
  const entries = [{kind: 'hierarchy-loaded', path: file}, ...['boss', 'leaf'].flatMap(role => [{kind: 'start', role, panePid: 10, t: started}, {kind: 'stop', role, t: old}])];
  const options = {home, file, floor: {list: () => []}, now: () => now, readSnapshot: () => ({entries, cards: [], works: [], version: null})};
  return {home, file, now, options};
}

test('hierarchy-prune: 백업 사본은 정해진 휴지통에 쓰고(원본 유지), 자리가 잘못되면 적용하지 않는다', () => {
  const f = pruneFixture(), dir = tmp('prunedir'), original = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => pruneHierarchy({...f.options, apply: true, env: {KADAN_TRASH_DIR: 'relative'}}), /TRASH_DIR_INVALID/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original, '잘못된 자리면 관계표를 바꾸지 않는다');
  // 휴지통 자리를 폴더로 만들 수 없을 때(파일 아래)도 적용하지 않는다
  const blocker = path.join(f.home, 'blocker');
  fs.writeFileSync(blocker, 'x');
  assert.throws(() => pruneHierarchy({...f.options, apply: true, env: {KADAN_TRASH_DIR: path.join(blocker, 'sub')}}));
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  const result = pruneHierarchy({...f.options, apply: true, env: {KADAN_TRASH_DIR: dir}});
  assert.equal(result.applied, true);
  assert.equal(path.dirname(result.backup), path.join(dir, localDate(f.now)));
  assert.match(path.basename(result.backup), /^parents\.json\.before-prune-/);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original, '백업은 사본이다');
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
  assert.notEqual(fs.readFileSync(f.file, 'utf8'), original);
});

test('kadan trash: show·set·clear, --reason 필수, 절대경로만, 0600 파일 하나', () => {
  const home = tmp('cli'), dir = tmp('clidir');
  const show = (env = {}) => run(home, ['trash', 'show'], env);
  let r = show();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /미설정/);
  assert.match(r.stdout, new RegExp(`${path.join(home, '.trash')} \\(기본값\\)`));
  // reason 없이는 거절
  r = run(home, ['trash', 'set', dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--reason/);
  assert.equal(fs.existsSync(trashSettingPath(home)), false);
  // 상대경로·~/ 거절
  for (const bad of ['relative/dir', '~/trash']) {
    r = run(home, ['trash', 'set', bad, '--reason', '시험']);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /TRASH_DIR_INVALID/);
  }
  assert.equal(fs.existsSync(trashSettingPath(home)), false, '거절된 값은 파일을 만들지 않는다');
  // 정상
  r = run(home, ['trash', 'set', dir, '--reason', '공용 휴지통으로 모은다']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(trashSettingPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(home).filter(n => n.startsWith('trash-setting')), ['trash-setting.json'], '임시 파일이 남지 않는다');
  assert.equal(readTrashSetting(home).reason, '공용 휴지통으로 모은다');
  r = show();
  assert.match(r.stdout, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.stdout, /기계 설정, 오늘 날짜 폴더 포함/);
  // 환경변수가 먼저
  r = show({KADAN_TRASH_DIR: path.join(dir, 'other')});
  assert.match(r.stdout, /환경변수/);
  assert.match(r.stdout, /환경변수 KADAN_TRASH_DIR가 기계 설정보다 먼저/);
  // 환경변수가 잘못되면 show도 거절을 보이고 죽지 않는다
  r = show({KADAN_TRASH_DIR: 'relative'});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /옮기지 않는다\(거절\)/);
  // clear
  r = run(home, ['trash', 'clear']);
  assert.equal(r.status, 2);
  r = run(home, ['trash', 'clear', '--reason', '되돌림']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(trashSettingPath(home)), false);
  assert.match(run(home, ['trash', 'clear', '--reason', '또']).stdout, /지울 휴지통 설정이 없다/);
  // 도움말은 아무것도 하지 않는다
  assert.match(run(home, ['trash', 'set', dir, '--help']).stdout, /사용법: kadan trash/);
  assert.equal(fs.existsSync(trashSettingPath(home)), false);
});
