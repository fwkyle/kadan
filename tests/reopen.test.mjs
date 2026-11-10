import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reopenRole, reopenSource, canReopen} from '../src/reopen.mjs';
import {startDigest} from '../src/secretary-resume.mjs';
import {createMailGenerations} from '../src/mail-generation.mjs';
import {ownerGenerations, isPreviousOwner} from '../src/owner-generation.mjs';
import {runnerChoices} from '../src/runner-settings.mjs';
import {stopConversationFields} from '../src/role-conversation.mjs';
import {collectRoles} from '../src/watch-roles.mjs';
import {settingsWith, TABLE} from './helpers/runner-table.mjs';

// 가짜 바닥으로 reopen 본체의 순서와 거절을 시험한다. 실제 tmux·CLI 왕복은 stop-reopen-tmux.test.mjs.
const ID = '0197aaaa-1111-4222-8333-444455556666', OTHER = '0197bbbb-1111-4222-8333-444455556666';
const MODEL = 'claude-haiku-5-5';
const CLAUDE = `claude --model ${MODEL} --effort low --dangerously-skip-permissions`;

function fixture({cmd = CLAUDE, role = 'w', profile = 'worker', stop = {}, withStop = true} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-reopen-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-reopen-cwd-'));
  const session = `kadan-${role}`;
  const start = {kind: 'start', floor: 'tmux', role, session, cmd, cwd, panePid: '100', roleProfile: profile, by: 'boss',
    launchSource: 'settings', settingsPreset: 'B', compareMode: true, pickId: 'pick-1', t: '2026-11-10T00:00:00.000Z'};
  const entries = [start];
  if (withStop) entries.push({kind: 'stop', role, session, by: 'boss', conversation: ID, conversationStart: startDigest(start),
    t: '2026-11-10T01:00:00.000Z', ...stop});
  const log = [];
  let alive = false, currentPid = '200';
  const floor = {name: 'tmux', alive: () => alive, pid: () => currentPid, stop: s => { log.push(['stop', s, currentPid]); alive = false; },
    create: options => { log.push(['create', options]); alive = true; currentPid = '200'; return {panePid: '200'}; }};
  const deps = {read: () => entries, record: entry => { log.push(['record', entry.kind]); entries.push({t: '2026-11-10T02:00:00.000Z', ...entry}); },
    modelChoices: () => new Map([[MODEL, ['low']], ['gpt-6-sol', ['low']]]),
    windowPolicy: () => ({}), openWindow: input => { log.push(['window', input.cwd]); return {method: 'manual'}; },
    register: input => { log.push(['register', input.role]); return {registered: false, reason: '이미 등록됨'}; },
    pendingCards: () => [], exists: () => true, homeDir: home};
  const run = ({settings = settingsWith(), hidden = false} = {}) => reopenRole({home, role, session, floor, settings, deps, hidden});
  const created = () => log.some(([kind]) => kind === 'create');
  return {home, cwd, role, session, start, entries, log, floor, deps, run, created, setAlive: value => { alive = value; },
    setPid: value => { currentPid = value; }};
}

test('reopen은 마지막 stop의 번호로 같은 대화·작업 폴더·실행기·모델·프로필로 다시 연다', () => {
  const f = fixture();
  const result = f.run();
  assert.deepEqual(f.log.map(([kind]) => kind), ['create', 'window', 'record', 'register']);
  assert.deepEqual(f.log[0][1], {session: 'kadan-w', role: 'w', cwd: f.cwd, cmd: `${CLAUDE} --resume ${ID}`});
  const started = f.entries.at(-1);
  assert.equal(started.kind, 'start');
  assert.equal(started.cmd, `${CLAUDE} --resume ${ID}`);
  assert.equal(started.cwd, f.cwd); assert.equal(started.harness, 'claude'); assert.equal(started.model, MODEL);
  assert.equal(started.roleProfile, 'worker'); assert.equal(started.panePid, '200');
  assert.equal(started.conversationMode, 'resume'); assert.equal(started.conversationRef, ID);
  // 무엇으로 열었는지: reopen, 어느 세대·어느 stop의 번호인지.
  assert.equal(started.reopenOf, startDigest(f.start));
  assert.equal(started.reopenStopAt, '2026-11-10T01:00:00.000Z');
  assert.equal(started.reopenConversation, ID);
  assert.equal(started.restartOf, undefined, 'restart가 아니다');
  assert.deepEqual({conversation: result.conversation, harness: result.harness, model: result.model, cwd: result.cwd, window: result.window},
    {conversation: ID, harness: 'claude', model: MODEL, cwd: f.cwd, window: 'manual'});
});

