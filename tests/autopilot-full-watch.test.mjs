import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runWatch} from '../src/watch-runner.mjs';
import {WorkStore} from '../src/work-store.mjs';

// 3라운드(검수 F4): 결정을 기다리는 동안 화면이 멈춰 있어도, 대기가 풀린 시각부터 멈춤을 센다.
// 그래서 풀린 시각 + 유예 뒤 본인 안내(1단, 명령 줄 포함)가 먼저 가고 계속 멈추면 2단이 간다. 가짜 시계·가짜 바닥·가짜 전송만 쓴다.
const MIN = 60_000;
const SUPER = 'p-슈퍼감독';
const parents = new Map([['p-작업자', 'p-감독'], ['p-감독', SUPER], [SUPER, '@user']]);
const iso = ms => new Date(ms).toISOString();

function setup(owner = SUPER) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-full-watch-'));
  new WorkStore(home).create({key: 'repo/w1', title: 't', goal: 'g', scope: 's', acceptance: 'a', owner, repoPath: home});
  return {home, done: () => fs.rmSync(home, {recursive: true, force: true})};
}
const decisionOf = (base, over = {}) => ({id: 'dec-1', revision: 1, status: 'open', chat: true, card: null, work: 'repo/w1', requestedBy: SUPER,
  question: '이 순서로 갈까요?', options: ['예', '아니오'], recommendation: '예', at: iso(base), ...over});
const declared = base => ({reversible: '브랜치를 지운다', notProhibited: {by: SUPER, at: iso(base)}});

async function simulate({home, base, minutes, decisions, ap, idleMs = 15 * MIN, tree = parents}) {
  const starts = [...tree.keys()].map((role, i) => ({kind: 'start', role, session: 'kadan-' + role, panePid: i + 1, t: iso(base)}));
  const records = [], nudges = [], alerts = [], controller = new AbortController();
  let minute = 0, reads = 0;
  const entries = [...starts, {kind: 'send', role: 'p-작업자', taskId: 'e1', t: iso(base)}, {kind: 'done', role: 'p-작업자', taskId: 'e1', result: 'ok', t: iso(base)}];
  const cards = [{key: 'repo/e1', id: 'e1', status: 'done', activity: 'done', workType: 'execution', role: 'p-작업자', board: 'p', at: iso(base), runs: []}];
  const readWorks = () => new WorkStore(home).listWatch().map(w => ({...w, executions: [{key: 'repo/e1', phase: 'implementation', round: 1}]}));
  await runWatch({signal: controller.signal, intervalMs: MIN, stallN: 2, stallAfterMs: 300_000, idleMs,
    parents: tree, routes: new Map(), superRole: SUPER, now: () => base + minute * MIN,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})), read: () => 'frozen screen', alive: () => true},
    readEntries: () => entries, readCards: () => cards, readWorks, readDecisions: () => decisions(minute),
    ...(ap ? {readAutopilotWingman: () => { reads++; return ap; }} : {}),
    sendAlert: (role, msg) => { alerts.push({minute, role, msg}); }, sendNudge: (role, msg) => { nudges.push({minute, role, msg}); },
    record: e => { records.push({...e, minute}); entries.push({...e, t: iso(base + minute * MIN)}); },
    print: () => {}, spawn: () => ({status: 0, stdout: ''}),
    sleep: async () => { if (++minute >= minutes) controller.abort(); }});
  const idle = records.filter(e => e.kind === 'alert' && !e.resolved && e.alertKind === '놀고 있음');
  return {records, nudges, alerts, idle, reads, firstIdle: idle.length ? Math.min(...idle.map(e => e.minute)) : null};
}
const full = base => ({on: true, level: 'full', startedAt: iso(base), decideAfterMs: 30 * MIN});

