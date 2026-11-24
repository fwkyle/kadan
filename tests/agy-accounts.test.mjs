import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collectAgy, fmtTime, formatReport, makeMasker, pairLogs, resolveTarget, screenStatus} from '../src/agy-accounts.mjs';
import {AGY_USAGE, parseAgyArgs, realDeps, runAgyAccounts} from '../src/commands/agy-accounts.mjs';
import {logStartMs, readAgyLog} from '../src/agy-log.mjs';
import {parseFlags} from '../src/cli-basics.mjs';

// kadan agy accounts. 계정·경로·세션 이름은 모두 가짜(example.invalid). 시험 이름 앞의 [표 N]은 카드의 '고정한 동작 표' 번호다.
const A = 'alice@example.invalid';
const B = 'bob@example.invalid';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-accounts-'));
const local = (...parts) => new Date(...parts).getTime();
const NOW = local(2026, 10, 24, 15, 25, 0);
const exp = text => Date.parse(`${text.replace(' ', 'T')}+09:00`);

const st = (mmdd, hms) => `I${mmdd} ${hms}.123456 100 `;
const loadedLine = (hms, e) => `${st('1124', hms)}keyring.go:64] keyringAuth: loaded token, expiry=${e}.8 +0900 KST expired=false`;
const authLine = (hms, who) => `${st('1124', hms)}server_oauth.go:226] OAuth: authenticated successfully as ${who}`;
const refreshLine = (hms, e) => `${st('1124', hms)}browser.go:265] token refreshed, new expiry=${e}.3 +0900 KST m=+1.0`;
const loginLines = (hms, e, who) => [`${st('1124', hms)}browser.go:145] consumerOAuth: token acquired, expiry=${e}.1 +0900 KST m=+1.0`,
  `${st('1124', hms)}browser.go:167] consumerOAuth: authenticated successfully as ${who}`, authLine(hms, who)];
// 계정 who로 hms에 시작한 로그. extra 줄이 뒤에 붙는다.
const logOf = (hms, e, who, ...extra) => [loadedLine(hms, e), authLine(hms, who), ...extra.flat()];
const RULE = '─'.repeat(40);
const QUOTA = ['  ⠿ 작업 중이던 화면', '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h15m59s.',
  RULE, '>', RULE, '? for shortcuts            auto · fake-agent (Fake Model · high)  /agents'].join('\n');
const WORKING = ['⣟  Generating...', RULE, '>', RULE, 'esc to cancel            auto · fake-agent (Fake Model · high)  /agents'].join('\n');
const IDLE = [RULE, '>', RULE, '? for shortcuts            auto · fake-agent (Fake Model · high)  /agents'].join('\n');

