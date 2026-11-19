import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {seniorCommand, seniorEvictedLine, seniorKeptLine} from '../src/senior.mjs';
import {initSettings, setRunner, setRunnerModel, setSeniors} from '../src/runner-settings.mjs';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {ASK_LINE, SESSION_TIMING, cleanupSeniorSessions, listSeniorSessions, readRecord, seniorSocket, seniorTmux} from '../src/senior-session.mjs';
import {OPEN_TABS_DIR, rememberOpenTab} from '../src/senior-tab.mjs';
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
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
let seq = 0;
// 호출이 끝나도 세션은 끄지 않고 남긴다(2026-11-19 [kyle]). 남은 세션이 이번 호출의 것이고 끝난 이유·남긴 시각이 적혔는지 본다.
function assertKept(f, answers, reasons) {
  const records = answers.map(a => readRecord(a.evidencePath));
  assert.deepEqual(f.sessions().sort(), records.map(r => r.session).sort());
  assert.deepEqual(records.map(r => [r.endReason, Boolean(r.endedAt), Boolean(r.keptAt), r.closedAt]), reasons.map(reason => [reason, true, true, undefined]));
}

function fixture(t, {seniors = [ASTRA, SOL], mode = null, plan = {}} = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ksi-')));
  const repo = path.join(home, 'repo'), bin = path.join(home, 'bin'), log = path.join(home, 'fake-log');
  for (const dir of [repo, bin, log]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, {mode: 0o755});
  const tmuxLog = path.join(home, 'tmux-calls.log');
  // slow-tmux 파일이 있는 동안은 tmux 호출마다 0.5초 늦춘다(작은 지연 주입: 신호가 tmux 호출 도중에 오는 경우를 만든다).
  // 파일 내용이 trap이면 TERM을 받은 호출이 진짜 tmux 클라이언트처럼 끝난다: 종료 코드 0·출력 없음(2026-11-17 tmux 3.6a 관찰).
  const slowTmux = path.join(home, 'slow-tmux');
  // blind-tmux 파일이 있는 동안은 세션 소유 조회(이름 칸이 든 display-message)가 실패한다(작은 실패 주입: 호출 끝의 확인을 못 하는 경우).
  const blindTmux = path.join(home, 'blind-tmux');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${tmuxLog}'\nif [ -e '${blindTmux}' ]; then case "$*" in *display-message*session_name*) echo '조회 실패(주입)' >&2; exit 1;; esac; fi\nif [ -e '${slowTmux}' ]; then\n  [ "$(cat '${slowTmux}')" = trap ] && trap 'exit 0' TERM\n  sleep 0.5\nfi\nexec '${REAL_TMUX}' "$@"\n`, {mode: 0o755});
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
  return {home, repo, env, tmux, run, log, tmuxLog, fakeLog, slowTmux, blindTmux, advices: () => readLedger(home).filter(e => e.kind === 'advice'),
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

// 대화형 길은 이제 agy도 부른다(codex + agy 혼합 포함) — tests/senior-agy-command.test.mjs. 헤드리스 길은 반대로 agy가 등록돼 있으면
// 아무도 부르지 않는다.
test('명시한 headless에서 agy가 등록돼 있으면 codex도 부르지 않고 세션·증거 폴더를 만들지 않는다(agy는 대화창으로만)', async t => {
  const f = fixture(t, {seniors: [ASTRA, ARGON], mode: 'headless'});
  await assert.rejects(() => f.run({}, {spawn: async () => assert.fail('부르면 안 된다')}), /헤드리스 시니어.*codex만 부른다.*agy\/gemini-4-argon-medium.*headless-agy/);
  await assert.rejects(() => f.run({model: 'gpt-6-astra'}, {spawn: async () => assert.fail('부르면 안 된다')}), /headless-agy/);
  assert.deepEqual(f.advices(), []);
  assert.equal(fs.existsSync(path.join(f.home, 'advice')), false);
  assert.equal(fs.existsSync(f.tmuxLog), false);
});

test('대화형 성공: 등록된 두 명에게 동시에 묻고 표지 뗀 답·advice·영수증이 같은 글을 가리킨다. 세션은 끄지 않고 남기며(키 0회) 정리 명령이 끈다. 기본 소켓 호출은 0회다', {skip}, async t => {
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
  // 답을 받은 뒤에도 두 세션은 남는다. 영수증에 남긴 수가 있고, 끝 화면도 지금처럼 저장했다.
  assertKept(f, r.answers, ['ok', 'ok']);
  assert.equal(r.keptSessions, 2);
  assert.equal(seniorKeptLine(2), '세션 2개를 남겼다 — 정리: kadan senior cleanup (목록만: kadan senior cleanup --dry-run)');
  for (const a of r.answers) assert.ok(fs.existsSync(path.join(a.evidencePath, 'screen-final.txt')));
  // 원장에는 start·stop이 없다(역할이 아니다).
  assert.deepEqual(readLedger(f.home).filter(e => ['start', 'stop'].includes(e.kind)), []);
  const calls = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.length > 20);
  assert.deepEqual(calls.filter(line => !line.startsWith(`-u -L ${f.tmux.socket} -f `)), []);
  // 키 명령은 시니어마다 질문 한 줄(붙여넣기 1 + Enter 1)뿐이다. 답을 회수한 뒤 남긴 세션에는 하나도 가지 않았다. 예약 종료도 걸지 않는다.
  assert.deepEqual([calls.filter(line => / paste-buffer /u.test(line)).length, calls.filter(line => / send-keys /u.test(line)).length], [2, 2]);
  assert.deepEqual(calls.filter(line => /\brun-shell\b/u.test(line)), []);
  const typed = r.answers.map(a => f.fakeLog(a.model, 'keys').length);
  // 정리 명령(제품 경로 — CLI): --dry-run은 목록만 보이고 아무것도 바꾸지 않는다. 작업자 명의는 거절한다.
  const cli = (args, role = 'qa-슈퍼감독') => spawnSync(process.execPath, [CLI, 'senior', 'cleanup', ...args], {env: {...f.env, KADAN_ROLE: role}, encoding: 'utf8'});
  const records = r.answers.map(a => readRecord(a.evidencePath));
  const dry = cli(['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  for (const [index, record] of records.entries()) {
    const line = dry.stdout.split('\n').find(text => text.includes(record.session));
    assert.equal(line, [`끌 것  ${record.session}`, `codex/${r.answers[index].model}`, `만든 ${record.createdAt}`, '끝 ok', `남긴 ${record.keptAt}`, record.dir].join('  '));
  }
  assert.match(dry.stdout, /--dry-run: 아무것도 바꾸지 않았다\. 끌 세션 2개, 둘 세션 0개/);
  assertKept(f, r.answers, ['ok', 'ok']);
  // 이 명령이 모르는 인자·표기는 아무것도 끄지 않고 거절한다 — --dry-run=true가 실제 정리로 빠지지 않는다(2026-11-19 검수 발견 1).
  for (const args of [['--dry-run=true'], ['--dry-run', 'true'], ['--dry-run=false'], ['--force'], ['--dry-run', '--all'], ['--dryrun'], ['extra']]) {
    const bad = cli(args);
    assert.equal(bad.status, 1, args.join(' '));
    assert.match(bad.stderr, /--dry-run 하나만 받는다 — 알 수 없는 인자: .*아무것도 끄지 않았다/u, args.join(' '));
    assert.equal(bad.stdout, '', args.join(' '));
  }
  assertKept(f, r.answers, ['ok', 'ok']);
  const denied = cli([], 'qa-작업자');
  assert.equal(denied.status, 1); assert.match(denied.stderr, /감독\(일반감독·슈퍼감독\) 또는 사람 명의로만/);
  assert.equal(f.sessions().length, 2);
  const mark = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean).length;
  const done = cli([]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /끈 세션 2개, 둔 세션 0개/);
  assert.deepEqual(f.sessions(), []);
  assert.deepEqual(r.answers.map(a => readRecord(a.evidencePath).closeReason), ['cleanup', 'cleanup']);
  // 정리 명령이 쓴 tmux 명령은 목록·조회·세션 끄기뿐이고, 남긴 세션의 화면이 받은 입력은 늘지 않았다.
  const after = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean).slice(mark);
  assert.deepEqual(after.filter(line => !/ (list-sessions|display-message|kill-session) /u.test(line)), []);
  assert.deepEqual(r.answers.map(a => f.fakeLog(a.model, 'keys').length), typed);
  assert.match(cli([]).stdout, /남은 시니어 세션이 없다/);
  // 영수증 아래의 남김 안내 줄은 CLI가 붙인다(남긴 수가 있을 때만).
  assert.ok(fs.readFileSync(CLI, 'utf8').includes('if(rest.keptSessions)console.log(seniorKeptLine(rest.keptSessions));'));
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
  // 탭은 세션과 함께 남긴다(닫지 않는다).
  assert.deepEqual([answer.reason, answer.tab, answer.tabReason], ['ok', 'opened', undefined], JSON.stringify(answer));
  assert.deepEqual(calls, ['create']);
  assert.deepEqual(f.fakeLog(ASTRA.model, 'submitted'), [ASK_LINE]);
  const all = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean);
  const mark = all.indexOf(TAB_MARK);
  assert.ok(mark > 0);
  assert.equal(all.slice(0, mark).filter(line => / send-keys .*Enter$/u.test(line)).length, 1, '탭 전에 Enter가 한 번 나갔다');
  assert.deepEqual(keyCommands(all.slice(mark + 1)), [], '탭이 붙은 뒤 키 명령 0회');
  assert.deepEqual([f.advices()[0].tab, f.advices()[0].rottieTerminalId], ['opened', 'term-1']);
  assertKept(f, [answer], ['ok']);
  const tabFile = path.join(answer.evidencePath, 'tab.json');
  assert.deepEqual([JSON.parse(fs.readFileSync(tabFile, 'utf8')).state, JSON.parse(fs.readFileSync(tabFile, 'utf8')).rottieTerminalId], ['opened', 'term-1']);
  // 정리 명령: 창 설정이 none이면 세션만 끄고 탭은 닫지 못한 이유를 보인다(로티 호출 0회). --dry-run은 탭도 건드리지 않는다.
  const cleanup = (flags, more) => seniorCommand(['cleanup'], flags, {home: f.home, by: 'qa-슈퍼감독', env, rottie, ...more});
  assert.match(await cleanup({'dry-run': true}), /끌 세션 1개/);
  assert.deepEqual(calls, ['create']);
  assert.equal(JSON.parse(fs.readFileSync(tabFile, 'utf8')).state, 'opened');
  // 본 실행: 세션을 끄고 그 호출 폴더의 tab.json에 열린 자기 탭을 기존 닫기(close → show)로 닫는다. 키는 끝까지 0회다.
  const done = await cleanup({});
  assert.match(done, /끔 {2}senior-.*— 탭 closed/u);
  assert.deepEqual(calls, ['create', 'close', 'show']);
  assert.equal(JSON.parse(fs.readFileSync(tabFile, 'utf8')).state, 'closed');
  assert.deepEqual(f.sessions(), []);
  assert.deepEqual(keyCommands(fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean).slice(mark + 1)), [], '정리까지 키 명령 0회');
  const markers = () => { try { return fs.readdirSync(path.join(f.home, OPEN_TABS_DIR)); } catch { return []; } };
  assert.deepEqual(markers(), [], '닫힌 탭의 표지는 지운다');
  // 로티 실행 파일이 없는 환경에서 정리하면 세션만 끄고 탭은 닫지 못한 이유를 보인다(로티 호출 0회). 표지가 남아 다음 정리가 다시 닫는다.
  const again = await f.run({}, {env, rottie});
  assert.equal(again.answers[0].tab, 'opened');
  assert.equal(markers().length, 1, '대화형 호출이 탭을 열면 표지를 둔다');
  const before = calls.length;
  const {KADAN_ROTTIE_BIN: bin, ...noBin} = env;
  assert.match(await cleanup({}, {env: noBin}), /— 탭 close-skipped\(rottie-bin-missing\) · 다음 cleanup이 다시 닫는다/);
  assert.equal(calls.length, before); assert.deepEqual(f.sessions(), []); assert.equal(markers().length, 1);
  // 탭 스위치가 꺼져 있고 창 설정이 none이어도, 실행 파일이 있으면 전에 연 자기 탭은 닫는다(세션은 이미 없다 — 표지로 찾는다).
  const later = await cleanup({}, {env: {...env, KADAN_SENIOR_TAB: 'off', KADAN_WINDOW: 'none'}});
  assert.match(later, /탭 닫음 {2}\(세션 없음\) {2}탭 term-1 {2}/u);
  assert.match(later, /끈 세션 0개, 둔 세션 0개 · 세션 줄 밖의 탭: 닫음 1개, 남음 0개/);
  assert.deepEqual(calls.slice(before), ['close', 'show']); assert.deepEqual(markers(), []);
});

