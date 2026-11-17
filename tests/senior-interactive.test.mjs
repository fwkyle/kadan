import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {seniorCommand} from '../src/senior.mjs';
import {initSettings, setRunner, setRunnerModel, setSeniors} from '../src/runner-settings.mjs';
import {CardStore} from '../src/card-store.mjs';
import {readLedger} from '../src/ledger.mjs';
import {ASK_LINE, SESSION_TIMING, listSeniorSessions, readRecord, seniorSocket, seniorTmux} from '../src/senior-session.mjs';
import {markerOf} from '../src/senior-screen.mjs';
import {runJudgeProcess} from '../src/watch-ai-process.mjs';

// `kadan senior`의 대화형 길(senior-mode interactive)을 처음부터 끝까지: 설정 → 자리 → 관문 → 감싼 프로세스 → advice·영수증.
// 진짜 codex·모델·로티·운영 tmux는 쓰지 않는다. 가짜 대화형 화면을 격리 소켓에 띄운다. MCP 이름은 모두 가짜다.
const FAKE = new URL('./helpers/fake-codex-tui.mjs', import.meta.url).pathname;
const SENIOR = new URL('../src/senior.mjs', import.meta.url).href;
const REAL_TMUX = spawnSync('which', ['tmux'], {encoding: 'utf8'}).stdout.trim();
const skip = !REAL_TMUX;
const TIMING = {...SESSION_TIMING, pollMs: 100, settleMs: 50, startupMs: 10_000, mcpMs: 2500, submitGraceMs: 1200, keyGapS: '0.2'};
const models = ['gpt-6-astra', 'gpt-6-sol'].map(slug => ({slug, supported_reasoning_levels: ['low', 'high'].map(effort => ({effort}))}));
const readCodexModels = () => ({models});
const ASTRA = {runner: 'codex', model: 'gpt-6-astra', effort: 'high'}, SOL = {runner: 'codex', model: 'gpt-6-sol', effort: 'low'};
const ARGON = {runner: 'agy', model: 'gemini-4-argon-medium'};
const BOUND = 'agy --agent kadan-noexec --model {model} --print-timeout 90s --output-format json --print {prompt}';
const digest = text => createHash('sha256').update(text).digest('hex');
let seq = 0;

