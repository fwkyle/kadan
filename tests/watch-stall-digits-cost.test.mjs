import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {runWatch} from '../src/watch-runner.mjs';
import {watchResponsibility} from '../src/watch-report.mjs';

// 검수(PR #187 1라운드) 시나리오 B·C를 감시 순회 수준으로 옮긴 시험. 가짜 실행기·가짜 시계만 쓴다.
const epoch = Date.parse('2026-10-18T00:00:00.000Z');
const stamp = m => new Date(epoch + m * 60_000).toISOString();
const lt = n => [...String(n)].map(d => 'ghijklmnop'[d]).join('');
const parents = new Map([['t-작업자', 't-감독'], ['t-감독', 't-슈퍼감독'], ['t-슈퍼감독', '@user'], ['t-done', 't-감독']]);

async function simulate({minutes, screen, cards = [], extraEntries = [], verdict = '진행중'}) {
  const starts = ['t-작업자', 't-done', 't-감독', 't-슈퍼감독']
    .map((role, i) => ({kind: 'start', role, session: 'kadan-' + role, panePid: i + 1, t: stamp(0)}));
  const entries = [...starts, ...extraEntries];
  const records = [], sent = [], nudges = [], aiCalls = [];
  let minute = 0;
  const controller = new AbortController();
  await runWatch({
    signal: controller.signal, intervalMs: 60_000, stallN: 2, stallAfterMs: 300_000,
    startReportGraceMs: 300_000, idleMs: 15 * 60_000,
    parents, routes: new Map(), superRole: 't-슈퍼감독', judgeCmd: 'fake', judgeCooldownMs: 300_000,
    now: () => epoch + minute * 60_000,
    floor: {
      list: () => starts.map(s => ({session: s.session, pid: s.panePid})),
      read: session => screen(session, minute),
    },
    readEntries: () => entries, readCards: () => cards, readWorks: () => [], readDecisions: () => [],
    sendAlert: (role, msg) => { sent.push([minute, role, msg]); },
    sendNudge: (role, msg) => { nudges.push([minute, role, msg]); },
    record: e => { records.push({...e, minute}); entries.push({...e, t: stamp(minute)}); },
    print: () => {}, spawn: () => ({status: 0, stdout: ''}),
    ai: {reports: {retire: () => {}}, run: args => {
      aiCalls.push({minute, role: args.role, source: args.source});
      const resp = watchResponsibility(args.role, cards, entries, parents, args.source, []);
      const key = args.source + ':' + args.role + ':' + (args.taskId || '') + ':' + resp;
      entries.push({kind: 'watch-ai-request', by: 'watch', protocol: 2, requestId: 'req-' + aiCalls.length,
        source: args.source, role: args.role, session: args.session, taskId: args.taskId ?? null,
        observationDigest: args.observationDigest, evidenceDigest: args.evidenceDigest,
        responsibility: resp, key, t: stamp(minute)});
      entries.push({kind: 'watch-ai-report', by: 'watch-ai', accepted: true, requestId: 'req-' + aiCalls.length,
        key, source: args.source, role: args.role,
        session: args.session, taskId: args.taskId ?? null, responsibility: resp,
        observationDigest: args.observationDigest, verdict, level: 'AMBER', t: stamp(minute)});
      return {ok: true};
    }},
    sleep: async () => { await setImmediate(); if (++minute >= minutes) controller.abort(); },
  });
  const alerts = records.filter(e => e.kind === 'alert');
  return {alerts, sent, nudges, aiCalls, records, entries};
}


const card = id => ({id, key: 'r/' + id, role: 't-작업자', status: 'assigned', workType: 'execution',
  activity: 'running', activityRole: 't-작업자', activityAt: stamp(0)});
const sendOf = id => [{kind: 'send', role: 't-작업자', taskId: id, t: stamp(0)}];
const workerCalls = r => r.aiCalls.filter(c => c.role === 't-작업자').map(c => c.minute);

