import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {seniorCommand} from '../src/senior.mjs';
import {initSettings, setRunner, setRunnerModel, setSeniors} from '../src/runner-settings.mjs';
import {CardStore} from '../src/card-store.mjs';
import {readLedger} from '../src/ledger.mjs';
import {ASK_LINE, SESSION_TIMING, listSeniorSessions, readRecord, seniorSocket, seniorTmux} from '../src/senior-session.mjs';
import {AGY_WORKDIR, agyAskLine} from '../src/senior-agy.mjs';
import {runJudgeProcess} from '../src/watch-ai-process.mjs';

// `kadan senior`의 agy 대화창 길을 처음부터 끝까지(설계 2026-11-18 v2.1): 설정 → 자리(고정 작업 폴더) → 관문(신뢰 창) → 감싼 프로세스 → advice·영수증.
// 진짜 agy·codex·모델·로티·운영 tmux는 쓰지 않는다. 가짜 대화창 화면 둘(codex·agy)을 격리 소켓에 띄운다.
const FAKE_CODEX = new URL('./helpers/fake-codex-tui.mjs', import.meta.url).pathname;
const FAKE_AGY = new URL('./helpers/fake-agy-tui.mjs', import.meta.url).pathname;
const REAL_TMUX = spawnSync('which', ['tmux'], {encoding: 'utf8'}).stdout.trim();
const skip = !REAL_TMUX;
const TIMING = {...SESSION_TIMING, pollMs: 100, settleMs: 50, startupMs: 30_000, submitGraceMs: 4000, keyGapS: '0.3'};
const models = ['gpt-6-astra', 'gpt-6-sol'].map(slug => ({slug, supported_reasoning_levels: ['low', 'high'].map(effort => ({effort}))}));
const readCodexModels = () => ({models});
const ASTRA = {runner: 'codex', model: 'gpt-6-astra', effort: 'high'};
const ARGON = {runner: 'agy', model: 'gemini-fake-argon-medium'}, HELIUM = {runner: 'agy', model: 'gemini-fake-helium-high'};
// 설명 AI용 헤드리스 틀이 실행기 표에 있어도 시니어는 쓰지 않는다.
const BOUND = 'agy --agent kadan-noexec --model {model} --print-timeout 90s --output-format json --print {prompt}';
const AGY_ANSWER = '결론: 가짜 답이다\n근거: 질문 파일을 읽었다';
const CODEX_ANSWER = '결론: 가짜 답이다\n근거: input.txt를 읽었다';
const digest = text => createHash('sha256').update(text).digest('hex');
let seq = 0;

