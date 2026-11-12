// 현황 재료의 조각 기억(src/dashboard/shared.mjs의 piece)이 응답을 바꾸지 않는지 확인한다.
// 기준(오라클)은 같은 코드에서 기억을 끈 계산이다: 같은 수집 결과·같은 시각에서 모든 화면 본문이 글자까지 같아야 한다.
// 수집은 실제 두 단계 loader(임시 SQLite 홈)를 거친다. 손으로 만든 수집 결과는 상류 객체가 매번 새것이라 기억이 맞는지 볼 수 없다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {CardStore} from '../src/card-store.mjs';
import {WorkStore} from '../src/work-store.mjs';
import {DecisionStore} from '../src/decisions.mjs';
import {BriefStore, briefInput} from '../src/human-brief.mjs';
import {EXPLAIN_BY} from '../src/actors.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {floor} from '../src/floor.mjs';
import {loadWallSnapshot} from '../src/commands/tree-wall.mjs';
import {wallCache} from '../src/wall-snapshot-cache.mjs';
import {dashboardData} from '../src/dashboard-api.mjs';
import {dashboardPieces} from '../src/dashboard/shared.mjs';
import {STALE_MS} from '../src/dashboard-execution.mjs';

// 시험이 실제 카단 세션(tmux)을 보지 않게 존재하지 않는 소켓을 쓴다. 살아 있는 세션은 floor.list를 바꿔 준다.
process.env.KADAN_SOCKET = process.env.KADAN_LITE_SOCKET = 'kadan-test-none-' + process.pid;

// 수집이 부르는 OS 조회(ps·vm_stat 등)는 이 시험의 대상이 아니고 한 번에 수십 ms가 든다. 실패한 조회로 바꿔 둔다
// (자원·프로세스 칸은 모름으로 나온다). 이 파일의 프로세스 안에서만 바뀐다.
childProcess.spawnSync = () => ({status: 1, signal: null, stdout: '', stderr: '시험: OS 조회 없음', pid: 0, output: []});
syncBuiltinESMExports();

// 가짜 시계. 저장 모듈이 적는 시각(new Date())은 실제 시각이라, 가짜 시계를 실제보다 한 시간 앞에서 시작해
// 저장된 시각이 모두 과거가 되게 한다. 시각을 직접 정해 넣는 사건만 미래일 수 있다.
function withClock(fn) {
  const real = Date.now;
  let t = real() + 3_600_000;
  Date.now = () => t;
  const list = floor.list;
  try { return fn({now: () => t, tick: ms => { t += ms; }, set: value => { t = value; }}); }
  finally { Date.now = real; floor.list = list; dashboardPieces.enable(true); }
}
const iso = ms => new Date(ms).toISOString();

function makeHome({sqlite = true} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-model-memo-'));
  if (sqlite) { createDatabase(home); writeStorageMarker(home, 'sqlite'); }
  process.env.KADAN_HOME = home;
  wallCache.clear();
  dashboardPieces.clear();
  dashboardPieces.enable(true);
  return home;
}

