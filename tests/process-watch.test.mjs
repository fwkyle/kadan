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
  // 큰 프로세스는 같은 PID가 10분 이어질 때만(아래 '지속 시간' 시험이 전체를 다룬다)
  const proc = {pid: 9, name: 'node', rssMb: 1100, session: 'a'};
  const one = assessProcesses(assessProcesses(null, snap({biggest: [proc]}), t, 0).state, snap({biggest: [proc]}), t, 600_000);
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

test('F4: since가 원장 줄에 적히고 복원되며, 같은 표본 재평가에도 같은 since·같은 알림 키 재료', async () => {
  const {recordAlert, seedAlertState} = await import('../src/watch-alert-body.mjs');
  const t = DEFAULT_THRESHOLDS, A = snap({rssMb: 13 * 1024});
  const first = assessProcesses(null, A, t, 123456).alerts[0];
  const lines = [];
  recordAlert(e => lines.push({t: '2026-10-31T00:00:00.000Z', ...e}), first, '@user', true);
  assert.equal(lines[0].since, 123456);
  const restored = seedAlertState(lines).active.find(a => a.id === 'process:memory');
  assert.equal(restored.since, 123456);
  const again = assessProcesses({processAlert: restored, normalCycles: 0}, A, t, 987654).alerts[0];
  assert.equal(again.since, 123456, '재시작 뒤 같은 표본 재평가에도 since 유지');
  // since 없는 옛 줄은 지금처럼 동작한다(복원 undefined, 재평가가 새 시각을 매김)
  const old = seedAlertState([{t: 'x', kind: 'alert', id: 'process:memory', alertKind: '프로세스', level: 'RED', signals: ['total'], text: 't'}])
    .active.find(a => a.id === 'process:memory');
  assert.equal('since' in old, false);
  assert.equal(assessProcesses({processAlert: old, normalCycles: 0}, A, t, 555).alerts[0].since, 555);
});

// ── 큰 프로세스 경보: 같은 PID가 오래 넘을 때만 ──
const MIN = 60_000;
const P = (pid, rssMb = 1500) => ({pid, name: 'node', rssMb, session: 'a'});
const withBig = (...procs) => snap({biggest: [...procs].sort((a, b) => b.rssMb - a.rssMb), bigAll: procs});
// 60초 간격 수집으로 표본 목록을 흘려 보낸다. 마지막 결과와 모든 경보를 돌려준다.
function run(samples, { state = null, start = 0, thresholds = DEFAULT_THRESHOLDS } = {}) {
  let r = {state, alerts: []};
  const all = [];
  samples.forEach((sample, i) => { r = assessProcesses(r.state, sample, thresholds, start + i * MIN); all.push(r.alerts); });
  return { ...r, all };
}

test('processSustainMin 시작값은 10분이고 잘못된 값은 시작값으로 돈다', () => {
  assert.equal(DEFAULT_THRESHOLDS.processSustainMin, 10);
  assert.equal(processThresholds({processWatch: {processSustainMin: 0}}).processSustainMin, 10);
  assert.equal(processThresholds({processWatch: {processSustainMin: 3}}).processSustainMin, 3);
});

test('(a) 짧게 사는 PID가 차례로 1G를 넘어도 어느 것도 10분이 안 되면 경보 0건', () => {
  const samples = [
    ...Array(6).fill(withBig(P(11))), ...Array(2).fill(withBig(P(12, 3000))), ...Array(4).fill(withBig(P(13, 2400))),
    snap(), snap(),
  ];
  const r = run(samples);
  assert.deepEqual(r.all.flat(), []);
});

test('(b) 같은 PID가 10분 넘게 1G 이상이면 RED 경보가 열려 있다(수정 전후 모두 통과)', () => {
  const r = run(Array(12).fill(withBig(P(21))));
  assert.equal(r.all[11].length, 1);
  assert.equal(r.all[11][0].level, 'RED');
  assert.deepEqual(r.all[11][0].signals, ['process']);
});

test('(b2) 큰 프로세스 경보는 10분이 되는 수집에서 열리고 오래 넘은 PID 목록을 적는다', () => {
  const r = run(Array(12).fill(withBig(P(21))));
  assert.deepEqual(r.all.slice(0, 10).map((a) => a.length), Array(10).fill(0), '0~9분');
  assert.equal(r.all[10].length, 1, '10분');
  assert.deepEqual(r.all[10][0].pids, [21]);
  assert.equal(r.all[10][0].since, 10 * MIN);
});

test('(c) PID가 9분 넘다가 사라지고 새 PID가 나타나면 시계가 이어지지 않는다', () => {
  const r = run([...Array(10).fill(withBig(P(31))), ...Array(10).fill(withBig(P(32)))]);
  assert.deepEqual(r.all.flat(), [], '새 PID는 처음부터 다시 잰다(19분 지나도 9분)');
  // 같은 PID가 한 번 기준 아래로 내려갔다 다시 넘어도 처음부터 다시 잰다
  const dip = run([...Array(9).fill(withBig(P(33))), snap(), ...Array(9).fill(withBig(P(33)))]);
  assert.deepEqual(dip.all.flat(), []);
});