// 가짜 세계: items마다 agy 프로세스 하나(+그 로그 파일 하나). where는 role|senior|rottie|other.
function world(items, {noLsof = [], logDirMissing = false, now = NOW, screens = {}, states = new Map(), extraLogs = []} = {}) {
  const logDir = path.join(fs.mkdtempSync(path.join(tmp, 'w-')), 'antigravity-cli', 'log');
  fs.mkdirSync(logDir, {recursive: true});
  const procs = [{pid: '1', ppid: '0', startMs: 0, comm: '/sbin/launchd'}];
  const open = new Map(), role = [], senior = [], rottie = [];
  for (const it of items) {
    const file = path.join(logDir, it.log);
    fs.writeFileSync(file, it.lines.join('\n') + '\n');
    const shell = `s${it.pid}`;
    procs.push({pid: shell, ppid: '1', startMs: 0, comm: '/bin/zsh'}, {pid: it.pid, ppid: shell, startMs: logStartMs(it.log) - (it.offset ?? 1000), comm: '/fake/bin/agy'});
    if (!noLsof.includes(it.pid)) open.set(it.pid, [file]);
    if (it.where === 'role') role.push({panePid: shell, session: it.session});
    if (it.where === 'senior') senior.push({panePid: shell, session: it.session});
    if (it.where === 'rottie') rottie.push({pid: shell, title: it.session, cwd: '/fake/dir'});
  }
  for (const log of extraLogs) fs.writeFileSync(path.join(logDir, log.name), log.lines.join('\n') + '\n');
  const calls = {kill: [], rolePanes: 0, assertWritable: 0, readScreen: []};
  const deps = {
    now: () => now,
    listProcesses: () => procs,
    listLogs: () => {
      if (logDirMissing) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
      return fs.readdirSync(logDir).map(name => ({file: path.join(logDir, name), mtimeMs: now - 60_000, startMs: logStartMs(name)}));
    },
    readLog: file => readAgyLog(file),
    openLogs: pids => new Map(pids.map(pid => [pid, open.get(pid) ?? []])),
    rolePanes: () => { calls.rolePanes++; return role; },
    seniorPanes: () => senior,
    rottieTabs: () => rottie,
    readScreen: session => { calls.readScreen.push(session); return screens[session] ?? null; },
    seniorStates: () => states,
    kill: dir => { calls.kill.push(dir); return {killed: true}; },
    assertWritable: () => { calls.assertWritable++; },
  };
  return {deps, calls, logDir};
}
const run = (argv, flagsOrArgs, w) => runAgyAccounts(argv, flagsOrArgs, w.deps);
const cli = (args, w) => { const {flags, rest} = parseFlags(args); return runAgyAccounts(rest, flags, w.deps); };

// 오늘 모양을 줄인 세계: 역할 창(로그인으로 B가 된 프로세스)·시니어 둘(B와 A)·로티 탭(A)·그 밖(A).
const today = () => world([
  {pid: '100', log: 'cli-20261124_131852.log', where: 'role', session: 'kadan-fake-worker',
    lines: logOf('13:18:52', '2026-11-24 14:15:43', A, loginLines('13:27:58', '2026-11-24 14:27:57', B), refreshLine('15:19:52', '2026-11-24 16:19:51'))},
  {pid: '200', log: 'cli-20261124_140136.log', where: 'senior', session: 'senior-b',
    lines: logOf('14:01:36', '2026-11-24 14:27:57', B, refreshLine('14:28:37', '2026-11-24 15:28:36'))},
  {pid: '300', log: 'cli-20261124_150546.log', where: 'senior', session: 'senior-a',
    lines: logOf('15:05:46', '2026-11-24 15:28:36', A)},
  {pid: '400', log: 'cli-20261124_144036.log', where: 'rottie', session: 'fake-tab',
    lines: logOf('14:40:36', '2026-11-24 15:28:36', A)},
  {pid: '500', log: 'cli-20261124_151947.log', where: 'other',
    lines: logOf('15:19:47', '2026-11-24 16:15:33', A)},
], {screens: {'kadan-fake-worker': WORKING}});

test('[표 1] 떠 있는 agy마다 한 줄: PID·시작 시각·어디·가린 계정·상태가 보인다', () => {
  const text = run(['accounts'], {}, today());
  assert.match(text, /^떠 있는 agy 5개/m);
  for (const pid of ['100', '200', '300', '400', '500']) assert.match(text, new RegExp(`^${pid}\\t`, 'm'));
  const row = text.split('\n').find(line => line.startsWith('100\t')).split('\t');
  assert.deepEqual(row.slice(0, 5), ['100', '13:18', '카단 역할 kadan-fake-worker', 'bob…', '작업 중']);
  assert.equal(row[5], 'lsof');
});

