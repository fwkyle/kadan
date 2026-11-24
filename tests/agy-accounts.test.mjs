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
const NOW = local(2030, 2, 5, 15, 25, 0);
// 만료 글자는 현지 시간대의 오프셋으로 쓴다: 시험의 '지금'(NOW)이 현지 시각이라 오프셋을 KST로 고정하면 UTC 같은 환경에서 만료가 이미 지난 것이 된다.
const OFFSET_MIN = -new Date(NOW).getTimezoneOffset();
const TZ = `${OFFSET_MIN < 0 ? '-' : '+'}${String(Math.floor(Math.abs(OFFSET_MIN) / 60)).padStart(2, '0')}${String(Math.abs(OFFSET_MIN) % 60).padStart(2, '0')}`;
const exp = text => Date.parse(`${text.replace(' ', 'T')}${TZ.slice(0, 3)}:${TZ.slice(3)}`);

const st = (mmdd, hms) => `I${mmdd} ${hms}.123456 1001 `;
const loadedLine = (hms, e) => `${st('0305', hms)}keyring.go:64] keyringAuth: loaded token, expiry=${e}.8 ${TZ} KST expired=false`;
const authLine = (hms, who) => `${st('0305', hms)}server_oauth.go:226] OAuth: authenticated successfully as ${who}`;
const refreshLine = (hms, e) => `${st('0305', hms)}browser.go:265] token refreshed, new expiry=${e}.3 ${TZ} KST m=+1.0`;
const loginLines = (hms, e, who) => [`${st('0305', hms)}browser.go:145] consumerOAuth: token acquired, expiry=${e}.1 ${TZ} KST m=+1.0`,
  `${st('0305', hms)}browser.go:167] consumerOAuth: authenticated successfully as ${who}`, authLine(hms, who)];
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
  {pid: '1100', log: 'cli-20300305_131852.log', where: 'role', session: 'kadan-fake-worker',
    lines: logOf('13:18:52', '2030-03-05 14:15:43', A, loginLines('13:27:58', '2030-03-05 14:27:57', B), refreshLine('15:19:52', '2030-03-05 16:19:51'))},
  {pid: '1200', log: 'cli-20300305_140136.log', where: 'senior', session: 'senior-b',
    lines: logOf('14:01:36', '2030-03-05 14:27:57', B, refreshLine('14:28:37', '2030-03-05 15:28:36'))},
  {pid: '1300', log: 'cli-20300305_150546.log', where: 'senior', session: 'senior-a',
    lines: logOf('15:05:46', '2030-03-05 15:28:36', A)},
  {pid: '1400', log: 'cli-20300305_144036.log', where: 'rottie', session: 'fake-tab',
    lines: logOf('14:40:36', '2030-03-05 15:28:36', A)},
  {pid: '1500', log: 'cli-20300305_151947.log', where: 'other',
    lines: logOf('15:19:47', '2030-03-05 16:15:33', A)},
], {screens: {'kadan-fake-worker': WORKING}});

test('[표 1] 떠 있는 agy마다 한 줄: PID·시작 시각·어디·가린 계정·상태가 보인다', () => {
  const text = run(['accounts'], {}, today());
  assert.match(text, /^떠 있는 agy 5개/m);
  for (const pid of ['1100', '1200', '1300', '1400', '1500']) assert.match(text, new RegExp(`^${pid}\\t`, 'm'));
  const row = text.split('\n').find(line => line.startsWith('1100\t')).split('\t');
  assert.deepEqual(row.slice(0, 5), ['1100', '13:18', '카단 역할 kadan-fake-worker', 'bob…', '작업 중']);
  assert.equal(row[5], 'lsof');
});

