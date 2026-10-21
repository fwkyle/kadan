import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {slotCommand} from '../src/review-slots.mjs';
import {CardStore} from '../src/card-store.mjs';

const env = {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Slot fixture', '-c', 'user.email=slot@example.test', ...args], {cwd, env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
// 시험마다 새 카단 폴더와 새 저장소. 실사용 카단 폴더·실제 저장소는 쓰지 않는다.
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-slot-')));
  const home = path.join(base, 'home'), repo = path.join(base, 'app');
  fs.mkdirSync(home); fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"v":1}\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'first');
  return {base, home, repo, logs: []};
}
const run = (f, args, flags = {}, extra = {}) => slotCommand(args, flags, {home: f.home, env: {}, pollMs: 20, log: m => f.logs.push(m), ...extra});

test('빈 자리를 고르고 처음 쓸 때만 worktree를 만든다; 두 번째는 다른 자리', async () => {
  const f = fixture();
  const first = await run(f, ['acquire', f.repo], {for: 'card-a'});
  assert.equal(first.slot, 'slot-1');
  assert.equal(first.path, path.join(f.base, 'app-review-slots', 'slot-1'));
  assert.equal(first.created, true);
  assert.equal(first.sha, git(f.repo, 'rev-parse', 'HEAD'));
  assert.equal(git(first.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD'); // 분리된 HEAD
  const second = await run(f, ['acquire', f.repo], {for: 'card-b'});
  assert.equal(second.slot, 'slot-2');
  assert.equal(fs.existsSync(path.join(f.base, 'app-review-slots', 'slot-3')), false);
  // worktree 경로를 줘도 같은 자리 묶음을 쓴다.
  const third = await run(f, ['acquire', second.path], {for: 'card-c'});
  assert.equal(third.slot, 'slot-3');
});

test('모두 사용 중이면 --no-wait는 빌린 쪽 정보와 함께 실패하고, release 뒤에는 같은 자리를 다시 쓴다', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'resource-limits.json'), JSON.stringify({reviewSlots: 1}));
  const first = await run(f, ['acquire', f.repo], {for: 'card-a', role: 'p-검수자'});
  await assert.rejects(run(f, ['acquire', f.repo], {for: 'card-b', 'no-wait': true}),
    e => e.exitCode === 3 && /slot-1: card-a \(p-검수자\)/.test(e.message));
  // 기다리기는 제한 시간 뒤 실패하고, 대기 중 누가 쥐었는지 알린다.
  await assert.rejects(run(f, ['acquire', f.repo], {for: 'card-b', 'wait-timeout': '0.05'}), e => e.exitCode === 3);
  assert.match(f.logs[0], /대기: 검수 자리 모두 사용 중 — slot-1: card-a/);
  const released = run(f, ['release', first.path]);
  assert.equal((await released).released[0].slot, 'slot-1');
  const again = await run(f, ['acquire', f.repo], {for: 'card-b'});
  assert.equal(again.slot, 'slot-1');
  assert.equal(again.created, false);
  // --for로도 돌려준다.
  assert.equal((await run(f, ['release'], {for: 'card-b'})).released.length, 1);
});

test('기다리는 동안 자리가 비면 그 자리를 받는다', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'resource-limits.json'), JSON.stringify({reviewSlots: 1}));
  const first = await run(f, ['acquire', f.repo], {for: 'card-a'});
  const waiting = run(f, ['acquire', f.repo], {for: 'card-b'});
  setTimeout(() => run(f, ['release', first.path]), 60);
  assert.equal((await waiting).slot, 'slot-1');
});

