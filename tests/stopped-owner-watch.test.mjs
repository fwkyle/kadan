import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import './helpers/isolated-home.mjs';
import {runWatch} from './helpers/watch-runner.mjs';
import {ledgerHome, appendLedger, readLedger} from '../src/ledger.mjs';
import {stopRole} from '../src/role-stop.mjs';

// Why: 상위가 `kadan stop`으로 일부러 끈 감독에게 "세션 종료 의심(죽음)"이 가면 오보다.
// 열린 업무의 owner였던 감독만 이 오보를 받았다(owner는 차례를 옮겨도 책임 대상에 남는다).
const t = '2026-11-16T00:00:00.000Z', epoch = Date.parse(t), later = '2026-11-16T00:01:00.000Z';
const parents = new Map([['worker', 'boss'], ['boss', 'top'], ['top', '@user']]);
const card = {id: 'task', key: 'repo/task', role: 'worker', status: 'done', workType: 'execution', title: '대상', board: 'p'};
const work = {key: 'repo/work', owner: 'boss', turnOwner: 'top', turnAt: t, status: 'open', board: 'p', executions: [{key: card.key}]};
const starts = ['worker', 'boss', 'top'].map((role, i) => ({kind: 'start', role, session: `kadan-${role}`, panePid: i + 1, t}));
const base = [...starts, {kind: 'send', role: 'worker', taskId: 'task', t}, {kind: 'done', role: 'worker', taskId: 'task', t}];

// 세 번 돌리고, boss 세션이 없는 채로 나온 감독 건강 점검 경보를 돌려준다.
async function bossAlerts(extra, {live = ['worker', 'top'], cards = [card], session = 'boss'} = {}) {
  let cycle = 0;const end = Error('end'), records = [], rows = [...base, ...extra];
  const load = os.loadavg;os.loadavg = () => [0, 0, 0];
  try {
    await assert.rejects(() => runWatch({
      floor: {list: () => starts.filter(s => live.includes(s.role)).map(s => ({session: s.session, pid: s.panePid})), read: () => '정상 대기'},
      readEntries: () => rows, readCards: () => cards, readWorks: () => [work], parents, superRole: 'old', routes: new Map(),
      intervalMs: 60000, stallN: 2, now: () => epoch + cycle * 60000, sendAlert: () => {}, record: e => records.push(e), print: () => {},
      spawn: cmd => {
        if (cmd === 'sleep' && ++cycle === 3) throw end;
        return {status: 0, stdout: cmd === 'memory_pressure' ? 'System-wide memory free percentage: 80%' : cmd === 'sysctl' ? 'used = 0M' : ''};
      },
    }), e => e === end);
  } finally {os.loadavg = load;}
  return records.filter(e => e.kind === 'alert' && e.id === `supervisor-health:kadan-${session}`);
}
const stop = extra => ({kind: 'stop', role: 'boss', session: 'kadan-boss', by: 'top', t: later, ...extra});
const restart = {kind: 'start', role: 'boss', session: 'kadan-boss', panePid: 9, t: '2026-11-16T00:02:00.000Z'};

test('stop 없이 세션이 사라진 감독은 그대로 죽음 경보를 받는다 (a)', async () => {
  assert.ok((await bossAlerts([])).some(e => e.alertKind === '죽음'));
});
test('owner인 감독을 일부러 stop했으면 죽음 경보를 내지 않는다 (d)', async () => {
  assert.deepEqual(await bossAlerts([stop()]), []);
});
test('stop 뒤 다시 start했는데 세션이 사라지면 죽음 경보가 다시 난다 (b)', async () => {
  assert.ok((await bossAlerts([stop(), restart])).some(e => e.alertKind === '죽음'));
});
test('restart: true인 stop 뒤 start가 없으면 죽음 경보를 유지한다 (c)', async () => {
  assert.ok((await bossAlerts([stop({restart: true})])).some(e => e.alertKind === '죽음'));
});
test('아래 감독을 stop해도 상위(top)가 사라지면 top의 죽음 경보는 그대로 난다', async () => {
  assert.deepEqual(await bossAlerts([stop()], {live: ['worker']}), []);
  assert.ok((await bossAlerts([stop()], {live: ['worker'], session: 'top'})).some(e => e.alertKind === '죽음'));
});

