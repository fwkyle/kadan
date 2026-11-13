// Why: 실제 감시기 연결과 guardedSend를 실행하고 바닥·기록·본문·OS 알림만 받아 적는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';

const [root, scenario, mode = 'current'] = process.argv.slice(2);
delete process.env.TMUX;
delete process.env.TMUX_PANE;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-send-reads-'));
process.env.KADAN_HOME = home;
process.env.KADAN_ROLE = 'fixture-sender';
process.env.KADAN_NOTIFY = 'off';
const calls = [], records = [], bodies = [], notifications = [], deliveries = [];
globalThis.__watchSendRecord = entry => records.push(entry);
globalThis.__watchSendBody = (digest, message) => bodies.push(message);
globalThis.__watchSendNotify = message => { notifications.push(message); return {}; };
globalThis.__watchSendCapture = options => { globalThis.__watchSendOptions = options; };
globalThis.__watchSendCount = domain => calls.push(domain ?? 'full');
let found = false;
registerHooks({load(url, context, next) {
  const result = next(url, context);
  if (!url.startsWith('file:') || !url.includes('/src/')) return result;
  let source = String(result.source);
  const replace = (before, after) => {
    if (!source.includes(before)) throw new Error(`계측 입구를 찾지 못함: ${before}`);
    source = source.replace(before, after);
  };
  if (url.endsWith('/ledger-domains.mjs')) {
    const entry = /export function readLedgerState\(home,\{domain=null[^)]*\}=\{\}\) \{/;
    if (!entry.test(source)) throw new Error('readLedgerState 입구를 찾지 못함');
    source = source.replace(entry, text => `${text} globalThis.__watchSendCount(domain);`);
    found = true;
  }
  if (url.endsWith('/cli-guarded-send.mjs')) {
    replace('record = appendLedger,', 'record = globalThis.__watchSendRecord,');
    replace('saveBody = saveMailBody,', 'saveBody = globalThis.__watchSendBody,');
    replace('  let entries;', '  globalThis.__watchBeforeGuard?.();\n  let entries;');
  }
  if (url.endsWith('/role-instructions.mjs') && process.env.WATCH_SEND_TEMPLATE_ROOT) {
    replace("const root = fileURLToPath(new URL('..',import.meta.url));",
      'const root = process.env.WATCH_SEND_TEMPLATE_ROOT;');
  }
  if (url.endsWith('/watch-runner.mjs')) {
    source = 'export async function runWatch(options) { globalThis.__watchSendCapture(options); }';
  }
  if (url.endsWith('/watch-system.mjs')) {
    source = `export const notifyUser = globalThis.__watchSendNotify;
      export const watchProcessName = () => 'fixture-watch';`;
  }
  return {...result, source};
}});
const src = relative => import(pathToFileURL(path.join(root, 'src', relative)).href);
const {appendLedger, readLedger} = await src('ledger.mjs');
const {appendStream} = await src('storage.mjs');
const {floor} = await src('floor.mjs');
const watch = await src('commands/watch.mjs');
const {guardedSend} = await src('cli-guarded-send.mjs');
const {lastStartFor, recordedPid, sessionName} = await src('cli-basics.mjs');
const {startDigest} = await src('secretary-resume.mjs');
const {NotifyHoldTracker} = await src('watch-notify-hold.mjs');
const {DatabaseSync} = await import('node:sqlite');
const role = 'fixture-검수자', session = sessionName(role);
let pid = '11', between = null;
const start = extra => ({kind:'start', role, session, panePid:pid,
  cwd:home, model:'gpt-fixture', roleProfile:'reviewer', ...extra});
const addStart = extra => appendLedger(start(extra), home);
appendStream(home, 'ledger.jsonl', {kind:'start', role, session, panePid:'9', model:'gpt-old'});
addStart();
appendLedger({kind:'start', role:'fixture-작업자', session:'kadan-fixture-작업자',
  panePid:'33', model:'gpt-fixture'}, home);
appendLedger({kind:'watch-cycle', by:'watch', timing:{steps:[{ms:123}]}}, home);
appendLedger({kind:'watch-scope', by:'watch', scope:{huge:'unused'}}, home);
appendLedger({kind:'send', role, session, message:'old',
  roleInstructions:{status:'applied', profile:'reviewer', templateDigest:'old'},
  instructions:{mode:'full', profile:'reviewer', templateDigest:'old'}}, home);
if (['reuse', 'reopen', 'restart'].includes(scenario)) {
  const original = readLedger(home).findLast(e => e.kind === 'start' && e.role === role);
  const link = startDigest(original);
  if (!/^[a-f0-9]{64}$/.test(link)) throw new Error('시작 기록 연결 지문이 아님');
  if (scenario !== 'reuse') appendLedger({kind:'stop', role, session}, home);
  addStart(scenario === 'reuse' ? {reuseOf:link, reused:true} :
    scenario === 'reopen' ? {reopen:true, reopenOf:link, conversationMode:'resume'} :
      {restart:true, restartOf:link, conversationMode:'resume'});
}
if (scenario === 'stopped') appendLedger({kind:'stop', role, session}, home);
if (scenario === 'old') {
  // 옛 형식에는 role과 panePid가 없고 rottiePid만 있다.
  appendStream(home, 'ledger.jsonl', {kind:'start', session:'kadan-legacy', rottiePid:'11'});
}
floor.list = () => [];
floor.alive = () => scenario !== 'missing-session';
floor.pid = () => pid;
floor.notificationHold = () => scenario === 'held'
  ? {code:'KADAN_HUMAN_ACTIVE', message:'fixture hold'} : null;
