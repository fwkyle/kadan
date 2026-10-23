import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {appendLedger,readLedger,readTaskLedger,readMailLedger,readMailboxLedger,readSystemLedger} from '../src/ledger.mjs';
import {createDatabase,writeStorageMarker,appendStream,readStream,transaction,storagePath} from '../src/storage.mjs';
import {ledgerStreams,projectLedger} from '../src/ledger-domains.mjs';
import {readLedgerIncremental,readLedgerStateIncremental,readLedgerViewIncremental,incrementalInfo,incrementalCounts,resetIncremental}
  from '../src/ledger-incremental.mjs';
import {cycleReads} from '../src/watch-reads.mjs';
import {collectRoles} from '../src/watch-roles.mjs';
import {endedExecutionKeys} from '../src/watch-supervisor.mjs';
import {planStaleNotices} from '../src/watch-stale-notice.mjs';
import {storageVersion} from '../src/storage.mjs';

// Why: 감시기의 원장 읽기를 '커서 뒤 새 사건만'으로 바꿔도 결과는 전체 읽기와 바이트까지 같아야 한다. 합성 원장만 쓴다.
const sqliteHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-ledger-incremental-'));
  createDatabase(dir);writeStorageMarker(dir, 'sqlite');
  return dir;
};
const FULL = {default: [readLedger, null], tasks: [readTaskLedger, 'tasks'], mail: [readMailLedger, 'mail'],
  mailbox: [readMailboxLedger, 'mailbox'], system: [readSystemLedger, 'system']};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quiet = () => {};
// 도메인 5종을 같은 순서(tasks가 mail보다 먼저)로 비교한다. 증분 투영의 본 키 집합이 도메인 사이에 새면 여기서 갈린다.
function assertSame(home, label) {
  for (const [name, [readFull, domain]] of Object.entries(FULL))
    assert.equal(digest(readLedgerIncremental(home, {domain, log: quiet})), digest(readFull(home)), `${label}: ${name}`);
}

let seq = 0;
const id = prefix => `${prefix}-${++seq}`;
// 묶음 종류: 일반 send / 작업 send+dispatch / done+완료 우편 / handover / watch-* / start·stop
const batches = {
  mail: home => appendLedger({kind: 'send', role: 'reader', by: 'lead', taskId: 'ctx', transport: 'mailbox', mailId: id('m')}, home),
  task: (home, key = id('t')) => appendLedger({kind: 'send', role: 'worker', by: 'lead', taskId: key,
    executionKey: `r/${key}`, mailId: id('m')}, home),
  done: (home, key) => appendLedger({kind: 'done', role: 'worker', taskId: key, executionKey: `r/${key}`, result: 'ok'}, home),
  handover: home => appendLedger({kind: 'handover', phase: 'transferred', handoverId: id('h'), from: 'worker', to: 'next',
    taskIds: ['r/other']}, home),
  watch: home => {
    appendLedger({kind: 'watch-ai-request', requestId: id('q'), parents: [['a', 'b']], routes: [['a', 'b']], timing: {a: 1},
      session: 's', evidenceDigest: 'x'}, home);
    appendLedger({kind: 'watch-cycle', by: 'watch', timing: {a: 1}, parents: [['a', 'b']], ok: true}, home);
    appendLedger({kind: 'watch-mail-reminder', action: 'result', delivery: 'sent', mailId: id('m'), role: 'worker',
      stage: 'first', timing: {a: 1}}, home);
  },
  session: home => {appendLedger({kind: 'start', role: 'worker', session: 'kadan-worker', panePid: 1}, home);
    appendLedger({kind: 'stop', role: 'worker'}, home);},
};
function seed(home, n = 6) {
  for (let i = 0; i < n; i++) {
    batches.session(home);batches.mail(home);batches.watch(home);
    const key = id('seed');batches.task(home, key);batches.done(home, key);
  }
}

