import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {ASK_LINE, SESSION_ENTRY, SESSION_TIMING, askSeat, closeSeat, codexArgv, confirmOwn, killOwn, listSeniorSessions,
  openSeats, passGate, readRecord, readSeniorMode, sendLine, seniorSocket, seniorTmux, sweepEnded} from '../src/senior-session.mjs';
import {markerOf, markerParts} from '../src/senior-screen.mjs';

// 시니어 대화형 세션(2026-11-17 설계): 진짜 codex 없이 가짜 대화형 화면(tests/helpers/fake-codex-tui.mjs)을 격리 소켓에 띄운다.
// 모델·네트워크·운영 tmux·로티는 쓰지 않는다. MCP 이름은 모두 가짜다.
const FAKE = new URL('./helpers/fake-codex-tui.mjs', import.meta.url).pathname;
const REAL_TMUX = spawnSync('which', ['tmux'], {encoding: 'utf8'}).stdout.trim();
const skip = !REAL_TMUX;
// 여유는 넉넉히 둔다: CI는 시험 파일을 병렬로 돌려 가짜 화면이 늦게 그릴 수 있다. 기다리는 값은 정상 경로의 시간을 늘리지 않는다.
const TIMING = {...SESSION_TIMING, pollMs: 100, settleMs: 50, startupMs: 30_000, mcpMs: 15_000, submitGraceMs: 4000, keyGapS: '0.3'};
const TOKEN = '0a1b2c3d';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let seq = 0;

// 시험마다 자기 홈·자기 소켓·가짜 codex·tmux 기록 틀을 갖는다. 부르는 쪽 환경에는 일부러 역할·바깥 tmux 값을 넣어 둔다(새지 않아야 한다).
function setup(t, plan = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kss-')));
  const bin = path.join(home, 'bin'), log = path.join(home, 'fake-log');
  fs.mkdirSync(bin); fs.mkdirSync(log);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, {mode: 0o755});
  // 모든 tmux 호출을 적는 틀: 기본 소켓 호출이 섞이지 않았는지 본다.
  const tmuxLog = path.join(home, 'tmux-calls.log');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${tmuxLog}'\nexec '${REAL_TMUX}' "$@"\n`, {mode: 0o755});
  const planFile = path.join(home, 'plan.json');
  const setPlan = value => fs.writeFileSync(planFile, JSON.stringify({log, default: {}, models: {}, ...value}));
  setPlan(plan);
  const env = {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: `ks${process.pid}x${++seq}`,
    FAKE_CODEX_PLAN: planFile, KADAN_ROLE: 'qa-슈퍼감독', TMUX: '/tmp/outer-tmux,1,0', TMUX_PANE: '%9'};
  const run = seniorTmux({socket: seniorSocket(env, home), home, env});
  t.after(() => {
    process.stderr.write(`격리 소켓 kill-server: -L ${run.socket}\n`);
    run.try(['kill-server']);
  });
  const allow = names => fs.writeFileSync(path.join(home, 'senior-mcp-allow'), names.join('\n') + '\n');
  const open = (count = 1, more = {}) => {
    const askId = randomUUID();
    const calls = Array.from({length: count}, (_, index) => {
      const dir = path.join(home, 'advice', askId, `${index + 1}-codex-m${index + 1}`);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'input.txt'), `질문\n끝 표지 조각: ${markerParts(TOKEN).map(part => JSON.stringify(part)).join(' ')}\n`);
      return {dir, model: `m${index + 1}`, effort: 'low', token: TOKEN, timing: TIMING};
    });
    return openSeats({home, run, askId, calls, deadlineAt: Date.now() + 30_000, ...more});
  };
  const deps = {run, home, timing: TIMING};
  const fakeLog = (model, kind) => {
    try { return fs.readFileSync(path.join(log, `${model}.${kind}`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  // 붙여넣기 구간 밖에서 받은 Enter 수와 Esc 수.
  const keys = model => {
    const raw = fakeLog(model, 'keys').join('').replace(/\x1b\[200~[\s\S]*?\x1b\[201~/gu, '');
    return {enter: raw.split('\r').length - 1, esc: fakeLog(model, 'esc').length, any: fakeLog(model, 'keys').length,
      submitted: fakeLog(model, 'submitted'), overlayEnter: fakeLog(model, 'overlay-enter').length};
  };
  const sessions = () => listSeniorSessions(run).map(row => row.name);
  return {home, env, run, log, setPlan, allow, open, deps, keys, sessions, tmuxLog,
    envDump: model => JSON.parse(fs.readFileSync(path.join(log, `${model}.env.json`), 'utf8'))};
}

test('senior-mode: 파일이 없으면 헤드리스, 한 줄 값만 받고 다른 값은 거절한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ksm-'));
  assert.equal(readSeniorMode(home), 'headless');
  for (const [text, want] of [['interactive\n', 'interactive'], ['headless', 'headless'], ['  interactive  \n', 'interactive']]) {
    fs.writeFileSync(path.join(home, 'senior-mode'), text);
    assert.equal(readSeniorMode(home), want);
  }
  for (const text of ['', 'Interactive', 'interactive\nheadless', 'tui', 'on']) {
    fs.writeFileSync(path.join(home, 'senior-mode'), text);
    assert.throws(() => readSeniorMode(home), /senior-mode 값 오류/);
  }
});

test('소켓: 격리 소켓이면 -senior를 붙이고, 기본 아닌 홈이 운영 시니어 소켓에 닿으면 거절한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kso-'));
  assert.equal(seniorSocket({KADAN_SOCKET: 'kadan-test-1'}, home), 'kadan-test-1-senior');
  assert.throws(() => seniorSocket({}, home), /KADAN_LIVE_FLOOR_DENIED/);
  assert.throws(() => seniorSocket({KADAN_SOCKET: 'kadan'}, home), /KADAN_LIVE_FLOOR_DENIED/);
  assert.throws(() => seniorTmux({socket: 'kadan-senior', home, env: {}}), /KADAN_LIVE_FLOOR_DENIED/);
  assert.throws(() => seniorTmux({socket: 'bad name', home, env: {}}), /형식 오류/);
});