test('[표 2] 어디: 조상 사슬로 카단 역할 > 시니어 창 > 로티 탭 > 그 밖 순서로 고른다', () => {
  const lines = run(['accounts'], {}, today()).split('\n');
  const where = pid => lines.find(line => line.startsWith(`${pid}\t`)).split('\t')[2];
  assert.equal(where('1100'), '카단 역할 kadan-fake-worker');
  assert.equal(where('1200'), '시니어 창 senior-b');
  assert.equal(where('1400'), '로티 탭 fake-tab /fake/dir');
  assert.equal(where('1500'), '그 밖');
  // 같은 사슬에 역할 세션과 시니어 창이 함께 있으면 역할 세션이 이긴다.
  const both = world([{pid: '1100', log: 'cli-20300305_131852.log', where: 'role', session: 'kadan-both', lines: logOf('13:18:52', '2030-03-05 14:15:43', A)}]);
  const rows = collectAgy({...both.deps, seniorPanes: () => [{panePid: 's1100', session: 'senior-x'}], rottieTabs: () => [{pid: 's1100', title: 't', cwd: null}]}).rows;
  assert.equal(rows[0].where.kind, 'role');
  const noRole = collectAgy({...both.deps, rolePanes: () => [], seniorPanes: () => [{panePid: 's1100', session: 'senior-x'}], rottieTabs: () => [{pid: 's1100', title: 't', cwd: null}]}).rows;
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
  assert.equal(line('1100'), 'bob… (목표와 같음)');
  assert.equal(line('1300'), 'ali… (목표와 다름)');
  assert.doesNotMatch(withTarget, /@|example\.invalid/);
  // 로그 짝이 없으면 계정은 모름이다.
  const unpaired = world([{pid: '1100', log: 'cli-20300305_131852.log', where: 'other', lines: logOf('13:18:52', '2030-03-05 14:15:43', A)}], {noLsof: ['1100']});
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
  assert.equal(rows.find(row => row.pid === '1100').status, '작업 중');
  for (const pid of ['1200', '1300', '1400', '1500']) assert.equal(rows.find(row => row.pid === pid).status, '모름');
  assert.deepEqual(w.calls.readScreen, ['kadan-fake-worker']); // 역할 세션만 화면을 읽는다
  const quota = world([{pid: '1100', log: 'cli-20300305_131852.log', where: 'role', session: 'kadan-quota', lines: logOf('13:18:52', '2030-03-05 14:15:43', A)}], {screens: {'kadan-quota': QUOTA}});
  assert.equal(collectAgy(quota.deps).rows[0].status, '한도로 멈춤');
});

test('[표 5] 맨 아래: 마지막으로 저장소를 덮은 계정(추정)과 다음 갱신 예정(약)', () => {
  const w = today();
  const report = collectAgy(w.deps);
  // 가장 늦은 덮어쓰기 = 역할 창 프로세스의 15:19:52 갱신(계정 B). 끝난 프로세스의 로그도 센다.
  assert.deepEqual([report.overwrite.account, report.overwrite.kind, report.overwrite.atMs], [B, 'refreshed', local(2030, 2, 5, 15, 19, 52)]);
  const text = formatReport(report);
  assert.match(text, /지금 새로 띄우면 뜰 계정\(추정\): bob… — 저장소를 마지막으로 덮은 것: 15:19 토큰 갱신/);
  assert.match(text, new RegExp(`다음 갱신: 약 ${fmtTime(exp('2030-03-05 15:28:36'), NOW)} \\(PID (1200|1300|1400)`));
  // 끝난 프로세스의 로그가 더 늦게 덮었다면 그 계정이 추정이다(살아 있는 프로세스가 없어도).
  const ended = world([], {extraLogs: [{name: 'cli-20300305_120000.log', lines: logOf('12:00:00', '2030-03-05 13:00:00', A, refreshLine('14:30:00', '2030-03-05 15:30:00'))}]});
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
    {pid: '1100', log: 'cli-20300305_100000.log', where: 'senior', session: 'senior-kept-a', lines: logOf('10:00:00', '2030-03-05 11:00:00', A)},
    {pid: '1110', log: 'cli-20300305_110000.log', where: 'senior', session: 'senior-run-a', lines: logOf('11:00:00', '2030-03-05 12:00:00', A)},
    {pid: '1120', log: 'cli-20300305_120000.log', where: 'senior', session: 'senior-norec-a', lines: logOf('12:00:00', '2030-03-05 13:00:00', A)},
    {pid: '1130', log: 'cli-20300305_130000.log', where: 'senior', session: 'senior-kept-b', lines: logOf('13:00:00', '2030-03-05 14:00:00', B)},
    {pid: '1140', log: 'cli-20300305_140000.log', where: 'senior', session: 'senior-nolog', offset: 600_000, lines: logOf('14:00:00', '2030-03-05 15:00:00', A)},
    {pid: '1150', log: 'cli-20300305_141000.log', where: 'role', session: 'kadan-fake-role', lines: logOf('14:10:00', '2030-03-05 15:10:00', A)},
    {pid: '1160', log: 'cli-20300305_142000.log', where: 'rottie', session: 'fake-tab', lines: logOf('14:20:00', '2030-03-05 15:20:00', A)},
    {pid: '1170', log: 'cli-20300305_143000.log', where: 'other', lines: logOf('14:30:00', '2030-03-05 15:30:00', A)},
  ], {noLsof: ['1140'], states});
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
  assert.match(text, /^끔  senior-kept-a \(PID 1100\)$/m);
  assert.match(text, /^둠  senior-run-a \(PID 1110\) — 진행 중인 호출$/m);
  assert.match(text, /^둠  senior-norec-a \(PID 1120\) — 끝난 호출로 확인되지 않음\(no-record\)$/m);
  assert.match(text, /^둠  senior-nolog \(PID 1140\) — 계정 모름$/m);
  assert.doesNotMatch(text.slice(text.indexOf('시니어 창 닫기')), /senior-kept-b/); // 목표와 같은 계정은 건드리지 않는다
  assert.doesNotMatch(text, /@|example\.invalid/);
  // 끄기가 실패하면 닫았다고 하지 않는다.
  const fail = seniorWorld();
  fail.deps.kill = () => ({killed: false, why: 'pid-differs'});
  assert.match(cli(['accounts', '--close-seniors', '--target', 'bob'], fail), /^둠  senior-kept-a \(PID 1100\) — 끄지 못함\(pid-differs\)$/m);
});

