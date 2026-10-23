import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {acquireReviveLock} from '../src/revive.mjs';

// revive 잠금은 symlink 하나다: 만들기와 주인 기록이 한 번에 되므로 '주인 없는 잠금' 틈이 없다. 가짜 값만 쓴다.
// 옛 폴더+pid 구조의 6d(쓰기 전 빼앗김)·6e(다시 읽기 불일치)·6g(어린 빈 폴더)는 그 순서가 더는 없다:
// 링크가 생기는 순간 주인이 적혀 있다. 같은 목적(되찾기 경쟁에서 둘 다 못 얻음/둘 다 얻음 방지)은 6d·6e로 옮겼다.
const CHILD = new URL('./helpers/revive-lock-child.mjs', import.meta.url).pathname;
const ROUNDS = Number(process.env.KADAN_LOCK_RACE_ROUNDS ?? 50);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-lockrace-'));
const lockOf = home => path.join(home, 'revive.lock2');
const ownerOf = (pid, startedAt = 1) => JSON.stringify({pid, startedAt});
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']); return Number(r.stdout.toString()); };
const run = (home, startAt, holdMs) => new Promise(resolve => {
  const child = spawn(process.execPath, [CHILD, home, String(startAt), String(holdMs)], {stdio: ['ignore', 'pipe', 'inherit']});
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.on('close', () => resolve(out.trim()));
});

test('6 죽은 주인의 잠금을 실제 프로세스 둘이 동시에 되찾으면 정확히 하나만 얻는다', async () => {
  const tally = {};
  for (let i = 0; i < ROUNDS; i++) {
    const home = tmp(), lock = lockOf(home);
    fs.symlinkSync(ownerOf(deadPid()), lock);
    const startAt = Date.now() + 250;
    const outs = await Promise.all([run(home, startAt, 150), run(home, startAt, 150)]);
    // 느린 기계에서 한 자식이 늦게 떠 앞 자식이 푼 뒤에 얻을 수 있다. 그 경우도 두 보유 구간이 겹치면 안 된다.
    const holds = outs.map(out => { const got = /^GOT (\d+)/m.exec(out), rel = /^REL (\d+)/m.exec(out); return got && rel ? [Number(got[1]), Number(rel[1])] : null; });
    const denied = outs.filter(out => out === 'NO').length;
    assert.equal(holds.filter(Boolean).length + denied, 2, `${i + 1}번째 회차: 자식이 죽었거나 출력이 이상하다 ${JSON.stringify(outs)}`);
    assert.ok(holds.some(Boolean), `${i + 1}번째 회차: 아무도 잠금을 못 얻었다`);
    const [a, b] = holds;
    if (a && b) assert.ok(a[1] <= b[0] || b[1] <= a[0], `${i + 1}번째 회차: 보유 구간이 겹친다 ${JSON.stringify(holds)}`);
    const key = denied ? 'GOT+NO' : 'GOT+GOT(겹치지 않음)';
    tally[key] = (tally[key] ?? 0) + 1;
    assert.ok(!fs.existsSync(lock) && !fs.lstatSync(lock, {throwIfNoEntry: false}), '둘 다 끝난 뒤 잠금이 남지 않는다');
    assert.deepEqual(fs.readdirSync(home).filter(n => n.startsWith('revive.lock')), [], '되찾으며 옮긴 링크도 남지 않는다');
  }
  console.log(`# 잠금 경쟁 ${ROUNDS}회: ${JSON.stringify(tally)}`);
});

test('6a 주인은 링크 대상 한 번으로 읽히고, 대상 문자열은 길이 상한 안이다', () => {
  const home = tmp(), lock = lockOf(home);
  const release = acquireReviveLock(home);
  const target = fs.readlinkSync(lock);
  assert.equal(JSON.parse(target).pid, process.pid);
  assert.ok(Number.isFinite(JSON.parse(target).startedAt));
  assert.ok(Buffer.byteLength(target) < 1023, 'macOS 대상 문자열 상한(1023바이트) 안이다');
  release();
});

test('6b 해제는 자기 링크일 때만 지운다 — 새 주인과 pid 재사용(같은 pid·다른 startedAt)의 잠금을 지우지 않는다', () => {
  const home = tmp(), lock = lockOf(home);
  let release = acquireReviveLock(home);
  // 우리 잠금이 되찾기로 치워지고 다른 프로세스가 새로 잡은 상황.
  fs.unlinkSync(lock);
  fs.symlinkSync(ownerOf(process.pid + 1), lock);
  release();
  assert.equal(fs.readlinkSync(lock), ownerOf(process.pid + 1), '새 주인의 링크가 그대로다');
  fs.unlinkSync(lock);
  // 같은 pid, 다른 startedAt
  release = acquireReviveLock(home);
  const mine = fs.readlinkSync(lock);
  fs.unlinkSync(lock);
  const reused = ownerOf(process.pid, JSON.parse(mine).startedAt + 1);
  fs.symlinkSync(reused, lock);
  release();
  assert.equal(fs.readlinkSync(lock), reused, '같은 pid라도 startedAt이 다르면 남의 잠금이다');
});

test('6c 죽은 주인 잠금은 되찾고 onReclaim을 부른다, 살아 있는 주인 잠금은 그대로 둔다', () => {
  const home = tmp(), lock = lockOf(home);
  fs.symlinkSync(ownerOf(deadPid()), lock);
  const reasons = [];
  const release = acquireReviveLock(home, {onReclaim: r => reasons.push(r)});
  assert.ok(release); assert.equal(reasons.length, 1);
  assert.equal(JSON.parse(fs.readlinkSync(lock)).pid, process.pid);
  assert.equal(acquireReviveLock(home), null, '살아 있는 주인(우리)의 잠금은 못 얻는다');
  release();
  assert.ok(!fs.lstatSync(lock, {throwIfNoEntry: false}));
  assert.deepEqual(fs.readdirSync(home).filter(n => n.startsWith('revive.lock')), []);
});