test('실행 꼴은 고정이다: 작업 폴더·샌드박스·승인·업데이트 확인 끄기를 반드시 주고 모델·강도 형식을 본다', () => {
  assert.deepEqual(codexArgv({out: '/x/out', model: 'gpt-fake', effort: 'low'}), ['codex', '--no-alt-screen', '-C', '/x/out',
    '-s', 'workspace-write', '-a', 'never', '--model', 'gpt-fake', '-c', 'model_reasoning_effort="low"',
    '-c', 'check_for_update_on_startup=false', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'sandbox_workspace_write.writable_roots=[]']);
  assert.throws(() => codexArgv({out: '/x', model: "m'; rm", effort: 'low'}), /모델 형식/);
  assert.throws(() => codexArgv({out: '/x', model: 'm', effort: 'lo w'}), /강도 형식/);
});

test('정상: 관문을 지나 한 줄을 넣고 일하는 표시 뒤 빈 입력칸에서 표지 뗀 답을 ok로 받는다. 키는 붙여넣기+Enter 두 번뿐이고 환경은 새지 않는다', {skip}, async t => {
  const s = setup(t);
  s.allow(['codex_worktrees', 'fixture-a', 'fixture-not-attached']);
  const [seat] = s.open();
  // 기록·세션 옵션·예약 종료는 codex가 뜨기 전에 끝나 있다(문 파일이 없어 가짜 codex는 아직 안 떴다).
  assert.equal(fs.existsSync(path.join(s.log, 'm1.env.json')), false);
  assert.deepEqual(confirmOwn(readRecord(seat.dir), s.run), {own: true});
  assert.match(seat.session, /^senior-[0-9a-f]{8}-1$/);
  assert.deepEqual(await passGate(seat, s.deps), {ok: true});
  const outcome = await askSeat(seat, s.deps);
  assert.deepEqual(outcome, {reason: 'ok', answer: '결론: 가짜 답이다\n근거: input.txt를 읽었다'});
  assert.ok(!outcome.answer.includes(markerOf(TOKEN)));
  const k = s.keys('m1');
  assert.deepEqual(k.submitted, ['/mcp', ASK_LINE]);
  assert.equal(k.enter, 2); assert.equal(k.esc, 0); assert.equal(k.overlayEnter, 0);
  // 환경 변수 덤프: 부른 쪽의 역할·바깥 tmux 값이 codex에 없다. KADAN_HOME은 남는다. pane PID는 대기 셸에서 그대로 이어졌다.
  const dump = s.envDump('m1');
  assert.deepEqual([dump.KADAN_ROLE, dump.TMUX, dump.TMUX_PANE], [null, null, null]);
  assert.equal(dump.KADAN_HOME, s.home);
  assert.equal(String(dump.pid), String(seat.panePid));
  assert.equal(dump.cwd, fs.realpathSync(seat.out));
  assert.deepEqual(dump.argv, codexArgv({out: fs.realpathSync(seat.out), model: 'm1', effort: 'low'}).slice(1));
  assert.deepEqual(closeSeat(seat, s.deps), {killed: true});
  assert.deepEqual(s.sessions(), []);
  assert.match(fs.readFileSync(path.join(seat.dir, 'screen-final.txt'), 'utf8'), /• 끝/);
  assert.ok(readRecord(seat.dir).endedAt);
  // 기본 소켓 호출 0회: 이 길의 모든 tmux 호출은 자기 전용 소켓이다.
  const calls = fs.readFileSync(s.tmuxLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.length > 10);
  assert.deepEqual(calls.filter(line => !line.startsWith(`-u -L ${s.run.socket} -f `)), []);
});

