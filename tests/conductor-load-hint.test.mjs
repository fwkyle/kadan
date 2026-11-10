// Why: 슈퍼감독이 일반감독에게 일을 맡기는 순간에 받는 감독의 업무 수가 보여야 한 감독에게 일이 몰리지 않는다.
// 안내는 stderr 한 줄이고, 기존 호출자(stdout 마지막 줄 JSON·종료 코드)를 바꾸면 안 된다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {conductorLoadHint, formatLoadHint, printConductorLoadHint, RECENT_MAIL_FACTOR} from '../src/conductor-load-hint.mjs';
import {readConductorOpenWorks, setConductorOpenWorks, readResourceConfig, DEFAULT_CONFIG} from '../src/heavy-limit.mjs';
import {guardedReason} from '../src/autopilot-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const child = path.join(here, 'helpers/conductor-load-hint-child.mjs');
const cli = path.join(root, 'src/cli.mjs');
const HINT = /받는 감독 /;
const RULE = /기준 도달\([^)]+\): 고칠 파일이 겹치지 않으면 새 감독을 띄워 맡긴다\(kyle 승인 불필요\)/;

function mail(scenario) {
  const out = spawnSync(process.execPath, [child, root, JSON.stringify(scenario)], {encoding: 'utf8', timeout: 60_000});
  return {status: out.status, stdout: out.stdout.trim().split('\n'), stderr: out.stderr.trim().split('\n').filter(Boolean)};
}
// 슈퍼 lh-슈퍼가 일반감독 lh-감독에게 맡기는 기본 경우. 업무 수만 바꿔 쓴다.
const base = (works, extra = {}) => ({
  sender: 'lh-슈퍼', roles: [['lh-슈퍼', 'super'], ['lh-감독', 'conductor']], argv: ['lh-감독', '새 일 맥락'],
  works: works.map((status, i) => [`r/w${i + 1}`, 'lh-감독', status]), ...extra,
});
const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'load-hint-set-'));

test('슈퍼 → 일반감독 새 우편: 영수증 뒤 stderr 마지막 줄에 업무 수가 나오고, 기준 미만이면 문장이 없다', () => {
  const r = mail(base(['open', 'open', 'hold']));
  assert.equal(r.status, 0, r.stderr.join('\n'));
  assert.match(r.stdout[0], /^키 전송됨|^전달됨/);
  assert.equal(r.stdout.length, 1);
  const hint = r.stderr.at(-1);
  assert.match(hint, /받는 감독 lh-감독: 진행 중 업무 2건\(r\/w1, r\/w2\) · 보류 1건 · 최근 24시간 슈퍼감독이 맡긴 새 우편 1통\(이번 포함\)$/);
  assert.doesNotMatch(hint, RULE);
});

test('기준(기본 3) 이상이면 같은 줄에 규칙 문장이 붙고, 업무가 많으면 앞 3개와 "외 N건"으로 줄인다', () => {
  const three = mail(base(['open', 'open', 'open']));
  assert.match(three.stderr.at(-1), /진행 중 업무 3건\(r\/w1, r\/w2, r\/w3\)/);
  assert.match(three.stderr.at(-1), /기준 도달\(진행 중 업무 3건 ≥ 기준 3개\)/);
  assert.match(three.stderr.at(-1), RULE);
  const five = mail(base(['open', 'open', 'open', 'open', 'open']));
  assert.match(five.stderr.at(-1), /진행 중 업무 5건\(r\/w1, r\/w2, r\/w3 외 2건\)/);
  assert.equal(five.stderr.filter(line => HINT.test(line)).length, 1);
});

test('기준 설정: 바꾼 값이 적용되고, 0이면 문장만 빠지고 수는 남으며, 깨진 파일은 기본 3으로 읽는다', () => {
  const raised = mail(base(['open', 'open', 'open'], {limitsFile: '{"conductorOpenWorks":5}'}));
  assert.match(raised.stderr.at(-1), /진행 중 업무 3건/);
  assert.doesNotMatch(raised.stderr.at(-1), RULE);
  const lowered = mail(base(['open', 'open'], {limitsFile: '{"conductorOpenWorks":2}'}));
  assert.match(lowered.stderr.at(-1), /기준 도달\(진행 중 업무 2건 ≥ 기준 2개\)/);
  const off = mail(base(['open', 'open', 'open', 'open'], {limitsFile: '{"conductorOpenWorks":0}'}));
  assert.match(off.stderr.at(-1), /진행 중 업무 4건/);
  assert.doesNotMatch(off.stderr.at(-1), RULE);
  const broken = mail(base(['open', 'open', 'open'], {limitsFile: '{깨진'}));
  assert.equal(broken.status, 0);
  assert.match(broken.stderr.at(-1), /기준 도달\(진행 중 업무 3건 ≥ 기준 3개\)/);
});

