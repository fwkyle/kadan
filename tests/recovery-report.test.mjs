import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {reportRecovery} from '../src/recovery-report.mjs';
import {Mailbox} from '../src/mailbox.mjs';
const flags = {report: JSON.stringify({version: 1, status: 'ambiguous', terminalId: 'original',
  title: 'director', cwd: '/workspace', reason: '역할 연결을 확정할 수 없습니다.'})};
function home() { return fs.mkdtempSync(path.join(process.env.KADAN_HOME, 'recovery-report-')); }

test('exceptions go to the durable secretary mailbox once, without waking a session', () => {
  const h = home();
  const result = reportRecovery(flags, {home: h});
  assert.equal(result.status, 'stored');
  assert.equal(result.wake, 'not-connected');
  const duplicate = reportRecovery(flags, {home: h});
  assert.equal(duplicate.mailId, result.mailId);
  assert.equal(duplicate.duplicate, true);
  const letters = new Mailbox(h, '비서').list();
  assert.equal(letters.length, 1);
  assert.match(new Mailbox(h, '비서').read(result.mailId).body, /살아 있는 세션은 건드리지/);
});

test('successful recovery and malformed reports are refused before sending', () => {
  const h = home();
  for (const report of [{version:1,status:'completed',terminalId:'old',reason:'done'},
    {version:1,status:'failed',reason:'error'}]) {
    assert.throws(() => reportRecovery({report:JSON.stringify(report)}, {home:h}));
  }
  assert.equal(new Mailbox(h, '비서').list().length, 0);
});

test('uncertain mailbox delivery never retries, but a committed letter can be reconciled', () => {
  const h = home();
  assert.throws(() => reportRecovery(flags, {home:h, send:() => {throw new Error('timeout');}}), /timeout/);
  assert.throws(() => reportRecovery(flags, {home:h, send:() => assert.fail('must not resend')}), /불확실/);
  const h2 = home(); let committed;
  assert.throws(() => reportRecovery(flags, {home:h2, send:options => {
    committed = new Mailbox(h2, '비서').send(options); throw new Error('after commit');
  }}), /after commit/);
  assert.equal(reportRecovery(flags, {home:h2}).mailId, committed.mailId);
  assert.equal(new Mailbox(h2, '비서').list().length, 1);
});