// 상태 줄 읽기(kadan/work-watch-status-line) 뒤: 시계가 늘어나는 '일하는 중' 화면은 정체 후보가 아니라 정체 AI(source stall)를 부르지 않는다.
// 이전에는 5분에 정체 AI가 처음 불렸다([5, 35, 65, 95, 125]). 이제는 진행 점검(progress)만 30분 간격 이상으로 남는다.
test('B: 시계만 도는 정상 작업 130분 — 정체 AI는 안 불리고 진행 점검만 30분 간격 이상으로 불린다', async () => {
  const r = await simulate({minutes: 130, cards: [card('t-b')], extraEntries: sendOf('t-b'),
    screen: (s, m) => s === 'kadan-t-작업자'
      ? ['• Working (' + m + 'm ' + (m * 7 % 60) + 's • esc to interrupt)', '', '› Ask Codex to do anything'].join('\n')
      : 'healthy'});
  assert.equal(r.aiCalls.filter(c => c.role === 't-작업자' && c.source === 'stall').length, 0, '일하는 중은 정체 AI 대상이 아니다');
  const calls = workerCalls(r);
  assert.ok(calls.length >= 1 && calls.length <= 5, '진행 점검만 남는다: ' + calls.join(','));
  calls.slice(1).forEach((m, i) => assert.ok(m - calls[i] >= 30, '30분 재검사 간격: ' + calls.join(',')));
});

test('B2: 8분마다 실제 새 출력이 나오면 그때마다 새 근거로 다시 불린다', async () => {
  const r = await simulate({minutes: 130, cards: [card('t-b2')], extraEntries: sendOf('t-b2'),
    screen: (s, m) => s === 'kadan-t-작업자'
      ? ['• Working (' + m + 'm • esc to interrupt)', '산출 ' + lt(Math.floor(m / 8)), '', '› Ask Codex to do anything'].join('\n')
      : 'healthy'});
  const calls = workerCalls(r);
  assert.ok(calls.length >= 14 && calls.length <= 17, '새 출력 약 8분마다: ' + calls.join(','));
  assert.ok(calls.some(m => m >= 10 && m < 30), '30분 안에도 새 출력이면 다시 불린다');
});

const old429 = '  └ Exceeded retry limit, last status: 429 Too Many Requests';
const crawl = (m, below, extra = []) => ['이전 출력 ' + lt(m), old429,
  ...Array.from({length: below - 1}, (_, i) => '진행 줄 ' + lt(i + 1)), ...extra,
  '• Working (' + m + 'm • esc to interrupt)'].join('\n');
const limitAlerts = r => r.alerts.filter(a => a.alertKind === '한도');

test('C: 창 밖으로 나갔던 옛 429 줄이 다시 그리며 창 안(13→12번째)으로 들어와도 새 한도 경보는 없다', async () => {
  const r = await simulate({minutes: 8, cards: [card('t-c')], extraEntries: sendOf('t-c'),
    screen: (s, m) => s === 'kadan-t-작업자' ? crawl(m, m < 3 ? 12 : 11) : 'healthy'});
  assert.deepEqual(limitAlerts(r), []);
});

// PR #200: 즉시 경보는 '현재 오류 덩어리'(마지막 빈 입력창 위 오류 머리줄 덩어리)에서만 난다. 일하는 표시가 아래에 계속 보이는
// 크롤 화면의 429 줄은 더 이상 한 줄 낱말로 읽지 않는다(그 화면은 정체 경로가 맡는다). 이 시험의 뜻 — 같은 글의 새 429가 새로 찍히면
// 경보 — 은 새 오류 덩어리(재연결 머리줄 + 429 줄 + 빈 입력창)가 나타나는 모양으로 옮겼다.
test('C2: 같은 글의 새 429가 현재 오류 덩어리로 새로 나타나면 한도 경보가 난다', async () => {
  const withBlock = m => ['이전 출력 ' + lt(m), old429, '• Reconnecting... ' + (m % 5 + 1) + '/5', old429, '', '› Ask Codex to do anything'].join('\n');
  const r = await simulate({minutes: 8, cards: [card('t-c2')], extraEntries: sendOf('t-c2'),
    screen: (s, m) => s === 'kadan-t-작업자' ? (m < 3 ? crawl(m, 12) : withBlock(m)) : 'healthy'});
  assert.equal(limitAlerts(r).length, 1);
  assert.equal(limitAlerts(r)[0].minute, 3);
});
