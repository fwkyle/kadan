import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expiryMs, lineMs, logStartMs, readAgyLog, scanBackward} from '../src/agy-log.mjs';

// agy 로그 읽기. 계정은 모두 가짜 주소(example.invalid)이고, 줄 모양만 실제 로그(Antigravity CLI 1.5.15)를 따른다.
const A = 'a@example.invalid';
const B = 'b@example.invalid';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-log-'));
const stamp = (mmdd, hms, id = 100) => `I${mmdd} ${hms}.123456 ${String(id).padStart(7)} `;
const loaded = (mmdd, hms, exp) => `${stamp(mmdd, hms)}keyring.go:64] keyringAuth: loaded token, expiry=${exp}.804105 +0900 KST expired=false`;
const auth = (mmdd, hms, who) => `${stamp(mmdd, hms)}server_oauth.go:226] OAuth: authenticated successfully as ${who}`;
const refreshed = (mmdd, hms, exp) => `${stamp(mmdd, hms)}browser.go:265] token refreshed, new expiry=${exp}.30143 +0900 KST m=+6659.2`;
const acquired = (mmdd, hms, exp) => `${stamp(mmdd, hms)}browser.go:145] consumerOAuth: token acquired, expiry=${exp}.17 +0900 KST m=+4145.0`;
const consumer = (mmdd, hms, who) => `${stamp(mmdd, hms)}browser.go:167] consumerOAuth: authenticated successfully as ${who}`;
const noise = n => Array.from({length: n}, (_, i) => `I1124 13:00:00.000000 ${String(i).padStart(7)} http_helpers.go:748] URL: https://example.invalid/v1 Trace: 0x${i}`);
const write = (name, lines) => { const file = path.join(dir, name); fs.writeFileSync(file, lines.join('\n') + '\n'); return file; };
const local = (...parts) => new Date(...parts).getTime();

test('이름의 날짜·시각과 만료 글자를 읽는다(만료는 글의 오프셋을 따른다)', () => {
  assert.equal(logStartMs('cli-20261124_131852.log'), local(2026, 10, 24, 13, 18, 52));
  assert.equal(logStartMs('cli-x.log'), null);
  assert.equal(expiryMs('2026-11-24 14:15:43', '+0900'), Date.parse('2026-11-24T05:15:43Z'));
  assert.equal(lineMs('I1124 15:19:52.625399 x', local(2026, 10, 24, 13, 18, 52)), local(2026, 10, 24, 15, 19, 52));
  // 해가 바뀌면 월일이 파일보다 작아진다 → 다음 해로 읽는다.
  assert.equal(lineMs('I0101 00:00:05.000000 x', local(2026, 11, 31, 23, 59, 0)), local(2027, 0, 1, 0, 0, 5));
});

test('시작 때 읽은 계정·갱신: 마지막 갱신의 계정은 그 줄 앞의 마지막 인증 줄이다', () => {
  const file = write('cli-20261124_112518.log', [loaded('1124', '11:25:18', '2026-11-24 12:15:49'), auth('1124', '11:25:18', A), ...noise(3),
    refreshed('1124', '12:16:18', '2026-11-24 13:16:17'), refreshed('1124', '13:20:18', '2026-11-24 14:20:17')]);
  const log = readAgyLog(file);
  assert.equal(log.account, A);
  assert.equal(log.lastWrite.kind, 'refreshed');
  assert.equal(log.lastWrite.account, A);
  assert.equal(log.lastWrite.atMs, local(2026, 10, 24, 13, 20, 18));
  assert.equal(log.lastWrite.expiryMs, expiryMs('2026-11-24 14:20:17', '+0900'));
  assert.equal(log.expiryMs, log.lastWrite.expiryMs);
  assert.equal(log.loadedExpiry, expiryMs('2026-11-24 12:15:49', '+0900'));
  assert.equal(log.exited, false);
});