test('보관 경로(바로 넣지 못함)에서도 나오고, stdout 마지막 줄은 보관 영수증 JSON 그대로다', () => {
  const r = mail(base(['open', 'open', 'open'], {roles: [['lh-슈퍼', 'super'], ['lh-감독', 'conductor', false]]}));
  assert.equal(r.status, 0, r.stderr.join('\n'));
  const receipt = JSON.parse(r.stdout.at(-1));
  assert.equal(receipt.status, 'stored');
  assert.ok(receipt.mailId);
  assert.match(r.stderr[0], /바로 넣지 못해 보관했습니다/);
  assert.match(r.stderr.at(-1), /받는 감독 lh-감독: 진행 중 업무 3건/);
  assert.match(r.stderr.at(-1), RULE);
});

test('안내가 나오지 않는 우편: 답장·--raw·발령·슈퍼가 아닌 발신자·일반감독이 아닌 수신자', () => {
  const works = [['r/w1', 'lh-감독'], ['r/w2', 'lh-감독'], ['r/w3', 'lh-감독']];
  const roles = [['lh-슈퍼', 'super'], ['lh-감독', 'conductor'], ['lh-작업자', 'worker'], ['lh-슈퍼2', 'super']];
  const cases = {
    '--raw': {sender: 'lh-슈퍼', argv: ['lh-감독', '원문'], flags: {raw: true}},
    '슈퍼가 아닌 발신자(작업자)': {sender: 'lh-작업자', argv: ['lh-감독', '완료 통지']},
    '사람 발신': {sender: '', argv: ['lh-감독', '사람 편지']},
    '받는 쪽이 작업자': {sender: 'lh-슈퍼', argv: ['lh-작업자', '확인']},
    '받는 쪽이 다른 슈퍼감독': {sender: 'lh-슈퍼', argv: ['lh-슈퍼2', '요청']},
    '일반감독이 일반감독에게': {sender: 'lh-감독', argv: ['lh-감독2', '협의'], roles: [...roles, ['lh-감독2', 'conductor']]},
  };
  for (const [name, extra] of Object.entries(cases)) {
    const r = mail({roles, works, ...extra});
    assert.equal(r.status, 0, `${name}: ${r.stderr.join('\n')}`);
    assert.equal(r.stderr.filter(line => HINT.test(line)).length, 0, `${name}: ${r.stderr.join('\n')}`);
  }
  // 답장: 일반감독이 먼저 물은 질문에 슈퍼가 답한다. 새로 맡기는 우편이 아니다.
  const asked = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const reply = mail({sender: 'lh-슈퍼', roles, works, argv: ['lh-감독', '답'], flags: {'reply-to': asked},
    ledger: [{kind: 'send', role: 'lh-슈퍼', session: 'kadan-lh-슈퍼', by: 'lh-감독', mailId: asked, expectReply: true}]});
  assert.equal(reply.status, 0, reply.stderr.join('\n'));
  assert.equal(reply.stderr.filter(line => HINT.test(line)).length, 0, reply.stderr.join('\n'));
});

test('발령(dispatch --task)은 실패하든 성공하든 안내를 내지 않는다', () => {
  const r = mail({...base(['open', 'open', 'open']), command: 'cmdDispatch', flags: {task: 'card-x'}, argv: ['lh-감독', '발령']});
  assert.equal(r.stderr.filter(line => HINT.test(line)).length, 0, r.stderr.join('\n'));
});

test('kadan send의 같은 경로에서도 나온다', () => {
  const r = mail({...base(['open', 'open', 'open']), command: 'cmdSend'});
  assert.equal(r.status, 0, r.stderr.join('\n'));
  assert.match(r.stderr.at(-1), RULE);
});

