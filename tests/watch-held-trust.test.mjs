import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {resetDiscordBlock, NOTIFY_LOG_FILE} from '../src/user-notify.mjs';
import {makeHerdrFloor} from '../src/floor-herdr.mjs';
import {runWatch} from '../src/watch-runner.mjs';
import {NotifyHoldTracker} from '../src/watch-notify-hold.mjs';
import {sendWatchMailReminder, watchMailHold} from '../src/commands/watch.mjs';

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

async function runHeld(w, paneText) {
  const saved = {KADAN_HOME: process.env.KADAN_HOME, KADAN_NOTIFY: process.env.KADAN_NOTIFY, KADAN_NOTIFY_ENV_FILE: process.env.KADAN_NOTIFY_ENV_FILE};
  try {
    process.env.KADAN_HOME = w.home; process.env.KADAN_NOTIFY = ''; process.env.KADAN_NOTIFY_ENV_FILE = w.secret;
    const role = 'qa-trust-worker', session = `kadan-${role}`;
    const socket = path.join(os.homedir(), '.config/herdr/sessions/qa-held-trust/herdr.sock'); // 이름 있는 세션 소켓 모양만 필요하다(모의 RPC라 파일은 만들지 않는다)
    const start = {kind: 'start', floor: 'herdr', role, session, panePid: '123', t: new Date(0).toISOString(),
      harness: 'codex', model: 'fixture-model', herdrSocket: socket, herdrWorkspaceId: 'W', herdrTerminalId: 'T'};
    const pane = {pane_id: 'P', workspace_id: 'W', terminal_id: 'T', scroll: {offset_from_bottom: 0}};
    const rpc = (sock, method) => {
      if (method === 'session.snapshot') return {snapshot: {panes: [pane]}};
      if (method === 'pane.process_info') return {process_info: {shell_pid: 123, foreground_processes: [{pid: 123, argv: ['codex', '--model', 'fixture-model']}]}};
      if (method === 'agent.get') return {agent: {terminal_id: 'T', agent_status: 'blocked'}};
      if (method === 'pane.read') return {read: {text: paneText, revision: 1, truncated: false}};
      throw new Error(`Unexpected mock RPC ${method}`);
    };
    const entries = [start, {kind: 'send', mailId: 'qa-trust-question', role, by: 'qa-trust-boss', t: new Date(0).toISOString(), expectReply: true}];
    const floor = makeHerdrFloor({env: {KADAN_HOME: w.home, KADAN_HERDR_SOCKET: socket}, entries: () => entries, rpc, argsForPid: () => ''});
    assert.throws(() => floor.send(session, '가짜 알림', {notificationGuard: {force: true}}), {code: 'KADAN_HERDR_TRUST_PROMPT'}); // force로도 안 풀린다
    const records = [], system = []; let n = 0; const stop = new AbortController();
    const tracker = new NotifyHoldTracker({record: e => records.push(e)});
    await runWatch({floor, readEntries: () => [...entries, ...records], readCards: () => [], readWorks: () => [],
      holdTracker: tracker, record: e => records.push(e), mailUnreadGraceMs: 300000, sendAlert: () => {},
      sendMailReminder: (to, message, pid) => sendWatchMailReminder(to, message, pid, {selectedFloor: floor, readStart: () => start, tracker,
        send: args => floor.send(args.session, args.message, {notificationGuard: args.notificationGuard})}),
      mailHold: to => watchMailHold(to, {selectedFloor: floor, tracker}),
      intervalMs: 1000, stallN: 100, routes: new Map(), now: () => 300000 + n * 1000,
      spawn: cmd => { if (cmd === 'osascript') system.push(cmd); return {status: 0, stdout: ''}; },
      signal: stop.signal, print: () => {}, sleep: async () => { if (++n >= 9) stop.abort(); }});
    const notices = fs.existsSync(path.join(w.home, NOTIFY_LOG_FILE))
      ? fs.readFileSync(path.join(w.home, NOTIFY_LOG_FILE), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    return {records, system, notices};
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