test('7-1 투영 같음: 묶음 종류를 K번 덧붙일 때마다 도메인 5종 sha256이 전체 읽기와 같고, 첫 읽기 뒤에는 전체를 다시 읽지 않는다', () => {
  resetIncremental();
  const home = sqliteHome();seed(home);
  assertSame(home, '시작');
  const afterBuild = incrementalCounts();
  assert.equal(afterBuild.full, 1);
  for (let round = 0; round < 3; round++) {
    batches.mail(home);assertSame(home, `일반 send ${round}`);
    const key = id('k');batches.task(home, key);assertSame(home, `작업 send+dispatch ${round}`);
    batches.done(home, key);assertSame(home, `done+완료 우편 ${round}`);
    batches.done(home, key);assertSame(home, `중복 done ${round}`);
    batches.handover(home);assertSame(home, `handover ${round}`);
    batches.watch(home);assertSame(home, `watch-* ${round}`);
    batches.session(home);assertSame(home, `start·stop ${round}`);
  }
  const counts = incrementalCounts();
  assert.equal(counts.full, 1, '덧붙이는 동안 전체 읽기는 처음 한 번뿐');
  assert.ok(counts.incremental >= 20, `증분 갱신 횟수 ${counts.incremental}`);
});

test('돌려준 배열은 버전마다 새 배열이고 이전 버전 배열은 제자리에서 늘어나지 않는다', () => {
  resetIncremental();
  const home = sqliteHome();seed(home, 2);
  const first = readLedgerIncremental(home, {log: quiet}),firstLength = first.length;
  const same = readLedgerIncremental(home, {log: quiet});
  assert.equal(same, first, '바뀐 게 없으면 같은 버전');
  batches.mail(home);
  const second = readLedgerIncremental(home, {log: quiet});
  assert.notEqual(second, first);
  assert.equal(first.length, firstLength);assert.equal(second.length, firstLength + 1);
  assert.equal(second[0], first[0], '사건 객체는 공유');
  const state = readLedgerStateIncremental(home, {log: quiet});
  batches.mail(home);
  assert.notEqual(readLedgerStateIncremental(home, {log: quiet}).ordered, state.ordered);
});

test('조건 5 새 묶음 안의 완료 우편: done과 완료 우편이 같은 증분 묶음에 들어와도 검증을 통과한다', () => {
  resetIncremental();
  const home = sqliteHome();seed(home, 2);
  const key = id('c');batches.task(home, key);assertSame(home, '발령');
  const before = incrementalCounts().full;
  batches.done(home, key);
  const rows = readLedgerIncremental(home, {domain: 'mail', log: quiet});
  assert.ok(rows.some(row => row.completion && row.completionTaskId === key), '완료 우편이 증분 묶음에서 보인다');
  assert.equal(incrementalCounts().full, before);
  assertSame(home, '완료 뒤');
});

test('조건 6 도메인별 uniqueDone: 영역마다 본 키 집합이 따로라 같은 입력의 첫 완료가 영역별로 다르게 남는다', () => {
  resetIncremental();
  const home = sqliteHome();
  const key = id('u');batches.task(home, key);
  readLedgerIncremental(home, {domain: 'tasks', log: quiet});
  batches.done(home, key);batches.done(home, key);
  const tasks = readLedgerIncremental(home, {domain: 'tasks', log: quiet});
  const mail = readLedgerIncremental(home, {domain: 'mail', log: quiet});
  assert.equal(tasks.filter(row => row.kind === 'done').length, 1);
  assert.equal(mail.filter(row => row.kind === 'done').length, 1);
  assert.equal(tasks.find(row => row.kind === 'done').completionMailId, mail.find(row => row.kind === 'done').completionMailId,
    '두 영역 모두 같은 첫 완료(완료 우편이 붙은 쪽)');
  assertSame(home, '도메인별');
});

