import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker, openDatabase} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {resolveWorkMail} from '../src/work-mail.mjs';
import {runWaitLoop, screenDoneResult} from '../src/cli-wait-done.mjs';

// --- V9: 질문을 보낸 뒤 그 실행을 업무에 연결해도 최종 답장이 거절되지 않는다 ---
function mailFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-reply-link-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const works = new WorkStore(home), cards = new CardStore(home);
  const work = works.create({key: 'repo/w', title: '업무', goal: '결과', scope: '전체', acceptance: '확인', owner: '감독', repoPath: home});
  const exec = cards.create({repo: 'repo', id: 'exec-1', repoPath: home, body: '# 지시'});
  const link = () => works.change(work.key, 'link', {execution: exec.key, phase: 'implementation', round: 1},
    {revision: works.get(work.key).revision, by: '감독', note: '연결'});
  return {home, work, exec, link};
}

test('V9: 질문 뒤 실행을 업무에 연결해도 최종 답장은 원본 연결(실행만)을 이어받는다', () => {
  const {home, work, exec, link} = mailFixture();
  const q = new Mailbox(home, '감독').send({by: '작업자', message: '질문', executionKey: exec.key, expectReply: true});
  assert.equal(q.workKey, undefined);
  link();
  const context = resolveWorkMail(home, {replyTo: q.mailId, role: '작업자', by: '감독', replyFinal: true});
  assert.equal(context.executionKey, exec.key);
  assert.equal(context.workKey, undefined);
  const reply = new Mailbox(home, '작업자').send({by: '감독', message: '답', replyTo: q.mailId, replyFinal: true});
  const stored = new Mailbox(home, '감독').read(reply.mailId);
  assert.equal(stored.replyTo, q.mailId);
  assert.equal(stored.executionKey, exec.key);
  // 새 우편은 연결된 업무를 그대로 추론한다.
  assert.equal(resolveWorkMail(home, {executionKey: exec.key}).workKey, work.key);
});

test('V9: 다른 실행을 붙인 답장은 여전히 거절하고, 원본에 없던 업무를 --work로 붙이면 쓰는 법을 알려 준다', () => {
  const {home, work, exec, link} = mailFixture();
  const q = new Mailbox(home, '감독').send({by: '작업자', message: '질문', executionKey: exec.key, expectReply: true});
  link();
  assert.throws(() => resolveWorkMail(home, {replyTo: q.mailId, executionKey: 'repo/other', role: '작업자', by: '감독', replyFinal: true}), /다릅니다/);
  assert.throws(() => resolveWorkMail(home, {replyTo: q.mailId, workKey: work.key, role: '작업자', by: '감독', replyFinal: true}),
    /원본 질문에는 업무가 없|--work를 빼/);
});

// --- V3: 같은 카드에 ok·failed 마커가 둘 있으면 wait와 from-screen이 같은 결과를 확정한다 ---
const session = 'kadan-w', role = 'w';
const cards = [{key: 'repo/a', id: 'a'}];
const dispatch = {kind: 'send', session, role, taskId: 'a', executionKey: 'repo/a', baselineMarkers: []};
function waitRecorded(text, baselineMarkers = []) {
  const recorded = [];
  const floor = {name: 'fake', read: () => ({text, cursor: 'c', incremental: false}), waitForChange() {}};
  const result = runWaitLoop({floor, session, role, intervalMs: 1, timeoutMs: 1000, quietMs: 500, baselineMarkers, cards, record: e => recorded.push(e)});
  return {result, recorded};
}
const fromScreen = (text, entries = [dispatch]) => screenDoneResult({text, entries, role, taskId: 'repo/a', cards}).result;

for (const [name, text, expected] of [
  ['앞 ok·뒤 failed', 'KADAN:DONE a ok\n작업 중\nKADAN:DONE a failed\n', 'failed'],
  ['앞 failed·뒤 ok', 'KADAN:DONE a failed\n작업 중\nKADAN:DONE a ok\n', 'ok'],
]) {
  test(`V3: ${name}이면 wait가 기록한 결과와 done --from-screen 결과가 같다`, () => {
    const {result, recorded} = waitRecorded(text);
    assert.equal(result.code, 0);
    assert.deepEqual(recorded.map(e => [e.taskId, e.result]), [['a', expected]]);
    assert.equal(fromScreen(text), expected);
  });
}

test('V3 대조군: 단일 마커·baseline 포함 화면·서로 다른 카드는 그대로다', () => {
  assert.deepEqual(waitRecorded('KADAN:DONE a ok').recorded.map(e => e.result), ['ok']);
  const baseline = [{taskId: 'a', result: 'ok'}];
  const withBaseline = waitRecorded('KADAN:DONE a ok\nKADAN:DONE a failed\n', baseline);
  assert.deepEqual(withBaseline.recorded.map(e => e.result), ['failed']);
  const two = waitRecorded('KADAN:DONE a ok\nKADAN:DONE b failed\nKADAN:DONE a failed\n');
  assert.deepEqual(two.recorded.map(e => [e.taskId, e.result]).sort(), [['a', 'failed'], ['b', 'failed']]);
});

// --- DOC-001: 문서의 busy_timeout 수치가 코드의 기본값과 맞는다 ---
test('DOC-001: sqlite-storage.md의 busy_timeout 초 수가 실제 기본값과 같다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-doc-busy-'));
  createDatabase(dir); writeStorageMarker(dir, 'sqlite');
  const saved = process.env.KADAN_BUSY_TIMEOUT_MS; delete process.env.KADAN_BUSY_TIMEOUT_MS;
  try {
    const db = openDatabase(dir, {readOnly: true});
    const ms = (() => { try { return db.prepare('PRAGMA busy_timeout').get().timeout; } finally { db.close(); } })();
    const doc = fs.readFileSync(new URL('../docs/sqlite-storage.md', import.meta.url), 'utf8');
    assert.match(doc, new RegExp(`${ms / 1000}초 busy_timeout`));
    assert.match(doc, new RegExp(`최대 ${ms / 1000}초`));
    assert.doesNotMatch(doc, /(?<![\d])5초 busy_timeout|최대 5초/);
  } finally { if (saved !== undefined) process.env.KADAN_BUSY_TIMEOUT_MS = saved; }
});
