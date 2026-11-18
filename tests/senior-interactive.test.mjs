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
// 여유는 넉넉히 둔다: CI는 시험 파일을 병렬로 돌려 가짜 화면이 늦게 그릴 수 있다. 기다리는 값은 정상 경로의 시간을 늘리지 않는다.
const TIMING = {...SESSION_TIMING, pollMs: 100, settleMs: 50, startupMs: 30_000, submitGraceMs: 4000, keyGapS: '0.3'};
const models = ['gpt-6-astra', 'gpt-6-sol'].map(slug => ({slug, supported_reasoning_levels: ['low', 'high'].map(effort => ({effort}))}));
const readCodexModels = () => ({models});
const ASTRA = {runner: 'codex', model: 'gpt-6-astra', effort: 'high'}, SOL = {runner: 'codex', model: 'gpt-6-sol', effort: 'low'};
const ARGON = {runner: 'agy', model: 'gemini-4-argon-medium'};
const BOUND = 'agy --agent kadan-noexec --model {model} --print-timeout 90s --output-format json --print {prompt}';
const digest = text => createHash('sha256').update(text).digest('hex');
let seq = 0;

function fixture(t, {seniors = [ASTRA, SOL], mode = null, plan = {}} = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ksi-')));
  const repo = path.join(home, 'repo'), bin = path.join(home, 'bin'), log = path.join(home, 'fake-log');
  for (const dir of [repo, bin, log]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, {mode: 0o755});
  const tmuxLog = path.join(home, 'tmux-calls.log');
  // slow-tmux 파일이 있는 동안은 tmux 호출마다 0.5초 늦춘다(작은 지연 주입: 신호가 tmux 호출 도중에 오는 경우를 만든다).
  // 파일 내용이 trap이면 TERM을 받은 호출이 진짜 tmux 클라이언트처럼 끝난다: 종료 코드 0·출력 없음(2026-11-17 tmux 3.6a 관찰).
  const slowTmux = path.join(home, 'slow-tmux');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${tmuxLog}'\nif [ -e '${slowTmux}' ]; then\n  [ "$(cat '${slowTmux}')" = trap ] && trap 'exit 0' TERM\n  sleep 0.5\nfi\nexec '${REAL_TMUX}' "$@"\n`, {mode: 0o755});
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
  // MCP 허용 목록 파일은 만들지 않는다: 질문 전 관문은 연결된 MCP를 보지 않는다(2026-11-18 [kyle]).
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
  return {home, repo, env, tmux, run, log, tmuxLog, fakeLog, slowTmux, advices: () => readLedger(home).filter(e => e.kind === 'advice'),
    sessions: () => listSeniorSessions(tmux).map(row => row.name)};
}