test('조건 7 완료 이전 인계: 인계 뒤 새 역할의 done도 전체 읽기와 같은 완료 우편으로 이어진다', () => {
  resetIncremental();
  const home = sqliteHome();
  const key = id('x');batches.task(home, key);
  assertSame(home, '발령');
  appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'dup-id', from: 'worker', to: 'next', taskIds: [`r/${key}`]}, home);
  appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'dup-id', from: 'worker', to: 'third', taskIds: [`r/${key}`]}, home);
  assertSame(home, '인계(중복 인계 ID)');
  appendLedger({kind: 'done', role: 'next', taskId: key, executionKey: `r/${key}`, result: 'ok'}, home);
  assertSame(home, '인계 뒤 done');
  const mail = readLedgerIncremental(home, {domain: 'mail', log: quiet});
  assert.ok(mail.some(row => row.completion && row.completionTaskId === key && row.by === 'next'));
});

test('slim 흡수: 영역 읽기도 한 벌의 원시 상태에서 투영해 전체 읽기와 같고, 시스템 영역은 큰 본문만 뺀다', () => {
  resetIncremental();
  const home = sqliteHome();seed(home, 2);batches.watch(home);
  assertSame(home, 'watch 본문');
  const request = readLedgerIncremental(home, {domain: 'system', log: quiet}).findLast(row => row.kind === 'watch-ai-request');
  assert.equal('parents' in request, false);assert.equal('routes' in request, false);
  assert.deepEqual(request.timing, {a: 1}, '시스템 영역은 timing을 남긴다(기존 규칙)');
  const reminder = readLedgerIncremental(home, {domain: 'mailbox', log: quiet}).findLast(row => row.kind === 'watch-mail-reminder');
  assert.deepEqual(Object.keys(reminder).sort(), ['action', 'delivery', 'kind', 'mailId', 'role', 't']);
});

function brokenCase(name, make, message) {
  test(`7-2 깬 입력(${name}): 증분과 전체가 같은 예외를 내고, 상태·커서를 버리며, 다음 호출은 전체 읽기다`, () => {
    resetIncremental();
    const home = sqliteHome();seed(home, 2);
    assertSame(home, '정상');
    const cursorBefore = incrementalInfo(home).cursors;
    make(home);
    let fullMessage;
    assert.throws(() => readLedger(home), error => (fullMessage = error.message, message.test(error.message)));
    assert.throws(() => readLedgerIncremental(home, {log: quiet}), error => error.message === fullMessage);
    assert.equal(incrementalInfo(home), null, '증분 상태와 커서를 함께 버린다');
    assert.equal(incrementalCounts().rejected, 1);
    assert.notEqual(cursorBefore, null);
    // 같은 홈에 정상 사본을 바꿔 넣으면 다음 호출은 전체 다시 읽기로 시작한다.
    const good = sqliteHome();seed(good, 2);
    const fullsBefore = incrementalCounts().full;
    fs.renameSync(storagePath(good), storagePath(home));
    assert.equal(digest(readLedgerIncremental(home, {log: quiet})), digest(readLedger(home)));
    assert.equal(incrementalCounts().full, fullsBefore + 1);
  });
}
const lastOrder = home => Math.max(...Object.values(ledgerStreams).map(s => readStream(home, s, {optional: true}).at(-1)?._ledgerOrder ?? 0));
brokenCase('순번 빈틈', home => appendStream(home, ledgerStreams.system, {kind: 'start', role: 'gap', _ledgerOrder: lastOrder(home) + 5}), /순번 누락/);
brokenCase('중복 mailId', home => {
  const dup = readStream(home, ledgerStreams.mail).find(row => row.kind === 'send').mailId;
  appendStream(home, ledgerStreams.mail, {kind: 'send', role: 'r', mailId: dup, _ledgerOrder: lastOrder(home) + 1});
}, /중복 mailId/);
brokenCase('완료 우편 짝 깨짐', home => appendStream(home, ledgerStreams.tasks,
  {kind: 'done', role: 'worker', taskId: 'z', executionKey: 'r/z', result: 'ok', completionMailId: 'nope', _ledgerOrder: lastOrder(home) + 1}),
/완료 우편 연결 손상/);

