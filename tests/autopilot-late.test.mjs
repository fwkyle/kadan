import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger, readMailBody} from '../src/ledger.mjs';
import {autopilotCommand} from '../src/commands/autopilot.mjs';
import {autopilotState} from '../src/autopilot.mjs';
import {autopilotGuard} from '../src/autopilot-guard.mjs';
import {readPolicy, evaluateGithub} from '../src/autopilot-repo-policy.mjs';
import {briefMessage, briefStartedRole} from '../src/start-brief.mjs';
import {lateMessage, DELIVERY_KIND} from '../src/autopilot-late.mjs';

// 가짜 우편·가짜 시계만 쓴다. 운영 홈·우편·tmux에 닿지 않는다(격리 tmux 시험은 자기 소켓 하나만 쓰고 끝에 그 소켓만 끈다).
const T0 = Date.parse('2026-11-23T01:00:00.000Z');
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-ap-late-'));
  const table = {'a-슈퍼감독': '@user', 'a-감독': 'a-슈퍼감독', 'b-슈퍼감독': '@user', 'b-감독': 'b-슈퍼감독'};
  const file = path.join(home, 'hierarchy.json');
  fs.writeFileSync(file, JSON.stringify(table));
  appendLedger({kind: 'hierarchy-loaded', path: file, hash: 'x', by: 'watch'}, home);
  for (const role of ['a-슈퍼감독', 'b-슈퍼감독']) appendLedger({kind: 'start', role, session: `kadan-${role}`, roleProfile: 'super'}, home);
  const works = [{key: 'a/w1', status: 'open', owner: 'a-감독', executions: []}];
  const sent = [];
  let clock = T0;
  const deps = {now: () => clock, readWorks: () => works,
    sendMail: (role, message) => { sent.push({role, message}); return {ok: true, mailId: `mail-${sent.length}`}; }, notify: () => {}};
  const run = (args, flags = {}, by = '사람') => autopilotCommand(args, flags, {home, by, deps});
  // 결과 사건만(예약 reserved는 보내기 직전 표시라 같은 전달의 결과 사건이 덮는다)
  const deliveries = () => readLedger(home).filter(e => e.kind === DELIVERY_KIND && e.delivery !== 'reserved');
  const reservations = () => readLedger(home).filter(e => e.kind === DELIVERY_KIND && e.delivery === 'reserved');
  return {home, works, sent, deps, run, deliveries, reservations, setNow: ms => { clock = ms; }};
}

test('1-1. 켜짐 뒤 업무를 받은 슈퍼감독은 status missing에 있고, deliver가 한 번 보낸 뒤 missing에서 빠진다(두 번째는 없음)', () => {
  const f = fixture();
  f.run(['on', '자리 비움'], {level: 'autopilot', quote: '자는 동안 알아서 해'});
  assert.deepEqual(f.sent.map(m => m.role), ['a-슈퍼감독']); // 켤 때는 업무가 있던 쪽에만
  f.works.push({key: 'b/w1', status: 'open', owner: 'b-감독', executions: []}); // 켠 뒤 b도 업무를 받았다
  assert.deepEqual(f.run(['status']).missing, ['b-슈퍼감독']);

  const r = f.run(['deliver']);
  assert.deepEqual(r.delivered.map(d => [d.role, d.ok]), [['b-슈퍼감독', true]]);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].role, 'b-슈퍼감독');
  assert.match(f.sent[1].message, /^\[Autopilot\] kyle이 자리를 비웠습니다/);
  assert.match(f.sent[1].message, /단계: Autopilot/);
  assert.match(f.sent[1].message, /kyle 추가 문구: 자리 비움/);
  assert.match(f.sent[1].message, /kyle 채팅 원문\(사람이\(가\) 옮겨 적음\)|\(2\) 어떤 근거로도 하지 않는 것/); // 금지 목록까지 간다
  const status = f.run(['status']);
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.lateDelivered, ['b-슈퍼감독']);
  assert.equal(autopilotState(readLedger(f.home), T0).on, true); // 전달 사건이 켜짐 계산을 깨지 않는다
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.deliveries()[0].onAt, readLedger(f.home).find(e => e.kind === 'autopilot').t);

  // 다시 돌려도 두 번째 전달은 없다.
  const again = f.run(['deliver']);
  assert.deepEqual(again.delivered, []);
  assert.equal(f.sent.length, 2);
  assert.equal(f.deliveries().length, 1);
});