test('[표 2] 어디: 조상 사슬로 카단 역할 > 시니어 창 > 로티 탭 > 그 밖 순서로 고른다', () => {
  const lines = run(['accounts'], {}, today()).split('\n');
  const where = pid => lines.find(line => line.startsWith(`${pid}\t`)).split('\t')[2];
  assert.equal(where('100'), '카단 역할 kadan-fake-worker');
  assert.equal(where('200'), '시니어 창 senior-b');
  assert.equal(where('400'), '로티 탭 fake-tab /fake/dir');
  assert.equal(where('500'), '그 밖');
  // 같은 사슬에 역할 세션과 시니어 창이 함께 있으면 역할 세션이 이긴다.
  const both = world([{pid: '100', log: 'cli-20261124_131852.log', where: 'role', session: 'kadan-both', lines: logOf('13:18:52', '2026-11-24 14:15:43', A)}]);
  const rows = collectAgy({...both.deps, seniorPanes: () => [{panePid: 's100', session: 'senior-x'}], rottieTabs: () => [{pid: 's100', title: 't', cwd: null}]}).rows;
  assert.equal(rows[0].where.kind, 'role');
  const noRole = collectAgy({...both.deps, rolePanes: () => [], seniorPanes: () => [{panePid: 's100', session: 'senior-x'}], rottieTabs: () => [{pid: 's100', title: 't', cwd: null}]}).rows;
  assert.equal(noRole[0].where.kind, 'senior');
  // 조상이 아닌 pane은 맞지 않는다.
  const far = collectAgy({...both.deps, rolePanes: () => [{panePid: '999', session: 'kadan-far'}]}).rows;
  assert.equal(far[0].where.kind, 'other');
});

test('[표 3] 계정: 이메일 전체는 어디에도 나오지 않고, --target이 있으면 같음/다름이 붙고, 짝이 안 정해지면 모름이다', () => {
  const plain = run(['accounts'], {}, today());
  assert.doesNotMatch(plain, /@|example\.invalid|alice@|bob@/);
  assert.doesNotMatch(plain, /같음|다름/);
  const withTarget = run(['accounts'], {target: 'bob'}, today());
  const line = pid => withTarget.split('\n').find(row => row.startsWith(`${pid}\t`)).split('\t')[3];
  assert.equal(line('100'), 'bob… (목표와 같음)');
  assert.equal(line('300'), 'ali… (목표와 다름)');
  assert.doesNotMatch(withTarget, /@|example\.invalid/);
  // 로그 짝이 없으면 계정은 모름이다.
  const unpaired = world([{pid: '100', log: 'cli-20261124_131852.log', where: 'other', lines: logOf('13:18:52', '2026-11-24 14:15:43', A)}], {noLsof: ['100']});
  unpaired.deps.listLogs = () => [];
  const row = collectAgy(unpaired.deps).rows[0];
  assert.deepEqual([row.account, row.pairedBy], [null, null]);
  assert.match(formatReport(collectAgy(unpaired.deps)), /\t모름\t모름\t모름\(짝이 되는 로그를 못 찾음\)/);
  // 앞 글자가 같은 두 계정은 구분될 때까지 늘려 보인다.
  const mask = makeMasker(['alice@example.invalid', 'alicia@example.invalid']);
  assert.deepEqual([mask('alice@example.invalid'), mask('alicia@example.invalid')], ['alice…', 'alici…']);
});

test('[표 4] 상태: 카단 역할 창은 화면으로 한도로 멈춤/작업 중/대기/모름, 그 밖의 창은 모름', () => {
  assert.equal(screenStatus(QUOTA), '한도로 멈춤');
  // 오래된 스크롤 기록 속 문구(그 뒤에 새 출력이 있음)나 인용은 한도가 아니다.
  const stale = ['⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h15m59s.', '● Ran fake command', RULE, '>', RULE, '? for shortcuts  auto'].join('\n');
  assert.equal(screenStatus(stale), '대기');
  assert.equal(screenStatus(WORKING), '작업 중');
  assert.equal(screenStatus(IDLE), '대기');
  assert.equal(screenStatus('이상한 화면\n끝'), '모름');
  assert.equal(screenStatus(null), '모름');
  assert.equal(screenStatus(''), '모름');
  const w = today();
  const rows = collectAgy(w.deps).rows;
  assert.equal(rows.find(row => row.pid === '100').status, '작업 중');
  for (const pid of ['200', '300', '400', '500']) assert.equal(rows.find(row => row.pid === pid).status, '모름');
  assert.deepEqual(w.calls.readScreen, ['kadan-fake-worker']); // 역할 세션만 화면을 읽는다
  const quota = world([{pid: '100', log: 'cli-20261124_131852.log', where: 'role', session: 'kadan-quota', lines: logOf('13:18:52', '2026-11-24 14:15:43', A)}], {screens: {'kadan-quota': QUOTA}});
  assert.equal(collectAgy(quota.deps).rows[0].status, '한도로 멈춤');
});

