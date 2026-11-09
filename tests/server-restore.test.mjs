import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareServerRestore, finishServerRestore,
  restoreCandidates, serverState} from '../src/server-restore.mjs';
import {restoreCommand, parseRestoreCommand} from '../src/server-restore-command.mjs';
import {runServerRestoreCycle} from '../src/server-restore-cycle.mjs';
import {writeServerSessions} from '../src/server-sessions.mjs';
import {commandWords} from '../src/ai-identity.mjs';
import {finishRevive} from '../src/revive.mjs';

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
    read: () => entries, hierarchy: () => ({}), bootTime: () => NOW - 3600_000};
  const snapshot = (now = NOW - 1000, sessions = entries.map(e => e.session)) =>
    writeServerSessions(home, sessions, now);
  snapshot();
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
  return {home, cwd, projectsDir, start, entries, options, calls, ops, transcript, snapshot};
}

test('서버 없음: 관찰된 감독만 복원, 시작 전 1통·결과 1통·역할 안내 각각 1통', () => {
  const f = fixture();
  f.entries.push(f.start('감독이라는이름-worker', 'worker'), f.start('test-review', 'reviewer'));
  f.entries.push(f.start('비서', 'secretary'));
  f.snapshot();
  const original = f.ops.startRole;
  f.ops.startRole = (...args) => {
    assert.deepEqual(f.calls.notices, ['서버 통째 종료 감지 — 감독 2명 복원 시작']);
    return original(...args);
  };
  const event = finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.deepEqual(f.calls.starts.map(x => x.item.role), ['test-super', 'test-lead']);
  assert.ok(f.calls.starts.every(x => !x.item.command.includes('옛 첫 지시') && x.id === OTHER));
  assert.deepEqual([f.calls.records.length, f.calls.notices.length, f.calls.sends.length], [1, 2, 2]);
  assert.equal(event.candidateBasis, 'server-sessions-snapshot');
  assert.equal(event.by, 'autostart');
  assert.equal(event.reason, 'server-loss');
  assert.equal(event.restoreId, OTHER);
  assert.ok(f.calls.sends.every(x => x.message.includes('직전 명령')));
});