// 역할: 슈퍼(총괄) → 감독 → 작업자 둘·검수자. 관계표 파일은 원장의 hierarchy-loaded 사건이 가리킨다.
// 결정 요청은 이름이 '슈퍼감독'으로 끝나는 역할만 쓸 수 있다(운영 이름 kadan-슈퍼감독은 쓰지 않는다).
const SUPER = '시험-슈퍼감독';
const ROLES = {[SUPER]: '@user', 감독: SUPER, 작업자: '감독', 작업자2: '감독', 검수자: '감독'};
function fixture(clock, {sqlite = true} = {}) {
  const home = makeHome({sqlite});
  const cards = new CardStore(home), works = new WorkStore(home), briefs = new BriefStore(home);
  const decisions = new DecisionStore(home, {notify: () => {}, userNotify: () => null, threadNote: () => false});
  const hierarchyFile = path.join(home, 'hierarchy.json');
  fs.writeFileSync(hierarchyFile, JSON.stringify(ROLES));
  const sessions = new Map(); // 역할 → pid
  floor.list = () => [...sessions].map(([role, pid]) => ({session: 'kadan-' + role, pid, alive: true}));
  const record = value => appendLedger({t: iso(clock.now() - 1000), ...value}, home);
  record({kind: 'hierarchy-loaded', path: hierarchyFile, hash: 'x', by: 'watch'});
  let pid = 100;
  const start = (role, profile = 'worker') => {
    pid += 1; sessions.set(role, pid);
    record({kind: 'start', role, session: 'kadan-' + role, panePid: pid, pid, by: '사람', roleProfile: profile,
      cmd: 'claude --model claude-test', harness: 'claude', model: 'claude-test'});
  };
  const stop = role => { sessions.delete(role); record({kind: 'stop', role, session: 'kadan-' + role, by: '사람'}); };
  start(SUPER, 'super'); start('감독', 'conductor'); start('작업자'); start('검수자', 'reviewer');
  // 업무 둘(실행 둘씩) + 업무에 묶이지 않은 카드 넷.
  const executions = [];
  for (const [n, owner] of [['첫', '감독'], ['둘째', '감독']]) {
    const key = 'demo/work-' + n;
    works.create({key, title: n + ' 업무', goal: '기억 대조', scope: '격리 시험', acceptance: '같다', owner,
      repoPath: home, board: '시험판'});
    for (const [i, phase] of ['implementation', 'review'].entries()) {
      works.change(key, 'execute', {title: `${n} ${phase}`, body: '# 지시\n\n## Why\n대조 시험', phase, round: 1},
        {revision: works.get(key).revision, by: owner, note: '격리 시험'});
    }
    executions.push(...works.get(key).executions.map(x => x.key));
  }
  for (let i = 1; i <= 4; i++) {
    cards.create({repo: 'demo', id: 'solo-' + i, repoPath: home, title: '혼자 ' + i, body: '# 혼자\n\n## Why\n묶이지 않은 카드', by: '사람'});
    executions.push('demo/solo-' + i);
  }
  const assign = (key, role, extra = {}) => {
    const card = cards.get(key, {body: false});
    // 손으로 하는 발령에는 티키타카 묶음 정보가 필요하다.
    const rally = {rallyId: 'r-' + key.split('/')[1], rallyTitle: '혼자 묶음', rallyRound: '1', rallyStep: 'implementation'};
    cards.update(key, {role, status: 'assigned', board: '시험판', scope: '격리 시험', ...rally, ...extra},
      {revision: card.revision, by: '감독', note: '배정'});
    record({kind: 'send', role, taskId: key, executionKey: key, by: '감독', bytes: 10, digest: 'd' + pid, preview: '발령'});
  };
  assign(executions[0], '작업자', {rallyId: 'r1', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'implementation'});
  assign(executions[1], '검수자', {rallyId: 'r1', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'review'});
  assign(executions[4], '작업자2'); // 세션이 없는 담당 → 확인 필요
  const collect = () => {
    const full = loadWallSnapshot(null, {summaryBodies: true}); full.home = home;
    const list = loadWallSnapshot(null, {listOnly: true, summaryBodies: true}); list.home = home;
    return {full, list};
  };
  return {home, cards, works, briefs, decisions, hierarchyFile, sessions, record, start, stop, assign, executions, collect};
}

// 화면 재료(model)를 쓰는 모든 화면의 주소. 업무 목록·상세는 서버처럼 목록용 수집으로 답한다.
function urlsOf(f) {
  const card = encodeURIComponent(f.executions[0]), solo = encodeURIComponent(f.executions[4]);
  return [
    '/api/dashboard/status', '/api/dashboard/status?super=' + encodeURIComponent(SUPER), '/api/dashboard/status?super=none',
    '/api/dashboard/status?repo=demo', '/api/dashboard/status?works=all',
    '/api/dashboard/workspace', '/api/dashboard/workspace?collection=executions&state=all',
    '/api/dashboard/workspace?collection=unlinked', '/api/dashboard/workspace?collection=executions&layout=wall',
    '/api/dashboard/workspace?collection=executions&layout=map', '/api/dashboard/workspace?collection=work&layout=map&state=all',
    '/api/dashboard/workspace?collection=executions&bucket=stale&state=all',
    '/api/dashboard/kanban', '/api/dashboard/kanban?group=owner', '/api/dashboard/kanban?repo=demo',
    '/api/dashboard/flow-unconfirmed', '/api/dashboard/sessions', '/api/dashboard/runs',
    '/api/dashboard/detail?card=' + card, '/api/dashboard/detail?card=' + solo,
    '/api/dashboard/detail?card=' + encodeURIComponent('demo/work-첫'), '/api/dashboard/detail?card=none',
    '/api/dashboard/review-result?card=' + card,
  ];
}
const usesList = url => /\/(workspace|detail)(\?|$)/.test(url);
// 같은 수집 결과를 내용은 그대로, 객체만 새로 만든다(수집 결과에 묶인 기억을 건너뛰게). getter는 부르지 않고 옮긴다.
const copyOf = snapshot => Object.defineProperties({}, Object.getOwnPropertyDescriptors(snapshot));
function bodies(f, {full, list}) {
  const out = new Map();
  for (const url of urlsOf(f)) {
    try { out.set(url, JSON.stringify(dashboardData(usesList(url) ? list : full, new URL(url, 'http://127.0.0.1')))); }
    catch (error) { out.set(url, `오류 ${error.status ?? 503} ${error.message}`); }
  }
  return out;
}
// 기억을 켠 계산과 끈 계산(같은 수집 결과의 사본, 같은 시각)이 모든 주소에서 글자까지 같다.
function assertSame(f, snapshots, label) {
  const withMemo = bodies(f, snapshots);
  dashboardPieces.enable(false);
  let plain;
  try { plain = bodies(f, {full: copyOf(snapshots.full), list: copyOf(snapshots.list)}); }
  finally { dashboardPieces.enable(true); }
  for (const [url, body] of withMemo) assert.equal(body, plain.get(url), `${label}: ${url}`);
  return withMemo;
}
const json = (map, url) => JSON.parse(map.get(url));
const misses = names => Object.fromEntries(names.map(name => [name, dashboardPieces.counts()[name]?.miss ?? 0]));
const hits = names => Object.fromEntries(names.map(name => [name, dashboardPieces.counts()[name]?.hit ?? 0]));
const HEAVY = ['briefs', 'workspace-rows', 'rows', 'worktimes', 'review-flows', 'by-key', 'hierarchy-path', 'hierarchy',
  'previous-generation', 'open-alerts', 'super-profiles', 'stale-cards', 'board-counts', 'waiting-questions'];