test('1-2. deliver: 꺼져 있으면 거절, 역할 이름을 주면 업무가 없어도 보내고 이미 받았으면 건너뜀, 확실히 안 간 것은 기록하지 않아 다시 시도된다', () => {
  const f = fixture();
  assert.throws(() => f.run(['deliver']), /켜져 있을 때만/);
  f.run(['on', '자리 비움'], {quote: 'kyle 말'});
  assert.throws(() => f.run(['deliver', 'a-작업자']), /슈퍼감독 이름이 아닙니다/);
  const fail = fixture();
  fail.run(['on', '자리 비움'], {quote: 'x'});
  fail.deps.sendMail = () => ({ok: false, delivery: 'not-sent', error: '세션 없음'});
  const r = fail.run(['deliver', 'b-슈퍼감독']);
  assert.deepEqual(r.delivered.map(d => [d.role, d.ok, d.delivery]), [['b-슈퍼감독', false, 'not-sent']]);
  assert.deepEqual(fail.deliveries().map(e => e.delivery), ['not-sent']); // 안 갔으니 받은 것이 아님 → 다시 시도 가능
  fail.deps.sendMail = (role, message) => { fail.sent.push({role, message}); return {ok: true, mailId: 'm'}; };
  assert.equal(fail.run(['deliver', 'b-슈퍼감독']).delivered.length, 1);
  const skipped = fail.run(['deliver', 'b-슈퍼감독']);
  assert.deepEqual([skipped.delivered, skipped.skipped], [[], ['b-슈퍼감독']]);
  // 켜짐을 끄고 다시 켜면 새 켜짐이라 다시 받는다.
  fail.setNow(T0 + 3600_000);
  fail.run(['off']);
  fail.setNow(T0 + 2 * 3600_000);
  fail.run(['on', '다시'], {quote: 'y'});
  assert.equal(fail.run(['deliver', 'b-슈퍼감독']).delivered.length, 1);
});

