import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareServerRestore, finishServerRestore, settleServerRestore,
  restoreCandidates, serverState} from '../src/server-restore.mjs';
import {restoreCommand, parseRestoreCommand} from '../src/server-restore-command.mjs';
import {commandWords} from '../src/ai-identity.mjs';

const NOW = Date.parse('2026-11-09T00:00:00Z');
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-3333-4444-555555555555';
const MISSING = {status: 1, stderr: 'no server running on /tmp/fake-socket'};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-restore-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const projectsDir = path.join(root, 'projects');
  const start = (role = 'test-lead', profile = 'conductor', more = {}) => ({
    kind: 'start', t: new Date(NOW - 60_000).toISOString(), role, session: `kadan-${role}`,
    floor: 'tmux', roleProfile: profile, cmd: `claude --resume ${ID} --model test '옛 첫 지시'`, cwd, ...more,
  });
  const entries = [start('test-super', 'super'), start()];
  const options = {home, now: NOW, id: OTHER, projectsDir, listSessions: () => MISSING,
    read: () => entries, hierarchy: () => ({}), uptime: () => 3600};
  const calls = {starts: [], sends: [], notices: [], records: []};
  const ops = {
    startRole: (item, id) => { calls.starts.push({item, id}); return {hidden: false}; },
    send: (role, message) => calls.sends.push({role, message}),
    notify: message => calls.notices.push(message), record: entry => calls.records.push(entry),
  };
  const transcript = (id, role, mtime = NOW - 1000, prefix = '') => {
    const dir = path.join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, prefix + JSON.stringify({message: `수신 역할: ${role}; 안내`}) + '\n');
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  };
  return {home, cwd, projectsDir, start, entries, options, calls, ops, transcript};
}

test('서버 없음: 직전 슈퍼·감독만 같은 대화로 시작, 사건 1개·알림 1통·역할 안내 각각 1통', () => {
  const f = fixture();
  f.entries.push(f.start('감독이라는이름-worker', 'worker'), f.start('test-review', 'reviewer'));
  f.entries.push(f.start('비서', 'secretary'));
  const plan = prepareServerRestore(f.options);
  const event = finishServerRestore(plan, f.ops);
  assert.deepEqual(f.calls.starts.map(x => x.item.role), ['test-super', 'test-lead']);
  assert.ok(f.calls.starts.every(x => !x.item.command.includes('옛 첫 지시') && x.id === OTHER));
  assert.deepEqual([f.calls.records.length, f.calls.notices.length, f.calls.sends.length], [1, 1, 2]);
  assert.equal(event.by, 'autostart');
  assert.equal(event.reason, 'server-loss');
  assert.equal(event.restoreId, OTHER);
  assert.ok(f.calls.sends.every(x => x.message.includes('직전 명령')));
});

test('서버 있음: 감독 세션 하나가 없어도 원장·대화 조회, 복원, 알림 0', () => {
  const f = fixture();
  f.options.listSessions = () => ({status: 0, stdout: 'kadan-test-super'});
  f.options.read = () => assert.fail('정상 주기에 원장 읽음');
  assert.equal(prepareServerRestore(f.options), null);
  finishServerRestore(null, f.ops);
  assert.equal(f.calls.starts.length + f.calls.notices.length, 0);
});

test('재부팅 5분·시간 불명: 시작 0, 후보와 수동 안내 알림 1통', () => {
  for (const uptime of [300, NaN, -1]) {
    const f = fixture(); f.options.uptime = () => uptime;
    finishServerRestore(prepareServerRestore(f.options), f.ops);
    assert.equal(f.calls.starts.length, 0);
    assert.equal(f.calls.notices.length, 1);
    assert.match(f.calls.notices[0], /수동:/);
  }
});

