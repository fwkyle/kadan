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
function fixture({cmd = CLAUDE, role = 'w', cwd, profile = 'worker', files = {}, openFiles = [], pending = [], tmux = 'kadan-w:@3.%3'} = {}) {
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
    paneInfo: () => ({panePid: '100', location: tmux}), pids: p => [p, '150'], openFiles: () => openFiles,
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
  const shape = e => { const {t, panePid, secretaryResumeSource, ...rest} = e; return rest; };
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
