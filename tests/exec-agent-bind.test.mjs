import '../tests/helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NOEXEC_AGENT, NOEXEC_AGENT_MD, EXEC_BINDINGS, assertExecBound, ensureAgentFile, isReadDirValue, withReadDir, withTimeout} from '../src/exec-agent.mjs';
import {initSettings, setRunner} from '../src/runner-settings.mjs';

// PR #212 검수 2라운드(F1~F6): 묶기 대상 틀은 셸이 공백 분리와 똑같이 읽는 단순 명령만 받는다. 링크를 따라 쓰지 않는다.
const GOOD = 'agy --agent kadan-noexec --model {model} --print-timeout 90s --output-format json --print {prompt}';
const bound = (exec, runner = 'agy') => assertExecBound({runners: {[runner]: {exec}}}, runner);
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('머지 뒤 운영 반영 명령의 틀은 그대로 통과한다(경로 프로그램·시간 값 바뀐 틀도)', () => {
  assert.equal(bound(GOOD), EXEC_BINDINGS.agy);
  assert.equal(bound(GOOD.replace('agy', '/usr/local/bin/agy')), EXEC_BINDINGS.agy);
  assert.equal(bound(GOOD.replace('90s', '1800s')), EXEC_BINDINGS.agy);
  assert.equal(bound(GOOD.replace('{model}', 'gemini-3.8-flash-low')), EXEC_BINDINGS.agy);
});

test('F2·F3·F4 묶기 문법을 어기는 틀은 모두 거절한다(주석·따옴표·--·중복·=·별칭·경로·--add-dir)', () => {
  const rejected = {
    '현재 운영 틀(--agent 없음)': 'agy --model {model} --print-timeout 90s --output-format json --print {prompt}',
    '주석 속 --agent': 'agy --model {model} --print {prompt} # --agent kadan-noexec',
    '따옴표 속 --agent': 'agy --model {model} --print {prompt} " x --agent kadan-noexec y "',
    '뒤쪽 --': `${GOOD} -- --agent kadan-noexec`,
    '--agent 중복': GOOD.replace('--agent kadan-noexec', '--agent kadan-noexec --agent other'),
    '--agent 다른 값': GOOD.replace('kadan-noexec', 'other'),
    '--agent= 혼합': `${GOOD} --agent=kadan-noexec`,
    '--add-dir': `${GOOD} --add-dir /FAKE/REPOSITORY`,
    '따옴표 속 시간 옵션': 'agy --agent kadan-noexec " x --print-timeout 90s y " --print-timeout 90s --print {prompt}',
    '세미콜론': `${GOOD}; touch /x`,
    '명령 치환': `${GOOD} $(id)`,
    '줄바꿈': GOOD.replace(' --model', '\n--model'),
    'NBSP 낱말 경계': GOOD.replace(' --model', ' --model'),
    '중괄호 확장 프로그램': GOOD.replace('agy', '/usr/{bin,local/bin}/agy'),
    '모르는 자리 {cwd}': GOOD.replace('{model}', '{cwd}'),
  };
  for (const [name, exec] of Object.entries(rejected)) assert.throws(() => bound(exec), /묶기 문법에 맞지 않는다/, name);
});

test('F3 등록 이름이나 대소문자를 바꿔도, 경로로 불러도 같은 문법이 적용된다', () => {
  const noAgent = 'agy --model {model} --print {prompt}';
  assert.throws(() => bound(noAgent, 'AGY'), /묶기 문법/, '등록 키 AGY');
  assert.throws(() => bound(noAgent, 'my-agent'), /묶기 문법/, '다른 등록 키여도 프로그램이 agy');
  assert.throws(() => bound('/opt/tools/AGY --model {model} --print {prompt}', 'other'), /묶기 문법/, '경로 + 대문자 프로그램');
  assert.throws(() => bound('"agy" --model {model} --print {prompt}', 'other'), /묶기 문법/, '따옴표로 감싼 프로그램');
  assert.equal(bound(GOOD, 'AGY'), EXEC_BINDINGS.agy);
  assert.equal(bound('node fake.mjs {model}', 'claude'), null, '묶기 대상이 아닌 실행기는 그대로');
});