test('키 조건 (가): 시작 화면이 업데이트 선택 창·번호 선택 창이면 키를 하나도 보내지 않고 관문에서 끝난다', {skip}, async t => {
  await Promise.all(['update', 'choice'].map(async startup => {
    const s = setup(t, {default: {startup}});
    s.allow(['codex_worktrees', 'fixture-a']);
    const [seat] = s.open();
    const gate = await passGate(seat, {...s.deps, timing: {...TIMING, startupMs: 1200}});
    assert.equal(gate.ok, false, startup);
    assert.match(gate.why, /^startup:/, startup);
    assert.equal(s.keys('m1').any, 0, `${startup}: 키 0회`);
    // 관문의 기다림과 별개로, 한 줄 넣기 자체도 붙여넣기 직전 검사에서 멈춘다(붙여넣기도 Enter도 나가지 않는다).
    for (const line of ['/mcp', ASK_LINE]) {
      assert.throws(() => sendLine(seat, line, {run: s.run, keyGapS: '0.1'}),
        error => error.code === 'KADAN_SENIOR_KEY_WITHHELD' && error.stage === 'paste' && error.delivery === 'not-sent', startup);
    }
    assert.equal(s.keys('m1').any, 0, `${startup}: 직접 넣어도 키 0회`);
    closeSeat(seat, s.deps);
  }));
});

test('키 조건 (나): 붙인 뒤 업데이트 선택 창으로 바뀌면 Enter 0회, 자기 한 줄이 정상 입력칸에 있으면 Enter 1회', {skip}, async t => {
  // /mcp를 붙인 직후 창이 바뀐다 → Enter가 나가지 않는다(업데이트가 시작되지 않는다).
  const onMcp = async () => {
    const a = setup(t, {default: {afterPaste: 'update', afterPasteOn: 'mcp'}});
    a.allow(['codex_worktrees', 'fixture-a']);
    const [seat] = a.open();
    const gate = await passGate(seat, a.deps);
    assert.equal(gate.ok, false);
    assert.match(gate.why, /^key:(selection-below-composer|composer-not-own-line)$/);
    assert.equal(a.keys('m1').enter, 0); assert.equal(a.keys('m1').overlayEnter, 0); assert.equal(a.keys('m1').any, 1);
    closeSeat(seat, a.deps);
  };
  // 질문 줄을 붙인 직후 창이 바뀐다 → 관문의 Enter 1회(/mcp)만 있고 질문의 Enter는 없다.
  const onAsk = async () => {
    const b = setup(t, {default: {afterPaste: 'update', afterPasteOn: 'ask'}});
    b.allow(['codex_worktrees', 'fixture-a']);
    const [seat] = b.open();
    assert.deepEqual(await passGate(seat, b.deps), {ok: true});
    const outcome = await askSeat(seat, b.deps);
    assert.equal(outcome.reason, 'call-failed');
    assert.match(outcome.detail, /^key:(selection-below-composer|composer-not-own-line) /);
    assert.equal(b.keys('m1').enter, 1); assert.equal(b.keys('m1').overlayEnter, 0);
    assert.deepEqual(b.keys('m1').submitted, ['/mcp']);
    closeSeat(seat, b.deps);
  };
  await Promise.all([onMcp(), onAsk()]);
});

