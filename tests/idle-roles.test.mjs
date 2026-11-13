import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {CardStore} from '../src/card-store.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {runIdleRoles, defaultDeps, idleRolesDue, claimIdleRolesRun, formatReport, reopenOutlook,
  IDLE_ROLES_OFF, IDLE_ROLES_SENDER, MAX_MAILS_PER_RUN, SWEEP_INTERVAL_MS} from '../src/idle-roles.mjs';
import {readIdleState, idleStatePath} from '../src/idle-screen-clock.mjs';
import {claimIdleRolesGate, runIdleRolesGate} from '../src/commands/idle-roles.mjs';
import {backgroundMarker} from '../src/watch-status-line.mjs';

// Why: 정리 후보 고르기는 "모르면 후보가 아니다"와 "아무것도 끄지 않는다"가 전부다. 가짜 바닥·가짜 시계와 실제 저장소(원장·업무·카드·우편)로
// 후보 조건, 빼는 조건 하나씩, 같은 후보를 기준 시간에 한 번만 알리는 것, 상한·끄기 파일·--dry-run·한 시간 문을 시험한다.
// 실제 tmux·실제 우편 명령 왕복은 idle-roles-tmux.test.mjs가 본다.
const HOUR = 60 * 60 * 1000;
const IDLE = '\n출력\n❯ \n';
const T1 = Date.now() - 13 * HOUR; // 첫 표본 시각. 두 번째 표본(지금)에서 기준 12시간을 넘긴다.
const HIERARCHY = {'슈퍼': '@user', '감독': '슈퍼', '작업A': '감독', '검수B': '감독'};

function world({profiles = {}, hierarchy = HIERARCHY, hours = 12} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-idle-'));
  createDatabase(home); writeStorageMarker(home, 'sqlite');
  const store = new WorkStore(home), cards = new CardStore(home);
  const roles = {'슈퍼': 'super', '감독': 'conductor', '작업A': 'worker', '검수B': 'reviewer', ...profiles};
  const pids = {}, screens = {}, stopped = [], sent = [];
  let pidSeq = 100;
  const start = (role, profile, extra = {}) => {
    const session = `kadan-${role}`;
    pids[session] = String(pidSeq++); screens[session] = IDLE;
    appendLedger({kind: 'start', floor: 'tmux', role, session, cmd: 'codex --model m', cwd: home, panePid: pids[session], by: '감독',
      ...(profile ? {roleProfile: profile} : {}), ...extra}, home);
  };
  for (const [role, profile] of Object.entries(roles)) start(role, profile);
  const floor = {name: 'tmux', pid: s => pids[s], read: s => screens[s], assertHumanIdle: () => {},
    list: () => Object.keys(pids).map(session => ({session, alive: true, pid: pids[session], created: 1})),
    stop: s => { stopped.push(s); }};
  const deps = {...defaultDeps(home, floor), hours: () => hours, hierarchy: () => hierarchy, decisions: () => [],
    settings: () => ({runners: {codex: {resume: 'codex --model {model} resume {conversation}'}}}),
    lookup: () => ({conversation: '0197aaaa-1111-4222-8333-444455556666', conversationStart: 'x'}),
    // 실제 우편 명령 대신 보관 우편을 쓴다(원장 send의 모양은 같다: 보낸 쪽·본문 지문).
    sendMail: (to, message) => { sent.push({to, message}); return {ok: true, mailId: new Mailbox(home, to).send({by: IDLE_ROLES_SENDER, message}).mailId}; }};
  const run = (now, extra = {}) => runIdleRoles({home, floor, now, deps, ...extra});
  // 표본을 한 번 쌓고(T1) 기준 시간을 넘긴 지금 다시 돈다.
  const settle = () => run(T1);
  const mk = (key, owner = '감독') => store.create({key, title: '업무', goal: '결과', scope: '범위', acceptance: '조건', owner, repoPath: home});
  const change = (key, action, fields) => store.change(key, action, fields, {revision: store.get(key).revision, by: '감독', note: '확인'});
  return {home, store, cards, floor, deps, pids, screens, stopped, sent, run, settle, start, mk, change};
}
const skipOf = (report, role) => report.skipped.find(item => item.role === role)?.reason;
const roles = report => report.candidates.map(c => c.role).sort();

