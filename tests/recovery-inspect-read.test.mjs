// Why: 복원 조회는 원장에서 start·stop·window만 읽는다. 그 좁은 읽기가 전체 읽기와 같은 판정을 내는지 고정한다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {inspectRecovery} from '../src/recovery.mjs';
import {appendLedger, readSystemLedger, readRecoveryLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker, appendRow, transaction} from '../src/storage.mjs';

const KINDS = new Set(['start', 'stop', 'window']);
function newHome() {
  const dir = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'inspect-read-'));
  createDatabase(dir); writeStorageMarker(dir, 'sqlite');
  return dir;
}
// 옛 원장 사건: SQLite 안의 'ledger.jsonl' 영역(파일이 아님)에 직접 넣는다.
const legacy = (home, rows) => transaction(home, db => { for (const row of rows) appendRow(db, 'ledger.jsonl', row); });
const start = (role, terminal, extra = {}) => ({kind: 'start', floor: 'tmux', role, session: `kadan-${role}`,
  cwd: '/work', cmd: 'claude --model opus --effort high', panePid: '20', by: 'lead',
  ...(terminal ? {rottieTerminalId: terminal} : {}), ...extra});
const pane = {pid: '20', dead: false, created: '123'};
const outcome = run => { try { return {ok: run()}; } catch (error) { return {error: error.message}; } };
// 같은 원장을 좁게 읽은 판정과 전체를 읽은 판정을 나란히 낸다.
function both(home, flags) {
  const narrow = outcome(() => inspectRecovery(flags, {home, livePane: () => pane}));
  const full = outcome(() => inspectRecovery(flags, {home, livePane: () => pane, entries: readSystemLedger(home)}));
  assert.deepEqual(narrow, full);
  return narrow;
}
// 세 종류 밖의 사건을 섞는다. 감시AI 호출 기록은 실제처럼 크고, 같은 탭 ID를 가진 다른 종류도 넣는다.
function noise(home, terminal, count = 40) {
  for (let i = 0; i < count; i++) {
    appendLedger({kind: 'watch-ai-request', requestId: `r${i}`, parents: 'p'.repeat(9000), routes: 'r'.repeat(9000),
      note: '"kind":"start"', rottieTerminalId: terminal, session: 'kadan-other'}, home);
    appendLedger({kind: 'advice', role: 'other', session: 'kadan-other', rottieTerminalId: terminal}, home);
    appendLedger({kind: 'alert', alertKind: 'quiet', role: 'super', session: 'kadan-super'}, home);
    appendLedger({kind: 'send', role: 'super', by: 'lead', taskId: `t${i}`, executionKey: `r/t${i}`}, home);
    appendLedger({kind: 'done', role: 'super', taskId: `t${i}`, executionKey: `r/t${i}`, result: 'ok'}, home);
  }
}

test('세 종류 밖의 사건이 많이 섞여도 좁은 읽기는 전체 읽기에서 세 종류만 고른 것과 같다', () => {
  const home = newHome();
  legacy(home, [{t: '2026-01-01T00:00:00.000Z', ...start('old', 'legacy-tab')},
    {kind: 'stop', role: 'gone', session: 'kadan-gone', t: '2026-01-01T00:00:01.000Z'},
    {t: '2026-01-01T00:00:02.000Z', kind: 'alert', note: {kind: 'start'}}]);
  noise(home, 'tab-1');
  appendLedger(start('super', 'tab-1'), home);
  noise(home, 'tab-1');
  appendLedger({kind: 'window', role: 'super', session: 'kadan-super', panePid: '20',
    rottieTerminalId: 'tab-2', restoredFrom: 'tab-1', by: '사람'}, home);
  noise(home, 'tab-2', 5);
  const full = readSystemLedger(home);
  assert.ok(full.length > 250);
  const narrow = readRecoveryLedger(home);
  assert.deepEqual(narrow, full.filter(entry => KINDS.has(entry.kind)));
  assert.deepEqual(narrow.map(entry => entry.kind), ['start', 'stop', 'start', 'window']);
  assert.equal(narrow.some(entry => '_ledgerOrder' in entry), false);

  const moved = both(home, {terminal: 'tab-2'});
  assert.equal(moved.ok.role, 'super');
  assert.equal(moved.ok.effort, 'high');
  assert.match(moved.ok.startDigest, /^[0-9a-f]{64}$/);
  assert.match(both(home, {terminal: 'tab-1'}).error, /교체됐을/); // 탭을 갈아 끼운 뒤의 옛 탭
  assert.equal(both(home, {terminal: 'legacy-tab'}).ok.role, 'old'); // 옛 원장 영역에만 있는 오래전 시작
  assert.match(both(home, {terminal: 'no-such-tab'}).error, /확인하지 못했습니다/);
  assert.match(both(home, {terminal: 'tab-2', cwd: '/elsewhere'}).error, /작업 폴더가 다릅니다/);
});