test('남긴 세션을 내보낼 때 탭은 탭 스위치와 무관하게 자기 탭 id로 닫고 결과를 영수증에 싣는다. 닫지 못한 탭은 세션이 없어도 다음 정리 명령이 표지로 찾아 닫는다(검수 발견 2)', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA]});
  // 검수자 재현과 같은 꼴: 끝난 호출의 세션 6개와 열린 탭 기록을 심는다(표지는 없다 — 제품의 탭 열기 길을 지나지 않은 탭).
  const seed = n => {
    const name = `senior-old-${n}`, ask = `ask-old-${n}`, dir = path.join(f.home, 'advice', ask, '1-codex-old');
    fs.mkdirSync(dir, {recursive: true});
    f.tmux(['new-session', '-d', '-s', name, 'exec /bin/sleep 300']);
    f.tmux(['set-option', '-t', `=${name}:`, '@kadan_senior_ask', ask]);
    f.tmux(['set-option', '-t', `=${name}:`, '@kadan_senior_dir', dir]);
    const panePid = f.tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_pid}']).trim();
    const at = new Date(Date.UTC(2026, 10, 19, 0, n)).toISOString();
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({session: name, dir, runner: 'codex', home: f.home, socket: f.tmux.socket, askId: ask,
      panePid, ownerPid: process.pid, expiresAt: Date.now() + 600_000, model: 'old', createdAt: at, endedAt: at, keptAt: at, endReason: 'ok'}));
    fs.writeFileSync(path.join(dir, 'tab.json'), JSON.stringify({state: 'opened', rottieTerminalId: `old-${n}`}));
    return {name, dir};
  };
  const old = [0, 1, 2, 3, 4, 5].map(seed);
  const base = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const calls = [];
  let made = 0, failClose = false;
  const rottie = argv => {
    if (argv[1] === 'create') return {ok: true, result: {terminal: {id: `new-${++made}`, state: 'running', pid: 4242, workspaceId: 'ws-1'}}, runtime: {build: 'b1'}};
    calls.push([argv[1], argv[argv.indexOf('--terminal') + 1]]);
    if (argv[1] === 'close' && failClose) throw Object.assign(new Error('닫기 실패(주입)'), {code: 'ROTTIE_INTERNAL', effect: 'unknown'});
    if (argv[1] === 'show') throw Object.assign(new Error('없다'), {code: 'ROTTIE_TERMINAL_NOT_FOUND', effect: 'none'});
    return {ok: true, result: {}};
  };
  const tab = dir => JSON.parse(fs.readFileSync(path.join(dir, 'tab.json'), 'utf8'));
  const markers = () => { try { return fs.readdirSync(path.join(f.home, OPEN_TABS_DIR)).sort(); } catch { return []; } };
  const cleanup = (flags, env) => seniorCommand(['cleanup'], flags, {home: f.home, by: 'qa-슈퍼감독', env, rottie});
  // (1) 탭 스위치를 끈 호출(6 + 1 > 6 → 가장 오래된 old-0을 내보낸다): 스위치는 새 탭을 여는 값이다 — 전에 연 자기 탭은 닫는다.
  const r1 = await f.run({}, {env: {...base, KADAN_SENIOR_TAB: 'off'}, rottie});
  assert.deepEqual([r1.answers[0].reason, r1.answers[0].tab, r1.answers[0].tabReason], ['ok', 'skipped', 'tab-off']);
  assert.deepEqual(r1.evicted, [{session: 'senior-old-0', tab: 'closed'}]);
  assert.deepEqual(calls, [['close', 'old-0'], ['show', 'old-0']]);
  assert.equal(tab(old[0].dir).state, 'closed'); assert.ok(!f.sessions().includes('senior-old-0'));
  assert.equal(seniorEvictedLine(r1.evicted), '남긴 세션 상한(6개)을 넘겨 오래된 세션 1개를 껐다: senior-old-0(탭 닫음)');
  assert.deepEqual(markers(), []);
  // (2) 닫기가 실패한 호출(old-1): 결과와 이유를 영수증에 싣고 표지를 남긴다. 세션은 이미 없다.
  failClose = true;
  const r2 = await f.run({}, {env: base, rottie});
  failClose = false;
  assert.deepEqual(r2.evicted, [{session: 'senior-old-1', tab: 'close-failed', tabReason: 'ROTTIE_INTERNAL'}]);
  assert.match(seniorEvictedLine(r2.evicted), /senior-old-1\(탭 close-failed: ROTTIE_INTERNAL — 다음 kadan senior cleanup이 다시 닫는다\)/);
  assert.ok(!f.sessions().includes('senior-old-1'));
  assert.deepEqual([tab(old[1].dir).state, tab(old[1].dir).rottieTerminalId], ['close-failed', 'old-1'], '탭 id는 남아 다시 닫아 볼 수 있다');
  assert.deepEqual(markers(), ['ask-old-1--1-codex-old.json', `${r2.askId}--1-codex-gpt-6-astra.json`].sort(), '닫지 못한 탭과 이번에 연 탭의 표지');
  // (3) 로티 실행 파일이 없는 호출(old-2): 건너뛴 이유를 싣고 표지를 남긴다.
  const {KADAN_ROTTIE_BIN: bin, ...noBin} = base;
  const r3 = await f.run({}, {env: noBin, rottie});
  assert.deepEqual(r3.evicted, [{session: 'senior-old-2', tab: 'close-skipped', tabReason: 'rottie-bin-missing'}]);
  assert.equal(tab(old[2].dir).state, 'opened'); assert.ok(markers().includes('ask-old-2--1-codex-old.json'));
  // (4) 미리보기: 세션 없이 남은 탭 둘을 '닫을 것'으로 보이고 아무것도 바꾸지 않는다(로티 호출 0회, 표지·탭 기록 그대로).
  const count = calls.length, kept = markers();
  const dry = await cleanup({'dry-run': true}, base);
  assert.match(dry, /탭 닫을 것 {2}\(세션 없음\) {2}탭 old-1 {2}/u); assert.match(dry, /탭 닫을 것 {2}\(세션 없음\) {2}탭 old-2 {2}/u);
  assert.match(dry, /끌 세션 6개, 둘 세션 0개 · 세션 줄 밖의 탭: 닫을 것 2개, 둘 것 0개/);
  assert.equal(calls.length, count); assert.deepEqual(markers(), kept); assert.equal(f.sessions().length, 6);
  // (4-1) 같은 홈을 다른 소켓으로 정리해도 이 소켓의 탭은 닫지 않는다(표지는 홈마다, 세션 목록은 소켓마다다). 살아 있는 세션의 탭도 그대로다.
  const elsewhere = await cleanup({}, {...base, KADAN_SOCKET: `${f.env.KADAN_SOCKET}o`});
  assert.match(elsewhere, /끈 세션 0개, 둔 세션 0개 · 세션 줄 밖의 탭: 닫음 0개, 남음 3개/);
  assert.match(elsewhere, /닫지 않음: 다른 소켓의 세션 기록/);
  assert.equal(calls.length, count); assert.deepEqual(markers(), kept); assert.equal(f.sessions().length, 6);
  // (5) 운영 로티 보호는 그대로다: 기본이 아닌 홈 + 허용 플래그 없음이면 창 none·실행 파일 있음이어도 로티를 부르지 않는다.
  //     세션은 끄고, 닫지 못한 탭은 모두 표지로 남는다.
  const guarded = await cleanup({}, {...f.env, KADAN_WINDOW: 'none', KADAN_ROTTIE_BIN: '/fake/rottie'});
  assert.equal(calls.length, count, '보호에 걸리면 로티 호출 0회');
  assert.match(guarded, /끈 세션 6개, 둔 세션 0개 · 세션 줄 밖의 탭: 닫음 0개, 남음 2개/);
  assert.match(guarded, /— 탭 close-skipped\(KADAN_LIVE_FLOOR_DENIED\) · 다음 cleanup이 다시 닫는다/);
  assert.deepEqual(f.sessions(), []);
  assert.equal(markers().length, 6, 'old-1·old-2와 방금 끈 세션의 열린 탭 넷(old-3·4·5, 둘째 호출의 탭)');
  // (6) 다음 정리: 세션이 하나도 없어도 표지로 찾아 전부 닫는다(닫기에 실패했던 old-1 포함). 키 명령은 끝까지 새 세션의 질문뿐이다.
  const done = await cleanup({}, base);
  assert.match(done, /끈 세션 0개, 둔 세션 0개 · 세션 줄 밖의 탭: 닫음 6개, 남음 0개/);
  assert.deepEqual(calls.slice(count).filter(([verb]) => verb === 'close').map(([, id]) => id).sort(), ['new-1', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5']);
  assert.deepEqual(markers(), []);
  assert.deepEqual(old.map(item => tab(item.dir).state), Array(6).fill('closed'));
  const lines = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual([lines.filter(line => / paste-buffer /u.test(line)).length, lines.filter(line => / send-keys /u.test(line)).length], [3, 3]);
  assert.match(await cleanup({}, base), /남은 시니어 세션이 없다/);
});

