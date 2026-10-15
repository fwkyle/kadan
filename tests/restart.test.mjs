import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {restartRole} from '../src/restart.mjs';
import {startDigest, resumeSecretary, checkpointSecretary} from '../src/secretary-resume.mjs';
import {ownerGenerations, isPreviousOwner} from '../src/owner-generation.mjs';
import {createMailGenerations} from '../src/mail-generation.mjs';
import {collectRoles} from '../src/watch-roles.mjs';
import {TABLE, settingsWith} from './helpers/runner-table.mjs';

const ID = '0197aaaa-1111-4222-8333-444455556666';
const CLAUDE = 'claude --model claude-haiku-5-5 --effort low --dangerously-skip-permissions';
const CODEX = 'codex -p lite --model gpt-6-sol -c model_reasoning_effort="low"';

// 가짜 바닥·가짜 프로세스로 restart 본체의 순서와 거절을 시험한다. 실제 실행기 왕복은 격리 소켓 시험(결과 문서)에서 한다.
function fixture({cmd = CLAUDE, role = 'w', cwd, profile = 'worker', files = {}, openFiles = [], held = {150: openFiles}, extraTree = [], pending = [], tmux = 'kadan-w:@3.%3'} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-restart-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-restart-user-'));
  const dir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-restart-cwd-'));
  fs.mkdirSync(path.join(homeDir, '.claude/sessions'), {recursive: true});
  fs.mkdirSync(path.join(homeDir, '.claude/projects/-x'), {recursive: true});
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(homeDir, name), JSON.stringify(value));
  const session = `kadan-${role}`;
  const entries = [{kind: 'start', floor: 'tmux', role, session, cmd, cwd: dir, panePid: '100', roleProfile: profile, by: 'boss', t: '2026-10-14T00:00:00Z'}];
  const log = [];
  let pid = '100';
  const floor = {name: 'tmux', alive: () => true, pid: () => pid,
    stop: s => log.push(['stop', s]), create: o => { log.push(['create', o]); pid = '200'; return {panePid: '200'}; }};
  const deps = {read: () => entries, record: e => { log.push(['record', e.kind]); entries.push({t: new Date().toISOString(), ...e}); },
    pendingCards: () => pending, closeWindow: () => ({}), openWindow: () => ({method: 'manual'}),
    paneInfo: () => ({panePid: '100', location: tmux}),
    // 실행기 본체(150)와 자식 도구(extraTree)를 args로 가른다. 파일은 프로세스별로 든다.
    processTree: () => [{pid: '100', ppid: '1', args: '-zsh'}, {pid: '150', ppid: '100', args: entries.findLast(e => e.kind === 'start').cmd}, ...extraTree],
    openFiles: pids => pids.flatMap(p => held[p] ?? []),
    readJson: f => JSON.parse(fs.readFileSync(f, 'utf8')), homeDir};
  const run = (flags = {}, settings = settingsWith()) => restartRole({home, role, session, flags, floor, settings, deps});
  return {home, dir, entries, log, run, session, role, deps, floor, homeDir};
}
const claudeFiles = {'.claude/sessions/150.json': {sessionId: ID, tmux: 'kadan-w:@3.%3'}, [`.claude/projects/-x/${ID}.jsonl`]: {}};

test('claude: 같은 이름·작업 폴더·옵션으로 대화 인자만 바꿔 다시 띄우고, 끄기·원장 순서가 지켜진다', () => {
  const f = fixture({files: claudeFiles});
  const receipt = f.run();
  assert.equal(receipt.conversation, ID);
  assert.deepEqual(f.log.map(([kind]) => kind), ['stop', 'record', 'create', 'record']);
  const [stop, start] = f.entries.slice(1);
  assert.equal(stop.kind, 'stop'); assert.equal(stop.restart, true);
  assert.equal(start.kind, 'start');
  assert.equal(start.cmd, `${CLAUDE} --resume ${ID}`);
  assert.equal(start.cwd, f.dir); assert.equal(start.session, 'kadan-w'); assert.equal(start.role, 'w');
  assert.equal(start.roleProfile, 'worker'); assert.equal(start.panePid, '200');
  assert.equal(start.restartOf, startDigest(f.entries[0])); assert.equal(start.restartConversation, ID);
  assert.equal(start.conversationMode, 'resume'); assert.equal(start.model, 'claude-haiku-5-5');
  assert.equal(start.forced, undefined);
});

