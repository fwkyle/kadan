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
    const results = (await Promise.all([run(home, startAt, 150), run(home, startAt, 150)])).sort();
    const key = results.join('+');
    tally[key] = (tally[key] ?? 0) + 1;
    assert.equal(key, 'GOT+NO', `${i + 1}번째 회차: ${key}`);
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
