import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptCommand, adoptPrompt, agySameConversationNotice, ADOPT_UNCHECKED_HARNESSES, detectConversation, detectForAdopt, runAdopt } from '../src/adopt.mjs';
import { findAgyConversation } from '../src/adopt-process.mjs';
import { commandWords, inspectCardSendIdentity } from '../src/ai-identity.mjs';

const ID = '158a8380-2bc4-4110-aea9-3a30417d29b5';

test('agy·omo 이어 열기 명령: 모델이 적히고 카드 전송 신원 확인을 통과한다', () => {
  const agy = adoptCommand({ harness: 'agy', id: ID, model: 'gemini-4-neon-xhigh', effort: 'high' });
  assert.equal(agy, `agy --conversation ${ID} --model gemini-4-neon-xhigh --effort high`);
  assert.equal(adoptCommand({ harness: 'agy', id: ID, model: 'gemini-4-neon-xhigh' }),
    `agy --conversation ${ID} --model gemini-4-neon-xhigh`);
  const omo = adoptCommand({ harness: 'omo', id: ID, model: 'openai/gpt-6:high' });
  assert.equal(omo, `omo --fork ${ID} --model openai/gpt-6:high`);
  for (const cmd of [agy, omo]) {
    const identity = inspectCardSendIdentity({ entries: [{ kind: 'start', session: 'kadan-r', panePid: '1', cmd }], session: 'kadan-r', currentPid: '1' });
    assert.equal(identity.ok, true, cmd);
  }
});

test('agy·omo: 모델 없음·나쁜 ID·omo의 --effort·모르는 실행기는 거절한다', () => {
  assert.throws(() => adoptCommand({ harness: 'agy', id: ID }), /--model이 필요하다/);
  assert.throws(() => adoptCommand({ harness: 'omo', id: 'x; rm -rf ~', model: 'm' }), /대화 ID/);
  assert.throws(() => adoptCommand({ harness: 'omo', id: ID, model: 'openai/gpt-6', effort: 'high' }), /omo는 --effort 대신/);
  assert.throws(() => adoptCommand({ harness: 'gemini', id: ID, model: 'm' }), /claude·codex·agy·omo 중 하나다/);
});

function fakes() {
  const calls = { start: [], send: [], log: [], inherit: [], prepare: [] };
  return {
    calls,
    deps: {
      floor: { alive: () => false, read: () => '› ' },
      sessionName: (role) => 'kadan-' + role,
      start: (argv, flags) => calls.start.push({ argv, flags }),
      send: (m) => calls.send.push(m),
      log: (line) => calls.log.push(line),
      sleep: () => {},
      // cmdAdopt가 agy·omo에 쓰는 것과 같은 꼴: 권한은 기본값, 안내 한 줄.
      inherit: (conversation) => {
        calls.inherit.push(conversation);
        return ADOPT_UNCHECKED_HARNESSES.includes(conversation.harness)
          ? { permissions: { args: [] }, unsupported: `${conversation.harness}는 권한·원본 탭을 확인할 수 없다` } : null;
      },
      prepare: (options) => { calls.prepare.push(options); return null; },
    },
  };
}

for (const [harness, model, cmd] of [
  ['agy', 'gemini-4-neon-xhigh', `agy --conversation ${ID} --model gemini-4-neon-xhigh`],
  ['omo', 'openai/gpt-6:high', `omo --fork ${ID} --model openai/gpt-6:high`],
]) {
  test(`adopt --resume --harness ${harness}: 이어 열기 명령으로 start하고, 권한 못 읽음을 한 줄 안내한다`, () => {
    const { calls, deps } = fakes();
    const out = runAdopt({ role: `감독-${harness}`, flags: { model, resume: ID, harness }, env: {}, ...deps });
    assert.equal(calls.start[0].flags.cmd, cmd);
    assert.equal(calls.start[0].flags.reason, `대화 옮기기(adopt): ${harness} ${ID}`);
    assert.ok(!/--permission-mode|approval_policy|dangerously/.test(calls.start[0].flags.cmd), '없던 권한을 붙이지 않는다');
    assert.ok(calls.log.some((l) => l.includes('권한·원본 탭을 확인할 수 없다')), '안내 한 줄');
    assert.equal(out.adoptionId, undefined, '인수 확인(원본 탭 닫기) 요청을 만들지 않는다');
    assert.equal(out.prompt, 'sent');
    assert.doesNotMatch(calls.send[0].message, /adopt accept/);
  });
}

