import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {resetDiscordBlock, NOTIFY_LOG_FILE} from '../src/user-notify.mjs';
import {makeHerdrFloor} from '../src/floor-herdr.mjs';
import {runWatch} from '../src/watch-runner.mjs';
import {readDecisions} from '../src/notify-threads.mjs';
import {NotifyHoldTracker} from '../src/watch-notify-hold.mjs';
import {sendWatchMailReminder, watchMailHold} from '../src/commands/watch.mjs';
import {sendTmux, notificationHold} from '../src/floor-tmux.mjs';

// PR #192 검수 F1 재현: 신뢰 승인 화면에 막힌 알림 밀림은 5번 뒤 force로도 안 풀리는 사용자 조치 장애다.
// 사용자 알림이 정확히 1건(새 글)이어야 하고, 반복 주기에도 중복이 없어야 한다. 가짜 값·가짜 서버·모의 RPC만 쓴다.
const helper = new URL('./helpers/fake-webhook.mjs', import.meta.url).pathname;
const live = [];
process.on('exit', () => { for (const c of live) c.kill('SIGKILL'); });

async function world() {
  resetDiscordBlock();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-held-trust-'));
  const logFile = path.join(home, 'requests.jsonl');
  const child = spawn(process.execPath, [helper, logFile, JSON.stringify([{status: 200, body: {id: 'M1', channel_id: 'C1'}}])], {stdio: ['ignore', 'pipe', 'inherit']});
  live.push(child);
  const port = await new Promise(resolve => child.stdout.once('data', d => resolve(Number(String(d).match(/PORT (\d+)/)[1]))));
  const secret = path.join(home, 'fake.env');
  fs.writeFileSync(secret, `DISCORD_WEBHOOK_URL=http://127.0.0.1:${port}/api/webhooks/111/FAKETOKEN-held\nDISCORD_USER_ID=424242424242\n`, {mode: 0o600});
  const requests = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return {home, secret, requests, stop: () => child.kill('SIGTERM')};
}