test('한 프로세스가 도중에 계정을 바꾼 사례: 브라우저 로그인 뒤의 계정이 현재 계정이고 덮어쓰기도 그 계정이다', () => {
  const file = write('cli-20261124_131852.log', [loaded('1124', '13:18:52', '2026-11-24 14:15:43'), auth('1124', '13:18:52', A), ...noise(2),
    acquired('1124', '13:27:58', '2026-11-24 14:27:57'), consumer('1124', '13:27:58', B), auth('1124', '13:27:58', B), ...noise(2),
    `${stamp('1124', '15:19:17')}common.go:571] CLI program exited, shutting down`]);
  const log = readAgyLog(file);
  assert.equal(log.account, B);
  assert.deepEqual([log.lastWrite.kind, log.lastWrite.account], ['browser-login', B]);
  assert.equal(log.exited, true);
});

test('로그인 뒤에 갱신하면 갱신의 계정은 로그인 계정이고, 로그인 전의 갱신은 옛 계정이다', () => {
  const lines = [loaded('1124', '09:00:00', '2026-11-24 10:00:00'), auth('1124', '09:00:00', A), refreshed('1124', '10:00:05', '2026-11-24 11:00:04'),
    acquired('1124', '10:30:00', '2026-11-24 11:30:00'), consumer('1124', '10:30:00', B), auth('1124', '10:30:00', B)];
  const before = readAgyLog(write('cli-20261124_090000.log', lines.slice(0, 3)));
  assert.equal(before.lastWrite.account, A);
  const after = readAgyLog(write('cli-20261124_090001.log', [...lines, refreshed('1124', '11:30:05', '2026-11-24 12:30:04')]));
  assert.deepEqual([after.lastWrite.kind, after.lastWrite.account, after.account], ['refreshed', B, B]);
});

test('시작하자마자 갱신해 인증 줄보다 먼저 찍힌 줄은 시작 때 읽은 계정으로 읽는다', () => {
  const file = write('cli-20261124_101437.log', [loaded('1124', '10:14:37', '2026-11-24 10:15:29'),
    refreshed('1124', '10:14:37', '2026-11-24 11:14:36'), auth('1124', '10:14:37', A), ...noise(2)]);
  const log = readAgyLog(file);
  assert.equal(log.lastWrite.account, A);
  assert.equal(log.account, A);
});

test('덮어쓰기가 없는 로그: lastWrite가 없고 만료는 시작 때 읽은 값이다. 인증 줄이 없으면 계정은 모름', () => {
  const only = readAgyLog(write('cli-20261124_141628.log', [loaded('1124', '14:16:28', '2026-11-24 15:15:32'), auth('1124', '14:16:28', A)]));
  assert.equal(only.lastWrite, null);
  assert.equal(only.expiryMs, expiryMs('2026-11-24 15:15:32', '+0900'));
  const none = readAgyLog(write('cli-20261124_141629.log', noise(3)));
  assert.equal(none.account, null);
  assert.equal(readAgyLog(path.join(dir, 'cli-20261124_999999.log')), null);
});

test('끝에서부터 덩어리로 읽는다: 덩어리 경계의 줄도 한 줄로 이어 붙고, 줄 수가 많아도 되는 만큼만 읽는다', () => {
  const lines = [...noise(500), auth('1124', '12:00:00', A)];
  const file = write('cli-20261124_120000.log', lines);
  const seen = [];
  scanBackward(file, line => { seen.push(line); return seen.length === 3; }, {chunk: 64});
  assert.equal(seen[0], lines.at(-1));
  assert.equal(seen[1], lines.at(-2));
  assert.equal(seen[2], lines.at(-3));
  const all = [];
  assert.equal(scanBackward(file, line => { all.push(line); return false; }, {chunk: 37}).complete, true);
  assert.deepEqual(all.reverse(), lines);
});

test('읽기 상한을 넘으면 계정을 추측하지 않고 모름으로 둔다(인증 줄이 상한 밖에 있는 큰 로그)', () => {
  const file = write('cli-20261124_130000.log', [loaded('1124', '13:00:00', '2026-11-24 14:00:00'), auth('1124', '13:00:00', A), ...noise(2000),
    refreshed('1124', '14:00:05', '2026-11-24 15:00:04'), ...noise(10)]);
  const small = readAgyLog(file, {budget: 4096, chunk: 1024});
  assert.equal(small.complete, false);
  assert.equal(small.account, null);
  assert.equal(small.lastWrite.account, null);
  const full = readAgyLog(file);
  assert.equal(full.complete, true);
  assert.equal(full.account, A);
  assert.equal(full.lastWrite.account, A);
});
