import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSingleWatch, watchProcessName } from '../src/watch-system.mjs';
import { readWatchProcesses } from '../src/watch-overview.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-per-home-'));
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const defaultHome = mk('real-default');
const linkToDefault = path.join(tmp, 'link-default');
fs.symlinkSync(defaultHome, linkToDefault);
const otherA = mk('a', 'test');
const otherB = mk('b', 'test');
const ps = (...lines) => () => ({ status: 0, stdout: lines.join('\n') });
const name = (home) => watchProcessName(home, defaultHome);

test('기본 홈 감시기 이름은 정확히 kadan-watch', () => {
  assert.equal(name(defaultHome), 'kadan-watch');
  assert.equal(name(undefined), 'kadan-watch');
});

test('링크로 가리킨 기본 홈도 기본으로 판정한다', () => {
  assert.equal(name(linkToDefault), 'kadan-watch');
  assert.equal(watchProcessName(defaultHome, linkToDefault), 'kadan-watch');
});

test('폴더 이름이 같은 두 홈은 서로 다른 이름이다', () => {
  const a = name(otherA), b = name(otherB);
  assert.match(a, /^kadan-watch:test-[0-9a-f]{6}$/);
  assert.match(b, /^kadan-watch:test-[0-9a-f]{6}$/);
  assert.notEqual(a, b);
  assert.equal(name(otherA), a);
});

test('기본 홈끼리는 중복을 거절한다', () => {
  assert.throws(() => assertSingleWatch(ps('999999 kadan-watch'), name(defaultHome)), /PID 999999/);
});

test('다른 홈은 기본 홈 감시기가 있어도 시작할 수 있다', () => {
  assert.doesNotThrow(() => assertSingleWatch(ps('999999 kadan-watch'), name(otherA)));
});

test('같은 다른 홈끼리는 중복을 거절하고 다른 다른 홈은 허용한다', () => {
  const a = name(otherA), b = name(otherB);
  assert.throws(() => assertSingleWatch(ps(`999999 ${a}`), a), /PID 999999/);
  assert.doesNotThrow(() => assertSingleWatch(ps(`999999 ${a}`), b));
});

test('상태 표시는 기본 홈에서 지금처럼 정확한 이름만 읽는다', () => {
  const out = [
    ' 42 Mon Sep  7 00:00:00 2026 kadan-watch',
    '43 Mon Sep  7 00:00:00 2026 node test-kadan-watch',
    `44 Mon Sep  7 00:00:00 2026 ${name(otherA)}`,
  ].join('\n');
  const spawn = () => ({ status: 0, stdout: out });
  assert.deepEqual(readWatchProcesses(spawn).map((p) => p.pid), [42]);
  assert.deepEqual(readWatchProcesses(spawn, 'kadan-watch').map((p) => p.pid), [42]);
});

test('상태 표시는 다른 홈에서 자기 홈 감시기만 찾는다', () => {
  const a = name(otherA), b = name(otherB);
  const out = [
    '42 Mon Sep  7 00:00:00 2026 kadan-watch',
    `44 Mon Sep  7 00:00:00 2026 ${a}`,
    `45 Mon Sep  7 00:00:00 2026 ${b}`,
  ].join('\n');
  const spawn = () => ({ status: 0, stdout: out });
  assert.deepEqual(readWatchProcesses(spawn, a).map((p) => p.pid), [44]);
});
