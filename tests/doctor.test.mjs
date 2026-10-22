import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {runDoctor, renderDoctor, doctorJson, sqliteWalState} from '../src/doctor.mjs';
import {appendLedger, readSystemLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {startDigest} from '../src/secretary-resume.mjs';
import {DASHBOARD_BUILD_COMMAND} from '../src/dashboard-static.mjs';

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// 격리된 가짜 세상: 데이터 폴더·사용자 홈·저장소 폴더가 모두 임시 폴더다. 실제 tmux·AI는 쓰지 않는다.
function world({build = true, alive = ['비서', '대시보드'], bridge = 'no-secret', settings = true, skills = true} = {}) {
  const root = tmp('kadan-doctor-');
  const home = path.join(root, 'home'), userHome = path.join(root, 'user'), repoRoot = path.join(root, 'repo');
  for (const dir of [home, userHome, repoRoot]) fs.mkdirSync(dir, {recursive: true});
  if (build) {
    fs.mkdirSync(path.join(repoRoot, 'gui', 'dist'), {recursive: true});
    fs.writeFileSync(path.join(repoRoot, 'gui', 'dist', 'index.html'), '<html></html>');
  }
  if (settings) {
    fs.writeFileSync(path.join(home, 'runner-settings.json'),
      JSON.stringify({version: 1, revision: 1, activePreset: 'p', presets: {p: {roles: {}}}, runners: {}}));
  }
  fs.mkdirSync(path.join(repoRoot, 'skills', 'kadan-go'), {recursive: true});
  fs.mkdirSync(path.join(userHome, '.codex', 'skills'), {recursive: true});
  if (skills) {
    fs.symlinkSync(path.join(repoRoot, 'skills', 'kadan-go'), path.join(userHome, '.codex', 'skills', 'kadan-go'));
  }
  const aliveSet = new Set(alive);
  const deps = {
    home, repoRoot, userHome, cli: path.join(repoRoot, 'src', 'cli.mjs'), platform: 'linux',
    env: {KADAN_HOME: home, KADAN_SOCKET: 'kadan-doctor-test', KADAN_WINDOW: 'none'},
    nodeVersion: '24.1.0', floorName: 'tmux',
    run: () => ({status: 0, stdout: 'tmux 3.4\n'}),
    probes: {alive: target => aliveSet.has(target), watchProfile: () => false, bridgeStatus: () => bridge},
  };
  return {root, home, userHome, repoRoot, deps};
}
const byId = (report, id) => report.checks.find(c => c.id === id);
const startEntry = (home, cmd) => appendLedger({kind: 'start', floor: 'tmux', role: '비서', session: 'kadan-비서',
  panePid: '20', cwd: home, roleProfile: 'secretary', cmd, by: '사람', t: new Date().toISOString()}, home);

// 폴더 안 모든 항목의 종류·크기·mtime·권한. doctor 전후가 같아야 "아무것도 쓰지 않았다".
function snapshot(dir) {
  const out = {};
  const walk = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file);
      const kind = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : 'f';
      out[path.relative(dir, file)] = `${kind}:${stat.size}:${stat.mtimeMs}:${stat.mode}`;
      if (stat.isDirectory()) walk(file);
    }
  };
  walk(dir);
  return out;
}

test('정상: 막힘이 없으면 종료 코드 0이고 정상·해당 없음만 나온다', () => {
  const w = world();
  const report = runDoctor(w.deps);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.checks.filter(c => !['ok', 'na'].includes(c.state)), []);
  assert.equal(report.checks.length, 11, '기본이 아닌 홈이라 11개가 모두 보인다');
  assert.equal(byId(report, 'dashboard-build').state, 'ok');
  assert.equal(byId(report, 'secretary-checkpoint').state, 'na');
  assert.match(renderDoctor(report), /대시보드 화면 \| 정상 \| .+ \| -/);
});

test('gui/dist가 없으면 막힘이고 종료 코드 1, 풀려면 칠 명령을 보인다', () => {
  const report = runDoctor(world({build: false}).deps);
  const row = byId(report, 'dashboard-build');
  assert.equal(row.state, 'blocked');
  assert.equal(row.fix, DASHBOARD_BUILD_COMMAND);
  assert.equal(report.exitCode, 1);
  assert.match(renderDoctor(report), /대시보드 화면 \| 막힘 \| .*503.* \| 풀려면: npm --prefix gui ci && npm run build:gui/);
});