test('1-3. 첫 안내: 켜짐 중이면 단계·kyle 문구·금지 목록이 붙고 나간 뒤 전달 콜백이 불리며, 꺼짐이면 줄이 없다', () => {
  const f = fixture();
  f.run(['on', '자리 비움'], {level: 'autopilot', quote: '다녀올게'});
  const on = autopilotState(readLedger(f.home), T0).start;
  const text = lateMessage(on, 'c-슈퍼감독');
  const base = {role: 'c-슈퍼감독', session: 'kadan-c-슈퍼감독', roleProfile: 'super', cmd: 'claude', reusing: false, sleep: () => {}, floor: {read: () => 'ready'},
    isCurrent: () => true, log: () => {}};
  const sentMessages = [];
  let called = 0;
  const send = ({message}) => { sentMessages.push(message); return {bytes: message.length, mailId: 'brief-1'}; };
  assert.equal(briefStartedRole({...base, send, autopilot: text, onSent: () => { called++; }}), 'sent');
  assert.equal(called, 1);
  assert.match(sentMessages[0], /카단 슈퍼감독 `c-슈퍼감독`/);
  assert.match(sentMessages[0], /\[Autopilot\] kyle이 자리를 비웠습니다/);
  assert.match(sentMessages[0], /단계: Autopilot/);
  assert.match(sentMessages[0], /kyle 추가 문구: 자리 비움/);
  // 꺼짐(autopilot 인자 없음): 본문에 줄이 없고 콜백도 없다.
  const off = [];
  assert.equal(briefStartedRole({...base, send: ({message}) => { off.push(message); return {bytes: 1, mailId: 'm'}; }, onSent: () => { called++; }}), 'sent');
  assert.equal(called, 1);
  assert.doesNotMatch(off[0], /Autopilot/);
  assert.equal(briefMessage({role: 'c-슈퍼감독', profile: 'super'}), off[0]);
  // 전달 기록이 던져도 start는 성공이다.
  const warns = [];
  assert.equal(briefStartedRole({...base, send, autopilot: text, onSent: () => { throw new Error('기록 실패'); }, warn: l => warns.push(l)}), 'sent');
  assert.match(warns[0], /Autopilot 안내 전달 기록 실패\(기록 실패\)/);
});

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-ap-late-start-'));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin');
  fs.mkdirSync(home); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho ready\nexec sleep 600\n', {mode: 0o755});
  const socket = `kal${process.pid}`;
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, KADAN_HOME: home, KADAN_SOCKET: socket, KADAN_FLOOR: 'tmux',
    KADAN_WINDOW: 'none', KADAN_NOTIFY: 'off', KADAN_START_BRIEF_INTERVAL_MS: '100', KADAN_START_BRIEF_TRIES: '30'};
  delete env.KADAN_ROLE; delete env.TMUX; delete env.TMUX_PANE;
  const kadan = (...args) => spawnSync(process.execPath, [CLI, ...args], {env, encoding: 'utf8', timeout: 60000});
  const tmux = (...args) => spawnSync('tmux', ['-u', '-L', socket, ...args], {encoding: 'utf8'});
  // `autopilot on`은 관계표를 읽어야 슈퍼감독을 정한다: 시험 홈에 표를 하나 올린다(업무는 없어 받는 쪽은 0명).
  const table = path.join(home, 'hierarchy.json');
  fs.writeFileSync(table, JSON.stringify({'x-슈퍼감독': '@user'}));
  appendLedger({kind: 'hierarchy-loaded', path: table, hash: 'x', by: 'watch'}, home);
  console.log(`격리 tmux 소켓: ${socket}`); // kill-server 전에 소켓 이름을 보인다
  t.after(() => tmux('kill-server'));
  return {home, kadan};
}