test('관문: 허용 목록 없음·목록 밖 이름·/mcp 못 읽음·out이 git 안이면 질문을 넣지 않는다(모델 호출 0회)', {skip}, async t => {
  const ALLOW = ['codex_worktrees', 'fixture-a'];
  const cases = [
    // 허용 목록 파일 없음: 거절하고 지금 연결된 이름을 보여 준다. 파일을 스스로 만들지 않는다.
    async () => {
      const none = setup(t);
      const [seat] = none.open();
      const missing = await passGate(seat, none.deps);
      assert.equal(missing.why, 'allow-missing');
      assert.match(missing.note, /senior-mcp-allow.*codex_worktrees, fixture-a/);
      assert.equal(fs.existsSync(path.join(none.home, 'senior-mcp-allow')), false);
      assert.deepEqual(none.keys('m1').submitted, ['/mcp']);
      closeSeat(seat, none.deps);
    },
    // 목록 밖 이름이 연결돼 있다.
    async () => {
      const extra = setup(t, {default: {mcp: [['codex_worktrees', 'connected', 3], ['fixture-x', 'connected', 2]]}});
      extra.allow(ALLOW);
      const [seat] = extra.open();
      const outside = await passGate(seat, extra.deps);
      assert.equal(outside.why, 'not-allowed'); assert.deepEqual(outside.outside, ['fixture-x']);
      closeSeat(seat, extra.deps);
    },
    // 꺼진 서버·목록에 있는데 안 붙은 서버는 막지 않는다.
    async () => {
      const off = setup(t, {default: {mcp: [['codex_worktrees', 'connected', 3], ['fixture-x', 'disabled', 0]]}});
      off.allow([...ALLOW, 'fixture-not-attached']);
      const [seat] = off.open();
      assert.deepEqual(await passGate(seat, off.deps), {ok: true});
      closeSeat(seat, off.deps);
    },
    // /mcp 출력을 못 읽음: 끝줄 없이 잘림 / 모르는 줄 / 아직 연결 중 — 부분 목록으로 통과시키지 않는다.
    ...[[{mcpTail: false}, 'mcp-incomplete'], [{mcpRaw: ['  fixture-a 연결됨']}, 'mcp-unreadable'],
      [{mcp: [['codex_worktrees', 'connected', 3], ['fixture-a', 'starting', 0]]}, 'mcp-pending']].map(([plan, why]) => async () => {
      const bad = setup(t, {default: plan});
      bad.allow(ALLOW);
      const [seat] = bad.open();
      // 잘린 출력은 상한까지 기다린 뒤 거절한다(여기서는 상한을 짧게 준다). 나머지 둘은 보자마자 거절한다.
      const gate = await passGate(seat, {...bad.deps, timing: {...TIMING, mcpMs: 1500}});
      assert.equal(gate.ok, false, why); assert.equal(gate.why, why);
      assert.deepEqual(bad.keys('m1').submitted, ['/mcp'], why);
      closeSeat(seat, bad.deps);
    }),
    // out/이 git 저장소 안: codex를 띄우지도 않는다.
    async () => {
      const git = setup(t);
      git.allow(ALLOW);
      const [seat] = git.open();
      assert.equal(spawnSync('git', ['init', '-q', seat.dir]).status, 0);
      assert.deepEqual(await passGate(seat, git.deps), {ok: false, why: 'out-inside-git'});
      assert.equal(fs.existsSync(path.join(git.log, 'm1.env.json')), false);
      assert.equal(fs.existsSync(seat.gate), false);
      closeSeat(seat, git.deps);
    },
  ];
  await Promise.all(cases.map(run => run()));
});