test('후보: 화면이 기준 시간 넘게 그대로이고 맡은 일이 없는 작업자·검수자를 직속 감독에게 묶음 우편 한 통으로 알린다', () => {
  const w = world(); w.settle();
  const report = w.run(Date.now());
  assert.deepEqual(roles(report), ['검수B', '작업A']);
  assert.equal(w.sent.length, 1, '받는 감독마다 한 통');
  assert.equal(w.sent[0].to, '감독');
  assert.match(w.sent[0].message, /^\[정리 후보\] 화면이 12시간 넘게 그대로이고 맡은 일이 없는 하위 역할 2개입니다\. 카단은 아무것도 끄지 않습니다\./);
  assert.match(w.sent[0].message, /^- 작업A · worker · 마지막 화면 변화 \d\d\/\d\d \d\d:\d\d 무렵\(약 13시간 전\) · reopen 가능\(대화 0197aaaa\) · 끄기: kadan stop 작업A$/m);
  assert.match(w.sent[0].message, /끄기: kadan stop 검수B$/m);
  assert.deepEqual(w.stopped, [], '아무것도 끄지 않는다');
  assert.equal(readLedger(w.home).filter(e => e.kind === 'stop').length, 0);
  assert.equal(readIdleState(w.home).candidates.length, 2, '대시보드가 읽을 후보 수');
});

test('기준 시간을 넘기지 않았으면 후보가 없고 원장을 읽지 않는다', () => {
  const w = world(); w.settle();
  let reads = 0;
  const report = runIdleRoles({home: w.home, floor: w.floor, now: T1 + 11 * HOUR,
    deps: {...w.deps, readEntries: () => { reads++; return readLedger(w.home); }}});
  assert.equal(report.stale, 0);
  assert.equal(reads, 0);
  assert.equal(w.sent.length, 0);
});

test('기준 시간은 설정값을 따른다: 3시간이면 4시간 쉰 역할이 후보다', () => {
  const w = world({hours: 3}); w.run(Date.now() - 4 * HOUR);
  assert.deepEqual(roles(w.run(Date.now())), ['검수B', '작업A']);
  assert.match(w.sent[0].message, /화면이 3시간 넘게/);
});

test('화면이 바뀐 역할은 후보가 아니다. 바닥글만 바뀐 역할은 후보다', () => {
  const w = world(); w.settle();
  w.screens['kadan-작업A'] = '\n새 출력\n❯ \n';
  assert.deepEqual(roles(w.run(Date.now())), ['검수B']);
});

test('다시 띄운 세대(restartOf·reopenOf)도 후보다 — 업무 마감 정리의 세대 제한이 없다', () => {
  const w = world();
  w.start('작업A', 'worker', {restartOf: 'abc', reason: '계정 전환'});
  w.settle();
  assert.deepEqual(roles(w.run(Date.now())), ['검수B', '작업A']);
});

test('일반감독: 책임진 업무가 없고 살아 있는 하위가 없으면 후보이고 슈퍼감독에게 알린다', () => {
  const w = world({hierarchy: {'슈퍼': '@user', '감독': '슈퍼'}, profiles: {'작업A': undefined, '검수B': undefined}});
  delete w.pids['kadan-작업A']; delete w.pids['kadan-검수B'];
  w.settle();
  const report = w.run(Date.now());
  assert.deepEqual(roles(report), ['감독']);
  assert.equal(w.sent[0].to, '슈퍼');
});

test('빼는 조건: 슈퍼감독·비서·프로필 기록 없음·기반 프로세스', () => {
  const w = world({profiles: {'비서역': 'secretary', '무기록': '', 'watch': 'worker'}}); w.settle();
  const report = w.run(Date.now());
  assert.match(skipOf(report, '슈퍼'), /프로필 super/);
  assert.match(skipOf(report, '비서역'), /프로필 secretary/);
  assert.match(skipOf(report, '무기록'), /프로필 기록 없음/);
  assert.equal(skipOf(report, 'watch'), undefined, '기반 프로세스는 목록에도 넣지 않는다');
  assert.ok(!roles(report).includes('watch'));
});