// ---- 3라운드 N3: 판별은 등록 키 또는 첫 낱말뿐 ----
const CLAUDE_PROD = 'claude -p --model {model} --tools "" --system-prompt "You are a concise assistant." --no-session-persistence --output-format json';
test('N3 첫 낱말이 agy가 아니면 뒤 낱말에 agy가 있어도 묶기 대상이 아니다(운영 claude 틀도 통과)', () => {
  assert.equal(bound('claude --model agy --print {prompt}', 'claude'), null);
  assert.equal(bound('claude --model agy --print {prompt}', 'other'), null);
  assert.equal(bound(CLAUDE_PROD, 'claude'), null);
  assert.equal(bound('node fake.mjs agy {prompt}', 'other'), null);
  assert.throws(() => bound('agy --model agy --print {prompt}', 'other'), /묶기 문법/, '첫 낱말이 agy면 여전히 대상');
});

test('F5 시간 치환은 시간 옵션 바로 다음 낱말 하나만 바꾼다(문법을 통과한 틀에서)', () => {
  assert.equal(withTimeout(GOOD, EXEC_BINDINGS.agy, 120), GOOD.replace('90s', '120s'));
  assert.equal(withTimeout('agy --agent kadan-noexec --print {prompt}', EXEC_BINDINGS.agy, 120), 'agy --agent kadan-noexec --print {prompt}');
  const timed = withTimeout(GOOD, EXEC_BINDINGS.agy, 7);
  assert.equal(bound(timed), EXEC_BINDINGS.agy, '치환 뒤 틀도 문법을 통과한다');
  assert.throws(() => bound(withTimeout(GOOD.replace('90s', '90s " x"'), EXEC_BINDINGS.agy, 7)), /묶기 문법/);
});

// ---- F1: 링크를 따라가지 않는다 ----
function outsideFile(root, name = 'OUTSIDE') {
  const file = path.join(root, name);
  fs.writeFileSync(file, 'OUTSIDE-ORIGINAL');
  return file;
}
const read = file => fs.readFileSync(file, 'utf8');

test('F1 에이전트 경로의 네 구성요소 각각이 링크이면 던지고 밖 파일은 그대로다', () => {
  for (const part of ['.agents', 'agents', 'kadan-noexec', 'agent.md']) {
    const root = tmp('kadan-f1-'), cwd = path.join(root, 'work'), outside = path.join(root, 'outside');
    fs.mkdirSync(cwd); fs.mkdirSync(outside);
    const target = outsideFile(outside);
    if (part === 'agent.md') {
      fs.mkdirSync(path.join(cwd, '.agents/agents/kadan-noexec'), {recursive: true});
      fs.symlinkSync(target, path.join(cwd, '.agents/agents/kadan-noexec/agent.md'));
    } else {
      const upper = { '.agents': [], agents: ['.agents'], 'kadan-noexec': ['.agents', 'agents'] }[part];
      if (upper.length) fs.mkdirSync(path.join(cwd, ...upper), {recursive: true});
      fs.symlinkSync(outside, path.join(cwd, ...upper, part));
    }
    assert.throws(() => ensureAgentFile(cwd), /에이전트 파일을 둘 수 없다/, part);
    assert.equal(read(target), 'OUTSIDE-ORIGINAL', `${part}: 밖 파일은 불변`);
    assert.deepEqual(fs.readdirSync(outside).sort(), ['OUTSIDE'], `${part}: 밖 폴더에 새 파일이 없다`);
  }
});

