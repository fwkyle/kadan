import {mailHeaderLine} from '../src/mail-header.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareTransfer, acceptTransfer, transferStatus} from '../src/adopt-transfer.mjs';
import {captureSource, verifySource, processIdentity} from '../src/adopt-process.mjs';
import {createHash} from 'node:crypto';
import {monitorAdoption} from '../src/adopt-monitor.mjs';
import {notifyAdoption} from '../src/adopt-notice.mjs';

const identity = (pid, parent = '1') => ({pid: String(pid), parent, started: 'Tue Oct 13 10:00:00 2026',
  executable: '/bin/sh'});
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-adopt-transfer-'));
  const floor = {alive: () => true, pid: () => '20'};
  const permissions = {args: ['--permission-mode', 'bypassPermissions'], sessionId: 'old', lastUser: 'original'};
  const source = {terminalId: 'old-tab', bin: '/test/rottie', shell: identity('10'), ai: identity('11', '10')};
  const inspect = pid => identity(pid);
  const transfer = prepareTransfer({home, role: 'new', session: 'kadan-new',
    conversation: {harness: 'claude', id: 'old', cwd: '/project', file: '/old.jsonl'},
    permissions, source, floor, inspect});
  const calls = [];
  const deps = {home, id: transfer.id, flags: {summary: '승인된 로컬 수정을 이어받아 검사한다.'}, floor,
    env: {KADAN_ROLE: 'new', CLAUDE_CODE_SESSION_ID: 'new-conversation'}, inspect,
    lineage: () => [identity('21', '20'), identity('20')],
    locate: () => '/new.jsonl',
    readPermissions: file => file === '/old.jsonl' ? permissions : {...permissions, sessionId: 'new-conversation'},
    verify: () => calls.push('verify'), record: event => calls.push(event.phase),
    close: () => { calls.push('close'); return {closed: true}; },
    remove: () => { calls.push('remove'); return {removed: true}; }};
  return {home, transfer, deps, calls, permissions};
}

test('2026-10-13: only the receiving agent acknowledgement closes/removes source, once', () => {
  const {home, transfer, deps, calls} = fixture();
  assert.equal(transferStatus(home, transfer.id).status, 'awaiting-acceptance');
  assert.deepEqual(calls, [], 'creating a window or echoing the prompt is not acceptance');
  assert.match(transfer.instruction, /adopt accept/);
  assert.equal(acceptTransfer(deps).source, 'removed');
  assert.deepEqual(calls, ['verify', 'accepted', 'verify', 'close', 'remove', 'finished']);
  assert.equal(acceptTransfer(deps).source, 'removed');
  assert.equal(calls.filter(value => value === 'close').length, 1);
});

test('wrong actor, replaced PID, old conversation, wrong actual permissions and changed source preserve tab', () => {
  for (const modify of [
    d => { d.env.KADAN_ROLE = 'other'; },
    d => { d.lineage = () => [identity('50')]; },
    d => { d.floor.pid = () => '22'; },
    d => { d.inspect = pid => ({...identity(pid), started: 'reused'}); },
    d => { d.env.CLAUDE_CODE_SESSION_ID = 'old'; },
    d => { d.readPermissions = () => ({args: ['--permission-mode', 'manual']}); },
    d => { const read = d.readPermissions; d.readPermissions = f => ({...read(f), lastUser: 'new-instruction'}); },
    d => { d.verify = () => { throw new Error('source changed'); }; },
    d => { d.flags.summary = '이어받은 목표·승인 범위와 다음 행동'; },
  ]) {
    const {deps, calls} = fixture(); modify(deps);
    assert.throws(() => acceptTransfer(deps));
    assert.equal(calls.includes('close'), false);
  }
});

test('ambiguous close does not remove or retry; an interrupted acknowledgement cannot close twice', () => {
  const {deps, calls} = fixture();
  deps.close = () => { calls.push('close'); return {closed: false, code: 'UNKNOWN'}; };
  assert.equal(acceptTransfer(deps).source, 'close-failed');
  assert.equal(calls.includes('remove'), false);
  acceptTransfer(deps);
  assert.equal(calls.filter(value => value === 'close').length, 1);
  const other = fixture();
  other.deps.close = () => { other.calls.push('close'); throw new Error('interrupted'); };
  assert.throws(() => acceptTransfer(other.deps), /interrupted/);
  assert.equal(transferStatus(other.home, other.transfer.id).status, 'accepted-unfinished');
  assert.throws(() => acceptTransfer(other.deps), /EEXIST/);
  assert.equal(other.calls.filter(value => value === 'close').length, 1);
});