test('빼는 조건: 끝나지 않은 카드(완료 기록이 없는 발령)', () => {
  const w = world(); w.settle();
  appendLedger({kind: 'send', by: '감독', role: '작업A', taskId: 'x1', digest: 'x1'}, w.home);
  const report = w.run(Date.now());
  assert.deepEqual(roles(report), ['검수B']);
  assert.match(skipOf(report, '작업A'), /끝나지 않은 카드 1건\(x1\)/);
});

test('빼는 조건: 책임진 열린 업무·보류 업무가 있는 감독, 업무의 차례인 역할', () => {
  const w = world(); w.mk('repo/open'); w.mk('repo/turn', '슈퍼'); w.settle();
  w.change('repo/turn', 'update', {turnOwner: '작업A'});
  let report = w.run(Date.now());
  assert.match(skipOf(report, '감독'), /책임진 끝나지 않은 업무 1건\(repo\/open\)/);
  assert.match(skipOf(report, '작업A'), /업무 repo\/turn의 차례/);
  w.change('repo/open', 'update', {status: 'hold'});
  report = w.run(Date.now());
  assert.match(skipOf(report, '감독'), /repo\/open 보류/, '보류 업무도 책임이다(깨울 길이 세션과 함께 사라진다)');
});

test('빼는 조건: 살아 있는 하위 역할이 있는 감독', () => {
  const w = world(); w.settle();
  const report = w.run(Date.now());
  assert.match(skipOf(report, '감독'), /살아 있는 하위 역할이 있음\((작업A|검수B)\)/);
});

test('빼는 조건: 열린 사용자 결정을 낸 역할', () => {
  const w = world(); w.settle();
  const report = runIdleRoles({home: w.home, floor: w.floor, now: Date.now(),
    deps: {...w.deps, decisions: () => [{id: 'd1', status: 'open', requestedBy: '작업A'}, {id: 'd2', status: 'answered', requestedBy: '검수B'}]}});
  assert.match(skipOf(report, '작업A'), /열린 사용자 결정 d1/);
  assert.deepEqual(roles(report), ['검수B'], '답이 끝난 결정은 막지 않는다');
});

test('빼는 조건: 답 대기 — 질문을 보낸 쪽과 답할 쪽 모두', () => {
  const w = world(); w.settle();
  new Mailbox(w.home, '검수B').send({by: '작업A', message: '이 값이 맞나요?', expectReply: true, category: 'request'});
  const report = w.run(Date.now());
  assert.match(skipOf(report, '작업A'), /보낸 질문의 답 대기\(검수B\)/);
  assert.match(skipOf(report, '검수B'), /답할 질문이 있음\(작업A\)/);
  assert.deepEqual(roles(report), []);
});

test('빼는 조건: 안 읽은 보관 우편이 있는 역할', () => {
  const w = world(); w.settle();
  new Mailbox(w.home, '작업A').send({by: '감독', message: '나중에 읽을 편지'});
  const report = w.run(Date.now());
  assert.match(skipOf(report, '작업A'), /안 읽은 보관 우편 1통/);
});

test('빼는 조건: 인계 진행 중(상태 파일). 끝난 인계는 막지 않는다. 깨진 파일은 확인 불가다', () => {
  const w = world(); w.settle();
  fs.mkdirSync(path.join(w.home, 'handovers'));
  const file = path.join(w.home, 'handovers', 'h1.json');
  fs.writeFileSync(file, JSON.stringify({id: 'h1', phase: 'prepared', from: '작업A', to: '작업C'}));
  assert.match(skipOf(w.run(Date.now()), '작업A'), /인계 진행 중/);
  fs.writeFileSync(file, JSON.stringify({id: 'h1', phase: 'complete', from: '작업A', to: '작업C'}));
  assert.ok(roles(w.run(Date.now())).includes('작업A'));
  fs.writeFileSync(file, '{');
  assert.match(skipOf(w.run(Date.now()), '작업A'), /확인 불가: 인계 상태를 읽지 못함/);
});