test('다시 열 때 시작 안내 우편·비교 모드 예약이 생기지 않고 비교 군 정보도 새로 붙지 않는다', () => {
  const f = fixture();
  f.run();
  const added = f.entries.slice(2);
  assert.deepEqual(added.map(e => e.kind), ['start'], '원장에 더해진 것은 start 하나뿐이다(send·compare-pick 없음)');
  for (const key of ['pickId', 'compareMode', 'launchSource', 'settingsPreset']) assert.equal(added[0][key], undefined, key);
});

test('우편·책임 세대가 이어진다: reopen의 start는 세대 경계가 아니다', () => {
  const f = fixture();
  f.run();
  const mail = createMailGenerations();
  f.entries.forEach((entry, index) => mail.apply(entry, index));
  assert.equal(mail.generationOf('w'), 0);
  assert.equal(mail.isPrevious('w', 0), false, '끄기 전에 온 우편이 이전 세대로 숨지 않는다');
  assert.equal(mail.resumedAfter('w', 0), true, '이어 연 자리로 표시돼 다음 우편에 지침 전문이 다시 붙는다');
  assert.equal(isPreviousOwner(ownerGenerations(f.entries), 'w', '2026-11-10T00:30:00.000Z'), false, '끄기 전에 붙은 책임이 이어진다');
  // 대조: 같은 이름을 새 대화로 다시 쓰면 경계다.
  const control = [...f.entries.slice(0, 2), {...f.entries.at(-1), cmd: CLAUDE, conversationMode: 'new', conversationRef: undefined}];
  const fresh = createMailGenerations();
  control.forEach((entry, index) => fresh.apply(entry, index));
  assert.equal(fresh.isPrevious('w', 0), true);
});

test('감시 발령을 이어받는다: reopen이 실제로 남긴 start는 끄기 전에 받고 끝내지 않은 카드의 발령을 restart처럼 잇는다', () => {
  const observe = entries => collectRoles({list: () => [{session: 'kadan-w', pid: '200', alive: true}], read: () => 'screen'}, entries, null, null)
    .observations.get('kadan-w').completionDispatches;
  const f = fixture();
  // 끄기 전에 받은 카드(c1)가 끝나지 않은 채로 꺼졌다가 다시 열린다.
  f.entries.splice(1, 0, {kind: 'send', role: 'w', session: 'kadan-w', taskId: 'c1', t: '2026-11-10T00:30:00.000Z'});
  f.run();
  assert.deepEqual([...observe(f.entries).keys()], ['c1'], 'reopen 뒤에도 끄기 전 발령이 감시 발령으로 남는다');
  assert.equal(f.entries.at(-1).restartOf, undefined, 'restartOf를 붙여서가 아니라 reopenOf로 이어받는다');
  // 대조: 같은 resume 명령을 사람이 kadan start --cmd로 직접 연 start(reopenOf 없음)는 예전 그대로 새로 센다.
  const manual = [...f.entries.slice(0, -1), {...f.entries.at(-1), reopenOf: undefined, reopenStopAt: undefined, reopenConversation: undefined}];
  assert.equal(observe(manual).size, 0);
});

test('다시 연 역할에 미확정 카드가 있으면 그 목록을 돌려준다(명령이 stderr로 안내한다)', () => {
  const f = fixture();
  const seen = [];
  f.deps.pendingCards = (entries, role) => { seen.push([entries.length, role]); return ['card-a', 'card-b']; };
  assert.deepEqual(f.run().pending, ['card-a', 'card-b']);
  assert.deepEqual(seen, [[2, 'w']], '세션을 만들기 직전에 다시 읽은 원장으로 한 번 센다');
  assert.deepEqual(fixture().run().pending, []);
});