test('사람 stop·죽음 경보 뒤에는 복원하지 않고, 새 start 뒤에는 다시 후보', () => {
  const f = fixture();
  f.entries.push({kind: 'stop', session: 'kadan-test-lead', by: '사람'});
  f.entries.push({kind: 'alert', role: 'test-super', alertKind: '죽음'});
  assert.deepEqual(restoreCandidates(f.entries), []);
  f.entries.push(f.start());
  assert.deepEqual(restoreCandidates(f.entries).map(x => x.start.role), ['test-lead']);
});

test('프로필 없는 옛 start는 관계표의 자식 유무로 판정, 명시 worker·비서는 제외', () => {
  const f = fixture();
  const entries = [f.start('root', undefined), f.start('middle', undefined), f.start('leaf', undefined),
    f.start('worker', 'worker'), f.start('비서', undefined)];
  for (const entry of entries) if (!['worker'].includes(entry.role)) delete entry.roleProfile;
  const parents = {root: '@user', middle: 'root', leaf: 'middle', worker: 'root', '비서': '@user', child: '비서'};
  assert.deepEqual(restoreCandidates(entries, parents).map(x => [x.start.role, x.profile]),
    [['root', 'super'], ['middle', 'conductor']]);
});

test('revive stopped·손상 상태는 복원하지 않는다', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'revive-state.json'),
    JSON.stringify({targets: {'test-lead': {state: 'stopped'}}}));
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.deepEqual(f.calls.starts.map(x => x.item.role), ['test-super']);
  const g = fixture();
  fs.writeFileSync(path.join(g.home, 'revive-state.json'), 'broken');
  finishServerRestore(prepareServerRestore(g.options), g.ops);
  assert.equal(g.calls.starts.length, 0);
});

test('복원 중 죽어도 예약된 60분 상한 보존, 서버가 있으면 다음 주기는 아무것도 안 함', () => {
  const f = fixture();
  prepareServerRestore(f.options); // 시작 직전 예약 이후 프로세스 종료를 흉내 낸다.
  settleServerRestore(f.home, () => ({status: 0})); // 기반 프로세스가 서버를 다시 만든 뒤 두 번째 손실
  f.options.now += 60_000;
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.equal(f.calls.starts.length, 0);
  assert.match(f.calls.notices[0], /60분/);
  f.options.listSessions = () => ({status: 0});
  assert.equal(prepareServerRestore(f.options), null);
  f.options.listSessions = () => MISSING;
  f.options.now = NOW + 3600_000;
  assert.equal(prepareServerRestore(f.options).attempted, true);
});

test('서버 없음이 계속되면 같은 손실의 기록·알림은 한 번만', () => {
  const f = fixture(); f.options.uptime = () => 300;
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  finishServerRestore(prepareServerRestore({...f.options, now: NOW + 60_000}), f.ops);
  assert.equal(f.calls.records.length, 1);
  assert.equal(f.calls.notices.length, 1);
  settleServerRestore(f.home, () => ({status: 0}));
  finishServerRestore(prepareServerRestore({...f.options, now: NOW + 120_000}), f.ops);
  assert.equal(f.calls.records.length, 2, '서버 재생성을 확인한 뒤 다른 손실은 새 사건');
});

test('끄는 파일이면 조회도 안 함, 조회 오류면 기반 작업까지 진행할 수 없게 throw', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'server-restore.off'), '');
  f.options.listSessions = () => assert.fail('꺼진 복원 조회');
  assert.equal(prepareServerRestore(f.options), null);
  const g = fixture();
  for (const result of [{status: 1, stderr: 'Permission denied'}, {status: null, error: new Error('timeout')},
    {status: 1, stderr: 'no server running on x\nother error'}]) {
    g.options.listSessions = () => result;
    assert.throws(() => prepareServerRestore(g.options), /조회 실패/);
  }
  assert.equal(serverState({status: 1,
    stderr: 'error connecting to /tmp/fake (No such file or directory)'}), 'missing');
});

