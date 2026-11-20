import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {SESSION_TIMING, askSeat, keepSeat, killOwn, listSeniorSessions, openSeats, passGate, readRecord, seniorSocket,
  seniorTmux} from '../src/senior-session.mjs';
import {AGY_WORKDIR, agyArgv, agyAskLine, askSeatAgy, prepareAgyWorkdir} from '../src/senior-agy.mjs';
import {NOEXEC_AGENT_MD} from '../src/exec-agent.mjs';
import {markerOf, markerParts} from '../src/senior-screen.mjs';

// 시니어 agy 대화창 갈래(설계 2026-11-18 v2.1): 진짜 agy 없이 가짜 대화창 화면(tests/helpers/fake-agy-tui.mjs)을 격리 소켓에 띄운다.
// 모델·네트워크·사용자 agy 설정·운영 tmux·로티는 쓰지 않는다. 가짜 화면의 신뢰 목록은 시험 폴더의 파일이다.
const FAKE = new URL('./helpers/fake-agy-tui.mjs', import.meta.url).pathname;
const REAL_TMUX = spawnSync('which', ['tmux'], {encoding: 'utf8'}).stdout.trim();
const skip = !REAL_TMUX;
const TIMING = {...SESSION_TIMING, pollMs: 100, settleMs: 50, startupMs: 30_000, submitGraceMs: 4000, keyGapS: '0.3'};
const TOKEN = '0a1b2c3d';
const PROMPT = `질문\n끝 표지 조각: ${markerParts(TOKEN).map(part => JSON.stringify(part)).join(' ')}\n`;
const OK_ANSWER = '결론: 가짜 답이다\n근거: 질문 파일을 읽었다';
let seq = 0;
// 시험 정리: 호출이 끝난 것으로 적고(남김 표시) 정리 명령과 같은 확인(killOwn)으로 끈다. 제품은 끝난 세션을 끄지 않고 남긴다.
const closeSeat = (seat, deps) => { keepSeat(seat, {run: deps.run, reason: 'test'}); return killOwn(seat.dir, {run: deps.run, reason: 'test'}); };