test('세대 회귀: restart는 우편·책임·감시 발령 세대를 끊지 않고, 이름만 재사용한 새 start는 끊는다', () => {
  const f = fixture({files: claudeFiles});
  f.entries.push({kind: 'send', role: 'w', session: 'kadan-w', taskId: 'c1', t: '2026-10-14T00:01:00Z'});
  f.run();
  const control = [...f.entries.slice(0, 2), {...f.entries.at(-1), restartOf: undefined, restartConversation: undefined, conversationMode: 'new', cmd: CLAUDE}];
  for (const [entries, previous] of [[f.entries, false], [control, true]]) {
    const generations = createMailGenerations();
    entries.forEach((e, i) => generations.apply(e, i));
    assert.equal(generations.isPrevious('w', 1), previous, '우편');
    assert.equal(isPreviousOwner(ownerGenerations(entries), 'w', '2026-10-14T00:00:30Z'), previous, '책임');
  }
  const observe = entries => {
    const live = [{session: 'kadan-w', pid: '200', alive: true}];
    return collectRoles({list: () => live, read: () => 'screen'}, entries, null, null).observations.get('kadan-w');
  };
  assert.deepEqual([...observe(f.entries).completionDispatches.keys()], ['c1'], '감시 발령');
  assert.equal(observe(control).completionDispatches.size, 0, '대조군은 비워진다');
});

test('거절은 모두 기존 세션을 끄기 전에 일어난다(stop·create 호출 0)', () => {
  const cases = {
    'codex 첫 입력 전(lock만)': fixture({cmd: CODEX, openFiles: [`/h/.codex/thread-writer-locks/${ID}.lock`]}),
    'claude tmux 자리 불일치': fixture({files: {'.claude/sessions/150.json': {sessionId: ID, tmux: 'kadan-x:@9.%9'}, [`.claude/projects/-x/${ID}.jsonl`]: {}}}),
    'claude tmux 필드 없음': fixture({files: {'.claude/sessions/150.json': {sessionId: ID}, [`.claude/projects/-x/${ID}.jsonl`]: {}}}),
    'claude 대화 파일 없음': fixture({}),
    'claude 첫 입력 전(기록 미저장)': fixture({files: {'.claude/sessions/150.json': {sessionId: ID, tmux: 'kadan-w:@3.%3'}}}),
    '끝나지 않은 카드': fixture({files: claudeFiles, pending: ['card-1']}),
    'resume --continue 명령': fixture({cmd: `${CLAUDE} --continue`, files: claudeFiles}),
  };
  for (const [name, f] of Object.entries(cases)) {
    assert.throws(() => f.run(), Error, name);
    assert.deepEqual(f.log, [], name);
    assert.equal(f.entries.length, 1, name);
  }
  assert.throws(() => cases['끝나지 않은 카드'].run(), /카드-?|card-1/);
});

test('표에 칸이 없는 실행기는 미지원으로 거절한다(conversation·resume 빈 칸)', () => {
  const f = fixture({cmd: 'devin --model swe-1-6-slow --permission-mode dangerous'});
  assert.throws(() => f.run(), /conversation 미지원/);
  const g = fixture({cmd: 'omo --model p/m'});
  assert.throws(() => g.run(), /omo\)|등록되지/);
  const old = fixture({cmd: CLAUDE, files: claudeFiles});
  const spawnOnly = settingsWith({claude: {spawn: TABLE.claude.spawn}});
  assert.throws(() => old.run({}, spawnOnly), /resume 미지원/);
  assert.deepEqual([f.log, g.log, old.log], [[], [], []]);
});

test('--force: 끝나지 않은 카드가 있어도 진행하고 stop·start 기록에 forced와 목록을 남긴다', () => {
  const f = fixture({files: claudeFiles, pending: ['card-1', 'card-2']});
  const receipt = f.run({force: true});
  assert.equal(receipt.forced, true);
  const [stop, start] = f.entries.slice(1);
  assert.equal(stop.forced, true); assert.deepEqual(stop.forcedTasks, ['card-1', 'card-2']);
  assert.equal(start.forced, true); assert.deepEqual(start.forcedTasks, ['card-1', 'card-2']);
});