test('ok 오판 막기: 표지만·표지 둘·쓰는 중·일하는 표시를 못 봄·링크·크기 초과는 ok가 아니다', {skip}, async t => {
  const cases = [['marker-only', 'empty', 'marker-only'], ['marker-twice', 'empty', 'marker-repeated'], ['partial', 'empty', 'no-marker'],
    ['none', 'empty', 'no-answer-file'], ['instant', 'empty', 'no-work-seen'], ['symlink', 'empty', 'answer-not-regular-file'],
    ['big', 'empty', 'answer-too-big']];
  await Promise.all(cases.map(async ([answer, reason, detail]) => {
    const s = setup(t, {default: {answer}});
    s.allow(['codex_worktrees', 'fixture-a']);
    const [seat] = s.open();
    assert.deepEqual(await passGate(seat, s.deps), {ok: true}, answer);
    assert.deepEqual(await askSeat(seat, s.deps), {reason, detail}, answer);
    closeSeat(seat, s.deps);
  }));
});

test('ok 오판 막기: 옛 답 파일이 있으면 부르지 않고, 일하는 화면에 표지가 있어도 ok가 아니라 시간 초과다(표지와 겹침)', {skip}, async t => {
  const old = setup(t);
  const askId = randomUUID();
  const dir = path.join(old.home, 'advice', askId, '1-codex-m1');
  fs.mkdirSync(path.join(dir, 'out'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'out', 'result.txt'), `옛 답\n${markerOf(TOKEN)}\n`);
  assert.throws(() => openSeats({home: old.home, run: old.run, askId, deadlineAt: Date.now() + 30_000,
    calls: [{dir, model: 'm1', effort: 'low', token: TOKEN, timing: TIMING}]}), /답 파일이 이미 있다/);
  assert.deepEqual(old.sessions(), []);
  const s = setup(t, {default: {answer: 'working-forever'}});
  s.allow(['codex_worktrees', 'fixture-a']);
  const [seat] = s.open(1, {deadlineAt: Date.now() + 9000});
  assert.deepEqual(await passGate(seat, s.deps), {ok: true});
  // 답 파일은 이미 완성된 표지를 갖고 있지만 화면이 계속 일하는 중이다.
  assert.deepEqual(await askSeat(seat, s.deps), {reason: 'timeout', detail: 'deadline'});
  assert.match(fs.readFileSync(path.join(seat.out, 'result.txt'), 'utf8'), new RegExp(markerOf(TOKEN)));
  closeSeat(seat, s.deps);
});

test('한도: 한도 화면은 limit, 한도 낱말이 답에만 있으면 ok. pane이 죽으면 call-failed', {skip}, async t => {
  const cases = [['limit', {reason: 'limit', detail: 'limit-screen'}], ['capacity', {reason: 'limit', detail: 'limit-screen'}],
    ['limit-in-answer', {reason: 'ok', answer: '결론: usage limit 과 429 낱말은 답의 일부다\n근거: rate limit 문서'}],
    ['exit', {reason: 'call-failed', detail: 'pane-dead'}]];
  await Promise.all(cases.map(async ([answer, want]) => {
    const s = setup(t, {default: {answer}});
    s.allow(['codex_worktrees', 'fixture-a']);
    const [seat] = s.open();
    assert.deepEqual(await passGate(seat, s.deps), {ok: true}, answer);
    assert.deepEqual(await askSeat(seat, s.deps), want, answer);
    assert.equal(s.keys('m1').enter, 2, `${answer}: 재시도 없음`);
    closeSeat(seat, s.deps);
  }));
});