test('F1 내용이 정확한 링크여도 던진다(내용 동일성은 경로 안전을 보장하지 않는다)', () => {
  const root = tmp('kadan-f1-same-'), cwd = path.join(root, 'work'), outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(cwd, '.agents/agents/kadan-noexec'), {recursive: true}); fs.mkdirSync(outside);
  const target = path.join(outside, 'agent.md');
  fs.writeFileSync(target, NOEXEC_AGENT_MD);
  fs.symlinkSync(target, path.join(cwd, '.agents/agents/kadan-noexec/agent.md'));
  assert.throws(() => ensureAgentFile(cwd), /에이전트 파일을 둘 수 없다/);
  assert.equal(read(target), NOEXEC_AGENT_MD);
});

test('F1 정상 경로: 한 단계씩 0700으로 만들고 정해진 내용을 쓰며, 다르면 고쳐 쓰고, 같으면 다시 쓰지 않는다', () => {
  const cwd = tmp('kadan-f1-ok-');
  const file = ensureAgentFile(cwd);
  assert.equal(read(file), NOEXEC_AGENT_MD);
  assert.equal(fs.statSync(path.join(cwd, '.agents')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, `${NOEXEC_AGENT_MD}  - run_command\n`);
  ensureAgentFile(cwd);
  assert.equal(read(file), NOEXEC_AGENT_MD);
  const before = fs.statSync(file).mtimeMs;
  ensureAgentFile(cwd);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('F1 파일 자리가 디렉터리이거나 구성요소가 일반 파일이면 던진다', () => {
  const dirCwd = tmp('kadan-f1-dir-');
  fs.mkdirSync(path.join(dirCwd, '.agents/agents/kadan-noexec/agent.md'), {recursive: true});
  assert.throws(() => ensureAgentFile(dirCwd), /에이전트 파일을 둘 수 없다/);
  const fileCwd = tmp('kadan-f1-file-');
  fs.writeFileSync(path.join(fileCwd, '.agents'), 'x');
  assert.throws(() => ensureAgentFile(fileCwd), /에이전트 파일을 둘 수 없다/);
});

// ---- 3라운드 N2: 기존 inode에 쓰지 않는다 ----
test('N2 agent.md가 밖 파일의 하드링크면 밖 파일은 그대로고 agent.md는 새 파일(nlink 1)이 된다', () => {
  for (const content of ['OUTSIDE-ORIGINAL', NOEXEC_AGENT_MD]) {
    const root = tmp('kadan-n2-'), cwd = path.join(root, 'work'), outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(cwd, '.agents/agents/kadan-noexec'), {recursive: true}); fs.mkdirSync(outside);
    const target = path.join(outside, 'OUTSIDE');
    fs.writeFileSync(target, content);
    const file = path.join(cwd, '.agents/agents/kadan-noexec/agent.md');
    fs.linkSync(target, file);
    ensureAgentFile(cwd);
    assert.equal(read(target), content, '밖 파일 불변');
    assert.equal(fs.lstatSync(target).nlink, 1, '밖 파일의 링크 수도 원래대로');
    assert.equal(read(file), NOEXEC_AGENT_MD);
    assert.equal(fs.lstatSync(file).nlink, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['agent.md'], '임시 파일이 남지 않는다');
  }
});

test('N2 새 임시 파일을 만들 수 없으면(폴더 쓰기 불가) 던진다 — 호출하는 쪽은 agy를 부르지 않는다', () => {
  const cwd = tmp('kadan-n2-nocall-');
  fs.mkdirSync(path.join(cwd, '.agents/agents/kadan-noexec'), {recursive: true});
  fs.chmodSync(path.join(cwd, '.agents/agents/kadan-noexec'), 0o500);
  try { assert.throws(() => ensureAgentFile(cwd), /에이전트 파일을 둘 수 없다/); }
  finally { fs.chmodSync(path.join(cwd, '.agents/agents/kadan-noexec'), 0o700); }
});

// ---- 저장: 그 행만 검사 ----
test('저장은 이번에 쓰는 실행기 행만 검사한다: 잘못된 agy 행은 거절, 옛 agy 행이 있어도 다른 행은 저장된다', () => {
  const home = tmp('kadan-bind-save-');
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex {model}'}]}));
  initSettings(home, {by: 'kyle', reason: '시험', record: () => {}});
  const meta = revision => ({revision, by: 'kyle', reason: '시험', record: () => {}});
  setRunner(home, {runner: 'agy', spawn: 'agy --model {model}', ...meta(1)}); // exec 칸 없음
  for (const exec of ['agy --model {model} --print {prompt}', `${GOOD} # x`, `${GOOD} --add-dir /x`])
    assert.throws(() => setRunner(home, {runner: 'agy', table: {exec}, ...meta(2)}), /묶기 문법/, exec);
  assert.throws(() => setRunner(home, {runner: 'AGY', spawn: 'agy --model {model}', table: {exec: 'agy --model {model} --print {prompt}'}, ...meta(2)}), /묶기 문법/);
  setRunner(home, {runner: 'agy', table: {exec: GOOD}, ...meta(2)});
  // 반영 전 운영 설정처럼 옛 틀(--agent 없음)을 파일에 직접 둔 뒤에도 다른 행은 저장된다.
  const file = path.join(home, 'runner-settings.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.runners.agy.exec = 'agy --model {model} --print {prompt}';
  fs.writeFileSync(file, JSON.stringify(raw));
  setRunner(home, {runner: 'other', spawn: 'other --model {model}', table: {exec: 'other {prompt}'}, ...meta(3)});
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).runners.other.exec, 'other {prompt}');
  assert.equal(NOEXEC_AGENT, 'kadan-noexec');
});

test('읽기 폴더: 코드가 덧붙인 값 하나만 받고, 저장된 틀·다른 값·중복은 거절한다', () => {
  const dir = '/FAKE/home/Dev/repo';
  const added = withReadDir(GOOD, EXEC_BINDINGS.agy, dir);
  assert.equal(added, `${GOOD} --add-dir ${dir}`);
  assert.equal(assertExecBound({runners: {agy: {exec: added}}}, 'agy', dir), EXEC_BINDINGS.agy);
  assert.throws(() => assertExecBound({runners: {agy: {exec: added}}}, 'agy'), /허용하지 않는 낱말 --add-dir/, '저장 검사(값 없이)는 거절');
  assert.throws(() => assertExecBound({runners: {agy: {exec: added}}}, 'agy', '/other'), /--add-dir 값 모양/);
  assert.throws(() => assertExecBound({runners: {agy: {exec: `${added} --add-dir ${dir}`}}}, 'agy', dir), /중복/);
  assert.throws(() => assertExecBound({runners: {agy: {exec: GOOD}}}, 'agy', dir), /--add-dir가 없다/);
});

test('읽기 폴더 값은 절대경로·허용 글자만, 아니면 덧붙이지 않는다', () => {
  for (const bad of ['rel/dir', '/a b', '/a;b', '/a$b', "/a'b", '/a/{model}', '/a/../b', '', null, undefined, '/한글'])
    assert.equal(isReadDirValue(bad), false, String(bad));
  assert.equal(isReadDirValue('/FAKE/home/Dev/my-repo_1.2'), true);
  assert.equal(withReadDir(GOOD, EXEC_BINDINGS.agy, '/a b'), GOOD);
  assert.equal(withReadDir(GOOD, {program: 'x'}, '/ok'), GOOD, 'readDirFlag가 없는 묶기는 그대로');
});

test('읽기 폴더를 덧붙이는 곳은 시니어 한 곳뿐이다(설명 AI는 cwd만 쓴다)', () => {
  const users = fs.readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.mjs'))
    .filter(f => /withReadDir/.test(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))).sort();
  assert.deepEqual(users, ['exec-agent.mjs', 'senior.mjs']);
});