test('source tab selection uses ancestor shell PID, not title; secretary resume cannot close secretary tab', () => {
  const rows = {11: {...identity('11', '10'), executable: '/bin/claude'}, 10: identity('10')};
  const options = {conversation: {harness: 'claude', id: 'old'},
    env: {CLAUDE_CODE_SESSION_ID: 'old', KADAN_ROTTIE_BIN: '/test/rottie'},
    lineage: [rows[11], rows[10]], inspect: pid => rows[pid],
    query: () => ({runtime: {bundleId: 'app', build: 'one'}, result: {terminals: [
      {id: 'unrelated', pid: 12, state: 'running', title: 'same title'},
      {id: 'old-tab', pid: 10, state: 'running', title: 'same title'},
    ]}})};
  const source = captureSource(options);
  assert.equal(source.terminalId, 'old-tab');
  assert.throws(() => captureSource({...options, conversation: {harness: 'claude', id: 'other'}}), /프로세스 확인/);
  const verify = {inspect: options.inspect, query: () => ({runtime: source.runtime,
    result: {terminal: {id: 'old-tab', state: 'running', pid: 10}}})};
  verifySource(source, verify);
  assert.throws(() => verifySource(source, {...verify, inspect: pid => ({...rows[pid], started: 'reused'})}));
  assert.throws(() => verifySource(source, {...verify, query: () => ({runtime: {bundleId: 'other', build: 'one'}})}));
});

test('process identity parser handles real macOS ps layout without reading arguments or secrets', () => {
  const parsed = processIdentity(22, (_cmd, _args, options) => {
    assert.equal(options.env.LC_ALL, 'C', '사용자 언어와 관계없이 날짜 형식을 고정한다');
    return {status: 0, stdout: '   10 Tue Oct 13 10:00:00 2026 /bin/claude\n'};
  });
  assert.deepEqual(parsed, {...identity('22', '10'), executable: '/bin/claude'});
});

test('one bounded wait reports delayed acceptance to secretary; successful adoption needs no letter', async () => {
  const letters = []; let now = 0;
  const deps = {status: () => ({status: 'awaiting-acceptance', role: 'new'}),
    now: () => now, sleep: async ms => { now += ms; }, timeout: 2000,
    notify: letter => letters.push(letter)};
  await monitorAdoption('/test', 'id', deps);
  assert.equal(letters.length, 1);
  await monitorAdoption('/test', 'id', {...deps, status: () => ({status: 'accepted', source: 'removed'})});
  assert.equal(letters.length, 1);
});

test('secretary exception reports use existing mailbox and suppress duplicate messages', () => {
  const entries = []; let sends = 0;
  const details = {id: 'id', role: 'new', reason: 'permission notice'};
  const deps = {read: () => entries, send: options => {
    sends++;
    entries.push({kind: 'send', role: '비서', by: options.by, mailId: 'letter',
      digest: createHash('sha256').update(mailHeaderLine({by: options.by, role: '비서'}) + options.message).digest('hex')});
    assert.equal(options.by, 'kadan-adopt');
    return {mailId: 'letter', status: 'stored'};
  }};
  assert.equal(notifyAdoption('/test', details, deps).status, 'stored');
  assert.equal(notifyAdoption('/test', details, deps).duplicate, true);
  assert.equal(sends, 1);
});

test('receiver death after acceptance recording still preserves original tab', () => {
  const {deps, calls} = fixture();
  deps.floor.alive = () => !calls.includes('accepted');
  assert.throws(() => acceptTransfer(deps), /새 감독 프로세스/);
  assert.equal(calls.includes('close'), false);
});

test('원본 탭 닫기·remove 실패는 code 옆에 정리된 원인 문구(message)를 결과와 원장에 남기고, 성공이면 칸이 없다', () => {
  const long = '로티\n오류 ' + 'x'.repeat(300);
  const closeFailed = fixture();
  closeFailed.deps.close = () => ({closed: false, code: 'ROTTIE_CLOSE_FAILED', message: long});
  const events = []; closeFailed.deps.record = event => events.push(event);
  const result = acceptTransfer(closeFailed.deps);
  assert.equal(result.source, 'close-failed');
  assert.equal(result.code, 'ROTTIE_CLOSE_FAILED');
  assert.ok(result.message.startsWith('로티 오류 xxx') && result.message.endsWith('…'));
  assert.equal([...result.message].length, 201);
  assert.deepEqual(events.at(-1).result, result);
  assert.equal(transferStatus(closeFailed.home, closeFailed.transfer.id).message, result.message);

  const removeFailed = fixture();
  removeFailed.deps.remove = () => ({removed: false, code: 'ROTTIE_REMOVE_FAILED', message: '탭이 목록에 남음'});
  const removed = acceptTransfer(removeFailed.deps);
  assert.deepEqual([removed.source, removed.code, removed.message], ['remove-failed', 'ROTTIE_REMOVE_FAILED', '탭이 목록에 남음']);

  const noMessage = fixture();
  noMessage.deps.close = () => ({closed: false, code: 'ROTTIE_CLOSE_FAILED', message: ' \n '});
  assert.ok(!('message' in acceptTransfer(noMessage.deps)));

  const ok = acceptTransfer(fixture().deps);
  assert.equal(ok.source, 'removed');
  assert.ok(!('message' in ok));
});