test('[표 9] 시니어가 아닌 창은 계정이 목표와 달라도 절대 닫지 않고 /login 안내 한 줄만 보인다', () => {
  const w = seniorWorld();
  const text = cli(['accounts', '--close-seniors', '--target', 'bob'], w);
  for (const dir of w.calls.kill) assert.match(dir, /kept-a$/);
  for (const [pid, label] of [['1150', '카단 역할 kadan-fake-role'], ['1160', '로티 탭 fake-tab /fake/dir'], ['1170', '그 밖']]) {
    assert.match(text, new RegExp(`^PID ${pid} \\(${label}\\): 목표와 다른 계정 — 닫지 않는다\\. 그 창에서 /login$`, 'm'));
  }
  // 목표와 같은 계정의 비시니어 창에는 안내가 없다.
  const same = cli(['accounts', '--target', 'alice'], seniorWorld());
  assert.doesNotMatch(same, /PID 1150 .*\/login/);
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
  const ended = world([], {extraLogs: [{name: 'cli-20300305_120000.log', lines: logOf('12:00:00', '2030-03-05 13:00:00', B, refreshLine('14:30:00', '2030-03-05 15:30:00'))}]});
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
  const logs = [{name: 'cli-20300305_100000.log', startMs: local(2030, 2, 5, 10, 0, 0)}, {name: 'cli-20300305_100001.log', startMs: local(2030, 2, 5, 10, 0, 1)},
    {name: 'cli-20300305_110000.log', startMs: local(2030, 2, 5, 11, 0, 0)}];
  const path1 = name => `/home/fake/.gemini/antigravity-cli/log/${name}`;
  const proc = (pid, startMs) => ({pid, startMs});
  // lsof가 로그를 하나 보이면 시각은 보지 않는다.
  const lsof = pairLogs([proc('1', local(2030, 2, 5, 9, 0, 0))], {openLogs: new Map([['1', [path1('cli-20300305_110000.log')]]]), logs});
  assert.deepEqual(lsof.get('1'), {name: 'cli-20300305_110000.log', by: 'lsof'});
  // lsof가 안 보이면 시작 시각(파일 이름이 1초 늦은 것까지). 후보가 하나일 때만.
  const byTime = pairLogs([proc('2', local(2030, 2, 5, 11, 0, 0) - 1000)], {openLogs: new Map(), logs});
  assert.deepEqual(byTime.get('2'), {name: 'cli-20300305_110000.log', by: '시각'});
  // 같은 시각 후보가 둘 이상이면 모름.
  const two = pairLogs([proc('3', local(2030, 2, 5, 10, 0, 0))], {openLogs: new Map(), logs});
  assert.equal(two.get('3').name, null);
  assert.match(two.get('3').why, /여럿/);
  // 같은 시각에 시작한 프로세스가 둘이면 서로 모름.
  const rivals = pairLogs([proc('4', local(2030, 2, 5, 11, 0, 0)), proc('5', local(2030, 2, 5, 11, 0, 0))], {openLogs: new Map(), logs});
  assert.deepEqual([rivals.get('4').name, rivals.get('5').name], [null, null]);
  // 다른 프로세스가 lsof로 쥔 로그는 시각 후보에서 뺀다. 같은 로그를 둘이 열면 둘 다 모름. 로그 둘을 열면 모름.
  const claimed = pairLogs([proc('6', 0), proc('7', local(2030, 2, 5, 11, 0, 0))], {openLogs: new Map([['6', [path1('cli-20300305_110000.log')]]]), logs});
  assert.equal(claimed.get('6').by, 'lsof');
  assert.equal(claimed.get('7').name, null);
  const shared = pairLogs([proc('8', 0), proc('9', 0)], {openLogs: new Map([['8', [path1('cli-20300305_110000.log')]], ['9', [path1('cli-20300305_110000.log')]]]), logs});
  assert.deepEqual([shared.get('8').name, shared.get('9').name], [null, null]);
  const multi = pairLogs([proc('10', 0)], {openLogs: new Map([['10', [path1('cli-20300305_110000.log'), path1('cli-20300305_100000.log')]]]), logs});
  assert.equal(multi.get('10').name, null);
});

