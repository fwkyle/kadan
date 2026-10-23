import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {acquireReviveLock} from '../src/revive.mjs';

// 항목 6: 죽은 주인의 잠금을 두 프로세스가 동시에 되찾아도 한 쪽만 잠금을 쥔다. 가짜 값만 쓴다.
const CHILD = new URL('./helpers/revive-lock-child.mjs', import.meta.url).pathname;
const ROUNDS = Number(process.env.KADAN_LOCK_RACE_ROUNDS ?? 50);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-lockrace-'));
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
    const home = tmp(), lock = path.join(home, 'revive.lock');
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(deadPid()));
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
    assert.ok(!fs.existsSync(lock), '둘 다 끝난 뒤 잠금이 남지 않는다');
    assert.deepEqual(fs.readdirSync(home).filter(n => n.startsWith('revive.lock')), [], '되찾으며 옮긴 폴더도 남지 않는다');
  }
  console.log(`# 잠금 경쟁 ${ROUNDS}회: ${JSON.stringify(tally)}`);
});

test('6b 해제는 자기 pid일 때만 잠금을 지운다 — 새 주인의 잠금을 지우지 않는다', () => {
  const home = tmp(), lock = path.join(home, 'revive.lock');
  const release = acquireReviveLock(home);
  // 우리 잠금이 되찾기로 치워지고 다른 프로세스가 새로 잡은 상황.
  fs.rmSync(lock, {recursive: true});
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid + 1));
  release();
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid + 1), '새 주인의 pid 파일이 그대로다');
});

test('6c 죽은 주인 잠금은 되찾고 onReclaim을 부른다, 살아 있는 주인 잠금은 그대로 둔다', () => {
  const home = tmp(), lock = path.join(home, 'revive.lock');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(deadPid()));
  const reasons = [];
  const release = acquireReviveLock(home, {onReclaim: r => reasons.push(r)});
  assert.ok(release); assert.equal(reasons.length, 1);
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid));
  assert.equal(acquireReviveLock(home), null, '살아 있는 주인(우리)의 잠금은 못 얻는다');
  release();
  assert.ok(!fs.existsSync(lock));
});

// 항목 6d: mkdir 성공 뒤 pid를 쓰기 전에 다른 쪽이 막 만든 잠금을 옮기면(ENOENT) 죽지 않고 다시 얻는다.
// fs.writeFileSync에 멈춤을 주입해 그 순서를 결정적으로 만든다(시계·부하 없음).
test('6d 막 만든 잠금을 pid 쓰기 전에 빼앗겨도 던지지 않고 다시 시도해 얻는다', () => {
  const home = tmp(), lock = path.join(home, 'revive.lock');
  const orig = fs.writeFileSync; let stolen = 0;
  fs.writeFileSync = (file, ...rest) => {
    if (String(file) === path.join(lock, 'pid') && !stolen++) fs.renameSync(lock, `${lock}.stale-test`);
    return orig(file, ...rest);
  };
  let release;
  try { release = acquireReviveLock(home); } finally { fs.writeFileSync = orig; }
  assert.equal(stolen, 2, '첫 쓰기는 빼앗겼고 다시 시도해 두 번째로 썼다');
  assert.ok(release, '다시 시도해 잠금을 얻었다');
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid));
  release();
  assert.ok(!fs.existsSync(lock));
});

test('6e pid를 쓴 뒤 다시 읽어 자기 pid가 아니면 얻은 것으로 보지 않는다', () => {
  const home = tmp(), lock = path.join(home, 'revive.lock');
  const orig = fs.writeFileSync; let calls = 0;
  fs.writeFileSync = (file, data, ...rest) => orig(file, calls++ ? data : String(process.pid + 1), ...rest);
  let release;
  try { release = acquireReviveLock(home, {isAlive: pid => pid === process.pid}); } finally { fs.writeFileSync = orig; }
  assert.ok(release, '남의 pid가 보이면 낡은 잠금으로 되찾아 다시 얻는다');
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid));
  release();
});