test('인계된 업무는 이어받은 감독으로 센다', () => {
  const scenario = {
    sender: 'lh-슈퍼', roles: [['lh-슈퍼', 'super'], ['lh-감독', 'conductor'], ['lh-감독2', 'conductor']],
    works: [['r/w1', 'lh-감독'], ['r/w2', 'lh-감독'], ['r/w3', 'lh-감독2']],
    ledger: [{kind: 'handover', phase: 'transferred', from: 'lh-감독', to: 'lh-감독2', t: new Date(Date.now() + 1000).toISOString()}],
  };
  const heir = mail({...scenario, argv: ['lh-감독2', '새 일']});
  assert.match(heir.stderr.at(-1), /받는 감독 lh-감독2: 진행 중 업무 3건/);
  const old = mail({...scenario, argv: ['lh-감독', '새 일']});
  assert.match(old.stderr.at(-1), /받는 감독 lh-감독: 진행 중 업무 0건 · 보류 0건/);
});

test('최근 24시간 새 우편 수: 슈퍼가 맡긴 새 우편만 세고 답장·발령·알림·작업자 통지·하루 지난 것은 뺀다', () => {
  const r = mail(base(['open'], {
    roles: [['lh-슈퍼', 'super'], ['lh-감독', 'conductor'], ['lh-작업자', 'worker']],
    mails: [
      ['lh-감독', 'lh-슈퍼', 1], ['lh-감독', 'lh-슈퍼', 5], ['lh-감독', 'lh-슈퍼', 23],
      ['lh-감독', 'lh-슈퍼', 30],
      ['lh-감독', 'lh-슈퍼', 2, {replyTo: 'x'}],
      ['lh-감독', 'lh-슈퍼', 2, {taskId: 'card-y'}],
      ['lh-감독', 'lh-슈퍼', 2, {notificationOnly: true}],
      ['lh-감독', 'lh-작업자', 2],
      ['lh-작업자', 'lh-슈퍼', 2],
    ],
  }));
  assert.match(r.stderr.at(-1), /새 우편 4통\(이번 포함\)/);
});

test('업무 조회가 던져도 전송 결과·종료 코드·stdout은 그대로이고 안내만 빠진다', () => {
  const ok = mail(base(['open', 'open', 'open']));
  const broken = mail(base(['open', 'open', 'open'], {corruptWork: true}));
  assert.equal(broken.status, 0, broken.stderr.join('\n'));
  assert.equal(broken.stdout.length, ok.stdout.length);
  assert.match(broken.stdout[0], /^키 전송됨|^전달됨/);
  assert.equal(broken.stderr.filter(line => HINT.test(line)).length, 0);
  const stored = mail(base(['open'], {corruptWork: true, roles: [['lh-슈퍼', 'super'], ['lh-감독', 'conductor', false]]}));
  assert.equal(stored.status, 0, stored.stderr.join('\n'));
  assert.equal(JSON.parse(stored.stdout.at(-1)).status, 'stored');
  assert.equal(stored.stderr.filter(line => HINT.test(line)).length, 0);
});

test('전송 실패의 종료 코드(KADAN_MAIL_DELIVERY_EXIT)는 안내와 무관하게 그대로다', () => {
  // 바닥이 던진 실패는 전달 불명확(5)이다. 업무가 쌓인 일반감독 앞이어도 코드는 같고 안내는 나오지 않는다.
  const r = mail(base(['open', 'open', 'open'], {floorThrows: 'unknown', deliveryExit: true}));
  assert.equal(r.status, 5, r.stderr.join('\n'));
  assert.equal(r.stderr.filter(line => HINT.test(line)).length, 0);
  const plain = mail(base(['open', 'open', 'open'], {floorThrows: 'unknown'}));
  assert.equal(plain.status, 1, plain.stderr.join('\n'));
});

test('조건에 안 맞는 우편은 업무 목록을 읽지 않는다', () => {
  let reads = 0;
  const readWorks = () => { reads++; return []; };
  const entries = [
    {kind: 'start', role: 'lh-슈퍼', roleProfile: 'super'}, {kind: 'start', role: 'lh-감독', roleProfile: 'conductor'},
    {kind: 'start', role: 'lh-작업자', roleProfile: 'worker'},
  ];
  const call = input => conductorLoadHint({home: '/nonexistent', entries, newContext: true, readWorks, ...input});
  assert.equal(call({by: 'lh-작업자', recipient: 'lh-감독'}), null);
  assert.equal(call({by: 'lh-슈퍼', recipient: 'lh-작업자'}), null);
  assert.equal(call({by: 'lh-슈퍼', recipient: 'lh-감독', newContext: false}), null);
  assert.equal(call({by: '사람', recipient: 'lh-감독'}), null);
  assert.equal(reads, 0);
  assert.match(call({by: 'lh-슈퍼', recipient: 'lh-감독'}), /진행 중 업무 0건/);
  assert.equal(reads, 1);
});

