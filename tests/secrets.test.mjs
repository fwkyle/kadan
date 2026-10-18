import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  SECRET_NAMES, secretEnvVar, resolveSecret, loadSecret, setSecretFile, unsetSecretFile,
  readSecretsSetting, initSecretsDir, defaultSecretPath, secretsSettingPath,
} from '../src/secrets.mjs';
import {setNotifySetting, effectiveNotifyEnvFile, readDiscordSecrets} from '../src/notify-setting.mjs';
import {cmdSecrets} from '../src/commands/secrets.mjs';
import {cmdNotify} from '../src/commands/notify.mjs';
import {notifyUser as rawNotifyUser} from '../src/user-notify.mjs';
import {importStorage, exportStorage, activateStorage, storageCommand} from '../src/storage-migration.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {CardStore} from '../src/card-store.mjs';
import {runInit} from '../src/quickstart.mjs';
const notifyUser = (message, spawn, opts = {}) => rawNotifyUser(message, spawn, {kind: 'alert', ...opts}); // 전송 시험은 새 글 대상 종류로 돌린다(정책은 notify-policy.test.mjs)

// 가짜 값만 쓴다. 어떤 값도 실제 주소·토큰·ID가 아니다.
const FAKE_TOKEN = 'FAKE-TOKEN-zz9981', FAKE_USER = '123456789012', FAKE_BOT = 'FAKE-BOT-qq7731';
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), `kadan-secrets-${prefix}-`));
const fakeEnv = (dir, name = 'x.env', extra = '') => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `DISCORD_WEBHOOK_URL=http://127.0.0.1:1/api/webhooks/1/${FAKE_TOKEN}\nDISCORD_USER_ID=${FAKE_USER}\n${extra}`, {mode: 0o600});
  return file;
};
const run = (fn, argv, flags, opts) => { const out = []; fn(argv, flags, {...opts, print: l => out.push(l)}); return out.join('\n'); };

test('이름 목록과 환경변수 이름 규칙', () => {
  assert.deepEqual(SECRET_NAMES, ['discord', 'discord-bot', 'explain-ai']);
  assert.equal(secretEnvVar('discord'), 'KADAN_SECRET_DISCORD_FILE');
  assert.equal(secretEnvVar('discord-bot'), 'KADAN_SECRET_DISCORD_BOT_FILE');
  assert.equal(secretEnvVar('explain-ai'), 'KADAN_SECRET_EXPLAIN_AI_FILE');
});

test('1 읽는 순서는 이름별로 환경변수 > 설정 > 기본 위치이고 옛 별칭도 discord에 같은 값을 준다', () => {
  const home = tmp('order'), a = path.join(home, 'a.env'), b = path.join(home, 'b.env'), c = path.join(home, 'c.env');
  for (const name of SECRET_NAMES) assert.deepEqual(
    (({source, path: p}) => ({source, p}))(resolveSecret({}, home, name)), {source: 'default', p: defaultSecretPath(home, name)});
  setSecretFile(home, 'discord', a); setSecretFile(home, 'discord-bot', b);
  assert.deepEqual(resolveSecret({}, home, 'discord').source, 'setting');
  assert.equal(resolveSecret({}, home, 'discord').path, a);
  assert.equal(resolveSecret({}, home, 'discord-bot').path, b);
  assert.equal(resolveSecret({}, home, 'explain-ai').source, 'default'); // 이름마다 따로
  // 환경변수가 설정을 이긴다. 옛 별칭 KADAN_NOTIFY_ENV_FILE도 같은 값이고, 둘 다 있으면 새 이름이 이긴다.
  assert.equal(resolveSecret({KADAN_NOTIFY_ENV_FILE: c}, home, 'discord').path, c);
  assert.equal(resolveSecret({KADAN_NOTIFY_ENV_FILE: c}, home, 'discord').source, 'env');
  assert.equal(resolveSecret({KADAN_SECRET_DISCORD_FILE: b, KADAN_NOTIFY_ENV_FILE: c}, home, 'discord').path, b);
  assert.equal(resolveSecret({KADAN_NOTIFY_ENV_FILE: c}, home, 'discord-bot').path, b); // 옛 별칭은 discord에만 적용
  // notify set discord는 secrets set discord와 같은 설정을 쓴다.
  const home2 = tmp('alias');
  cmdNotify(['set', 'discord'], {'env-file': a}, {home: home2, env: {}, print() {}});
  assert.equal(readSecretsSetting(home2).files.discord, a);
  assert.equal(resolveSecret({}, home2, 'discord').path, a);
  assert.equal(resolveSecret({}, home2, 'discord').source, 'setting');
});