test('adopt: agy·omo도 대화 ID가 없으면 거절하고, 모르는 실행기는 넷을 안내한다', () => {
  const { deps } = fakes();
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'm' }, env: {}, ...deps }),
    /--resume <대화ID> --harness codex\|agy\|omo/);
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'm', resume: ID, harness: 'gemini' }, env: {}, ...deps }),
    /claude·codex·agy·omo/);
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'openai/gpt-6', resume: ID, harness: 'omo', effort: 'high' }, env: {}, ...deps }),
    /omo는 --effort 대신/);
});

test('adopt: detect가 agy 대화를 알려 주면 --resume 없이도 이어 연다', () => {
  const { calls, deps } = fakes();
  runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-xhigh' }, env: {},
    detect: (env) => detectConversation(env) ?? { harness: 'agy', id: ID }, ...deps });
  assert.equal(calls.start[0].flags.cmd, `agy --conversation ${ID} --model gemini-4-neon-xhigh`);
});

test('findAgyConversation: 상위 agy가 연 presence 잠금이 정확히 하나일 때만 ID로 쓴다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-agy-home-'));
  const root = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'conversations', `${ID}.db`), '');
  const lock = id => `n${path.join(root, 'presence', `${id}.lock`)}`;
  const lsof = lines => () => ({ status: 0, stdout: ['p1', 'n/tmp/other', ...lines].join('\n') });
  const lineage = [{ pid: '5', executable: '/bin/zsh' }, { pid: '6', executable: '/opt/bin/agy' }];
  const find = (run, l = lineage) => findAgyConversation({ lineage: l, run, userHome: home });
  assert.deepEqual(find(lsof([lock(ID)])), { harness: 'agy', id: ID });
  assert.equal(find(lsof([])), null, '잠금이 없으면 모른다');
  assert.equal(find(lsof([lock(ID), lock('other-id')])), null, '둘 이상이면 고르지 않는다');
  assert.equal(find(lsof([lock('no-such-db')])), null, '대화 DB가 없으면 쓰지 않는다');
  assert.equal(find(lsof([`n${path.join(root, 'presence', 'sub', `${ID}.lock`)}`])), null, '다른 폴더의 같은 이름은 쓰지 않는다');
  assert.equal(find(() => ({ status: 1, stdout: '' })), null, 'lsof 실패');
  assert.equal(find(lsof([lock(ID)]), [{ pid: '5', executable: '/bin/zsh' }]), null, '상위에 agy가 없으면 모른다');
});

// 검수 exec-b189a814 재현: 상위 agy가 감지되는 환경에서도 지정한 실행기를 따른다.
const agyDetect = (env, harness) => detectForAdopt(env, harness, () => ({ harness: 'agy', id: ID }));

test('adopt: --harness omo인데 --resume이 없으면 상위 agy 감지가 있어도 시작 전에 거절한다', () => {
  const { calls, deps } = fakes();
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'openai/gpt-6', harness: 'omo' }, env: {}, detect: agyDetect, ...deps }),
    /--harness omo는 지금 대화 ID를 알 수 없다 — --resume/);
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'm', harness: 'codex' }, env: {}, detect: agyDetect, ...deps }),
    /--harness codex는 지금 대화 ID를 알 수 없다/);
  assert.equal(calls.start.length, 0);
  assert.equal(calls.send.length, 0);
});

test('adopt: 모르는 --harness는 --resume이 없어도 네 이름을 안내하며 거절한다', () => {
  const { calls, deps } = fakes();
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'm', harness: 'unknown' }, env: {}, detect: agyDetect, ...deps }),
    /claude·codex·agy·omo 중 하나다/);
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'm', harness: true }, env: {}, detect: agyDetect, ...deps }),
    /--harness에는 값이 필요하다/);
  assert.equal(calls.start.length, 0);
});