const status = '/api/dashboard/status';

test('사건 없는 두 번째 수집: 조각을 다시 계산하지 않고, 본문은 기억을 끈 계산과 같다', () => withClock(clock => {
  const f = fixture(clock);
  const first = f.collect();
  dashboardData(first.full, new URL(status, 'http://127.0.0.1'));
  const before = misses(HEAVY), hitsBefore = hits(HEAVY);
  for (const name of HEAVY) assert.ok(before[name] >= 1, `첫 계산: ${name}`);
  clock.tick(15_000);
  const second = f.collect();
  assert.notEqual(second.full, first.full, '수집 결과는 새 객체다');
  assert.equal(second.full.center.cards, first.full.center.cards, '카드 상태는 같은 객체로 재사용된다');
  assert.equal(second.full.entries, first.full.entries);
  dashboardData(second.full, new URL(status, 'http://127.0.0.1'));
  assert.deepEqual(misses(HEAVY), before, '사건이 없으면 다시 계산한 조각이 없다');
  for (const name of HEAVY) assert.equal(hits(HEAVY)[name], hitsBefore[name] + 1, `재사용: ${name}`);
  // 목록용 수집(업무 뺀 실행 목록)도 같은 카드·설명 조각을 재사용한다.
  dashboardData(second.list, new URL('/api/dashboard/workspace?collection=executions', 'http://127.0.0.1'));
  assert.deepEqual(misses(['briefs', 'workspace-rows', 'worktimes', 'review-flows']),
    Object.fromEntries(['briefs', 'workspace-rows', 'worktimes', 'review-flows'].map(n => [n, before[n]])));
  assert.equal(misses(['rows-executions'])['rows-executions'], 1);
  assertSame(f, second, '두 번째 수집');
  // 기억을 끄면 같은 입력이어도 매번 계산한다(오라클이 실제로 다시 계산하는지).
  const off = () => dashboardPieces.counts().rows.off;
  const offBefore = off();
  dashboardPieces.enable(false);
  dashboardData(copyOf(second.full), new URL(status, 'http://127.0.0.1'));
  dashboardPieces.enable(true);
  assert.equal(off(), offBefore + 1);
  assert.deepEqual(misses(HEAVY), before, '기억을 끈 계산은 기억을 건드리지 않는다');
}));