test('2 기존 알림 설정 파일(notify-setting.json)이 있는 홈에서 새 코드가 같은 비밀 경로를 찾고 디코 경로가 이어진다', () => {
  const home = tmp('legacy'), file = fakeEnv(home);
  setNotifySetting(home, {envFile: file}); // 옛 형식 파일 그대로
  assert.ok(fs.existsSync(path.join(home, 'notify-setting.json')) && !fs.existsSync(secretsSettingPath(home)));
  const r = resolveSecret({}, home, 'discord');
  assert.deepEqual([r.path, r.source, r.via], [file, 'setting', 'notify-setting.json']);
  assert.deepEqual(effectiveNotifyEnvFile({}, home), {envFile: file, source: 'setting', error: null});
  assert.equal(readDiscordSecrets(file).userId, FAKE_USER);
  // 새 설정이 있으면 새 설정이 이긴다.
  const other = fakeEnv(home, 'other.env'); setSecretFile(home, 'discord', other);
  assert.equal(resolveSecret({}, home, 'discord').path, other);
  // 디코 알림 통로: 설정 오류가 아니라 실제로 보내기를 시도한다(주소는 닫힌 로컬 포트라 실패하지만 config-error는 아니다).
  const home2 = tmp('legacy2'); setNotifySetting(home2, {envFile: fakeEnv(home2)});
  const res = notifyUser('m', () => ({status: 0}), {home: home2, env: {KADAN_NOTIFY: ''}, totalMs: 4000});
  assert.notEqual(res.discord?.outcome, 'config-error');
  assert.ok(res.discord, '디코 시도 결과가 있어야 한다');
  // unset은 옛 파일도 풀어 지운 경로가 되살아나지 않게 한다.
  assert.equal(unsetSecretFile(home, 'discord'), true);
  assert.equal(resolveSecret({}, home, 'discord').source, 'default');
  assert.ok(!fs.existsSync(path.join(home, 'notify-setting.json')));
});

test('기본 위치(secrets/discord.env)는 파일이 있을 때만 쓰고 없으면 미설정(시스템 알림만)', () => {
  const home = tmp('default');
  assert.deepEqual(effectiveNotifyEnvFile({}, home), {envFile: null, source: 'default', error: null});
  initSecretsDir(home);
  const file = fakeEnv(path.join(home, 'secrets'), 'discord.env');
  assert.deepEqual(effectiveNotifyEnvFile({}, home), {envFile: file, source: 'default', error: null});
  assert.equal(loadSecret({}, home, 'discord').values.DISCORD_USER_ID, FAKE_USER);
});

test('3 show는 출처·경로·키 이름만 보이고 값은 출력·오류에 없으며 권한이 넓으면 경고한다', () => {
  const home = tmp('show'), dir = path.join(home, 'secrets');
  initSecretsDir(home);
  const file = fakeEnv(dir, 'discord.env', `EXTRA_KEY=${FAKE_BOT}\n`);
  fs.writeFileSync(path.join(dir, 'discord-bot.env'), `DISCORD_BOT_TOKEN=${FAKE_BOT}\nDISCORD_APPLICATION_ID=998877\n`, {mode: 0o644});
  fs.chmodSync(dir, 0o755);
  const out = run(cmdSecrets, ['show'], {}, {home, env: {}});
  for (const v of [FAKE_TOKEN, FAKE_USER, FAKE_BOT, '998877']) assert.ok(!out.includes(v), `값 ${v} 노출`);
  assert.match(out, /discord: 기본 위치\(secrets\/discord\.env\)/);
  assert.match(out, /키: DISCORD_USER_ID, DISCORD_WEBHOOK_URL, EXTRA_KEY/);
  assert.match(out, /키: DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN/);
  assert.match(out, /discord-bot\.env 권한이 0644라 600보다 넓다/);
  assert.match(out, /secrets 권한이 0755라 700보다 넓다/);
  assert.match(out, /explain-ai: 기본 위치.*\n\s+파일 없음/);
  assert.ok(file && !out.includes('권한 경고: ' + file)); // 600 파일은 경고 없음
  // 이름 하나만, 환경변수 출처.
  const one = run(cmdSecrets, ['show', 'discord'], {}, {home, env: {KADAN_SECRET_DISCORD_FILE: file}});
  assert.match(one, /discord: 환경변수\(KADAN_SECRET_DISCORD_FILE\)/);
  assert.ok(!one.includes('explain-ai'));
  // 읽기 때에도 경고가 따라온다(막지는 않음).
  const loaded = loadSecret({}, home, 'discord-bot');
  assert.equal(loaded.values.DISCORD_BOT_TOKEN, FAKE_BOT);
  assert.ok(loaded.warnings.length >= 1);
  // 읽기 오류에도 값이 없다.
  const missing = loadSecret({KADAN_SECRET_DISCORD_FILE: path.join(home, 'nope.env')}, home, 'discord');
  assert.match(missing.error, /읽을 수 없다\(ENOENT\)/);
});