test('시작 프로필 기록이 없는 수신자는 이번 전송이 정한 프로필을 쓴다', () => {
  const entries = [{kind: 'start', role: 'lh-슈퍼', roleProfile: 'super'}, {kind: 'start', role: 'lh-옛감독'}];
  const call = receiptProfile => conductorLoadHint({home: '/nonexistent', entries, newContext: true, readWorks: () => [],
    by: 'lh-슈퍼', recipient: 'lh-옛감독', receiptProfile});
  assert.match(call('conductor'), /받는 감독 lh-옛감독/);
  assert.equal(call('worker'), null);
});

test('안내 출력 함수는 던지지 않는다', () => {
  const lines = [];
  printConductorLoadHint({home: '/nonexistent', entries: [{kind: 'start', role: 'a', roleProfile: 'super'},
    {kind: 'start', role: 'b', roleProfile: 'conductor'}], by: 'a', recipient: 'b', newContext: true,
    readWorks: () => { throw new Error('조회 실패'); }}, line => lines.push(line));
  assert.deepEqual(lines, []);
});

test('기준 문장의 두 조건: 진행 중 업무 수 ≥ 기준 또는 최근 새 우편 수 ≥ 기준의 2배, 어느 쪽인지 문장에 적힌다', () => {
  const line = (open, recentMails, threshold = 3) => formatLoadHint({recipient: 'x-감독', hold: 0, recentMails, threshold,
    open: Array.from({length: open}, (_, i) => `r/w${i + 1}`)});
  // 진행 중 2·새 우편 12: 우편 수로 붙는다.
  assert.match(line(2, 12), /기준 도달\(최근 새 우편 12통 ≥ 기준의 2배 6통\): 고칠 파일이/);
  assert.doesNotMatch(line(2, 12), /진행 중 업무 2건 ≥/);
  // 진행 중 2·새 우편 5: 없다. 6통부터 붙는다.
  assert.doesNotMatch(line(2, 5), RULE);
  assert.match(line(2, 6), RULE);
  // 진행 중 3·새 우편 1: 업무 수로 붙는다.
  assert.match(line(3, 1), /기준 도달\(진행 중 업무 3건 ≥ 기준 3개\): 고칠 파일이/);
  // 둘 다면 둘 다 적힌다.
  assert.match(line(4, 9), /기준 도달\(진행 중 업무 4건 ≥ 기준 3개, 최근 새 우편 9통 ≥ 기준의 2배 6통\)/);
  // 기준 0이면 두 조건 모두 문장이 없고 수는 남는다.
  assert.doesNotMatch(line(9, 99, 0), RULE);
  assert.match(line(9, 99, 0), /진행 중 업무 9건.*새 우편 99통/);
  // 기준 5면 우편 10통부터.
  assert.doesNotMatch(line(1, 9, 5), RULE);
  assert.match(line(1, 10, 5), /최근 새 우편 10통 ≥ 기준의 2배 10통/);
  assert.equal(RECENT_MAIL_FACTOR, 2);
});

test('실제 전송: 진행 중 업무가 기준 미만이어도 최근 24시간에 맡긴 새 우편이 기준의 2배면 문장이 붙는다', () => {
  const mails = n => Array.from({length: n}, (_, i) => ['lh-감독', 'lh-슈퍼', i + 1]);
  const piled = mail(base(['open', 'open', 'hold'], {mails: mails(5)}));
  assert.match(piled.stderr.at(-1), /진행 중 업무 2건.*새 우편 6통\(이번 포함\) — 기준 도달\(최근 새 우편 6통 ≥ 기준의 2배 6통\)/);
  const under = mail(base(['open', 'open', 'hold'], {mails: mails(4)}));
  assert.match(under.stderr.at(-1), /새 우편 5통\(이번 포함\)$/);
  const off = mail(base(['open', 'open'], {mails: mails(8), limitsFile: '{"conductorOpenWorks":0}'}));
  assert.doesNotMatch(off.stderr.at(-1), RULE);
  assert.match(off.stderr.at(-1), /새 우편 9통/);
});

test('슈퍼감독이 일반감독에게 보내는 질문(--expect-reply)에도 안내가 나온다', () => {
  const r = mail(base(['open', 'open', 'open'], {flags: {'expect-reply': true}}));
  assert.equal(r.status, 0, r.stderr.join('\n'));
  assert.match(r.stderr.at(-1), RULE);
});