function fixture(t, {seniors = [ARGON], mode = null, agy = {}, codex = {}, git = false} = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-')));
  const repo = path.join(home, 'repo'), bin = path.join(home, 'bin'), log = path.join(home, 'fake-log');
  for (const dir of [repo, bin, log]) fs.mkdirSync(dir);
  if (git) execFileSync('git', ['-C', repo, 'init', '-q']);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX}' "$@"\n`, {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'agy'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_AGY}' "$@"\n`, {mode: 0o755});
  const tmuxLog = path.join(home, 'tmux-calls.log');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${tmuxLog}'\nexec '${REAL_TMUX}' "$@"\n`, {mode: 0o755});
  const agyPlan = path.join(home, 'agy-plan.json'), codexPlan = path.join(home, 'codex-plan.json');
  fs.writeFileSync(agyPlan, JSON.stringify({log, default: {}, models: {}, ...agy}));
  fs.writeFileSync(codexPlan, JSON.stringify({log, default: {}, models: {}, ...codex}));
  fs.writeFileSync(path.join(home, 'agent-runners.json'), JSON.stringify({runners: [{id: 'codex', spawn: 'codex --model {model} -c model_reasoning_effort="{effort}"'}]}));
  const meta = revision => ({revision, by: 'kyle', reason: '시험', record: () => {}, readCodexModels});
  initSettings(home, {by: 'kyle', reason: '시작', record: () => {}});
  setRunner(home, {runner: 'agy', spawn: 'agy --model {model}', table: {execField: 'response'}, ...meta(1)});
  setRunnerModel(home, {runner: 'agy', model: ARGON.model, efforts: '', ...meta(2)});
  setRunnerModel(home, {runner: 'agy', model: HELIUM.model, efforts: '', ...meta(3)});
  setSeniors(home, {items: seniors, ...meta(4)});
  const file = path.join(home, 'runner-settings.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.runners.agy.exec = BOUND; fs.writeFileSync(file, JSON.stringify(raw));
  new CardStore(home).create({repo: 'qa', id: 'card-a', repoPath: repo, body: '# 시험 카드\n\n- DB 열 이름을 바꾼다\n'});
  if (mode != null) fs.writeFileSync(path.join(home, 'senior-mode'), `${mode}\n`);
  const env = {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: `kc${process.pid}x${++seq}`,
    FAKE_AGY_PLAN: agyPlan, FAKE_CODEX_PLAN: codexPlan, KADAN_ROLE: 'qa-슈퍼감독', TMUX: '/tmp/outer-tmux,1,0', TMUX_PANE: '%9', KADAN_SENIOR_TAB: 'on'};
  const tmux = seniorTmux({socket: seniorSocket(env, home), home, env});
  t.after(() => {
    process.stderr.write(`격리 소켓 kill-server: -L ${tmux.socket}\n`);
    tmux.try(['kill-server']);
  });
  // 호출 프로세스로 넘어가는 명령을 모두 적는다: 대화형 길에서는 감싼 프로세스(senior-session-run.mjs)뿐이어야 한다.
  const commands = [];
  const spawn = (command, settings) => { commands.push(command); return runJudgeProcess(command, settings); };
  const run = (flags = {}, more = {}) => seniorCommand(['qa/card-a'], {question: '바꿀까?', ...flags},
    {home, by: 'qa-슈퍼감독', env, readCodexModels, sessionTiming: TIMING, spawn, ...more});
  const fakeLog = (model, kind) => {
    try { return fs.readFileSync(path.join(log, `${model}.${kind}`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  const workdir = path.join(home, AGY_WORKDIR);
  return {home, repo, env, tmux, run, log, tmuxLog, fakeLog, commands, workdir,
    // 원장 줄은 끝난 순서로 쌓인다. 견줄 때는 자리 순서(같은 질문 안)로 본다.
    advices: () => readLedger(home).filter(e => e.kind === 'advice').sort((a, b) => a.t.localeCompare(b.t) || a.seniorIndex - b.seniorIndex),
    sessions: () => listSeniorSessions(tmux).map(row => row.name),
    asks: () => { try { return fs.readdirSync(path.join(workdir, 'asks')); } catch { return []; } },
    dump: model => JSON.parse(fs.readFileSync(path.join(log, `${model}.env.json`), 'utf8'))};
}

test('agy 대화창(모드 파일 없음 = 대화형): 고정 작업 폴더의 신뢰 창을 한 번 지나 화면의 답을 받고, advice·영수증·증거가 같은 글을 가리킨다. 헤드리스 호출은 0회다', {skip}, async t => {
  const f = fixture(t, {git: true});
  const r = await f.run({timeout: '60'});
  const [a] = r.answers;
  assert.deepEqual([a.runner, a.model, a.reason, a.status, a.mode, a.answer], ['agy', ARGON.model, 'ok', 'ok', 'interactive', AGY_ANSWER]);
  // 첫 호출: 신뢰 창을 지난 사실과 그 경로를 영수증에 알린다.
  assert.match(a.note, new RegExp(`agy 폴더 신뢰 창을 Enter 한 번으로 지났다\\(${f.workdir}\\)`));
  const [entry] = f.advices();
  assert.deepEqual([entry.reason, entry.mode, entry.runner, entry.model, entry.bytes, entry.digest],
    ['ok', 'interactive', 'agy', ARGON.model, Buffer.byteLength(AGY_ANSWER), digest(AGY_ANSWER)]);
  assert.equal(fs.readFileSync(path.join(a.evidencePath, 'result.txt'), 'utf8'), AGY_ANSWER);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.evidencePath, 'outcome.json'), 'utf8')), {reason: 'ok'});
  const record = readRecord(a.evidencePath);
  assert.equal(record.runner, 'agy'); assert.equal(record.workdir, f.workdir);
  assert.equal(a.follow, `tmux -L ${f.tmux.socket} attach -r -t '=${record.session}'`);
  // 화면에는 질문 파일을 가리키는 한 줄만 들어갔고, 질문 파일은 호출 끝에 지워졌다(같은 글이 증거 폴더 input.txt에 남는다).
  assert.deepEqual(f.fakeLog(ARGON.model, 'submitted'), [agyAskLine(record.askFile)]);
  assert.equal(record.askFile, path.join(f.workdir, 'asks', `${r.askId}-1.txt`));
  assert.deepEqual(f.asks(), []);
  const input = fs.readFileSync(path.join(a.evidencePath, 'input.txt'), 'utf8');
  assert.match(input, /답은 파일로 쓰지 않고 이 대화의 답으로 화면에 쓴다/);
  assert.ok(input.includes(`읽기 전용 폴더로 열려 있다: ${f.repo}`));
  assert.ok(!input.includes('result.txt') && !input.includes(record.marker), '완성된 표지와 답 파일 지시는 없다');
  assert.ok(!f.fakeLog(ARGON.model, 'keys').join('').includes(record.marker), '화면 입력에도 완성된 표지가 없다');
  // 실행 꼴: 대화창 + 도구 없는 에이전트 + 저장소 읽기 폴더. 강도·헤드리스 옵션은 없다. 역할·바깥 tmux 값은 새지 않는다.
  const dump = f.dump(ARGON.model);
  assert.deepEqual(dump.argv, ['--model', ARGON.model, '--agent', 'kadan-noexec', '--add-dir', f.repo]);
  assert.equal(dump.cwd, f.workdir);
  assert.deepEqual([dump.KADAN_ROLE, dump.TMUX, dump.TMUX_PANE], [null, null, null]);
  assert.equal(fs.existsSync(path.join(f.repo, '.agents')), false, '저장소에는 에이전트 파일을 두지 않는다');
  // 헤드리스 호출 0회: 호출 프로세스로 간 명령은 감싼 프로세스 하나뿐이다(senior.sh·agy 틀 없음).
  assert.equal(f.commands.length, 1);
  assert.match(f.commands[0], /senior-session-run\.mjs' ask /);
  assert.ok(!f.commands.some(command => /senior\.sh|--print|^agy/u.test(command)));
  assert.deepEqual(f.sessions(), []);
  assert.deepEqual(readLedger(f.home).filter(e => ['start', 'stop', 'trust'].includes(e.kind)), [], '역할이 아니다: 원장에 start·stop·trust 없음');
  // 둘째 호출: 신뢰 창이 없어 알림도 없다. --effort는 agy에 넘기지 않고 무시한 사실을 알린다.
  const again = await f.run({timeout: '60', effort: 'low'});
  assert.equal(again.answers[0].reason, 'ok');
  assert.equal(again.answers[0].note, '--effort는 agy에 넘기지 않아 무시했다(강도는 모델 이름이 정한다)');
  assert.ok(!f.dump(ARGON.model).argv.includes('--effort'));
  assert.deepEqual(f.fakeLog(ARGON.model, 'trust-enter').length, 1, '신뢰 창 Enter는 첫 호출의 한 번뿐이다');
  const calls = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(calls.filter(line => !line.startsWith(`-u -L ${f.tmux.socket} -f `)), []);
});

test('저장소가 git 최상위가 아니면 --add-dir 없이 띄우고 카드 본문·첨부만 근거로 답하게 한다', {skip}, async t => {
  const f = fixture(t, {agy: {default: {startup: 'composer'}}});
  const r = await f.run({timeout: '60'});
  assert.equal(r.answers[0].reason, 'ok');
  assert.deepEqual(f.dump(ARGON.model).argv, ['--model', ARGON.model, '--agent', 'kadan-noexec']);
  const input = fs.readFileSync(path.join(r.answers[0].evidencePath, 'input.txt'), 'utf8');
  assert.match(input, /저장소를 직접 읽을 수 없다/); assert.ok(!input.includes('읽기 전용 폴더로 열려 있다'));
});

test('혼합 등록(codex + agy) 정상: 두 칸 모두 답하고 각자 자기 방식(답 파일·화면)으로 회수한다. --model로 한 명만 고를 수 있다', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA, ARGON]});
  const r = await f.run({timeout: '60'});
  assert.deepEqual(r.answers.map(a => [a.runner, a.model, a.reason, a.mode, a.answer]), [
    ['codex', 'gpt-6-astra', 'ok', 'interactive', CODEX_ANSWER], ['agy', ARGON.model, 'ok', 'interactive', AGY_ANSWER]]);
  assert.deepEqual(f.fakeLog('gpt-6-astra', 'submitted'), [ASK_LINE]);
  assert.equal(readRecord(r.answers[0].evidencePath).runner, 'codex');
  assert.ok(fs.existsSync(path.join(r.answers[0].evidencePath, 'out', 'result.txt')), 'codex 칸은 답 파일로 회수한다');
  assert.equal(fs.existsSync(path.join(r.answers[1].evidencePath, 'out')), false, 'agy 칸에는 답 파일 폴더가 없다');
  assert.deepEqual(f.advices().map(e => [e.model, e.reason, e.runner]), [['gpt-6-astra', 'ok', undefined], [ARGON.model, 'ok', 'agy']]);
  assert.deepEqual(f.sessions(), []); assert.deepEqual(f.asks(), []);
  const picked = await f.run({timeout: '60', model: ARGON.model});
  assert.deepEqual(picked.answers.map(a => [a.runner, a.source, a.reason]), [['agy', 'flag', 'ok']]);
  assert.equal(f.fakeLog('gpt-6-astra', 'submitted').length, 1, '고르지 않은 codex는 부르지 않았다');
});