test('빼는 조건: 응답 생성 중·최근 사람 입력·입력 대기가 아닌 화면', () => {
  const w = world();
  w.screens['kadan-작업A'] = '✢ Grooving… (32s · ↓ 1.7k tokens)\n❯ \n';
  w.screens['kadan-검수B'] = '모르는 화면';
  w.settle();
  let report = w.run(Date.now());
  assert.match(skipOf(report, '작업A'), /working: 응답 생성 중/);
  assert.match(skipOf(report, '검수B'), /판정 불가: 입력 대기 화면이 아님/);
  const w2 = world(); w2.settle();
  w2.floor.assertHumanIdle = session => { if (session === 'kadan-작업A') throw Object.assign(new Error('x'), {code: 'KADAN_HUMAN_ACTIVE'}); };
  report = w2.run(Date.now());
  assert.match(skipOf(report, '작업A'), /입력 중: 사람이 최근 입력함/);
});

test('빼는 조건: 관계표를 못 읽음·관계표에 없는 역할·살아 있는 상위가 없음(사용자에게는 알리지 않는다)', () => {
  let w = world({hierarchy: null}); w.settle();
  assert.match(skipOf(w.run(Date.now()), '작업A'), /관계표를 읽지 못함/);
  w = world({hierarchy: {'슈퍼': '@user', '감독': '슈퍼', '검수B': '감독'}}); w.settle();
  assert.match(skipOf(w.run(Date.now()), '작업A'), /관계표에 없는 역할/);
  w = world(); delete w.pids['kadan-감독']; delete w.pids['kadan-슈퍼']; w.settle();
  const report = w.run(Date.now());
  assert.match(skipOf(report, '작업A'), /살아 있는 상위 감독이 없음/);
  assert.equal(w.sent.length, 0);
});

test('직속 감독이 꺼져 있으면 살아 있는 가장 가까운 상위(슈퍼감독)에게 알린다', () => {
  const w = world(); delete w.pids['kadan-감독']; w.settle();
  w.run(Date.now());
  assert.deepEqual(w.sent.map(m => m.to), ['슈퍼']);
});

test('빼는 조건: pane PID가 시작 기록과 다르면 확인 불가다', () => {
  const w = world(); w.settle();
  const real = w.floor.pid;
  w.floor.pid = session => session === 'kadan-작업A' ? '999' : real(session);
  assert.match(skipOf(w.run(Date.now()), '작업A'), /확인 불가: 이름은 같은데 다른 프로세스다/);
});

test('원장·카드·업무를 못 읽으면 전원 확인 불가이고 우편을 보내지 않는다', () => {
  for (const key of ['readEntries', 'cardSummaries', 'works', 'decisions']) {
    const w = world(); w.settle();
    const report = runIdleRoles({home: w.home, floor: w.floor, now: Date.now(), deps: {...w.deps, [key]: () => { throw new Error('읽기 실패'); }}});
    assert.deepEqual(roles(report), [], key);
    assert.match(skipOf(report, '작업A'), /확인 불가: 읽기 실패/, key);
    assert.equal(w.sent.length, 0, key);
  }
});

test('다시 열 수 없는 세션은 빼지 않고 줄에 reopen 불가(이유)를 적는다', () => {
  const w = world(); w.settle();
  const report = runIdleRoles({home: w.home, floor: w.floor, now: Date.now(),
    deps: {...w.deps, lookup: ({session}) => session === 'kadan-작업A' ? {conversationMissing: 'undetermined'} : {conversation: 'c0ffee00-1111-4222-8333-444455556666'}}});
  assert.deepEqual(roles(report), ['검수B', '작업A']);
  assert.match(w.sent[0].message, /- 작업A · worker · .* · reopen 불가\(대화 번호를 찾지 못함: undetermined\) · 끄기: kadan stop 작업A$/m);
  assert.match(w.sent[0].message, /- 검수B · reviewer · .* · reopen 가능\(대화 c0ffee00\)/m);
});