test('index.html이 있어도 읽을 수 없으면 막힘이다(폴더 존재가 아니라 파일 읽기로 본다)', t => {
  if (process.getuid?.() === 0) return t.skip('root는 권한과 무관하게 읽는다');
  const w = world();
  const file = path.join(w.repoRoot, 'gui', 'dist', 'index.html');
  fs.chmodSync(file, 0o000);
  try {
    const report = runDoctor(w.deps);
    assert.equal(byId(report, 'dashboard-build').state, 'blocked');
    assert.match(byId(report, 'dashboard-build').reason, /읽을 수 없다/);
    assert.equal(report.exitCode, 1);
  } finally { fs.chmodSync(file, 0o600); }
});

test('복원 잠금이 남아 있으면 주의로 경로만 보이고 지우지 않는다', () => {
  const w = world();
  const lock = path.join(w.home, 'recovery', 'role-abc.lock');
  fs.mkdirSync(lock, {recursive: true});
  const report = runDoctor(w.deps);
  const row = byId(report, 'recovery-locks');
  assert.equal(row.state, 'warn');
  assert.ok(row.reason.includes(lock), '경로를 보인다');
  assert.equal(report.exitCode, 0, '주의는 종료 코드를 바꾸지 않는다');
  assert.ok(fs.existsSync(lock), 'doctor는 잠금을 지우지 않는다');
});

test('비서가 claude면 체크포인트는 해당 없음, codex인데 파일이 없으면 상태에 따라 주의/막힘', () => {
  const claude = world();
  startEntry(claude.home, 'claude --model x');
  assert.equal(byId(runDoctor(claude.deps), 'secretary-checkpoint').state, 'na');
  assert.match(byId(runDoctor(claude.deps), 'secretary-checkpoint').reason, /claude/);

  const living = world();
  startEntry(living.home, 'codex --model x');
  assert.equal(byId(runDoctor(living.deps), 'secretary-checkpoint').state, 'warn', '살아 있는 비서면 주의');

  const dead = world({alive: ['대시보드']});
  startEntry(dead.home, 'codex --model x');
  const report = runDoctor(dead.deps);
  assert.equal(byId(report, 'secretary-checkpoint').state, 'blocked', '죽은 비서는 복원이 막힌다');
  assert.equal(report.exitCode, 1);
  assert.ok(!fs.existsSync(path.join(dead.home, 'secretary-resume.json')), '체크포인트를 만들지 않는다');
});