// 검수 F1: 기록 실패 정리는 이번 호출이 만든 세션일 때만 끈다(잠긴 규칙 4).
test('기록 실패 정리: 그사이 같은 이름으로 뜬 다른 프로세스는 끄지 않는다', () => {
  for (const replaced of [false, true, 'unknown']) {
    const f = fixture();
    f.deps.record = () => { throw new Error('injected ledger failure'); };
    f.deps.openWindow = () => {
      // 창을 여는 사이 방금 만든 프로세스(200)가 사라지고 같은 이름에 다른 프로세스(999)가 떴다.
      if (replaced === true) f.setPid('999');
      if (replaced === 'unknown') f.floor.pid = () => { throw new Error('tmux 조회 실패'); };
      return {method: 'manual'};
    };
    const killed = () => f.log.filter(([kind]) => kind === 'stop').map(([, , pid]) => pid);
    if (replaced === false) {
      assert.throws(() => f.run(), /시작 기록 실패 — 방금 만든 kadan-w을 닫았다: injected ledger failure/);
      assert.deepEqual(killed(), ['200'], '대조: 교체가 없으면 이번 호출이 만든 세션만 닫는다');
    } else {
      assert.throws(() => f.run(), /시작 기록 실패 — .*닫지 않았다.*직접 확인.*injected ledger failure/s);
      assert.deepEqual(killed(), [], '이번 호출이 만들지 않았거나 확인할 수 없는 세션은 끄지 않는다');
    }
  }
});

// 검수 F2: 확인하는 사이 새 세대가 떴다 꺼지면 옛 세대 대화로 열지 않는다.
test('세션을 만들기 직전 원장을 다시 읽어, 처음 고른 세대가 마지막 세대가 아니면 거절한다', () => {
  const newer = cwd => [
    {kind: 'start', floor: 'tmux', role: 'w', session: 'kadan-w', cmd: 'sleep 60', cwd, panePid: '300', t: '2026-11-10T01:10:00.000Z'},
    {kind: 'stop', role: 'w', session: 'kadan-w', conversationMissing: 'not-ai-runner', t: '2026-11-10T01:20:00.000Z'}];
  // (가) 사전 확인 도중 일반 start·stop으로 B세대가 생겼다 사라졌다(번호 없는 stop).
  const f = fixture();
  let reads = 0;
  const read = f.deps.read;
  f.deps.read = () => { reads++; return read(); };
  f.deps.windowPolicy = () => { f.entries.push(...newer(f.cwd)); return {}; };
  assert.throws(() => f.run(), /확인하는 사이 .*세대가 바뀌었다/);
  assert.equal(f.created(), false);
  assert.equal(reads, 2, '원장 읽기는 두 번이다(처음 고를 때·만들기 직전)');
  // (나) B세대가 같은 번호를 남기고 꺼졌어도(다른 세대의 stop) 처음 고른 세대가 아니므로 거절한다.
  const g = fixture();
  g.deps.windowPolicy = () => {
    const [start] = newer(g.cwd);
    const again = {...start, cmd: g.start.cmd};
    g.entries.push(again, {kind: 'stop', role: 'w', session: 'kadan-w', conversation: ID, conversationStart: startDigest(again), t: '2026-11-10T01:20:00.000Z'});
    return {};
  };
  assert.throws(() => g.run(), /확인하는 사이 .*세대가 바뀌었다/);
  assert.equal(g.created(), false);
  // (다) 같은 세대에 stop이 하나 더 붙은 경우(다른 stop)도 처음 고른 stop이 아니므로 거절한다.
  const h = fixture();
  h.deps.windowPolicy = () => { h.entries.push({...h.entries[1], t: '2026-11-10T01:30:00.000Z', handoverId: 'x'}); return {}; };
  assert.throws(() => h.run(), /확인하는 사이 .*세대가 바뀌었다/);
  assert.equal(h.created(), false);
  // 대조: 그 역할과 상관없는 사건이 더해진 것은 거절 사유가 아니다.
  const ok = fixture();
  ok.deps.windowPolicy = () => { ok.entries.push({kind: 'start', role: 'other', session: 'kadan-other', panePid: '9', t: '2026-11-10T01:10:00.000Z'}); return {}; };
  ok.run();
  assert.equal(ok.created(), true);
});