test('[표 5] 맨 아래: 마지막으로 저장소를 덮은 계정(추정)과 다음 갱신 예정(약)', () => {
  const w = today();
  const report = collectAgy(w.deps);
  // 가장 늦은 덮어쓰기 = 역할 창 프로세스의 15:19:52 갱신(계정 B). 끝난 프로세스의 로그도 센다.
  assert.deepEqual([report.overwrite.account, report.overwrite.kind, report.overwrite.atMs], [B, 'refreshed', local(2026, 10, 24, 15, 19, 52)]);
  const text = formatReport(report);
  assert.match(text, /지금 새로 띄우면 뜰 계정\(추정\): bob… — 저장소를 마지막으로 덮은 것: 15:19 토큰 갱신/);
  assert.match(text, new RegExp(`다음 갱신: 약 ${fmtTime(exp('2026-11-24 15:28:36'), NOW)} \\(PID (200|300|400)`));
  // 끝난 프로세스의 로그가 더 늦게 덮었다면 그 계정이 추정이다(살아 있는 프로세스가 없어도).
  const ended = world([], {extraLogs: [{name: 'cli-20261124_120000.log', lines: logOf('12:00:00', '2026-11-24 13:00:00', A, refreshLine('14:30:00', '2026-11-24 15:30:00'))}]});
  const endedReport = collectAgy(ended.deps);
  assert.equal(endedReport.overwrite.account, A);
  assert.equal(endedReport.next, null);
});

test('[표 6] --close-seniors에 --target이 없으면 거절한다(종료 2, 아무것도 닫지 않음)', () => {
  const w = today();
  assert.throws(() => cli(['accounts', '--close-seniors'], w), error => error.exitCode === 2 && /--target이 필요/.test(error.message));
  assert.deepEqual(w.calls.kill, []);
  assert.equal(w.calls.assertWritable, 0);
});

const seniorWorld = () => {
  const states = new Map([
    ['senior-kept-a', {state: 'kept', why: null, dir: '/fake/advice/kept-a'}],
    ['senior-run-a', {state: 'active', why: 'running', dir: '/fake/advice/run-a'}],
    ['senior-norec-a', {state: 'active', why: 'no-record', dir: null}],
    ['senior-kept-b', {state: 'kept', why: null, dir: '/fake/advice/kept-b'}],
    ['senior-nolog', {state: 'kept', why: null, dir: '/fake/advice/nolog'}]]);
  return world([
    {pid: '100', log: 'cli-20261124_100000.log', where: 'senior', session: 'senior-kept-a', lines: logOf('10:00:00', '2026-11-24 11:00:00', A)},
    {pid: '110', log: 'cli-20261124_110000.log', where: 'senior', session: 'senior-run-a', lines: logOf('11:00:00', '2026-11-24 12:00:00', A)},
    {pid: '120', log: 'cli-20261124_120000.log', where: 'senior', session: 'senior-norec-a', lines: logOf('12:00:00', '2026-11-24 13:00:00', A)},
    {pid: '130', log: 'cli-20261124_130000.log', where: 'senior', session: 'senior-kept-b', lines: logOf('13:00:00', '2026-11-24 14:00:00', B)},
    {pid: '140', log: 'cli-20261124_140000.log', where: 'senior', session: 'senior-nolog', offset: 600_000, lines: logOf('14:00:00', '2026-11-24 15:00:00', A)},
    {pid: '150', log: 'cli-20261124_141000.log', where: 'role', session: 'kadan-fake-role', lines: logOf('14:10:00', '2026-11-24 15:10:00', A)},
    {pid: '160', log: 'cli-20261124_142000.log', where: 'rottie', session: 'fake-tab', lines: logOf('14:20:00', '2026-11-24 15:20:00', A)},
    {pid: '170', log: 'cli-20261124_143000.log', where: 'other', lines: logOf('14:30:00', '2026-11-24 15:30:00', A)},
  ], {noLsof: ['140'], states});
};