test('--reason: stop·start 두 사건에 다듬은 이유를 남기고, 없으면 칸 자체가 없다', () => {
  const f = fixture({files: claudeFiles});
  f.run({reason: '  모델을 바꿔서  '});
  const [stop, start] = f.entries.slice(1);
  assert.equal(stop.reason, '모델을 바꿔서'); assert.equal(start.reason, '모델을 바꿔서');
  const plain = fixture({files: claudeFiles});
  plain.run();
  const [plainStop, plainStart] = plain.entries.slice(1);
  assert.equal(plainStop.reason, undefined); assert.equal(plainStart.reason, undefined);
});

test('--expect-pid: 지금 세대와 같으면 진행하고, 다르면 끄기 전에 거절한다 — 같은 요청을 두 번내면 두 번째는 거절', () => {
  const f = fixture({files: claudeFiles});
  f.run({'expect-pid': '100'});
  assert.deepEqual(f.log.map(([kind]) => kind), ['stop', 'record', 'create', 'record']);
  // 첫 실행 뒤 원장의 최신 시작은 pane PID 200이다. 옛 화면의 세대 표시(100)로 다시내면 두 번 재시작이 되므로 거절한다.
  assert.throws(() => f.run({'expect-pid': '100'}), /세대와 다르다/);
  assert.equal(f.log.filter(([kind]) => kind === 'stop').length, 1, '두 번째 요청은 기존 세션을 끄지 않는다');
  assert.equal(f.entries.filter(e => e.kind === 'start').length, 2);
  const g = fixture({files: claudeFiles});
  assert.throws(() => g.run({'expect-pid': '999'}), /세대와 다르다/);
  assert.deepEqual(g.log, []);
  assert.equal(g.entries.length, 1);
});

test('입력 대기만(끝나지 않은 카드 없음)이면 기본으로 진행하고, 두 번째 restart는 이전 대화 인자를 갈아끼운다', () => {
  const f = fixture({files: claudeFiles});
  f.run();
  fs.writeFileSync(path.join(f.homeDir, '.claude/sessions/150.json'), JSON.stringify({sessionId: ID.replace('aaaa', 'bbbb'), tmux: 'kadan-w:@3.%3'}));
  fs.writeFileSync(path.join(f.homeDir, `.claude/projects/-x/${ID.replace('aaaa', 'bbbb')}.jsonl`), '{}');
  f.deps.paneInfo = () => ({panePid: '200', location: 'kadan-w:@3.%3'});
  f.run();
  assert.equal(f.entries.at(-1).cmd, `${CLAUDE} --resume ${ID.replace('aaaa', 'bbbb')}`);
  assert.equal(f.entries.filter(e => e.kind === 'start').length, 3);
});

test('이미 종료된 역할·죽은 pane·자기 자신·PID 불일치는 거절한다', () => {
  const stopped = fixture({files: claudeFiles}); stopped.entries.push({kind: 'stop', session: 'kadan-w'});
  assert.throws(() => stopped.run(), /이미 종료/);
  const dead = fixture({files: claudeFiles}); dead.floor.alive = () => false;
  assert.throws(() => dead.run(), /세션 없음/);
  const moved = fixture({files: claudeFiles}); moved.floor.pid = () => '999';
  assert.throws(() => moved.run(), /PID가 다르다/);
  process.env.KADAN_ROLE = 'w';
  try { assert.throws(() => fixture({files: claudeFiles}).run(), /자기 자신/); } finally { delete process.env.KADAN_ROLE; }
  for (const f of [stopped, dead, moved]) assert.deepEqual(f.log, []);
});

test('adopt처럼 갈라 연(claude --resume X --fork-session) 역할도 살아 있는 대화로 resume한다', () => {
  const f = fixture({cmd: `${CLAUDE} --resume origin --fork-session`, files: claudeFiles});
  f.run();
  assert.equal(f.entries.at(-1).cmd, `${CLAUDE} --resume ${ID}`);
  assert.equal(f.entries.at(-1).conversationMode, 'resume');
});

