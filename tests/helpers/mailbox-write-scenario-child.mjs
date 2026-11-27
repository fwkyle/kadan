// 고정된 우편 명령 순서를 격리 홈에서 실행하고 원장에 붙은 줄을 그대로 낸다. 자식 프로세스 전용 도구.
// 사용: node mailbox-write-scenario-child.mjs <저장소 절대경로> <narrow|full> [붙은 줄을 적을 파일]
// Why: 우편함 명령의 읽기를 좁혀도 쓰기 길(우편 저장·읽음·취소·최종 답장·차례 반환)이 원장에 붙이는 줄은 바이트까지 같아야 한다.
//  - narrow: 저장소 코드 그대로.
//  - full: 같은 코드에서 좁은 읽기 세 함수만 전체 읽기(readMailboxLedger·readSendLedger·readLedger)로 바꿔 끼운다(좁히기 전과 같은 읽기).
//    좁은 읽기가 없는 옛 저장소에서는 바꿀 것이 없어 그대로 돈다.
// 시각과 우편 ID는 고정한다: Date는 단계마다 1초씩만 흐르는 가짜 시계, randomUUID는 차례 번호다. 두 실행의 차이는 읽기뿐이다.
// 결과는 표준 출력의 JSON 한 줄이다({rows, sha256, kinds, steps, homeReplaced}).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const [root, mode, outFile] = process.argv.slice(2);
if (!root || !['narrow', 'full'].includes(mode)) throw new Error('사용: <저장소 절대경로> <narrow|full> [출력 파일]');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-write-'));
process.env.KADAN_HOME = home;
process.env.KADAN_NOTIFY = 'off';
delete process.env.KADAN_ROLE;