test('시작하자마자 죽은 codex는 관문에서 pane-dead로 끝난다', {skip}, async t => {
  const s = setup(t, {default: {startup: 'exit'}});
  s.allow(['codex_worktrees', 'fixture-a']);
  const [seat] = s.open();
  assert.deepEqual(await passGate(seat, s.deps), {ok: false, why: 'startup:pane-dead'});
});

test('동시 상한: 3+2는 아무도 못 만들고 2+2는 된다. 한 세션을 만든 뒤 다음이 실패하면 만든 것을 끈다', {skip}, t => {
  const s = setup(t);
  const first = s.open(2);
  assert.equal(s.sessions().length, 2);
  const [third] = s.open(1);
  assert.throws(() => s.open(2), /자리가 모자란다\(지금 3개 \+ 이번 2명 > 4\)/);
  assert.equal(s.sessions().length, 3);
  killOwn(third.dir, {run: s.run});
  assert.equal(s.open(2).length, 2);
  assert.equal(s.sessions().length, 4);
  for (const seat of first) killOwn(seat.dir, {run: s.run});
  // 부분 생성: 둘째 세션 만들기가 실패하면 첫째 자기 세션을 끄고 던진다.
  let made = 0;
  const flaky = Object.assign((args, input) => {
    if (args[0] === 'new-session' && ++made === 2) throw new Error('세션 생성 실패(주입)');
    return s.run(args, input);
  }, {try: s.run.try, socket: s.run.socket, home: s.home});
  const before = s.sessions();
  assert.throws(() => s.open(2, {run: flaky}), /세션 생성 실패\(주입\)/);
  assert.deepEqual(s.sessions(), before);
  assert.equal(fs.existsSync(path.join(s.home, 'senior-seats.lock')), false);
});