test('present + 손상 복원 상태: 기반 실행, 원장 조회 0, 매 주기 관찰 갱신·0600', () => {
  const f = fixture(); let base = 0, lists = 0;
  fs.writeFileSync(path.join(f.home, 'server-restore-state.json'), '{"attemptedAt":"bad"}');
  for (const now of [NOW, NOW + 60_000]) {
    const result = runServerRestoreCycle({...f.options, now,
      listSessions: () => { lists++; return {status: 0, stdout: 'kadan-test-super\npersonal\n'}; },
      read: () => assert.fail('정상 주기 원장 조회'),
      runBase: ({serverLoss}) => { assert.equal(serverLoss, false); base++; return 'base-result'; },
    }, f.ops);
    assert.equal(result, 'base-result');
    const file = path.join(f.home, 'server-sessions.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),
      {observedAt: new Date(now).toISOString(), sessions: ['kadan-test-super']});
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(base, 2); assert.equal(lists, 2);
  assert.equal(f.calls.starts.length + f.calls.notices.length, 0);
});

test('missing + 원장 예외: 기반 결과 유지, 사유 사건·중복 방지 키 알림 1통', () => {
  const f = fixture(); let base = 0; const keys = [];
  const notify = f.ops.notify;
  f.ops.notify = (message, options) => { keys.push(options.key); notify(message); };
  for (let cycle = 0; cycle < 2; cycle++) {
    assert.equal(runServerRestoreCycle({...f.options,
      runBase: ({serverLoss}) => { assert.equal(serverLoss, true); base++; return 17; },
      read: () => { assert.equal(base, cycle + 1); throw new Error('database is locked'); },
    }, f.ops), 17);
  }
  assert.equal(base, 2);
  assert.equal(f.calls.notices.length, 1, '같은 사유는 OS 알림도 1시간에 한 번');
  assert.match(keys[0], /^server-restore-error-/);
  assert.equal(f.calls.records[0].reason, 'server-restore-error');
  assert.equal(f.calls.records[0].detail, '복원 원장 조회 실패');
  f.snapshot(NOW + 3600_000);
  runServerRestoreCycle({...f.options, now: NOW + 3600_000, runBase: () => {},
    read: () => { throw new Error('database is locked'); }}, f.ops);
  assert.equal(f.calls.notices.length, 2); assert.equal(keys[0], keys[1]);
});

test('unknown: 기반만 실행, 스냅숏 불변·복원·알림 없음, stderr 한 줄', () => {
  for (const result of [{status: 1, stderr: 'Permission denied'}, {status: null, error: new Error('timeout')},
    {status: 1, stderr: 'no server running on x\nother error'}]) {
    const f = fixture(), warnings = [];
    const file = path.join(f.home, 'server-sessions.json'), before = fs.readFileSync(file, 'utf8');
    let base = 0;
    runServerRestoreCycle({...f.options, listSessions: () => result,
      read: () => assert.fail('unknown 원장 조회'), warn: line => warnings.push(line),
      runBase: ({serverLoss}) => { assert.equal(serverLoss, false); base++; },
    }, f.ops);
    assert.equal(base, 1); assert.equal(warnings.length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(f.calls.starts.length + f.calls.notices.length, 0);
  }
  assert.equal(serverState({status: 1,
    stderr: 'error connecting to /tmp/fake (No such file or directory)'}), 'missing');
});

test('관찰 뒤 재부팅·부팅 시각 불명: 시작 0, 수동 안내 1통', () => {
  for (const boot of [NOW - 500, NaN, -1]) {
    const f = fixture(); f.options.bootTime = () => boot;
    finishServerRestore(prepareServerRestore(f.options), f.ops);
    assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.notices.length, 1);
    assert.match(f.calls.notices[0], /부팅|수동/);
  }
  // 부팅 후 15분이 지나 로그인해도, 부팅 전 관찰은 오래된 기록이므로 복원하지 않는다.
  const f = fixture(); f.snapshot(NOW - 20 * 60_000);
  f.options.bootTime = () => NOW - 15 * 60_000;
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.equal(f.calls.starts.length, 0); assert.match(f.calls.notices[0], /관찰 이후 재부팅/);
  assert.match(f.calls.notices[0], /수동:/);
});

test('거짓 죽음 경보는 무시, 관찰에 없는 오래된 명시 resume 감독은 제외', () => {
  const f = fixture();
  f.entries.push({kind: 'alert', role: 'test-super', alertKind: '죽음'});
  f.entries.push(f.start('test-old', 'conductor', {t: '2026-10-15T00:00:00Z'}));
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.deepEqual(f.calls.starts.map(x => x.item.role), ['test-super', 'test-lead']);
});

test('관찰 이후 stop만 제외, 이전 stop은 생존 관찰이 우선', () => {
  const f = fixture();
  f.entries.push({kind: 'stop', session: 'kadan-test-lead', t: new Date(NOW).toISOString()});
  f.entries.push({kind: 'stop', role: 'test-super', t: new Date(NOW - 2000).toISOString()});
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.deepEqual(f.calls.starts.map(x => x.item.role), ['test-super']);
});

test('프로필 없는 옛 start는 관계표의 자식 유무로 판정, 명시 worker·비서는 제외', () => {
  const f = fixture();
  const entries = [f.start('root'), f.start('middle'), f.start('leaf'),
    f.start('worker', 'worker'), f.start('비서')];
  for (const entry of entries) if (entry.role !== 'worker') delete entry.roleProfile;
  const parents = {root: '@user', middle: 'root', leaf: 'middle', worker: 'root', '비서': '@user', child: '비서'};
  const snapshot = f.snapshot(NOW - 1000, entries.map(e => e.session));
  assert.deepEqual(restoreCandidates(entries, parents, snapshot).map(x => [x.start.role, x.profile]),
    [['root', 'super'], ['middle', 'conductor']]);
});

test('시작 기록 없는 관찰 세션은 건너뜀 목록에 표시', () => {
  const f = fixture(); f.snapshot(NOW - 1000, ['kadan-test-no-start']);
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.equal(f.calls.starts.length, 0);
  assert.match(f.calls.notices[0], /test-no-start: skipped.*시작 기록 없음/);
});

test('스냅숏 없음·10분 초과·손상: 시작 없이 수동 확인 알림만', () => {
  for (const kind of ['missing', 'stale', 'corrupt']) {
    const f = fixture(), file = path.join(f.home, 'server-sessions.json');
    if (kind === 'missing') fs.renameSync(file, `${file}.saved`);
    if (kind === 'stale') f.snapshot(NOW - 600_001);
    if (kind === 'corrupt') fs.writeFileSync(file, 'bad');
    if (kind !== 'stale') f.options.read = () => assert.fail('유효한 관찰 없이 원장 읽음');
    finishServerRestore(prepareServerRestore(f.options), f.ops);
    assert.equal(f.calls.starts.length, 0); assert.equal(f.calls.notices.length, 1);
    assert.match(f.calls.notices[0], /수동/);
  }
});

test('revive stopped·손상 상태는 복원하지 않는다', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'revive-state.json'),
    JSON.stringify({targets: {'test-lead': {state: 'stopped'}}}));
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.deepEqual(f.calls.starts.map(x => x.item.role), ['test-super']);
  const g = fixture(); fs.writeFileSync(path.join(g.home, 'revive-state.json'), 'broken');
  finishServerRestore(prepareServerRestore(g.options), g.ops);
  assert.equal(g.calls.starts.length, 0);
});