test('codex: 첫 입력 뒤(rollout 열림)면 resume 명령으로 다시 띄운다', () => {
  const f = fixture({cmd: CODEX, openFiles: [`/h/.codex/sessions/2026/10/14/rollout-2026-10-14T16-35-00-${ID}.jsonl`, `/h/.codex/thread-writer-locks/${ID}.lock`]});
  f.run();
  assert.equal(f.entries.at(-1).cmd, `codex -p lite --model gpt-6-sol -c model_reasoning_effort=low resume ${ID}`);
});

// ---- 비서: kadan up과 같은 체크포인트 경로 ----
function secretaryFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-secretary-restart-'));
  const transcript = path.join(home, 'rollout-exact.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({type: 'session_meta', payload: {id: 'exact-conversation', cwd: home}}) + '\n');
  const entries = [{kind: 'start', floor: 'tmux', role: '비서', session: 'kadan-비서', panePid: '20', cwd: home, roleProfile: 'secretary',
    cmd: 'codex --model test-model -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox', by: '사람'}];
  let pane = {pid: '20'};
  const calls = [];
  const floor = {name: 'tmux', alive: () => Boolean(pane), pid: () => pane?.pid,
    stop: () => { calls.push('stop'); pane = null; }, create: o => { calls.push(o); pane = {pid: '30'}; return {panePid: '30'}; }};
  const deps = {read: () => entries, record: e => entries.push(e), findTranscript: () => transcript, pendingCards: () => [],
    closeWindow: () => ({}), openWindow: () => ({method: 'manual'})};
  return {home, entries, floor, deps, calls, setPane: v => { pane = v; }};
}

test('비서: restart와 kadan up(stop 없이 사라진 뒤 복원)이 같은 필드의 start 사건을 만든다', () => {
  const a = secretaryFixture();
  checkpointSecretary({home: a.home, floor: a.floor, read: a.deps.read, findTranscript: a.deps.findTranscript});
  a.setPane(null);
  assert.equal(resumeSecretary({home: a.home, floor: a.floor, read: a.deps.read, record: a.deps.record, startNew: () => assert.fail('새 비서')}), 'restored');
  const b = secretaryFixture();
  const receipt = restartRole({home: b.home, role: '비서', session: 'kadan-비서', flags: {}, floor: b.floor, settings: null, deps: b.deps});
  assert.equal(receipt.conversation, 'exact-conversation');
  const shape = e => { const {t, panePid, secretaryResumeSource, restartOf, ...rest} = e; return rest; };
  const upStart = a.entries.filter(e => e.kind === 'start').at(-1), restartStart = b.entries.filter(e => e.kind === 'start').at(-1);
  const sameHome = e => JSON.parse(JSON.stringify(e).replaceAll(a.home, '<H>').replaceAll(b.home, '<H>'));
  assert.deepEqual(sameHome(shape(restartStart)), sameHome(shape(upStart)));
  assert.equal(b.entries.find(e => e.kind === 'stop').restart, true);
  assert.equal(restartStart.secretaryResumeSource, startDigest(b.entries[0]));
  const generations = createMailGenerations();
  b.entries.forEach((e, i) => generations.apply(e, i));
  assert.equal(generations.isPrevious('비서', 0), false);
});

test('비서: 체크포인트를 못 만들면 끄지 않고 거절하고, 끝나지 않은 카드도 막는다', () => {
  const f = secretaryFixture();
  assert.throws(() => restartRole({home: f.home, role: '비서', session: 'kadan-비서', flags: {}, floor: f.floor, settings: null,
    deps: {...f.deps, findTranscript: () => { throw new Error('비서 대화 파일을 하나로 확인하지 못했습니다.'); }}}), /하나로 확인/);
  assert.throws(() => restartRole({home: f.home, role: '비서', session: 'kadan-비서', flags: {}, floor: f.floor, settings: null,
    deps: {...f.deps, pendingCards: () => ['c9']}}), /c9/);
  assert.deepEqual(f.calls, []);
});

const ROLLOUT = id => `/h/.codex/sessions/2026/10/14/rollout-2026-10-14T16-35-00-${id}.jsonl`;
const B = '0197bbbb-1111-4222-8333-444455556666';
const PLUGIN = {pid: '160', ppid: '150', args: 'node /h/.codex/plugins/cache/x/mcp/server.mjs --stdio'};