test('체크포인트가 맞으면 정상이다(복원 판정과 같은 함수를 쓴다)', () => {
  const w = world();
  const transcript = path.join(w.root, 'rollout-x.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({type: 'session_meta', payload: {id: 'conv-1', cwd: w.home}}) + '\n');
  startEntry(w.home, 'codex --model x');
  // 원장이 붙이는 필드까지 같아야 지문이 맞으므로 실제 원장에서 읽은 기록으로 지문을 만든다.
  const stored = readSystemLedger(w.home).find(e => e.kind === 'start');
  fs.writeFileSync(path.join(w.home, 'secretary-resume.json'), JSON.stringify({
    version: 1, startDigest: startDigest(stored), transcript, conversation: 'conv-1', cwd: w.home,
    command: "'codex' 'resume' 'conv-1'"}));
  assert.equal(byId(runDoctor(w.deps), 'secretary-checkpoint').state, 'ok');
});

test('디코 미설정은 해당 없음, 디코 설정 오류는 주의다', () => {
  assert.equal(byId(runDoctor(world({bridge: 'no-secret'}).deps), 'base').state, 'ok');
  assert.match(byId(runDoctor(world({bridge: 'no-secret'}).deps), 'base').reason, /디코 다리 해당 없음/);
  const bad = byId(runDoctor(world({bridge: 'bad-config: 채널 없음'}).deps), 'base');
  assert.equal(bad.state, 'warn');
  assert.match(bad.reason, /디코 다리: 설정 오류/);
});

test('기반 프로세스: 비서·대시보드가 없으면 막힘, revive 멈춤 표시를 읽어 이유를 보인다', () => {
  const w = world({alive: []});
  assert.equal(byId(runDoctor(w.deps), 'base').state, 'blocked');
  fs.writeFileSync(path.join(w.home, 'revive-state.json'),
    JSON.stringify({targets: {비서: {state: 'stopped'}, 대시보드: {state: 'capped'}}}));
  const row = byId(runDoctor(w.deps), 'base');
  assert.equal(row.state, 'blocked');
  assert.match(row.reason, /비서: 사람이 꺼 둔/);
  assert.match(row.reason, /대시보드: 1시간에 3번/);
  fs.writeFileSync(path.join(w.home, 'revive-state.json'), '{깨짐');
  assert.match(byId(runDoctor(w.deps), 'base').reason, /revive-state\.json이 깨져/);
  assert.equal(fs.readFileSync(path.join(w.home, 'revive-state.json'), 'utf8'), '{깨짐', '깨진 파일을 옮기거나 고치지 않는다');
});

test('창 설정이 손상되면 막힘이고 고치는 명령을 보인다', () => {
  const w = world();
  fs.writeFileSync(path.join(w.home, 'window-setting.json'), 'not json');
  const report = runDoctor(w.deps);
  const row = byId(report, 'settings');
  assert.equal(row.state, 'blocked');
  assert.equal(row.fix, 'kadan window unset');
  assert.equal(report.exitCode, 1);
  assert.equal(fs.readFileSync(path.join(w.home, 'window-setting.json'), 'utf8'), 'not json');
});

test('runner-settings.json이 없으면 주의다', () => {
  const row = byId(runDoctor(world({settings: false}).deps), 'settings');
  assert.equal(row.state, 'warn');
  assert.match(row.fix, /kadan runners init/);
});

test('기본이 아닌 홈: 운영 바닥 거절 장치 항목이 보이고, 기본 소켓이면 막힘이다', () => {
  const w = world();
  assert.equal(byId(runDoctor(w.deps), 'live-floor').state, 'ok');
  const open = runDoctor({...w.deps, env: {...w.deps.env, KADAN_SOCKET: 'kadan'}});
  assert.equal(byId(open, 'live-floor').state, 'blocked');
  assert.match(byId(open, 'live-floor').reason, /KADAN_LIVE_FLOOR_DENIED/);
  assert.equal(open.exitCode, 1);
  const allowed = runDoctor({...w.deps, env: {...w.deps.env, KADAN_ALLOW_LIVE_FLOOR: '1'}});
  assert.equal(byId(allowed, 'live-floor').state, 'warn');
});

test('스킬 링크: 안 걸린 링크는 주의로 이름만 보이고 만들지 않는다', () => {
  const w = world({skills: false});
  const row = byId(runDoctor(w.deps), 'skills');
  assert.equal(row.state, 'warn');
  assert.match(row.reason, /kadan-go/);
  assert.equal(fs.existsSync(path.join(w.userHome, '.codex', 'skills', 'kadan-go')), false);
});

test('비밀 파일 권한이 넓으면 주의다(값은 읽지 않는다)', () => {
  const w = world();
  fs.mkdirSync(path.join(w.home, 'secrets'), {mode: 0o700});
  const file = path.join(w.home, 'secrets', 'discord.env');
  fs.writeFileSync(file, 'DISCORD_WEBHOOK_URL=https://example.invalid/x\n', {mode: 0o644});
  fs.chmodSync(file, 0o644);
  const row = byId(runDoctor(w.deps), 'secrets');
  assert.equal(row.state, 'warn');
  assert.match(row.reason, /600보다 넓다/);
  assert.doesNotMatch(JSON.stringify(row), /example\.invalid/);
});

test('autostart: macOS에서 설치돼 있지 않으면 주의, 설치 판정은 autostart status와 같다', () => {
  const w = world();
  const report = runDoctor({...w.deps, platform: 'darwin'});
  assert.equal(byId(report, 'autostart').state, 'warn');
  assert.equal(byId(report, 'autostart').fix, 'kadan autostart install');
  assert.ok(!fs.existsSync(path.join(w.userHome, 'Library')), 'plist를 만들지 않는다');
});

test('조회가 실패하면 확인 불가이고 종료 코드는 막힘만 센다', () => {
  const w = world();
  w.deps.probes.alive = () => { throw new Error('tmux 조회 실패'); };
  const report = runDoctor(w.deps);
  assert.equal(byId(report, 'base').state, 'unknown');
  assert.match(byId(report, 'base').reason, /조회 실패: tmux 조회 실패/);
  assert.equal(report.exitCode, 0);
});

test('--json 꼴: 같은 내용을 id·state·stateLabel·reason·fix로 낸다', () => {
  const json = doctorJson(runDoctor(world({build: false}).deps));
  assert.equal(json.ok, false);
  assert.equal(json.blocked, 1);
  const row = json.checks.find(c => c.id === 'dashboard-build');
  assert.deepEqual(Object.keys(row), ['id', 'name', 'state', 'stateLabel', 'reason', 'fix']);
  assert.equal(row.stateLabel, '막힘');
  assert.equal(json.checks.find(c => c.id === 'runtime').fix, null);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(json)));
});

test('무쓰기 잠금(JSONL): doctor 전후로 파일 목록·크기·mtime이 같다', () => {
  const w = world();
  startEntry(w.home, 'codex --model x');
  fs.mkdirSync(path.join(w.home, 'recovery', 'role-x.lock'), {recursive: true});
  fs.mkdirSync(path.join(w.home, 'secrets'), {mode: 0o700});
  fs.writeFileSync(path.join(w.home, 'revive-state.json'), '{깨짐');
  fs.writeFileSync(path.join(w.home, 'window-setting.json'), 'not json');
  const before = snapshot(w.root);
  runDoctor({...w.deps, platform: 'darwin'});
  runDoctor(w.deps);
  assert.deepEqual(snapshot(w.root), before);
});