test('한 줄 문장: 줄바꿈이 없고 0건이면 이름 괄호를 붙이지 않는다', () => {
  const line = formatLoadHint({recipient: 'x-감독', open: [], hold: 2, recentMails: 1, threshold: 3});
  assert.equal(line, '받는 감독 x-감독: 진행 중 업무 0건 · 보류 2건 · 최근 24시간 슈퍼감독이 맡긴 새 우편 1통(이번 포함)');
  assert.doesNotMatch(formatLoadHint({recipient: 'x', open: ['a', 'b', 'c', 'd'], hold: 0, recentMails: 9, threshold: 3}), /\n/);
});

test('limit set conductor-works: 다른 키를 보존하고, 파일이 없으면 새로 만들고, 깨진 파일은 덮어쓰지 않는다', () => {
  const home = freshHome(), file = path.join(home, 'resource-limits.json');
  assert.equal(readConductorOpenWorks(home), 3);
  setConductorOpenWorks(home, '5');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {conductorOpenWorks: 5});
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, JSON.stringify({reviewSlots: 6, limits: {rust: 2}, 모르는키: {a: 1}}));
  setConductorOpenWorks(home, '0');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {reviewSlots: 6, limits: {rust: 2}, 모르는키: {a: 1}, conductorOpenWorks: 0});
  assert.equal(readConductorOpenWorks(home), 0);
  fs.writeFileSync(file, '{깨진');
  assert.throws(() => setConductorOpenWorks(home, '4'), /읽지 못해 쓰지 않았다/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{깨진');
  assert.equal(readConductorOpenWorks(home), 3);
  for (const bad of ['{"conductorOpenWorks":-1}', '{"conductorOpenWorks":"4"}', '{"conductorOpenWorks":1.5}', '[]']) {
    fs.writeFileSync(file, bad);
    assert.equal(readConductorOpenWorks(home), 3, bad);
  }
});

test('이 키가 있어도 같은 파일을 읽는 검수 자리·동시 개수 읽기 결과는 그대로다', () => {
  const home = freshHome(), file = path.join(home, 'resource-limits.json');
  assert.deepEqual(readResourceConfig(home), DEFAULT_CONFIG);
  setConductorOpenWorks(home, '7');
  const {conductorOpenWorks, ...rest} = readResourceConfig(home);
  assert.equal(conductorOpenWorks, 7);
  assert.deepEqual(rest, DEFAULT_CONFIG);
  fs.writeFileSync(file, JSON.stringify({reviewSlots: 2, leaseMaxHours: 5, limits: {build: 4}}));
  const before = readResourceConfig(home);
  setConductorOpenWorks(home, '1');
  const {conductorOpenWorks: now, ...after} = readResourceConfig(home);
  assert.equal(now, 1);
  assert.deepEqual(after, before);
});

test('CLI: limit set은 0 이상의 정수만 받고 그 밖은 종료 코드 2, status가 현재 값을 보이며, limit run은 그대로 돈다', () => {
  const home = freshHome();
  const run = (...args) => spawnSync(process.execPath, [cli, 'limit', ...args], {env: {...process.env, KADAN_HOME: home}, encoding: 'utf8', timeout: 30_000});
  assert.equal(JSON.parse(run('status').stdout).conductorOpenWorks, 3);
  for (const bad of [['set', 'conductor-works', 'abc'], ['set', 'conductor-works', '1.5'], ['set', 'conductor-works', '-1'],
    ['set', 'conductor-works'], ['set', 'other', '3'], ['set', 'conductor-works', '3', '4']]) {
    const r = run(...bad);
    assert.equal(r.status, 2, `${bad.join(' ')}: ${r.stderr}`);
  }
  assert.equal(fs.existsSync(path.join(home, 'resource-limits.json')), false);
  const set = run('set', 'conductor-works', '4');
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout), {conductorOpenWorks: 4});
  const status = JSON.parse(run('status').stdout);
  assert.equal(status.conductorOpenWorks, 4);
  assert.deepEqual(status.limits, {rust: 1, install: 2, build: 2});
  const ran = run('run', 'build', '--', process.execPath, '-e', 'console.log("ran")');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /ran/);
});

test('Autopilot 거절 목록: limit set만 거절 대상이고 run·status는 아니다', () => {
  assert.equal(guardedReason('limit', ['set', 'conductor-works', '3'], {}), 'limit set');
  assert.equal(guardedReason('limit', ['status'], {}), null);
  assert.equal(guardedReason('limit', ['run', 'build', '--', 'npm', 'test'], {}), null);
  assert.equal(guardedReason('limit', [], {}), null);
});
