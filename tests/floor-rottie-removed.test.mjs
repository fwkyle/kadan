// 로티는 창으로만 쓴다 — 바닥 값으로는 거절하고, 바닥 시절(9/15 이전)의 옛 원장 줄은 여전히 읽힌다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger} from '../src/ledger.mjs';
import {renderLogEntry} from '../src/cli.mjs';
import {selectFloorName} from '../src/floor.mjs';

function cli(home, args, extra = {}) {
  const env = {PATH: process.env.PATH, HOME: process.env.HOME, KADAN_HOME: home,
    KADAN_SOCKET: `rr-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', ...extra};
  return spawnSync(process.execPath, ['src/cli.mjs', ...args], {env, encoding: 'utf8', timeout: 20000});
}

test('KADAN_FLOOR=rottie는 KADAN_FLOOR_INVALID(tmux|herdr만 허용)로 거절한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-rottie-gone-'));
  const run = cli(home, ['status'], {KADAN_FLOOR: 'rottie'});
  assert.equal(run.status, 2);
  assert.match(run.stderr, /KADAN_FLOOR_INVALID.*tmux\|herdr만 허용/);
  assert.throws(() => selectFloorName('rottie'), {code: 'KADAN_FLOOR_INVALID'});
  assert.equal(selectFloorName('tmux').name, 'tmux');
  assert.equal(selectFloorName('herdr').name, 'herdr');
});

test('옛 로티 바닥 시작 줄(floor:"rottie", rottiePid·rottieBuild)이 있어도 log·status가 오류 없이 돈다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-rottie-old-ledger-'));
  const old = {kind: 'start', role: 'old-worker', session: 'kadan-old-worker', floor: 'rottie', window: 'rottie',
    rottieTerminalId: 'term-old', rottiePid: '4321', rottieWorkspaceId: 'ws-old', rottieBuild: 'build-old'};
  appendLedger(old, home);
  assert.match(renderLogEntry({...old, t: '2026-09-01T00:00:00.000Z', by: 'x'}), /PID=4321 창=rottie/);
  const log = cli(home, ['log']);
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /PID=4321/);
  const status = cli(home, ['status'], {KADAN_FLOOR: 'tmux'});
  assert.equal(status.status, 0, status.stderr);
});