// 씨앗을 고정한 난수(mulberry32).
const random = seed => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('무작위 사건 대조: 역할·우편·카드·업무·설명·결정 사건과 사건 없는 수집을 섞어도 모든 화면 본문이 같다', () => withClock(clock => {
  for (const seed of [20261112, 7]) {
    const f = fixture(clock), rand = random(seed), pickOne = list => list[Math.floor(rand() * list.length)];
    const open = [];
    let n = 0, quiet = 0, reused = 0;
    const actions = [
      () => {}, () => {}, // 사건 없음
      () => f.record({kind: 'alert', id: 'a' + (n % 3), alertKind: '정체', level: 'warn', role: pickOne(['작업자', '검수자']),
        session: 'kadan-작업자', recipient: pickOne(['감독', SUPER]), by: 'watch', resolved: rand() < 0.3}),
      () => f.record({kind: 'send', mailId: 'm' + n, mailRule: 1, role: pickOne(['감독', '작업자']), by: pickOne(['작업자', SUPER]),
        bytes: 5, digest: 'x' + n, preview: '우편 ' + n, ...(rand() < 0.5 ? {expectReply: true} : {})}),
      () => { const key = pickOne(f.executions), card = f.cards.get(key, {body: false});
        f.cards.update(key, {}, {revision: card.revision, by: card.role || '감독', noteKind: 'progress', note: '진행 ' + n}); },
      () => { const key = pickOne(f.executions), card = f.cards.get(key, {body: false});
        if (card.role) f.cards.update(key, {activity: pickOne(['running', 'waiting'])},
          {revision: card.revision, by: card.role, noteKind: 'progress', note: '활동 ' + n}); },
      () => { const key = pickOne(f.executions.slice(4));
        if (f.cards.get(key, {body: false}).status === 'draft') f.assign(key, pickOne(['작업자', '작업자2', '검수자'])); },
      () => { const key = pickOne(f.executions), card = f.cards.get(key, {body: false});
        if (card.role) f.record({kind: 'done', role: card.role, taskId: key, executionKey: key, result: pickOne(['ok', 'failed']), by: '감독'}); },
      () => { const key = pickOne(['demo/work-첫', 'demo/work-둘째']), work = f.works.get(key);
        f.works.change(key, 'update', {progress: '진척 ' + n}, {revision: work.revision, by: '감독', note: '대조'}); },
      () => { const key = pickOne(f.executions), card = f.cards.get(key, {body: false});
        f.briefs.write(key, {revision: card.revision, title: '쉬운 제목 ' + n, workstream: '대조', summary: '요약 ' + n}, '감독'); },
      () => open.push(f.decisions.request(pickOne(f.executions), {question: '질문 ' + n, options: ['가', '나'], recommendation: '가',
        reason: '대조 시험\n- 확인 경로 없음: 격리 시험의 결정', work: '없음'}, SUPER)),
      () => { const d = open.shift(); if (d) f.decisions.answer(d.id, {revision: f.decisions.get(d.id).revision, choice: '가'}, '사람'); },
      () => (f.sessions.has('작업자2') ? f.stop('작업자2') : f.start('작업자2')),
      () => f.start('감독', rand() < 0.5 ? 'super' : 'conductor'), // 슈퍼감독 프로필이 바뀜
      () => fs.writeFileSync(f.hierarchyFile, JSON.stringify(rand() < 0.5 ? ROLES : {...ROLES, 작업자2: SUPER})),
      () => clock.tick(61_000),      // 업무 목록 계산의 60초 만료
      () => clock.tick(11 * 60_000), // 상류 기억의 10분 만료
    ];
    for (let step = 0; step < 30; step++) {
      n = step;
      const action = step % 3 === 2 ? actions[0] : pickOne(actions);
      action();
      clock.tick(1000 + Math.floor(rand() * 4000));
      const before = dashboardPieces.counts().rows?.hit ?? 0;
      assertSame(f, f.collect(), `씨앗 ${seed} 단계 ${step}`);
      if (action === actions[0]) quiet++;
      if ((dashboardPieces.counts().rows?.hit ?? 0) > before) reused++;
    }
    assert.ok(quiet >= 8 && reused >= 8, `빈 증명이 아니다: 사건 없는 단계 ${quiet} · 행 재사용 ${reused}`);
  }
}));

test('결정은 수집보다 새롭다: 같은 수집 결과 위에서 결정이 추가되면 그 요청의 결정 목록으로 답한다', () => withClock(clock => {
  const f = fixture(clock);
  const snapshots = f.collect();
  const before = json(assertSame(f, snapshots, '결정 전'), status);
  assert.equal(before.decisions.length, 0);
  f.decisions.request(f.executions[0], {question: '추가 질문', options: ['가', '나'], recommendation: '가',
    reason: '대조 시험\n- 확인 경로 없음: 격리 시험의 결정', work: '없음'}, SUPER);
  // 서버는 재사용한 수집 결과에 요청 시점의 결정 목록을 다시 넣는다(src/wall.mjs).
  for (const s of [snapshots.full, snapshots.list]) { s.decisions = new DecisionStore(f.home).list({dashboard: true}); s.decisionError = null; }
  const after = json(assertSame(f, snapshots, '결정 뒤(같은 수집)'), status);
  assert.equal(after.decisions.length, 1);
  assert.equal(after.supervisors.items.find(s => s.super === SUPER).decisions, 1);
  assert.equal(json(assertSame(f, snapshots, '결정 뒤(같은 수집)'), status + '?super=' + encodeURIComponent(SUPER)).decisions.length, 1);
  // 결정을 읽지 못한 요청은 모름(null)으로 답한다.
  for (const s of [snapshots.full, snapshots.list]) { s.decisions = []; s.decisionError = '결정 기록 못 읽음'; }
  assert.equal(json(assertSame(f, snapshots, '결정 오류'), status).decisions, null);
  clock.tick(15_000);
  assert.equal(json(assertSame(f, f.collect(), '결정 뒤(새 수집)'), status).decisions.length, 1);
}));