// 항목 6d(F4): 죽은 주인을 본 뒤 옮기기 직전에 다른 쪽이 되찾아 새로 잡으면, 우리는 새 주인의 링크를 옮기게 된다.
// 그 링크를 돌려놓아 새 주인이 계속 쥐고, 우리는 얻지 못한다(둘 다 얻음 금지). rename에 주입해 순서를 결정적으로 만든다.
test('6d 되찾는 중 새 주인이 생기면 그 링크를 돌려놓고 둘 다 얻지 않는다', () => {
  const home = tmp(), lock = lockOf(home);
  fs.symlinkSync(ownerOf(deadPid()), lock);
  const live = ownerOf(process.pid + 1, 7);
  const origRename = fs.renameSync; let swapped = 0;
  fs.renameSync = (from, to) => {
    if (!swapped++ && String(from) === lock) { fs.unlinkSync(lock); fs.symlinkSync(live, lock); }
    return origRename(from, to);
  };
  const reasons = []; let release;
  try { release = acquireReviveLock(home, {isAlive: pid => pid === process.pid + 1 || pid === process.pid, onReclaim: r => reasons.push(r), sleep: () => {}}); }
  finally { fs.renameSync = origRename; }
  assert.equal(swapped, 1);
  assert.equal(release, null, '새 주인이 쥐고 있으니 얻지 못한다');
  assert.equal(reasons.length, 0, '죽은 주인을 되찾은 것이 아니다');
  assert.equal(fs.readlinkSync(lock), live, '새 주인의 링크가 제자리로 돌아와 있다');
  assert.deepEqual(fs.readdirSync(home).filter(n => n.includes('stale')), [], '옮긴 링크가 남지 않는다');
});

// 항목 6e(F3): 되찾기에서 진 쪽(rename이 ENOENT)이 잠금이 비었다고 믿고 포기하지 않는다. 이긴 쪽이 잡은 뒤에는 못 얻고,
// 이긴 쪽이 풀면 얻는다. 아무도 못 얻는 상태로 굳지 않는다.
test('6e 되찾기에서 진 쪽은 던지지 않고 다시 시도해, 이긴 쪽이 풀면 얻는다', () => {
  const home = tmp(), lock = lockOf(home);
  const dead = ownerOf(deadPid());
  fs.symlinkSync(dead, lock);
  const origRename = fs.renameSync; let lost = 0, winnerRelease = null;
  fs.renameSync = (from, to) => {
    if (!lost++ && String(from) === lock) {
      // 이긴 쪽이 먼저 되찾고 잡았다가 곧 푼다: 우리 rename은 ENOENT.
      origRename(from, `${lock}.won`); fs.unlinkSync(`${lock}.won`);
      winnerRelease = true;
    }
    return origRename(from, to);
  };
  let release;
  try { release = acquireReviveLock(home, {sleep: () => {}}); } finally { fs.renameSync = origRename; }
  assert.ok(winnerRelease);
  assert.ok(release, '진 쪽은 다시 시도해 얻는다');
  assert.equal(JSON.parse(fs.readlinkSync(lock)).pid, process.pid);
  release();
});

// 항목 6f: 다시 시도 길은 모두 마감과 쉬기를 지난다. 링크 읽기가 매번 ENOENT여도 던지지 않고 null로 끝난다.
// 읽기에 주입하므로 시계·부하 없이 결정적이다. 쉬기는 주입한 sleep으로 센다.
test('6f 링크가 읽기 전에 매번 사라져도 마감을 지키고 null로 끝나며 쉰다', () => {
  const home = tmp(), lock = lockOf(home);
  fs.symlinkSync(ownerOf(deadPid()), lock);
  const origRead = fs.readlinkSync; let reads = 0, sleeps = 0;
  fs.readlinkSync = (file, ...rest) => { if (String(file) === lock) { reads++; const e = new Error('gone'); e.code = 'ENOENT'; throw e; } return origRead(file, ...rest); };
  let release;
  try { release = acquireReviveLock(home, {waitMs: 1, sleep: () => { sleeps++; }}); } finally { fs.readlinkSync = origRead; }
  assert.equal(release, null);
  assert.ok(sleeps > 0, '다시 시도하기 전에 쉬었다');
  assert.ok(reads <= 4, `즉시 재시도에 상한이 있다(읽기 ${reads}회)`);
});

test('6g 산 주인의 잠금은 마감까지 쉬었다가 null로 끝난다', () => {
  const home = tmp();
  fs.symlinkSync(ownerOf(process.pid), lockOf(home));
  let sleeps = 0;
  assert.equal(acquireReviveLock(home, {waitMs: 1, sleep: () => { sleeps++; }}), null);
  assert.equal(fs.readlinkSync(lockOf(home)), ownerOf(process.pid), '산 주인의 링크는 건드리지 않는다');
});

test('6h 옛 revive.lock 폴더가 있는 홈: 새 잠금이 정상이고 옛 폴더는 그대로 남으며 알림만 한 번 부른다', () => {
  const home = tmp(), legacy = path.join(home, 'revive.lock');
  fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'pid'), '1');
  const seen = [];
  const release = acquireReviveLock(home, {onLegacy: f => seen.push(f)});
  assert.ok(release);
  assert.deepEqual(seen, [legacy]);
  release();
  assert.ok(fs.existsSync(path.join(legacy, 'pid')), '옛 폴더와 그 안은 지우지 않는다');
});