test('reopen 예상: 바닥·실행 명령·이어 열기 틀·작업 폴더를 미리 본다. 조회가 던져도 던지지 않는다', () => {
  const entries = [{kind: 'start', session: 'kadan-a', role: 'a', cmd: 'codex --model m', cwd: '/x', panePid: '1'}];
  const settings = {runners: {codex: {resume: 'codex resume {conversation}'}}};
  const ok = {conversation: 'c1'};
  const outlook = extra => reopenOutlook({session: 'kadan-a', entries, floorName: 'tmux', settings, lookup: () => ok, exists: () => true, ...extra});
  assert.deepEqual(outlook(), {ok: true, conversation: 'c1'});
  assert.match(outlook({floorName: 'herdr'}).why, /tmux 바닥이 아님/);
  assert.match(outlook({settings: {runners: {codex: {}}}}).why, /codex의 이어 열기 명령이 없음/);
  assert.match(outlook({exists: () => false}).why, /작업 폴더가 없음: \/x/);
  assert.match(outlook({entries: [{kind: 'start', session: 'kadan-a', role: 'a', cmd: 'sleep 1', cwd: '/x', panePid: '1'}]}).why, /실행기·모델을 읽지 못함/);
  assert.match(outlook({lookup: () => { throw new Error('조회 실패'); }}).why, /확인 실패: 조회 실패/);
});

test('같은 후보는 기준 시간에 한 번만 알린다 — 근거는 보낸 우편(원장 send와 본문)이다', () => {
  const w = world(); w.settle();
  w.run(Date.now());
  assert.equal(w.sent.length, 1);
  // 상태 파일을 지워도(감시기·기계 재시작) 보낸 우편에서 다시 읽으므로 또 보내지 않는다. 지문만 다시 맞춰 준다.
  const state = readIdleState(w.home);
  fs.writeFileSync(idleStatePath(w.home), JSON.stringify({version: 1, lastRunAt: null, sessions: state.sessions, attempts: {}}));
  const again = w.run(Date.now() + HOUR);
  assert.deepEqual(roles(again), ['검수B', '작업A'], '후보이기는 하다');
  assert.equal(w.sent.length, 1, '한 시간 뒤에는 다시 보내지 않는다');
  assert.ok(again.candidates.every(c => c.notifiedAt));
  assert.match(formatReport(again).join('\n'), /이미 알린 후보\(기준 시간 안\): .*작업A/);
  w.run(Date.now() + 13 * HOUR);
  assert.equal(w.sent.length, 2, '기준 시간이 지나도 그대로면 다시 알린다');
});

test('새로 생긴 후보만 따로 알린다(이미 알린 역할은 묶음에서 빠진다)', () => {
  const w = world(); w.settle();
  w.screens['kadan-검수B'] = '\n두 시간 뒤에 나온 출력\n❯ \n';
  w.run(T1 + 2 * HOUR); // 검수B의 시계는 여기서 다시 시작한다
  w.run(Date.now()); // 작업A 13시간, 검수B 11시간
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].message, /하위 역할 1개/);
  assert.match(w.sent[0].message, /끄기: kadan stop 작업A$/m);
  w.run(Date.now() + 2 * HOUR); // 검수B도 기준을 넘겼고, 작업A는 두 시간 전에 알린 역할이다
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1].message, /끄기: kadan stop 검수B$/m);
  assert.doesNotMatch(w.sent[1].message, /kadan stop 작업A/);
});

test('전달이 불명확한 우편은 기준 시간 동안 다시 보내지 않는다. 확실히 안 간 우편은 다음 시간에 다시 보낸다', () => {
  for (const [delivery, resend] of [['unknown', 0], ['sent', 0], ['not-sent', 1]]) {
    const w = world(); w.settle();
    let calls = 0;
    const deps = {...w.deps, sendMail: () => { calls++; return {ok: false, delivery, error: '실패'}; }};
    const first = runIdleRoles({home: w.home, floor: w.floor, now: Date.now(), deps});
    assert.equal(first.mails[0].sent, false);
    runIdleRoles({home: w.home, floor: w.floor, now: Date.now() + HOUR, deps});
    assert.equal(calls - 1, resend, delivery);
  }
});