test('명시 resume ID·옵션은 보존하고 위치 프롬프트는 제거, 알 수 없는 문법은 거절', () => {
  const f = fixture();
  const run = cmd => commandWords(restoreCommand({...f.options,
    start: f.start('test-lead', 'conductor', {cmd})}).command);
  assert.deepEqual(run(`claude --model test --resume ${ID} '옛 첫 지시'`),
    ['claude', '--resume', ID, '--model', 'test']);
  assert.deepEqual(run(`codex resume ${ID} --model test -c 'x="y"' -- '옛 지시'`),
    ['codex', 'resume', ID, '--model', 'test', '-c', 'x="y"']);
  for (const cmd of ['codex --model test', `claude --unknown value --resume ${ID}`,
    `claude --resume ${ID} --fork-session`, `claude --resume ${ID} --add-dir a b`,
    `claude --resume ${ID} unquoted prompt`, `claude --resume ${ID}; echo hi`,
    `claude --resume ${ID} --model`, `claude --resume ${ID} --continue`]) {
    assert.throws(() => parseRestoreCommand(cmd), undefined, cmd);
  }
});

test('Claude 명시 ID가 없으면 정확한 역할 쌍반점 표시·7일·시작 이후 mtime 사용', () => {
  const f = fixture(); const start = f.start('test-lead', 'conductor', {cmd: 'claude --model test'});
  f.transcript(OTHER, 'test-lead-extra');
  assert.throws(() => restoreCommand({...f.options, start}), /대화 없음/);
  const file = f.transcript(ID, 'test-lead', NOW - 1000, 'x'.repeat(65530));
  const result = restoreCommand({...f.options, start});
  assert.deepEqual(result.transcript, {id: ID, path: file, mtime: NOW - 1000});
  f.transcript(OTHER, 'test-lead');
  assert.throws(() => restoreCommand({...f.options, start}), /둘 이상/);
  for (const id of [ID, OTHER]) f.transcript(id, 'test-lead', NOW - 8 * 86400_000);
  assert.throws(() => restoreCommand({...f.options, start}), /대화 없음/);
  f.transcript(ID, 'test-lead', NOW - 120_000);
  assert.throws(() => restoreCommand({...f.options, start}), /대화 없음/);
});

test('cwd 없음·codex 대화 ID 없음·Claude 일치 없음은 항목별 건너뜀', () => {
  const f = fixture();
  f.entries[0].cwd += '-gone'; f.entries[1].cmd = 'codex --model test';
  f.entries.push(f.start('test-no-match', 'conductor', {cmd: 'claude --model test'}));
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.equal(f.calls.starts.length, 0);
  assert.equal(f.calls.records[0].results.filter(x => x.result === 'skipped').length, 3);
});

test('시작 실패는 재시도하지 않고 다음 역할 계속, 우편 실패는 시작 성공을 뒤집지 않음', () => {
  const f = fixture();
  f.ops.startRole = item => {
    f.calls.starts.push(item.role);
    if (item.role === 'test-super') throw new Error('start failure');
    return {hidden: true};
  };
  f.ops.send = () => { throw new Error('input rejected'); };
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.equal(f.calls.starts.length, 2);
  assert.deepEqual(f.calls.records[0].results.map(x => x.result), ['failed', 'started']);
  assert.match(f.calls.notices[0], /kadan attach 'test-lead'/);
  assert.match(f.calls.notices[0], /전달 실패/);
});

test('기반 실행 실패·원장 쓰기 실패는 성공으로 숨기지 않는다', () => {
  const f = fixture();
  finishServerRestore(prepareServerRestore(f.options), {...f.ops, baseError: true});
  assert.equal(f.calls.starts.length, 0);
  const g = fixture();
  assert.throws(() => finishServerRestore(prepareServerRestore(g.options), {...g.ops,
    record: () => { throw new Error('disk'); }}), /disk/);
  assert.equal(g.calls.notices.length, 0);
});