test('세션 목록의 경로 칸이 빈 살아 있는 세션의 탭은 닫지 않는다 — 세션이 없다는 것은 기록의 세션 이름으로 직접 조회해 확정됐을 때만이다(재검수 발견 1)', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA]});
  const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const calls = [];
  const rottie = argv => { calls.push([argv[1], argv[argv.indexOf('--terminal') + 1]]); if (argv[1] === 'show') throw Object.assign(new Error('없다'), {code: 'ROTTIE_TERMINAL_NOT_FOUND', effect: 'none'}); return {ok: true, result: {}}; };
  const cleanup = flags => seniorCommand(['cleanup'], flags, {home: f.home, by: 'qa-슈퍼감독', env, rottie});
  // 도는 호출의 세션 하나(끝남 기록 없음, 부른 프로세스 살아 있음)와 열린 탭·표지.
  const seed = (n, more = {}) => {
    const name = `senior-live-${n}`, ask = `ask-live-${n}`, dir = path.join(f.home, 'advice', ask, '1-codex-m');
    fs.mkdirSync(dir, {recursive: true});
    f.tmux(['new-session', '-d', '-s', name, 'exec /bin/sleep 300']);
    f.tmux(['set-option', '-t', `=${name}:`, '@kadan_senior_ask', ask]);
    f.tmux(['set-option', '-t', `=${name}:`, '@kadan_senior_dir', dir]);
    const panePid = f.tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_pid}']).trim();
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({session: name, dir, runner: 'codex', home: f.home, socket: f.tmux.socket, askId: ask,
      panePid, ownerPid: process.pid, expiresAt: Date.now() + 600_000, model: 'm', createdAt: new Date().toISOString(), ...more}));
    fs.writeFileSync(path.join(dir, 'tab.json'), JSON.stringify({state: 'opened', rottieTerminalId: `tab-${n}`}));
    rememberOpenTab(f.home, dir, `tab-${n}`);
    return {name, dir};
  };
  const live = seed(1);
  assert.match(await cleanup({}), /둠 {2}senior-live-1 .*끄지 않음: 진행 중인 호출/u);
  assert.deepEqual(calls, []);
  // 세션 옵션의 호출 폴더 칸이 비었다: 목록으로는 '기록 없음' 세션이고, 그 호출 폴더는 목록의 어느 세션과도 이어지지 않는다.
  f.tmux(['set-option', '-u', '-t', `=${live.name}:`, '@kadan_senior_dir']);
  for (const flags of [{'dry-run': true}, {}]) {
    const out = await cleanup(flags);
    assert.match(out, /둠 {2}senior-live-1 {2}\(기록 없음\)/u);
    assert.match(out, /탭 둠 {2}\(세션 줄 밖의 탭\) {2}탭 tab-1 .*닫지 않음: 그 이름의 세션이 살아 있다\(진행 중으로 본다\)/u);
    assert.doesNotMatch(out, /탭 닫음|탭 닫을 것/u);
  }
  assert.deepEqual(calls, [], '살아 있는 세션의 탭에 로티 호출 0회');
  assert.deepEqual(f.sessions(), [live.name]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(live.dir, 'tab.json'), 'utf8')).state, 'opened');
  assert.equal(fs.readdirSync(path.join(f.home, OPEN_TABS_DIR)).length, 1, '표지도 그대로다');
  // 기록의 PID가 달라도(같은 이름의 세션이 있다) 탭을 둔다.
  const moved = seed(2, {panePid: '1'});
  f.tmux(['set-option', '-u', '-t', `=${moved.name}:`, '@kadan_senior_dir']);
  assert.match(await cleanup({}), /탭 tab-2 .*닫지 않음: 그 이름의 세션이 살아 있다/u);
  assert.deepEqual(calls, []);
  // 세션이 실제로 없어지면(이름으로 조회해 없음이 확정) 그때 닫는다. 살아 있는 다른 세션의 탭은 그대로다.
  f.tmux(['kill-session', '-t', `=${live.name}`]);
  const after = await cleanup({});
  assert.match(after, /탭 닫음 {2}\(세션 없음\) {2}탭 tab-1 {2}/u); assert.match(after, /탭 둠 .*탭 tab-2 /u);
  assert.deepEqual(calls, [['close', 'tab-1'], ['show', 'tab-1']]);
  assert.ok(!fs.readFileSync(f.tmuxLog, 'utf8').split('\n').some(line => / (send-keys|paste-buffer|kill-session) .*senior-live-2/u.test(line)), '남은 세션에는 키도 끄기도 없다');
});