test('명시한 headless는 기존 호출을 쓰고 잘못된 모드는 거절한다', async t => {
  const f = fixture(t, {seniors: [ASTRA], mode: 'headless'});
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
      ['ok', 'interactive', Buffer.byteLength(a.answer), digest(a.answer), 'skipped', 'window-none']);
    assert.equal(fs.readFileSync(path.join(a.evidencePath, 'result.txt'), 'utf8'), a.answer);
    const record = readRecord(a.evidencePath);
    assert.equal(a.follow, `tmux -L ${f.tmux.socket} attach -r -t '=${record.session}'`);
    assert.match(record.session, new RegExp(`^senior-${r.askId.slice(0, 8)}-${index + 1}$`));
    // 프롬프트: 저장소 절대경로와 안내 파일 읽기를 적고, '현재 작업 폴더가 저장소' 문구는 쓰지 않는다. 완성된 끝 표지는 없다.
    const input = fs.readFileSync(path.join(a.evidencePath, 'input.txt'), 'utf8');
    assert.ok(input.includes(`그 카드의 저장소는 ${f.repo} 이다`)); assert.match(input, /안내 파일\(AGENTS\.md/);
    assert.ok(!input.includes('현재 작업 폴더가 그 카드의 저장소다'));
    assert.ok(input.includes(`--- 첨부 ${note} ---\n첨부 내용`));
    assert.ok(record.marker.startsWith('KADAN-SENIOR-END-') && !input.includes(record.marker), '완성된 표지는 input.txt에 없다');
    assert.ok(fs.readFileSync(path.join(a.evidencePath, 'out', 'result.txt'), 'utf8').includes(record.marker));
    assert.deepEqual(f.fakeLog(a.model, 'submitted'), [ASK_LINE], '/mcp는 넣지 않고 질문 한 줄만 들어갔다');
    assert.equal(fs.existsSync(path.join(f.home, 'senior-mcp-allow')), false, '허용 목록 파일 없이도 질문이 나간다');
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

// 탭을 연 순간을 tmux 호출 기록에 남기는 가짜 로티 호출. 그 줄 뒤에 키 명령이 있으면 '탭이 붙은 뒤에 키를 보낸 것'이다.
const TAB_MARK = '# ROTTIE-CREATE';
const keyCommands = lines => lines.filter(line => /\b(send-keys|paste-buffer|load-buffer)\b/u.test(line));

test('로티 읽기 전용 탭은 질문을 제출한 뒤에 연다(Enter까지 나간 뒤) — 열린 뒤에는 키 0회이고, 탭 생성 실패도 자문을 계속한다', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA]});
  const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const attempts = [];
  const rottie = argv => {
    fs.appendFileSync(f.tmuxLog, `${TAB_MARK}\n`);
    const ask = fs.readdirSync(path.join(f.home, 'advice'))[0];
    const dir = path.join(f.home, 'advice', ask, '1-codex-gpt-6-astra');
    attempts.push({
      verb: argv[1], command: argv[argv.indexOf('--command') + 1], record: readRecord(dir),
      sessions: f.sessions(), submittedMark: fs.existsSync(path.join(dir, 'submitted.json')),
      tmux: fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean)
    });
    throw Object.assign(new Error('시험 탭 생성 실패'), {code: 'ROTTIE_WORKSPACE_NOT_OPEN', effect: 'none'});
  };
  const {answers: [answer]} = await f.run({}, {env, rottie});
  assert.equal(attempts.length, 1);
  const [before] = attempts;
  assert.equal(before.verb, 'create');
  assert.deepEqual(before.sessions, [before.record.session]);
  assert.equal(before.submittedMark, true, '제출 표지가 있어야 탭을 연다');
  const beforeTab = before.tmux.slice(0, before.tmux.indexOf(TAB_MARK));
  assert.ok(beforeTab.some(line => / paste-buffer /u.test(line)), '탭 전에 질문이 붙었다');
  assert.ok(beforeTab.some(line => / send-keys .*Enter$/u.test(line)), '탭 전에 Enter까지 나갔다');
  assert.equal(before.command, `tmux -L ${f.tmux.socket} attach -r -t '=${before.record.session}'`);
  assert.equal(answer.follow, before.command);
  assert.deepEqual([answer.reason, answer.tab, answer.tabReason], ['ok', 'skipped', 'ROTTIE_WORKSPACE_NOT_OPEN']);
  assert.equal(f.advices()[0].tabReason, answer.tabReason);
  // 탭을 연 뒤에는 이 세션에 키를 하나도 보내지 않는다.
  const all = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(keyCommands(all.slice(all.indexOf(TAB_MARK) + 1)), []);
  assert.deepEqual(f.fakeLog(ASTRA.model, 'submitted'), [ASK_LINE]);
});