test('거절은 모두 세션을 만들기 전에 끝난다', async t => {
  const refused = (f, pattern, options) => {
    assert.throws(() => f.run(options), pattern);
    assert.equal(f.created(), false, '세션을 만들지 않는다');
    assert.equal(f.entries.some(e => e.reopenOf), false, '기록도 남기지 않는다');
  };
  await t.test('세션이 살아 있음', () => {
    const f = fixture(); f.setAlive(true);
    refused(f, /이미 살아 있다: kadan-w/);
  });
  await t.test('마지막 기록이 stop이 아님(카단이 끄지 않고 사라진 세션)', () => {
    refused(fixture({withStop: false}), /마지막 기록이 stop이 아니다.*claude --resume, codex resume/s);
  });
  await t.test('stop에 번호 없음: 옛 기록과 끌 때 못 찾은 기록 — 고르기 화면으로 찾는 법을 안내한다', () => {
    const old = fixture({stop: {conversation: undefined, conversationStart: undefined}});
    refused(old, new RegExp(`대화 번호가 없다\\(이 기능 이전의 기록\\)\\. cd ${old.cwd} 뒤 실행기의 이어 열기 고르기 화면.*kadan start w --cmd .* --profile worker --no-prompt`));
    refused(fixture({stop: {conversation: undefined, conversationMissing: 'timeout'}}), /끌 때 못 찾음: timeout/);
  });
  await t.test('작업 폴더가 없음(머지 뒤 지운 worktree)', () => {
    const f = fixture();
    fs.rmdirSync(f.cwd);
    refused(f, /역할 작업 폴더가 없다/);
  });
  await t.test('대화 파일이 없음(실행기 보존 기간 경과)', () => {
    const f = fixture(); f.deps.exists = () => false;
    refused(f, /저장 파일이 없다/);
  });
  await t.test('실행기·모델이 설정에 없음', () => {
    const {claude, ...withoutClaude} = TABLE;
    refused(fixture(), /등록되지 않았다/, {settings: settingsWith(withoutClaude)});
    refused(fixture(), /실행 모델 설정이 없다/, {settings: null});
    const model = fixture(); model.deps.modelChoices = () => new Map([['other-model', []]]);
    refused(model, /모델 목록에 없다/);
    const broken = fixture(); broken.deps.modelChoices = () => { throw new Error('codex 모델 목록을 읽을 수 없다'); };
    refused(broken, /모델 목록을 읽지 못해 다시 열지 않는다/);
    // 실제 목록 함수: 설정의 models에 있는 모델만 통과한다.
    const real = fixture(); real.deps.modelChoices = runnerChoices;
    refused(real, /모델 목록에 없다/, {settings: settingsWith({claude: {...TABLE.claude, models: [{model: 'another', efforts: []}]}})});
    const listed = fixture(); listed.deps.modelChoices = runnerChoices;
    listed.run({settings: settingsWith({claude: {...TABLE.claude, models: [{model: MODEL, efforts: ['low']}]}})});
    assert.equal(listed.created(), true);
  });
  await t.test('resume 틀이 없는 실행기', () => {
    const {resume, ...noResume} = TABLE.claude;
    refused(fixture(), /resume 미지원/, {settings: settingsWith({claude: noResume})});
  });
  await t.test('기반 프로세스', () => {
    for (const role of ['비서', '대시보드', '디코', 'watch']) refused(fixture({role}), /기반 프로세스다/);
  });
  await t.test('인계로 종료된 역할', () => {
    refused(fixture({stop: {handoverId: '11111111-1111-4111-8111-111111111111'}}), /인계로 종료된 역할이다/);
  });
  await t.test('다른 세대의 번호로 열지 않는다', () => {
    refused(fixture({stop: {conversationStart: 'f'.repeat(64)}}), /마지막 시작 세대의 것이 아니다/);
    // 1세대는 번호를 남기고 꺼졌고, 2세대(새 대화)는 번호 없이 꺼졌다 → 1세대 번호로 열지 않는다.
    const f = fixture();
    f.entries.push({kind: 'start', floor: 'tmux', role: 'w', session: 'kadan-w', cmd: CLAUDE, cwd: f.cwd, panePid: '300', t: '2026-11-10T01:10:00.000Z'},
      {kind: 'stop', role: 'w', session: 'kadan-w', conversationMissing: 'undetermined', t: '2026-11-10T01:20:00.000Z'});
    refused(f, /끌 때 못 찾음: undetermined/);
    // 2세대가 stop 기록 없이 사라졌다 → 앞 세대의 stop 번호를 쓰지 않는다.
    const g = fixture();
    g.entries.push({kind: 'start', floor: 'tmux', role: 'w', session: 'kadan-w', cmd: CLAUDE, cwd: g.cwd, panePid: '300', t: '2026-11-10T01:10:00.000Z'});
    refused(g, /마지막 기록이 stop이 아니다/);
  });
  await t.test('다른 역할의 주소(이름 정규화 충돌)', () => {
    const f = fixture();
    f.entries[0].role = 'w!';
    refused(f, /역할 이름 충돌/);
  });
  await t.test('창 규칙 거절(로티에서 역할 프로필 --hidden 등)', () => {
    const f = fixture();
    f.deps.windowPolicy = input => { assert.deepEqual(input, {roleProfile: 'worker', hidden: true}); throw new Error('KADAN_HIDDEN_FORBIDDEN'); };
    refused(f, /KADAN_HIDDEN_FORBIDDEN/, {hidden: true});
  });
  await t.test('확인하는 사이 같은 이름이 떠 있으면 만들지 않는다', () => {
    const f = fixture();
    let asked = 0;
    f.floor.alive = () => ++asked > 1;
    refused(f, /이미 살아 있다/);
  });
  // 명령 재조립(rebuildResumeCommand)이 거절하는 꼴은 reopen도 거절한다(restart와 같은 한계). 재조립 규칙은 여기서 바꾸지 않는다.
  await t.test('대화 지정이 둘 이상인 시작 명령은 같은 대화를 보장할 수 없어 거절한다', () => {
    refused(fixture({cmd: `${CLAUDE} --resume ${OTHER} --resume ${ID}`}), /대화 지정\(resume·fork·continue\)/);
  });
  await t.test('tmux가 아닌 바닥', () => {
    const f = fixture(); f.floor.name = 'herdr';
    refused(f, /tmux 바닥에서만/);
  });
});