test('탭 기록(tab.json)을 한 번 읽지 못해도 표지를 지우지 않는다 — 이유를 보이고, 기록이 돌아오면 다음 정리가 그 탭을 닫는다(재검수 발견 2)', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA]});
  const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const calls = [];
  const rottie = argv => { calls.push([argv[1], argv[argv.indexOf('--terminal') + 1]]); if (argv[1] === 'show') throw Object.assign(new Error('없다'), {code: 'ROTTIE_TERMINAL_NOT_FOUND', effect: 'none'}); return {ok: true, result: {}}; };
  const cleanup = flags => seniorCommand(['cleanup'], flags, {home: f.home, by: 'qa-슈퍼감독', env, rottie});
  // 세션이 이미 없는 호출의 열린 탭과 표지(세션 기록은 이 소켓의 것이다).
  const dir = path.join(f.home, 'advice', 'ask-gone', '1-codex-m');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({session: 'senior-gone-1', dir, runner: 'codex', home: f.home, socket: f.tmux.socket,
    askId: 'ask-gone', panePid: '1', ownerPid: 2 ** 22 + 12345, expiresAt: 1, model: 'm', endedAt: 'x'}));
  const tabFile = path.join(dir, 'tab.json'), good = JSON.stringify({state: 'opened', rottieTerminalId: 'tab-gone'});
  fs.writeFileSync(tabFile, good);
  rememberOpenTab(f.home, dir, 'tab-gone');
  const markers = () => fs.readdirSync(path.join(f.home, OPEN_TABS_DIR));
  // 다른 프로세스가 쓰는 도중처럼 반쯤 쓴 기록이 보였다.
  fs.writeFileSync(tabFile, '{');
  for (const flags of [{'dry-run': true}, {}]) {
    const out = await cleanup(flags);
    assert.match(out, /탭 둠 {2}\(세션 줄 밖의 탭\) {2}탭 tab-gone .*닫지 않음: 탭 기록이 깨짐/u);
    assert.match(out, /세션 줄 밖의 탭: (닫을 것|닫음) 0개, (둘 것|남음) 1개/u);
  }
  assert.deepEqual(calls, []); assert.deepEqual(markers(), ['ask-gone--1-codex-m.json'], '표지를 지우지 않는다');
  assert.equal(fs.readFileSync(tabFile, 'utf8'), '{', '읽지 못한 기록을 덮어쓰지 않는다');
  // 기록이 돌아오면 다음 정리가 닫고 표지를 지운다.
  fs.writeFileSync(tabFile, good);
  assert.match(await cleanup({}), /탭 닫음 {2}\(세션 없음\) {2}탭 tab-gone {2}/u);
  assert.deepEqual(calls, [['close', 'tab-gone'], ['show', 'tab-gone']]); assert.deepEqual(markers(), []);
  assert.equal(JSON.parse(fs.readFileSync(tabFile, 'utf8')).state, 'closed');
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), [], '임시 파일이 남지 않는다');
});