test('무쓰기 잠금(빈 홈·없는 폴더): 홈이 없어도 아무것도 만들지 않는다', () => {
  const w = world();
  const missing = path.join(w.root, 'nothing-here');
  const report = runDoctor({...w.deps, home: missing, env: {...w.deps.env, KADAN_HOME: missing}});
  assert.equal(byId(report, 'storage').state, 'blocked');
  assert.equal(fs.existsSync(missing), false);
});

test('무쓰기 잠금(SQLite 닫힌 원장): 읽기 전용으로 열어도 -wal/-shm이 생기지 않는다', () => {
  const w = world();
  createDatabase(w.home);
  writeStorageMarker(w.home, 'sqlite');
  assert.equal(sqliteWalState(w.home), 'idle', '시험 준비: 닫힌 원장');
  const before = snapshot(w.root);
  const report = runDoctor(w.deps);
  assert.equal(byId(report, 'storage').state, 'ok');
  assert.match(byId(report, 'storage').reason, /파일 생성 없음/);
  assert.equal(byId(report, 'secretary-checkpoint').state, 'unknown', '닫힌 원장은 읽으면 파일이 생겨 읽지 않는다');
  assert.deepEqual(snapshot(w.root), before);
  for (const suffix of ['-wal', '-shm']) assert.ok(!fs.existsSync(path.join(w.home, `kadan.sqlite${suffix}`)));
});

test('무쓰기 잠금(SQLite 열려 있는 원장): 새 파일을 만들지 않고 원장 파일을 바꾸지 않는다', () => {
  const w = world();
  createDatabase(w.home);
  writeStorageMarker(w.home, 'sqlite');
  const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite');
  const writer = new DatabaseSync(path.join(w.home, 'kadan.sqlite'));
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    writer.exec("INSERT INTO events(stream,seq,payload) VALUES('probe',1,'{}')");
    assert.equal(sqliteWalState(w.home), 'live', '시험 준비: 열려 있는 원장');
    const names = fs.readdirSync(w.home).sort();
    const main = fs.statSync(path.join(w.home, 'kadan.sqlite'));
    const report = runDoctor(w.deps);
    assert.equal(byId(report, 'storage').state, 'ok');
    assert.notEqual(byId(report, 'secretary-checkpoint').state, 'unknown', '열려 있는 원장은 읽는다');
    assert.deepEqual(fs.readdirSync(w.home).sort(), names, '새 파일이 없다');
    const after = fs.statSync(path.join(w.home, 'kadan.sqlite'));
    assert.equal(`${after.size}:${after.mtimeMs}`, `${main.size}:${main.mtimeMs}`);
  } finally { writer.close(); }
});

test('SQLite -wal/-shm 한쪽만 있으면 열지 않고 확인 불가다', () => {
  const w = world();
  createDatabase(w.home);
  writeStorageMarker(w.home, 'sqlite');
  fs.writeFileSync(path.join(w.home, 'kadan.sqlite-wal'), '');
  const before = snapshot(w.root);
  const row = byId(runDoctor(w.deps), 'storage');
  assert.equal(row.state, 'unknown');
  assert.deepEqual(snapshot(w.root), before);
});

test('CLI: kadan doctor --json은 격리 홈에서 JSON을 내고, 막힘이 있으면 종료 코드 1이며 홈을 바꾸지 않는다', () => {
  const root = tmp('kadan-doctor-cli-');
  const home = path.join(root, 'home'), user = path.join(root, 'user');
  fs.mkdirSync(home); fs.mkdirSync(user);
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const env = {...process.env, HOME: user, KADAN_HOME: home, KADAN_SOCKET: `kadan-doctor-${process.pid}`,
    KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_FLOOR: 'tmux'};
  delete env.KADAN_ROLE;
  const before = snapshot(root);
  const run = spawnSync(process.execPath, [cli, 'doctor', '--json'], {env, encoding: 'utf8', timeout: 30000});
  const json = JSON.parse(run.stdout);
  assert.equal(json.checks.length, 11);
  assert.equal(json.checks.find(c => c.id === 'base').state, 'blocked', '세션이 하나도 없다');
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.deepEqual(snapshot(root), before, '홈과 사용자 폴더에 아무것도 만들지 않았다');
  const text = spawnSync(process.execPath, [cli, 'doctor'], {env, encoding: 'utf8', timeout: 30000});
  assert.match(text.stdout, /^node·tmux \| (정상|막힘) \| /m);
  assert.equal(spawnSync(process.execPath, [cli, 'doctor', '--help'], {env, encoding: 'utf8'}).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, 'doctor', 'extra'], {env, encoding: 'utf8'}).status, 2);
});
