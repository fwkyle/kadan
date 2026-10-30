// 우편 한 통(cmdMail)이 원장 전체 읽기(readLedgerState)를 몇 번, 어디서 하는지 센다. 자식 프로세스 전용 도구.
// 사용: node send-ledger-reads-child.mjs <저장소 절대경로> <경우>. 결과는 표준 출력의 JSON 한 줄이다.
// 세기: 읽기 함수 이름이 아니라 모든 읽기가 지나는 readLedgerState 입구에 계수기를 끼운다(직접 readLedger() 호출까지 센다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';

const [root, scenario] = process.argv.slice(2);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'send-reads-'));
process.env.KADAN_HOME = home;
process.env.KADAN_NOTIFY = 'off';
process.env.KADAN_ROLE = 'sender';
const calls = [];
globalThis.kadanCountRead = domain => {
  const frames = new Error().stack.split('\n').slice(3).map(line => line.trim())
    .filter(line => line.includes(root) && !/src\/ledger(-domains)?\.mjs/.test(line));
  calls.push({domain: domain ?? 'full', site: frames[0]?.match(/src\/[^:]+:\d+/)?.[0] ?? '?', via: frames[1]?.match(/src\/[^:]+:\d+/)?.[0] ?? '?'});
};
registerHooks({load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  let source = String(result.source);
  if (url.endsWith('/src/ledger-domains.mjs')) {
    source = source.replace('export function readLedgerState(home,{domain=null}={}) {',
      'export function readLedgerState(home,{domain=null}={}) { globalThis.kadanCountRead(domain);');
  }
  // 준비 단계와 guardedSend 사이에 일을 끼워 넣는 시험용 자리. 코드 모양이 바뀌어 못 찾으면 조용히 넘기지 않고 멈춘다.
  if (url.endsWith('/src/commands/send.mjs')) {
    if (!source.includes('receipt = guardedSend({')) throw new Error('guardedSend 호출 자리를 찾지 못함');
    source = source.replace('receipt = guardedSend({', 'globalThis.kadanBeforeGuardedSend?.(); receipt = guardedSend({');
  }
  return {...result, source};
}});
const src = rel => import(pathToFileURL(path.join(root, 'src', rel)).href);
const {floor} = await src('floor.mjs');
const {appendLedger, readLedger} = await src('ledger.mjs');
const {cmdMail} = await src('commands/send.mjs');
const sends = [];
floor.alive = () => true;
floor.pid = () => '11';
floor.send = (_session, message) => { sends.push(message); return {keyDelivery: 'sent'}; };
const start = (role, extra = {}) => ({kind: 'start', role, session: `kadan-${role}`, panePid: '11', ...extra});
appendLedger(start('receiver'), home);
appendLedger(start('sender'), home);
const flags = {};
let argv = ['receiver', '본문'];
if (scenario === 'store') {
  appendLedger({kind: 'start', role: 'nopid', session: 'kadan-nopid'}, home);
  argv = ['nopid', '본문'];
}
if (scenario === 'peer') {
  for (const role of ['슈퍼A', '슈퍼B']) appendLedger(start(role, {roleProfile: 'super'}), home);
  process.env.KADAN_ROLE = '슈퍼A';
  argv = ['슈퍼B', '본문'];
}
if (scenario === 'work') {
  const {WorkStore} = await src('work-store.mjs');
  new WorkStore(home).create({key: 'r/w1', title: 't', goal: 'g', scope: 's', acceptance: 'a', owner: 'sender', repoPath: home, by: 'sender'});
  flags.work = 'r/w1';
}
if (scenario === 'reply') {
  process.env.KADAN_ROLE = 'receiver';
  cmdMail(['sender', '질문'], {'expect-reply': true});
  flags['reply-to'] = readLedger(home).findLast(e => e.kind === 'send' && e.role === 'sender').mailId;
  process.env.KADAN_ROLE = 'sender';
  sends.length = 0;
}
if (scenario === 'generation') {
  // 준비 단계가 원장을 읽은 뒤 전송 직전에 수신자가 새 PID로 다시 시작된 경우.
  globalThis.kadanBeforeGuardedSend = () => appendLedger(start('receiver', {panePid: '22'}), home);
}
const logs = [];
const log = console.log, error = console.error;
console.log = console.error = (...args) => logs.push(args.join(' '));
calls.length = 0;
let outcome = 'ok';
try { cmdMail(argv, flags); } catch (e) { outcome = `error: ${e.message}`; }
console.log = log; console.error = error;
console.log(JSON.stringify({scenario, outcome, calls, floorSends: sends.length, logs}));
