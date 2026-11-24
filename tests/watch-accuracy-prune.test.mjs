import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createDatabase} from '../src/storage.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {WatchReports, watchResponsibility} from '../src/watch-report.mjs';
import {withEffectiveOwner} from '../src/handover-state.mjs';
import {buildSupervisorScope} from '../src/watch-scope.mjs';
import {watchOverview} from '../src/watch-overview.mjs';
import {planHierarchyPrune, PRUNE_GRACE_MS} from '../src/hierarchy-prune.mjs';

// 결함 3·4·5 회귀: 인계된 업무의 책임 해시 일치, 비서 감시 제외·staleReason, 마감된 업무 카드의 관계표 정리.
const parents = new Map([['w-작업자', 'w-감독-구'], ['w-감독-구', 'w-슈퍼'], ['w-감독-신', 'w-슈퍼'], ['w-슈퍼', '@user']]);
const handover = {kind: 'handover', phase: 'transferred', from: 'w-감독-구', to: 'w-감독-신',
  taskIds: [], t: '2026-11-20T01:00:00Z'};
const rawWork = {key: 'w/work', board: 'w', status: 'open', owner: 'w-감독-구', at: '2026-11-19T00:00:00Z',
  executions: [{key: 'w/a'}], history: [{action: 'create', at: '2026-11-19T00:00:00Z'}]};
const card = {id: 'a', key: 'w/a', role: 'w-작업자', board: 'w', status: 'assigned', workType: 'execution'};

function fixture(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-accuracy-'));
  createDatabase(home);
  fs.writeFileSync(path.join(home, 'storage.json'), JSON.stringify({version: 1, backend: 'sqlite'}));
  const f = {home, at: Date.now(), cards: [card], works: [rawWork], sent: []};
  for (const [i, role] of ['w-작업자', 'w-감독-구', 'w-감독-신', 'w-슈퍼'].entries()) {
    appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1}, home);
  }
  appendLedger({kind: 'send', role: 'w-작업자', taskId: 'a'}, home);
  appendLedger(handover, home);
  f.options = {home, now: () => f.at, readCards: () => f.cards, readWorks: () => f.works, ...extra,
    floor: {list: () => []}, send: (role, message) => f.sent.push({role, message})};
  f.r = new WatchReports(f.options);
  f.request = (over = {}) => f.r.request({source: 'supervisor-health', role: 'w-감독-신', parents, ...over});
  f.rows = () => readLedger(home);
  return f;
}

test('결함 3: 인계된 업무의 책임 해시가 감시기·요청·접수·퇴역에서 같다', () => {
  const f = fixture();
  const entries = f.rows();
  const effective = f.works.map(w => withEffectiveOwner(w, entries));
  assert.equal(effective[0].owner, 'w-감독-신');
  // 원본 업무로는 새 책임 감독이 감시 범위에 없다(어긋남의 원인).
  assert.equal(watchResponsibility('w-감독-신', f.cards, entries, parents, 'supervisor-health', f.works), null);
  const expected = watchResponsibility('w-감독-신', f.cards, entries, parents, 'supervisor-health', effective);
  assert.ok(expected);
  const request = f.request();
  assert.equal(request.responsibility, expected);
  const report = f.r.submit(request.requestId, '정체', '응답 없음');
  assert.equal(report.accepted, true);
  assert.equal('staleReason' in report, false);
  // 감시기처럼 이미 얹은 업무를 넘기든, 기본값(원본 읽기)이든 퇴역하지 않는다.
  const before = f.rows().length;
  f.r.retire(f.rows(), f.cards, parents, effective);
  f.r.retire(f.rows(), f.cards, parents);
  const added = f.rows().slice(before);
  assert.equal(added.some(e => e.kind === 'watch-ai-retired' || e.resolution === 'scope-exit'), false);
});

test('결함 3: 보류된 알림 재전송 점검도 인계된 업무를 책임으로 본다', () => {
  const f = fixture();
  const request = f.request();
  f.r.submit(request.requestId, '정체', '응답 없음', {});
  const entries = f.rows();
  const held = entries.findLast(e => e.kind === 'watch-ai-delivery');
  appendLedger({...held, held: true}, f.home);
  fs.writeFileSync(path.join(request.evidencePath, 'notification.txt'), '보류 알림');
  f.options.floor = {list: () => []};
  f.r.retryHeld(f.rows(), parents);
  const last = f.rows().findLast(e => e.kind === 'watch-ai-delivery');
  assert.notEqual(last.delivery, 'cancelled');
});