test('1-4. 격리 tmux: Autopilot 켜짐 중 새 super start는 첫 안내에 켜짐 줄과 전달 사건이 남고, 꺼짐 중이면 줄이 없다', t => {
  if (spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux 없음');
  const w = world(t);
  const off = w.kadan('start', 'late-off-슈퍼감독', '--hidden', '--profile', 'super', '--cmd', 'claude', '--reason', 't');
  assert.equal(off.status, 0, off.stdout + off.stderr);
  const sends = () => readLedger(w.home).filter(e => e.kind === 'send');
  assert.equal(sends().length, 1);
  assert.doesNotMatch(readFirstBody(w.home, sends()[0]), /\[Autopilot\]/);
  assert.equal(readLedger(w.home).filter(e => e.kind === DELIVERY_KIND).length, 0);

  const turnOn = w.kadan('autopilot', 'on', '자리 비움', '--level', 'autopilot', '--quote', '다녀올게');
  assert.equal(turnOn.status, 0, turnOn.stdout + turnOn.stderr);
  const on = w.kadan('start', 'late-on-슈퍼감독', '--hidden', '--profile', 'super', '--cmd', 'claude', '--reason', 't');
  assert.equal(on.status, 0, on.stdout + on.stderr);
  const brief = sends().at(-1);
  assert.equal(brief.role, 'late-on-슈퍼감독');
  const body = readFirstBody(w.home, brief);
  assert.match(body, /\[Autopilot\] kyle이 자리를 비웠습니다/);
  assert.match(body, /단계: Autopilot/);
  assert.match(body, /kyle 추가 문구: 자리 비움/);
  const delivery = readLedger(w.home).filter(e => e.kind === DELIVERY_KIND && e.delivery !== 'reserved');
  assert.equal(delivery.length, 1);
  assert.equal(delivery[0].role, 'late-on-슈퍼감독');
  assert.equal(delivery[0].via, 'start');
  assert.equal(delivery[0].onAt, readLedger(w.home).find(e => e.kind === 'autopilot').t);
  assert.equal(autopilotState(readLedger(w.home), Date.now()).on, true);
  // 같은 켜짐의 status: 첫 안내로 받았으니 missing에 없고, deliver를 해도 두 번째는 안 간다(위 업무가 없어도 받은 역할로 센다)
  const st = JSON.parse(w.kadan('autopilot', 'status').stdout);
  assert.deepEqual([st.on, st.missing, st.lateDelivered], [true, [], ['late-on-슈퍼감독']]);
  assert.equal(w.kadan('autopilot', 'deliver', 'late-on-슈퍼감독').status, 0);
  assert.equal(readLedger(w.home).filter(e => e.kind === DELIVERY_KIND && e.delivery !== 'reserved').length, 1);
  assert.equal(sends().filter(e => e.role === 'late-on-슈퍼감독').length, 1);
});

const readFirstBody = (home, send) => readMailBody(send.digest, home) ?? assert.fail('우편 본문을 못 읽음');

// ---- 3. 역할 세션의 저장소 설정 길 ----
const ROLE = 'a-작업자';
const guardCall = (home, args, flags = {}, env = {KADAN_ROLE: ROLE}) => autopilotGuard({command: 'autopilot', args, flags, home, env});

test('3-1. 켜짐 중 역할 세션의 autopilot repo 쓰기는 --quote가 있을 때만 통과, 없거나 빈 값이면 거절(--quote 안내), 사람은 그대로', () => {
  const f = fixture();
  f.run(['on', '자리 비움'], {quote: 'x'});
  const write = ['repo', 'acme/kadan'];
  for (const flags of [{'deploy-branch': 'main'}, {'deploy-branch': 'main', quote: ''}, {'deploy-branch': 'main', quote: '   '}, {'deploy-branch': 'main', quote: true}])
    assert.throws(() => guardCall(f.home, write, flags), error => error.exitCode === 2 && /--quote/.test(error.message) && /autopilot repo acme\/kadan/.test(error.message), JSON.stringify(flags));
  guardCall(f.home, write, {'deploy-branch': 'main', quote: 'deploy_branch는 main으로 해'}); // 통과
  guardCall(f.home, write, {'deploy-branch': 'main'}, {}); // 사람(역할 없음)
  guardCall(f.home, ['repo', 'list']); // 읽기는 그대로
  // 다른 거절 항목은 --quote로 풀리지 않는다.
  assert.throws(() => autopilotGuard({command: 'restart', args: ['x'], flags: {force: true, quote: 'q'}, home: f.home, env: {KADAN_ROLE: ROLE}}), /restart --force/);
  assert.throws(() => guardCall(f.home, ['wingman', 'a-슈퍼감독'], {quote: 'q'}), /wingman/);
});

test('3-2. 역할 세션 + --quote: 저장되고 원장에 kyle 원문·쓴 역할이 남는다. 사람 쓰기는 원문 칸 없이 그대로', () => {
  const f = fixture();
  const quote = 'kadan 저장소는 main으로 배포 브랜치 걸어줘';
  const out = f.run(['repo', 'acme/kadan'], {'deploy-branch': 'main', quote}, ROLE);
  assert.match(out, /저장: acme\/kadan deployBranch main/);
  assert.equal(readPolicy(f.home).repos['acme/kadan'].deployBranch, 'main');
  assert.equal(readPolicy(f.home).repos['acme/kadan'].by, ROLE);
  const events = readLedger(f.home).filter(e => e.kind === 'autopilot-repo-policy');
  assert.equal(events.length, 1);
  assert.equal(events[0].by, ROLE);
  assert.equal(events[0].quote, quote);
  assert.equal(events[0].viaChat, true);
  assert.equal(evaluateGithub(f.home, 'acme/kadan', {baseBranch: 'main'}).verdict.reason, 'deploy-branch');

  f.run(['repo', 'acme/human'], {'auto-merge': '금지'}, '사람');
  const human = readLedger(f.home).filter(e => e.kind === 'autopilot-repo-policy').at(-1);
  assert.equal(human.by, '사람');
  assert.ok(!('quote' in human) && !('viaChat' in human));
  // 사람이 --quote를 줘도 원문 칸은 만들지 않는다(사람 쓰기는 지금과 같음).
  f.run(['repo', 'acme/human2'], {'auto-merge': '금지', quote: 'q'}, '사람');
  assert.ok(!('quote' in readLedger(f.home).filter(e => e.kind === 'autopilot-repo-policy').at(-1)));
  assert.throws(() => f.run(['repo', 'acme/long'], {'deploy-branch': 'main', quote: 'x'.repeat(4001)}, ROLE), /4000자를 넘습니다/);
});

test('3-3. CLI: 켜짐 중 역할 세션은 --quote 없으면 종료 2·저장 안 됨, 있으면 저장 + 원장에 원문·역할', () => {
  const f = fixture();
  f.run(['on', '자리 비움'], {quote: 'x'});
  const run = argv => spawnSync(process.execPath, [CLI, ...argv], {
    env: {...process.env, KADAN_HOME: f.home, KADAN_WINDOW: 'none', KADAN_ROLE: ROLE}, encoding: 'utf8', timeout: 20_000});
  const denied = run(['autopilot', 'repo', 'acme/kadan', '--deploy-branch', 'main']);
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /--quote "<kyle 원문>"/);
  assert.equal(readPolicy(f.home).repos['acme/kadan'], undefined);
  const ok = run(['autopilot', 'repo', 'acme/kadan', '--deploy-branch', 'main', '--quote', 'main으로 걸어줘']);
  assert.equal(ok.status, 0, ok.stderr);
  const event = readLedger(f.home).filter(e => e.kind === 'autopilot-repo-policy').at(-1);
  assert.deepEqual([event.by, event.quote], [ROLE, 'main으로 걸어줘']);
});