// idleCycles: 앞의 몇 주기는 idle 화면(30초 안정 유예 → 입력 보호 사유)이고 그 뒤 신뢰 승인 화면이 된다.
// idleWhen(n): 주기 번호별로 idle이어야 하면 true(idleCycles보다 우선). cycles: 돌릴 주기 수. readAt: 이 주기부터 우편을 읽은 것으로 보인다(경보가 풀린다).
async function runHeld(w, paneText, {idleCycles = 0, idleWhen = null, cycles = 9, readAt = null} = {}) {
  const saved = {KADAN_HOME: process.env.KADAN_HOME, KADAN_NOTIFY: process.env.KADAN_NOTIFY, KADAN_NOTIFY_ENV_FILE: process.env.KADAN_NOTIFY_ENV_FILE};
  try {
    process.env.KADAN_HOME = w.home; process.env.KADAN_NOTIFY = ''; process.env.KADAN_NOTIFY_ENV_FILE = w.secret;
    const role = 'qa-trust-worker', session = `kadan-${role}`;
    const socket = path.join(os.homedir(), '.config/herdr/sessions/qa-held-trust/herdr.sock'); // 이름 있는 세션 소켓 모양만 필요하다(모의 RPC라 파일은 만들지 않는다)
    const start = {kind: 'start', floor: 'herdr', role, session, panePid: '123', t: new Date(0).toISOString(),
      harness: 'codex', model: 'fixture-model', herdrSocket: socket, herdrWorkspaceId: 'W', herdrTerminalId: 'T'};
    const pane = {pane_id: 'P', workspace_id: 'W', terminal_id: 'T', scroll: {offset_from_bottom: 0}};
    let n = 0;
    const idle = () => (idleWhen ? idleWhen(n) : n < idleCycles);
    const rpc = (sock, method) => {
      if (method === 'session.snapshot') return {snapshot: {panes: [pane]}};
      if (method === 'pane.process_info') return {process_info: {shell_pid: 123, foreground_processes: [{pid: 123, argv: ['codex', '--model', 'fixture-model']}]}};
      if (method === 'agent.get') return {agent: {terminal_id: 'T', agent_status: idle() ? 'idle' : 'blocked'}};
      if (method === 'pane.read') return {read: {text: idle() ? 'stable idle screen' : paneText, revision: 1, truncated: false}};
      throw new Error(`Unexpected mock RPC ${method}`);
    };
    const entries = [start, {kind: 'send', mailId: 'qa-trust-question', role, by: 'qa-trust-boss', t: new Date(0).toISOString(), expectReply: true}];
    const floor = makeHerdrFloor({env: {KADAN_HOME: w.home, KADAN_HERDR_SOCKET: socket}, entries: () => entries, rpc, argsForPid: () => ''});
    if (!idleCycles && !idleWhen) assert.throws(() => floor.send(session, '가짜 알림', {notificationGuard: {force: true}}), {code: 'KADAN_HERDR_TRUST_PROMPT'}); // force로도 안 풀린다
    const records = [], system = []; const stop = new AbortController();
    const tracker = new NotifyHoldTracker({record: e => records.push(e)});
    await runWatch({floor, readEntries: () => [...entries, ...records, ...(readAt !== null && n >= readAt ? [{kind: 'mail-read', mailId: 'qa-trust-question', role, by: role, t: new Date(300000 + readAt * 1000).toISOString()}] : [])], readCards: () => [], readWorks: () => [],
      holdTracker: tracker, record: e => records.push(e), mailUnreadGraceMs: 300000, sendAlert: () => {},
      sendMailReminder: (to, message, pid) => sendWatchMailReminder(to, message, pid, {selectedFloor: floor, readStart: () => start, tracker,
        send: args => floor.send(args.session, args.message, {notificationGuard: args.notificationGuard})}),
      mailHold: to => watchMailHold(to, {selectedFloor: floor, tracker}),
      intervalMs: 1000, stallN: 100, routes: new Map(), now: () => 300000 + n * 1000,
      spawn: cmd => { if (cmd === 'osascript') system.push(cmd); return {status: 0, stdout: ''}; },
      signal: stop.signal, print: () => {}, sleep: async () => { if (++n >= cycles) stop.abort(); }});
    const notices = fs.existsSync(path.join(w.home, NOTIFY_LOG_FILE))
      ? fs.readFileSync(path.join(w.home, NOTIFY_LOG_FILE), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    return {records, system, notices, tracker, role};
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('F1 신뢰 승인 화면에 막힌 알림 밀림은 사용자에게 새 글 1건, 9주기를 돌아도 중복이 없다', async () => {
  const w = await world();
  try {
    const {records, system, notices} = await runHeld(w, 'Do you trust the contents of this directory?');
    const alerts = records.filter(e => e.kind === 'alert' && e.alertKind === '알림밀림');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].holdCode, 'KADAN_HERDR_TRUST_PROMPT');
    assert.equal(alerts[0].recipient, '@user');
    assert.equal(w.requests().length, 1);                       // 새 글 1건
    assert.deepEqual(system, []);                                // 디코로 갔으니 맥 알림 없음
    assert.equal(notices.filter(n => n.outcome === 'policy-skip').length, 0);
  } finally { w.stop(); }
});

test('F1(2라운드) 입력 보호로 시작한 밀림이 신뢰 승인 화면으로 바뀌면 그 변화에 사용자 알림 1건', async () => {
  const w = await world();
  try {
    const {records, system, notices} = await runHeld(w, 'Do you trust the contents of this directory?', {idleCycles: 3});
    const alerts = records.filter(e => e.kind === 'alert' && e.alertKind === '알림밀림');
    assert.deepEqual(alerts.map(a => a.holdCode).slice(0, 2), ['KADAN_HUMAN_ACTIVE', 'KADAN_HERDR_TRUST_PROMPT']); // 처음은 조용한 사유, 바뀐 뒤 한 번 더
    assert.equal(notices.filter(n => n.outcome === 'policy-skip').length, 1);   // 조용한 사유는 안 보냄
    assert.equal(w.requests().length, 1);                                        // 바뀐 사유로 새 글 1건, 이후 같은 사유 반복은 중복 없음
    assert.deepEqual(system, []);
  } finally { w.stop(); }
});

// F2(2라운드): 강제 차례 뒤에도 남는 tmux 모드(시계 모드 등)는 사용자 조치 대상이다. 실제 격리 tmux에서 본다.
const hasTmux = spawnSync('tmux', ['-V']).status === 0 && String(process.env.KADAN_SOCKET ?? '').startsWith('kadan-test-');
test('F2(2라운드) 강제 뒤에도 남는 시계 모드 밀림은 사용자에게 새 글 1건', {skip: !hasTmux && 'tmux 또는 격리 소켓 없음'}, async () => {
  const w = await world(), socket = process.env.KADAN_SOCKET, role = 'qa-held-clock', session = `kadan-${role}`;
  const saved = {KADAN_HOME: process.env.KADAN_HOME, KADAN_NOTIFY: process.env.KADAN_NOTIFY, KADAN_NOTIFY_ENV_FILE: process.env.KADAN_NOTIFY_ENV_FILE};
  const run = (args, input) => {
    const r = spawnSync('tmux', ['-L', socket, ...args], {encoding: 'utf8', input});
    if (r.status !== 0) throw new Error(`isolated tmux: ${r.stderr}`);
    return r.stdout;
  };
  try {
    run(['new-session', '-d', '-s', session, '/bin/sh']);
    run(['clock-mode', '-t', session]);
    const pid = run(['display-message', '-p', '-t', session, '#{pane_pid}']).trim();
    process.env.KADAN_HOME = w.home; process.env.KADAN_NOTIFY = ''; process.env.KADAN_NOTIFY_ENV_FILE = w.secret;
    const start = {kind: 'start', role, session, panePid: pid, t: new Date(0).toISOString()};
    const entries = [start, {kind: 'send', mailId: 'qa-clock-mail', role, by: 'qa-held-boss', t: new Date(0).toISOString(), expectReply: true}];
    const records = [], system = []; let n = 0; const stop = new AbortController();
    const tracker = new NotifyHoldTracker({record: e => records.push(e)});
    const floor = {list: () => [{session, pid}], alive: () => true, read: () => '',
      notificationHold: (to, guard) => notificationHold(to, guard, {run}),
      send: (to, message, options) => sendTmux(to, message, {run, spawn: () => ({status: 0}), ...options})};
    await runWatch({floor, readEntries: () => [...entries, ...records], readCards: () => [], readWorks: () => [],
      holdTracker: tracker, record: e => records.push(e), mailUnreadGraceMs: 300000, sendAlert: () => {},
      sendMailReminder: (to, message, expected) => sendWatchMailReminder(to, message, expected, {selectedFloor: floor, readStart: () => start, tracker,
        send: args => floor.send(args.session, args.message, {notificationGuard: args.notificationGuard})}),
      mailHold: to => watchMailHold(to, {selectedFloor: floor, tracker}), intervalMs: 1000, stallN: 100, routes: new Map(),
      now: () => 300000 + n * 1000, spawn: cmd => { if (cmd === 'osascript') system.push(cmd); return {status: 0, stdout: ''}; },
      signal: stop.signal, print: () => {}, sleep: async () => { if (++n >= 9) stop.abort(); }});
    assert.equal(run(['display-message', '-p', '-t', session, '#{pane_in_mode}']).trim(), '1');   // cancel로 안 풀린 채 남음
    const alerts = records.filter(e => e.alertKind === '알림밀림');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].holdCode, 'KADAN_PANE_IN_MODE');
    assert.equal(w.requests().length, 1);
    assert.deepEqual(system, []);
  } finally {
    try { run(['kill-session', '-t', session]); } catch { /* 이미 없음 */ }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    w.stop();
  }
});