test('혼합 등록: agy 신뢰 창을 지나지 못하면 두 칸 모두 질문을 넣지 않는다(모델 호출 0회, 키 0회)', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA, ARGON], agy: {default: {startup: 'trust-other'}}});
  const error = await f.run({timeout: '60'}).then(() => assert.fail('실패해야 한다'), e => e);
  assert.equal(error.exitCode, 1);
  assert.deepEqual(error.answers.map(a => [a.model, a.reason, a.detail]), [
    ['gpt-6-astra', 'call-failed', 'isolation:peer-gate-failed'], [ARGON.model, 'call-failed', 'isolation:startup:trust-path-mismatch']]);
  assert.match(error.answers[1].note, /신뢰 창을 지나지 못했다/);
  for (const model of ['gpt-6-astra', ARGON.model]) {
    assert.deepEqual(f.fakeLog(model, 'submitted'), [], model); assert.equal(f.fakeLog(model, 'keys').length, 0, `${model}: 키 0회`);
  }
  assert.deepEqual(f.commands, [], '질문 프로세스를 띄우지 않았다');
  assert.deepEqual(f.advices().map(e => [e.model, e.reason, e.tabReason]), [['gpt-6-astra', 'call-failed', 'gate-failed'], [ARGON.model, 'call-failed', 'gate-failed']]);
  assert.deepEqual(f.sessions(), []); assert.deepEqual(f.asks(), []);
});