test('F4: 대기 내내 화면이 멈춰도 자격 시각(30분) 뒤 유예(15분)가 지나서야 본인 안내가 먼저 가고, 계속 멈추면 2단이 간다', async () => {
  const t = setup();
  try {
    const base = Date.now();
    const r = await simulate({home: t.home, base, minutes: 90, ap: full(base), decisions: () => [decisionOf(base, declared(base))]});
    assert.ok(r.firstIdle >= 45 && r.firstIdle <= 46, `첫 놀고 있음은 자격 시각+유예(45분) 뒤: ${r.firstIdle}`);
    const first = r.idle.filter(e => e.minute === r.firstIdle);
    assert.ok(first.length > 0 && first.every(e => !e.id.endsWith(':상위')), '처음 경보는 2단(:상위)이 아니라 1단');
    assert.ok(r.nudges.length > 0, '본인 안내가 갔다');
    assert.equal(r.nudges[0].role, SUPER);
    assert.match(r.nudges[0].msg, /진행할 수 있는지 확인: `kadan decision proceed dec-1 --revision 1`/);
    assert.ok(r.idle.some(e => e.id.endsWith(':상위') && e.minute > r.firstIdle), '계속 멈추면 2단(상위)');
    assert.ok(r.reads <= 90 * 2, `주기당 스냅샷 읽기 ${r.reads}번`);
  } finally { t.done(); }
});

test('F4: 진행 기록이 붙은 결정도 진행 기록 시각부터 멈춤을 센다', async () => {
  const t = setup();
  try {
    const base = Date.now();
    const proceeded = {by: SUPER, at: iso(base + 20 * MIN), recommendation: '예', reversible: '브랜치를 지운다', notProhibited: {by: SUPER, at: iso(base)}};
    const r = await simulate({home: t.home, base, minutes: 70, decisions: () => [decisionOf(base, {...declared(base), proceeded})]});
    assert.ok(r.firstIdle >= 35 && r.firstIdle <= 36, `진행 기록(20분)+유예 뒤: ${r.firstIdle}`);
    assert.ok(r.idle.filter(e => e.minute === r.firstIdle).every(e => !e.id.endsWith(':상위')));
    assert.equal(r.reads, 0, '진행 기록이 붙은 결정은 스냅샷을 읽지 않는다');
  } finally { t.done(); }
});

test('F4: 꺼짐·낮은 단계·표시 없는 평소 결정은 감시 판정이 기준과 같다(계속 답 대기, 경보 없음)', async () => {
  for (const [name, ap, decision] of [
    ['낮은 단계', {...full(Date.now()), level: 'autopilot'}, over => ({...over})],
    ['꺼짐', {on: false}, over => ({...over})],
    ['표시 없는 평소 결정', null, (over, base) => decisionOf(base)],
    ['대기 시간 전(120분)', null, over => ({...over})],
  ]) {
    const t = setup();
    try {
      const base = Date.now();
      const snapshot = name === '대기 시간 전(120분)' ? {...full(base), decideAfterMs: 120 * MIN} : ap ? {...ap, startedAt: iso(base)} : (name === '표시 없는 평소 결정' ? full(base) : null);
      const r = await simulate({home: t.home, base, minutes: 90, ap: snapshot, decisions: () => [decision(decisionOf(base, declared(base)), base)]});
      if (name === '대기 시간 전(120분)') assert.equal(r.firstIdle, null, name + ': 90분 동안 답 대기');
      else assert.equal(r.firstIdle, null, name + ': 계속 답 대기');
      assert.equal(r.nudges.length + r.alerts.length, 0, name);
    } finally { t.done(); }
  }
});

// ===== 4라운드(검수 F5): 요청한 역할과 업무 책임 감독이 다른 흔한 구성 =====
// 작업자 → 일반감독 C → 요청 슈퍼감독 R → 상위 슈퍼감독 T → 사용자. 결정은 R이 C의 업무에 걸었다. 진행 권한은 R뿐이다.
const R = SUPER, C = 'p-감독', T = 't-슈퍼감독';
const tree = new Map([['p-작업자', C], [C, R], [R, T], [T, '@user']]);
const toRole = (r, role) => r.nudges.filter(n => n.role === role);

