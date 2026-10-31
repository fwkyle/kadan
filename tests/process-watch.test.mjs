import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessProcesses, collectProcesses, parseEtime, parsePs, processThresholds, DEFAULT_THRESHOLDS, DIRECT_GROUP, createProcessCache,
} from '../src/process-watch.mjs';

const MB = 1024; // ps rss는 KB
const SECRET = '--token=SECRET';

// 서버 100 → 직속 gzip/split(300,301), pane 200(세션 a) → node 210(2GB) · claude 211 · python 212(작고 오래됨)
// pane 400(세션 "b c") → node 410. 서버 밖 launchd(1) 아래 python 900(3GB)은 세지 않는다.
const PS = [
  `  100     1   20480  05:00:00 /opt/homebrew/bin/tmux`,
  `  300   100    1024  05:00:00 /usr/bin/gzip`,
  `  301   100     512  05:00:00 /usr/bin/split`,
  `  200   100    4096  05:00:00 /bin/zsh`,
  `  210   200 ${2048 * MB}  01:00:00 /opt/nvm dir/bin/node`,
  `  211   200 ${300 * MB}  01:00:00 claude`,
  `  212   210    5120  3-02:00:00 /usr/bin/python3.12`,
  `  400   100    4096  05:00:00 /bin/bash`,
  `  410   400 ${100 * MB}  02:00 node`,
  `  900     1 ${3072 * MB}  3-00:00:00 /usr/bin/python3`,
  `이건 깨진 줄`,
].join('\n');
const PANES = '100 a 200\n100 b c 400\n';

const fakeSpawn = (overrides = {}) => (command, args) => {
  if (command === 'tmux') return overrides.tmux ?? {status: 0, stdout: PANES};
  if (command === 'ps') return overrides.ps ?? {status: 0, stdout: PS};
  throw new Error(`예상 밖 호출 ${command}`);
};

test('etime 변환과 comm에 공백이 든 줄 읽기', () => {
  assert.equal(parseEtime('02:03'), 123);
  assert.equal(parseEtime('01:02:03'), 3723);
  assert.equal(parseEtime('3-02:00:00'), 3 * 86400 + 7200);
  assert.equal(parseEtime('이상함'), null);
  const rows = parsePs(PS);
  assert.equal(rows.length, 10);
  assert.equal(rows.find(r => r.pid === 210).name, 'node');
});

test('세션 귀속·서버 직속 묶음·서버 밖 제외·종류별 개수·오래 남은 작은 프로세스', () => {
  const calls = [];
  const result = collectProcesses((c, a) => { calls.push(c); return fakeSpawn()(c, a); }, {socket: 'kadan'});
  assert.deepEqual(calls, ['tmux', 'ps'], 'tmux 1회 + ps 1회');
  assert.equal(result.ok, true);
  const by = Object.fromEntries(result.sessions.map(s => [s.session, s]));
  assert.deepEqual(Object.keys(by).sort(), [DIRECT_GROUP, 'a', 'b c'].sort());
  assert.equal(by.a.count, 4);
  assert.equal(by.a.kinds.node, 1); assert.equal(by.a.kinds.claude, 1); assert.equal(by.a.kinds.python, 1);
  assert.equal(by.a.leak, 1, '3일 넘은 5MB python 하나');
  assert.equal(by.a.big[0].pid, 210);
  assert.equal(by.a.big[0].rssMb, 2048);
  assert.equal(by['b c'].count, 2);
  assert.equal(by[DIRECT_GROUP].kinds.gzip, 1);
  assert.equal(by[DIRECT_GROUP].kinds.split, 1);
  assert.equal(result.count, 9, '서버 밖 python 900은 세지 않는다');
  assert.equal(result.kinds.python, 1);
  assert.equal(result.sessions[0].session, 'a', 'RSS 순');
});

test('tmux·ps를 못 읽으면 0개로 꾸미지 않고 ok:false', () => {
  assert.equal(collectProcesses(fakeSpawn({tmux: {status: 1, stdout: ''}}), {socket: 'x'}).ok, false);
  assert.equal(collectProcesses(fakeSpawn({tmux: {status: 0, stdout: ''}}), {socket: 'x'}).ok, false);
  assert.equal(collectProcesses(fakeSpawn({ps: {status: 1, stdout: ''}}), {socket: 'x'}).ok, false);
});