test('실제 조회 어댑터: tmux는 -u로 부르고(한글 세션 이름), ps·lsof 출력을 읽는다', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tmux') return {status: 0, stdout: '1815 kadan-작업자-한글\n99 kadan-b c\nbad line\n'};
    if (cmd === 'ps') return {status: 0, stdout: ' 1801 1802 Tue Mar  5 15:19:46 2030 /fake/bin/agy\n  7  1 Tue Mar  5 09:01:02 2030 /sbin/launchd\n'};
    return {status: 1, stdout: 'p1801\nn/home/fake/.gemini/antigravity-cli/log/cli-20300305_151947.log\nn/home/fake/.gemini/antigravity-cli/log\np5\nn/etc/hosts\n'};
  };
  const deps = realDeps({home: tmp, env: {}, run});
  assert.deepEqual(deps.rolePanes(), [{panePid: '1815', session: 'kadan-작업자-한글'}, {panePid: '99', session: 'kadan-b c'}]);
  assert.equal(calls[0][0], 'tmux');
  assert.equal(calls[0][1], '-u');
  assert.equal(calls[0][2], '-L');
  const procs = deps.listProcesses();
  assert.deepEqual(procs.map(proc => [proc.pid, proc.ppid, proc.comm]), [['1801', '1802', '/fake/bin/agy'], ['7', '1', '/sbin/launchd']]);
  assert.equal(procs[0].startMs, local(2030, 2, 5, 15, 19, 46));
  assert.deepEqual([...deps.openLogs(['1801', '5'])], [['1801', ['/home/fake/.gemini/antigravity-cli/log/cli-20300305_151947.log']], ['5', []]]);
});

// ---- PR #488 검수 반례(exec-34e0b42a)의 회귀 시험. 값은 모두 합성값(2030년·1000번대 PID·example.invalid)이다. ----
const GOAL = 'goal@example.invalid';
const OLDER = 'other@example.invalid';
const LATER = 'later@example.invalid';
const t2 = (hour, minute = 0, second = 0) => new Date(2030, 6, 12, hour, minute, second).getTime();
const authAt = (stamp, who) => `I0712 ${stamp} 1001 server_oauth.go:1] OAuth: authenticated successfully as ${who}`;
const refreshAt = stamp => `I0712 ${stamp} 1001 browser.go:1] token refreshed, new expiry=2030-07-12 13:00:00 ${TZ}`;
const acquireAt = stamp => `I0712 ${stamp} 1001 browser.go:1] consumerOAuth: token acquired, expiry=2030-07-12 13:00:00 ${TZ}`;
const procOf = (pid, ppid, startMs, comm = 'agy') => ({pid, ppid, startMs, comm});