test('수집 종류가 섞이지 않는다: 목록용·요약 본문·업무 포함 여부가 달라도 각자 기억을 끈 계산과 같다', () => withClock(clock => {
  const f = fixture(clock);
  const exec = new URL('/api/dashboard/workspace?collection=executions&state=all', 'http://127.0.0.1');
  const work = new URL('/api/dashboard/workspace?collection=work&state=all', 'http://127.0.0.1');
  const load = options => { const s = loadWallSnapshot(null, options); s.home = f.home; return s; };
  const plain = (snapshot, url) => {
    dashboardPieces.enable(false);
    try { return JSON.stringify(dashboardData(copyOf(snapshot), url)); } finally { dashboardPieces.enable(true); }
  };
  const kinds = [{summaryBodies: true}, {listOnly: true, summaryBodies: true}, {listOnly: true}, {}];
  for (let round = 0; round < 2; round++) {
    for (const options of kinds) {
      const snapshot = load(options);
      // 업무를 뺀 목록을 먼저, 그 뒤 업무 목록을 같은 수집 결과에서 부른다(서버의 호출 순서 가운데 섞이기 쉬운 쪽).
      for (const url of [exec, work, exec]) {
        assert.equal(JSON.stringify(dashboardData(snapshot, url)), plain(snapshot, url), `${JSON.stringify(options)} ${url.search}`);
      }
      const rows = JSON.parse(JSON.stringify(dashboardData(snapshot, exec))).rows;
      assert.ok(rows.length > 0 && rows.every(r => r.kind === 'execution'));
      assert.ok(JSON.parse(JSON.stringify(dashboardData(snapshot, work))).rows.every(r => r.kind === 'work'));
    }
    clock.tick(15_000);
  }
  // 요약 본문 수집과 전체 본문 수집은 카드 객체가 달라 같은 기억을 받지 않는다.
  assert.notEqual(load({summaryBodies: true}).center.cards, load({}).center.cards);
}));

// 키가 없는 수집(저장소 없는 홈·시험)은 상류 기억(wallCache.memo)이 매번 계산해 새 객체를 낸다.
// 여기서는 상류 기억을 비워 같은 길(매번 새 객체)을 만든다.
test('키가 없으면 매번 계산한다: 상류가 새 객체를 내면 재사용이 0이고, 카드 상태 오류는 기억 없이 같은 오류를 낸다', () => withClock(clock => {
  const f = fixture(clock);
  const first = f.collect(), url = new URL(status, 'http://127.0.0.1');
  dashboardData(first.full, url);
  const names = ['briefs', 'workspace-rows', 'rows', 'worktimes', 'review-flows', 'previous-generation', 'stale-cards', 'board-counts'];
  for (let round = 0; round < 2; round++) {
    const before = misses(names);
    clock.tick(15_000);
    wallCache.clear();
    const second = f.collect();
    assert.notEqual(second.full.center.cards, first.full.center.cards, '카드 상태를 새로 만들었다');
    dashboardData(second.full, url);
    const after = misses(names);
    for (const name of names) assert.equal(after[name], before[name] + 1, `매번 계산: ${name}`);
    assertSame(f, second, '상류 기억 없음');
  }
  const kept = [...dashboardPieces.values().keys()].sort();
  const broken = {...copyOf(first.full), center: null, centerError: '원장을 읽을 수 없어 카드 상태 모름'};
  for (const on of [true, false]) {
    dashboardPieces.enable(on);
    assert.throws(() => dashboardData(copyOf(broken), url), /원장을 읽을 수 없어 카드 상태 모름/);
  }
  dashboardPieces.enable(true);
  assert.deepEqual([...dashboardPieces.values().keys()].sort(), kept, '오류 수집 결과는 기억을 만들지 않는다');
}));

test('원장 밖 입력은 다음 요청에 바로 보인다: 세션 생존·대기 출력 꼬리·관계표', () => withClock(clock => {
  const f = fixture(clock);
  const live = map => json(map, status).live.map(s => s.role);
  assert.ok(!live(assertSame(f, f.collect(), '처음')).includes('작업자2'));
  // 세션이 생김(원장 사건 없이 바닥만 바뀜) → 죽음.
  f.sessions.set('작업자2', 999);
  clock.tick(15_000);
  let now = assertSame(f, f.collect(), '세션 생김');
  assert.ok(live(now).includes('작업자2'));
  assert.ok(json(now, '/api/dashboard/sessions').roles.some(r => r.role === '작업자' && r.life.state === 'alive'));
  f.sessions.delete('작업자');
  clock.tick(15_000);
  now = assertSame(f, f.collect(), '세션 죽음');
  assert.ok(!live(now).includes('작업자'));
  // 대기 출력 꼬리 파일(out/*.wait-*.txt)이 생기고 바뀜.
  fs.mkdirSync(path.join(f.home, 'out'), {recursive: true});
  for (const text of ['첫 꼬리', '바뀐 꼬리']) {
    fs.writeFileSync(path.join(f.home, 'out', 'kadan-검수자.wait-1.txt'), text);
    clock.tick(15_000);
    const snapshots = f.collect();
    assertSame(f, snapshots, '대기 꼬리 ' + text);
    assert.ok(JSON.stringify(snapshots.full.center.roles).includes(text) || JSON.stringify(snapshots.full.tree).includes(text),
      '꼬리 글이 수집 결과에 들어 있다');
  }
  // 관계표 파일만 바뀜(원장 사건 없음): 새 관계표가 보이고 관계표를 읽는 조각만 다시 계산한다.
  const before = misses(['previous-generation', 'hierarchy', 'briefs', 'workspace-rows']);
  fs.writeFileSync(f.hierarchyFile, JSON.stringify({...ROLES, 검수자: SUPER}));
  clock.tick(15_000);
  now = assertSame(f, f.collect(), '관계표 변경');
  assert.equal(json(now, status).hierarchy['검수자'], SUPER);
  const after = misses(['previous-generation', 'hierarchy', 'briefs', 'workspace-rows']);
  assert.equal(after.hierarchy, before.hierarchy + 1);
  assert.equal(after['previous-generation'], before['previous-generation'] + 1);
  assert.equal(after.briefs, before.briefs);
  assert.equal(after['workspace-rows'], before['workspace-rows']);
  // 관계표가 깨지면 모름(null)이고, 고치면 돌아온다.
  fs.writeFileSync(f.hierarchyFile, '{깨짐');
  clock.tick(15_000);
  assert.equal(json(assertSame(f, f.collect(), '관계표 깨짐'), status).hierarchy, null);
  fs.writeFileSync(f.hierarchyFile, JSON.stringify(ROLES));
  clock.tick(15_000);
  assert.equal(json(assertSame(f, f.collect(), '관계표 복구'), status).hierarchy['검수자'], '감독');
}));