test('adopt: --harness agy만 주면 ID를 자동 감지하고, --harness가 없으면 Claude 환경 → agy 순서다', () => {
  let { calls, deps } = fakes();
  runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-xhigh', harness: 'agy' }, env: { CLAUDE_CODE_SESSION_ID: 'abc-1' }, detect: agyDetect, ...deps });
  assert.equal(calls.start[0].flags.cmd, `agy --conversation ${ID} --model gemini-4-neon-xhigh`, 'agy를 지정하면 Claude 환경 값을 쓰지 않는다');
  ({ calls, deps } = fakes());
  runAdopt({ role: '감독', flags: { model: 'opus' }, env: { CLAUDE_CODE_SESSION_ID: 'abc-1' }, detect: agyDetect,
    findTranscript: () => ({ ok: true }), ...deps });
  assert.match(calls.start[0].flags.cmd, /^claude --resume abc-1 /, '지정이 없으면 Claude 환경이 먼저');
  ({ calls, deps } = fakes());
  runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-xhigh' }, env: {}, detect: agyDetect, ...deps });
  assert.match(calls.start[0].flags.cmd, /^agy --conversation /, '그다음 agy');
  assert.throws(() => runAdopt({ role: '감독', flags: { model: 'opus', harness: 'claude' }, env: {}, detect: agyDetect, ...deps }),
    /옮길 대화를 모른다/, 'claude를 지정하고 Claude 환경이 아니면 agy로 넘어가지 않는다');
});

test('adopt: 값이 빠진 --effort는 실행기와 관계없이 거절한다', () => {
  const { calls, deps } = fakes();
  for (const harness of ['claude', 'codex', 'agy', 'omo']) {
    assert.throws(() => runAdopt({ role: '감독', flags: { model: 'openai/gpt-6', resume: ID, harness, effort: true }, env: {}, findTranscript: () => ({ ok: true }), ...deps }),
      /--effort에는 값이 필요하다/, harness);
  }
  assert.equal(calls.start.length, 0);
});

test('adopt 출력: agy는 같은 대화 이어 열기, 첫 안내 전송 줄에는 인수 확인 대기 표시를 넘기지 않는다', () => {
  const { calls, deps } = fakes();
  runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-xhigh', resume: ID, harness: 'agy' }, env: {}, ...deps });
  assert.ok(calls.log.some((l) => l.startsWith('같은 대화 이어 열기: agy 대화')));
  assert.ok(!calls.log.some((l) => /복제 창 생성|인수 확인 대기/.test(l)));
  assert.equal(calls.send[0].awaitingAcceptance, false);
  const omo = fakes();
  runAdopt({ role: '감독', flags: { model: 'openai/gpt-6', resume: ID, harness: 'omo' }, env: {}, ...omo.deps });
  assert.ok(omo.calls.log.some((l) => l.startsWith('복제 창 생성: omo 대화')));
});

test('adopt 첫 안내: agy만 맨 앞에 "이 창이 새 감독 창" 한 줄과 세션 이름이 들어가고 claude·codex·omo는 그대로다', () => {
  const agy = fakes();
  runAdopt({ role: '감독-agy', flags: { model: 'gemini-4-neon-xhigh', resume: ID, harness: 'agy' }, env: {}, ...agy.deps });
  const message = agy.calls.send[0].message;
  assert.ok(message.startsWith(agySameConversationNotice('kadan-감독-agy')));
  assert.match(message.split('\n')[0], /^지금 이 창\(kadan-감독-agy\)이 kadan adopt로 이어 연 새 감독 창이다/);
  assert.ok(message.endsWith(adoptPrompt('감독-agy', '@user', 'conductor', 'agy')), '나머지 안내는 그대로');
  assert.match(message, /같은 대화로 이어 열어/);
  assert.doesNotMatch(message, /복제해/, 'agy는 복제가 아니라 이어 열기다');
  for (const [harness, model] of [['codex', 'gpt-6'], ['omo', 'openai/gpt-6:high'], ['claude', 'opus']]) {
    const { calls, deps } = fakes();
    runAdopt({ role: `감독-${harness}`, flags: { model, resume: ID, harness }, env: {}, findTranscript: () => ({ ok: true }), ...deps });
    assert.equal(calls.send[0].message, adoptPrompt(`감독-${harness}`, '@user'), harness);
    assert.doesNotMatch(calls.send[0].message, /새 감독 창이다/, harness);
  }
});

// 실행기 표의 agy resume 틀(2026-11-24 [kyle]): adopt가 카단 start로 띄운 agy와 같은 권한 옵션으로 이어 연다.
const AGY_RESUME = 'agy --model {model} --dangerously-skip-permissions --conversation {conversation}';
const SPAWN = 'agy --model {model} --dangerously-skip-permissions';
const tableOf = (resume, spawn = SPAWN) => () => ({ runners: { agy: { spawn, resume } } });