test('대화 파일의 주인: 본체는 A lock만, 자식 도구가 B 저장 대화를 연 경우 끄기 전에 거절한다', () => {
  const f = fixture({cmd: CODEX, extraTree: [PLUGIN], held: {150: [`/h/.codex/thread-writer-locks/${ID}.lock`], 160: [ROLLOUT(B)]}});
  assert.throws(() => f.run(), /대화 파일이 없다/);
  assert.deepEqual(f.log, []);
  assert.equal(f.entries.length, 1);
});

test('대화 파일의 주인: 본체가 연 대화는 진행하고, 래퍼 아래 실제 바이너리가 연 경우도 진행한다', () => {
  const body = fixture({cmd: CODEX, extraTree: [PLUGIN], held: {150: [ROLLOUT(B)], 160: [ROLLOUT(ID)]}});
  body.run();
  assert.match(body.entries.at(-1).cmd, new RegExp(`resume ${B}$`));
  // codex 실제 트리(2026-10-14 실측): node 래퍼(.../bin/codex)가 네이티브 바이너리를 띄우고, 파일은 네이티브가 연다.
  const NATIVE = '/n/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex -p lite --model gpt-6-sol -c model_reasoning_effort=low';
  const wrapped = fixture({cmd: CODEX, held: {151: [ROLLOUT(B), `/h/.codex/thread-writer-locks/${B}.lock`]}});
  wrapped.deps.processTree = () => [{pid: '100', ppid: '1', args: 'node /n/bin/codex -p lite --model gpt-6-sol -c model_reasoning_effort=low'},
    {pid: '151', ppid: '100', args: NATIVE}, {pid: '160', ppid: '151', args: 'node /h/.codex/plugins/x/server.mjs'}];
  wrapped.run();
  assert.match(wrapped.entries.at(-1).cmd, new RegExp(`resume ${B}$`));
});

test('대화 파일의 주인: 본체 프로세스를 못 찾으면(다른 모델·다른 실행기뿐) 거절한다', () => {
  const f = fixture({cmd: CODEX, held: {150: [ROLLOUT(B)]}});
  f.deps.processTree = () => [{pid: '100', ppid: '1', args: '-zsh'}, {pid: '150', ppid: '100', args: 'codex --model other-model'}];
  assert.throws(() => f.run(), /하나의 사슬로 정할 수 없다/);
  assert.deepEqual(f.log, []);
});

test('비서: 복원 정보를 못 만들면(codex가 아닌 비서) 끄지 않고 거절한다', () => {
  const f = secretaryFixture();
  f.entries[0].cmd = 'claude --model test-model';
  assert.throws(() => restartRole({home: f.home, role: '비서', session: 'kadan-비서', flags: {}, floor: f.floor, settings: null, deps: f.deps}), /지원하지 않는다/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.entries.length, 1);
});

test('비서: --reason은 checkpoint 경로의 stop·start에도 남고, --expect-pid가 다르면 끄기 전에 거절한다', () => {
  const f = secretaryFixture();
  restartRole({home: f.home, role: '비서', session: 'kadan-비서', flags: {reason: '설정 변경'}, floor: f.floor, settings: null, deps: f.deps});
  assert.equal(f.entries.find(e => e.kind === 'stop').reason, '설정 변경');
  assert.equal(f.entries.filter(e => e.kind === 'start').at(-1).reason, '설정 변경');
  const g = secretaryFixture();
  assert.throws(() => restartRole({home: g.home, role: '비서', session: 'kadan-비서', flags: {'expect-pid': '999'}, floor: g.floor, settings: null, deps: g.deps}), /세대와 다르다/);
  assert.deepEqual(g.calls, []);
  assert.equal(g.entries.length, 1);
});