// 시각 경계: 경계 바로 앞·정확히 그 시각·바로 뒤에서, 새 수집과 옛 수집 결과의 사본(같은 카드 객체) 둘 다 기억을 끈 계산과 같다.
// 옛 수집 결과의 사본은 상류 기억이 카드 상태를 새로 만들지 않아도 조각 스스로 경계를 지키는지 본다.
// 서버는 같은 수집 결과 객체를 cacheSec 동안 다시 쓰고, 그동안 화면 재료(model)는 그 객체에 묶여 옛 것 그대로다.
// 그 길도 견준다: 같은 내용의 수집 결과 두 벌(기억 켬·끔)을 각각 같은 객체로 거듭 부른다.
function heldPair(snapshots) {
  const on = {full: copyOf(snapshots.full), list: copyOf(snapshots.list)};
  const off = {full: copyOf(snapshots.full), list: copyOf(snapshots.list)};
  return (f, label) => {
    const withMemo = bodies(f, on);
    dashboardPieces.enable(false);
    let plain;
    try { plain = bodies(f, off); } finally { dashboardPieces.enable(true); }
    for (const [url, body] of withMemo) assert.equal(body, plain.get(url), `${label}: ${url}`);
    return withMemo;
  };
}
function aroundBoundary(f, clock, boundary, check) {
  clock.set(boundary - 2000);
  const old = f.collect();
  assertSame(f, old, '경계 2초 전');
  const held = heldPair(old);
  held(f, '같은 수집 결과 · 경계 2초 전');
  const seen = [];
  for (const [label, at] of [['1ms 전', boundary - 1], ['정확히', boundary], ['1ms 뒤', boundary + 1]]) {
    clock.set(at);
    const again = held(f, `같은 수집 결과를 다시 씀 · 경계 ${label}`);
    const stale = assertSame(f, {full: copyOf(old.full), list: copyOf(old.list)}, `옛 수집 결과 · 경계 ${label}`);
    const fresh = assertSame(f, f.collect(), `새 수집 · 경계 ${label}`);
    seen.push([label, check(stale), check(fresh), check(again)]);
  }
  return seen;
}

test('시각 경계(미래 시각): 진행 보고 시각이 지나는 순간 앞뒤로 기억을 끈 계산과 같다', () => withClock(clock => {
  const f = fixture(clock), key = f.executions[0];
  const boundary = clock.now() + 600_000;
  const card = f.cards.get(key, {body: false});
  // 보고 시각이 미래인 진행 보고(시각을 직접 적어 넣는다).
  appendStream(f.home, `cards/${key}/events.jsonl`, {...card, revision: card.revision + 1, at: iso(boundary), by: '작업자',
    activity: 'running', activityAt: iso(boundary), activityRole: '작업자', noteKind: 'progress', note: '미래 보고'});
  const row = map => { const r = json(map, '/api/dashboard/workspace?collection=executions&state=all').rows.find(x => x.key === key);
    return `${r.state}/${r.healthLabel}/${r.reportLabel}`; };
  const seen = aroundBoundary(f, clock, boundary, row);
  assert.equal(seen[0][2], seen[0][1], '경계 전에는 옛 수집 결과와 새 수집이 같다');
  assert.notEqual(seen[1][2], seen[0][2], `정확히 그 시각에 값이 바뀐다: ${JSON.stringify(seen)}`);
  assert.equal(seen[2][2], seen[1][2]);
}));