test('탭이 열린 순간 진짜 읽기 전용 클라이언트가 붙어도(tmux 3.8의 send-keys 거절 조건) 답이 끝까지 오고 키는 하나도 더 나가지 않는다', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA]});
  const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const outer = `${f.tmux.socket}-view`;
  const outerEnv = {...process.env}; delete outerEnv.TMUX; delete outerEnv.TMUX_PANE;
  t.after(() => {
    process.stderr.write(`격리 소켓 kill-server: -L ${outer}\n`);
    spawnSync(REAL_TMUX, ['-L', outer, 'kill-server'], {env: outerEnv});
  });
  const calls = [];
  const clients = [];
  // 로티를 흉내 낸다: create가 오면 60x20 PTY(바깥 격리 tmux)에서 제품이 만든 attach 명령을 그대로 돈다.
  const rottie = argv => {
    calls.push(argv[1]);
    if (argv[1] === 'create') {
      fs.appendFileSync(f.tmuxLog, `${TAB_MARK}\n`);
      const command = argv[argv.indexOf('--command') + 1].replace(/^tmux /u, `${REAL_TMUX} `);
      const view = spawnSync(REAL_TMUX, ['-L', outer, '-f', '/dev/null', 'new-session', '-d', '-s', 'view', '-x', '60', '-y', '20', command],
        {env: outerEnv, encoding: 'utf8'});
      clients.push(view.status);
      return {ok: true, result: {terminal: {id: 'term-1', state: 'running', pid: 4242, workspaceId: 'ws-1'}}, runtime: {build: 'b1'}};
    }
    if (argv[1] === 'show') throw Object.assign(new Error('없다'), {code: 'ROTTIE_TERMINAL_NOT_FOUND', effect: 'none'});
    return {ok: true, result: {}};
  };
  const {answers: [answer]} = await f.run({}, {env, rottie});
  assert.deepEqual(clients, [0]);
  assert.deepEqual([answer.reason, answer.tab, answer.tabReason], ['ok', 'closed', undefined], JSON.stringify(answer));
  assert.deepEqual(calls, ['create', 'close', 'show']);
  assert.deepEqual(f.fakeLog(ASTRA.model, 'submitted'), [ASK_LINE]);
  const all = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean);
  const mark = all.indexOf(TAB_MARK);
  assert.ok(mark > 0);
  assert.equal(all.slice(0, mark).filter(line => / send-keys .*Enter$/u.test(line)).length, 1, '탭 전에 Enter가 한 번 나갔다');
  assert.deepEqual(keyCommands(all.slice(mark + 1)), [], '탭이 붙은 뒤 키 명령 0회');
  assert.equal(f.advices()[0].tab, 'closed');
  assert.deepEqual(f.sessions(), []);
});

// 제출되지 않은 칸(붙인 직후 업데이트 창 → Enter 0회)의 호출 폴더에 거짓 표지를 심는다. 부모는 표지를 읽어 확인하므로 탭을 열지 않는다.
test('거짓 제출 표지(깨진 글·폴더·링크·다른 호출의 표지)가 있어도 제출되지 않은 칸에는 탭을 열지 않고 이유가 남는다(검수 exec-3258d70f)', {skip}, async t => {
  const plant = {
    '깨진 JSON': dir => { fs.writeFileSync(path.join(dir, 'submitted.json'), '{"askId":'); },
    '폴더': dir => { fs.mkdirSync(path.join(dir, 'submitted.json')); },
    '링크': dir => {
      const real = path.join(dir, 'real-marker.json');
      const record = readRecord(dir);
      fs.writeFileSync(real, JSON.stringify({askId: record.askId, session: record.session, panePid: record.panePid, dir}));
      fs.symlinkSync(real, path.join(dir, 'submitted.json'));
    },
    '다른 호출의 표지': dir => {
      const record = readRecord(dir);
      fs.writeFileSync(path.join(dir, 'submitted.json'), JSON.stringify({askId: 'someone-else', session: record.session, panePid: record.panePid, dir}));
    },
  };
  const reasons = {'깨진 JSON': 'bad-json', '폴더': 'not-regular-file', '링크': 'not-regular-file', '다른 호출의 표지': 'other-call'};
  for (const [label, doPlant] of Object.entries(plant)) {
    const f = fixture(t, {seniors: [ASTRA], plan: {default: {afterPaste: 'update', afterPasteOn: 'ask'}}});
    const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
    const calls = [];
    const rottie = argv => { calls.push(argv); throw new Error(`${label}: 제출되지 않은 칸에 탭을 만들면 안 된다`); };
    // 감싼 프로세스를 띄우기 직전에 거짓 표지를 심는다.
    const spawnWith = (command, settings) => {
      doPlant(command.replace(/'$/u, '').split(' ').at(-1).replace(/^'/u, ''));
      return runJudgeProcess(command, settings);
    };
    const error = await f.run({timeout: '60'}, {env, rottie, spawn: spawnWith}).then(() => assert.fail(`${label}: 실패해야 한다`), e => e);
    assert.deepEqual(error.answers.map(a => [a.reason, a.tab, a.tabReason]), [['call-failed', 'skipped', `submitted-mark-${reasons[label]}`]], label);
    assert.deepEqual(calls, [], `${label}: 로티 탭 생성 0회`);
    assert.deepEqual(f.fakeLog(ASTRA.model, 'submitted'), [], `${label}: 질문은 제출되지 않았다`);
    assert.equal(f.advices()[0].tabReason, `submitted-mark-${reasons[label]}`);
  }
});