// 시험마다 자기 홈·자기 소켓·가짜 agy·tmux 기록 틀을 갖는다. 부르는 쪽 환경에는 일부러 역할·바깥 tmux 값을 넣어 둔다(새지 않아야 한다).
function setup(t, plan = {}, {conf = null} = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ksa-')));
  const bin = path.join(home, 'bin'), log = path.join(home, 'fake-log');
  fs.mkdirSync(bin); fs.mkdirSync(log);
  fs.writeFileSync(path.join(bin, 'agy'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, {mode: 0o755});
  const tmuxLog = path.join(home, 'tmux-calls.log');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${tmuxLog}'\nexec '${REAL_TMUX}' "$@"\n`, {mode: 0o755});
  // 스크롤 한도를 줄여 보는 시험만 카단 tmux 설정 파일을 먼저 둔다(없으면 제품이 기본 설정을 쓴다).
  if (conf) fs.writeFileSync(path.join(home, 'tmux.conf'), conf);
  const planFile = path.join(home, 'plan.json');
  const setPlan = value => fs.writeFileSync(planFile, JSON.stringify({log, default: {}, models: {}, ...value}));
  setPlan(plan);
  const env = {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: `ka${process.pid}x${++seq}`,
    FAKE_AGY_PLAN: planFile, KADAN_ROLE: 'qa-슈퍼감독', TMUX: '/tmp/outer-tmux,1,0', TMUX_PANE: '%9'};
  const run = seniorTmux({socket: seniorSocket(env, home), home, env});
  t.after(() => {
    process.stderr.write(`격리 소켓 kill-server: -L ${run.socket}\n`);
    run.try(['kill-server']);
  });
  // models: 자리마다 모델 이름 하나(가짜 화면의 계획은 모델 이름으로 고른다).
  const open = (models = ['m1'], more = {}) => {
    const askId = randomUUID();
    const calls = models.map((model, index) => {
      const dir = path.join(home, 'advice', askId, `${index + 1}-agy-${model}`);
      fs.mkdirSync(dir, {recursive: true});
      return {dir, runner: 'agy', model, effort: 'max', token: TOKEN, timing: TIMING, prompt: PROMPT, ...more.call};
    });
    return openSeats({home, run, askId, calls, deadlineAt: Date.now() + 30_000, ...more.seats});
  };
  const deps = {run, home, timing: TIMING};
  const fakeLog = (model, kind) => {
    try { return fs.readFileSync(path.join(log, `${model}.${kind}`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  // 붙여넣기 구간 밖에서 받은 Enter 수, 신뢰 창이 받은 Enter 수, 선택 화면이 받은 Enter 수.
  const keys = model => {
    const raw = fakeLog(model, 'keys').join('').replace(/\x1b\[200~[\s\S]*?\x1b\[201~/gu, '');
    return {enter: raw.split('\r').length - 1, esc: fakeLog(model, 'esc').length, any: fakeLog(model, 'keys').length,
      submitted: fakeLog(model, 'submitted'), trustEnter: fakeLog(model, 'trust-enter'), overlayEnter: fakeLog(model, 'overlay-enter').length};
  };
  const workdir = path.join(home, AGY_WORKDIR);
  const asks = () => { try { return fs.readdirSync(path.join(workdir, 'asks')).sort(); } catch { return []; } };
  const trusted = () => { try { return JSON.parse(fs.readFileSync(path.join(log, 'trusted.json'), 'utf8')); } catch { return []; } };
  return {home, env, run, log, setPlan, open, deps, keys, workdir, asks, trusted, tmuxLog,
    sessions: () => listSeniorSessions(run).map(row => row.name),
    envDump: model => JSON.parse(fs.readFileSync(path.join(log, `${model}.env.json`), 'utf8'))};
}

test('실행 꼴은 고정이다: 대화창으로만 띄우고(--print·-p·--effort 없음) 도구 없는 에이전트를 반드시 주며 읽기 폴더는 안전한 값만 붙인다', () => {
  assert.deepEqual(agyArgv({model: 'gemini-fake-medium'}), ['agy', '--model', 'gemini-fake-medium', '--agent', 'kadan-noexec']);
  assert.deepEqual(agyArgv({model: 'm', readDir: '/fake/repo'}), ['agy', '--model', 'm', '--agent', 'kadan-noexec', '--add-dir', '/fake/repo']);
  for (const argv of [agyArgv({model: 'm'}), agyArgv({model: 'm', readDir: '/fake/repo'})]) {
    assert.ok(!argv.some(word => ['--print', '-p', '--effort', '--print-timeout', '--output-format'].includes(word)), argv.join(' '));
  }
  assert.throws(() => agyArgv({model: "m'; rm"}), /모델 형식/);
  assert.throws(() => agyArgv({model: 'm', readDir: '/a b'}), /읽기 폴더 형식/);
  // 화면에 넣는 한 줄은 `/`로 시작하지 않는다(agy가 명령 완성 목록을 띄운다).
  assert.ok(!agyAskLine('/fake/asks/x-1.txt').startsWith('/'));
  assert.ok(agyAskLine('/fake/asks/x-1.txt').endsWith(': /fake/asks/x-1.txt'));
});

test('정상: 첫 호출은 고정 작업 폴더의 신뢰 창을 Enter 한 번으로 지나 질문 한 줄을 넣고 화면의 답을 받는다. 둘째 호출에는 신뢰 창이 없고 신뢰 목록은 늘지 않는다', {skip}, async t => {
  const s = setup(t);
  const [seat] = s.open();
  // 순서: 고정 폴더(git 밖 확인) → 에이전트 파일 → 질문 파일 → 세션. agy는 아직 뜨지 않았다(문 파일이 없다).
  assert.equal(seat.workdir, s.workdir); assert.equal(seat.runner, 'agy');
  assert.equal(fs.readFileSync(path.join(s.workdir, '.agents/agents/kadan-noexec/agent.md'), 'utf8'), NOEXEC_AGENT_MD);
  assert.deepEqual(s.asks(), [`${seat.askId}-1.txt`]);
  assert.equal(fs.readFileSync(seat.askFile, 'utf8'), PROMPT);
  assert.equal(seat.line, agyAskLine(seat.askFile));
  assert.equal(fs.existsSync(path.join(s.log, 'm1.env.json')), false);
  const gate = await passGate(seat, s.deps);
  assert.equal(gate.ok, true); assert.equal(gate.trust.result, 'accepted'); assert.equal(gate.trust.path, s.workdir);
  assert.deepEqual(gate.trust.keys, ['Enter']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(seat.dir, 'gate.json'), 'utf8')).trust.result, 'accepted');
  const outcome = await askSeat(seat, s.deps);
  assert.deepEqual(outcome, {reason: 'ok', answer: OK_ANSWER});
  assert.ok(!outcome.answer.includes(markerOf(TOKEN)));
  // 키: 신뢰 창 Enter 한 번(Yes 줄에서) + 질문 한 줄의 붙여넣기와 Enter 한 번. 그 밖의 키는 없다.
  const k = s.keys('m1');
  assert.deepEqual(k.trustEnter, ['> Yes, I trust this folder']);
  assert.deepEqual(k.submitted, [seat.line]);
  assert.equal(k.enter, 2); assert.equal(k.esc, 0); assert.equal(k.overlayEnter, 0);
  // 환경: 부른 쪽의 역할·바깥 tmux 값이 agy에 없다. 작업 폴더는 고정 폴더이고 실행 인자는 고정 꼴 그대로다.
  const dump = s.envDump('m1');
  assert.deepEqual([dump.KADAN_ROLE, dump.TMUX, dump.TMUX_PANE], [null, null, null]);
  assert.equal(dump.cwd, s.workdir); assert.equal(String(dump.pid), String(seat.panePid));
  assert.deepEqual(dump.argv, agyArgv({model: 'm1'}).slice(1));
  assert.equal(JSON.parse(fs.readFileSync(path.join(seat.dir, 'boundary.json'), 'utf8')).line, seat.line);
  // 호출이 끝나도 세션과 자리별 질문 파일은 남는다. 세션을 끌 때(정리 명령·내보내기와 같은 확인) 질문 파일도 치운다.
  assert.deepEqual(keepSeat(seat, {...s.deps, reason: 'ok'}), {kept: true});
  assert.deepEqual(s.sessions(), [seat.session]);
  assert.deepEqual(s.asks(), [`${seat.askId}-1.txt`]);
  assert.deepEqual(killOwn(seat.dir, {run: s.run, reason: 'cleanup'}), {killed: true});
  assert.deepEqual(s.sessions(), []);
  assert.deepEqual(s.asks(), [], '세션을 끌 때 질문 파일을 지운다');
  // 둘째 호출: 같은 고정 폴더라 신뢰 창이 없다. 신뢰 목록은 그 폴더 하나 그대로다.
  const [again] = s.open(['m2']);
  const second = await passGate(again, s.deps);
  assert.deepEqual(second, {ok: true});
  assert.deepEqual((await askSeat(again, s.deps)).reason, 'ok');
  assert.deepEqual(s.keys('m2').trustEnter, []); assert.equal(s.keys('m2').enter, 1);
  assert.deepEqual(s.trusted(), [s.workdir], '호출이 늘어도 신뢰 목록은 한 항목이다');
  closeSeat(again, s.deps);
  // 이 길의 모든 tmux 호출은 자기 전용 소켓이다.
  const calls = fs.readFileSync(s.tmuxLog, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(calls.filter(line => !line.startsWith(`-u -L ${s.run.socket} -f `)), []);
});

test('신뢰 창 키 조건: 다른 경로·경로 두 줄·No가 선택됨·끄기 스위치면 키를 하나도 보내지 않고 관문에서 끝난다. Enter 뒤에도 창이 남으면 실패다', {skip}, async t => {
  const s = setup(t, {models: {other: {startup: 'trust-other'}, two: {startup: 'trust-two'}, no: {startup: 'trust-no'},
    stay: {startup: 'trust', afterTrust: 'stay'}}});
  const seats = s.open(['other', 'two', 'no', 'stay']);
  // 거절은 신뢰 창을 본 그 자리에서 끝난다(기다림 없음). 창이 남는 경우만 정해 둔 시간까지 기다린 뒤 실패한다.
  const gates = await Promise.all(seats.map(seat => passGate(seat, seat.model === 'stay' ? {...s.deps, timing: {...TIMING, startupMs: 4000}} : s.deps)));
  assert.deepEqual(gates.map(gate => [gate.ok, gate.why]), [[false, 'startup:trust-path-mismatch'], [false, 'startup:trust-path-unreadable'],
    [false, 'startup:trust-not-yes'], [false, 'startup:trust-remains']]);
  for (const model of ['other', 'two', 'no']) assert.equal(s.keys(model).any, 0, `${model}: 키 0회`);
  // 조건이 맞아 Enter를 한 번 보냈지만 창이 그대로면 더 보내지 않고 실패한다.
  assert.deepEqual(s.keys('stay').trustEnter, ['> Yes, I trust this folder']);
  for (const seat of seats) closeSeat(seat, s.deps);
  // 끄기 스위치($KADAN_HOME/auto-trust.off): 조건이 맞아도 지나지 않는다.
  const off = setup(t);
  fs.writeFileSync(path.join(off.home, 'auto-trust.off'), '');
  const [seat] = off.open();
  const gate = await passGate(seat, off.deps);
  assert.deepEqual([gate.ok, gate.why], [false, 'startup:trust-switch-off']);
  assert.equal(off.keys('m1').any, 0);
  assert.deepEqual(off.trusted(), []);
  closeSeat(seat, off.deps);
});

test('키 조건: 시작 화면이 모르는 선택 화면이면 키 0회로 끝나고, 붙인 뒤 선택 화면으로 바뀌면 Enter 0회다. 첫 기동 배너와 안내 글이 든 빈 입력칸은 통과한다', {skip}, async t => {
  const s = setup(t, {default: {startup: 'composer'}, models: {menu: {startup: 'menu'}, paste: {afterPaste: 'menu'}, banner: {banner: true},
    dead: {startup: 'exit'}}});
  const [menu, paste, banner, dead] = s.open(['menu', 'paste', 'banner', 'dead']);
  // 선택 화면은 정해 둔 시간까지 기다린 뒤 실패한다. 죽은 세션은 본 그 자리에서 끝난다.
  const short = {...s.deps, timing: {...TIMING, startupMs: 4000}};
  const [menuGate, pasteGate, bannerGate, deadGate] = await Promise.all([passGate(menu, short), passGate(paste, s.deps), passGate(banner, s.deps), passGate(dead, s.deps)]);
  assert.equal(menuGate.ok, false); assert.match(menuGate.why, /^startup:/);
  assert.deepEqual([s.keys('menu').any, s.keys('menu').overlayEnter], [0, 0]);
  assert.deepEqual([deadGate.ok, deadGate.why], [false, 'startup:pane-dead']);
  // 붙인 직후 선택 화면: 본문은 붙었지만 Enter는 나가지 않는다.
  assert.deepEqual(pasteGate, {ok: true});
  const refused = await askSeat(paste, s.deps);
  assert.equal(refused.reason, 'call-failed'); assert.match(refused.detail, /^key:/);
  assert.deepEqual([s.keys('paste').enter, s.keys('paste').overlayEnter, s.keys('paste').submitted.length], [0, 0, 0]);
  // 첫 기동 배너(esc to dismiss)와 흐리지 않은 안내 글이 있어도 빈 입력칸이다 — 신뢰 창이 없던 자리도 붙여넣기·Enter 조건을 각각 지난다.
  assert.deepEqual(bannerGate, {ok: true});
  assert.deepEqual(await askSeat(banner, s.deps), {reason: 'ok', answer: OK_ANSWER});
  assert.deepEqual([s.keys('banner').enter, s.keys('banner').esc], [1, 0]);
  for (const seat of [menu, paste, banner, dead]) closeSeat(seat, s.deps);
  assert.deepEqual(s.sessions(), []);
});

test('답 회수: 화면보다 긴 답도 스크롤 기록에서 순서대로 전부 받고, 표지 뒤의 출처 묶음은 버린다', {skip}, async t => {
  const s = setup(t, {default: {startup: 'composer'}, models: {long: {answer: 'long', lines: 80}, sources: {answer: 'sources'}}});
  const seats = s.open(['long', 'sources']);
  assert.deepEqual((await Promise.all(seats.map(seat => passGate(seat, s.deps)))).map(gate => gate.ok), [true, true]);
  const [long, sources] = await Promise.all(seats.map(seat => askSeat(seat, s.deps)));
  // 세션 화면은 50줄이라 80줄 답의 앞부분은 화면 밖(스크롤 기록)에 있다.
  const want = Array.from({length: 80}, (_, index) => `LINE-${String(index + 1).padStart(3, '0')}`).join('\n');
  assert.deepEqual(long, {reason: 'ok', answer: want});
  const visible = s.run(['capture-pane', '-p', '-t', `=${seats[0].session}:`]);
  assert.ok(!visible.includes('LINE-001') && visible.includes('LINE-080'), '마지막 화면에는 답의 뒤쪽만 있다');
  assert.deepEqual(sources, {reason: 'ok', answer: OK_ANSWER});
  for (const seat of seats) closeSeat(seat, s.deps);
});

test('ok 오판 막기: 표지만·표지 둘·본문에 표지 인용·단독 줄 아님·표지 뒤 본문·표지 없음·일하는 표시를 못 봄은 ok가 아니다', {skip}, async t => {
  const cases = {'marker-only': 'marker-only', 'marker-twice': 'marker-repeated', 'marker-quoted': 'marker-repeated',
    'marker-inline': 'marker-not-alone', 'text-after': 'text-after-marker', none: 'no-marker', instant: 'no-work-seen'};
  const names = Object.keys(cases);
  const run = async part => {
    const s = setup(t, {default: {startup: 'composer'}, models: Object.fromEntries(part.map(name => [name, {answer: name}]))});
    const seats = s.open(part);
    await Promise.all(seats.map(seat => passGate(seat, s.deps)));
    const outcomes = await Promise.all(seats.map(seat => askSeat(seat, s.deps)));
    for (const [index, name] of part.entries()) assert.deepEqual(outcomes[index], {reason: 'empty', detail: cases[name]}, name);
    for (const seat of seats) closeSeat(seat, s.deps);
  };
  await Promise.all([run(names.slice(0, 4)), run(names.slice(4))]);
});

test('회수를 믿을 수 없으면 call-failed다: 시작 경계가 스크롤에서 사라짐·스크롤 한도·캡처 상한 초과·세션 죽음. 일하는 중에 상한이 끝나면 timeout이다', {skip}, async t => {
  const s = setup(t, {default: {startup: 'composer'}, models: {clear: {answer: 'clear'}, exit: {answer: 'exit'}, forever: {answer: 'working-forever'}}});
  const [clear, exit, forever, tiny] = s.open(['clear', 'exit', 'forever', 'tiny']);
  await Promise.all([clear, exit, forever, tiny].map(seat => passGate(seat, s.deps)));
  const late = {...forever, deadlineAt: Date.now() + 4000};
  const [cleared, died, timedOut, overflow] = await Promise.all([askSeat(clear, s.deps), askSeat(exit, s.deps), askSeat(late, s.deps),
    askSeat(tiny, {...s.deps, captureMaxBytes: 64})]);
  assert.deepEqual(cleared, {reason: 'call-failed', detail: 'boundary-lost'});
  assert.deepEqual(died, {reason: 'call-failed', detail: 'pane-dead'});
  assert.equal(timedOut.reason, 'timeout'); assert.match(timedOut.detail, /^deadline/);
  // 캡처가 출력 상한을 넘으면 잘린 것이다: 질문을 넣기 전에 걸리므로 키는 0회다.
  assert.deepEqual(overflow, {reason: 'call-failed', detail: 'capture-too-big'});
  assert.equal(s.keys('tiny').any, 0);
  for (const seat of [clear, exit, forever, tiny]) closeSeat(seat, s.deps);
  // 스크롤 한도가 작은 서버: 긴 답이 한도를 채우면 경계가 남았는지와 무관하게 받지 않는다.
  const small = setup(t, {default: {startup: 'composer', answer: 'long', lines: 120}}, {conf: 'set -g status off\nset -g history-limit 40\n'});
  const [seat] = small.open(['m1']);
  await passGate(seat, small.deps);
  const limited = await askSeat(seat, small.deps);
  assert.equal(limited.reason, 'call-failed');
  assert.ok(['scrollback-limit', 'boundary-lost'].includes(limited.detail), limited.detail);
  closeSeat(seat, small.deps);
});

test('고정 작업 폴더: git 저장소 안이면 폴더·에이전트 파일·질문 파일·세션을 하나도 만들지 않고 거절한다. 링크면 거절하고, 준비는 여러 번 불러도 같다', {skip}, t => {
  const s = setup(t);
  execFileSync('git', ['-C', s.home, 'init', '-q']);
  assert.throws(() => s.open(), /agy 시니어 작업 폴더를 쓸 수 없다\(out-inside-git\)/);
  assert.equal(fs.existsSync(s.workdir), false, 'git 안이면 폴더도 만들지 않는다');
  assert.deepEqual(s.sessions(), []);
  assert.equal(fs.existsSync(path.join(s.home, 'senior-seats.lock')), false, '잠금은 풀려 있다');
  // 이미 있는 폴더가 git 안이어도 에이전트 파일을 쓰지 않는다.
  fs.mkdirSync(s.workdir);
  assert.throws(() => s.open(), /out-inside-git/);
  assert.deepEqual(fs.readdirSync(s.workdir), []);
  // 링크인 고정 폴더는 거절한다(밖의 폴더에 에이전트 파일을 쓰지 않는다).
  const linked = setup(t);
  const outside = path.join(linked.home, 'elsewhere'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, linked.workdir);
  assert.throws(() => linked.open(), /agy 시니어 작업 폴더를 쓸 수 없다/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(linked.sessions(), []);
  // 정상 홈: 두 번 준비해도 같은 실제 경로이고 에이전트 파일은 그대로다.
  const fine = setup(t);
  assert.equal(prepareAgyWorkdir(fine.home), fine.workdir);
  assert.equal(prepareAgyWorkdir(fine.home), fine.workdir);
  assert.equal(fs.readFileSync(path.join(fine.workdir, '.agents/agents/kadan-noexec/agent.md'), 'utf8'), NOEXEC_AGENT_MD);
});

// 검수 exec-89326673 중요 1: 신뢰 창 Enter도 바닥의 키 전송·Claude 신뢰 키와 같은 확인(기록보기 모드·사람 입력)을 거친다.
test('신뢰 창 Enter 직전 확인: 기록보기(복사) 모드 중이거나 사람 입력이 감지되면 Enter 0회로 끝나고, 정상이면 한 번 보낸다', {skip}, async t => {
  const s = setup(t, {models: {copy: {startup: 'trust'}, human: {startup: 'trust'}, normal: {startup: 'trust'}}});
  const [copy, human, normal] = s.open(['copy', 'human', 'normal']);
  // 사람이 그 창에서 기록보기를 연 경우와, 중계가 남긴 사람 입력 표시(@kadan_human_input)가 방금인 경우.
  s.run(['copy-mode', '-t', `=${copy.session}:`]);
  s.run(['set-option', '-t', `=${human.session}:`, '@kadan_human_input', String(Math.floor(Date.now() / 1000))]);
  const gates = await Promise.all([copy, human, normal].map(seat => passGate(seat, s.deps)));
  assert.deepEqual(gates.map(gate => [gate.ok, gate.why]), [[false, 'startup:trust-pane-in-mode'], [false, 'startup:trust-human-active'], [true, undefined]]);
  assert.match(gates[0].note, /키를 보내지 않았다/); assert.match(gates[1].note, /키를 보내지 않았다/);
  assert.equal(gates[2].trust.result, 'accepted');
  // tmux로 나간 Enter 명령 수(세션별)와 가짜 화면이 받은 Enter 수.
  const calls = fs.readFileSync(s.tmuxLog, 'utf8').split('\n').filter(Boolean);
  const enters = seat => calls.filter(line => line.endsWith(` send-keys -t =${seat.session}: Enter`)).length;
  assert.deepEqual([enters(copy), enters(human), enters(normal)], [0, 0, 1]);
  assert.deepEqual([s.keys('copy').any, s.keys('human').any, s.keys('normal').trustEnter.length], [0, 0, 1]);
  for (const seat of [copy, human]) assert.equal(JSON.parse(fs.readFileSync(path.join(seat.dir, 'gate.json'), 'utf8')).trust, undefined);
  for (const seat of [copy, human, normal]) closeSeat(seat, s.deps);
});

// 검수 exec-18bddad5: 확인 순서가 codex 질문 키와 같아야 한다 — 사람 입력 조회 뒤에 pane PID·생존을 본다.
// 조회 도중 프로세스가 바뀌는 순간은 가짜 화면으로 만들 수 없어 tmux 호출을 흉내 낸 실행 함수로 본다.
test('신뢰 창 Enter 확인 순서: 사람 입력 조회 도중 창의 프로세스가 바뀌면 Enter 0회로 끝나고, 바뀌지 않으면 한 번 보낸다', async () => {
  const rule = '─'.repeat(60);
  const idle = [rule, '>', rule, `${'? for shortcuts'.padEnd(40, ' ')}auto · kadan-noexec (Fake Model · medium)  /agents`].join('\n');
  const gate = async ({swap}) => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ksa-order-')));
    const trust = ['Accessing workspace:', '', home, '', 'Do you trust the contents of this project?', '',
      'Fake Antigravity CLI requires permission to read, edit, and execute files here.', '', '> Yes, I trust this folder', '  No, exit', '',
      '  ↑/↓ Navigate · enter Confirm', `${' '.repeat(40)}auto · Fake Model · medium`].join('\n');
    let pid = '123', sent = 0;
    const order = [];
    const run = args => {
      if (args[0] === 'capture-pane') return sent ? idle : trust;
      if (args[0] === 'display-message') {
        const format = args.at(-1);
        order.push(format === '#{pane_in_mode}' ? 'mode' : 'pid');
        return format === '#{pane_in_mode}' ? '0' : `${pid}|0`;
      }
      // 사람 입력 조회가 시작되는 순간 그 창의 프로세스가 다른 것으로 바뀐다.
      if (args[0] === 'list-clients') { order.push('human'); if (swap) pid = '456'; return ''; }
      if (args[0] === 'send-keys') { order.push('enter'); sent += 1; return ''; }
      return '';
    };
    run.try = args => ({status: 0, stdout: run(args)});
    const seat = {runner: 'agy', home, dir: home, workdir: home, session: 'senior-fake-1', panePid: '123', gate: path.join(home, 'launch'),
      deadlineAt: Date.now() + 60_000};
    const verdict = await passGate(seat, {run, timing: {...TIMING, settleMs: 1, pollMs: 1, startupMs: 200}, sleep: async () => {}});
    return {verdict, sent, order};
  };
  const swapped = await gate({swap: true});
  assert.equal(swapped.sent, 0, '바뀐 프로세스로 Enter를 보내지 않는다');
  assert.deepEqual([swapped.verdict.ok, swapped.verdict.why], [false, 'startup:pane-dead']);
  const normal = await gate({swap: false});
  assert.equal(normal.sent, 1);
  assert.equal(normal.verdict.ok, true); assert.equal(normal.verdict.trust.result, 'accepted');
  // Enter 바로 앞의 확인 순서: 기록보기 모드 → 사람 입력 → pane PID·생존 → Enter(그 사이의 화면 재확인은 화면 읽기라 여기 적히지 않는다).
  const enter = normal.order.indexOf('enter');
  assert.deepEqual(normal.order.slice(enter - 3, enter + 1), ['mode', 'human', 'pid', 'enter']);
});

// 검수 exec-89326673 중요 2: 지금 화면이 쉬고 있어도 답을 읽는 전체 스크롤 캡처에 일하는 표시·선택 창이 있으면 ok가 아니다.
// 두 캡처 사이에 화면이 바뀌는 순간은 가짜 화면으로 만들기 어려워 tmux 호출을 흉내 낸 실행 함수로 본다.
test('최종 캡처의 상태: 지금 화면은 빈 입력칸인데 답을 읽은 스크롤 캡처에 일하는 표시·선택 창이 보이면 ok로 받지 않는다', async () => {
  const rule = '─'.repeat(60), marker = markerOf(TOKEN);
  const line = agyAskLine('/fake/home/senior-agy/asks/ask-1.txt');
  const composer = (hint = '? for shortcuts', text = '') => [rule, `> ${text}`.trimEnd(), rule, `${hint.padEnd(40, ' ')}auto · kadan-noexec (Fake Model · medium)  /agents`];
  const transcript = end => [rule, `> ${line}`, '', '  결론: 가짜 답이다', '', `  ${marker}`, '', ...end].join('\n');
  const recover = async end => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ksa-final-'));
    let stage = 'initial', polls = 0, histories = 0;
    const run = args => {
      if (args[0] === 'capture-pane') {
        if (stage === 'initial') return composer().join('\n');
        if (stage === 'pasted') return composer('', line).join('\n');
        return composer(polls++ === 0 ? 'esc to cancel' : '? for shortcuts').join('\n');   // 한 번 일하고 그 뒤로 쉰다
      }
      if (args[0] === 'display-message') {
        const format = args.at(-1);
        return format === '#{pane_in_mode}' ? '0' : format === '#{pane_pid}|#{pane_dead}' ? '123|0' : '2|50000';
      }
      if (args[0] === 'paste-buffer') stage = 'pasted';
      if (args[0] === 'send-keys') stage = 'submitted';
      return '';
    };
    // 전체 스크롤 캡처: 넣기 전에는 빈 입력칸뿐이고, 끝 판정 때는 시험이 준 끝 화면이 붙어 있다.
    run.try = args => ({status: 0, stdout: args[0] === 'capture-pane' ? (histories++ === 0 ? composer().join('\n') : transcript(end)) : run(args)});
    const seat = {home, dir: home, workdir: home, session: 'senior-fake-1', panePid: '123', deadlineAt: Date.now() + 60_000, line, marker};
    return askSeatAgy(seat, {run, timing: {...TIMING, pollMs: 1, keyGapS: '0', submitGraceMs: 30}, sleep: async () => {}, spawn: () => ({status: 0})});
  };
  assert.deepEqual(await recover(composer()), {reason: 'ok', answer: '결론: 가짜 답이다'});
  assert.deepEqual(await recover(composer('esc to cancel')), {reason: 'call-failed', detail: 'final-capture-not-idle:working'});
  assert.deepEqual(await recover([...composer(), '> 1. Log in']), {reason: 'call-failed', detail: 'final-capture-not-idle:lines-below-composer'});
});

test('질문 파일은 자리별이다: 한 호출에서 agy 두 자리를 만들면 서로 다른 파일이고, 한 자리를 만든 뒤 다음이 실패하면 만든 파일도 치운다', {skip}, async t => {
  const s = setup(t, {default: {startup: 'composer'}});
  const seats = s.open(['m1', 'm2']);
  assert.deepEqual(s.asks(), [`${seats[0].askId}-1.txt`, `${seats[0].askId}-2.txt`]);
  assert.notEqual(seats[0].askFile, seats[1].askFile); assert.notEqual(seats[0].line, seats[1].line);
  assert.equal(seats[0].workdir, seats[1].workdir);
  await Promise.all(seats.map(seat => passGate(seat, s.deps)));
  const outcomes = await Promise.all(seats.map(seat => askSeat(seat, s.deps)));
  assert.deepEqual(outcomes.map(outcome => outcome.reason), ['ok', 'ok']);
  // 각 자리는 자기 질문 줄만 받았다.
  assert.deepEqual(s.keys('m1').submitted, [seats[0].line]); assert.deepEqual(s.keys('m2').submitted, [seats[1].line]);
  for (const seat of seats) closeSeat(seat, s.deps);
  assert.deepEqual(s.asks(), []);
  // 둘째 자리의 모델 이름이 형식에 어긋나 실패한다: 첫 자리의 세션과 질문 파일이 남지 않는다.
  assert.throws(() => s.open(['m3', "bad'name"]), /모델 형식/);
  assert.deepEqual(s.sessions(), []);
  assert.deepEqual(s.asks(), []);
  const partial = fs.readdirSync(path.join(s.home, 'advice')).map(ask => readRecord(path.join(s.home, 'advice', ask, '1-agy-m3'))).find(Boolean);
  assert.equal(partial.endReason, 'partial-create');
});