test('F5: R이 C의 업무 결정을 요청 — 자격 전 모두 대기, 자격 뒤 R에게만 1단+명령 줄, C에게는 없음, 계속 멈추면 R의 상위(T)로 2단', async () => {
  const t = setup(C);
  try {
    const base = Date.now();
    const r = await simulate({home: t.home, base, minutes: 100, tree, ap: full(base), decisions: () => [decisionOf(base, declared(base))]});
    assert.ok(r.firstIdle >= 45 && r.firstIdle <= 46, `자격 시각(30분)+유예(15분) 전에는 R·C 모두 대기: ${r.firstIdle}`);
    assert.deepEqual(toRole(r, C), [], '업무 책임 감독 C에게는 놀고 있음 안내가 없다(할 수 있는 것이 없다)');
    const mine = toRole(r, R);
    assert.ok(mine.length > 0 && mine[0].minute === r.firstIdle, 'R에게 1단');
    assert.match(mine[0].msg, /진행할 수 있는지 확인: `kadan decision proceed dec-1 --revision 1`/);
    assert.ok(r.idle.every(e => !e.id.includes(`:${C}`)), 'C에 대한 놀고 있음 기록이 없다');
    const up = r.idle.filter(e => e.id === `idle:hierarchy:${R}:상위`);
    assert.ok(up.length > 0 && up[0].minute >= r.firstIdle + 14, 'R이 계속 멈추면 R의 상위로 2단');
    assert.ok(r.alerts.some(a => a.role === T) || r.idle.some(e => e.id.endsWith(':상위')), '2단은 R의 상위(T) 경로');
  } finally { t.done(); }
});

test('F5: R이 진행 → 진행 시각부터 센 1단이 C에게 간다(R에게는 더 없음)', async () => {
  const t = setup(C);
  try {
    const base = Date.now();
    const proceedAt = base + 50 * MIN;
    const proceeded = {by: R, at: iso(proceedAt), recommendation: '예', reversible: '브랜치를 지운다', notProhibited: {by: R, at: iso(base)}};
    const r = await simulate({home: t.home, base, minutes: 100, tree, ap: full(base),
      decisions: minute => [decisionOf(base, {...declared(base), ...(minute >= 50 ? {proceeded, revision: 2} : {})})]});
    const forC = toRole(r, C);
    assert.ok(forC.length > 0, '진행 뒤 C의 할 일이 된다');
    assert.ok(forC[0].minute >= 65 && forC[0].minute <= 66, `진행 시각(50분)+유예: ${forC[0].minute}`);
    assert.ok(toRole(r, R).every(n => n.minute < 50 + 15), 'R의 안내는 진행 전(자격 뒤)에만');
  } finally { t.done(); }
});

test('F5: 사람이 답하면 평소대로(결정이 사라져 C가 책임을 되찾고, R에게는 더 안내가 없다)', async () => {
  const t = setup(C);
  try {
    const base = Date.now();
    const r = await simulate({home: t.home, base, minutes: 90, tree, ap: full(base),
      decisions: minute => minute < 40 ? [decisionOf(base, declared(base))] : []});
    assert.ok(toRole(r, R).length === 0 || toRole(r, R).every(n => n.minute < 40 + 1), '답한 뒤 R에게 진행 안내가 없다');
    assert.ok(toRole(r, C).length > 0 || r.idle.some(e => e.minute >= 40), '답한 뒤 업무는 평소처럼 책임 감독의 할 일');
  } finally { t.done(); }
});

test('F5: 요청한 역할이 관계표에 없으면 맡길 곳이 없어 3라운드처럼 업무 책임 감독(C)의 할 일로 둔다', async () => {
  const t = setup(C);
  try {
    const base = Date.now();
    const r = await simulate({home: t.home, base, minutes: 70, tree, ap: full(base),
      decisions: () => [decisionOf(base, {...declared(base), requestedBy: 'x-슈퍼감독'})]});
    assert.ok(r.firstIdle >= 45 && r.firstIdle <= 46);
    assert.ok(toRole(r, C).length > 0, 'C가 안내를 받는다(명령 줄은 요청자에게만 붙으므로 없음)');
    assert.doesNotMatch(toRole(r, C)[0].msg, /decision proceed/);
  } finally { t.done(); }
});