test('탭이 열린 직후 세션이 끝나도(수용한 틈) 열린 탭은 기존 닫기·지우기로 정리되고 호출은 끝난다', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA]});
  const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const calls = [];
  const rottie = argv => {
    calls.push(argv[1]);
    if (argv[1] === 'create') {
      // 탭을 만드는 순간 세션을 없앤다(판정과 열기 사이에 끝난 것과 같다).
      for (const name of f.sessions()) f.tmux.try(['kill-session', '-t', `=${name}`]);
      return {ok: true, result: {terminal: {id: 'term-1', state: 'running', pid: 4242, workspaceId: 'ws-1'}}, runtime: {build: 'b1'}};
    }
    if (argv[1] === 'show') throw Object.assign(new Error('없다'), {code: 'ROTTIE_TERMINAL_NOT_FOUND', effect: 'none'});
    return {ok: true, result: {}};
  };
  const error = await f.run({timeout: '60'}, {env, rottie}).then(() => assert.fail('세션이 없어졌으니 실패해야 한다'), e => e);
  assert.deepEqual(calls, ['create', 'close', 'show']);
  assert.deepEqual(error.answers.map(a => [a.reason, a.tab]), [['call-failed', 'closed']]);
  assert.deepEqual(f.sessions(), []);
});

test('제출 전에 끝난 칸은 탭을 열지 않는다(not-submitted), 제출 표지를 보기 전에 호출이 끝났으면 열지 않는다(finished-before-open)', {skip}, async t => {
  const calls = [];
  const rottie = argv => { calls.push(argv); throw new Error('이 시험에서는 탭을 만들면 안 된다'); };
  // 붙인 직후 업데이트 창으로 바뀌어 Enter가 나가지 않는다 → 질문은 제출되지 않았다.
  const refused = fixture(t, {seniors: [ASTRA], plan: {default: {afterPaste: 'update', afterPasteOn: 'ask'}}});
  const env = {...refused.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const error = await refused.run({timeout: '60'}, {env, rottie}).then(() => assert.fail('실패해야 한다'), e => e);
  assert.deepEqual(error.answers.map(a => [a.reason, a.tab, a.tabReason]), [['call-failed', 'skipped', 'not-submitted']]);
  assert.deepEqual(calls, []);
  assert.deepEqual(refused.fakeLog(ASTRA.model, 'submitted'), []);
  // 표지를 살피는 간격이 호출보다 길면 호출이 먼저 끝난다: 이미 닫힌 세션에는 탭을 만들지 않는다.
  const quick = fixture(t, {seniors: [ASTRA]});
  const quickEnv = {...quick.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const {answers: [done]} = await quick.run({}, {env: quickEnv, rottie, tabPollMs: 3_600_000});
  assert.deepEqual([done.reason, done.tab, done.tabReason], ['ok', 'skipped', 'finished-before-open']);
  assert.deepEqual(calls, []);
});

test('관문 교차: 한 명이 관문에서 걸리면 통과한 다른 한 명에게도 질문 키가 나가지 않고 둘 다 call-failed로 남는다', {skip}, async t => {
  // 관문에서 걸리는 길은 시작 화면이 업데이트 선택 창인 경우다(키 0회). 연결된 MCP 이름은 이제 관문과 무관하다.
  const f = fixture(t, {plan: {models: {'gpt-6-sol': {startup: 'update'}}}});
  // 로티 탭이 켜져 있어도 관문에서 거절된 칸은 탭을 열지 않는다(검수 exec-276744c7 발견 2).
  const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const rottieCalls = [];
  const rottie = argv => { rottieCalls.push(argv); throw new Error('관문에서 걸린 칸에는 탭을 만들지 않아야 한다'); };
  const error = await f.run({}, {env, rottie, sessionTiming: {...TIMING, startupMs: 1500}}).then(() => assert.fail('실패해야 한다'), e => e);
  assert.deepEqual(rottieCalls, [], '관문 실패 칸에 로티 탭 생성 0회');
  assert.deepEqual(f.advices().map(e => [e.model, e.tab, e.tabReason]).sort(),
    [['gpt-6-astra', 'skipped', 'gate-failed'], ['gpt-6-sol', 'skipped', 'gate-failed']]);
  assert.equal(error.exitCode, 1);
  assert.deepEqual(error.answers.map(a => [a.model, a.reason, a.status]), [
    ['gpt-6-astra', 'call-failed', '실패(call-failed)'], ['gpt-6-sol', 'call-failed', '실패(call-failed)']]);
  assert.equal(error.answers[0].detail, 'isolation:peer-gate-failed');
  assert.match(error.answers[1].detail, /^isolation:startup:/);
  // 둘 다 키를 한 번도 받지 않았다(/mcp도 질문 줄도 없다 — 모델 호출 0회).
  for (const model of ['gpt-6-astra', 'gpt-6-sol']) { assert.deepEqual(f.fakeLog(model, 'submitted'), []); assert.equal(f.fakeLog(model, 'keys').length, 0); }
  assert.deepEqual(f.advices().map(e => [e.model, e.reason]).sort(), [['gpt-6-astra', 'call-failed'], ['gpt-6-sol', 'call-failed']]);
  assert.deepEqual(f.sessions(), []);
});

test('허용 목록 파일이 없고 모르는 MCP가 연결돼 있어도 질문이 나간다. 한도·빈 답은 칸마다 상태로 남고 하나라도 답하면 종료 코드 0이다', {skip}, async t => {
  const noAllow = async () => {
    const none = fixture(t, {seniors: [ASTRA], plan: {default: {mcp: [['codex_worktrees', 'connected', 3], ['fixture-x', 'connected', 1]]}}});
    const ok = await none.run();
    assert.deepEqual(ok.answers.map(a => [a.model, a.status, a.reason]), [['gpt-6-astra', 'ok', 'ok']]);
    assert.equal(fs.existsSync(path.join(none.home, 'senior-mcp-allow')), false);
    assert.deepEqual(none.fakeLog('gpt-6-astra', 'submitted'), [ASK_LINE]);
  };
  const limitAndOk = async () => {
    const mixed = fixture(t, {plan: {models: {'gpt-6-astra': {answer: 'limit'}, 'gpt-6-sol': {answer: 'ok'}}}});
    const r = await mixed.run();
    assert.deepEqual(r.answers.map(a => [a.model, a.status, a.reason]), [['gpt-6-astra', '한도', 'limit'], ['gpt-6-sol', 'ok', 'ok']]);
    assert.ok(!('answer' in r.answers[0]));
  };
  const emptyAnswer = async () => {
    const empty = fixture(t, {seniors: [SOL], plan: {default: {answer: 'marker-only'}}});
    const failed = await empty.run().then(() => assert.fail('실패해야 한다'), e => e);
    assert.deepEqual(failed.answers.map(a => [a.reason, a.detail]), [['empty', 'marker-only']]);
    assert.deepEqual(empty.advices().map(e => [e.reason, e.bytes]), [['empty', 0]]);
  };
  await Promise.all([noAllow(), limitAndOk(), emptyAnswer()]);
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
  for (let i = 0; i < 200 && f.fakeLog('gpt-6-astra', 'submitted').length < 1; i++) await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(f.fakeLog('gpt-6-astra', 'submitted'), [ASK_LINE]);
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
  const error = await f.run({timeout: '60'}, {spawn: (command, settings) => runJudgeProcess(command, {...settings, timeout: 6000})})
    .then(() => assert.fail('실패해야 한다'), e => e);
  assert.deepEqual(error.answers.map(a => [a.reason, a.status]), [['timeout', '실패(timeout)']]);
  const [entry] = f.advices();
  assert.equal(entry.reason, 'timeout');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(entry.evidencePath, 'outcome.json'), 'utf8')), {reason: 'interrupted', detail: 'SIGTERM'});
  assert.equal(readRecord(entry.evidencePath).endReason, 'interrupted', '세션을 끈 것은 감싼 프로세스의 신호 처리기다');
  assert.deepEqual(f.sessions(), []);
  assert.deepEqual(f.fakeLog('gpt-6-astra', 'submitted'), [ASK_LINE], '다시 넣지 않는다');
});