test('한 번 실행의 우편 상한: 받는 감독이 상한보다 많으면 나머지는 다음 실행으로 미룬다', () => {
  const hierarchy = {'슈퍼': '@user'}, profiles = {'감독': undefined, '작업A': undefined, '검수B': undefined};
  for (let i = 1; i <= MAX_MAILS_PER_RUN + 1; i++) { hierarchy[`감독${i}`] = '슈퍼'; hierarchy[`작업${i}`] = `감독${i}`; profiles[`감독${i}`] = 'conductor'; profiles[`작업${i}`] = 'worker'; }
  const w = world({hierarchy, profiles});
  for (const gone of ['kadan-감독', 'kadan-작업A', 'kadan-검수B']) delete w.pids[gone];
  w.settle();
  const report = w.run(Date.now());
  assert.equal(w.sent.length, MAX_MAILS_PER_RUN);
  assert.equal(report.held.length, 1);
  assert.match(formatReport(report).join('\n'), /이번에 보내지 않음 → 감독\d: 작업\d \(한 번 실행의 우편 상한 5통\)/);
  w.run(Date.now() + HOUR);
  assert.equal(w.sent.length, MAX_MAILS_PER_RUN + 1, '미룬 묶음은 다음 실행에 간다');
});

test('끄기 파일: 우편을 보내지 않고 원장도 읽지 않지만 화면 표본은 계속 쌓는다. --dry-run은 끄기 파일이 있어도 목록을 보인다', () => {
  const w = world();
  fs.writeFileSync(path.join(w.home, IDLE_ROLES_OFF), '');
  w.settle();
  let reads = 0;
  const deps = {...w.deps, readEntries: () => { reads++; return readLedger(w.home); }};
  const report = runIdleRoles({home: w.home, floor: w.floor, now: Date.now(), deps});
  assert.equal(report.off, true);
  assert.equal(report.stale, 4, '표본은 쌓였다');
  assert.equal(reads, 0);
  assert.equal(w.sent.length, 0);
  assert.equal(readIdleState(w.home).candidates, null, '후보 수는 모름으로 남는다');
  const dry = runIdleRoles({home: w.home, floor: w.floor, now: Date.now(), deps, dryRun: true});
  assert.deepEqual(roles(dry), ['검수B', '작업A']);
  assert.equal(dry.mails.length, 1);
  assert.equal(w.sent.length, 0);
  assert.match(formatReport(dry).join('\n'), /--dry-run\(보내지 않음, 상태 파일도 쓰지 않음\) · idle-roles\.off 있음/);
});

test('--dry-run: 보낼 묶음만 만들고 우편·상태 파일·원장을 쓰지 않는다', () => {
  const w = world(); w.settle();
  const before = fs.readFileSync(idleStatePath(w.home), 'utf8'), ledger = readLedger(w.home).length;
  const report = w.run(Date.now(), {dryRun: true});
  assert.equal(report.mails.length, 1);
  assert.equal(report.mails[0].sent, false);
  assert.equal(w.sent.length, 0);
  assert.equal(fs.readFileSync(idleStatePath(w.home), 'utf8'), before);
  assert.equal(readLedger(w.home).length, ledger);
  const text = formatReport(report).join('\n');
  assert.match(text, /정리 후보 2개 · --dry-run/);
  assert.match(text, /보낼 우편 → 감독 \(2개\)\n\[정리 후보\]/);
  assert.match(text, /화면은 그대로지만 후보가 아닌 역할 2개:\n {2}슈퍼 — 프로필 super/);
});

test('tmux가 아닌 바닥에서는 고르지 않는다', () => {
  const w = world(); w.floor.name = 'herdr';
  const report = w.run(Date.now());
  assert.equal(report.unsupported, 'herdr');
  assert.equal(fs.existsSync(idleStatePath(w.home)), false);
  assert.match(formatReport(report)[0], /herdr 바닥에서는 정리 후보를 고르지 않는다/);
});