// 가짜 시계: 인자 없는 new Date()와 Date.now()만 고정값을 낸다. 단계 사이에만 흐른다.
const RealDate = Date;
let now = RealDate.UTC(2026, 0, 1, 0, 0, 0);
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(now); }
  static now() { return now; }
};
// 가짜 우편 ID: 부른 차례대로 번호를 매긴다. 이름 붙은 import에도 반영되게 내장 모듈 내보내기를 다시 맞춘다.
let uuid = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`;
syncBuiltinESMExports();

let replaced = 0;
registerHooks({load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (mode !== 'full' || !url.endsWith('/src/ledger.mjs')) return result;
  let source = String(result.source);
  if (!source.includes('LedgerNarrow')) return result; // 좁은 읽기가 없는 옛 코드
  for (const [narrow, full] of [['readMailboxLedgerNarrow', 'readMailboxLedger'], ['readSendLedgerNarrow', 'readSendLedger'],
    ['readHandoverLedger', 'readLedger']]) {
    const entry = new RegExp(`export function ${narrow}\\(home = ledgerHome\\(\\)\\) \\{`);
    if (!entry.test(source)) throw new Error(`${narrow} 입구를 찾지 못함`);
    source = source.replace(entry, found => `${found} return ${full}(home);`);
    replaced++;
  }
  return {...result, source};
}});

const src = rel => import(pathToFileURL(path.join(root, 'src', rel)).href);
const {floor} = await src('floor.mjs');
const {appendLedger} = await src('ledger.mjs');
const {createDatabase, writeStorageMarker} = await src('storage.mjs');
const {cmdMail, cmdSend} = await src('commands/send.mjs');
const {Mailbox, inboxCommand} = await src('mailbox.mjs');
const {WorkStore} = await src('work-store.mjs');
if (mode === 'full' && fs.readFileSync(path.join(root, 'src/ledger.mjs'), 'utf8').includes('LedgerNarrow') && replaced !== 3) {
  throw new Error('좁은 읽기를 전체 읽기로 바꿔 끼우지 못함');
}

createDatabase(home); writeStorageMarker(home, 'sqlite');
floor.alive = () => true;
floor.pid = () => '11';
let duringSend = null;
floor.send = () => { const hook = duringSend; duringSend = null; hook?.(); return {keyDelivery: 'sent'}; };

class Exit extends Error {}
const steps = [];
const quiet = fn => {
  const log = console.log, error = console.error, exit = process.exit, out = [];
  console.log = console.error = (...args) => out.push(args.join(' '));
  process.exit = code => { throw new Exit(`exit ${code}`); };
  try { return {value: fn(), out}; } catch (e) { return {error: e instanceof Exit ? `${e.message}: ${out.at(-1) ?? ''}` : e.message, out}; }
  finally { console.log = log; console.error = error; process.exit = exit; }
};
// 단계 하나: 이름, 보내는 역할(KADAN_ROLE), 할 일. 끝나면 가짜 시계를 1초 보낸다.
function step(name, role, fn) {
  if (role) process.env.KADAN_ROLE = role; else delete process.env.KADAN_ROLE;
  const result = quiet(fn);
  steps.push({name, ...(result.error ? {error: result.error} : {})});
  now += 1000;
  return result.value;
}
const lastMail = (role, by) => {
  const db = new DatabaseSync(path.join(home, 'kadan.sqlite'), {readOnly: true});
  try {
    const rows = db.prepare("SELECT payload FROM events WHERE stream='mail/events.jsonl' ORDER BY seq DESC").all();
    return rows.map(row => JSON.parse(row.payload)).find(e => e.kind === 'send' && e.role === role && e.by === by)?.mailId;
  } finally { db.close(); }
};
const start = (role, extra = {}) => appendLedger({kind: 'start', role, session: `kadan-${role}`, panePid: '11', ...extra}, home);

for (const role of ['alpha', 'beta', 'gamma']) step(`start ${role}`, null, () => start(role));
step('start delta(PID 없음)', null, () => appendLedger({kind: 'start', role: 'delta', session: 'kadan-delta'}, home));
// 바로 넣는 우편, 질문, 읽음, 중간 답장, 최종 답장(쓰기 잠금 안에서 답장 연결을 다시 읽는다).
step('mail 평문', 'alpha', () => cmdMail(['beta', '평문 우편'], {}));
step('mail 질문', 'alpha', () => cmdMail(['beta', '질문 하나?'], {'expect-reply': true}));
const q1 = lastMail('beta', 'alpha');
step('inbox ack', 'beta', () => inboxCommand(['ack', q1], {role: 'beta'}, {home, by: 'beta'}));
step('inbox ack 반복', 'beta', () => inboxCommand(['ack', q1], {role: 'beta'}, {home, by: 'beta'}));
step('mail 중간 답장', 'beta', () => cmdMail(['alpha', '검토 중'], {'reply-to': q1}));
step('mail 최종 답장', 'beta', () => cmdMail(['alpha', '찬성'], {'reply-to': q1, 'reply-final': true}));
step('mail 최종 답장 반복(거절)', 'beta', () => cmdMail(['alpha', '또 찬성'], {'reply-to': q1, 'reply-final': true}));
// 저장 전용 수신자(비서)와 꺼진 역할 앞 보관, 답변 대기 취소.
step('mail 비서', 'alpha', () => cmdMail(['비서', '비서 보고'], {}));
step('mail 비서 질문', 'alpha', () => cmdMail(['비서', '비서 질문?'], {'expect-reply': true}));
const q2 = lastMail('비서', 'alpha');
step('mail 비서의 최종 답', '비서', () => cmdMail(['alpha', '비서 답'], {'reply-to': q2, 'reply-final': true}));
step('mail 보관(꺼진 역할)', 'alpha', () => cmdMail(['delta', '보관될 질문?'], {'expect-reply': true}));
const q3 = lastMail('delta', 'alpha');
step('inbox cancel', 'alpha', () => inboxCommand(['cancel', q3], {role: 'alpha'}, {home, by: 'alpha'}));
step('mail 취소된 질문에 최종 답(거절)', 'delta', () => cmdMail(['alpha', '늦은 답'], {'reply-to': q3, 'reply-final': true}));
// 중복 거르기(sourceKey).
for (const n of [1, 2]) {
  step(`저장 sourceKey ${n}`, null, () => new Mailbox(home, '비서').send({by: 'discord', message: '디코 글', sourceKey: 'discord:1'}));
}
// 발령(send --task 없는 옛 꼴은 원장 직접 기록) → 완료 → 자동 결과 우편 → 그 우편 읽음.
step('발령 기록', null, () => appendLedger({kind: 'send', role: 'beta', by: 'alpha', taskId: 't-1', digest: 'dx', bytes: 1}, home));
step('완료 기록', null, () => appendLedger({kind: 'done', role: 'beta', taskId: 't-1', result: 'ok', by: 'alpha'}, home));
const completion = lastMail('alpha', 'beta');
step('inbox ack 결과 우편', 'alpha', () => inboxCommand(['ack', completion], {role: 'alpha'}, {home, by: 'alpha'}));
// 업무 연결 우편과 차례 반환(업무 잠금 안에서 책임자를 다시 읽는다).
step('업무 등록', null, () => new WorkStore(home).create({key: 'r/w1', title: '업무', goal: '결과', scope: '범위', acceptance: '조건',
  owner: 'alpha', repoPath: '/tmp', by: 'alpha'}));
step('업무 차례 넘김', null, () => new WorkStore(home).change('r/w1', 'update', {turnOwner: 'beta'}, {revision: 1, by: 'alpha', note: '차례'}));
step('mail 업무 결과(차례 반환)', 'beta', () => cmdMail(['alpha', '업무 결과'], {work: 'r/w1'}));
step('send 업무 연결', 'alpha', () => cmdSend(['beta', '업무 지시'], {work: 'r/w1'}));
// 인계 뒤 답장: 질문한 alpha의 책임이 gamma로 넘어간 뒤에는 옛 주소(alpha)로 보낸 최종 답도 현재 책임자 gamma에게 간다.
step('mail 인계 전 질문', 'alpha', () => cmdMail(['beta', '인계 전 질문?'], {'expect-reply': true}));
const q4 = lastMail('beta', 'alpha');
step('인계 확정', null, () => appendLedger({kind: 'handover', phase: 'transferred', handoverId: 'h1', from: 'alpha', to: 'gamma', by: 'alpha'}, home));
step('mail 인계 뒤 옛 주소로 최종 답', 'beta', () => cmdMail(['alpha', '옛 주소 답'], {'reply-to': q4, 'reply-final': true}));
step('mail 인계 뒤 최종 답 반복(거절)', 'beta', () => cmdMail(['gamma', '인계 뒤 답'], {'reply-to': q4, 'reply-final': true}));
// 같은 이름 새 대화(세대 경계) 뒤 우편과 이전 세대 미확인 읽음.
step('mail 세대 앞 우편', 'gamma', () => cmdMail(['beta', '세대 앞 우편'], {}));
const old = lastMail('beta', 'gamma');
step('stop beta', null, () => appendLedger({kind: 'stop', role: 'beta', session: 'kadan-beta', by: '사람'}, home));
step('start beta 새 대화', null, () => start('beta', {conversationMode: 'new'}));
step('mail 세대 뒤 우편', 'gamma', () => cmdMail(['beta', '세대 뒤 우편'], {}));
step('inbox ack 이전 세대 우편', 'beta', () => inboxCommand(['ack', old], {role: 'beta'}, {home, by: 'beta'}));
// 전달 중 경쟁: 최종 답을 창에 넣는 사이 다른 최종 답이 먼저 저장되면, 전달 사실만 남기고 최종 답으로는 인정하지 않는다.
step('mail 경쟁용 질문', 'gamma', () => cmdMail(['beta', '경쟁 질문?'], {'expect-reply': true}));
const q5 = lastMail('beta', 'gamma');
step('mail 최종 답(전달 중 경쟁)', 'beta', () => {
  duringSend = () => new Mailbox(home, 'gamma').send({by: 'beta', message: '먼저 저장된 최종 답', replyTo: q5, replyFinal: true});
  return cmdMail(['gamma', '늦게 기록될 최종 답'], {'reply-to': q5, 'reply-final': true});
});

const db = new DatabaseSync(path.join(home, 'kadan.sqlite'), {readOnly: true});
let lines;
try { lines = db.prepare('SELECT stream, seq, payload FROM events ORDER BY rowid').all().map(row => `${row.stream}\t${row.seq}\t${row.payload}`); }
finally { db.close(); }
// 실행마다 달라지는 것은 임시 홈 경로뿐이다. 그 글자만 표지로 바꾼다(바꾼 횟수를 함께 낸다).
let homeReplaced = 0;
const dump = lines.map(line => line.replaceAll(home, () => { homeReplaced++; return '<HOME>'; })).join('\n') + '\n';
if (outFile) fs.writeFileSync(outFile, dump);
const kinds = {};
for (const line of lines) { const kind = JSON.parse(line.split('\t')[2]).kind ?? '(종류 없음)'; kinds[kind] = (kinds[kind] ?? 0) + 1; }
console.log(JSON.stringify({mode, rows: lines.length, sha256: crypto.createHash('sha256').update(dump).digest('hex'),
  kinds, steps, homeReplaced, replaced, ...(outFile ? {} : {dump})}));