function copyPair(modelA, modelB) {
  const make = model => {
    const home = sqliteHome();
    appendLedger({kind: 'start', role: 'a', session: 's-a', t: '2026-01-01T00:00:00.000Z'}, home);
    appendLedger({kind: 'start', role: 'mid', session: 's-mid', model, t: '2026-01-01T00:00:01.000Z'}, home);
    appendLedger({kind: 'stop', role: 'a', t: '2026-01-01T00:00:02.000Z'}, home);
    return home;
  };
  return [make(modelA), make(modelB)];
}

test('어긋남 감지 DB 교체: 행 수·마지막 행이 같고 중간 start.model만 다른 사본으로 바꿔치기해도 전체를 다시 읽는다', () => {
  resetIncremental();
  const [home, other] = copyPair('model-A', 'model-B');
  const lines = [];
  const before = readLedgerIncremental(home, {log: line => lines.push(line)});
  assert.equal(before.find(row => row.role === 'mid').model, 'model-A');
  assert.deepEqual(incrementalInfo(home).cursors['system/events.jsonl'], 3);
  // 파일 교체(복원 도구가 하는 일): 옛 -wal·-shm은 치우고(이름만 바꿔 둔다) 새 사본을 제자리에 넣는다.
  for (const suffix of ['-wal', '-shm'])
    if (fs.existsSync(storagePath(home) + suffix)) fs.renameSync(storagePath(home) + suffix, `${storagePath(home)}${suffix}.replaced`);
  fs.renameSync(storagePath(other), storagePath(home));
  const after = readLedgerIncremental(home, {log: line => lines.push(line)});
  assert.equal(after.find(row => row.role === 'mid').model, 'model-B');
  assert.equal(digest(after), digest(readLedger(home)));
  assert.equal(lines.length, 1);assert.match(lines[0], /DB 파일 식별값이 바뀜/);
  assert.equal(incrementalCounts().drift, 1);
});

test('어긋남 감지: 끝 순번 감소, 끝 행 지문 다름, 옛 원문 변경은 로그 한 줄과 함께 전체를 다시 읽는다', () => {
  const cases = {
    '끝 순번 감소': (home, db) => {
      const stream = ledgerStreams.system,seqNow = db.prepare('SELECT seq FROM heads WHERE stream=?').get(stream).seq;
      const row = db.prepare('SELECT payload FROM events WHERE stream=? AND seq=?').get(stream, seqNow - 1);
      db.prepare('UPDATE heads SET seq=?,payload=? WHERE stream=?').run(seqNow - 1, row.payload, stream);
    },
    '행 지문 다름': (home, db) => db.prepare('UPDATE heads SET payload=? WHERE stream=?')
      .run(JSON.stringify({kind: 'stop', role: 'x', _ledgerOrder: 3}), ledgerStreams.system),
    '옛 원문 변경': home => appendStream(home, 'ledger.jsonl', {kind: 'stop', role: 'old'}),
  };
  for (const [name, tamper] of Object.entries(cases)) {
    resetIncremental();
    const [home] = copyPair('m', 'm'),lines = [];
    readLedgerIncremental(home, {log: line => lines.push(line)});
    transaction(home, db => tamper(home, db));
    const after = readLedgerIncremental(home, {log: line => lines.push(line)});
    assert.equal(lines.length, 1, name);assert.match(lines[0], /전체 다시 읽기/, name);
    assert.equal(incrementalCounts().drift, 1, name);
    assert.equal(digest(after), digest(readLedger(home)), name);
  }
});