test('--ref로 요청한 커밋을 분리 체크아웃한다', async () => {
  const f = fixture();
  const old = git(f.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(f.repo, 'b.txt'), 'b'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-q', '-m', 'second');
  const got = await run(f, ['acquire', f.repo], {for: 'card-a', ref: old});
  assert.equal(git(got.path, 'rev-parse', 'HEAD'), old);
  await run(f, ['release', got.path]);
  const next = await run(f, ['acquire', f.repo], {for: 'card-b', ref: 'main'});
  assert.equal(next.slot, 'slot-1');
  assert.equal(git(next.path, 'rev-parse', 'HEAD'), git(f.repo, 'rev-parse', 'main'));
});

test('커밋 안 된 변경이 있는 자리는 다시 쓰지 않는다', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'resource-limits.json'), JSON.stringify({reviewSlots: 1}));
  const got = await run(f, ['acquire', f.repo], {for: 'card-a'});
  fs.writeFileSync(path.join(got.path, 'stray.txt'), 'x');
  const released = await run(f, ['release', got.path]);
  assert.match(released.released[0].warning, /커밋 안 된 변경/);
  await assert.rejects(run(f, ['acquire', f.repo], {for: 'card-b', 'no-wait': true}),
    e => /커밋 안 된 변경이 있어 다시 쓰지 않음/.test(e.message) && /stray\.txt/.test(e.message));
  // 거부한 자리에는 임차가 남지 않는다.
  assert.equal(fs.readdirSync(path.join(f.home, 'review-slots')).flatMap(d => fs.readdirSync(path.join(f.home, 'review-slots', d))).some(n => n.endsWith('.lease.json')), false);
});

test('버려진 임차(세션 없음·너무 오래됨)는 회수하고 그렇다고 알린다', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'resource-limits.json'), JSON.stringify({reviewSlots: 1, leaseMaxHours: 1}));
  const sessions = new Map([['kadan-p-검수자', 42]]);
  const floor = {alive: s => sessions.has(s), pid: s => sessions.get(s)};
  const extra = {floor, sessionName: role => `kadan-${role}`};
  await run(f, ['acquire', f.repo], {for: 'card-a', role: 'p-검수자'}, extra);
  await assert.rejects(run(f, ['acquire', f.repo], {for: 'card-b', 'no-wait': true}, extra), e => e.exitCode === 3);
  sessions.delete('kadan-p-검수자');
  const status = await run(f, ['status', f.repo], {}, extra);
  assert.match(status.pools[0].slots[0].reclaimable, /세션 없음/);
  const got = await run(f, ['acquire', f.repo], {for: 'card-b', 'no-wait': true}, extra);
  assert.equal(got.slot, 'slot-1');
  assert.deepEqual(got.reclaimed.map(r => [r.holder, r.reason]), [['card-a', '세션 없음(kadan-p-검수자)']]);
  // 역할 밖에서 빌린 임차는 나이로만 판단한다.
  const later = () => Date.now() + 2 * 3600_000;
  const aged = await run(f, ['acquire', f.repo], {for: 'card-c', 'no-wait': true}, {now: later});
  assert.deepEqual(aged.reclaimed.map(r => r.reason), ['1시간 초과']);
});

test('deps는 잠금 파일이 바뀌었거나 node_modules가 없을 때만 설치한다', async () => {
  const f = fixture();
  const got = await run(f, ['acquire', f.repo], {for: 'card-a'});
  const counter = path.join(f.base, 'installs.txt');
  const cmd = `echo x >> ${counter} && mkdir -p node_modules`;
  const first = await run(f, ['deps', got.path], {cmd});
  assert.equal(first.installed, true);
  assert.equal(first.lockfile, 'package-lock.json');
  assert.equal((await run(f, ['deps', got.path], {cmd})).installed, false);
  // 자리를 돌려주고 다시 빌려도 node_modules와 설치 기록은 남는다.
  await run(f, ['release', got.path]);
  const again = await run(f, ['acquire', f.repo], {for: 'card-b'});
  assert.equal(again.path, got.path);
  assert.equal((await run(f, ['deps', again.path], {cmd})).reason, '잠금 파일 그대로');
  // 잠금 파일이 바뀐 커밋으로 옮기면 다시 설치한다.
  fs.writeFileSync(path.join(f.repo, 'package-lock.json'), '{"v":2}\n'); git(f.repo, 'commit', '-q', '-am', 'lock');
  await run(f, ['release', again.path]);
  const moved = await run(f, ['acquire', f.repo], {for: 'card-c', ref: 'main'});
  assert.equal((await run(f, ['deps', moved.path], {cmd})).installed, true);
  // 캐시 정리로 node_modules가 지워졌으면 해시가 같아도 설치한다.
  fs.rmSync(path.join(moved.path, 'node_modules'), {recursive: true});
  assert.equal((await run(f, ['deps', moved.path], {cmd})).installed, true);
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 3);
  // 설치 실패는 기록을 남기지 않고 종료 코드를 돌려준다.
  fs.rmSync(path.join(moved.path, 'node_modules'), {recursive: true});
  await assert.rejects(run(f, ['deps', moved.path], {cmd: 'exit 7'}), e => e.exitCode === 7);
  // 빌리지 않은 자리는 설치하지 않는다.
  await run(f, ['release', moved.path]);
  await assert.rejects(run(f, ['deps', moved.path], {cmd}), /빌린 자리가 아님/);
});