test('[표 7] --target이 관측된 계정 0개 또는 2개 이상과 맞으면 거절하고 아무것도 닫지 않는다', () => {
  for (const target of ['nobody', 'example.invalid', 'e']) {
    const w = seniorWorld();
    assert.throws(() => cli(['accounts', '--close-seniors', '--target', target], w), error => error.exitCode === 2 && /정확히 하나여야/.test(error.message), target);
    assert.deepEqual(w.calls.kill, [], target);
    assert.equal(w.calls.assertWritable, 0, target);
  }
  const w = seniorWorld();
  const message = (() => { try { cli(['accounts', '--close-seniors', '--target', 'example.invalid'], w); } catch (error) { return error.message; } return ''; })();
  assert.match(message, /2개와 맞는다/);
  assert.doesNotMatch(message, /@|example\.invalid\./);
  assert.deepEqual(resolveTarget('bob', collectAgy(w.deps).rows).account, B);
});

test('[표 8] 목표와 다른 계정의 시니어 창 중 끝난 호출·기록 대조가 맞는 것만 닫고, 나머지는 이유와 함께 둔다', () => {
  const w = seniorWorld();
  const text = cli(['accounts', '--close-seniors', '--target', 'bob'], w);
  assert.deepEqual(w.calls.kill, ['/fake/advice/kept-a']); // 계정 A + kept 하나뿐
  assert.equal(w.calls.assertWritable, 1);
  assert.match(text, /^끔  senior-kept-a \(PID 100\)$/m);
  assert.match(text, /^둠  senior-run-a \(PID 110\) — 진행 중인 호출$/m);
  assert.match(text, /^둠  senior-norec-a \(PID 120\) — 끝난 호출로 확인되지 않음\(no-record\)$/m);
  assert.match(text, /^둠  senior-nolog \(PID 140\) — 계정 모름$/m);
  assert.doesNotMatch(text.slice(text.indexOf('시니어 창 닫기')), /senior-kept-b/); // 목표와 같은 계정은 건드리지 않는다
  assert.doesNotMatch(text, /@|example\.invalid/);
  // 끄기가 실패하면 닫았다고 하지 않는다.
  const fail = seniorWorld();
  fail.deps.kill = () => ({killed: false, why: 'pid-differs'});
  assert.match(cli(['accounts', '--close-seniors', '--target', 'bob'], fail), /^둠  senior-kept-a \(PID 100\) — 끄지 못함\(pid-differs\)$/m);
});

test('[표 9] 시니어가 아닌 창은 계정이 목표와 달라도 절대 닫지 않고 /login 안내 한 줄만 보인다', () => {
  const w = seniorWorld();
  const text = cli(['accounts', '--close-seniors', '--target', 'bob'], w);
  for (const dir of w.calls.kill) assert.match(dir, /kept-a$/);
  for (const [pid, label] of [['150', '카단 역할 kadan-fake-role'], ['160', '로티 탭 fake-tab /fake/dir'], ['170', '그 밖']]) {
    assert.match(text, new RegExp(`^PID ${pid} \\(${label}\\): 목표와 다른 계정 — 닫지 않는다\\. 그 창에서 /login$`, 'm'));
  }
  // 목표와 같은 계정의 비시니어 창에는 안내가 없다.
  const same = cli(['accounts', '--target', 'alice'], seniorWorld());
  assert.doesNotMatch(same, /PID 150 .*\/login/);
});

