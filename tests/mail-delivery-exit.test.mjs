import "./helpers/isolated-home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger} from '../src/ledger.mjs';
import {
  MAIL_DELIVERY_EXIT_ENV, MAIL_EXIT_SENT, MAIL_EXIT_UNKNOWN, mailFailureExitCode, mailDeliveryOf,
} from '../src/mail-delivery-exit.mjs';
import {sendAutopilotMail} from '../src/autopilot.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const ON = {[MAIL_DELIVERY_EXIT_ENV]: '1'};

test('mailFailureExitCode: 켠 쪽만 sent=4·unknown=5, 나머지와 켜지 않은 호출자는 예전 그대로', () => {
  const sent = Object.assign(new Error('x'), {delivery: 'sent'});
  const unknown = Object.assign(new Error('x'), {delivery: 'unknown'});
  const notSent = Object.assign(new Error('x'), {delivery: 'not-sent'});
  const plain = new Error('x');
  const two = Object.assign(new Error('x'), {exitCode: 2});
  assert.deepEqual([sent, unknown, notSent, plain, two].map(e => mailFailureExitCode(e, ON)), [MAIL_EXIT_SENT, MAIL_EXIT_UNKNOWN, 1, 1, 2]);
  assert.deepEqual([sent, unknown, notSent, plain, two].map(e => mailFailureExitCode(e, {})), [1, 1, 1, 1, 2]);
});

test('mailDeliveryOf: 종료 코드만 본다 — 0 ok, 1 not-sent, 4 sent, 5·모르는 코드·시간 초과·신호는 unknown', () => {
  assert.equal(mailDeliveryOf({status: 0}), 'ok');
  assert.equal(mailDeliveryOf({status: 1, stderr: '전달은 됐지만 기록 반영 실패'}), 'not-sent', '문구는 보지 않는다');
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
    [{status: 1, stderr: 'c'}, 'not-sent'], [{status: null, error: new Error('spawnSync ETIMEDOUT')}, 'unknown']]) {
    const r = sendAutopilotMail('/h', 'kadan-x', fake(result))('a-슈퍼감독', '본문');
    assert.equal(r.ok, false);
    assert.equal(r.delivery, delivery);
  }
});

test('CLI: 세션이 없는 역할에 mail — 붙여넣기 전 실패라 켜도 안 켜도 종료 코드 1(다른 호출자 동작 그대로)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-mail-exit-'));
  // 시작 기록(PID 포함)은 있지만 격리 tmux에 세션은 없다 → 세션 없음(not-sent).
  appendLedger({kind: 'start', role: 'zz-슈퍼감독', session: 'kadan-zz-슈퍼감독', panePid: 999999, roleProfile: 'super'}, home);
  const base = {...process.env, KADAN_HOME: home, KADAN_WINDOW: 'none'};
  delete base.KADAN_ROLE;
  for (const env of [base, {...base, ...ON}]) {
    const r = spawnSync(process.execPath, [CLI, 'mail', 'zz-슈퍼감독', '--raw', '안녕'], {env, encoding: 'utf8', timeout: 20_000});
    assert.equal(r.status, 1, r.stderr);
  }
});