test('시간 상한(F2): 준비·관문이 끝났을 때 상한이 지났으면 질문 프로세스를 띄우지 않고 질문도 넣지 않는다(칸은 timeout)', {skip}, async t => {
  const f = fixture(t);
  // 가짜 시계: 두 시니어의 관문 기록(gate.json)이 모두 생긴 순간부터 시계가 1시간 뒤로 넘어간다(상한 60초).
  const gates = () => { try { return fs.readdirSync(path.join(f.home, 'advice')).flatMap(ask => fs.readdirSync(path.join(f.home, 'advice', ask))
    .filter(name => fs.existsSync(path.join(f.home, 'advice', ask, name, 'gate.json')))).length; } catch { return 0; } };
  const now = () => Date.now() + (gates() >= 2 ? 3_600_000 : 0);
  const launched = [];
  const error = await f.run({timeout: '60'}, {now, spawn: (command, settings) => { launched.push(command); return runJudgeProcess(command, settings); }})
    .then(() => assert.fail('실패해야 한다'), e => e);
  assert.deepEqual(launched, [], '상한이 지난 뒤에는 질문 프로세스를 시작하지 않는다');
  assert.deepEqual(error.answers.map(a => [a.model, a.reason, a.status, a.detail]), [
    ['gpt-6-astra', 'timeout', '실패(timeout)', 'deadline:before-ask'], ['gpt-6-sol', 'timeout', '실패(timeout)', 'deadline:before-ask']]);
  // 관문은 키를 보내지 않으므로 질문 줄은 누구에게도 가지 않았다.
  for (const model of ['gpt-6-astra', 'gpt-6-sol']) assert.deepEqual(f.fakeLog(model, 'submitted'), []);
  assert.deepEqual(f.advices().map(e => e.reason), ['timeout', 'timeout']);
  assert.deepEqual(f.sessions(), []);
});