// ---- PR #472 검수 changes 2·3 ----
test('2. 켤 때 첫 전달이 not-sent·unknown인 역할은 받은 것이 아니다: status.missing에 나오고 deliver가 한 번 보낸다', () => {
  for (const delivery of ['not-sent', 'unknown']) {
    const f = fixture();
    f.deps.sendMail = (role, message) => { f.sent.push({role, message}); return {ok: false, delivery, error: '실패'}; };
    f.run(['on', '자리 비움'], {quote: 'x'});
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.run(['status']).missing, ['a-슈퍼감독'], delivery); // 켤 때 실패한 역할이 보인다
    f.deps.sendMail = (role, message) => { f.sent.push({role, message}); return {ok: true, mailId: 'm2'}; };
    assert.deepEqual(f.run(['deliver']).delivered.map(d => [d.role, d.ok]), [['a-슈퍼감독', true]], delivery);
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.run(['status']).missing, []);
    assert.equal(f.run(['deliver']).delivered.length, 0); // 한 번만
    assert.equal(f.sent.length, 2);
  }
  // 켤 때 전달됨(ok)·전달됨 기록 실패(sent)는 받은 것이다
  for (const sentResult of [{ok: true, mailId: 'm'}, {ok: false, delivery: 'sent'}]) {
    const f = fixture();
    f.deps.sendMail = (role, message) => { f.sent.push({role, message}); return sentResult; };
    f.run(['on', '자리 비움'], {quote: 'x'});
    assert.deepEqual(f.run(['status']).missing, [], JSON.stringify(sentResult));
    assert.equal(f.run(['deliver']).delivered.length, 0);
  }
});

test('2b. deliver 결과가 unknown이면 받은 것으로 세지 않아 다시 시도되고, not-sent 뒤 성공하면 받은 것이다(마지막 사건이 이긴다)', () => {
  const f = fixture();
  f.run(['on', '자리 비움'], {quote: 'x'});
  f.deps.sendMail = (role, message) => { f.sent.push({role, message}); return {ok: false, delivery: 'unknown'}; };
  f.run(['deliver', 'b-슈퍼감독']);
  assert.equal(f.run(['deliver', 'b-슈퍼감독']).delivered.length, 1); // unknown은 다시 시도
  f.deps.sendMail = (role, message) => { f.sent.push({role, message}); return {ok: true, mailId: 'm'}; };
  assert.equal(f.run(['deliver', 'b-슈퍼감독']).delivered.length, 1);
  assert.equal(f.run(['deliver', 'b-슈퍼감독']).delivered.length, 0);
  assert.deepEqual(f.run(['status']).lateDelivered, ['b-슈퍼감독']);
});