test('저장소 없는 홈(none)은 증분 상태 없이 빈 결과를 돌려주고 파일을 만들지 않는다', () => {
  resetIncremental();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-ledger-incremental-none-'));
  for (const domain of [null, 'tasks', 'mail', 'mailbox', 'system'])
    assert.deepEqual(readLedgerIncremental(home, {domain, log: quiet}), []);
  assert.deepEqual(readLedger(home), []);
  assert.equal(storageVersion(home), null);
  assert.equal(incrementalInfo(home), null);
  assert.equal(incrementalCounts().full, 0);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('감시기 연결: 같은 고정 입력으로 K주기 동안 낸 경보 판단 입력이 전체 읽기 때와 같다', () => {
  resetIncremental();
  const home = sqliteHome();
  const cards = [{id: 'a', key: 'r/a', role: 'worker', status: 'assigned', workType: 'execution'}];
  const floor = {list: () => [{session: 'kadan-worker', pid: 1}], read: () => '› '};
  const alerts = entries => JSON.stringify([
    collectRoles(floor, entries, null, cards).observations,
    endedExecutionKeys({cards, entries, liveSessions: new Set(['kadan-worker']), now: Date.parse('2026-10-20T00:00:00Z')}),
    planStaleNotices({cards, entries, works: [], now: Date.parse('2026-10-20T00:00:00Z'), liveSessions: new Set(['kadan-worker'])}),
  ], (key, value) => value instanceof Map ? [...value] : value instanceof Set ? [...value] : value);
  appendLedger({kind: 'start', role: 'worker', session: 'kadan-worker', panePid: 1, t: '2026-10-19T00:00:00.000Z'}, home);
  const viaFull = cycleReads({readEntries: () => readLedger(home), version: () => storageVersion(home)});
  const viaIncremental = cycleReads({readEntries: () => readLedgerIncremental(home, {log: quiet}), version: () => storageVersion(home)});
  for (let cycle = 0; cycle < 5; cycle++) {
    if (cycle === 1) appendLedger({kind: 'send', role: 'worker', by: 'lead', taskId: 'a', executionKey: 'r/a', mailId: id('m'),
      t: '2026-10-19T01:00:00.000Z'}, home);
    if (cycle === 3) appendLedger({kind: 'done', role: 'worker', taskId: 'a', executionKey: 'r/a', result: 'ok',
      t: '2026-10-19T02:00:00.000Z'}, home);
    batches.watch(home);
    viaFull.begin();viaIncremental.begin();
    assert.equal(alerts(viaIncremental.readEntries()), alerts(viaFull.readEntries()), `주기 ${cycle}`);
    viaFull.end();viaIncremental.end();
  }
  assert.equal(incrementalCounts().full, 1);
});

test('한 번 읽기: state와 entries는 같은 current() 한 번에서 나와 같은 끝 순번까지만 반영한다', () => {
  resetIncremental();
  const home = sqliteHome();seed(home);
  const first = readLedgerViewIncremental(home, {log: quiet});
  assert.equal(digest(first.entries), digest(readLedger(home)));
  assert.equal(digest(first.entries), digest(projectLedger(first.state)));
  const base = incrementalCounts();
  // 호출마다 읽기 한 번(full+incremental+unchanged 합이 정확히 1 늘어난다). 둘을 따로 부르면 2가 늘어난다.
  const passes = () => {const c = incrementalCounts();return c.full + c.incremental + c.unchanged;};
  const before = passes();
  batches.mail(home);
  const second = readLedgerViewIncremental(home, {log: quiet});
  assert.equal(passes() - before, 1);
  assert.equal(incrementalCounts().incremental - base.incremental, 1);
  assert.equal(digest(second.entries), digest(readLedger(home)));
  assert.equal(digest(second.entries), digest(projectLedger(second.state)));
  assert.equal(second.state.ordered.length, readLedgerStateIncremental(home, {log: quiet}).ordered.length);
  // 이미 돌려준 결과는 뒤에 들어온 사건으로 자라지 않는다(버전마다 새 배열).
  const frozen = {ordered: second.state.ordered.length, entries: second.entries.length};
  batches.mail(home);readLedgerViewIncremental(home, {log: quiet});
  assert.deepEqual({ordered: second.state.ordered.length, entries: second.entries.length}, frozen);
  assert.equal(incrementalCounts().full, 1);
});

test('한 번 읽기: 저장소 없는 홈(none)은 DB를 열지 않고 빈 state와 entries를 함께 만든다', () => {
  resetIncremental();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-ledger-view-none-'));
  const view = readLedgerViewIncremental(home, {log: quiet});
  assert.deepEqual(view.entries, []);
  assert.equal(digest(view.entries), digest(readLedger(home)));
  assert.equal(digest(view.entries), digest(projectLedger(view.state)));
  assert.deepEqual(fs.readdirSync(home), []);
});