function fixture(t, {seniors = [ASTRA, SOL], mode = 'interactive', plan = {}, allow = ['codex_worktrees', 'fixture-a']} = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ksi-')));
  const repo = path.join(home, 'repo'), bin = path.join(home, 'bin'), log = path.join(home, 'fake-log');
  for (const dir of [repo, bin, log]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, {mode: 0o755});
  const tmuxLog = path.join(home, 'tmux-calls.log');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${tmuxLog}'\nexec '${REAL_TMUX}' "$@"\n`, {mode: 0o755});
  const planFile = path.join(home, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify({log, default: {}, models: {}, ...plan}));
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'}]}));
  const meta = revision => ({revision, by: 'kyle', reason: '시험', record: () => {}, readCodexModels});
  initSettings(home, {by: 'kyle', reason: '시작', record: () => {}});
  setRunner(home, {runner: 'agy', spawn: 'agy --model {model}', table: {execField: 'response'}, ...meta(1)});
  setRunnerModel(home, {runner: 'agy', model: ARGON.model, efforts: '', ...meta(2)});
  setSeniors(home, {items: seniors, ...meta(3)});
  const file = path.join(home, 'runner-settings.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.runners.agy.exec = BOUND; fs.writeFileSync(file, JSON.stringify(raw));
  new CardStore(home).create({repo: 'qa', id: 'card-a', repoPath: repo, body: '# 시험 카드\n\n- DB 열 이름을 바꾼다\n'});
  if (mode != null) fs.writeFileSync(path.join(home, 'senior-mode'), `${mode}\n`);
  if (allow) fs.writeFileSync(path.join(home, 'senior-mcp-allow'), `# 시험용 가짜 이름\n${allow.join('\n')}\n`);
  // 부르는 쪽(감독 pane)의 환경처럼 역할·바깥 tmux 값을 넣어 둔다.
  const env = {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: `ki${process.pid}x${++seq}`,
    FAKE_CODEX_PLAN: planFile, KADAN_ROLE: 'qa-슈퍼감독', TMUX: '/tmp/outer-tmux,1,0', TMUX_PANE: '%9', KADAN_SENIOR_TAB: 'on'};
  const tmux = seniorTmux({socket: seniorSocket(env, home), home, env});
  t.after(() => {
    process.stderr.write(`격리 소켓 kill-server: -L ${tmux.socket}\n`);
    tmux.try(['kill-server']);
  });
  const run = (flags = {}, more = {}) => seniorCommand(['qa/card-a'], {question: '바꿀까?', ...flags},
    {home, by: 'qa-슈퍼감독', env, readCodexModels, sessionTiming: TIMING, ...more});
  const fakeLog = (model, kind) => {
    try { return fs.readFileSync(path.join(log, `${model}.${kind}`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  return {home, repo, env, tmux, run, log, tmuxLog, fakeLog, advices: () => readLedger(home).filter(e => e.kind === 'advice'),
    sessions: () => listSeniorSessions(tmux).map(row => row.name)};
}

test('기본 불변: senior-mode가 없거나 headless면 지금처럼 senior.sh를 부르고 세션을 만들지 않는다. 잘못된 값은 아무도 부르기 전에 거절한다', async t => {
  for (const mode of [null, 'headless']) {
    const f = fixture(t, {seniors: [ASTRA], mode});
    const calls = [];
    const fake = async (command, opts) => {
      calls.push(command);
      fs.writeFileSync(path.join(opts.env.KADAN_SENIOR_DIR, 'result.txt'), '결론: 헤드리스 답');
      return {status: 0, stderr: '', stdout: ''};
    };
    const r = await f.run({}, {spawn: fake});
    assert.match(calls[0], /senior\.sh'$/);
    assert.equal(r.answers[0].reason, 'ok'); assert.ok(!('mode' in r.answers[0]));
    assert.match(r.answers[0].follow, /^tail -F .*diagnostic\.log$/);
    assert.ok(!('mode' in f.advices()[0]));
    assert.equal(fs.existsSync(f.tmuxLog), false, '헤드리스 길은 시니어 소켓을 부르지 않는다');
    assert.equal(fs.existsSync(path.join(r.answers[0].evidencePath, 'session.json')), false);
  }
  const bad = fixture(t, {seniors: [ASTRA], mode: 'tui'});
  await assert.rejects(() => bad.run({}, {spawn: async () => assert.fail('부르면 안 된다')}), /senior-mode 값 오류/);
  assert.deepEqual(bad.advices(), []);
  assert.equal(fs.existsSync(path.join(bad.home, 'advice')), false);
});

test('대화형 길은 codex만: 다른 실행기가 등록돼 있으면 아무도 부르지 않고 세션도 만들지 않는다', async t => {
  const f = fixture(t, {seniors: [ASTRA, ARGON]});
  await assert.rejects(() => f.run({}, {spawn: async () => assert.fail('부르면 안 된다')}), /대화형 시니어.*codex만.*agy\/gemini-4-argon-medium/);
  assert.deepEqual(f.advices(), []);
  assert.equal(fs.existsSync(path.join(f.home, 'advice')), false);
  assert.equal(fs.existsSync(f.tmuxLog), false);
});

test('대화형 성공: 등록된 두 명에게 동시에 묻고 표지 뗀 답·advice·영수증이 같은 글을 가리킨다. 세션은 남지 않고 기본 소켓 호출은 0회다', {skip}, async t => {
  const f = fixture(t);
  const note = path.join(f.home, 'note.md'); fs.writeFileSync(note, '첨부 내용');
  const r = await f.run({file: note, timeout: '60'});
  assert.deepEqual(r.answers.map(a => [a.model, a.reason, a.status, a.mode]), [['gpt-6-astra', 'ok', 'ok', 'interactive'], ['gpt-6-sol', 'ok', 'ok', 'interactive']]);
  const advices = f.advices();
  assert.equal(advices.length, 2);
  for (const [index, a] of r.answers.entries()) {
    assert.equal(a.answer, '결론: 가짜 답이다\n근거: input.txt를 읽었다');
    const entry = advices.find(e => e.adviceId === a.adviceId);
    assert.deepEqual([entry.reason, entry.mode, entry.bytes, entry.digest, entry.tab, entry.tabReason],
      ['ok', 'interactive', Buffer.byteLength(a.answer), digest(a.answer), 'skipped', 'interactive']);
    assert.equal(fs.readFileSync(path.join(a.evidencePath, 'result.txt'), 'utf8'), a.answer);
    const record = readRecord(a.evidencePath);
    assert.equal(a.follow, `tmux -L ${f.tmux.socket} attach -r -t =${record.session}`);
    assert.match(record.session, new RegExp(`^senior-${r.askId.slice(0, 8)}-${index + 1}$`));
    // 프롬프트: 저장소 절대경로와 안내 파일 읽기를 적고, '현재 작업 폴더가 저장소' 문구는 쓰지 않는다. 완성된 끝 표지는 없다.
    const input = fs.readFileSync(path.join(a.evidencePath, 'input.txt'), 'utf8');
    assert.ok(input.includes(`그 카드의 저장소는 ${f.repo} 이다`)); assert.match(input, /안내 파일\(AGENTS\.md/);
    assert.ok(!input.includes('현재 작업 폴더가 그 카드의 저장소다'));
    assert.ok(input.includes(`--- 첨부 ${note} ---\n첨부 내용`));
    assert.ok(record.marker.startsWith('KADAN-SENIOR-END-') && !input.includes(record.marker), '완성된 표지는 input.txt에 없다');
    assert.ok(fs.readFileSync(path.join(a.evidencePath, 'out', 'result.txt'), 'utf8').includes(record.marker));
    assert.deepEqual(f.fakeLog(a.model, 'submitted'), ['/mcp', ASK_LINE]);
    assert.ok(!f.fakeLog(a.model, 'keys').join('').includes(record.marker), '화면 입력에도 완성된 표지가 없다');
    const env = JSON.parse(fs.readFileSync(path.join(f.log, `${a.model}.env.json`), 'utf8'));
    assert.deepEqual([env.KADAN_ROLE, env.TMUX, env.TMUX_PANE, env.KADAN_HOME], [null, null, null, f.home]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.evidencePath, 'outcome.json'), 'utf8')), {reason: 'ok'});
    assert.equal(fs.existsSync(path.join(a.evidencePath, 'diagnostic.log')), false);
  }
  assert.deepEqual(f.sessions(), []);
  // 원장에는 start·stop이 없다(역할이 아니다).
  assert.deepEqual(readLedger(f.home).filter(e => ['start', 'stop'].includes(e.kind)), []);
  const calls = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.length > 20);
  assert.deepEqual(calls.filter(line => !line.startsWith(`-u -L ${f.tmux.socket} -f `)), []);
});

test('관문 교차: 한 명이 관문에서 걸리면 통과한 다른 한 명에게도 질문 키가 나가지 않고 둘 다 call-failed로 남는다', {skip}, async t => {
  const f = fixture(t, {plan: {models: {'gpt-6-sol': {mcp: [['codex_worktrees', 'connected', 3], ['fixture-x', 'connected', 1]]}}}});
  const error = await f.run().then(() => assert.fail('실패해야 한다'), e => e);
  assert.equal(error.exitCode, 1);
  assert.deepEqual(error.answers.map(a => [a.model, a.reason, a.status, a.detail]), [
    ['gpt-6-astra', 'call-failed', '실패(call-failed)', 'isolation:peer-gate-failed'], ['gpt-6-sol', 'call-failed', '실패(call-failed)', 'isolation:not-allowed']]);
  assert.match(error.message, /\[codex\/gpt-6-sol\] 자문 실패\(call-failed\).*허용 목록.*밖의 MCP가 연결돼 있다: fixture-x/);
  // 둘 다 관문의 /mcp만 받았다. 질문 줄은 누구에게도 가지 않았다(모델 호출 0회).
  for (const model of ['gpt-6-astra', 'gpt-6-sol']) assert.deepEqual(f.fakeLog(model, 'submitted'), ['/mcp']);
  assert.deepEqual(f.advices().map(e => [e.model, e.reason, e.detail]).sort(), [['gpt-6-astra', 'call-failed', 'isolation:peer-gate-failed'],
    ['gpt-6-sol', 'call-failed', 'isolation:not-allowed']]);
  assert.deepEqual(f.sessions(), []);
});

test('허용 목록 파일이 없으면 거절하고 연결된 이름을 보여 준다. 한도·빈 답은 칸마다 상태로 남고 하나라도 답하면 종료 코드 0이다', {skip}, async t => {
  const none = fixture(t, {seniors: [ASTRA], allow: null});
  const refused = await none.run().then(() => assert.fail('실패해야 한다'), e => e);
  assert.match(refused.message, /MCP 허용 목록 파일이 없다: .*senior-mcp-allow — 지금 연결된 MCP: codex_worktrees, fixture-a/);
  assert.equal(fs.existsSync(path.join(none.home, 'senior-mcp-allow')), false);
  assert.deepEqual(none.fakeLog('gpt-6-astra', 'submitted'), ['/mcp']);
  const mixed = fixture(t, {plan: {models: {'gpt-6-astra': {answer: 'limit'}, 'gpt-6-sol': {answer: 'ok'}}}});
  const r = await mixed.run();
  assert.deepEqual(r.answers.map(a => [a.model, a.status, a.reason]), [['gpt-6-astra', '한도', 'limit'], ['gpt-6-sol', 'ok', 'ok']]);
  assert.ok(!('answer' in r.answers[0]));
  const empty = fixture(t, {seniors: [SOL], plan: {default: {answer: 'marker-only'}}});
  const failed = await empty.run().then(() => assert.fail('실패해야 한다'), e => e);
  assert.deepEqual(failed.answers.map(a => [a.reason, a.detail]), [['empty', 'marker-only']]);
  assert.deepEqual(empty.advices().map(e => [e.reason, e.bytes]), [['empty', 0]]);
});

test('자리가 모자라면 아무도 부르지 않고(advice 0줄) 입력이 200KB를 넘으면 준비 단계에서 거절한다', {skip}, async t => {
  const f = fixture(t);
  for (const name of ['a', 'b', 'c']) f.tmux(['new-session', '-d', '-s', `held-${name}`, 'sleep 600']);
  await assert.rejects(() => f.run(), /자리가 모자란다\(지금 3개 \+ 이번 2명 > 4\)/);
  assert.deepEqual(f.advices(), []);
  assert.deepEqual(f.sessions().sort(), ['held-a', 'held-b', 'held-c']);
  assert.equal(fs.existsSync(path.join(f.log, 'gpt-6-astra.env.json')), false);
  const big = fixture(t, {seniors: [ASTRA]});
  const files = [1, 2, 3, 4].map(n => { const file = path.join(big.home, `big-${n}.txt`); fs.writeFileSync(file, 'x'.repeat(60_000)); return file; });
  await assert.rejects(() => big.run({file: files}), /프롬프트가 너무 크다/);
  assert.equal(fs.existsSync(path.join(big.home, 'advice')), false);
});

test('TERM: 도는 중에 신호를 받으면 자기 세션을 끄고 143으로 나가며 advice에 interrupted가 남는다', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA], plan: {default: {answer: 'working-forever'}}});
  const script = path.join(f.home, 'ask.mjs');
  fs.writeFileSync(script, `import {seniorCommand} from ${JSON.stringify(SENIOR)};
const models = ${JSON.stringify(models)};
await seniorCommand(['qa/card-a'], {question: '바꿀까?', timeout: '120'}, {home: process.env.KADAN_HOME, by: 'qa-슈퍼감독',
  readCodexModels: () => ({models}), sessionTiming: ${JSON.stringify(TIMING)}});
`);
  const child = spawn(process.execPath, [script], {env: f.env, stdio: ['ignore', 'ignore', 'inherit']});
  const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({code, signal})));
  t.after(() => child.kill('SIGKILL'));
  // 질문이 들어가 가짜 화면이 일하는 중이 될 때까지 기다린다.
  for (let i = 0; i < 200 && f.fakeLog('gpt-6-astra', 'submitted').length < 2; i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(f.fakeLog('gpt-6-astra', 'submitted'), ['/mcp', ASK_LINE]);
  assert.equal(f.sessions().length, 1);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, {code: 143, signal: null});
  for (let i = 0; i < 50 && f.sessions().length; i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(f.sessions(), []);
  assert.deepEqual(f.advices().map(e => [e.reason, e.mode]), [['interrupted', 'interactive']]);
  const record = readRecord(f.advices()[0].evidencePath);
  assert.ok(record.endedAt);
  assert.ok(!fs.readFileSync(path.join(f.advices()[0].evidencePath, 'input.txt'), 'utf8').includes(markerOf(record.marker.slice(-8))));
});