test('결함 3: withEffectiveOwner는 이미 얹은 업무에 다시 불러도 인계 시각을 되돌리지 않는다', () => {
  const entries = [handover];
  const once = withEffectiveOwner(rawWork, entries);
  assert.equal(once.ownedAt, handover.t);
  const twice = withEffectiveOwner(once, entries);
  assert.equal(twice, once);
  assert.equal(twice.ownedAt, handover.t);
  assert.equal(withEffectiveOwner({...rawWork}, entries).ownedAt, handover.t);
});

test('결함 3: 대시보드 감시 개요가 인계 후 현재 책임 감독을 보인다', () => {
  const text = JSON.stringify({worker: 'sup-old', 'sup-old': 'top', 'sup-new': 'top', top: '@user'});
  const hash = createHash('sha256').update(text).digest('hex');
  const now = Date.parse('2026-11-24T02:00:00Z');
  const center = {runtimeKnown: true, roles: [], boards: [{name: 'p', runs: [],
    cards: [{id: 'c', key: 'p/c', role: 'worker', status: 'assigned', workType: 'execution',
      displayState: 'running'}]}]};
  const work = {key: 'p/work', board: 'p', status: 'open', owner: 'sup-old', at: '2026-11-19T00:00:00Z',
    executions: [{key: 'p/c'}], history: [{action: 'create', at: '2026-11-19T00:00:00Z'}]};
  const entries = [{kind: 'hierarchy-loaded', pid: 42, path: '/t/h.json', hash, t: '2026-11-24T01:00:00Z'},
    {kind: 'send', role: 'worker', taskId: 'c', t: '2026-11-24T01:01:00Z'},
    {kind: 'handover', phase: 'transferred', from: 'sup-old', to: 'sup-new', taskIds: [], t: '2026-11-24T01:02:00Z'}];
  const m = watchOverview({center, entries, works: [work], processes: [{pid: 42, startedAt: '2026-11-24T00:00:00Z'}],
    readFile: () => text, now});
  assert.ok(m.boards[0].roles.some(r => r.role === 'sup-new'));
});

test('결함 4: 상위 사슬이 비서로 이어져도 감독 범위에 비서가 들어가지 않는다', () => {
  const table = new Map([['작업자', '감독'], ['감독', '비서'], ['비서', '@user']]);
  const entries = [{kind: 'send', role: '작업자', taskId: 'a'}];
  const cards = [{id: 'a', key: 'x/a', role: '작업자', board: 'x', status: 'assigned', workType: 'execution'}];
  const scope = buildSupervisorScope(cards, entries, table, []);
  assert.deepEqual([...scope.sessions], ['kadan-감독']);
  assert.equal(scope.entries.some(e => e.role === '비서'), false);
  // 비서 아래 하위 감독·작업자 감시는 그대로 유지된다.
  assert.equal(scope.entries.some(e => e.role === '감독' && e.subject === '작업자'), true);
  // 비서가 최상위 감독의 부모여도 올라가지 않는다.
  const work = {key: 'x/work', status: 'open', owner: '감독', at: '2026-11-19T00:00:00Z',
    executions: [{key: 'x/a'}], history: [{action: 'create', at: '2026-11-19T00:00:00Z'}]};
  const withWork = buildSupervisorScope(cards, entries, table, [{...work, ownedAt: null}]);
  assert.equal(withWork.sessions.has('kadan-비서'), false);
  assert.equal(withWork.sessions.has('kadan-감독'), true);
});