test('(d) 합계 12G 이상은 지속 시간 없이 바로 RED', () => {
  const r = run([snap({rssMb: 13 * 1024})]);
  assert.equal(r.all[0].length, 1);
  assert.equal(r.all[0][0].level, 'RED');
  assert.deepEqual(r.all[0][0].signals, ['total']);
});

test('(e) 1G 넘는 PID가 여럿이면 짧은 큰 것보다 오래 붙은 작은 것이 10분이 될 때 울린다', () => {
  const samples = Array.from({length: 12}, (_, i) => withBig(P(41, 1200), P(100 + i, 3000)));
  const r = run(samples);
  assert.deepEqual(r.all.slice(0, 10).flat(), []);
  assert.deepEqual(r.all[10][0].pids, [41], '매번 바뀌는 3G 쪽이 아니라 오래 붙은 1.2G');
});

test('수집 실패는 PID 시계를 지우지 않는다(9분 뒤 한 번 못 읽어도 다음 수집에서 10분)', () => {
  const r = run([...Array(10).fill(withBig(P(51))), {ok: false}, withBig(P(51))]);
  assert.equal(r.all[10].length, 0, '실패 주기에는 경보 없음');
  assert.equal(r.all[11].length, 1, '시계가 이어져 11분째 열림');
});

test('경보가 열린 뒤 PID가 사라지면 3주기 정상 뒤 닫히고, 문구 키(since)는 PID 목록으로 바뀌지 않는다', () => {
  const open = run(Array(12).fill(withBig(P(61))));
  const since = open.all[10][0].since;
  assert.equal(open.all[11][0].since, since);
  const swapped = run([withBig(P(61), P(62))], {state: open.state, start: 12 * MIN});
  assert.equal(swapped.all[0][0].since, since, '오래 붙은 PID가 하나 더 늘어도 같은 키');
  const closed = run([snap(), snap(), snap()], {state: open.state, start: 12 * MIN});
  assert.deepEqual(closed.all.map((a) => a.length), [1, 1, 0]);
});

test('재시작: 오래 넘은 PID 경보로 시작하면 같은 PID는 이어서 센다(해소·재경보 없음), 없으면 신호가 빠진다', () => {
  const open = run(Array(12).fill(withBig(P(71))));
  const restored = {...open.all[11][0]};
  const state = {processAlert: restored, normalCycles: 0}; // 재시작 직후: 표 없음
  const same = run(Array(5).fill(withBig(P(71))), {state, start: 20 * MIN});
  assert.equal(same.all.every((a) => a.length === 1 && a[0].since === restored.since), true);
  // 경보 since가 방금(기준 집합이 최근에 바뀜)이어도 복원한 PID는 이미 오래 넘은 것으로 본다
  const recent = {processAlert: {...restored, since: 20 * MIN}, normalCycles: 0};
  assert.equal(run([withBig(P(71))], {state: recent, start: 20 * MIN}).all[0].length, 1);
  // 복원한 PID가 사라졌으면 평소대로 3주기 뒤 닫힌다
  const gone = run([snap(), snap(), snap()], {state, start: 20 * MIN});
  assert.deepEqual(gone.all.map((a) => a.length), [1, 1, 0]);
  // 옛 경보(PID 목록 없음)는 채우지 않는다
  const { pids, ...old } = restored;
  const oldRun = run([withBig(P(71))], {state: {processAlert: old, normalCycles: 0}, start: 20 * MIN});
  assert.deepEqual(oldRun.all[0][0].signals, old.signals, '경보는 3주기 유지 중');
  assert.equal(oldRun.all[0][0], oldRun.state.processAlert);
  assert.equal(Object.keys(oldRun.state.bigSince).length, 1);
  assert.equal(oldRun.state.bigSince[71], 20 * MIN, '지금부터 새로 잼');
});

test('bigAll은 세션별 상위 3개·전체 상위 5개 자르기와 상관없이 기준 이상 PID를 모두 담는다', () => {
  const lines = ['  100     1   2048  05:00:00 tmux', '  200   100   4096  05:00:00 zsh'];
  for (let i = 0; i < 8; i++) lines.push(`  ${300 + i}   200 ${1100 * MB}  01:00 node`);
  lines.push(`  400   200 ${900 * MB}  01:00 node`);
  const r = collectProcesses(fakeSpawn({tmux: {status: 0, stdout: '100 s 200\n'}, ps: {status: 0, stdout: lines.join('\n')}}), {socket: 'k'});
  assert(r.biggest.length <= 5 && r.biggest.length < r.bigAll.length, '상위 N개만 남는 기존 목록');
  assert.equal(r.bigAll.length, 8);
  assert(r.bigAll.every((proc) => proc.rssMb >= 1024));
});