test('동시 상한 교차: 2개가 있을 때 두 호출이 동시에 2명씩 잡으려 하면 하나만 되고 합은 4를 넘지 않는다', {skip}, async t => {
  const s = setup(t);
  s.open(2);
  const script = path.join(s.home, 'race.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto';
import {openSeats, seniorSocket, seniorTmux} from ${JSON.stringify(new URL('../src/senior-session.mjs', import.meta.url).href)};
const home = process.env.KADAN_HOME, askId = randomUUID();
const run = seniorTmux({socket: seniorSocket(process.env, home), home});
const calls = [1, 2].map(n => { const dir = path.join(home, 'advice', askId, n + '-codex-m' + n); fs.mkdirSync(dir, {recursive: true});
  return {dir, model: 'm' + n, effort: 'low', token: 'aaaaaaaa'}; });
try { openSeats({home, run, askId, calls, deadlineAt: Date.now() + 30000}); console.log('opened'); }
catch (error) { console.log(/자리가 모자란다/.test(error.message) ? 'refused' : 'error:' + error.message); }
process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); // 부른 쪽이 닫을 때까지 살아 있다(도는 호출)
`);
  const children = [];
  const one = () => new Promise(resolve => {
    const child = spawn(process.execPath, [script], {env: s.env, stdio: ['pipe', 'pipe', 'inherit']});
    children.push(child);
    child.stdout.once('data', data => resolve(String(data).trim()));
  });
  t.after(() => children.forEach(child => child.stdin.end()));
  const results = await Promise.all([one(), one()]);
  assert.deepEqual(results.sort(), ['opened', 'refused']);
  assert.equal(s.sessions().length, 4);
});

test('예약 종료: 같은 확인을 쓴다 — PID가 바뀐 pane은 끄지 않고 이유를 남기며, 자기 것은 상한 뒤 tmux 서버가 끈다', {skip}, async t => {
  const s = setup(t);
  const [seat] = s.open();
  // 같은 이름의 세션에 다른 프로세스가 들어앉았다(pane PID가 기록과 다르다).
  s.run(['respawn-pane', '-k', '-t', `=${seat.session}:`, 'sleep 600']);
  const reap = spawnSync(process.execPath, [SESSION_ENTRY, 'reap', seat.dir], {env: s.env, encoding: 'utf8'});
  assert.equal(reap.status, 3);
  assert.deepEqual(s.sessions(), [seat.session]);
  assert.equal(readRecord(seat.dir).killSkipped, 'pid-differs');
  assert.deepEqual(killOwn(seat.dir, {run: s.run}), {killed: false, why: 'pid-differs'});
  s.run(['kill-session', '-t', `=${seat.session}`]);
  // 생성 식별값이 다른 기록으로는 끄지 못한다.
  const [other] = s.open();
  fs.writeFileSync(path.join(other.dir, 'session.json'), JSON.stringify({...readRecord(other.dir), askId: randomUUID()}));
  assert.deepEqual(killOwn(other.dir, {run: s.run}), {killed: false, why: 'generation-differs'});
  assert.deepEqual(s.sessions(), [other.session]);
  s.run(['kill-session', '-t', `=${other.session}`]);
  // 실제 예약: 상한+여유가 지나면 tmux 서버가 진입 파일의 reap을 불러 자기 세션을 끈다.
  const [timed] = s.open(1, {deadlineAt: Date.now() + 500, reapMarginMs: 500});
  assert.deepEqual(s.sessions(), [timed.session]);
  for (let i = 0; i < 80 && s.sessions().length; i++) await sleep(100);
  assert.deepEqual(s.sessions(), []);
  assert.equal(readRecord(timed.dir).endReason, 'scheduled');
});

test('청소: 다음 호출은 기록이 맞고 끝난 자기 세션만 끈다 — 기록 없는 세션·도는 호출·기록이 다른 세션은 그대로 둔다', {skip}, t => {
  const s = setup(t);
  // 자리를 먼저 다 잡고(잡을 때마다 청소가 돈다) 그 뒤에 기록을 바꾼다.
  const [ended] = s.open(), [running] = s.open(), [changed] = s.open(), [gone] = s.open();
  const patch = (seat, more) => fs.writeFileSync(path.join(seat.dir, 'session.json'), JSON.stringify({...readRecord(seat.dir), ...more}));
  patch(ended, {endedAt: new Date().toISOString()});   // 끝남 기록이 있다
  patch(changed, {panePid: '1', endedAt: 'x'});         // 끝났다고 적혀 있지만 pane PID가 기록과 다르다
  patch(gone, {ownerPid: 2 ** 22 + 12345});             // 부른 프로세스가 없다
  s.run(['new-session', '-d', '-s', 'senior-foreign', 'sleep 600']); // 기록 없는 남의 세션(옵션 없음)
  const swept = sweepEnded({home: s.home, run: s.run});
  assert.deepEqual(swept.sort(), [ended.session, gone.session].sort());
  assert.deepEqual(s.sessions().sort(), ['senior-foreign', running.session, changed.session].sort());
  assert.equal(readRecord(changed.dir).killSkipped, 'pid-differs');
  // 도는 호출(부른 프로세스가 살아 있음)은 만료 시각이 지난 뒤에만 끈다.
  assert.deepEqual(sweepEnded({home: s.home, run: s.run, now: () => readRecord(running.dir).expiresAt}), []);
  assert.deepEqual(sweepEnded({home: s.home, run: s.run, now: () => readRecord(running.dir).expiresAt + 1}), [running.session]);
  // 호출 폴더가 이 홈의 advice/ 밖을 가리키는 세션은 기록이 있어도 건드리지 않는다.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kso-'));
  s.run(['kill-session', '-t', '=senior-foreign']);
  s.run(['new-session', '-d', '-s', 'senior-elsewhere', 'sleep 600']);
  s.run(['set-option', '-t', '=senior-elsewhere:', '@kadan_senior_dir', outside]);
  fs.writeFileSync(path.join(outside, 'session.json'), JSON.stringify({session: 'senior-elsewhere', dir: outside, endedAt: 'x',
    socket: s.run.socket, askId: 'a', panePid: '1'}));
  assert.deepEqual(sweepEnded({home: s.home, run: s.run}), []);
  assert.ok(s.sessions().includes('senior-elsewhere'));
});