// 항목 6f: 다시 시도 길은 모두 마감과 쉬기를 지난다. 매 시도 잠금을 빼앗기게 주입해도 waitMs=1에서 null로 끝난다.
// 쓰기·읽기에 주입하므로 시계·부하 없이 결정적이다. 쉬기는 주입한 sleep으로 센다.
const pidOf = home => path.join(home, 'revive.lock', 'pid');
const losing = {
  '쓰기 ENOENT': {write: (home, orig) => (file, ...rest) => { if (String(file) === pidOf(home)) fs.rmSync(path.dirname(file), {recursive: true}); return orig(file, ...rest); }},
  '다시 읽기 실패': {write: (home, orig) => (file, ...rest) => { orig(file, ...rest); if (String(file) === pidOf(home)) fs.rmSync(path.dirname(file), {recursive: true}); }},
  '남의 pid': {read: (home, orig) => (file, ...rest) => { if (String(file) !== pidOf(home)) return orig(file, ...rest); fs.rmSync(path.dirname(file), {recursive: true}); return String(process.pid + 1); }},
};
for (const [name, inject] of Object.entries(losing)) {
  test(`6f ${name}이 매번 반복돼도 마감을 지키고 null로 끝나며 쉰다`, () => {
    const home = tmp();
    const origWrite = fs.writeFileSync, origRead = fs.readFileSync; let writes = 0, sleeps = 0;
    if (inject.write) fs.writeFileSync = (file, ...rest) => { if (String(file) === pidOf(home)) writes++; return inject.write(home, origWrite)(file, ...rest); };
    if (inject.read) fs.readFileSync = inject.read(home, origRead);
    let release;
    try { release = acquireReviveLock(home, {waitMs: 1, sleep: () => { sleeps++; }}); }
    finally { fs.writeFileSync = origWrite; fs.readFileSync = origRead; }
    assert.equal(release, null);
    assert.ok(sleeps > 0, '다시 시도하기 전에 쉬었다');
    assert.ok(writes <= 4, `즉시 재시도에 상한이 있다(쓰기 ${writes}회)`);
  });
}

// 항목 6g: 되찾으려고 옮긴 폴더가 누군가 막 만든 pid 없는 폴더면 돌려놓지 않고 지우고, 바로 새로 얻는다.
test('6g 옮긴 폴더가 pid 없는 어린 폴더면 되돌려 빈 잠금을 남기지 않고 지운 뒤 바로 얻는다', () => {
  const home = tmp(), lock = path.join(home, 'revive.lock');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(deadPid()));
  const origRename = fs.renameSync; let swapped = false;
  // 옛 죽은 소유자 잠금을 읽은 뒤 옮기기 직전에, 다른 쪽이 그것을 치우고 막 만든 빈 폴더로 바꿔 둔 상황.
  fs.renameSync = (from, to) => {
    if (!swapped && String(from) === lock) { swapped = true; fs.rmSync(lock, {recursive: true}); fs.mkdirSync(lock); }
    return origRename(from, to);
  };
  const reasons = []; let release;
  try { release = acquireReviveLock(home, {onReclaim: r => reasons.push(r)}); } finally { fs.renameSync = origRename; }
  assert.ok(swapped);
  assert.ok(release, '빈 잠금이 남지 않아 바로 얻는다');
  assert.equal(reasons.length, 0, '낡은 잠금을 되찾은 것이 아니라 어린 폴더를 치운 것이다');
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid));
  assert.deepEqual(fs.readdirSync(home).filter(n => n.startsWith('revive.lock.stale')), [], '옮긴 폴더가 남지 않는다');
  release();
  assert.ok(!fs.existsSync(lock));
  // 가짜 60초 뒤의 다음 회차도 막히지 않는다.
  const again = acquireReviveLock(home, {now: () => Date.now() + 60000});
  assert.ok(again); again();
});