test('F1(3라운드) 조용함 → 신뢰 → 조용함 → 신뢰 → 해소: 글 1건, 해소 때 처음 글에 ✅ 해결됨 고치기 1건', async t => {
  const w = await world();
  try {
    const {records, system, tracker, role} = await runHeld(w, 'Do you trust the contents of this directory?',
      {idleWhen: n => n < 3 || n === 4, cycles: 12, readAt: 9});
    const alerts = records.filter(e => e.kind === 'alert' && e.alertKind === '알림밀림');
    assert.equal(alerts.at(-1).resolved, true);
    assert.equal(tracker.alerts().length, 0);
    assert.equal(tracker.forced(role), false);
    const sent = w.requests();
    assert.equal(sent.length, 2);                                    // 새 글 1건 + 해소 고치기 1건 (두 번째 신뢰는 중복이라 새 글 없음)
    assert.match(sent[0].url, /wait=true/);
    assert.match(sent[1].url, /\/messages\/M1/);                    // 처음 올린 글 M1을 고친다
    assert.match(JSON.parse(sent[1].body).content, /^\[감시sh \d{2}:\d{2}\] ✅ 해결됨 — /);
    t.diagnostic(JSON.parse(sent[1].body).content);
    assert.deepEqual(system, []);
    const posts = Object.entries(readDecisions(w.home)).filter(([k]) => k.startsWith('alert:'));
    assert.equal(posts.length, 1);                                    // 처음 글과의 연결만 남는다
    assert.equal(posts[0][1].resolved, true);
  } finally { w.stop(); }
});
