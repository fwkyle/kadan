import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runnerTemplate, fillTemplate, resumeTail, rebuildResumeCommand, findConversation, checkConversationSpec} from '../src/runner-table.mjs';
import {conversationOf} from '../src/conversation-ref.mjs';
import {launchIdentityOf} from '../src/ai-identity.mjs';
import {TABLE, settingsWith} from './helpers/runner-table.mjs';

const ID = '0197aaaa-1111-4222-8333-444455556666';
const settings = settingsWith();

test('틀 채우기: 빈 칸은 미지원으로 거절하고, 값이 없는 자리는 만들지 않는다', () => {
  assert.throws(() => runnerTemplate(settings, 'devin', 'exec'), /devin\)는 exec 미지원/);
  assert.throws(() => runnerTemplate(settings, 'zzz', 'resume'), /zzz\)는 resume 미지원/);
  assert.equal(fillTemplate('agy --model {model} --print {prompt}', {model: 'm', prompt: 'hi'}), 'agy --model m --print hi');
  assert.throws(() => fillTemplate('x --resume {conversation}', {}), /\{conversation\}/);
  assert.equal(fillTemplate('a {effort}', {}), 'a ');
});

test('resume 꼬리: spawn 뒤에 붙은 대화 인자만 돌려주고, 다른 모양은 거절한다', () => {
  assert.deepEqual(resumeTail(settings, 'claude'), ['--resume', 'KADANCONVERSATION']);
  assert.deepEqual(resumeTail(settings, 'codex'), ['resume', 'KADANCONVERSATION']);
  assert.deepEqual(resumeTail(settings, 'agy'), ['--conversation', 'KADANCONVERSATION']);
  const bad = settingsWith({x: {spawn: 'x --model {model}', resume: 'y --model {model} --resume {conversation}'}});
  assert.throws(() => resumeTail(bad, 'x'), /spawn 틀 뒤에/);
});

test('명령 재조립: 모델·강도·권한 옵션은 그대로, 대화 인자만 바뀐다(실행기 셋)', () => {
  const claude = 'claude --model claude-haiku-5-5 --effort low --dangerously-skip-permissions';
  assert.equal(rebuildResumeCommand(settings, 'claude', claude, ID), `${claude} --resume ${ID}`);
  const codex = 'codex -p lite --model "gpt-6-sol" -c model_reasoning_effort="low"';
  const rebuilt = rebuildResumeCommand(settings, 'codex', codex, ID);
  assert.equal(rebuilt, `codex -p lite --model gpt-6-sol -c model_reasoning_effort=low resume ${ID}`);
  assert.equal(rebuildResumeCommand(settings, 'agy', 'agy --model gemini-3.8-flash-low --dangerously-skip-permissions', ID),
    `agy --model gemini-3.8-flash-low --dangerously-skip-permissions --conversation ${ID}`);
  // 두 번째 restart: 이전 대화 인자를 떼고 새 ID로 바꾼다.
  const again = rebuildResumeCommand(settings, 'claude', `${claude} --resume old-id`, ID);
  assert.equal(again, `${claude} --resume ${ID}`);
  for (const [name, cmd] of [['claude', `${claude} --resume ${ID}`], ['codex', rebuilt]]) {
    assert.equal(conversationOf(cmd).conversationMode, 'resume', name);
    assert.equal(conversationOf(cmd).conversationRef, ID, name);
  }
  assert.deepEqual([launchIdentityOf(rebuilt).harness, launchIdentityOf(rebuilt).model], ['codex', 'gpt-6-sol']);
});

test('명령 재조립: 갈라 연(fork) 명령은 표의 fork 꼬리를 떼고 살아 있는 대화로 resume한다', () => {
  const adopted = 'claude --model claude-haiku-5-5 --effort low --dangerously-skip-permissions --resume origin --fork-session';
  assert.equal(rebuildResumeCommand(settings, 'claude', adopted, ID),
    `claude --model claude-haiku-5-5 --effort low --dangerously-skip-permissions --resume ${ID}`);
  const codexFork = 'codex -p lite --model gpt-6-sol -c model_reasoning_effort=low fork origin';
  assert.match(rebuildResumeCommand(settings, 'codex', codexFork, ID), / resume 0197aaaa/);
});