function review({processes = [], files, panes = [], states = [], open = []}) {
  const dir = path.join(fs.mkdtempSync(path.join(tmp, 'review-')), 'antigravity-cli', 'log');
  fs.mkdirSync(dir, {recursive: true});
  const logs = files.map(([name, lines]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return {file, startMs: logStartMs(name), mtimeMs: t2(12, 59)};
  });
  const kills = [];
  const deps = {
    now: () => t2(13), listProcesses: () => processes, listLogs: () => logs,
    openLogs: () => new Map(open.map(([pid, index]) => [pid, [logs[index].file]])),
    readLog: readAgyLog, rolePanes: () => [], seniorPanes: () => panes, rottieTabs: () => [],
    seniorStates: () => new Map(states), assertWritable: () => {},
    kill: dir => { kills.push(dir); return {killed: true}; },
  };
  return {deps, kills};
}
const knownLog = ['cli-20300712_110000.log', [authAt('11:00:00.100000', GOAL)]];
const otherLog = ['cli-20300712_120002.log', [authAt('12:00:02.100000', OLDER)]];
const SENIOR = 'senior-fake';
const FAKE_DIR = '/fake/advice/one';
const closeGoal = deps => { const {rest, flags} = parseFlags(['accounts', '--close-seniors', '--target', 'goal']); return runAgyAccounts(rest, flags, deps); };

test('[검수 대조군] lsof로 확정된 다른 계정이라도 기록이 맞지 않는 창(generation-differs)은 닫지 않는다', () => {
  const {deps, kills} = review({files: [knownLog, otherLog], processes: [procOf('1101', '1', t2(11)), procOf('1120', '1', t2(12, 0, 1))],
    panes: [{panePid: '1120', session: SENIOR}], open: [['1101', 0], ['1120', 1]],
    states: [[SENIOR, {state: 'active', why: 'generation-differs', dir: FAKE_DIR}]]});
  assert.match(closeGoal(deps), /generation-differs/);
  assert.deepEqual(kills, []);
});

test('[검수 대조군] lsof로 확정된 다른 계정의 끝난 창 하나는 닫는다', () => {
  const {deps, kills} = review({files: [knownLog, otherLog], processes: [procOf('1101', '1', t2(11)), procOf('1120', '1', t2(12, 0, 1))],
    panes: [{panePid: '1120', session: SENIOR}], open: [['1101', 0], ['1120', 1]], states: [[SENIOR, {state: 'kept', dir: FAKE_DIR}]]});
  assert.match(closeGoal(deps), /^끔  senior-fake \(PID 1120\)$/m);
  assert.deepEqual(kills, [FAKE_DIR]);
});

test('[검수 반례 1] 한 로그를 시각 후보로 삼는 프로세스가 둘이면 둘 다 계정 모름이고 시니어 두 창을 모두 남긴다', () => {
  const {deps, kills} = review({files: [knownLog, otherLog],
    processes: [procOf('1101', '1', t2(11)), procOf('1120', '1', t2(12)), procOf('1130', '1', t2(12, 0, 3))],
    panes: [{panePid: '1120', session: SENIOR}, {panePid: '1130', session: 'senior-fake-two'}], open: [['1101', 0]],
    states: [[SENIOR, {state: 'kept', dir: FAKE_DIR}], ['senior-fake-two', {state: 'kept', dir: '/fake/advice/two'}]]});
  const pairs = collectAgy(deps).rows.map(({pid, pairedBy}) => [pid, pairedBy]);
  closeGoal(deps);
  assert.deepEqual({pairs, kills}, {pairs: [['1101', 'lsof'], ['1120', null], ['1130', null]], kills: []});
  // 한 프로세스에 시각 후보 로그가 둘이어도 모름이다(유일할 때만 짝을 정한다).
  const two = pairLogs([{pid: '1140', startMs: t2(12, 0, 1)}], {openLogs: new Map(), logs: [
    {name: 'cli-20300712_120000.log', startMs: t2(12)}, {name: 'cli-20300712_120002.log', startMs: t2(12, 0, 2)}]});
  assert.equal(two.get('1140').name, null);
});