test('임시 자리는 --reason이 있어야 만들고, 돌려줄 때 지운다', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'resource-limits.json'), JSON.stringify({reviewSlots: 1}));
  await run(f, ['acquire', f.repo], {for: 'card-a'});
  await assert.rejects(run(f, ['acquire', f.repo], {for: 'card-b', temporary: true}), /--reason/);
  const temp = await run(f, ['acquire', f.repo], {for: 'card-b', temporary: true, reason: '전후 비교 급함'});
  assert.equal(temp.temporary, true);
  assert.match(temp.slot, /^temp-/);
  const status = await run(f, ['status'], {});
  assert.equal(status.pools[0].slots.find(s => s.slot === temp.slot).reason, '전후 비교 급함');
  const released = await run(f, ['release', temp.path]);
  assert.equal(released.released[0].removed, true);
  assert.equal(fs.existsSync(temp.path), false);
  assert.equal(git(f.repo, 'worktree', 'list').includes(temp.slot), false);
});

test('값 없는 옵션 뒤의 위치 인자도 그대로 쓴다(공용 옵션 해석기 보정)', async () => {
  const f = fixture();
  const got = await run(f, ['acquire'], {for: 'card-a', 'no-wait': f.repo});
  assert.equal(got.slot, 'slot-1');
});

// 카드 원장에 저장소 이름을 등록한다(이름 → repoPath 조회 시험용).
const register = (f, repo, repoPath) => new CardStore(f.home).create({repo, id: `c-${Math.random().toString(36).slice(2, 8)}`, repoPath, body: '# 시험'});

test('저장소 안에서 카드의 저장소 이름으로 빌려도 같은 자리 묶음을 쓴다(실제 사고 재현)', async () => {
  const f = fixture();
  register(f, 'app-name', f.repo);
  const before = process.cwd();
  process.chdir(f.repo);
  try {
    const byName = await run(f, ['acquire', 'app-name'], {for: 'card-a'});
    assert.equal(byName.repo, f.repo);
    assert.equal(byName.path, path.join(f.base, 'app-review-slots', 'slot-1'));
    const byDot = await run(f, ['acquire', '.'], {for: 'card-b'});
    assert.equal(byDot.slot, 'slot-2');
    const byWorktree = await run(f, ['acquire', byName.path], {for: 'card-c'});
    assert.equal(byWorktree.slot, 'slot-3');
    const status = await run(f, ['status', 'app-name']);
    assert.equal(status.pools.length, 1);
    assert.equal(status.pools[0].repo, f.repo);
  } finally { process.chdir(before); }
});

test('모르는 이름은 자리를 만들지 않고 경로를 달라고 안내한다', async () => {
  const f = fixture();
  await assert.rejects(run(f, ['acquire', 'nope'], {for: 'card-a'}), /찾지 못했습니다: nope.*경로를 주세요/);
  assert.equal(fs.existsSync(path.join(f.home, 'review-slots')), false);
  assert.equal(fs.existsSync(path.join(f.base, 'app-review-slots')), false);
  await assert.rejects(run(f, ['status', 'nope']), /경로를 주세요/);
});