test('명령 재조립: 대화를 다른 방식으로 지정했거나 읽을 수 없으면 거절한다', () => {
  const noFork = settingsWith({claude: {...TABLE.claude, fork: undefined}});
  assert.throws(() => rebuildResumeCommand(noFork, 'claude', 'claude --model m --effort low --dangerously-skip-permissions --resume o --fork-session', ID), /대화 지정/);
  assert.throws(() => rebuildResumeCommand(settings, 'claude', 'claude --model m --continue', ID), /대화 지정/);
  assert.throws(() => rebuildResumeCommand(settings, 'claude', 'claude --model m && rm x', ID), /읽을 수 없다/);
  assert.throws(() => rebuildResumeCommand(settings, 'claude', 'claude --model m', 'a b; rm'), /안전하지/);
  assert.throws(() => rebuildResumeCommand(settings, 'zzz', 'zzz --model m', ID), /미지원|resume/);
});

test('conversationOf: agy --conversation·devin --resume은 같은 대화(resume), 지정이 없으면 새 대화', () => {
  assert.deepEqual(conversationOf(`agy --model m --conversation ${ID}`), {conversationMode: 'resume', conversationRef: ID});
  assert.deepEqual(conversationOf(`agy --model m --conversation=${ID}`), {conversationMode: 'resume', conversationRef: ID});
  assert.deepEqual(conversationOf('agy --model m --continue'), {conversationMode: 'resume'});
  assert.deepEqual(conversationOf('devin --model m --resume tangy-rise'), {conversationMode: 'resume', conversationRef: 'tangy-rise'});
  assert.equal(conversationOf('agy --model m').conversationMode, 'new');
  assert.equal(conversationOf('devin --model m --resume').conversationMode, 'new'); // ID 없이 고르는 화면은 대화를 정하지 않는다
  assert.equal(conversationOf("agy --model m '--conversation x'").conversationMode, 'new');
  assert.equal(launchIdentityOf('agy --model gemini-3.8-flash-low').ok, true);
});

const rollout = `/h/.codex/sessions/2026/10/14/rollout-2026-10-14T16-35-00-${ID}.jsonl`;
const lock = `/h/.codex/thread-writer-locks/${ID}.lock`;

test('open-file: 열린 대화 파일이 0개(첫 입력 전 lock만)·여러 개면 거절, 같은 ID 중복은 하나로 센다', () => {
  const spec = TABLE.codex.conversation;
  assert.throws(() => findConversation(spec, {openFiles: () => [lock, '/x/y']}), /대화 파일이 없다/);
  assert.equal(findConversation(spec, {openFiles: () => [rollout, lock, rollout]}), ID);
  const other = rollout.replace(ID, '0197bbbb-1111-4222-8333-444455556666');
  assert.throws(() => findConversation(spec, {openFiles: () => [rollout, other]}), /2개라/);
  const agy = TABLE.agy.conversation;
  assert.equal(findConversation(agy, {openFiles: () => [`/h/.gemini/antigravity-cli/conversations/${ID}.db`, `/h/.gemini/antigravity-cli/conversations/${ID}.db-wal`]}), ID);
});

function jsonFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-pid-json-'));
  fs.mkdirSync(path.join(dir, '.claude/sessions'), {recursive: true});
  for (const [pid, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, `.claude/sessions/${pid}.json`), JSON.stringify(value));
  return dir;
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const claude = TABLE.claude.conversation;

test('pid-json: 프로세스 트리의 파일에서 sessionId를 읽되 tmux 자리가 같아야 하고, 없거나 다르면 거절한다', () => {
  const homeDir = jsonFixture({200: {sessionId: ID, tmux: 'kadan-w:@3.%3'}});
  fs.mkdirSync(path.join(homeDir, '.claude/projects/-tmp'), {recursive: true});
  fs.writeFileSync(path.join(homeDir, `.claude/projects/-tmp/${ID}.jsonl`), '{}');
  const deps = {pids: ['100', '200'], readJson: read, tmuxLocation: 'kadan-w:@3.%3', homeDir};
  assert.equal(findConversation(claude, deps), ID);
  assert.throws(() => findConversation(claude, {...deps, tmuxLocation: 'kadan-other:@9.%9'}), /다른 세션의 대화/);
  assert.throws(() => findConversation(claude, {...deps, pids: ['100']}), /파일이 없다/);
});