test('[표 10] 옵션 꼴: --close-seniors 반복·값 붙음, --target 반복·빈 값, 알 수 없는 옵션·하위 명령은 사용법 오류(종료 2, 부작용 0)', () => {
  const bad = [
    ['accounts', '--close-seniors', '--close-seniors', '--target', 'bob'],
    ['accounts', '--close-seniors', 'yes', '--target', 'bob'],
    ['accounts', '--close-seniors', '--target', 'bob', '--target', 'alice'],
    ['accounts', '--close-seniors', '--target', ''],
    ['accounts', '--close-seniors', '--target'],
    ['accounts', '--target', 'bob', '--target', 'alice'],
    ['accounts', '--close-seniors=true', '--target', 'bob'],
    ['accounts', '--target', 'bob', '--frobnicate'],
    ['accounts', 'extra'],
    ['switch'],
    [],
  ];
  for (const args of bad) {
    const w = seniorWorld();
    assert.throws(() => cli(args, w), error => error.exitCode === 2 && error.message.includes('사용법: kadan agy accounts'), JSON.stringify(args));
    assert.deepEqual(w.calls.kill, [], JSON.stringify(args));
    assert.equal(w.calls.assertWritable, 0, JSON.stringify(args));
    assert.equal(w.calls.rolePanes, 0, `${JSON.stringify(args)}: 조회도 하지 않는다`);
  }
  assert.deepEqual(parseAgyArgs(['accounts'], {}), {target: null, close: false});
  assert.deepEqual(parseAgyArgs(['accounts'], {target: ' bob ', 'close-seniors': true}), {target: 'bob', close: true});
  assert.equal(cli(['accounts', '--help'], seniorWorld()), AGY_USAGE);
});

test('[표 11] agy 프로세스가 없으면 오류 없이 안내하고, 읽을 수 있으면 맨 아래 추정만 보인다. 로그 폴더가 없어도 오류가 아니다', () => {
  const ended = world([], {extraLogs: [{name: 'cli-20261124_120000.log', lines: logOf('12:00:00', '2026-11-24 13:00:00', B, refreshLine('14:30:00', '2026-11-24 15:30:00'))}]});
  const text = run(['accounts'], {}, ended);
  assert.match(text, /^떠 있는 agy 없음$/m);
  assert.match(text, /지금 새로 띄우면 뜰 계정\(추정\): bob… — 저장소를 마지막으로 덮은 것: 14:30 토큰 갱신/);
  assert.doesNotMatch(text, /다음 갱신/);
  assert.equal(ended.calls.rolePanes, 0);
  const none = world([], {logDirMissing: true});
  const textNone = run(['accounts'], {}, none);
  assert.match(textNone, /^떠 있는 agy 없음$/m);
  assert.match(textNone, /추정\): 모름 — 로그 폴더를 읽지 못함/);
  // --close-seniors도 대상이 없으면 닫을 것이 없다고만 한다(같은 계정이 하나라도 관측돼야 하므로 목표가 맞지 않으면 거절).
  assert.throws(() => cli(['accounts', '--close-seniors', '--target', 'bob'], none), error => error.exitCode === 2);
});