// 끈 작업자(끝나지 않은 카드가 있음)의 경보는 다른 곳(작업자 감시 watch.mjs)에서 난다. 이 PR이 고치는 감독 건강 점검과 다른 지점이라
// 고치지 않고 지금 동작만 고정한다: 작업자는 stop 뒤에도 죽음 경보가 난다.
test('특성: 일부러 끈 작업자도 죽음 경보가 난다(감독 건강 점검과 다른 지점, 이 PR에서 안 고침)', async () => {
  let cycle = 0;const end = Error('end'), records = [], rows = [...starts, {kind: 'send', role: 'worker', taskId: 'task', t},
    {kind: 'stop', role: 'worker', session: 'kadan-worker', by: 'boss', t: later}];
  const load = os.loadavg;os.loadavg = () => [0, 0, 0];
  try {
    await assert.rejects(() => runWatch({
      floor: {list: () => starts.filter(s => s.role !== 'worker' || cycle < 1).map(s => ({session: s.session, pid: s.panePid})), read: () => '정상 대기'},
      readEntries: () => rows, readCards: () => [{...card, status: 'assigned', activity: 'running'}], readWorks: () => [], parents,
      superRole: 'old', routes: new Map(), intervalMs: 60000, stallN: 2, now: () => epoch + cycle * 60000, sendAlert: () => {},
      record: e => records.push(e), print: () => {},
      spawn: cmd => {
        if (cmd === 'sleep' && ++cycle === 3) throw end;
        return {status: 0, stdout: cmd === 'memory_pressure' ? 'System-wide memory free percentage: 80%' : cmd === 'sysctl' ? 'used = 0M' : ''};
      },
    }), e => e === end);
  } finally {os.loadavg = load;}
  assert.ok(records.some(e => e.kind === 'alert' && e.id === 'death:kadan-worker' && e.alertKind === '죽음'));
});

function stopFixture(role, works) {
  const home = ledgerHome(), session = `kadan-${role}`, lines = [];
  appendLedger({kind: 'start', floor: 'tmux', role, session, cmd: 'codex', panePid: '100', by: 'top'}, home);
  const floor = {name: 'tmux', alive: () => true, pid: () => '100', stop: () => {}};
  const result = stopRole({role, session, home, floor, readWorks: () => works, log: line => lines.push(line), warn: () => {},
    lookup: () => ({conversationMissing: 'undetermined'})});
  return {lines, stop: readLedger(home).findLast(e => e.kind === 'stop' && e.session === session), result};
}
test('kadan stop은 이 역할이 owner인 열린 업무를 한 줄로 알리고 stop 사건에 키를 남긴다(막지 않음)', () => {
  const works = [{key: 'repo/b', owner: 'owner-x', status: 'open'}, {key: 'repo/a', owner: 'owner-x', status: 'open'},
    {key: 'repo/closed', owner: 'owner-x', status: 'done'}, {key: 'repo/other', owner: 'someone', status: 'open'}];
  const f = stopFixture('owner-x', works);
  assert.equal(f.result.ok, true);
  assert.deepEqual(f.stop.ownedOpenWorks, ['repo/a', 'repo/b']);
  assert.ok(f.lines.some(line => line.includes('owner인 열린 업무 2건: repo/a, repo/b')));
});
test('owner인 열린 업무가 없으면 출력도 stop 사건 칸도 없다', () => {
  const f = stopFixture('owner-y', [{key: 'repo/x', owner: 'other', status: 'open'}]);
  assert.equal(f.stop.ownedOpenWorks, undefined);
  assert.deepEqual(f.lines, ['종료됨: kadan-owner-y']);
});
test('업무 목록을 못 읽어도 끈다', () => {
  const home = ledgerHome(), role = 'owner-z';
  appendLedger({kind: 'start', floor: 'tmux', role, session: `kadan-${role}`, cmd: 'codex', panePid: '100', by: 'top'}, home);
  const result = stopRole({role, session: `kadan-${role}`, home, floor: {name: 'tmux', alive: () => true, pid: () => '100', stop: () => {}},
    readWorks: () => {throw new Error('x');}, log: () => {}, warn: () => {}, lookup: () => ({conversationMissing: 'undetermined'})});
  assert.equal(result.ok, true);
});