test('감싼 프로세스: 호출 하나는 프로세스 하나다 — 그 프로세스가 TERM을 받으면 자기 세션을 끄고 나가며 칸은 timeout으로 남는다', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA], plan: {default: {answer: 'working-forever'}}});
  // 기존 호출 프로세스(runJudgeProcess)의 상한만 짧게 준다: 상한에 걸리면 감싼 프로세스 묶음에 TERM이 간다.
  const error = await f.run({timeout: '60'}, {spawn: (command, settings) => runJudgeProcess(command, {...settings, timeout: 2500})})
    .then(() => assert.fail('실패해야 한다'), e => e);
  assert.deepEqual(error.answers.map(a => [a.reason, a.status]), [['timeout', '실패(timeout)']]);
  const [entry] = f.advices();
  assert.equal(entry.reason, 'timeout');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(entry.evidencePath, 'outcome.json'), 'utf8')), {reason: 'interrupted', detail: 'SIGTERM'});
  assert.equal(readRecord(entry.evidencePath).endReason, 'interrupted', '세션을 끈 것은 감싼 프로세스의 신호 처리기다');
  assert.deepEqual(f.sessions(), []);
  assert.deepEqual(f.fakeLog('gpt-6-astra', 'submitted'), ['/mcp', ASK_LINE], '다시 넣지 않는다');
});