test('시간 상한: 관문 도중 상한이 끝난 칸은 timeout이고 탭을 열지 않으며 탭 이유는 gate-timeout이다(검수 exec-276744c7 발견 2)', {skip}, async t => {
  const f = fixture(t);
  const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const rottieCalls = [];
  const rottie = argv => { rottieCalls.push(argv); throw new Error('관문에서 시간 초과된 칸에는 탭을 만들지 않아야 한다'); };
  // 가짜 시계: 두 시니어의 문 파일(launch)이 만들어지는 순간(관문 시작)부터 1시간 뒤로 넘어간다 → 관문이 상한을 넘겨 끝난다.
  const launches = () => { try { return fs.readdirSync(path.join(f.home, 'advice')).flatMap(ask => fs.readdirSync(path.join(f.home, 'advice', ask))
    .filter(name => fs.existsSync(path.join(f.home, 'advice', ask, name, 'launch')))).length; } catch { return 0; } };
  const now = () => Date.now() + (launches() >= 1 ? 3_600_000 : 0);
  const error = await f.run({timeout: '60'}, {now, env, rottie}).then(() => assert.fail('실패해야 한다'), e => e);
  assert.deepEqual(error.answers.map(a => [a.model, a.reason]), [['gpt-6-astra', 'timeout'], ['gpt-6-sol', 'timeout']]);
  assert.deepEqual(rottieCalls, [], '관문 시간 초과 칸에 로티 탭 생성 0회');
  assert.deepEqual(f.advices().map(e => [e.model, e.tab, e.tabReason]).sort(),
    [['gpt-6-astra', 'skipped', 'gate-timeout'], ['gpt-6-sol', 'skipped', 'gate-timeout']]);
  for (const model of ['gpt-6-astra', 'gpt-6-sol']) assert.deepEqual(f.fakeLog(model, 'submitted'), []);
  assert.deepEqual(f.sessions(), []);
});