test('결함 4: 거절된 보고에만 첫 번째 원인 코드 staleReason을 남긴다', () => {
  const reasonOf = (f, request) => f.rows()
    .findLast(e => e.kind === 'watch-ai-report' && e.requestId === request.requestId);
  const cases = {
    expired: f => { f.at += 10 * 60_000; },
    'call-recorded': (f, r) => { appendLedger({kind: 'watch-ai-call', requestId: r.requestId}, f.home); },
    'responsibility-changed': f => { f.works = [{...rawWork, status: 'done'}]; },
    'superseded-request': f => { f.request(); },
  };
  for (const [code, mutate] of Object.entries(cases)) {
    const f = fixture();
    const request = f.request();
    mutate(f, request);
    const result = f.r.submit(request.requestId, '정체', '응답 없음');
    assert.equal(result.accepted, false, code);
    assert.equal(reasonOf(f, request).staleReason, code);
  }
  const ok = fixture();
  const request = ok.request();
  ok.r.submit(request.requestId, '진행중', '정상');
  assert.equal('staleReason' in reasonOf(ok, request), false);
});

// 결함 5
const now = Date.parse('2026-11-24T12:00:00Z');
const old = new Date(now - 2 * PRUNE_GRACE_MS).toISOString();
const started = new Date(now - 3 * PRUNE_GRACE_MS).toISOString();
const table = {boss: '@user', leaf: 'boss'};
const baseEntries = [{kind: 'start', role: 'boss', panePid: 10, t: started},
  {kind: 'start', role: 'leaf', panePid: 10, t: started},
  {kind: 'stop', role: 'boss', t: old}, {kind: 'stop', role: 'leaf', t: old}];
const sentOld = {kind: 'send', role: 'leaf', taskId: 'old-card', t: started};
// 발령은 종료 기록 앞에 둔다(종료 뒤 활동 흔적은 사망 근거를 지운다).
const withSent = [baseEntries[0], baseEntries[1], sentOld, baseEntries[2], baseEntries[3]];
const oldCard = {id: 'old-card', key: 'r/old-card', role: 'leaf', status: 'assigned', at: started,
  workType: 'execution'};
const closedWork = status => ({key: 'r/w', status, owner: 'nobody', executions: [{key: 'r/old-card'}]});
const plan = extra => planHierarchyPrune({table, entries: baseEntries, cards: [], works: [], sessions: [], now,
  ...extra});
const removed = result => result.remove.map(r => r.role);
const why = (result, role = 'leaf') => result.retain.find(r => r.role === role)?.reason;

test('결함 5: 마감된 업무의 미완료 카드·발령은 죽은 역할을 붙잡지 않는다', () => {
  for (const status of ['done', 'cancelled']) {
    assert.deepEqual(removed(plan({cards: [oldCard], works: [closedWork(status)]})), ['leaf'], `카드 ${status}`);
    const sentPlan = plan({cards: [{...oldCard, status: 'done'}], entries: withSent, works: [closedWork(status)]});
    assert.deepEqual(removed(sentPlan), ['leaf'], `발령 ${status}`);
  }
});

test('결함 5: 열린·보류 업무, 업무 미연결, 연결 오류, 24시간 미경과, 살아 있는 역할은 계속 남긴다', () => {
  for (const status of ['open', 'hold']) {
    assert.equal(why(plan({cards: [oldCard], works: [closedWork(status)]})), '미완료 카드', status);
    const sentPlan = plan({cards: [{...oldCard, status: 'done'}], entries: withSent, works: [closedWork(status)]});
    assert.equal(why(sentPlan), '미완료 발령', status);
  }
  assert.equal(why(plan({cards: [oldCard]})), '미완료 카드');
  const unlinked = plan({cards: [{...oldCard, status: 'done'}], entries: withSent, works: []});
  assert.equal(why(unlinked), '미완료 발령');
  const brokenEntries = [...withSent.slice(0, 2), {...sentOld, taskId: 'missing'}, ...withSent.slice(3)];
  const broken = plan({cards: [], entries: brokenEntries, works: [closedWork('done')]});
  assert.equal(why(broken), '미완료 발령');
  const recent = new Date(now - PRUNE_GRACE_MS + 1).toISOString();
  const young = plan({entries: [...baseEntries.slice(0, 3), {kind: 'stop', role: 'leaf', t: recent}],
    cards: [oldCard], works: [closedWork('done')]});
  assert.equal(why(young), '종료 후 24시간 미경과');
  const alive = plan({cards: [oldCard], works: [closedWork('done')], sessions: [{session: 'kadan-leaf', pid: 10}]});
  assert.equal(why(alive), '살아 있음');
  assert.equal(why(plan({cards: [oldCard], works: [closedWork('done')]}), 'boss'), '하위 역할 있음');
});