test('비서: restart 뒤에도 감시 발령·우편·책임이 이어지고, --force는 새 start에 forced를 남긴다', () => {
  const f = secretaryFixture();
  f.entries.push({kind: 'send', role: '비서', session: 'kadan-비서', taskId: 'sc1', t: '2026-10-14T00:01:00Z'});
  f.deps.pendingCards = () => ['sc1'];
  assert.throws(() => restartRole({home: f.home, role: '비서', session: 'kadan-비서', flags: {}, floor: f.floor, settings: null, deps: f.deps}), /sc1/);
  restartRole({home: f.home, role: '비서', session: 'kadan-비서', flags: {force: true}, floor: f.floor, settings: null, deps: f.deps});
  const start = f.entries.filter(e => e.kind === 'start').at(-1);
  assert.equal(start.restartOf, startDigest(f.entries[0]));
  assert.equal(start.forced, true); assert.deepEqual(start.forcedTasks, ['sc1']);
  assert.equal(f.entries.find(e => e.kind === 'stop').forced, true);
  const live = [{session: 'kadan-비서', pid: '30', alive: true}];
  const observed = collectRoles({list: () => live, read: () => 'screen'}, f.entries, null, null).observations.get('kadan-비서');
  assert.deepEqual([...observed.completionDispatches.keys()], ['sc1']);
});

const SAME = pid => ({pid, ppid: '150', args: `codex -p lite --model gpt-6-sol -c model_reasoning_effort=low`});

test('같은 실행기 하위 에이전트: 본체는 A lock만, 맞는 자식이 B rollout을 연 경우 거절한다(사슬 갈림 아님: 자식 한 개)', () => {
  const f = fixture({cmd: CODEX, extraTree: [SAME('160')], held: {150: [`/h/.codex/thread-writer-locks/${ID}.lock`], 160: [ROLLOUT(B)]}});
  assert.throws(() => f.run(), /서로 다른 대화 2개/);
  assert.deepEqual(f.log, []);
});

test('같은 실행기 하위 에이전트: 저장된 대화 하나뿐이어도 다른 ID의 lock이 보이면 거절한다', () => {
  const f = fixture({cmd: CODEX, held: {150: [ROLLOUT(B), `/h/.codex/thread-writer-locks/${ID}.lock`]}});
  assert.throws(() => f.run(), /서로 다른 대화 2개/);
  assert.deepEqual(f.log, []);
});

test('본체 사슬: 뿌리가 둘이거나 맞는 자식이 둘로 갈리면 거절한다', () => {
  const split = fixture({cmd: CODEX, extraTree: [SAME('160'), SAME('161')], held: {150: [ROLLOUT(B)]}});
  assert.throws(() => split.run(), /하나의 사슬로 정할 수 없다/);
  const twoRoots = fixture({cmd: CODEX, held: {150: [ROLLOUT(B)]}});
  twoRoots.deps.processTree = () => [{pid: '100', ppid: '1', args: '-zsh'}, {pid: '150', ppid: '100', args: SAME('x').args}, {pid: '170', ppid: '100', args: SAME('x').args}];
  assert.throws(() => twoRoots.run(), /하나의 사슬로 정할 수 없다/);
  assert.deepEqual([split.log, twoRoots.log], [[], []]);
});

test('pid-json: 뿌리 본체의 PID 파일이 없고 자식 PID의 파일만 있으면 거절한다(claude형)', () => {
  const f = fixture({files: {'.claude/sessions/160.json': {sessionId: ID, tmux: 'kadan-w:@3.%3'}, [`.claude/projects/-x/${ID}.jsonl`]: {}},
    extraTree: [{pid: '160', ppid: '150', args: CLAUDE}]});
  assert.throws(() => f.run(), /파일이 없다/);
  assert.deepEqual(f.log, []);
});

test('정상 모양: claude·agy 단일 프로세스, codex 래퍼→네이티브(대화 하나)는 진행한다', () => {
  const agy = fixture({cmd: 'agy --model gemini-3.8-flash-low --dangerously-skip-permissions', held: {150: [`/h/.gemini/antigravity-cli/conversations/${ID}.db`, `/h/.gemini/antigravity-cli/conversations/${ID}.db-wal`]}});
  const settings = settingsWith();
  agy.run({}, settings);
  assert.match(agy.entries.at(-1).cmd, new RegExp(`--conversation ${ID}$`));
  const claude = fixture({files: claudeFiles});
  claude.run();
  assert.match(claude.entries.at(-1).cmd, new RegExp(`--resume ${ID}$`));
});
