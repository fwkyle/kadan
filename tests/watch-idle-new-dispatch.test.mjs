import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {collectRoles} from '../src/watch-roles.mjs';
import {runWatch} from './helpers/watch-runner.mjs';

// 앞 실행 완료 → 새 발령 → 짧은 턴 종료 → 빈 입력창. 운영 사건은 익명화했다.
const role = 'p-worker', session = `kadan-${role}`;
const at = minute => new Date(Date.parse('2026-10-19T03:00:00Z') + minute * 60_000).toISOString();
const start = {kind: 'start', role, session, panePid: 1, harness: 'codex', t: at(21)};
const sent = (taskId, minute) => ({kind: 'send', role, session, taskId,
  executionKey: `repo/${taskId}`, mailId: `mail-${taskId}-${minute}`, t: at(minute)});
const done = {kind: 'done', role, taskId: 'old', executionKey: 'repo/old', result: 'failed', t: at(39.75)};
const entries = [start, sent('old', 22), done, sent('new', 58)];
const cards = ['old', 'new'].map(id => ({id, key: `repo/${id}`, role, status: 'assigned'}));
const idleScreen = compact => [
  ...(compact ? ['• Context compacted · 0s', ''] : []),
  '• 이 작업 폴더에서는 제공한 규칙을 따르겠습니다.', '',
  '  Worked for 1m 6s • 12:59 PM', '', '', '› Ask Codex to do anything', '',
  '  GPT-6-Astra medium · workspace · branch · Context 9% used · weekly 51% left · ⚠ 2 warnings · f2 to view',
].join('\n');
function spool(rows = []) {
  fs.writeFileSync(path.join(process.env.KADAN_HOME, 'stop-hook-spool.jsonl'),
    rows.map(row => JSON.stringify({role, harness: 'codex', result: 'failed', ...row})).join('\n'));
}
function observe(rows, screen = idleScreen(true), allCards = cards) {
  return collectRoles({list: () => [{session, pid: 1}], read: () => screen},
    rows, null, allCards).observations.get(session);
}

test('완료 확정한 앞 카드의 훅·화면 마커는 새 발령의 완료후보가 아니다', () => {
  for (const source of ['hook', 'screen']) {
    spool(source === 'hook' ? [{taskId: 'old', at: at(39.7)}] : []);
    const screen = (source === 'screen' ? 'KADAN:DONE old failed\n' : '') + idleScreen(true);
    const seen = observe(entries, screen);
    assert.equal(seen.doneMarker, null, source);
    assert.equal(seen.doneSource, null);
  }
});

test('현재 카드 DONE은 유지하고 다른 역할·모호한 주소의 done은 발령을 지우지 않는다', () => {
  spool([{taskId: 'new', at: at(59)}]);
  assert.equal(observe(entries).doneMarker?.taskId, 'new');
  spool([{taskId: 'old', at: at(39.7)}]);
  const other = {...done, role: 'p-other'};
  assert.equal(observe([start, sent('old', 22), other]).doneMarker?.taskId, 'old');
  const ambiguous = {...done, executionKey: undefined};
  const allCards = [...cards, {id: 'old', key: 'other/old'}];
  const seen = observe([start, sent('old', 22), ambiguous], 'KADAN:DONE repo/old failed', allCards);
  assert.equal(seen.doneMarker?.taskId, 'repo/old');
});

test('같은 카드 재발령은 새 발령 뒤 훅만 완료로 읽는다', () => {
  const rows = [start, sent('old', 22), done, sent('old', 58)];
  spool([{taskId: 'old', at: at(39.7)}]);
  assert.equal(observe(rows).doneMarker, null);
  spool([{taskId: 'old', at: at(59)}]);
  assert.equal(observe(rows).doneMarker?.taskId, 'old');
});

test('원장과 결과가 다른 훅·화면 DONE과 발령 전 done은 확인할 후보로 남긴다', () => {
  for (const source of ['hook', 'screen']) {
    spool(source === 'hook' ? [{taskId: 'old', at: at(39.7), result: 'ok'}] : []);
    const screen = (source === 'screen' ? 'KADAN:DONE old ok\n' : '') + idleScreen(true);
    assert.equal(observe(entries, screen).doneMarker?.result, 'ok');
  }
  spool([{taskId: 'old', at: at(39.7)}]);
  const earlier = {...done, t: at(20)};
  assert.equal(observe([start, sent('old', 22), earlier, sent('new', 58)]).doneMarker?.taskId, 'old');
});

async function loop({compact = true, screen = idleScreen(compact), extra = [], currentDone = false} = {}) {
  spool([{taskId: 'old', at: at(39.7)}, ...(currentDone ? [{taskId: 'new', at: at(59)}] : [])]);
  let cycle = 0;
  const records = [], messages = [], aiCalls = [], end = new Error('end');
  await assert.rejects(() => runWatch({
    floor: {list: () => [{session, pid: 1}], read: () => screen},
    readEntries: () => [...entries, ...extra], readCards: () => cards,
    liveRecipients: ['p-boss'], parents: new Map([[role, 'p-boss'], ['p-boss', '@user']]),
    routes: new Map(), superRole: 'p-boss', intervalMs: 60_000, stallN: 3,
    startReportGraceMs: 20 * 60_000, stallAfterMs: 20 * 60_000,
    now: () => Date.parse(at(59)) + cycle * 60_000,
    record: row => records.push({...row, testMinute: cycle}),
    sendAlert: (recipient, text) => messages.push({recipient, text}),
    judgeCmd: 'fake', ai: {run: input => { aiCalls.push(input); return {ok: true}; }},
    print: () => {},
    spawn: cmd => {
      if (cmd === 'sleep' && ++cycle === 10) throw end;
      if (cmd === 'memory_pressure') return {status: 0, stdout: 'System-wide memory free percentage: 80%'};
      if (cmd === 'sysctl') return {status: 0, stdout: 'used = 0M'};
      return {status: 0, stdout: ''};
    },
  }), error => error === end);
  return {alerts: records.filter(row => row.alertKind === '멈춤' && !row.resolved), messages, aiCalls};
}

test('실제 감시 순회: 옛 훅·옛 질문이 있어도 압축 여부와 무관하게 4분에 감독 경보 1회', async () => {
  for (const compact of [true, false]) {
    const oldQuestion = {kind: 'send', transport: 'mailbox', by: role, role: 'p-boss',
      mailId: 'old-question', expectReply: true, executionKey: 'repo/old', t: at(23)};
    const result = await loop({compact, extra: [oldQuestion]});
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].testMinute, 4);
    assert.equal(result.alerts[0].recipient, 'p-boss');
    assert.equal(result.messages.length, 1);
    assert.equal(result.aiCalls.length, 0);
  }
});

test('실제 감시 순회: 현재 질문·현재 DONE·사람 입력·큐 배너는 멈춤에서 제외한다', async () => {
  const question = {kind: 'send', transport: 'mailbox', by: role, role: 'p-boss',
    mailId: 'new-question', expectReply: true, executionKey: 'repo/new', t: at(59)};
  const cases = [
    {extra: [question]}, {currentDone: true},
    {screen: idleScreen(true).replace('› Ask Codex to do anything', '› 사람이 쓰는 중')},
    {screen: idleScreen(true) + '\n• Messages to be submitted at end of turn\n  ↳ 다음 요청'},
  ];
  for (const options of cases) assert.equal((await loop(options)).alerts.length, 0, JSON.stringify(options));
});