test('짝짓기: lsof가 보이면 lsof를 쓰고, 안 보이면 시작 시각으로 짝짓되 같은 시각 후보가 여럿이면 모름이다', () => {
  const logs = [{name: 'cli-20261124_100000.log', startMs: local(2026, 10, 24, 10, 0, 0)}, {name: 'cli-20261124_100001.log', startMs: local(2026, 10, 24, 10, 0, 1)},
    {name: 'cli-20261124_110000.log', startMs: local(2026, 10, 24, 11, 0, 0)}];
  const path1 = name => `/home/fake/.gemini/antigravity-cli/log/${name}`;
  const proc = (pid, startMs) => ({pid, startMs});
  // lsof가 로그를 하나 보이면 시각은 보지 않는다.
  const lsof = pairLogs([proc('1', local(2026, 10, 24, 9, 0, 0))], {openLogs: new Map([['1', [path1('cli-20261124_110000.log')]]]), logs});
  assert.deepEqual(lsof.get('1'), {name: 'cli-20261124_110000.log', by: 'lsof'});
  // lsof가 안 보이면 시작 시각(파일 이름이 1초 늦은 것까지). 후보가 하나일 때만.
  const byTime = pairLogs([proc('2', local(2026, 10, 24, 11, 0, 0) - 1000)], {openLogs: new Map(), logs});
  assert.deepEqual(byTime.get('2'), {name: 'cli-20261124_110000.log', by: '시각'});
  // 같은 시각 후보가 둘 이상이면 모름.
  const two = pairLogs([proc('3', local(2026, 10, 24, 10, 0, 0))], {openLogs: new Map(), logs});
  assert.equal(two.get('3').name, null);
  assert.match(two.get('3').why, /여럿/);
  // 같은 시각에 시작한 프로세스가 둘이면 서로 모름.
  const rivals = pairLogs([proc('4', local(2026, 10, 24, 11, 0, 0)), proc('5', local(2026, 10, 24, 11, 0, 0))], {openLogs: new Map(), logs});
  assert.deepEqual([rivals.get('4').name, rivals.get('5').name], [null, null]);
  // 다른 프로세스가 lsof로 쥔 로그는 시각 후보에서 뺀다. 같은 로그를 둘이 열면 둘 다 모름. 로그 둘을 열면 모름.
  const claimed = pairLogs([proc('6', 0), proc('7', local(2026, 10, 24, 11, 0, 0))], {openLogs: new Map([['6', [path1('cli-20261124_110000.log')]]]), logs});
  assert.equal(claimed.get('6').by, 'lsof');
  assert.equal(claimed.get('7').name, null);
  const shared = pairLogs([proc('8', 0), proc('9', 0)], {openLogs: new Map([['8', [path1('cli-20261124_110000.log')]], ['9', [path1('cli-20261124_110000.log')]]]), logs});
  assert.deepEqual([shared.get('8').name, shared.get('9').name], [null, null]);
  const multi = pairLogs([proc('10', 0)], {openLogs: new Map([['10', [path1('cli-20261124_110000.log'), path1('cli-20261124_100000.log')]]]), logs});
  assert.equal(multi.get('10').name, null);
});

test('실제 조회 어댑터: tmux는 -u로 부르고(한글 세션 이름), ps·lsof 출력을 읽는다', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tmux') return {status: 0, stdout: '75315 kadan-작업자-한글\n99 kadan-b c\nbad line\n'};
    if (cmd === 'ps') return {status: 0, stdout: ' 40518 38812 Tue Nov 24 15:19:46 2026 /fake/bin/agy\n  7  1 Tue Nov  4 09:01:02 2026 /sbin/launchd\n'};
    return {status: 1, stdout: 'p40518\nn/home/fake/.gemini/antigravity-cli/log/cli-20261124_151947.log\nn/home/fake/.gemini/antigravity-cli/log\np5\nn/etc/hosts\n'};
  };
  const deps = realDeps({home: tmp, env: {}, run});
  assert.deepEqual(deps.rolePanes(), [{panePid: '75315', session: 'kadan-작업자-한글'}, {panePid: '99', session: 'kadan-b c'}]);
  assert.equal(calls[0][0], 'tmux');
  assert.equal(calls[0][1], '-u');
  assert.equal(calls[0][2], '-L');
  const procs = deps.listProcesses();
  assert.deepEqual(procs.map(proc => [proc.pid, proc.ppid, proc.comm]), [['40518', '38812', '/fake/bin/agy'], ['7', '1', '/sbin/launchd']]);
  assert.equal(procs[0].startMs, local(2026, 10, 24, 15, 19, 46));
  assert.deepEqual([...deps.openLogs(['40518', '5'])], [['40518', ['/home/fake/.gemini/antigravity-cli/log/cli-20261124_151947.log']], ['5', []]]);
});

test('공개 저장소 점검: 이 시험이 쓰는 계정은 모두 example.invalid 가짜 주소다', () => {
  const source = [fs.readFileSync(new URL(import.meta.url), 'utf8'), fs.readFileSync(new URL('./agy-log.test.mjs', import.meta.url), 'utf8')].join('\n');
  const addresses = source.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [];
  assert.ok(addresses.length > 0);
  for (const address of addresses) assert.match(address, /@example\.invalid$/);
});