test('시각 경계(24시간): 마지막 신호가 24시간이 되는 순간 지금 막힌 것 → 오래된 미확정, 앞뒤로 기억을 끈 계산과 같다', () => withClock(clock => {
  const f = fixture(clock), key = f.executions[5];
  // 세션 없는 담당에게 보낸 발령. 발령 시각 + 24시간이 경계다.
  const sent = clock.now() - STALE_MS + 300_000, boundary = sent + STALE_MS;
  const card = f.cards.get(key, {body: false});
  f.cards.update(key, {role: '없는담당', status: 'assigned', board: '시험판', scope: '격리 시험',
    rallyId: 'r-stale', rallyTitle: '오래된 묶음', rallyRound: '1', rallyStep: 'implementation'}, {revision: card.revision, by: '감독', note: '배정'});
  appendLedger({t: iso(sent), kind: 'send', role: '없는담당', taskId: key, executionKey: key, by: '감독', bytes: 1, digest: 's', preview: '발령'}, f.home);
  const view = map => {
    const s = json(map, status), row = s.rows.find(r => r.key === key);
    const board = s.boards.find(b => b.name === '시험판').counts;
    return `${row.bucket}/막힘 ${board.stuck}/오래됨 ${board.stale}/정리 ${s.cleanupRequest.includes(key)}`
      + `/목록 ${json(map, '/api/dashboard/workspace?collection=executions&bucket=stale&state=all').rows.some(r => r.key === key)}`;
  };
  const before = dashboardPieces.counts();
  const seen = aroundBoundary(f, clock, boundary, view);
  for (const [label, stale, fresh] of seen) assert.equal(stale, fresh, `옛 수집 결과와 새 수집이 같다(${label})`);
  // 같은 수집 결과를 다시 쓰는 요청: 행은 옛 것(막힘)이지만 판 진행 수·정리 요청은 그 시각의 계산이다(바꾸기 전과 같은 동작).
  assert.match(seen[0][3], /^stuck\/.*\/정리 false\/목록 false$/, seen[0][3]);
  assert.match(seen[1][3], /^stuck\/.*\/정리 true\/목록 false$/, seen[1][3]);
  assert.match(seen[0][2], /^stuck\/.*\/정리 false\/목록 false$/, seen[0][2]);
  assert.match(seen[1][2], /^stale\/.*\/정리 true\/목록 true$/, `정확히 24시간에 바뀐다: ${seen[1][2]}`);
  assert.equal(seen[2][2], seen[1][2]);
  // 경계 전에는 재사용했고(빈 증명이 아니다), 경계에서 묶음 조각을 다시 계산했다.
  const after = dashboardPieces.counts();
  for (const name of ['rows', 'stale-cards', 'board-counts']) {
    assert.ok(after[name].hit > (before[name]?.hit ?? 0), `재사용 있음: ${name}`);
    assert.ok(after[name].miss >= (before[name]?.miss ?? 0) + 2, `경계에서 다시 계산: ${name}`);
  }
}));

test('같은 수집 결과를 오래 다시 써도: 행이 옛 것이 된 뒤의 묶음 조각은 기억하지 않고 그 시각의 계산과 같다', () => withClock(clock => {
  const f = fixture(clock), key = f.executions[5];
  // 발령 시각이 미래인 실행(세션 없는 담당). 그 시각이 지나면 신호가 생기고(막힘), 24시간 뒤 오래된 미확정이 된다.
  const sent = clock.now() + 60_000;
  const card = f.cards.get(key, {body: false});
  f.cards.update(key, {role: '없는담당', status: 'assigned', board: '시험판', scope: '격리 시험',
    rallyId: 'r-future', rallyTitle: '미래 묶음', rallyRound: '1', rallyStep: 'implementation'}, {revision: card.revision, by: '감독', note: '배정'});
  appendLedger({t: iso(sent), kind: 'send', role: '없는담당', taskId: key, executionKey: key, by: '감독', bytes: 1, digest: 'f', preview: '발령'}, f.home);
  const held = heldPair(f.collect());
  // 정리 요청(오래된 미확정 목록)에 이 카드가 들어 있는가. 신호가 없을 때와 24시간이 지난 뒤에만 들어 있다.
  const listed = map => json(map, status).cleanupRequest.includes(key);
  const seen = [];
  for (const at of [sent - 1000, sent - 1, sent, sent + 1, sent + 5000, sent + STALE_MS - 1, sent + STALE_MS, sent + STALE_MS + 1]) {
    clock.set(at);
    seen.push(listed(held(f, '발령 시각 기준 ' + (at - sent) + 'ms')));
  }
  assert.deepEqual(seen, [true, true, false, false, false, false, true, true]);
}));