test('오래전 시작·탭 교체·종료 뒤 거절이 좁은 읽기에서도 그대로다', () => {
  const home = newHome();
  appendLedger(start('lead', 'first'), home);
  noise(home, 'first', 30); // 시작 뒤에 다른 사건이 오래 쌓인다
  assert.equal(both(home, {terminal: 'first'}).ok.role, 'lead');
  appendLedger({kind: 'stop', role: 'lead', session: 'kadan-lead', rottieTerminalId: 'first'}, home);
  assert.match(both(home, {terminal: 'first'}).error, /직접 종료한/);
  appendLedger(start('lead', undefined, {panePid: '99'}), home); // 탭 없이 다시 띄운 새 세대
  assert.match(both(home, {terminal: 'first'}).error, /교체됐을/);
  appendLedger({kind: 'window', role: 'lead', session: 'kadan-lead', panePid: '99', rottieTerminalId: 'late'}, home);
  assert.equal(both(home, {terminal: 'late'}).ok.panePid, '99');
  // 이전 탭에서 추론 강도를 이어받는 옛 복원 기록
  appendLedger(start('lead', 'mid', {panePid: '21'}), home);
  noise(home, 'mid', 3);
  appendLedger(start('lead', 'next', {cmd: 'claude --resume exact --model opus', restoredFrom: 'mid'}), home);
  assert.equal(both(home, {terminal: 'next'}).ok.effort, 'high');
});

test('앞머리 모양이 다른 사건도 전체 읽기와 같은 종류로 읽는다', () => {
  const home = newHome();
  legacy(home, [
    {kind: 'start', role: 'a', session: 'kadan-a', t: 'kind-first'}, // 종류가 맨 앞
    {t: 'short', kind: 'stop', session: 'kadan-a'}, // 시각 길이가 다름
    {t: '2026-01-01T00:00:00.000Z', by: 'x', kind: 'window', session: 'kadan-a'}, // 사이에 다른 필드
    {t: '2026-01-01T00:00:00.000Z', kind: 'alert', inner: {kind: 'start'}},
    {t: '2026-01-01T00:00:00.000Z', kind: 'starter'},
    {t: '2026-01-01T00:00:00.000Z', kind: 'sta"rt'},
    {t: '2026-01-01T00:00:00.000Z', kind: 'start\\'},
    {t: 'xxxxxxxxxxxxxxxxxxxxxxx"', kind: 'start', session: 'kadan-b'}, // 시각 안의 따옴표
    {t: 'xxxxxxxxxxxxxxxxxxxxx","k', kind: 'stop', session: 'kadan-b'},
    {t: '","kind":"start","x":"', kind: 'alert'}, // 시각 값이 종류처럼 보임
    {t: '2026-01-01T00:00:00.000Z', kind: 'k'.repeat(80)}, // 창 밖까지 이어지는 긴 종류
    {t: '2026-01-01T00:00:00.000Z', kind: 'window', session: 'kadan-b'},
  ]);
  for (const t of ['xxxxxxxxxxxxxxxxxxxxxx\\', 'xxxxxxxxxxxxxxxxxxxxxxx"', '","kind":"stop","y":"']) {
    appendLedger({t, kind: 'alert', note: t}, home);
    appendLedger({t, kind: 'stop', session: 'kadan-b'}, home);
  }
  appendLedger({kind: 'starting', session: 'kadan-b'}, home);
  const full = readSystemLedger(home).filter(entry => KINDS.has(entry.kind));
  assert.equal(full.length, 9);
  assert.deepEqual(readRecoveryLedger(home), full);
});

test('저장소가 없거나 빈 홈이면 예전과 같은 문구로 거절한다', () => {
  const none = fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'inspect-none-'));
  assert.deepEqual(readRecoveryLedger(none), []);
  assert.match(both(none, {terminal: 'tab'}).error, /확인하지 못했습니다/);
  assert.match(both(newHome(), {terminal: 'tab'}).error, /확인하지 못했습니다/);
});