test('설정 값이 없거나 잘못되면 키별로 시작값', () => {
  assert.deepEqual(processThresholds(null), DEFAULT_THRESHOLDS);
  assert.deepEqual(processThresholds({}), DEFAULT_THRESHOLDS);
  assert.deepEqual(processThresholds({processWatch: 'x'}), DEFAULT_THRESHOLDS);
  assert.deepEqual(processThresholds({processWatch: {totalGb: -1, processGb: 'a', python: 0, node: NaN}}), DEFAULT_THRESHOLDS);
  assert.deepEqual(processThresholds({processWatch: {totalGb: 20, node: 5}}), {...DEFAULT_THRESHOLDS, totalGb: 20, node: 5});
});

const snap = (patch = {}) => ({
  ok: true, count: 10, rssMb: 1000, leak: 0, biggest: [{pid: 1, name: 'node', rssMb: 100, session: 'a'}],
  kinds: {python: 0, node: 0}, sessions: [{session: 'a', count: 10, rssMb: 1000, big: [{pid: 1, name: 'node', rssMb: 100}]}], ...patch,
});

test('경보: 열림 → 같은 기준 집합이면 같은 신호 → 집합 바뀜 → 내려가도 3주기 뒤 닫힘', () => {
  const t = DEFAULT_THRESHOLDS;
  let r = assessProcesses(null, snap(), t);
  assert.deepEqual(r.alerts, []);
  const big = snap({rssMb: 13 * 1024});
  r = assessProcesses(r.state, big, t);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].kind, '프로세스');
  assert.equal(r.alerts[0].level, 'RED');
  assert.deepEqual(r.alerts[0].signals, ['total']);
  const first = r.alerts[0];
  r = assessProcesses(r.state, big, t);
  assert.deepEqual(r.alerts[0].signals, first.signals, '같은 상태');
  const withNode = snap({rssMb: 13 * 1024, kinds: {python: 0, node: 40}});
  r = assessProcesses(r.state, withNode, t);
  assert.deepEqual(r.alerts[0].signals, ['total', 'node']);
  // 못 읽은 주기는 닫힘으로 세지 않는다
  for (let i = 0; i < 5; i++) r = assessProcesses(r.state, {ok: false}, t);
  assert.equal(r.alerts.length, 1);
  r = assessProcesses(r.state, snap(), t); assert.equal(r.alerts.length, 1);
  r = assessProcesses(r.state, snap(), t); assert.equal(r.alerts.length, 1);
  r = assessProcesses(r.state, snap(), t); assert.equal(r.alerts.length, 0, '3번째 정상 주기에 닫힘');
});

test('보조 기준만 넘으면 AMBER, 큰 프로세스 1GB는 RED', () => {
  const t = DEFAULT_THRESHOLDS;
  assert.equal(assessProcesses(null, snap({kinds: {python: 31, node: 0}}), t).alerts[0].level, 'AMBER');
  const one = assessProcesses(null, snap({biggest: [{pid: 9, name: 'node', rssMb: 1100, session: 'a'}]}), t);
  assert.equal(one.alerts[0].level, 'RED');
  assert.deepEqual(one.alerts[0].signals, ['process']);
});

test('명령줄 전체는 요청하지 않고, 수집 결과·경보 본문 어디에도 없다', () => {
  // 가짜 ps는 args/command 열을 요청받았을 때만 비밀이 든 명령줄을 돌려준다.
  const seen = [];
  const spawn = (command, args) => {
    if (command !== 'ps') return fakeSpawn()(command, args);
    seen.push(args.join(' '));
    const asked = args.some(a => /^(args|command)=?/.test(a)) || /(^| )-o?\s?(args|command)/.test(args.join(' '));
    return {status: 0, stdout: asked ? PS.replace('/opt/nvm dir/bin/node', `/opt/nvm dir/bin/node ${SECRET}`) : PS};
  };
  const result = collectProcesses(spawn, {socket: 'kadan'});
  assert(seen.length === 1 && !/args|command/.test(seen[0]) && seen[0].includes('comm='), seen.join('|'));
  const alert = assessProcesses(null, result, {...DEFAULT_THRESHOLDS, totalGb: 0.001}).alerts[0];
  assert(alert, '낮춘 기준이라 경보가 난다');
  assert(alert.text.includes('node#210'), 'PID·이름·RSS는 담긴다');
  assert(!JSON.stringify(result).includes('SECRET'));
  assert(!alert.text.includes('SECRET') && !alert.text.includes('--token'));
});

