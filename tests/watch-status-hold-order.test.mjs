import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {runWatch} from '../src/watch-runner.mjs';
import {NotifyHoldTracker} from '../src/watch-notify-hold.mjs';

// PR #199 검수 3라운드: 우편 감시(mailWatch.tick)가 처음 입력 보호 보류를 관측하는 주기에 멈춤 판정이 같은 주기의 보류를
// 보고 결정되어야 한다. 이전에는 멈춤 판정·감독 알림이 먼저 돌아 처음 보류되는 주기에 감독행 헛멈춤 1건이 났다.
// alpha: 우편 알림이 복사 모드로 밀리는 역할, beta: 보류와 무관한 정상 멈춤 역할.
const epoch = Date.parse('2026-10-18T00:00:00Z');
const stamp = m => new Date(epoch + m * 60_000).toISOString();
const a = 'wsh-alpha', b = 'wsh-beta', boss = 'wsh-boss';
const idle = 'finished response\n\n❯ \nOpus 5.5 | ctx:20%';
const codex = m => `• Working (${m + 1}m 00s • esc to interrupt)\n\n` +
  '› Ask Codex to do anything\nmodel max · /workspace · ctx:20%\nweekly 80% left';

async function simulate({minutes = 12, holdStart = 0, releaseAt = Infinity,
  graceMinutes = 0, screen = () => idle, useMail = true} = {}) {
  const roles = [a, b, boss];
  const starts = roles.map((role, i) => ({kind: 'start', role, session: 'kadan-' + role,
    panePid: i + 1, t: stamp(-1)}));
  const cards = [a, b].map((role, i) => ({key: 'wsh/t' + i, id: 't' + i,
    role, status: 'assigned', workType: 'execution', activity: 'running',
    activityRole: role, activityAt: stamp(0)}));
  const tasks = cards.map(c => ({kind: 'send', role: c.role, session: 'kadan-' + c.role,
    taskId: c.id, executionKey: c.key, t: stamp(0)}));
  const mail = {kind: 'send', transport: 'mailbox', mailId: 'wsh-mail',
    by: boss, role: a, digest: 'wsh-message', t: stamp(0)};
  const entries = [...starts, ...tasks, ...(useMail ? [mail] : [])];
  const records = [], held = [], delivered = [], tracker = new NotifyHoldTracker();
  let minute = 0;
  const end = new AbortController();
  await runWatch({signal: end.signal, intervalMs: 60_000, stallN: 2,
    stallAfterMs: 300_000, startReportGraceMs: 300_000,
    holdTracker: tracker, mailUnreadGraceMs: graceMinutes * 60_000,
    parents: new Map([[a, boss], [b, boss], [boss, '@user']]),
    routes: new Map(), superRole: boss, now: () => epoch + minute * 60_000,
    floor: {list: () => starts.map(s => ({session: s.session, pid: s.panePid})),
      read: session => session === 'kadan-' + boss ? 'healthy boss' : screen(minute, session)},
    readEntries: () => entries, readCards: () => cards, readWorks: () => [],
    readDecisions: () => [], print() {}, spawn: () => ({status: 0, stdout: ''}),
    sendAlert() {}, sendNudge() {},
    mailHold: role => {
      if (minute >= holdStart && minute < releaseAt) {
        const error = {code: 'KADAN_PANE_IN_MODE', message: 'copy mode', delivery: 'not-sent'};
        tracker.held(role, error); held.push({minute, role}); return error;
      }
      return null;
    },
    sendMailReminder: role => {tracker.delivered(role, {}); delivered.push({minute, role});},
    record: event => {records.push({...event, minute}); entries.push({...event, t: stamp(minute)});},
    sleep: async () => {await setImmediate(); if (++minute >= minutes) end.abort();},
  });
  const stops = records.filter(e => e.kind === 'alert' && e.alertKind === '멈춤');
  return {stops, held, delivered, records};
}

test('기본 우편 유예 5분: 5분째 처음 보류되는 주기에도 alpha 멈춤 0건', async () => {
  const r = await simulate({minutes: 8, graceMinutes: 5, holdStart: 5, screen: m => m === 0 ? codex(m) : idle});
  assert.equal(r.held[0].minute, 5);
  assert.equal(r.stops.filter(s => s.role === a && !s.resolved).length, 0);
});

test('4분 유예: 멈춤 기준 4분과 같은 주기에 처음 보류돼도 alpha 멈춤 0건', async () => {
  const r = await simulate({minutes: 7, graceMinutes: 4, holdStart: 4});
  assert.equal(r.held[0].minute, 4);
  assert.equal(r.stops.filter(s => s.role === a && !s.resolved).length, 0);
});

test('보류와 무관한 beta의 정상 멈춤 1건은 그대로 4분에 나고, alpha는 보류가 풀린 뒤 4분을 다시 채운다', async () => {
  const r = await simulate({minutes: 13, releaseAt: 6});
  const alpha = r.stops.filter(s => s.role === a && !s.resolved);
  const beta = r.stops.filter(s => s.role === b && !s.resolved);
  assert.equal(beta.length, 1);
  assert.equal(beta[0].minute, 4);
  assert.equal(alpha.length, 1);
  assert.equal(alpha[0].minute, 11, '풀린 뒤 첫 비보류 관측 7분 + 4분');
});
