import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase} from '../src/storage.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {WatchReports} from '../src/watch-report.mjs';

// 감시 AI 보고 경로(WatchReports.deliver)의 나이트런 당번 덮어쓰기. 가짜 시계·격리 홈·가짜 바닥·가짜 전송만 쓴다.
const U = '@user', DUTY = 'd-슈퍼감독', WORKER = 'p-작업자';
const parents = new Map([[WORKER, U]]);

function fixture({night = true, level = '자동', readNightDuty, failDuty = false} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-night-duty-report-'));
  createDatabase(home);
  fs.writeFileSync(path.join(home, 'storage.json'), JSON.stringify({version: 1, backend: 'sqlite'}));
  const f = {home, at: Date.now(), sent: [], cards: [{id: 'a', key: 'r/a', role: WORKER, board: 'p', status: 'assigned', workType: 'execution'}]};
  appendLedger({kind: 'start', role: WORKER, session: `kadan-${WORKER}`, panePid: 1}, home);
  appendLedger({kind: 'start', role: DUTY, session: `kadan-${DUTY}`, panePid: 2, roleProfile: 'super'}, home);
  appendLedger({kind: 'send', role: WORKER, taskId: 'a'}, home);
  if (night) appendLedger({kind: 'night', phase: 'on', by: '사람', level, duty: DUTY, until: new Date(f.at + 8 * 3600_000).toISOString(), t: new Date(f.at - 60_000).toISOString()}, home);
  f.options = {home, now: () => f.at, readCards: () => f.cards,
    floor: {list: () => [WORKER, DUTY].map((role, i) => ({session: `kadan-${role}`, pid: i + 1}))},
    send: (role, message) => {
      f.sent.push({role, message});
      if (failDuty && role === DUTY) throw Object.assign(new Error('가짜 전달 실패'), {delivery: 'not-sent'});
    },
    ...(readNightDuty ? {readNightDuty} : {})};
  f.r = new WatchReports(f.options);
  f.report = verdict => { const job = f.r.request({source: 'stall', role: WORKER, parents}); return f.r.submit(job.requestId, verdict, '시험 이유'); };
  f.entries = kind => readLedger(home).filter(e => e.kind === kind);
  return f;
}

test('1. 자동 단계 + 당번 생존 + 정체 AMBER → 당번 1통, 사용자 0통, 원장 route.basis 당번', () => {
  const f = fixture();
  f.report('정체');
  assert.deepEqual(f.sent.map(s => s.role), [DUTY]);
  const [delivery] = f.entries('watch-ai-delivery');
  assert.equal(delivery.recipient, DUTY);
  assert.equal(delivery.route.basis, '당번');
  const alert = f.entries('alert').find(e => e.source === 'watch-ai');
  assert.equal(alert.route.basis, '당번');
  assert.equal(alert.delivered, true);
});

test('2. 조정·응답장애·모름 verdict와 나이트런 꺼짐·기본 단계는 사용자 그대로', () => {
  for (const verdict of ['조정', '응답장애', '모름']) {
    const f = fixture();
    f.report(verdict);
    assert.deepEqual(f.sent.map(s => s.role), [U], verdict);
    assert.notEqual(f.entries('watch-ai-delivery')[0].route.basis, '당번', verdict);
  }
  for (const opts of [{night: false}, {level: '기본'}]) {
    const f = fixture(opts);
    f.report('정체');
    assert.deepEqual(f.sent.map(s => s.role), [U], JSON.stringify(opts));
  }
});

test('2. RED 정체가 deliver에 오면 [당번, @user] 겹알림(기존 조건 그대로)', () => {
  const f = fixture();
  const job = f.r.request({source: 'stall', role: WORKER, parents, userNotify: true});
  f.r.deliver(job, {verdict: '정체', level: 'RED'}, '시험 메시지', parents);
  assert.deepEqual(f.sent.map(s => s.role), [DUTY, U]);
});

test('3. 당번 전송이 확실히 실패하면(관계표에 당번 없음) 사용자가 전달실패를 받는다', () => {
  const f = fixture({failDuty: true});
  f.report('정체');
  assert.deepEqual(f.sent.map(s => s.role), [DUTY, U]);
  assert.match(f.sent[1].message, /보고 전달 실패/);
  const [delivery] = f.entries('watch-ai-delivery');
  assert.equal(delivery.escalation.recipient, U);
  assert.ok(f.entries('alert').some(e => e.alertKind === '전달실패' && e.recipient === U && e.delivered === true));
});

test('4. 나이트 상태 읽기가 던지면 사용자 유지', () => {
  const f = fixture({readNightDuty: () => { throw new Error('결정 저장소 읽기 실패'); }});
  f.report('정체');
  assert.deepEqual(f.sent.map(s => s.role), [U]);
});

test('5. 정체 보고 한 건마다 나이트 상태 읽기 1회', () => {
  let calls = 0;
  const f = fixture({readNightDuty: ({entries}) => { calls++; const last = [...entries].reverse().find(e => e.kind === 'night'); return {on: true, level: last.level, duty: last.duty}; }});
  f.report('정체');
  assert.equal(calls, 1);
  assert.deepEqual(f.sent.map(s => s.role), [DUTY]);
});