test('시작 전 예약으로 60분 상한 보존, 같은 스냅숏은 중복 처리하지 않음', () => {
  const f = fixture(); prepareServerRestore(f.options);
  assert.equal(prepareServerRestore(f.options), null);
  f.options.now += 60_000; f.snapshot(NOW + 59_000);
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.equal(f.calls.starts.length, 0); assert.match(f.calls.notices[0], /60분/);
  f.options.now = NOW + 3600_000; f.snapshot(NOW + 3599_000);
  assert.equal(prepareServerRestore(f.options).attempted, true);
});

test('끄는 파일이면 복원 준비를 건너뜀', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.home, 'server-restore.off'), '');
  f.options.read = () => assert.fail('꺼진 복원 조회');
  assert.equal(prepareServerRestore(f.options), null);
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
  f.snapshot();
  finishServerRestore(prepareServerRestore(f.options), f.ops);
  assert.equal(f.calls.starts.length, 0);
  assert.equal(f.calls.records[0].results.filter(x => x.result === 'skipped').length, 3);
  assert.equal(f.calls.records[0].results[0].reason, '작업 폴더 없음');
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
  assert.match(f.calls.notices.at(-1), /kadan attach 'test-lead'/);
  assert.match(f.calls.notices.at(-1), /전달 실패/);
});

test('기반 실행 실패·원장 쓰기 실패는 성공으로 숨기지 않는다', () => {
  const f = fixture();
  assert.throws(() => runServerRestoreCycle({...f.options,
    runBase: () => { throw new Error('base failed'); },
    read: () => assert.fail('기반 실패 뒤 복원 시작')}, f.ops), /base failed/);
  assert.equal(f.calls.starts.length, 0);
  const g = fixture();
  assert.throws(() => finishServerRestore(prepareServerRestore(g.options), {...g.ops,
    record: () => { throw new Error('disk'); }}), /disk/);
  assert.equal(g.calls.notices.length, 1, '시작 전 안내만 있고 성공 결과 안내는 없음');
});

test('missing + 상한 상태 손상·사유 원장 쓰기 실패에도 기반 결과 유지와 오류 통지', () => {
  const f = fixture(), warnings = [];
  fs.writeFileSync(path.join(f.home, 'server-restore-state.json'), '{"attemptedAt":"bad"}');
  const result = runServerRestoreCycle({...f.options, runBase: () => 'base-ok',
    warn: line => warnings.push(line)}, {...f.ops, record: () => { throw new Error('disk'); }});
  assert.equal(result, 'base-ok'); assert.equal(f.calls.starts.length, 0);
  assert.equal(f.calls.notices.length, 1);
  assert.match(f.calls.notices[0], /서버 복원 상한 상태 손상/);
  assert.deepEqual(warnings, ['서버 복원 실패 사유 원장 기록 실패']);
});

// 실제 finishRevive를 통과하여 보관된 조용한 알림과 기반 사건의 대응도 검증한다.
function baseRevival(f, {ring = false} = {}) {
  const notices = [], records = [];
  const runBase = ({deferNotices}) => {
    const original = {
      notify: (message, options) => { notices.push({message, ...options}); return {via: 'discord'}; },
      record: entry => records.push(entry),
    };
    const ops = deferNotices ? deferNotices(original) : original;
    if (ring) {
      ops.notify('감시기가 1시간 상한에 걸렸습니다', {ring: true});
      assert.equal(notices.length, 1, '울림은 복원 판단 전에 즉시 전달');
    }
    finishRevive({home: f.home, now: NOW, ops,
      pending: new Map(['비서', '대시보드'].map(target => [target, {count: 1, reason: '세션 없음'}])),
      results: {비서: 'started', 대시보드: 'started'}});
    return 'base-ok';
  };
  return {runBase, notices, records};
}

test('후보 0·off·같은 관찰: 요약 없이 기존 기반 알림·실제 영수증을 보존', () => {
  for (const kind of ['empty', 'off', 'same']) {
    const f = fixture();
    if (kind === 'empty') { f.entries.splice(0, 2, f.start('test-worker', 'worker')); f.snapshot(); }
    if (kind === 'off') fs.writeFileSync(path.join(f.home, 'server-restore.off'), '');
    if (kind === 'same') prepareServerRestore(f.options);
    const base = baseRevival(f);
    assert.equal(runServerRestoreCycle({...f.options, runBase: base.runBase}, f.ops), 'base-ok');
    assert.equal(base.notices.length, 2, kind);
    assert.ok(base.notices.every(n => n.ring === false));
    assert.deepEqual(base.records.map(e => [e.target, e.notice, e.noticeSummary]),
      [['비서', 'discord', undefined], ['대시보드', 'discord', undefined]]);
    assert.equal(f.calls.notices.length, 0);
  }
});