test('stored 칸이 없는 실행기는 대화 파일을 확인하지 못했다고 돌려준다(거절하지 않는다)', () => {
  const CODEX = 'codex -p lite --model gpt-6-sol -c model_reasoning_effort="low"';
  const f = fixture({cmd: CODEX});
  f.deps.exists = () => assert.fail('stored 칸이 없으면 확인하지 않는다');
  const result = f.run();
  assert.equal(result.storedChecked, false);
  // 낱말을 다시 이어 붙이면서 따옴표가 정리되고, 대화형 codex에는 카단의 인라인 화면 플래그가 붙는다(restart와 같다).
  assert.equal(f.entries.at(-1).cmd, `codex -p lite --model gpt-6-sol -c model_reasoning_effort=low resume ${ID} --no-alt-screen`);
  assert.equal(fixture().run().storedChecked, true);
});

test('--hidden이면 창을 열지 않고, 창 사전 점검이 돌려준 칸은 start에 남는다', () => {
  const f = fixture();
  f.deps.windowPolicy = () => ({rottieBinSwitched: {from: null, to: '/x/rottie', reason: 'missing'}});
  const result = f.run({hidden: true});
  assert.equal(result.window, 'hidden');
  assert.equal(f.log.some(([kind]) => kind === 'window'), false);
  assert.equal(f.entries.at(-1).window, 'hidden');
  assert.deepEqual(f.entries.at(-1).rottieBinSwitched, {from: null, to: '/x/rottie', reason: 'missing'});
});

test('시작 기록을 못 남기면 방금 만든 세션만 닫고 실패한다', () => {
  const f = fixture();
  f.deps.record = () => { throw new Error('disk full'); };
  assert.throws(() => f.run(), /시작 기록 실패 — 방금 만든 kadan-w을 닫았다: disk full/);
  assert.deepEqual(f.log.map(([kind]) => kind), ['create', 'window', 'stop']);
  assert.equal(f.log.at(-1)[2], '200', '닫은 것은 이번 호출이 만든 pane이다');
});

test('껐다 열기를 되풀이해도 같은 번호 하나로 이어진다(resume 꼬리가 겹치지 않는다)', () => {
  const f = fixture();
  f.run();
  // 다시 연 세대를 또 끈다: 끄기 조회는 reopen이 남긴 start(명령 있음)를 그 세대로 본다.
  const reopened = f.entries.at(-1);
  const fields = stopConversationFields({session: f.session, entries: f.entries, floorName: 'tmux', readSettings: () => settingsWith(),
    deps: {paneInfo: () => ({panePid: '200', location: 'kadan-w:@1.%1'}),
      processTree: () => [{pid: '200', ppid: '1', args: '-zsh'}, {pid: '250', ppid: '200', args: reopened.cmd}],
      readJson: () => ({sessionId: ID, tmux: 'kadan-w:@1.%1'}), processStartedAt: () => 0, exists: () => true, homeDir: f.home}});
  // pid-json 방식은 실제 파일 시각을 본다 — 여기서는 세대 지문만 확인한다.
  assert.equal(fields.conversationStart, startDigest(reopened));
  f.entries.push({kind: 'stop', role: 'w', session: f.session, conversation: ID, conversationStart: startDigest(reopened), t: '2026-11-10T03:00:00.000Z'});
  f.setAlive(false);
  f.run();
  assert.equal(f.entries.at(-1).cmd, `${CLAUDE} --resume ${ID}`);
  assert.equal(f.entries.at(-1).reopenOf, startDigest(reopened));
});