test('pid-json: tmux 필드가 없거나 파일이 여러 개면 거절하고, 저장된 기록이 없으면 끄기 전에 거절한다', () => {
  const noTmux = jsonFixture({200: {sessionId: ID}});
  assert.throws(() => findConversation(claude, {pids: ['200'], readJson: read, tmuxLocation: 'a:@1.%1', homeDir: noTmux}), /tmux 값이/);
  const two = jsonFixture({200: {sessionId: ID, tmux: 'a:@1.%1'}, 201: {sessionId: ID, tmux: 'a:@1.%1'}});
  assert.throws(() => findConversation(claude, {pids: ['200', '201'], readJson: read, tmuxLocation: 'a:@1.%1', homeDir: two}), /2개라/);
  const unsaved = jsonFixture({200: {sessionId: ID, tmux: 'a:@1.%1'}});
  assert.throws(() => findConversation(claude, {pids: ['200'], readJson: read, tmuxLocation: 'a:@1.%1', homeDir: unsaved}), /저장되지 않았다/);
  const badId = jsonFixture({200: {sessionId: 'a b', tmux: 'a:@1.%1'}});
  assert.throws(() => findConversation(claude, {pids: ['200'], readJson: read, tmuxLocation: 'a:@1.%1', homeDir: badId}), /안전하지/);
});

test('표 검증: 모양이 틀린 conversation 칸은 저장 전에 거절한다', () => {
  assert.throws(() => checkConversationSpec({kind: 'magic'}), /kind/);
  assert.throws(() => checkConversationSpec({kind: 'open-file', pattern: 'no-group'}), /캡처 그룹/);
  assert.throws(() => checkConversationSpec({kind: 'pid-json', path: '/x/y.json', field: 'id'}), /\{pid\}/);
  assert.throws(() => checkConversationSpec({kind: 'open-file', pattern: '(a)', stored: '/x'}), /\{conversation\}/);
});

test('코드에 실행기 이름으로 갈라지는 분기가 없다(표 모듈·restart 본체)', () => {
  for (const file of ['../src/runner-table.mjs', '../src/restart.mjs', '../src/process-tree.mjs']) {
    const code = fs.readFileSync(new URL(file, import.meta.url), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /['"`](claude|codex|agy|devin|omo)['"`]/, file);
  }
});

import {initSettings, readSettings, setRunner} from '../src/runner-settings.mjs';

test('설정: 옛 설정(spawn만)은 그대로 읽히고, 표 칸은 선택이며 검증을 거쳐 저장된다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-table-settings-'));
  const records = [], record = e => records.push(e);
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [
    {id: 'codex', spawn: 'codex --model {model} -c e={effort}'},
    {id: 'claude-code', spawn: TABLE.claude.spawn, resume: TABLE.claude.resume, conversation: TABLE.claude.conversation},
  ]}));
  const value = initSettings(home, {by: 'kyle', reason: '표 옮기기', record});
  assert.equal(value.runners.codex.resume, undefined); // 옛 모양 그대로
  assert.equal(value.runners.claude.resume, TABLE.claude.resume);
  assert.deepEqual(value.runners.claude.conversation, TABLE.claude.conversation);
  const meta = revision => ({by: 'kyle', reason: '칸 채우기', revision, record});
  assert.throws(() => setRunner(home, {runner: 'codex', table: {resume: 'other --model {model} --resume {conversation}'}, ...meta(1)}), /spawn 틀 뒤에/);
  assert.throws(() => setRunner(home, {runner: 'codex', table: {resume: 'codex --model {model} -c e={effort} resume'}, ...meta(1)}), /\{conversation\}/);
  assert.throws(() => setRunner(home, {runner: 'codex', table: {exec: 'codex {bogus}'}, ...meta(1)}), /모르는 자리/);
  assert.throws(() => setRunner(home, {runner: 'codex', table: {magic: 'x'}, ...meta(1)}), /알 수 없는 칸/);
  const next = setRunner(home, {runner: 'codex', table: {resume: 'codex --model {model} -c e={effort} resume {conversation}', conversation: TABLE.codex.conversation}, ...meta(1)});
  assert.equal(next.revision, 2);
  assert.equal(readSettings(home).runners.codex.spawn, 'codex --model {model} -c e={effort}');
  // fork 틀도 저장 전에 같은 검사를 거친다(spawn 뒤에 대화 인자를 붙인 모양, {conversation} 한 번).
  assert.throws(() => setRunner(home, {runner: 'codex', table: {fork: 'other --model {model} fork {conversation}'}, ...meta(2)}), /fork 틀은 spawn 틀 뒤에/);
  assert.throws(() => setRunner(home, {runner: 'codex', table: {fork: 'codex --model {model} -c e={effort} fork'}, ...meta(2)}), /\{conversation\}/);
  const cleared = setRunner(home, {runner: 'codex', table: {resume: null}, ...meta(2)});
  assert.equal(cleared.runners.codex.resume, undefined);
  assert.throws(() => resumeTail(readSettings(home), 'codex'), /미지원/);
});
