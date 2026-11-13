import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ledgerHome, appendLedger, readLedger, readMailBody} from '../src/ledger.mjs';
import {tmuxFloor, tmux} from '../src/floor-tmux.mjs';
import {settingsWith} from './helpers/runner-table.mjs';
import {readSettings} from '../src/runner-settings.mjs';
import {runIdleRoles, IDLE_ROLES_SENDER} from '../src/idle-roles.mjs';
import {idleStatePath} from '../src/idle-screen-clock.mjs';

// 실제 tmux·ps·lsof·우편 명령으로 "쉼(가짜 시계) → 정리 후보 우편이 직속 감독 창에 도착 → 감독이 kadan stop → kadan reopen으로 같은 대화"
// 왕복을 확인한다. 실행기는 가짜 Node 스크립트이고 격리 홈·격리 tmux 서버만 쓴다(stop-reopen-tmux.test.mjs와 같은 틀).
const A = '0197aaaa-1111-4222-8333-444455556666';
const HOUR = 60 * 60 * 1000;
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const WATCH_PARENT = "const pp=process.ppid;setInterval(()=>{try{process.kill(pp,0)}catch{process.exit(0)}},200);";
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function until(check, what) {
  for (let i = 0; i < 400 && !check(); i++) wait(50);
  assert.ok(check(), `기다렸지만 되지 않음: ${what}`);
}