test('설명 AI 줄의 신선도: 카드·설명이 그대로여도 그 카드의 결정이 바뀌면 설명 조각을 다시 계산한다', () => withClock(clock => {
  const f = fixture(clock), key = f.executions[0];
  const rowOf = map => json(map, '/api/dashboard/workspace?collection=executions&state=all').rows.find(r => r.key === key);
  const first = f.collect();
  const card = first.full.center.cards.find(c => c.key === key);
  f.briefs.write(key, {revision: card.revision, title: '설명 AI 제목', workstream: '대조', summary: '설명 AI 요약'}, EXPLAIN_BY,
    {inputHash: briefInput(card, first.full.briefInputs.decisions.get(key) ?? []).hash});
  clock.tick(15_000);
  const fresh = f.collect();
  assert.equal(fresh.full.center.cards, first.full.center.cards, '설명 사건은 카드 상태를 바꾸지 않는다');
  assert.equal(rowOf(assertSame(f, fresh, '설명 AI 줄')).summary, '설명 AI 요약');
  const before = misses(['briefs']);
  f.decisions.request(key, {question: '이 카드의 결정', options: ['가', '나'], recommendation: '가',
    reason: '대조 시험\n- 확인 경로 없음: 격리 시험의 결정', work: '없음'}, SUPER);
  clock.tick(15_000);
  const decided = f.collect();
  assert.equal(decided.full.center.cards, first.full.center.cards, '결정 사건도 카드 상태를 바꾸지 않는다');
  assert.equal(rowOf(assertSame(f, decided, '결정 뒤')).summary, '', '입력 지문이 달라진 설명 AI 줄은 숨는다');
  assert.equal(misses(['briefs']).briefs, before.briefs + 1);
}));

test('업무만 바뀐 수집: 카드 상태는 그대로여도 업무 행은 새 업무 목록으로 다시 만든다', () => withClock(clock => {
  const f = fixture(clock), key = 'demo/work-첫';
  const workRow = map => json(map, '/api/dashboard/workspace?collection=work&layout=map&state=all').rows.find(r => r.key === 'work:' + key || r.key === key);
  const first = f.collect();
  const before = workRow(assertSame(f, first, '처음'));
  const counted = misses(['rows', 'workspace-rows', 'briefs']);
  const work = f.works.get(key);
  f.works.change(key, 'update', {progress: '절반 끝'}, {revision: work.revision, by: '감독', note: '진척'});
  clock.tick(15_000);
  const second = f.collect();
  assert.equal(second.full.center.cards, first.full.center.cards, '업무 사건은 카드 상태를 바꾸지 않는다');
  const after = workRow(assertSame(f, second, '업무 갱신 뒤'));
  assert.equal(after.revision, before.revision + 1);
  const now = misses(['rows', 'workspace-rows', 'briefs']);
  assert.equal(now.rows, counted.rows + 1, '행은 다시 만든다');
  assert.equal(now['workspace-rows'], counted['workspace-rows'], '카드별 재료는 다시 계산하지 않는다');
  assert.equal(now.briefs, counted.briefs);
}));

test('슈퍼감독 프로필: 시작 기록의 프로필이 바뀌면 슈퍼감독별 묶음이 바로 바뀐다', () => withClock(clock => {
  const f = fixture(clock);
  const supers = map => json(map, status).supervisors.items.map(s => s.super);
  assert.deepEqual(supers(assertSame(f, f.collect(), '처음')), [SUPER]);
  f.start('감독', 'super');
  clock.tick(15_000);
  assert.deepEqual(supers(assertSame(f, f.collect(), '감독이 슈퍼감독으로 시작')).sort(), ['감독', SUPER].sort());
  f.start('감독', 'conductor');
  clock.tick(15_000);
  assert.deepEqual(supers(assertSame(f, f.collect(), '다시 일반감독')), [SUPER]);
}));

test('시계가 뒤로 가면 기억을 쓰지 않는다', () => withClock(clock => {
  const f = fixture(clock);
  const snapshots = f.collect();
  assertSame(f, snapshots, '처음');
  const before = misses(['rows', 'briefs']);
  clock.tick(-5000);
  assertSame(f, {full: copyOf(snapshots.full), list: copyOf(snapshots.list)}, '시계가 뒤로 감');
  const after = misses(['rows', 'briefs']);
  assert.equal(after.rows, before.rows + 1);
  assert.equal(after.briefs, before.briefs + 1);
}));

test('기억한 값을 화면이 고쳐 쓰지 않는다: 모든 화면을 거친 뒤에도 조각 값이 그대로이고 행·관계표는 얼려 있다', () => withClock(clock => {
  const f = fixture(clock);
  const snapshots = f.collect();
  dashboardData(snapshots.full, new URL(status, 'http://127.0.0.1'));
  dashboardData(snapshots.list, new URL('/api/dashboard/workspace?collection=executions', 'http://127.0.0.1'));
  const text = () => JSON.stringify([...dashboardPieces.values()], (key, value) =>
    value instanceof Map ? [...value] : value instanceof Set ? [...value] : value);
  const before = text(), values = dashboardPieces.values();
  for (const name of ['rows', 'rows-executions']) {
    assert.ok(Object.isFrozen(values.get(name)) && values.get(name).every(Object.isFrozen), `${name} 얼림`);
  }
  assert.ok(Object.isFrozen(values.get('hierarchy')));
  for (let i = 0; i < 2; i++) bodies(f, snapshots);
  clock.tick(15_000);
  bodies(f, f.collect());
  assert.equal(text(), before);
}));