test('계획 있음: 기반 울림은 따로, 조용한 기반 결과는 요약과 실제 알림 결과에 연결', () => {
  for (const receipt of [{via: 'system'}, {via: 'none', reason: '알림 불가'}]) {
    const f = fixture(), base = baseRevival(f, {ring: true});
    f.ops.notify = message => { f.calls.notices.push(message); return receipt; };
    runServerRestoreCycle({...f.options, runBase: base.runBase}, f.ops);
    assert.equal(base.notices.length, 1, '울림 외 기반 알림은 결과 요약에 포함');
    assert.equal(f.calls.notices.length, 2);
    assert.match(f.calls.notices[1], /기반: 비서가 꺼져 있어 다시 띄웠습니다/);
    assert.match(f.calls.notices[1], /대시보드가 꺼져 있어 다시 띄웠습니다/);
    assert.equal(f.calls.notices[1].split('\n').filter(line => line.startsWith('기반:')).length, 1);
    assert.equal(f.calls.records[0].baseResults.length, 2);
    assert.ok(base.records.every(e => e.notice === receipt.via && e.noticeSummary === OTHER));
    assert.equal(base.records[0].noticeReason, receipt.reason);
  }
});

test('요약 전송 예외가 나면 보관한 기반 알림을 그대로 보내고 가짜 요약 영수증을 남기지 않음', () => {
  const f = fixture(), base = baseRevival(f);
  f.ops.notify = message => {
    if (message.startsWith('tmux 서버 전체')) throw new Error('notify failed');
    f.calls.notices.push(message);
  };
  runServerRestoreCycle({...f.options, runBase: base.runBase}, f.ops);
  assert.equal(base.notices.length, 2);
  assert.ok(base.records.every(e => e.notice === 'discord' && e.noticeSummary === undefined));
});

test('처리 오류·낡은 관찰·재부팅에도 직전 감독 세션 이름을 알림과 사건에 보존', () => {
  for (const kind of ['error', 'stale', 'reboot']) {
    const f = fixture();
    f.entries.push(f.start('test-worker', 'worker')); f.snapshot();
    if (kind === 'error') fs.writeFileSync(path.join(f.home, 'server-restore-state.json'), 'bad');
    if (kind === 'stale') f.snapshot(NOW - 600_001);
    if (kind === 'reboot') f.options.bootTime = () => NOW - 500;
    runServerRestoreCycle({...f.options, runBase: () => {}}, f.ops);
    assert.equal(f.calls.starts.length, 0);
    const event = f.calls.records[0];
    assert.deepEqual(event.supervisorSessions, ['kadan-test-super', 'kadan-test-lead']);
    assert.match(f.calls.notices[0], /직전 감독 세션: kadan-test-super, kadan-test-lead/);
    assert.ok(!event.supervisorSessions.includes('kadan-test-worker'));
    f.snapshot(NOW, ['kadan-비서']);
    assert.deepEqual(event.supervisorSessions, ['kadan-test-super', 'kadan-test-lead']);
  }
});

test('원장 오류로 종류를 모르면 스냅숏의 세션 이름만 보존하고 감독이라고 추측하지 않음', () => {
  const f = fixture();
  runServerRestoreCycle({...f.options, runBase: () => {},
    read: () => { throw new Error('locked'); }}, f.ops);
  assert.equal(f.calls.records[0].supervisorSessions, null);
  assert.deepEqual(f.calls.records[0].observedSessions, ['kadan-test-super', 'kadan-test-lead']);
  assert.match(f.calls.notices[0], /역할 종류 확인 불가.*kadan-test-super, kadan-test-lead/);
  assert.doesNotMatch(f.calls.notices[0], /--resume|옛 첫 지시/);
});

test('present 스냅숏 쓰기 실패: 기반 실행 유지, 오류 사건과 한 시간 한 번 알림', () => {
  const f = fixture(); let base = 0;
  const file = path.join(f.home, 'server-sessions.json');
  fs.renameSync(file, `${file}.saved`);
  fs.mkdirSync(file); // rename 대상이 디렉터리라 쓰기 실패. 권한·실제 디스크 장애 없이 재현.
  for (const now of [NOW, NOW + 60_000]) {
    assert.equal(runServerRestoreCycle({...f.options, now,
      listSessions: () => ({status: 0, stdout: 'kadan-test-lead\n'}),
      runBase: () => { base++; return 'base-ok'; }}, f.ops), 'base-ok');
  }
  assert.equal(base, 2); assert.equal(f.calls.notices.length, 1);
  assert.match(f.calls.notices[0], /서버 세션 목록 저장 실패/);
  assert.equal(f.calls.records.length, 2);
  assert.ok(f.calls.records.every(e => e.reason === 'server-restore-error'));
});
