import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase} from '../src/storage.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {WatchReports} from '../src/watch-report.mjs';

// 감시 AI 보고 경로(WatchReports.deliver)의 Autopilot Wingman 덮어쓰기. 가짜 시계·격리 홈·가짜 바닥·가짜 전송만 쓴다.
const U = '@user', WINGMAN = 'd-슈퍼감독', WORKER = 'p-작업자';
const parents = new Map([[WORKER, U]]);

function fixture({autopilot = true, level = 'autopilot', readAutopilotWingman, failWingman = false} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-autopilot-wingman-report-'));
  createDatabase(home);
  fs.writeFileSync(path.join(home, 'storage.json'), JSON.stringify({version: 1, backend: 'sqlite'}));
  const f = {home, at: Date.now(), sent: [], cards: [{id: 'a', key: 'r/a', role: WORKER, board: 'p', status: 'assigned', workType: 'execution'}]};
  appendLedger({kind: 'start', role: WORKER, session: `kadan-${WORKER}`, panePid: 1}, home);
  appendLedger({kind: 'start', role: WINGMAN, session: `kadan-${WINGMAN}`, panePid: 2, roleProfile: 'super'}, home);
  appendLedger({kind: 'send', role: WORKER, taskId: 'a'}, home);
  if (autopilot) appendLedger({kind: 'autopilot', phase: 'on', by: '사람', level, wingman: WINGMAN, until: new Date(f.at + 8 * 3600_000).toISOString(), t: new Date(f.at - 60_000).toISOString()}, home);
  f.options = {home, now: () => f.at, readCards: () => f.cards,
    floor: {list: () => [WORKER, WINGMAN].map((role, i) => ({session: `kadan-${role}`, pid: i + 1}))},
    send: (role, message) => {
      f.sent.push({role, message});
      if (failWingman && role === WINGMAN) throw Object.assign(new Error('가짜 전달 실패'), {delivery: 'not-sent'});
    },
    ...(readAutopilotWingman ? {readAutopilotWingman} : {})};
  f.r = new WatchReports(f.options);
  f.report = verdict => { const job = f.r.request({source: 'stall', role: WORKER, parents}); return f.r.submit(job.requestId, verdict, '시험 이유'); };
  f.entries = kind => readLedger(home).filter(e => e.kind === kind);
  return f;
}

test('1. Autopilot 단계 + Wingman 생존 + 정체 AMBER → Wingman 1통, 사용자 0통, 원장 route.basis Wingman', () => {
  const f = fixture();
  f.report('정체');
  assert.deepEqual(f.sent.map(s => s.role), [WINGMAN]);
  const [delivery] = f.entries('watch-ai-delivery');
  assert.equal(delivery.recipient, WINGMAN);
  assert.equal(delivery.route.basis, 'wingman');
  const alert = f.entries('alert').find(e => e.source === 'watch-ai');
  assert.equal(alert.route.basis, 'wingman');
  assert.equal(alert.delivered, true);
});

test('2. 조정·응답장애·모름 verdict와 Autopilot 꺼짐·기본 단계는 사용자 그대로', () => {
  for (const verdict of ['조정', '응답장애', '모름']) {
    const f = fixture();
    f.report(verdict);
    assert.deepEqual(f.sent.map(s => s.role), [U], verdict);
    assert.notEqual(f.entries('watch-ai-delivery')[0].route.basis, 'Wingman', verdict);
  }
  for (const opts of [{autopilot: false}, {level: 'cruise'}]) {
    const f = fixture(opts);
    f.report('정체');
    assert.deepEqual(f.sent.map(s => s.role), [U], JSON.stringify(opts));
  }
});

test('2. RED 정체가 deliver에 오면 [Wingman, @user] 겹알림(기존 조건 그대로)', () => {
  const f = fixture();
  const job = f.r.request({source: 'stall', role: WORKER, parents, userNotify: true});
  f.r.deliver(job, {verdict: '정체', level: 'RED'}, '시험 메시지', parents);
  assert.deepEqual(f.sent.map(s => s.role), [WINGMAN, U]);
});

test('3. Wingman 전송이 확실히 실패하면(관계표에 Wingman 없음) 사용자가 전달실패를 받는다', () => {
  const f = fixture({failWingman: true});
  f.report('정체');
  assert.deepEqual(f.sent.map(s => s.role), [WINGMAN, U]);
  assert.match(f.sent[1].message, /보고 전달 실패/);
  const [delivery] = f.entries('watch-ai-delivery');
  assert.equal(delivery.escalation.recipient, U);
  assert.ok(f.entries('alert').some(e => e.alertKind === '전달실패' && e.recipient === U && e.delivered === true));
});

test('4. Autopilot 상태 읽기가 던지면 사용자 유지', () => {
  const f = fixture({readAutopilotWingman: () => { throw new Error('결정 저장소 읽기 실패'); }});
  f.report('정체');
  assert.deepEqual(f.sent.map(s => s.role), [U]);
});

test('5. 정체 보고 한 건마다 Autopilot 상태 읽기 1회', () => {
  let calls = 0;
  const f = fixture({readAutopilotWingman: ({entries}) => { calls++; const last = [...entries].reverse().find(e => e.kind === 'autopilot'); return {on: true, level: last.level, wingman: last.wingman}; }});
  f.report('정체');
  assert.equal(calls, 1);
  assert.deepEqual(f.sent.map(s => s.role), [WINGMAN]);
});