test('adopt agy: 실행기 표 resume 틀(권한 옵션 포함)로 이어 열고, 강도는 뒤에 덧붙이며, 카드 전송 신원 확인을 통과한다', () => {
  const { calls, deps } = fakes();
  runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-high', resume: ID, harness: 'agy' }, env: {},
    readRunnerSettings: tableOf(AGY_RESUME), ...deps });
  const cmd = `agy --model gemini-4-neon-high --dangerously-skip-permissions --conversation ${ID}`;
  assert.equal(calls.start[0].flags.cmd, cmd);
  assert.ok(calls.log.some((l) => l.includes('실행기 표의 agy resume 틀대로')));
  const identity = inspectCardSendIdentity({ entries: [{ kind: 'start', session: 'kadan-r', panePid: '1', cmd }], session: 'kadan-r', currentPid: '1' });
  assert.equal(identity.ok, true);
  const withEffort = fakes();
  runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-high', resume: ID, harness: 'agy', effort: 'high' }, env: {},
    readRunnerSettings: tableOf(AGY_RESUME), ...withEffort.deps });
  assert.equal(withEffort.calls.start[0].flags.cmd, `${cmd} --effort high`);
});

test('adopt agy: 표의 resume 틀을 바꾸면 명령이 따라간다(adopt에 명령 모양을 따로 두지 않는다)', () => {
  const { calls, deps } = fakes();
  runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-high', resume: ID, harness: 'agy' }, env: {},
    readRunnerSettings: tableOf('agy --model {model} --yolo --conversation {conversation}', 'agy --model {model} --yolo'), ...deps });
  assert.equal(calls.start[0].flags.cmd, `agy --model gemini-4-neon-high --yolo --conversation ${ID}`);
});

test('adopt agy: 표를 못 읽거나 resume 틀이 이어 열 꼴이 아니면 기본 명령으로 열고 사실대로 한 줄 알린다', () => {
  const bad = [() => null, () => { throw new Error('손상'); }, tableOf(''), tableOf('agy --model {model}'),
    tableOf('agy --print {prompt} --model {model} --conversation {conversation}'), tableOf('sh -c {model} {conversation}'),
    tableOf('agy --conversation {conversation} --model {model}'), tableOf('agy --dangerously-skip-permissions --conversation {conversation}', 'agy --dangerously-skip-permissions')];
  for (const readRunnerSettings of bad) {
    const { calls, deps } = fakes();
    runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-high', resume: ID, harness: 'agy' }, env: {}, readRunnerSettings, ...deps });
    assert.equal(calls.start[0].flags.cmd, `agy --conversation ${ID} --model gemini-4-neon-high`);
    assert.ok(calls.log.some((l) => l.includes('권한 옵션 없는 기본 명령으로 연다')));
  }
});

test('adopt: omo·claude·codex 명령은 표를 읽어도 그대로다', () => {
  const settings = tableOf(AGY_RESUME);
  for (const [harness, model, cmd] of [
    ['omo', 'openai/gpt-6:high', `omo --fork ${ID} --model openai/gpt-6:high`],
    ['codex', 'gpt-6', `codex fork ${ID} --model gpt-6`],
    ['claude', 'opus', `claude --resume ${ID} --fork-session --model opus`],
  ]) {
    const { calls, deps } = fakes();
    runAdopt({ role: `감독-${harness}`, flags: { model, resume: ID, harness }, env: {}, findTranscript: () => ({ ok: true }),
      readRunnerSettings: settings, ...deps });
    assert.equal(calls.start[0].flags.cmd, cmd, harness);
    assert.ok(!calls.log.some((l) => l.startsWith('agy 권한')), harness);
  }
});

test('adopt --parent <역할>: 네 실행기 모두 첫 안내에 상위 자기 소개 우편 한 줄(한 번만)과 역할 이름이 들어가고, @user·기본값에는 없다', () => {
  const introduce = /상위 슈퍼-감독에게 자기 소개 우편 한 통\(목표·승인 범위·업무 키 요약\)을 kadan mail로 한 번만 보내세요/;
  for (const [harness, model] of [['claude', 'opus'], ['codex', 'gpt-6'], ['agy', 'gemini-4-neon-xhigh'], ['omo', 'openai/gpt-6:high']]) {
    const base = { role: `감독-${harness}`, env: {}, findTranscript: () => ({ ok: true }) };
    const withParent = fakes();
    runAdopt({ ...base, flags: { model, resume: ID, harness, parent: '슈퍼-감독' }, ...withParent.deps });
    assert.match(withParent.calls.send[0].message, introduce, harness);
    for (const parent of [{ parent: '@user' }, {}]) {
      const none = fakes();
      runAdopt({ ...base, flags: { model, resume: ID, harness, ...parent }, ...none.deps });
      assert.doesNotMatch(none.calls.send[0].message, /자기 소개 우편/, `${harness} ${JSON.stringify(parent)}`);
    }
  }
  assert.equal(adoptPrompt('감독', '@user').includes('자기 소개'), false);
  assert.ok(adoptPrompt('감독', '슈퍼-감독', 'conductor').endsWith('마감·사고만 보냅니다.'));
});