test('3a. 겹친 deliver: 첫 deliver의 전송 도중(예약 뒤·결과 전) 두 번째가 읽어도 같은 켜짐·같은 역할에는 1건', () => {
  const f = fixture();
  f.run(['on', '자리 비움'], {quote: 'x'}); // b는 켤 때 업무가 없어 받지 못했다
  let inner = null;
  f.deps.sendMail = (role, message) => {
    f.sent.push({role, message});
    if (!inner) { inner = 'ran'; inner = f.run(['deliver', role]); } // 첫 전송 도중에 같은 역할 deliver가 한 번 더 돈다
    return {ok: true, mailId: `m${f.sent.length}`};
  };
  const outer = f.run(['deliver', 'b-슈퍼감독']);
  assert.equal(f.sent.filter(m => m.role === 'b-슈퍼감독').length, 1);
  assert.deepEqual([inner.delivered.length, inner.skipped], [0, ['b-슈퍼감독']]);
  assert.equal(outer.delivered.length, 1);
  assert.equal(f.reservations().length, 1);
  assert.equal(f.deliveries().filter(e => e.role === 'b-슈퍼감독').length, 1);
});

test('3b. 잠금 폴더가 이미 있으면(다른 전달이 예약 중) 보내지 않고 건너뛴다. 잠금은 예약 한 번만 잡고 끝나면 지운다', () => {
  const f = fixture();
  f.run(['on', '자리 비움'], {quote: 'x'});
  f.run(['deliver', 'b-슈퍼감독']);
  assert.ok(!fs.existsSync(path.join(f.home, 'autopilot-delivery.lock'))); // 끝나면 잠금이 없다
  fs.mkdirSync(path.join(f.home, 'autopilot-delivery.lock'));
  const before = f.sent.length;
  // 잠금을 못 얻는 동안(5초 대기) 이미 받은 역할이라 아예 보내지 않는다. 받지 않은 역할은 건너뛴다.
  const r = f.run(['deliver', 'c-슈퍼감독']);
  assert.deepEqual([r.delivered.length, r.skipped], [0, ['c-슈퍼감독']]);
  assert.equal(f.sent.length, before);
  fs.rmdirSync(path.join(f.home, 'autopilot-delivery.lock'));
});

test('3c. 격리 tmux: 같은 켜짐에 같은 이름의 슈퍼감독을 새로 두 번 띄워도 켜짐 안내는 1건(두 번째 첫 안내에는 줄이 없다)', t => {
  if (spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux 없음');
  const w = world(t);
  const turnOn = w.kadan('autopilot', 'on', '자리 비움', '--level', 'autopilot', '--quote', '다녀올게');
  assert.equal(turnOn.status, 0, turnOn.stdout + turnOn.stderr);
  const role = 'dup-슈퍼감독';
  const sends = () => readLedger(w.home).filter(e => e.kind === 'send' && e.role === role);
  const start = () => { const r = w.kadan('start', role, '--hidden', '--profile', 'super', '--cmd', 'claude', '--reason', 't'); assert.equal(r.status, 0, r.stdout + r.stderr); };
  start();
  assert.equal(w.kadan('stop', role).status, 0);
  start(); // 새 세대(이름 재사용)
  const bodies = sends().map(e => readMailBody(e.digest, w.home));
  assert.equal(bodies.length, 2);
  assert.equal(bodies.filter(b => b.includes('[Autopilot] kyle이 자리를 비웠습니다')).length, 1);
  const events = readLedger(w.home).filter(e => e.kind === DELIVERY_KIND && e.role === role);
  assert.deepEqual(events.map(e => e.delivery), ['reserved', 'ok']);
});