test('닫힘 기록이어도 탭 id가 없거나 형식이 틀리거나 표지와 다르면 표지를 지우지 않는다 — 이유를 보이고, 기록이 돌아오면 그 탭을 닫는다. 같은 id의 닫힘만 표지를 지운다(재검수 2)', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA]});
  const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const calls = [];
  const rottie = argv => { calls.push([argv[1], argv[argv.indexOf('--terminal') + 1]]); if (argv[1] === 'show') throw Object.assign(new Error('없다'), {code: 'ROTTIE_TERMINAL_NOT_FOUND', effect: 'none'}); return {ok: true, result: {}}; };
  const cleanup = flags => seniorCommand(['cleanup'], flags, {home: f.home, by: 'qa-슈퍼감독', env, rottie});
  const markers = () => { try { return fs.readdirSync(path.join(f.home, OPEN_TABS_DIR)).sort(); } catch { return []; } };
  // 끝난 호출의 세션(살려 둘지 끌지는 사례마다 정한다)과 열린 탭·표지.
  const seed = (n, alive) => {
    const name = `senior-shape-${n}`, ask = `ask-shape-${n}`, dir = path.join(f.home, 'advice', ask, '1-codex-m');
    fs.mkdirSync(dir, {recursive: true});
    f.tmux(['new-session', '-d', '-s', name, 'exec /bin/sleep 300']);
    f.tmux(['set-option', '-t', `=${name}:`, '@kadan_senior_ask', ask]);
    f.tmux(['set-option', '-t', `=${name}:`, '@kadan_senior_dir', dir]);
    const panePid = f.tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_pid}']).trim();
    const at = new Date(Date.UTC(2026, 10, 19, 0, n)).toISOString();
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({session: name, dir, runner: 'codex', home: f.home, socket: f.tmux.socket, askId: ask,
      panePid, ownerPid: process.pid, expiresAt: Date.now() + 600_000, model: 'm', createdAt: at, endedAt: at, keptAt: at, endReason: 'ok'}));
    fs.writeFileSync(path.join(dir, 'tab.json'), JSON.stringify({state: 'opened', rottieTerminalId: `tab-${n}`}));
    rememberOpenTab(f.home, dir, `tab-${n}`);
    if (!alive) f.tmux(['kill-session', '-t', `=${name}`]);
    return {name, dir, tabFile: path.join(dir, 'tab.json'), marker: `${ask}--1-codex-m.json`};
  };
  f.tmux(['start-server', ';', 'set-option', '-s', 'exit-empty', 'off']); // 마지막 세션을 끈 뒤에도 같은 소켓에서 다음 사례를 잇는다
  // (가) 표지 훑기: 세션이 이미 없는 탭. 재검수 재현의 세 경우.
  const samples = [[{state: 'closed'}, '탭 기록에 탭 id가 없음'], [{state: 'closed', rottieTerminalId: ['tab-2']}, '탭 기록의 탭 id 형식이 다름'],
    [{state: 'closed', rottieTerminalId: 'different-tab'}, '표지의 탭 id가 탭 기록과 다름']];
  for (const [index, [sample, reason]] of samples.entries()) {
    const seat = seed(index + 1, false);
    const good = fs.readFileSync(seat.tabFile, 'utf8'), before = calls.length;
    fs.writeFileSync(seat.tabFile, JSON.stringify(sample));
    for (const flags of [{'dry-run': true}, {}]) {
      const out = await cleanup(flags);
      assert.ok(out.includes(`탭 둠  (세션 줄 밖의 탭)  탭 tab-${index + 1}  ${seat.dir}  — 닫지 않음: ${reason}`), out);
    }
    assert.equal(calls.length, before, '닫힘 기록으로는 로티를 부르지 않는다');
    assert.ok(markers().includes(seat.marker), `${reason}: 표지를 지우지 않는다`);
    // 원래의 열린 탭 기록이 돌아오면 다음 정리가 그 탭을 닫고 표지를 지운다.
    fs.writeFileSync(seat.tabFile, good);
    assert.ok((await cleanup({})).includes(`탭 닫음  (세션 없음)  탭 tab-${index + 1}  `));
    assert.deepEqual(calls.slice(before), [['close', `tab-${index + 1}`], ['show', `tab-${index + 1}`]]);
    assert.ok(!markers().includes(seat.marker));
  }
  // (나) 세션 줄에서 바로 정리하는 길: 끝난 호출의 살아 있는 세션을 끄면서 그 탭 기록이 '다른 탭의 닫힘'이면 표지를 남기고 이유를 보인다.
  const kept = seed(4, true), mark = calls.length;
  fs.writeFileSync(kept.tabFile, JSON.stringify({state: 'closed', rottieTerminalId: 'different-tab'}));
  const closing = await cleanup({});
  assert.match(closing, /끔 {2}senior-shape-4 .*— 탭 닫지 않음: 표지의 탭 id가 탭 기록과 다름 · 표지는 그대로다/u);
  // 내보내기 안내 줄도 같다: 믿을 수 없어 닫지 않은 탭에는 '다시 닫는다'고 약속하지 않는다(닫아 보다 못 닫은 탭에만 한다).
  assert.equal(seniorEvictedLine([{session: 's-1', tab: 'close-skipped', tabReason: 'tab-id-differs'}, {session: 's-2', tab: 'close-skipped', tabReason: 'tab-record-bad-json'},
    {session: 's-3', tab: 'close-failed', tabReason: 'ROTTIE_INTERNAL'}, {session: 's-4', tab: 'closed'}, {session: 's-5'}]),
    '남긴 세션 상한(6개)을 넘겨 오래된 세션 5개를 껐다: s-1(탭 닫지 않음: 표지의 탭 id가 탭 기록과 다름 — 표지는 그대로다), s-2(탭 닫지 않음: 탭 기록이 깨짐 — 표지는 그대로다), ' +
    's-3(탭 close-failed: ROTTIE_INTERNAL — 다음 kadan senior cleanup이 다시 닫는다), s-4(탭 닫음), s-5(탭 없음)');
  assert.equal(calls.length, mark); assert.ok(markers().includes(kept.marker)); assert.ok(!f.sessions().includes(kept.name));
  fs.writeFileSync(kept.tabFile, JSON.stringify({state: 'opened', rottieTerminalId: 'tab-4'}));
  assert.ok((await cleanup({})).includes('탭 닫음  (세션 없음)  탭 tab-4  '));
  assert.deepEqual(calls.slice(mark), [['close', 'tab-4'], ['show', 'tab-4']]); assert.deepEqual(markers(), []);
  // (다) 반대 대조: 표지와 같은 id의 닫힘은 로티를 부르지 않고 표지를 지운다 — 훑기와 세션 줄 길 모두.
  const same = seed(5, false), sameKept = seed(6, true), count = calls.length;
  fs.writeFileSync(same.tabFile, JSON.stringify({state: 'closed', rottieTerminalId: 'tab-5'}));
  fs.writeFileSync(sameKept.tabFile, JSON.stringify({state: 'closed', rottieTerminalId: 'tab-6'}));
  assert.match(await cleanup({'dry-run': true}), /끌 세션 1개, 둘 세션 0개$/u);
  assert.equal(markers().length, 2, '미리보기는 표지를 지우지 않는다');
  assert.match(await cleanup({}), /끈 세션 1개, 둔 세션 0개$/u);
  assert.equal(calls.length, count, '같은 id의 닫힘에는 로티 호출 0회'); assert.deepEqual(markers(), []);
});