test('adopt 꼴 시작 명령(--resume <부모 대화> --fork-session)은 끝에 있든 중간에 있든 부모 대화가 아니라 stop에 적힌 자기 대화로 연다', () => {
  const f = fixture({cmd: `${CLAUDE} --resume ${OTHER} --fork-session`});
  f.run();
  const started = f.entries.at(-1);
  assert.equal(started.cmd, `${CLAUDE} --resume ${ID}`, '표의 fork 꼬리와 같은 모양이면 떼고 자기 대화의 resume 꼬리를 붙인다');
  assert.equal(started.conversationRef, ID);
  assert.doesNotMatch(started.cmd, new RegExp(`${OTHER}|--fork-session`));
  // 명령 중간의 fork 지정도 명령 재조립이 떼어 낸다(재조립 규칙은 restart와 같은 함수다).
  const middle = fixture({cmd: `claude --resume ${OTHER} --fork-session --model ${MODEL} --effort low --dangerously-skip-permissions`});
  middle.run();
  const opened = middle.entries.at(-1);
  assert.equal(opened.conversationMode, 'resume'); assert.equal(opened.conversationRef, ID);
  assert.equal(opened.model, MODEL);
  assert.doesNotMatch(opened.cmd, new RegExp(`${OTHER}|--fork-session`));
});

test('살아 있는 세션을 다시 연 start가 끼어 있던 역할: reopenOf에는 stop 직전의 마지막 start 사건을 적고, 감시 발령이 이어진다', () => {
  const observe = entries => collectRoles({list: () => [{session: 'kadan-w', pid: '200', alive: true}], read: () => 'screen'}, entries, null, null)
    .observations.get('kadan-w').completionDispatches;
  const f = fixture();
  // 세대를 띄운 start 뒤에 같은 pane을 다시 연 start(명령 없음, 부른 쪽 작업 폴더)가 있고, 그 뒤 발령을 받고 꺼졌다.
  const reuse = {kind: 'start', floor: 'tmux', role: 'w', session: 'kadan-w', cwd: '/somewhere/else', panePid: '100', by: 'boss', t: '2026-11-10T00:10:00.000Z'};
  f.entries.splice(1, 0, reuse, {kind: 'send', role: 'w', session: 'kadan-w', taskId: 'c1', t: '2026-11-10T00:30:00.000Z'});
  f.run();
  const started = f.entries.at(-1);
  assert.equal(started.reopenOf, startDigest(reuse), '감시기가 보는 것과 같은 사건(그 세션의 마지막 start)이다');
  assert.notEqual(started.reopenOf, startDigest(f.start));
  assert.equal(f.entries.find(e => e.kind === 'stop').conversationStart, startDigest(f.start), '세대를 띄운 start의 지문은 stop에 있다');
  assert.equal(started.cwd, f.cwd, '작업 폴더·명령은 세대를 띄운 start의 것이다');
  assert.equal(started.cmd, `${CLAUDE} --resume ${ID}`);
  assert.deepEqual([...observe(f.entries).keys()], ['c1']);
});

test('restart가 끄고 새 세션을 못 만든 경우(stop만 남음)도 그 stop의 번호로 다시 연다', () => {
  const f = fixture({stop: {restart: true}});
  f.run();
  assert.equal(f.entries.at(-1).reopenConversation, ID);
});

test('reopenSource·canReopen: 우편 안내가 쓰는 판정은 원장 배열만 본다', () => {
  const f = fixture();
  assert.equal(reopenSource(f.entries, f.session, f.role).conversation, ID);
  assert.equal(canReopen(f.entries, f.session, f.role), true);
  assert.equal(canReopen(fixture({stop: {conversation: undefined}}).entries, 'kadan-w', 'w'), false);
  assert.equal(canReopen(fixture({withStop: false}).entries, 'kadan-w', 'w'), false);
  assert.equal(canReopen([], 'kadan-none', 'none'), false);
  assert.equal(canReopen(fixture({role: '비서'}).entries, 'kadan-비서', '비서'), false);
  assert.notEqual(OTHER, ID);
});