test('한 시간 문: 마지막 실행에서 한 시간이 지나야 돈다. 끄기 파일이 있어도 돈다(표본)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-idle-gate-'));
  const now = Date.now();
  assert.equal(idleRolesDue(home, now), true, '처음');
  assert.equal(claimIdleRolesGate(home, now), true);
  assert.equal(claimIdleRolesGate(home, now + 60_000), false, '1분 뒤 자동 실행은 건너뛴다');
  assert.equal(idleRolesDue(home, now + SWEEP_INTERVAL_MS - 1), false);
  assert.equal(idleRolesDue(home, now + SWEEP_INTERVAL_MS), true);
  fs.writeFileSync(path.join(home, IDLE_ROLES_OFF), '');
  assert.equal(idleRolesDue(home, now + SWEEP_INTERVAL_MS), true);
  claimIdleRolesRun(home, now + 10 * HOUR);
  assert.equal(idleRolesDue(home, now), true, '시계가 뒤로 갔으면(미래 값) 다시 돈다');
});

test('한 시간 문 실행은 어떤 실패도 던지지 않고, 우편을 보냈을 때만 한 줄을 낸다', () => {
  const lines = [], warns = [];
  const io = {log: line => lines.push(line), warn: line => warns.push(line)};
  runIdleRolesGate('/x', {...io, run: () => { throw new Error('터짐'); }});
  assert.deepEqual(warns, ['정리 후보 고르기 실패: 터짐']);
  runIdleRolesGate('/x', {...io, run: () => ({mails: []})});
  assert.deepEqual(lines, []);
  runIdleRolesGate('/x', {...io, run: () => ({mails: [{to: '감독', roles: ['a', 'b'], sent: true}, {to: '슈퍼', roles: ['c'], sent: false, delivery: 'unknown'}]})});
  assert.deepEqual(lines, ['정리 후보 우편 1통: 감독(2개)']);
  assert.equal(warns.at(-1), '정리 후보 우편 실패 1통: 슈퍼(unknown)');
});

test('보낸 쪽 이름이 같은 다른 우편·다른 보낸 쪽의 같은 문구는 "이미 알림" 근거가 아니다', () => {
  const w = world(); w.settle();
  new Mailbox(w.home, '감독').send({by: '슈퍼', message: '- 작업A · 끄기: kadan stop 작업A'});
  w.run(Date.now());
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].message, /kadan stop 작업A$/m);
});

// ---- PR #405 검수 발견(F1·F2)의 회귀 ----
// 화면 표본은 감시 쪽 시험(tests/watch-status-line.test.mjs)이 쓰는 실제 화면 모양과 같다(숫자·낱말만 바꿈).
const RULE = '─'.repeat(60);
const claudeScreen = line => ['⏺ 결과를 등록했습니다.', '', line, '', RULE, '❯ ', RULE, '  ~/Dev/example', '  Claude high | ctx:10%'].join('\n');
const codexScreen = line => ['─ Worked for 17m 42s ─────────────────', '', line, '', '', '›', '', '  gpt-example medium · ~/Dev/example · main · Context 63% used'].join('\n');
const CLAUDE_BG = '✻ Cooked for 24s · done 7:41 PM · 2 shells still running';
const CODEX_BG = '  2 background terminals running · /ps to view · /stop to close';

for (const [name, screen] of [['claude', claudeScreen(CLAUDE_BG)], ['codex', codexScreen(CODEX_BG)]]) {
  test(`F1 ${name}: 백그라운드 셸 표시가 있는 화면은 13시간 그대로여도 정리 후보가 아니다(감시와 같은 판독)`, () => {
    assert.equal(backgroundMarker(screen)?.count, 2, '감시가 읽는 표시와 같은 화면이다');
    const w = world();
    w.screens['kadan-작업A'] = screen;
    w.settle();
    let reads = 0;
    const report = runIdleRoles({home: w.home, floor: w.floor, now: Date.now(),
      deps: {...w.deps, readEntries: () => { reads++; return readLedger(w.home); }}});
    assert.deepEqual(roles(report), ['검수B'], '표시가 없는 검수B만 후보다');
    assert.equal(w.sent.length, 1);
    assert.doesNotMatch(w.sent[0].message, /kadan stop 작업A/);
    assert.deepEqual(report.paused, [{role: '작업A', reason: '백그라운드 셸 2개 실행 중'}], '시계를 세지 않은 이유가 보고에 남는다');
    assert.match(formatReport(report).join('\n'), /쉼 시계를 세지 않는 역할 1개:\n {2}작업A — 백그라운드 셸 2개 실행 중/);
  });
}