test('같은 이름이 서로 다른 저장소 경로에 등록되면 후보를 나열하고 실패한다', async () => {
  const f = fixture();
  const other = path.join(f.base, 'other');
  fs.mkdirSync(other); git(other, 'init', '-q', '-b', 'main');
  register(f, 'dup', f.repo); register(f, 'dup', other);
  await assert.rejects(run(f, ['acquire', 'dup'], {for: 'card-a'}),
    e => e.message.includes(f.repo) && e.message.includes(other) && /경로를 주세요/.test(e.message));
  // 같은 이름이 같은 저장소의 worktree로 등록된 것은 하나로 본다.
  const wt = path.join(f.base, 'wt'); git(f.repo, 'worktree', 'add', '-q', '--detach', wt);
  register(f, 'one', f.repo); register(f, 'one', wt);
  assert.equal((await run(f, ['acquire', 'one'], {for: 'card-a'})).repo, f.repo);
});

test('git 저장소가 아닌 경로는 다음 행동이 붙은 문구로 실패한다', async () => {
  const f = fixture();
  const plain = path.join(f.base, 'plain'); fs.mkdirSync(plain);
  await assert.rejects(run(f, ['acquire', plain], {for: 'card-a'}),
    e => e.message.includes(`저장소 경로가 아닙니다: ${plain}`) && /저장소 이름을 주세요/.test(e.message));
});

test('옮겨진 repoPath의 빈 폴더가 다른 저장소 아래에 있어도 상위 저장소를 빌리지 않는다', async () => {
  const f = fixture();
  const former = path.join(f.repo, 'former'); fs.mkdirSync(former); // 옛 경로: 일반 폴더, 상위가 다른 저장소
  register(f, 'moved-project', former);
  await assert.rejects(run(f, ['acquire', 'moved-project'], {for: 'card-a'}), /찾지 못했습니다: moved-project/);
  assert.equal(fs.existsSync(path.join(f.home, 'review-slots')), false);
  assert.equal(fs.existsSync(path.join(f.base, 'app-review-slots')), false);
});

test('다른 저장소 안의 일반 폴더·하위 폴더 경로는 꼭대기 아님으로 실패한다', async () => {
  const f = fixture();
  const sub = path.join(f.repo, 'sub'); fs.mkdirSync(sub);
  await assert.rejects(run(f, ['acquire', sub], {for: 'card-a'}),
    e => e.message.includes(`저장소 꼭대기가 아닙니다: ${fs.realpathSync(sub)}`) && e.message.includes(`꼭대기: ${f.repo}`));
  // 의도된 변화: `.`도 저장소 꼭대기가 아닌 하위 폴더에서 실행하면 이제 실패한다.
  const before = process.cwd();
  process.chdir(sub);
  try { await assert.rejects(run(f, ['acquire', '.'], {for: 'card-a'}), /저장소 꼭대기가 아닙니다/); }
  finally { process.chdir(before); }
  assert.equal(fs.existsSync(path.join(f.home, 'review-slots')), false);
});

test('cwd 아래 같은 이름의 다른 저장소 폴더가 있어도 순수 이름은 카드 원장으로 해석한다', async () => {
  const f = fixture();
  register(f, 'app-name', f.repo);
  const shadow = path.join(f.base, 'work', 'app-name'); fs.mkdirSync(shadow, {recursive: true});
  git(shadow, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(shadow, 'x'), '1'); git(shadow, 'add', '.'); git(shadow, 'commit', '-q', '-m', 'x');
  const before = process.cwd();
  process.chdir(path.join(f.base, 'work'));
  try {
    assert.equal((await run(f, ['acquire', 'app-name'], {for: 'card-a'})).repo, f.repo);
    // 원장에 없는 이름이면 cwd 폴더는 쓰지 않고 ./이름을 안내한다.
    await assert.rejects(run(f, ['acquire', 'app-name2'], {for: 'card-b'}), e => !/\.\/app-name2/.test(e.message));
    fs.mkdirSync(path.join(f.base, 'work', 'plain-dir'));
    await assert.rejects(run(f, ['acquire', 'plain-dir'], {for: 'card-b'}), /경로로 쓰려면 \.\/plain-dir/);
    assert.equal((await run(f, ['acquire', './app-name'], {for: 'card-c'})).repo, fs.realpathSync(shadow));
  } finally { process.chdir(before); }
});