test('혼합 등록: 한쪽(agy)이 질문 제출 뒤에 실패해도 다른 칸(codex)의 답은 그대로 돌려준다(종료 코드 0)', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA, ARGON], agy: {default: {startup: 'composer', answer: 'exit'}}});
  const r = await f.run({timeout: '60'});
  assert.deepEqual(r.answers.map(a => [a.model, a.reason, a.status]), [['gpt-6-astra', 'ok', 'ok'], [ARGON.model, 'call-failed', '실패(call-failed)']]);
  assert.equal(r.answers[0].answer, CODEX_ANSWER); assert.ok(!('answer' in r.answers[1]));
  assert.equal(r.answers[1].detail, 'pane-dead');
  assert.equal(f.fakeLog(ARGON.model, 'submitted').length, 1, 'agy 칸은 질문을 받은 뒤에 죽었다');
  assert.deepEqual(f.sessions(), []); assert.deepEqual(f.asks(), []);
  // 반대쪽: codex가 한도 화면으로 끝나도 agy 칸의 답은 온다.
  const g = fixture(t, {seniors: [ASTRA, ARGON], agy: {default: {startup: 'composer'}}, codex: {default: {answer: 'limit'}}});
  const mixed = await g.run({timeout: '60'});
  assert.deepEqual(mixed.answers.map(a => [a.model, a.reason]), [['gpt-6-astra', 'limit'], [ARGON.model, 'ok']]);
});