function setup(t, name) {
  const home = ledgerHome();
  const prior = {socket: process.env.KADAN_SOCKET, tmpdir: process.env.TMUX_TMPDIR, sink: process.env.KADAN_TEST_NOTIFY_SINK};
  process.env.KADAN_SOCKET = `i${process.pid}${name}`;
  const sockDir = fs.mkdtempSync('/tmp/ki-'); // 소켓 경로가 길면 tmux가 거절한다
  process.env.TMUX_TMPDIR = sockDir;
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, 'codex-home/sessions/2026/11/10'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'codex-home/thread-writer-locks'), {recursive: true});
  // 사용자 알림(디코·OS)이 하나라도 나가면 이 파일에 줄이 생긴다. 후보 알림은 사용자를 울리지 않아야 한다.
  process.env.KADAN_TEST_NOTIFY_SINK = path.join(dir, 'notify-sink.jsonl');
  t.after(() => {
    console.error(`격리 소켓 kill-server: ${sockDir}/${process.env.KADAN_SOCKET}`);
    tmux(['kill-server']);
    fs.rmSync(sockDir, {recursive: true, force: true});
    for (const [key, value] of [['KADAN_SOCKET', prior.socket], ['TMUX_TMPDIR', prior.tmpdir], ['KADAN_TEST_NOTIFY_SINK', prior.sink]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const rollout = path.join(dir, `codex-home/sessions/2026/11/10/rollout-2026-11-10T16-35-00-${A}.jsonl`);
  const lock = path.join(dir, `codex-home/thread-writer-locks/${A}.lock`);
  for (const f of [rollout, lock]) fs.writeFileSync(f, '{}');
  // 가짜 codex 본체: HOLD로 받은 파일을 열고, `resume <id>`로 뜨면 그 대화의 파일을 연다. READY 파일로 떴음을 알린다.
  const fake = path.join(dir, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('fs');
const fds=(process.env.HOLD||'').split(',').filter(Boolean).map(f=>fs.openSync(f,'r'));
const ri=process.argv.indexOf('resume');
if(ri>0&&process.argv[ri+1]){const id=process.argv[ri+1];for(const f of [${JSON.stringify(lock)},${JSON.stringify(rollout)}])try{fds.push(fs.openSync(f,'r'))}catch{}
fs.writeFileSync(${JSON.stringify(path.join(dir, 'resumed'))},JSON.stringify({id,argv:process.argv.slice(2)}));}
console.log('›');if(process.env.READY)fs.writeFileSync(process.env.READY,'ok');${WATCH_PARENT}`, {mode: 0o700});
  const settings = settingsWith({codex: {
    spawn: `${fake} --model {model} -c e={effort}`, resume: `${fake} --model {model} -c e={effort} resume {conversation}`,
    models: [{model: 'test-model', efforts: ['low']}],
    conversation: {kind: 'open-file', pattern: '/sessions/.+/rollout-[0-9T-]+-([0-9a-f-]{36})\\.jsonl$',
      evidence: ['/thread-writer-locks/([0-9a-f-]{36})\\.lock$']}}});
  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settings));
  return {home, dir, fake, rollout, lock, work: sockDir};
}

// 역할의 작업 폴더는 KADAN_HOME 밖이어야 한다. 소켓 폴더가 이미 홈 밖의 정리 대상이라 그것을 쓴다.
function launch(s, role, profile, env = {}) {
  const session = `kadan-${role}`, ready = path.join(s.dir, `ready-${role}`);
  const cmd = `${s.fake} --model test-model -c e=low`;
  const vars = Object.entries({...env, READY: ready}).map(([k, v]) => `${k}=${v}`).join(' ');
  const created = tmuxFloor.create({session, role, cwd: s.work, cmd: `env ${vars} ${cmd}`});
  appendLedger({kind: 'start', floor: 'tmux', role, session, cwd: s.work, cmd, roleProfile: profile, by: 'test', ...created});
  until(() => fs.existsSync(ready), `가짜 실행기 ${role}가 떴다`);
  return created;
}
const kadan = (...args) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8',
  env: {...process.env, KADAN_WINDOW: 'none', KADAN_FLOOR: 'tmux', KADAN_ROLE: ''}});
const skip = spawnSync('tmux', ['-V']).status !== 0;

test('실제 왕복: 쉼(가짜 시계) → 후보 우편이 직속 감독 창에 도착(아무것도 끄지 않음) → 감독이 stop → reopen으로 같은 대화', {skip}, t => {
  const s = setup(t, 'round');
  const hierarchy = path.join(s.dir, 'hierarchy.json');
  fs.writeFileSync(hierarchy, JSON.stringify({idleboss: '@user', idlecase: 'idleboss'}));
  appendLedger({kind: 'hierarchy-loaded', path: hierarchy, hash: 'x', by: 'watch'}, s.home);
  launch(s, 'idleboss', 'conductor');
  const created = launch(s, 'idlecase', 'worker', {HOLD: `${s.lock},${s.rollout}`});
  const now = Date.now();

  // 첫 표본(13시간 전으로 친다): 처음 본 세션은 그때부터 센다. 후보도 우편도 없다.
  const first = runIdleRoles({home: s.home, floor: tmuxFloor, now: now - 13 * HOUR});
  assert.equal(first.live, 2);
  assert.equal(first.stale, 0);
  assert.equal(first.mails.length, 0);

  // 기준 12시간을 넘긴 지금: 작업자가 후보이고, 실제 우편 명령으로 직속 감독에게 간다.
  const second = runIdleRoles({home: s.home, floor: tmuxFloor, now});
  assert.deepEqual(second.candidates.map(c => c.role), ['idlecase'], JSON.stringify(second.skipped));
  assert.match(second.skipped.find(x => x.role === 'idleboss').reason, /살아 있는 하위 역할이 있음\(idlecase\)/);
  assert.equal(second.mails.length, 1);
  assert.equal(second.mails[0].sent, true, JSON.stringify(second.mails[0]));
  assert.equal(second.mails[0].to, 'idleboss');
  assert.match(second.mails[0].message, new RegExp(`- idlecase · worker · .* · reopen 가능\\(대화 ${A.slice(0, 8)}\\) · 끄기: kadan stop idlecase$`, 'm'));

  // 아무것도 끄지 않았다.
  assert.equal(tmuxFloor.alive('kadan-idlecase'), true);
  assert.equal(tmuxFloor.alive('kadan-idleboss'), true);
  assert.equal(readLedger().filter(e => e.kind === 'stop' && e.session === 'kadan-idlecase').length, 0);
  // "이미 알림"의 근거: 원장 send에 보낸 쪽이 남고, 그 지문으로 본문의 역할 줄을 다시 읽을 수 있다.
  const sent = () => readLedger().filter(e => e.kind === 'send' && e.by === IDLE_ROLES_SENDER && e.role === 'idleboss');
  const sends = sent();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].role, 'idleboss');
  assert.match(readMailBody(sends[0].digest, s.home), /끄기: kadan stop idlecase$/m);
  // 감독 창에 우편이 들어갔다. 사용자 알림은 하나도 나가지 않았다.
  until(() => tmuxFloor.read('kadan-idleboss').includes('[정리 후보]'), '감독 창에 후보 우편이 보인다');
  assert.equal(fs.existsSync(process.env.KADAN_TEST_NOTIFY_SINK), false, '사용자 알림 없음');

  // 한 시간 뒤: 여전히 후보지만 다시 보내지 않는다(근거는 위 우편).
  const third = runIdleRoles({home: s.home, floor: tmuxFloor, now: now + HOUR});
  assert.deepEqual(third.candidates.map(c => c.role), ['idlecase']);
  assert.equal(third.mails.length, 0);
  assert.equal(sent().length, 1);

  // 실제 명령의 --dry-run: 목록만 보이고 상태 파일·우편은 그대로다.
  const state = fs.readFileSync(idleStatePath(s.home), 'utf8');
  const dry = kadan('idle-roles', 'run', '--dry-run');
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /^기준 12시간 · 살아 있는 역할 세션 2개 · 화면이 기준 넘게 그대로인 세션 1개 · 정리 후보 1개 · --dry-run/);
  assert.match(dry.stdout, /이미 알린 후보\(기준 시간 안\): idlecase/);
  assert.equal(fs.readFileSync(idleStatePath(s.home), 'utf8'), state);
  assert.equal(sent().length, 1);

  // 받은 감독의 판단으로 끈다 → 원장 stop에 대화 번호 → reopen으로 같은 대화.
  const stopped = kadan('stop', 'idlecase');
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  const stop = readLedger().findLast(e => e.kind === 'stop' && e.session === 'kadan-idlecase');
  assert.equal(stop.conversation, A, '우편이 예고한 그 대화 번호다');
  const reopened = kadan('reopen', 'idlecase');
  assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr);
  assert.match(reopened.stdout, new RegExp(`^다시 열림: kadan-idlecase \\(codex test-model, 대화 ${A}, `));
  until(() => fs.existsSync(path.join(s.dir, 'resumed')), '다시 연 가짜 실행기가 resume 표시를 남겼다');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'resumed'), 'utf8')).id, A);
  assert.notEqual(String(tmuxFloor.pid('kadan-idlecase')), String(created.panePid));

  // 다시 연 세션은 새 프로세스라 시계가 처음부터다: 바로 다시 후보가 되지 않는다.
  const after = runIdleRoles({home: s.home, floor: tmuxFloor, now: now + 2 * HOUR});
  assert.equal(after.stale, 0);
});

test('실제 왕복: 대화 번호를 찾지 못하는 세션도 후보로 알리되 줄에 reopen 불가를 적는다', {skip}, t => {
  const s = setup(t, 'noconv');
  const hierarchy = path.join(s.dir, 'hierarchy.json');
  fs.writeFileSync(hierarchy, JSON.stringify({idleboss2: '@user', idlelost: 'idleboss2'}));
  appendLedger({kind: 'hierarchy-loaded', path: hierarchy, hash: 'x', by: 'watch'}, s.home);
  launch(s, 'idleboss2', 'conductor');
  launch(s, 'idlelost', 'reviewer'); // 대화 파일을 열지 않은 실행기
  const now = Date.now();
  runIdleRoles({home: s.home, floor: tmuxFloor, now: now - 13 * HOUR});
  const report = runIdleRoles({home: s.home, floor: tmuxFloor, now});
  assert.equal(report.mails[0]?.sent, true, JSON.stringify(report));
  assert.match(report.mails[0].message, /- idlelost · reviewer · .* · reopen 불가\(대화 번호를 찾지 못함: undetermined\) · 끄기: kadan stop idlelost$/m);
  assert.equal(tmuxFloor.alive('kadan-idlelost'), true);
});

test('실제 명령: 기준 시간 보기·바꾸기 — 범위 밖·낡은 revision·이유 없음은 거절하고, 바꾼 사람·이유가 원장에 남는다', () => {
  const home = ledgerHome();
  fs.rmSync(path.join(home, 'runner-settings.json'), {force: true});
  const show = () => JSON.parse(kadan('idle-roles', 'show').stdout);
  assert.deepEqual({hours: show().hours, source: show().source, revision: show().revision}, {hours: 12, source: 'default', revision: null});
  const none = kadan('idle-roles', 'set', '6', '--revision', '1', '--reason', '시험');
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /실행 모델 설정이 없다/);

  fs.writeFileSync(path.join(home, 'runner-settings.json'), JSON.stringify(settingsWith({})));
  const revision = show().revision;
  assert.ok(Number.isInteger(revision));
  for (const bad of ['0', '169', '1.5', 'abc', '-3']) {
    const r = kadan('idle-roles', 'set', bad, '--revision', String(revision), '--reason', '시험');
    assert.equal(r.status, 2, `${bad}: ${r.stderr}`);
    assert.match(r.stderr, /기준 시간은 1~168 사이의 정수\(시간\)만 받는다/);
  }
  const noReason = kadan('idle-roles', 'set', '6', '--revision', String(revision));
  assert.notEqual(noReason.status, 0);
  assert.match(noReason.stderr, /이유가 필요하다/);
  assert.equal(show().hours, 12, '거절된 값은 저장되지 않는다');

  const ok = kadan('idle-roles', 'set', '6', '--revision', String(revision), '--reason', '끝난 역할을 더 빨리 알림');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), {hours: 6, revision: revision + 1});
  assert.deepEqual({hours: show().hours, source: show().source, revision: show().revision}, {hours: 6, source: 'setting', revision: revision + 1});
  const event = readLedger().findLast(e => e.kind === 'runner-settings');
  assert.deepEqual({action: event.action, by: event.by, reason: event.reason, before: event.before, after: event.after, revision: event.revision},
    {action: 'idle-hours', by: '사람', reason: '끝난 역할을 더 빨리 알림', before: null, after: 6, revision: revision + 1});
  // 실행 모델 설정의 나머지는 그대로다.
  const settings = readSettings(home);
  assert.equal(settings.idleRoleHours, 6);
  assert.ok(settings.presets[settings.activePreset].roles);

  const stale = kadan('idle-roles', 'set', '8', '--revision', String(revision), '--reason', '낡은 값');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /설정이 바뀌었다\(현재 revision \d+\)/);
  assert.equal(show().hours, 6);
  assert.match(kadan('idle-roles', '--help').stdout, /아무것도 끄지 않는다/);
  assert.equal(kadan('idle-roles', 'nope').status, 2);
});

test('자동 실행(kadan up --auto): 한 시간 문이 열렸을 때만 고르고 우편을 보낸다. 같은 시간 안의 다음 실행은 건너뛴다', {skip}, t => {
  const s = setup(t, 'gate');
  const hierarchy = path.join(s.dir, 'hierarchy.json');
  fs.writeFileSync(hierarchy, JSON.stringify({idleboss3: '@user', idleauto: 'idleboss3'}));
  appendLedger({kind: 'hierarchy-loaded', path: hierarchy, hash: 'x', by: 'watch'}, s.home);
  launch(s, 'idleboss3', 'conductor');
  launch(s, 'idleauto', 'worker', {HOLD: `${s.lock},${s.rollout}`});
  // 기반 프로세스 4개는 "사람이 끈 것"으로 표시해 자동 실행이 아무것도 띄우지 않게 한다(이 시험은 한 시간 문만 본다).
  fs.writeFileSync(path.join(s.home, 'quickstart.json'), JSON.stringify({runner: 'sh'}));
  fs.writeFileSync(path.join(s.home, 'revive-state.json'), JSON.stringify({targets:
    Object.fromEntries(['비서', '대시보드', '디코', 'watch'].map(role => [role, {state: 'stopped'}]))}));
  const auto = () => spawnSync(process.execPath, [cli, 'up', '--auto', '--hidden', '--no-prompt'], {encoding: 'utf8', timeout: 60_000,
    env: {...process.env, KADAN_WINDOW: 'none', KADAN_WINDOW_FORCE: '1', KADAN_FLOOR: 'tmux', KADAN_ROLE: ''}});
  // 이 파일의 시험들은 격리 홈 하나를 같이 쓴다. 앞 시험의 우편·stop을 세지 않게 이 시험의 역할로 좁힌다.
  const mails = () => readLedger().filter(e => e.kind === 'send' && e.by === IDLE_ROLES_SENDER && e.role === 'idleboss3');
  // 13시간 전의 표본을 심는다(마지막 실행도 13시간 전이라 문이 열려 있다).
  runIdleRoles({home: s.home, floor: tmuxFloor, now: Date.now() - 13 * HOUR});

  const first = auto();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /정리 후보 우편 1통: idleboss3\(1개\)/);
  assert.equal(mails().length, 1);
  assert.equal(readLedger().filter(e => e.kind === 'stop' && ['kadan-idleauto', 'kadan-idleboss3'].includes(e.session)).length, 0, '자동 실행도 아무것도 끄지 않는다');
  assert.equal(tmuxFloor.alive('kadan-idleauto'), true);

  const second = auto();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.doesNotMatch(second.stdout, /정리 후보/);
  assert.equal(mails().length, 1, '1분 뒤 자동 실행은 문이 닫혀 있다');
  assert.equal(fs.existsSync(process.env.KADAN_TEST_NOTIFY_SINK), false, '사용자 알림 없음');
});