test('5 알 수 없는 이름·상대경로를 거절하고 링크된 비밀 파일은 읽고 손상된 설정은 사유를 준다', () => {
  const home = tmp('reject');
  assert.throws(() => setSecretFile(home, 'nope', '/abs/x.env'), /알 수 없는 비밀 이름: nope/);
  assert.throws(() => setSecretFile(home, 'discord', 'rel.env'), /절대경로/);
  assert.throws(() => resolveSecret({}, home, 'nope'), /알 수 없는 비밀 이름/);
  assert.match(resolveSecret({KADAN_SECRET_DISCORD_FILE: 'rel.env'}, home, 'discord').error, /절대경로/);
  assert.ok(!fs.existsSync(secretsSettingPath(home)));
  const exit = spawnSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, 'secrets', 'set', 'discord', '--file', 'rel.env'],
    {env: {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none'}, encoding: 'utf8'});
  assert.notEqual(exit.status, 0); assert.match(exit.stderr, /절대경로/);
  const exit2 = spawnSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, 'secrets', 'show', 'nope'],
    {env: {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none'}, encoding: 'utf8'});
  assert.notEqual(exit2.status, 0); assert.match(exit2.stderr, /알 수 없는 비밀 이름/);
  // 링크
  const real = fakeEnv(home, 'real.env'), link = path.join(home, 'link.env');
  fs.symlinkSync(real, link);
  setSecretFile(home, 'discord', link);
  assert.equal(loadSecret({}, home, 'discord').values.DISCORD_USER_ID, FAKE_USER);
  // 손상
  for (const bad of ['{bad', '{"version":2,"files":{}}', '{"version":1,"files":{"nope":"/a"}}', '{"version":1,"files":{"discord":"rel"}}']) {
    fs.writeFileSync(secretsSettingPath(home), bad);
    const r = resolveSecret({}, home, 'discord');
    assert.equal(r.source, 'broken'); assert.match(r.error, /비밀 위치 설정 손상/);
    assert.match(run(cmdSecrets, ['show', 'discord'], {}, {home, env: {}}), /설정 손상/);
    assert.match(effectiveNotifyEnvFile({}, home).error, /손상/);
    assert.throws(() => setSecretFile(home, 'discord', real), /손상/); // 손상 위에 덮어쓰지 않는다
    assert.equal(effectiveNotifyEnvFile({KADAN_SECRET_DISCORD_FILE: real}, home).source, 'env'); // 환경변수가 정하면 막지 않는다
  }
  assert.equal(unsetSecretFile(home, 'discord'), true); // 손상도 unset으로 복구
  assert.equal(resolveSecret({}, home, 'discord').source, 'default');
});

test('set/unset은 이름별로 따로이고 원자적으로 쓰며 값은 저장하지 않는다. init은 빈 폴더만 만든다', () => {
  const home = tmp('setunset'), a = fakeEnv(home, 'a.env'), b = fakeEnv(home, 'b.env');
  setSecretFile(home, 'discord', a); setSecretFile(home, 'discord-bot', b);
  const raw = fs.readFileSync(secretsSettingPath(home), 'utf8');
  assert.ok(!raw.includes(FAKE_TOKEN) && !raw.includes(FAKE_USER));
  assert.equal(fs.statSync(secretsSettingPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(home).filter(f => f.endsWith('.tmp')), []);
  assert.equal(unsetSecretFile(home, 'discord'), true);
  assert.deepEqual(Object.keys(readSecretsSetting(home).files), ['discord-bot']);
  assert.equal(unsetSecretFile(home, 'discord-bot'), true);
  assert.ok(!fs.existsSync(secretsSettingPath(home)));
  assert.equal(unsetSecretFile(home, 'discord'), false);
  // init
  const fresh = tmp('init');
  const r = initSecretsDir(fresh);
  assert.equal(r.created, true);
  assert.equal(fs.statSync(r.dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(r.dir), []); // 값 파일을 만들지 않는다
  fs.chmodSync(r.dir, 0o755);
  assert.equal(initSecretsDir(fresh).created, false);
  assert.equal(fs.statSync(r.dir).mode & 0o777, 0o755); // 이미 있으면 권한을 바꾸지 않는다
});

function sqliteHome() { const home = tmp('store'); createDatabase(home); writeStorageMarker(home, 'sqlite'); return home; }

test('4 storage export 결과에 secrets/가 없다(가짜 값 파일 포함) — 링크된 secrets도, 다른 곳의 같은 이름 폴더는 그대로', () => {
  const source = sqliteHome(), out = source + '-out';
  new CardStore(source).create({repo: 'r', id: 'a', repoPath: source, body: '# a'});
  initSecretsDir(source);
  fs.writeFileSync(path.join(source, 'secrets', 'discord.env'), `DISCORD_USER_ID=${FAKE_USER}\nDISCORD_WEBHOOK_URL=${FAKE_TOKEN}\n`, {mode: 0o600});
  fs.mkdirSync(path.join(source, 'cards', 'secrets'), {recursive: true}); // 최상위가 아닌 같은 이름은 제외 대상이 아니다
  fs.writeFileSync(path.join(source, 'cards', 'secrets', 'keep.txt'), 'keep');
  storageCommand(['pause'], {}, {home: source});
  const result = exportStorage(source, out);
  assert.equal(result.backend, 'jsonl');
  assert.ok(!fs.existsSync(path.join(out, 'secrets')), 'export에 secrets/가 있다');
  assert.ok(fs.existsSync(path.join(out, 'cards', 'secrets', 'keep.txt')));
  const all = spawnSync('grep', ['-r', '-l', FAKE_TOKEN, out], {encoding: 'utf8'});
  assert.equal(all.stdout, '', '가짜 값이 export 어딘가에 있다');
});

test('4 import와 activate 경로도 secrets/를 뺀다(링크로 된 secrets 포함)', () => {
  const source = tmp('imp'); // JSONL 홈
  new CardStore(source).create({repo: 'r', id: 'a', repoPath: source, body: '# a'});
  const elsewhere = tmp('elsewhere');
  fs.writeFileSync(path.join(elsewhere, 'discord.env'), `DISCORD_USER_ID=${FAKE_USER}\nTOKEN=${FAKE_TOKEN}\n`);
  fs.symlinkSync(elsewhere, path.join(source, 'secrets')); // 사용자가 secrets를 다른 곳으로 링크해 둔 경우
  const target = source + '-candidate';
  importStorage(source, target); // 링크 secrets가 있어도 중앙 기록 링크 오류가 나지 않고 복사에서도 빠진다
  assert.ok(!fs.existsSync(path.join(target, 'secrets')));
  storageCommand(['pause'], {}, {home: source}); storageCommand(['pause'], {}, {home: target});
  const act = activateStorage(source, target, {writersStopped: true});
  assert.equal(act.backend, 'sqlite');
  assert.ok(fs.existsSync(path.join(source, 'secrets')), 'activate가 원본 secrets를 건드렸다');
  assert.equal(fs.readFileSync(path.join(elsewhere, 'discord.env'), 'utf8').includes(FAKE_TOKEN), true);
  const all = spawnSync('grep', ['-r', '-l', FAKE_TOKEN, target], {encoding: 'utf8'});
  assert.equal(all.stdout, '');
});

test('quickstart init은 빈 secrets/(700)만 만들고 값 파일은 만들지 않는다', () => {
  const home = tmp('qs'), userHome = tmp('qsu'), repo = tmp('qsr');
  const okSpawn = () => ({status: 0, stdout: 'tmux 3.4'});
  const lines = [];
  const r = runInit({home, repoRoot: repo, spawn: okSpawn, which: () => null, flags: {'no-skills': true}, userHome, log: l => lines.push(l)});
  assert.equal(r.secrets.created, true);
  assert.equal(fs.statSync(path.join(home, 'secrets')).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.join(home, 'secrets')), []);
  assert.ok(lines.some(l => l.includes('비밀 폴더')));
  assert.equal(runInit({home, repoRoot: repo, spawn: okSpawn, which: () => null, flags: {'no-skills': true}, userHome, log() {}}).secrets.created, false);
});

test('CLI: kadan secrets set/show/unset/init이 격리 홈에서 끝까지 돈다', () => {
  const home = tmp('cli'), file = fakeEnv(home, 'cli.env');
  const cli = args => spawnSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, 'secrets', ...args],
    {env: {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none', KADAN_SECRET_DISCORD_FILE: '', KADAN_NOTIFY_ENV_FILE: ''}, encoding: 'utf8'});
  assert.equal(cli(['init']).status, 0);
  const set = cli(['set', 'discord', '--file', file]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /기계 설정\(secrets-setting\.json\)/);
  assert.ok(!set.stdout.includes(FAKE_TOKEN));
  assert.match(cli(['show']).stdout, /discord: 기계 설정/);
  assert.match(cli(['unset', 'discord']).stdout, /고정을 풀었다/);
  assert.match(cli(['unset', 'discord']).stdout, /풀 고정이 없다/);
  assert.notEqual(cli(['bogus']).status, 0);
});
