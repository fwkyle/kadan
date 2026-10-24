import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WatchReports} from '../src/watch-report.mjs';
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

test('SQLite는 JSONL 잠금을 쓰지 않고 JSONL 작업 예외도 자기 잠금을 반환한다', () => {
  const sqlite = fixture(true);
  fs.mkdirSync(sqlite.lock);
  assert.equal(sqlite.reports.locked(() => 'sqlite'), 'sqlite');
  assert.equal(fs.existsSync(sqlite.lock), true);
  const jsonl = fixture();
  assert.throws(() => jsonl.reports.locked(() => { throw new Error('작업 실패'); }), /작업 실패/);
  assert.equal(jsonl.reports.locked(() => '다음 작업'), '다음 작업');
});