test('6천 줄 입력(10배)을 파싱·트리하는 시간이 1초 안이다 (고정 문자열, 실제 프로세스 안 늘림)', () => {
  const lines = ['    1     0   1000  10:00:00 /opt/tmux'];
  const panes = [];
  for (let s = 0; s < 20; s++) {
    lines.push(`${10 + s} 1 4096 10:00 /bin/zsh`);
    panes.push(`1 s${s} ${10 + s}`);
  }
  for (let i = 0; i < 6000; i++) lines.push(`${1000 + i} ${10 + (i % 20)} ${1 + (i % 50) * 1024} ${i % 7}-01:00:00 /usr/bin/node`);
  const started = performance.now();
  const result = collectProcesses(fakeSpawn({tmux: {status: 0, stdout: panes.join('\n')}, ps: {status: 0, stdout: lines.join('\n')}}), {socket: 'k'});
  const ms = performance.now() - started;
  assert.equal(result.count, 6021);
  assert(ms < 1000, `측정 ${ms.toFixed(1)}ms`);
  if (process.env.PROCESS_WATCH_PRINT_COST) console.log(`cost 6021 lines: ${ms.toFixed(1)}ms`);
});

test('대시보드 재사용 캐시: TTL 안에서는 수집 1회', () => {
  let t = 0, n = 0;
  const get = createProcessCache(() => ({ok: true, n: ++n}), {ttlMs: 15_000, now: () => t});
  get(); t = 14_000; get();
  assert.equal(n, 1);
  t = 15_000; assert.equal(get().n, 2);
  const failing = createProcessCache(() => { throw new Error('boom'); }, {now: () => 0});
  assert.equal(failing().ok, false);
});

test('F1: tmux가 준 서버 PID 행이 ps에 없으면 0개 정상이 아니라 ok:false이고 열린 경보는 닫히지 않는다', () => {
  const t = DEFAULT_THRESHOLDS;
  for (const ps of ['', '이건 깨진 줄\n', '  999     1   2048  05:00:00 /usr/bin/other\n']) {
    const bad = collectProcesses(fakeSpawn({ps: {status: 0, stdout: ps}}), {socket: 'x'});
    assert.equal(bad.ok, false, JSON.stringify(ps));
  }
  let r = assessProcesses(null, snap({rssMb: 13 * 1024}), t);
  assert.equal(r.alerts.length, 1);
  for (let i = 0; i < 5; i++) r = assessProcesses(r.state, collectProcesses(fakeSpawn({ps: {status: 0, stdout: ''}}), {socket: 'x'}), t);
  assert.equal(r.alerts.length, 1, '빈 ps 5번에도 경보 유지');
});

test('F3: 정상 → 수집 실패 → 정상 → 실패 → 정상은 정상 연속이 끊겨 닫히지 않고, 연속 3번 정상만 닫는다', () => {
  const t = DEFAULT_THRESHOLDS, fail = {ok: false};
  let r = assessProcesses(null, snap({rssMb: 13 * 1024}), t);
  for (const sample of [snap(), fail, snap(), fail, snap()]) r = assessProcesses(r.state, sample, t);
  assert.equal(r.alerts.length, 1, '정상 1,실패,정상 1,실패,정상 1');
  assert.equal(r.state.normalCycles, 1);
  r = assessProcesses(r.state, snap(), t); assert.equal(r.alerts.length, 1);
  r = assessProcesses(r.state, snap(), t); assert.equal(r.alerts.length, 0, '이어진 3번째 정상');
});

test('F2 바탕: 기준 집합이 바뀐 시각(since)은 전이마다 달라지고 같은 상태에서는 유지된다', () => {
  const t = DEFAULT_THRESHOLDS;
  const A = snap({rssMb: 13 * 1024}), B = snap({rssMb: 13 * 1024, kinds: {python: 0, node: 40}});
  let r = assessProcesses(null, A, t, 1000); const a1 = r.alerts[0].since;
  r = assessProcesses(r.state, A, t, 2000); assert.equal(r.alerts[0].since, a1, '같은 상태는 유지');
  r = assessProcesses(r.state, B, t, 3000); const b = r.alerts[0].since;
  r = assessProcesses(r.state, A, t, 4000); const a2 = r.alerts[0].since;
  assert.deepEqual([a1, b, a2], [1000, 3000, 4000]);
});
