import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger} from '../src/ledger.mjs';
import {
  MAIL_DELIVERY_EXIT_ENV, MAIL_EXIT_NOT_SENT, MAIL_EXIT_SENT, MAIL_EXIT_UNKNOWN, mailFailureExitCode, mailDeliveryOf,
} from '../src/mail-delivery-exit.mjs';
import {sendAutopilotMail} from '../src/autopilot.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const ON = {[MAIL_DELIVERY_EXIT_ENV]: '1'};

test('mailFailureExitCode: 켠 쪽만 not-sent=3·sent=4·unknown=5, 표시 없는 실패는 전송 전이면 3·뒤면 5, 켜지 않은 호출자는 예전 그대로', () => {
  const sent = Object.assign(new Error('x'), {delivery: 'sent'});
  const unknown = Object.assign(new Error('x'), {delivery: 'unknown'});
  const notSent = Object.assign(new Error('x'), {delivery: 'not-sent'});
  const plain = new Error('x');
  const two = Object.assign(new Error('x'), {exitCode: 2});
  const all = [sent, unknown, notSent, plain, two];
  // 전송 함수를 부른 뒤(기본): 표시 없는 실패는 붙여넣기 뒤일 수 있어 불명확이다.
  assert.deepEqual(all.map(e => mailFailureExitCode(e, ON)), [MAIL_EXIT_SENT, MAIL_EXIT_UNKNOWN, MAIL_EXIT_NOT_SENT, MAIL_EXIT_UNKNOWN, MAIL_EXIT_UNKNOWN]);
  // 전송 함수를 부르기 전: 표시 없는 실패는 위치상 안 감이다. 표시가 있으면 표시를 따른다.
  assert.deepEqual(all.map(e => mailFailureExitCode(e, ON, {beforeSend: true})), [MAIL_EXIT_SENT, MAIL_EXIT_UNKNOWN, MAIL_EXIT_NOT_SENT, MAIL_EXIT_NOT_SENT, MAIL_EXIT_NOT_SENT]);
  for (const beforeSend of [false, true]) assert.deepEqual(all.map(e => mailFailureExitCode(e, {}, {beforeSend})), [1, 1, 1, 1, 2]);
});

test('mailDeliveryOf: 종료 코드만 본다 — 0 ok, 3 not-sent, 4 sent, 1·5·모르는 코드·시간 초과·신호는 unknown', () => {
  assert.equal(mailDeliveryOf({status: 0}), 'ok');
  assert.equal(mailDeliveryOf({status: MAIL_EXIT_NOT_SENT, stderr: '전달은 됐지만 기록 반영 실패'}), 'not-sent', '문구는 보지 않는다');
  assert.equal(mailDeliveryOf({status: 1, stderr: '세션 없음'}), 'unknown', '일반 오류 1은 붙여넣기 뒤일 수 있다');
  assert.equal(mailDeliveryOf({status: MAIL_EXIT_SENT}), 'sent');
  assert.equal(mailDeliveryOf({status: MAIL_EXIT_UNKNOWN}), 'unknown');
  assert.equal(mailDeliveryOf({status: 7}), 'unknown');
  assert.equal(mailDeliveryOf({status: null, error: Object.assign(new Error('spawnSync ETIMEDOUT'), {code: 'ETIMEDOUT'})}), 'unknown');
  assert.equal(mailDeliveryOf({status: null, signal: 'SIGTERM'}), 'unknown');
});

test('sendAutopilotMail: 자식에 켜짐 환경변수를 주고, 결과를 delivery로 돌려준다', () => {
  const calls = [];
  const fake = result => (cmd, args, opts) => { calls.push({args, env: opts.env}); return result; };
  const ok = sendAutopilotMail('/h', 'kadan-x', fake({status: 0, stdout: '{"mailId":"m1"}\n'}))('a-슈퍼감독', '본문');
  assert.deepEqual(ok, {ok: true, mailId: 'm1'});
  assert.equal(calls[0].env[MAIL_DELIVERY_EXIT_ENV], '1');
  assert.deepEqual(calls[0].args.slice(1), ['mail', 'a-슈퍼감독', '본문']);
  for (const [result, delivery] of [[{status: MAIL_EXIT_SENT, stderr: 'a'}, 'sent'], [{status: MAIL_EXIT_UNKNOWN, stderr: 'b'}, 'unknown'],
    [{status: MAIL_EXIT_NOT_SENT, stderr: 'c'}, 'not-sent'], [{status: 1, stderr: 'd'}, 'unknown'], [{status: null, error: new Error('spawnSync ETIMEDOUT')}, 'unknown']]) {
    const r = sendAutopilotMail('/h', 'kadan-x', fake(result))('a-슈퍼감독', '본문');
    assert.equal(r.ok, false);
    assert.equal(r.delivery, delivery);
  }
});

test('CLI: 세션이 없는 역할에 mail — 안 켜면 종료 코드 1(다른 호출자 그대로), 켜면 확실히 안 감 3', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mail-exit-'));
  // 시작 기록(PID 포함)은 있지만 격리 tmux에 세션은 없다 → 세션 없음(not-sent).
  appendLedger({kind: 'start', role: 'zz-슈퍼감독', session: 'kadan-zz-슈퍼감독', panePid: 999999, roleProfile: 'super'}, home);
  const base = {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none'};
  delete base.KADAN_ROLE;
  for (const [env, code] of [[base, 1], [{...base, ...ON}, MAIL_EXIT_NOT_SENT]]) {
    const r = spawnSync(process.execPath, [CLI, 'mail', 'zz-슈퍼감독', '--raw', '안녕'], {env, encoding: 'utf8', timeout: 20_000});
    assert.equal(r.status, code, r.stderr);
  }
  // 전송 함수를 부르기 전의 실패(모르는 역할, --raw라 보관 불가)도 켜면 3이다.
  const unknownRole = spawnSync(process.execPath, [CLI, 'mail', 'nobody-슈퍼감독', '--raw', '안녕'], {env: {...base, ...ON}, encoding: 'utf8', timeout: 20_000});
  assert.equal(unknownRole.status, MAIL_EXIT_NOT_SENT, unknownRole.stderr);
});