test('[검수 반례 2] 같은 시니어 창에 목표 계정 프로세스가 함께 있으면 창을 남긴다', () => {
  const {deps, kills} = review({files: [knownLog, otherLog],
    processes: [procOf('1120', '1', t2(11), 'shell'), procOf('1101', '1120', t2(11)), procOf('1130', '1120', t2(12))],
    panes: [{panePid: '1120', session: SENIOR}], open: [['1101', 0], ['1130', 1]], states: [[SENIOR, {state: 'kept', dir: FAKE_DIR}]]});
  const text = closeGoal(deps);
  assert.deepEqual(kills, []);
  assert.match(text, /^둠  senior-fake \(PID 1101, 1130\) — 같은 창에 목표 계정 프로세스가 있음\(PID 1101\)$/m);
});

test('[검수 반례 3] 같은 시니어 창에 계정 모름 프로세스가 함께 있으면 창을 남긴다', () => {
  const unknownLog = ['cli-20300712_120500.log', ['I0712 12:05:00.100000 1001 boot']];
  const {deps, kills} = review({files: [knownLog, otherLog, unknownLog],
    processes: [procOf('1101', '1', t2(11)), procOf('1120', '1', t2(12), 'shell'), procOf('1130', '1120', t2(12)), procOf('1140', '1120', t2(12, 5))],
    panes: [{panePid: '1120', session: SENIOR}], open: [['1101', 0], ['1130', 1], ['1140', 2]], states: [[SENIOR, {state: 'kept', dir: FAKE_DIR}]]});
  const text = closeGoal(deps);
  assert.deepEqual(kills, []);
  assert.match(text, /^둠  senior-fake \(PID 1130, 1140\) — 같은 창에 계정 모름 프로세스가 있음\(PID 1140\)$/m);
});

test('[검수 반례 4] 같은 초의 토큰 갱신은 소수초까지 비교해 파일 순서와 무관하게 더 늦은 사건을 고른다', () => {
  const one = ['cli-20300712_110000.log', [authAt('11:00:00.100000', OLDER), refreshAt('12:00:00.100000')]];
  const two = ['cli-20300712_110500.log', [authAt('11:05:00.100000', LATER), refreshAt('12:00:00.900000')]];
  const from = files => collectAgy(review({files}).deps).overwrite.account;
  assert.deepEqual([from([one, two]), from([two, one])], [LATER, LATER]);
  // 소수초까지 같은 두 사건의 계정이 다르면 모름이다.
  const tie = ['cli-20300712_110800.log', [authAt('11:08:00.100000', LATER), refreshAt('12:00:00.100000')]];
  const text = runAgyAccounts(['accounts'], {}, review({files: [one, tie]}).deps);
  assert.match(text, /추정\): 모름\(같은 시각의 최근 사건들이 서로 다른 계정\)/);
  // 소수초까지 같아도 계정이 같으면 그 계정이다.
  const same = ['cli-20300712_110900.log', [authAt('11:09:00.100000', OLDER), refreshAt('12:00:00.100000')]];
  assert.equal(collectAgy(review({files: [one, same]}).deps).overwrite.account, OLDER);
});

test('[검수 반례 5] 가장 최근 로그인 사건의 계정을 못 정하면 예전 계정을 최신으로 내지 않고 모름이다', () => {
  const text = runAgyAccounts(['accounts'], {}, review({files: [
    ['cli-20300712_110000.log', [authAt('11:00:00.100000', OLDER), refreshAt('12:00:00.100000')]],
    ['cli-20300712_110500.log', [authAt('11:05:00.100000', OLDER), acquireAt('12:30:00.100000')]],
  ]}).deps);
  assert.match(text, /추정\): 모름\(가장 최근 사건 계정 미확정\)/);
  assert.doesNotMatch(text, /oth…/);
});

test('공개 저장소 점검: 이 시험이 쓰는 계정은 모두 example.invalid 가짜 주소다', () => {
  const source = [fs.readFileSync(new URL(import.meta.url), 'utf8'), fs.readFileSync(new URL('./agy-log.test.mjs', import.meta.url), 'utf8')].join('\n');
  const addresses = source.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [];
  assert.ok(addresses.length > 0);
  for (const address of addresses) assert.match(address, /@example\.invalid$/);
});