test('F1: 표시가 있는 동안은 쉼 시계가 시작하지 않는다 — 표시만 있는 세션뿐이면 원장도 읽지 않고, 표시가 사라진 뒤부터 센다', () => {
  const w = world();
  for (const session of Object.keys(w.screens)) w.screens[session] = claudeScreen(CLAUDE_BG);
  w.settle();
  let reads = 0;
  const deps = {...w.deps, readEntries: () => { reads++; return readLedger(w.home); }};
  const during = runIdleRoles({home: w.home, floor: w.floor, now: Date.now(), deps});
  assert.equal(during.stale, 0);
  assert.equal(reads, 0, '표시가 있는 세션은 기준을 넘긴 세션으로 세지 않는다');
  assert.equal(during.paused.length, 4);
  // 셸이 끝나 표시가 사라졌다(끝난 턴 요약 줄만 남음). 시계는 이때부터다.
  for (const session of Object.keys(w.screens)) w.screens[session] = claudeScreen('✻ Cooked for 24s · done 7:41 PM');
  const after = runIdleRoles({home: w.home, floor: w.floor, now: Date.now() + HOUR, deps});
  assert.equal(after.stale, 0, '표시가 있던 13시간은 쉼으로 치지 않는다');
  const later = runIdleRoles({home: w.home, floor: w.floor, now: Date.now() + 14 * HOUR, deps});
  assert.deepEqual(roles(later), ['검수B', '작업A'], '표시가 사라진 뒤 기준 시간이 지나면 후보다');
});

test('F1 대조: 같은 끝난 화면에서 셸 표시만 없으면 후보다', () => {
  const w = world();
  w.screens['kadan-작업A'] = claudeScreen('✻ Cooked for 24s · done 7:41 PM');
  w.settle();
  assert.deepEqual(roles(w.run(Date.now())), ['검수B', '작업A']);
});

test('F2: 표본 뒤 마지막 확인에서 새 본문을 읽으면 후보에서 빼고 쉼 시각을 그 실행 시각으로 다시 센다', () => {
  const w = world();
  const before = claudeScreen('✻ Cooked for 24s · done 7:41 PM'), after = before.replace('결과를 등록했습니다', '방금 새 답을 끝냈습니다');
  w.screens['kadan-작업A'] = before;
  w.settle();
  let caseReads = 0;
  const baseRead = w.floor.read;
  w.floor.read = session => session !== 'kadan-작업A' ? baseRead(session) : ++caseReads === 1 ? before : after;
  const now = Date.now();
  const report = w.run(now);
  assert.equal(caseReads, 2, '표본 1번 + 마지막 확인 1번');
  assert.deepEqual(roles(report), ['검수B']);
  assert.match(skipOf(report, '작업A'), /확인하는 사이 화면이 바뀜/);
  assert.doesNotMatch(w.sent[0].message, /kadan stop 작업A/);
  assert.equal(readIdleState(w.home).sessions['kadan-작업A'].since, now, '상태 파일의 쉼 시각이 이번 실행 시각이다');
  // 그 뒤 화면이 그대로면 13시간 전이 아니라 이번 시각부터 12시간을 센다.
  w.floor.read = session => session === 'kadan-작업A' ? after : baseRead(session);
  assert.ok(!roles(w.run(now + 11 * HOUR)).includes('작업A'));
  assert.ok(roles(w.run(now + 13 * HOUR)).includes('작업A'));
});

test('F2: 마지막 확인에서 화면을 읽지 못하면 후보가 아니다', () => {
  const w = world(); w.settle();
  let caseReads = 0;
  const baseRead = w.floor.read;
  w.floor.read = session => { if (session === 'kadan-작업A' && ++caseReads > 1) throw new Error('읽기 실패'); return baseRead(session); };
  const report = w.run(Date.now());
  assert.match(skipOf(report, '작업A'), /판정 불가: 화면을 읽지 못함/);
  assert.deepEqual(roles(report), ['검수B']);
});