// PR #481 검수 재현 1: 닫는 따옴표가 빠진 틀은 표의 검사가 거절하므로 기본 명령 + 경고 한 줄로 돌아가야 하고, 그 명령은 낱말로 읽혀야 한다.
test('adopt agy: 닫는 따옴표가 빠진 resume 틀은 기본 명령 + 경고로 돌아가고 그 명령은 낱말로 읽힌다', () => {
  const { calls, deps } = fakes();
  runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-high', resume: ID, harness: 'agy' }, env: {},
    readRunnerSettings: tableOf('agy --model {model} --dangerously-skip-permissions --conversation "{conversation}'), ...deps });
  const cmd = calls.start[0].flags.cmd;
  assert.equal(cmd, `agy --conversation ${ID} --model gemini-4-neon-high`);
  assert.ok(commandWords(cmd), '낱말로 읽힌다');
  assert.equal(calls.log.filter((l) => l.includes('권한 옵션 없는 기본 명령으로 연다')).length, 1);
});

// PR #481 검수 재현 2: 틀이 모델 자리를 따옴표로 감싸도 모델 값이 그대로(따옴표 겹침 없이) 낱말로 읽혀야 한다.
test('adopt agy: 모델 자리에 따옴표가 있는 틀 + model[1m]도 인자 값이 그대로다', () => {
  for (const model of ['model[1m]', 'gemini-4-neon-high']) {
    const { calls, deps } = fakes();
    runAdopt({ role: '감독', flags: { model, resume: ID, harness: 'agy', effort: 'high' }, env: {},
      readRunnerSettings: tableOf('agy --model "{model}" --dangerously-skip-permissions --conversation {conversation}',
        'agy --model "{model}" --dangerously-skip-permissions'), ...deps });
    const words = commandWords(calls.start[0].flags.cmd);
    assert.deepEqual(words, ['agy', '--model', model, '--dangerously-skip-permissions', '--conversation', ID, '--effort', 'high'], model);
  }
  // 따옴표 없는 기본 틀도 대괄호 모델은 낱말 하나로 읽힌다.
  const { calls, deps } = fakes();
  runAdopt({ role: '감독', flags: { model: 'model[1m]', resume: ID, harness: 'agy' }, env: {}, readRunnerSettings: tableOf(AGY_RESUME), ...deps });
  assert.equal(commandWords(calls.start[0].flags.cmd)[2], 'model[1m]');
});

// PR #481 재검수: 지원하지 않는 자리({prompt}·{cwd} 등)가 있는 resume 틀은 표 검사의 임시 값(P 등)이 인자로 새지 않게 기본 명령 + 경고로 돌아간다.
test('adopt agy: resume 틀에 {prompt}·{cwd} 같은 지원 밖 자리가 있으면 기본 명령 + 경고이고 임시 값이 명령에 없다', () => {
  const cases = [
    ['agy --model {model} --dangerously-skip-permissions --conversation {conversation} {prompt}', SPAWN],
    ['agy --model {model} --dangerously-skip-permissions --conversation {conversation} --add-dir {cwd}', SPAWN],
    ['agy --model {model} --dangerously-skip-permissions --conversation {conversation} {other}', SPAWN],
    ['agy --model {model} --dangerously-skip-permissions {prompt} --conversation {conversation}', 'agy --model {model} --dangerously-skip-permissions {prompt}'],
  ];
  for (const [resume, spawn] of cases) {
    const { calls, deps } = fakes();
    runAdopt({ role: '감독', flags: { model: 'gemini-4-neon-high', resume: ID, harness: 'agy' }, env: {},
      readRunnerSettings: tableOf(resume, spawn), ...deps });
    const cmd = calls.start[0].flags.cmd;
    assert.equal(cmd, `agy --conversation ${ID} --model gemini-4-neon-high`, resume);
    assert.deepEqual(commandWords(cmd).filter((w) => w === 'P' || w === '/'), [], '임시 값 없음');
    assert.equal(calls.log.filter((l) => l.includes('쓸 수 없는 자리') && l.includes('기본 명령으로 연다')).length, 1, resume);
  }
});