// 감싼 프로세스가 상한에 걸리면 TERM은 프로세스 묶음 전체에 간다. 그때 돌던 tmux 호출이 어떻게 끝나든 칸은 timeout이어야 한다.
// trap: 진짜 tmux 클라이언트처럼 TERM을 받아 스스로 끝난다(종료 코드 0·출력 없음) — 리눅스 CI에서 call-failed로 남았던 경우.
// (그 호출이 신호로 죽는 경우는 tests/senior-session.test.mjs의 단위 시험이 본다. macOS CI 시간을 아끼려고 여기서는 하나만 돌린다.)
for (const mode of ['trap']) {
  test(`감싼 프로세스: 상한의 TERM이 tmux 호출 도중에 와도 죽은 세션으로 읽지 않고 칸은 timeout으로 남는다 (${mode})`, {skip}, async t => {
    const f = fixture(t, {seniors: [ASTRA], plan: {default: {answer: 'working-forever'}}});
    t.after(() => fs.rmSync(f.slowTmux, {force: true}));
    // 폴링 간격을 아주 짧게 두고 tmux 호출을 0.5초씩 늦추면, 감싼 프로세스는 거의 늘 tmux 호출 안에 있다.
    const pending = f.run({timeout: '60'}, {sessionTiming: {...TIMING, pollMs: 10},
      spawn: (command, settings) => runJudgeProcess(command, {...settings, timeout: 6000})}).then(() => assert.fail('실패해야 한다'), e => e);
    for (let i = 0; i < 400 && f.fakeLog('gpt-6-astra', 'submitted').length < 1; i++) await new Promise(r => setTimeout(r, 25));
    fs.writeFileSync(f.slowTmux, mode);
    const error = await pending;
    fs.rmSync(f.slowTmux, {force: true});
    assert.deepEqual(f.fakeLog('gpt-6-astra', 'submitted'), [ASK_LINE]);
    assert.deepEqual(error.answers.map(a => [a.reason, a.status]), [['timeout', '실패(timeout)']]);
    assert.deepEqual(f.advices().map(e => e.reason), ['timeout']);
    assert.deepEqual(f.sessions(), []);
  });
}