floor.send = (address, message, options) => {
  if (scenario === 'held' && options.notificationGuard) {
    throw Object.assign(new Error('fixture hold'), {code:'KADAN_HUMAN_ACTIVE', delivery:'not-sent'});
  }
  deliveries.push({address, message, options});
  return {keyDelivery:'sent', sequence:1};
};
floor.sendEnter = address => { deliveries.push({enter:address}); return {keyDelivery:'sent'}; };
const print = console.log, warn = console.error, logs = [];
console.log = console.error = (...args) => logs.push(args.join(' '));
await watch.cmdWatch([], {});
const current = globalThis.__watchSendOptions;
if (!found || !current?.sendAlert || !current?.resume429 || !current?.sendQueueEnter) {
  throw new Error('읽기 계수기 또는 실제 감시기 연결을 찾지 못함');
}
const legacy = {
  sendAlert: (r, m) => watch.sendWatchMessage(r, m),
  sendNudge: (r, m) => watch.sendWatchNudge(r, m),
  sendMailReminder: (r, m, p) => watch.sendWatchMailReminder(r, m, p),
  mailHold: r => watch.watchMailHold(r),
  resume429: (r, message, expectedPid) => {
    const address = sessionName(r);
    if (String(recordedPid(lastStartFor(address))) !== String(expectedPid)) {
      throw new Error('429 재개 세대 변경');
    }
    return guardedSend({floor, session:address, role:r, message, source:'watch', recordedPid:expectedPid});
  },
  sendQueueEnter: (r, expectedPid) => {
    if (String(recordedPid(lastStartFor(sessionName(r)))) !== String(expectedPid)) {
      throw new Error('입력 큐 재개 세대 변경');
    }
    return floor.sendEnter(sessionName(r));
  },
};
// 주기 읽기 후 전송 전에 별도 쓰기가 들어오는 경우. 실제 전송 연결의 cycleReads를 사용한다.
const stale = current.readEntries();
// 공유된 배열과 각 사건은 전송 길에서 고치면 안 된다.
const freeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const item of Object.values(value)) freeze(item);
};
freeze(stale);
if (['fresh', 'between', 'pid-mismatch'].includes(scenario)) {
  const change = () => { pid = '22'; addStart({roleProfile:'super'}); };
  if (scenario === 'between') between = change;
  else if (scenario === 'pid-mismatch') pid = '22';
  else change();
}
if (scenario === 'broken') {
  const db = new DatabaseSync(path.join(home, 'kadan.sqlite'));
  const order = db.prepare("SELECT max(json_extract(payload,'$._ledgerOrder')) AS n FROM events").get().n;
  const seq = db.prepare("SELECT max(seq) AS n FROM events WHERE stream='system/events.jsonl'").get().n;
  db.prepare('INSERT INTO events(stream,seq,payload) VALUES (?,?,?)').run('system/events.jsonl', seq + 1,
    JSON.stringify({kind:'watch-cycle', by:'watch', _ledgerOrder:order + 5}));
  db.close();
}
let senders = mode === 'legacy' ? legacy : current;
globalThis.__watchBeforeGuard = () => { between?.(); between = null; };
if (mode === 'stale') {
  if (!watch.createWatchSenders) throw new Error('새 연결 함수 없음');
  const readEntries = mode === 'stale' ? () => stale : current.readEntries;
  senders = watch.createWatchSenders(readEntries, {selectedFloor:floor,
    tracker:new NotifyHoldTracker({record:globalThis.__watchSendRecord}),
    send:guardedSend});
}
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['t','mailId','digest','bodySha256','templateDigest','templateDigestFull'].includes(key))
    .map(([key, item]) => [key, normalize(item)]));
  return typeof value === 'string' ? value.replaceAll(home, '<home>')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>')
    .replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/g, '<uuid>')
    .replace(/\b[a-f0-9]{12,64}\b/g, '<digest>') : value;
};
const output = {};
const kinds = ['sendAlert','sendMailReminder','resume429','sendQueueEnter','sendNudge','mailHold','user'];
for (const kind of kinds) {
  calls.length = records.length = bodies.length = notifications.length = deliveries.length = logs.length = 0;
  let error = null;
  const target = scenario === 'no-start' ? 'absent' : scenario === 'old' ? 'legacy' : role;
  const expected = ['fresh','pid-mismatch'].includes(scenario) ? '11' : pid;
  try {
    if (kind === 'user') senders.sendAlert('@user', 'fixture alert');
    else if (kind === 'sendQueueEnter' || kind === 'mailHold') senders[kind](target, expected);
    else {
      const withPid = kind === 'sendMailReminder' || kind === 'resume429';
      senders[kind](target, 'fixture alert', withPid ? expected : undefined);
    }
  } catch (e) { error = {code:e.code ?? null, delivery:e.delivery ?? null, message:e.message}; }
  output[kind] = normalize({calls:[...calls], records:[...records], bodies:[...bodies],
    notifications:[...notifications], deliveries:[...deliveries], error, logs:[...logs]});
}
console.log = print; console.error = warn;
print(JSON.stringify({scenario, mode, output}));