test('정리 명령 --dry-run은 빈 홈에서도 파일을 하나도 만들지 않는다(검수 발견 3)', {skip}, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kse-')));
  const env = {...process.env, KADAN_HOME: home, KADAN_SOCKET: `ke${process.pid}x${++seq}`, KADAN_ROLE: 'qa-슈퍼감독'};
  const out = spawnSync(process.execPath, [CLI, 'senior', 'cleanup', '--dry-run'], {env, encoding: 'utf8'});
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /남은 시니어 세션이 없다/);
  assert.deepEqual(fs.readdirSync(home), [], 'tmux 설정 파일·표지 폴더·잠금 어느 것도 만들지 않는다');
});

test('영수증의 남긴 세션 수는 호출이 끝나는 시점의 실제 상태다 — 한 칸이 먼저 끝난 뒤 다른 정리가 그 세션을 꺼도 맞다(검수 발견 4)', {skip}, async t => {
  const f = fixture(t, {plan: {models: {'gpt-6-sol': {workMs: 5000}}}});
  // 먼저 답한 칸을 원장에 적는 순간 다른 정리가 돈다: 끝난 그 칸의 세션만 끄고 아직 도는 칸은 둔다.
  let crossed = null;
  const record = entry => { appendLedger(entry, f.home); crossed ??= cleanupSeniorSessions({home: f.home, run: f.tmux}); };
  const r = await f.run({timeout: '60'}, {record});
  assert.deepEqual(r.answers.map(a => [a.model, a.reason]), [['gpt-6-astra', 'ok'], ['gpt-6-sol', 'ok']]);
  const sessions = r.answers.map(a => readRecord(a.evidencePath).session);
  assert.deepEqual(Object.fromEntries(crossed.map(row => [row.session, row.action === 'left' ? row.why : row.action])), {[sessions[0]]: 'closed', [sessions[1]]: 'running'});
  assert.deepEqual(f.sessions(), [sessions[1]]);
  assert.equal(r.keptSessions, 1, '이미 꺼진 세션을 남겼다고 세지 않는다');
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

test('탭이 열린 직후 세션이 사라지면(수용한 틈) 남길 세션이 없으므로 열린 탭은 기존 닫기·지우기로 정리되고 호출은 끝난다', {skip}, async t => {
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
  assert.equal(error.keptSessions, 0); assert.ok(!error.message.includes('남겼다'), '남은 세션이 없으면 안내 줄도 없다');
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
  // 관문에서 걸린 호출의 세션도 남긴다(무엇이 떴는지 화면으로 본다). 전원 실패로 끝나는 길에도 남김 안내 줄이 있다. 남긴 뒤에도 키는 0회다.
  assertKept(f, error.answers, ['call-failed', 'call-failed']);
  assert.equal(error.keptSessions, 2); assert.ok(error.message.endsWith(seniorKeptLine(2)));
  for (const model of ['gpt-6-astra', 'gpt-6-sol']) assert.equal(f.fakeLog(model, 'keys').length, 0);
  assert.deepEqual(keyCommands(fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean)), []);
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
    // 한도로 끝난 칸의 세션도 남는다(한도 화면을 직접 본다).
    assertKept(mixed, r.answers, ['limit', 'ok']);
    assert.equal(r.keptSessions, 2);
  };
  const emptyAnswer = async () => {
    const empty = fixture(t, {seniors: [SOL], plan: {default: {answer: 'marker-only'}}});
    const failed = await empty.run().then(() => assert.fail('실패해야 한다'), e => e);
    assert.deepEqual(failed.answers.map(a => [a.reason, a.detail]), [['empty', 'marker-only']]);
    assert.deepEqual(empty.advices().map(e => [e.reason, e.bytes]), [['empty', 0]]);
    assertKept(empty, failed.answers, ['empty']);
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

test('호출 끝에 세션을 확인하지 못하면(조회 실패) 끄지도 탭을 닫지도 않고 남긴 수에만 넣지 않는다 — 살아 있는 세션은 정리 명령이 나중에 끈다', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA]});
  const env = {...f.env, KADAN_WINDOW: 'rottie', KADAN_ROTTIE_BIN: '/fake/rottie', KADAN_ALLOW_FAKE_ROTTIE: '1'};
  const calls = [];
  const rottie = argv => {
    calls.push(argv[1]);
    if (argv[1] === 'show') throw Object.assign(new Error('없다'), {code: 'ROTTIE_TERMINAL_NOT_FOUND', effect: 'none'});
    return argv[1] === 'create' ? {ok: true, result: {terminal: {id: 'term-1', state: 'running', pid: 4242, workspaceId: 'ws-1'}}, runtime: {build: 'b1'}} : {ok: true, result: {}};
  };
  fs.writeFileSync(f.blindTmux, '');
  const r = await f.run({}, {env, rottie});
  const [answer] = r.answers;
  assert.deepEqual([answer.reason, answer.tab], ['ok', 'opened']);
  assert.ok(!('keptSessions' in r), '확인하지 못한 세션은 남긴 수에 세지 않는다');
  assert.deepEqual(calls, ['create'], '탭을 닫지 않았다');
  const record = readRecord(answer.evidencePath);
  assert.deepEqual(f.sessions(), [record.session], '세션을 끄지 않았다');
  assert.deepEqual([record.endReason, Boolean(record.keptAt), record.closedAt, record.killSkipped], ['ok', true, undefined, undefined]);
  assert.ok(!fs.readFileSync(f.tmuxLog, 'utf8').includes(' kill-session '));
  // 조회가 되살아나면 정리 명령이 그 세션을 끄고 탭을 닫는다.
  fs.rmSync(f.blindTmux);
  assert.match(await seniorCommand(['cleanup'], {}, {home: f.home, by: 'qa-슈퍼감독', env, rottie}), /끈 세션 1개, 둔 세션 0개/);
  assert.deepEqual(f.sessions(), []); assert.deepEqual(calls, ['create', 'close', 'show']);
});

