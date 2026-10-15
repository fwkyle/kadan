import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WatchReports} from '../src/watch-report.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';

function fixture(sqlite = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-report-lock-'));
  if (sqlite) { createDatabase(home); writeStorageMarker(home, 'sqlite'); }
  const reports = new WatchReports({home, floor: {list: () => []}, send: () => assert.fail('외부 발송 없음'),
    readCards: () => [{id: 'card', key: 'test/card', role: 'worker', status: 'assigned'}],
    readWorks: () => [],
  });
  return {home, reports, lock: path.join(home, '.watch-report-lock')};
}

test('JSONL 보고는 다른 프로세스의 잠금 해제 뒤 저장하고 같은 요청은 한 번만 남긴다', async () => {
  const f = fixture();
  appendLedger({kind: 'start', role: 'worker', session: 'kadan-worker', panePid: 1}, f.home);
  appendLedger({kind: 'send', role: 'worker', taskId: 'card', executionKey: 'test/card'}, f.home);
  const request = f.reports.request({source: 'stall', role: 'worker'});
  assert.ok(request);
  fs.mkdirSync(f.lock);
  const child = spawn(process.execPath, ['-e',
    `setTimeout(() => require('fs').renameSync(process.argv[1], process.argv[1] + '-released'), 150)`, f.lock]);
  const closed = once(child, 'close');
  try {
    assert.equal(f.reports.submit(request.requestId, '진행중', '격리 시험').accepted, true);
    assert.equal(f.reports.submit(request.requestId, '진행중', '같은 요청').duplicate, true);
    assert.equal(readLedger(f.home).filter(e => e.kind === 'watch-ai-report').length, 1);
    assert.equal(fs.existsSync(f.lock), false);
  } finally { await closed; }
});

test('JSONL 잠금이 끝내 풀리지 않으면 정해진 시간 뒤 실패하고 남의 잠금을 보존한다', () => {
  const f = fixture();
  fs.mkdirSync(f.lock);
  let entered = false;
  const start = Date.now();
  assert.throws(() => f.reports.locked(() => { entered = true; }), /감시 보고 저장 중/);
  assert.ok(Date.now() - start >= 4900);
  assert.equal(entered, false);
  assert.equal(fs.existsSync(f.lock), true);
});

test('SQLite는 JSONL 잠금을 쓰지 않고 JSONL 작업 예외도 자기 잠금을 반환한다', () => {
  const sqlite = fixture(true);
  fs.mkdirSync(sqlite.lock);
  assert.equal(sqlite.reports.locked(() => 'sqlite'), 'sqlite');
  assert.equal(fs.existsSync(sqlite.lock), true);
  const jsonl = fixture();
  assert.throws(() => jsonl.reports.locked(() => { throw new Error('작업 실패'); }), /작업 실패/);
  assert.equal(jsonl.reports.locked(() => '다음 작업'), '다음 작업');
});
