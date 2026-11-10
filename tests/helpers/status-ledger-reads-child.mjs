// kadan status 한 번(cmdStatus)이 원장을 몇 번 읽는지 세고 출력 줄을 돌려준다. 자식 프로세스 전용 도구.
// 사용: node status-ledger-reads-child.mjs <바닥 이름 tmux|herdr> <덧붙일 세션 수>. 결과는 표준 출력의 JSON 한 줄이다.
// 세기: 읽기 함수 이름이 아니라 저장소의 읽기 트랜잭션 수(storageObservation)로 센다. 좁은 읽기도 전체 읽기도 1회로 잡힌다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [floorName, extraText] = process.argv.slice(2);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'status-reads-'));
process.env.KADAN_HOME = home;
process.env.KADAN_NOTIFY = 'off';
const {floor} = await import('../../src/floor.mjs');
const {appendLedger, readLedger, readRecoveryLedger} = await import('../../src/ledger.mjs');
const {createDatabase, writeStorageMarker, appendRow, transaction} = await import('../../src/storage.mjs');
const {storageObservation} = await import('../../src/storage-observation.mjs');
const {lastStartFor} = await import('../../src/cli-basics.mjs');
const {cmdStatus} = await import('../../src/commands/status.mjs');

createDatabase(home); writeStorageMarker(home, 'sqlite');
const start = (role, extra = {}) => (
  {kind: 'start', floor: 'tmux', role, session: `kadan-${role}`, by: 'lead', ...extra});
// 옛 원장 영역(SQLite 안의 'ledger.jsonl' 영역)에만 시작 기록이 있는 세션과, 나중에 새 영역에서 다시 시작된 세션.
transaction(home, db => {
  appendRow(db, 'ledger.jsonl', {t: '2026-01-01T00:00:00.000Z', ...start('옛', {panePid: '10'})});
  appendRow(db, 'ledger.jsonl', {t: '2026-01-01T00:00:01.000Z', ...start('일치', {panePid: '99'})});
  appendRow(db, 'ledger.jsonl',
    {t: '2026-01-01T00:00:02.000Z', kind: 'alert', session: 'kadan-일치', note: {kind: 'start'}});
});
appendLedger(start('일치', {panePid: '98', cmd: 'codex --model gpt-5', harness: 'codex', model: 'gpt-5'}), home);
// 같은 세션의 다른 종류 사건과, 본문에 start 글자가 든 큰 사건은 마지막 시작을 바꾸지 않는다.
appendLedger({kind: 'watch-ai-request', requestId: 'r1', parents: 'p'.repeat(9000), routes: 'r'.repeat(9000),
  note: '"kind":"start"', session: 'kadan-일치', panePid: '77'}, home);
appendLedger(start('일치', {panePid: '21', cmd: 'claude --model opus', harness: 'claude', model: 'opus'}), home);
appendLedger({kind: 'stop', role: '일치', session: 'kadan-일치', by: 'lead'}, home);
appendLedger({kind: 'window', role: '일치', session: 'kadan-일치', panePid: '55', by: '사람'}, home);
appendLedger(start('변경', {rottiePid: '31', cmd: 'kimi', harness: 'kimi'}), home);
appendLedger({kind: 'send', role: '변경', by: 'lead', taskId: 't1', executionKey: 'r/t1'}, home);
const extra = Number(extraText) || 0;
for (let i = 0; i < extra; i++) appendLedger(start(`덤${i}`, {panePid: String(100 + i), model: 'sonnet'}), home);

const live = [['옛', '10'], ['일치', '21'], ['변경', '32'], ['없음', '40'],
  ...Array.from({length: extra}, (_, i) => [`덤${i}`, String(100 + i)])];
const sessions = live.map(([role, pid], i) => ({session: `kadan-${role}`, pid, attached: i % 2 ? '1' : '0',
  created: 1_700_000_000 + i, terminalId: `term-${i}`, state: 'idle'}));
floor.list = () => sessions;
floor.name = floorName;

const lines = [];
const log = console.log;
console.log = (...args) => lines.push(args.join(' '));
const before = storageObservation(home).read.count;
let outcome = 'ok';
try { cmdStatus(); } catch (error) { outcome = `error: ${error.message}`; }
const reads = storageObservation(home).read.count - before;
console.log = log;
// 전체 읽기로 고른 세션별 마지막 시작과, 좁은 읽기(start·stop·window)로 고른 것을 나란히 낸다.
// 읽기 횟수를 센 뒤에 읽으므로 위 계수에는 들어가지 않는다.
const full = readLedger(home), narrow = readRecoveryLedger(home);
const picks = sessions.map(({session}) => (
  {session, full: lastStartFor(session, full), narrow: lastStartFor(session, narrow)}));
console.log(JSON.stringify({outcome, sessions: sessions.length, reads, lines, picks}));