test('문을 열지 않은 자리(codex 작업 폴더가 git 안이라 관문이 띄우기 전에 거절)는 남기지 않고 끈다 — 모델이 뜨지 않은 대기 셸이라 남긴 수에도 없다', {skip}, async t => {
  const f = fixture(t);
  execFileSync('git', ['-C', f.home, 'init', '-q']);
  const error = await f.run().then(() => assert.fail('실패해야 한다'), e => e);
  assert.deepEqual(error.answers.map(a => [a.model, a.reason, a.detail]), [
    ['gpt-6-astra', 'call-failed', 'isolation:out-inside-git'], ['gpt-6-sol', 'call-failed', 'isolation:out-inside-git']]);
  assert.deepEqual(f.sessions(), [], '대기 셸을 60초 기다리지 않고 그 자리에서 껐다');
  assert.equal(error.keptSessions, 0); assert.ok(!error.message.includes('남겼다'));
  for (const a of error.answers) {
    const record = readRecord(a.evidencePath);
    assert.deepEqual([record.closeReason, fs.existsSync(record.gate)], ['not-kept', false]);
    assert.equal(fs.existsSync(path.join(f.log, `${a.model}.env.json`)), false, '가짜 codex는 뜨지 않았다');
  }
});

test('TERM: 도는 중에 신호를 받으면 세션을 끄지 않고 남긴 채(키 0회) 143으로 나가며 advice에 interrupted가 남는다', {skip}, async t => {
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
  assert.deepEqual(f.advices().map(e => [e.reason, e.mode]), [['interrupted', 'interactive']]);
  // 중단된 호출의 세션도 남는다. 끝남·남긴 시각은 신호 처리기가 기록에만 적는다(감싼 프로세스가 정리될 시간을 조금 준다).
  await new Promise(r => setTimeout(r, 1500));
  const record = readRecord(f.advices()[0].evidencePath);
  assert.deepEqual(f.sessions(), [record.session]);
  assert.deepEqual([record.endReason, Boolean(record.endedAt), Boolean(record.keptAt)], ['interrupted', true, true]);
  assert.deepEqual(f.fakeLog('gpt-6-astra', 'submitted'), [ASK_LINE], '중단 뒤에도 더 넣은 것이 없다');
  const lines = fs.readFileSync(f.tmuxLog, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual([lines.filter(line => / paste-buffer /u.test(line)).length, lines.filter(line => / send-keys /u.test(line)).length], [1, 1]);
  assert.ok(!lines.some(line => / kill-session /u.test(line)), '아무 세션도 끄지 않았다');
  assert.ok(!fs.readFileSync(path.join(f.advices()[0].evidencePath, 'input.txt'), 'utf8').includes(markerOf(record.marker.slice(-8))));
});

test('감싼 프로세스: 호출 하나는 프로세스 하나다 — 그 프로세스가 TERM을 받으면 세션을 끄지 않고 남김 표시만 적고 나가며 칸은 timeout으로 남는다', {skip}, async t => {
  const f = fixture(t, {seniors: [ASTRA], plan: {default: {answer: 'working-forever'}}});
  // 기존 호출 프로세스(runJudgeProcess)의 상한만 짧게 준다: 상한에 걸리면 감싼 프로세스 묶음에 TERM이 간다.
  const error = await f.run({timeout: '60'}, {spawn: (command, settings) => runJudgeProcess(command, {...settings, timeout: 6000})})
    .then(() => assert.fail('실패해야 한다'), e => e);
  assert.deepEqual(error.answers.map(a => [a.reason, a.status]), [['timeout', '실패(timeout)']]);
  const [entry] = f.advices();
  assert.equal(entry.reason, 'timeout');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(entry.evidencePath, 'outcome.json'), 'utf8')), {reason: 'interrupted', detail: 'SIGTERM'});
  assertKept(f, error.answers, ['interrupted']); // 남김 표시를 먼저 적은 것은 감싼 프로세스의 신호 처리기다
  assert.equal(error.keptSessions, 1); assert.ok(error.message.endsWith(seniorKeptLine(1)));
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
  assertKept(f, error.answers, ['timeout', 'timeout']);
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
  assertKept(f, error.answers, ['timeout', 'timeout']);
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
    assert.equal(f.sessions().length, 1, '시간 초과로 끝난 호출의 세션도 남는다');
    assert.ok(readRecord(error.answers[0].evidencePath).keptAt);
  });
}