test('agy 두 명: 한 호출에서 자리별 질문 파일을 따로 쓰고 같은 고정 폴더에서 각자 답한다. 잘린·표지 없는 답은 그 칸만 실패다', {skip}, async t => {
  const f = fixture(t, {seniors: [ARGON, HELIUM], agy: {default: {startup: 'composer'}, models: {[HELIUM.model]: {answer: 'none'}}}});
  const r = await f.run({timeout: '60'});
  assert.deepEqual(r.answers.map(a => [a.model, a.reason, a.detail]), [[ARGON.model, 'ok', undefined], [HELIUM.model, 'empty', 'no-marker']]);
  const lines = [ARGON, HELIUM].map(s => f.fakeLog(s.model, 'submitted')[0]);
  assert.deepEqual(lines, [1, 2].map(n => agyAskLine(path.join(f.workdir, 'asks', `${r.askId}-${n}.txt`))));
  assert.deepEqual(f.dump(ARGON.model).cwd, f.dump(HELIUM.model).cwd);
  assert.deepEqual(f.advices().map(e => [e.reason, e.bytes]), [['ok', Buffer.byteLength(AGY_ANSWER)], ['empty', 0]]);
});

test('고정 작업 폴더가 git 저장소 안이면 codex를 포함해 아무도 부르지 않는다(세션·에이전트 파일·advice 0)', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA, ARGON]});
  execFileSync('git', ['-C', f.home, 'init', '-q']);
  await assert.rejects(() => f.run({timeout: '60'}), /agy 시니어 작업 폴더를 쓸 수 없다\(out-inside-git\).*아무도 부르지 않는다/);
  assert.deepEqual(f.advices(), []); assert.deepEqual(f.sessions(), []); assert.deepEqual(f.commands, []);
  assert.equal(fs.existsSync(f.workdir), false);
  for (const model of ['gpt-6-astra', ARGON.model]) assert.equal(fs.existsSync(path.join(f.log, `${model}.env.json`)), false, `${model}: 뜨지도 않았다`);
});

// 탭을 연 순간을 tmux 호출 기록에 남기는 가짜 로티 호출. 그 줄 뒤에 키 명령이 있으면 '탭이 붙은 뒤에 키를 보낸 것'이다.
const TAB_MARK = '# ROTTIE-CREATE';
test('로티 읽기 전용 탭은 agy 칸도 질문을 제출한 뒤에 연다: 신뢰 창 Enter·붙여넣기·Enter가 모두 탭보다 앞이고 열린 뒤에는 키 0회다', {skip}, async t => {
  const f = fixture(t);
  const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const attempts = [];
  const rottie = argv => {
    fs.appendFileSync(f.tmuxLog, `${TAB_MARK}\n`);
    const dir = path.join(f.home, 'advice', fs.readdirSync(path.join(f.home, 'advice'))[0], `1-agy-${ARGON.model}`);
    attempts.push({verb: argv[1], command: argv[argv.indexOf('--command') + 1], record: readRecord(dir),
      submitted: fs.existsSync(path.join(dir, 'submitted.json')), trustEnters: f.fakeLog(ARGON.model, 'trust-enter').length});
    throw Object.assign(new Error('시험 탭 생성 실패'), {code: 'ROTTIE_WORKSPACE_NOT_OPEN', effect: 'none'});
  };
  const {answers: [answer]} = await f.run({timeout: '60'}, {env, rottie});
  assert.equal(attempts.length, 1);
  assert.deepEqual([attempts[0].verb, attempts[0].submitted, attempts[0].trustEnters], ['create', true, 1]);
  assert.equal(attempts[0].command, `tmux -L ${f.tmux.socket} attach -r -t '=${attempts[0].record.session}'`);
  assert.deepEqual([answer.reason, answer.tab, answer.tabReason], ['ok', 'skipped', 'ROTTIE_WORKSPACE_NOT_OPEN']);
  const all = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean);
  const mark = all.indexOf(TAB_MARK);
  const keys = lines => lines.filter(line => /\b(send-keys|paste-buffer|load-buffer)\b/u.test(line));
  assert.equal(all.slice(0, mark).filter(line => / send-keys .*Enter$/u.test(line)).length, 2, '탭 전에 신뢰 창 Enter와 질문 Enter가 나갔다');
  assert.equal(all.slice(0, mark).filter(line => / paste-buffer /u.test(line)).length, 1);
  assert.deepEqual(keys(all.slice(mark + 1)), [], '탭이 붙은 뒤 키 명령 0회');
});
