import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {systemNotify, notifyUser, SYSTEM_NOTIFY_REFUSED} from '../src/user-notify.mjs';
import {finishNight} from '../src/night.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';

// 시험이 kyle 맥에 진짜 알림을 띄우지 못하게 하는 관문(2026-10-23). 진짜 spawnSync는 부르지 않는다 — 거절되는지만 본다.
const fakeSpawn = calls => (cmd, args) => { calls.push([cmd, args]); return {status: 0}; };

test('systemNotify: off + 진짜 spawnSync는 osascript를 부르지 않고 거절 문구를 돌려준다(던지지 않는다)', () => {
  assert.equal(systemNotify('문구', spawnSync, {KADAN_NOTIFY: 'off'}), 'KADAN_NOTIFY=off: 실제 시스템 알림 거절');
  assert.equal(SYSTEM_NOTIFY_REFUSED, 'KADAN_NOTIFY=off: 실제 시스템 알림 거절');
});

test('systemNotify: off + 가짜 spawn은 불리고, off 아님 + 가짜 spawn은 기존과 같다', () => {
  const a = [];
  assert.equal(systemNotify('문구', fakeSpawn(a), {KADAN_NOTIFY: 'off'}), null);
  assert.equal(a.length, 1); assert.equal(a[0][0], 'osascript');
  const b = [];
  assert.equal(systemNotify('문구', fakeSpawn(b), {}), null);
  assert.equal(b.length, 1);
  assert.match(systemNotify('문구', () => ({status: 1}), {}), /종료 코드 1/);
});

test('notifyUser: off + 진짜 spawnSync는 result.error에 거절 문구가 들어가고 던지지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-notify-gate-'));
  const r = notifyUser('문구', spawnSync, {home, env: {KADAN_NOTIFY: 'off'}});
  assert.equal(r.error, SYSTEM_NOTIFY_REFUSED);
  assert.equal(r.via, 'system');
});

test('나이트 끝 처리: 기본 알림(가짜 notify 없음)이 거절돼도 끝 사건 기록은 남는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-night-gate-'));
  const t = Date.now() - 60_000;
  appendLedger({kind: 'night', phase: 'on', t: new Date(t).toISOString(), until: new Date(t + 3600_000).toISOString(),
    by: '사람', text: '자러 감', to: [], delivered: []}, home);
  const event = finishNight({home, by: '사람', phase: 'off', reason: null});
  assert.equal(event.phase, 'off');
  assert.deepEqual(readLedger(home).filter(e => e.kind === 'night').map(e => e.phase), ['on', 'off']);
});
