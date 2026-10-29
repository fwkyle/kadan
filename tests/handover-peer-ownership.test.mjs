import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cmdMail} from '../src/commands/send.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {Mailbox} from '../src/mailbox.mjs';
import {floor} from '../src/floor.mjs';

// 인계 전 질문에 답할 때 주소·PID·슈퍼 관계를 독립적으로 대조한다.
for (const profile of ['super', 'worker']) {
  for (const pid of ['11', null]) {
    for (const address of ['old-owner', 'next-owner']) {
      test(`인계 답장: ${profile}, PID ${pid}, 주소 ${address}`, () => {
        const env = {...process.env}, exit = process.exit;
        const saved = {alive: floor.alive, pid: floor.pid, send: floor.send};
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-peer-'));
        Object.assign(process.env, {KADAN_HOME: home, KADAN_ROLE: 'reply-owner', KADAN_NOTIFY: 'off'});
        for (const role of ['old-owner', 'next-owner', 'reply-owner']) {
          appendLedger({kind: 'start', role, session: `kadan-${role}`, roleProfile: profile,
            panePid: role === 'next-owner' ? pid : '11'}, home);
        }
        const mailbox = new Mailbox(home, 'reply-owner');
        const question = mailbox.send({by: 'old-owner', message: '질문', expectReply: true});
        appendLedger({kind: 'handover', phase: 'transferred', from: 'old-owner', to: 'next-owner',
          handoverId: 'fixture-transfer', taskIds: []}, home);
        let sends = 0, error;
        floor.alive = () => true;
        floor.pid = () => '11';
        floor.send = () => { sends++; return {keyDelivery: 'sent'}; };
        process.exit = code => { throw new Error(`fixture exit ${code}`); };
        try {
          try {
            cmdMail([address, '최종 답변'], {'reply-to': question.mailId, 'reply-final': true});
          } catch (caught) { error = caught; }
          const reply = readLedger(home).find(e => e.kind === 'send' && e.replyTo === question.mailId);
          const rejected = profile === 'worker' && pid === null && address === 'old-owner';
          assert.equal(Boolean(error), rejected);
          assert.equal(Boolean(reply), !rejected);
          assert.equal(mailbox.read(question.mailId).replyStatus, rejected ? 'waiting' : 'answered');
          assert.equal(sends, pid ? 1 : 0);
          if (reply) {
            assert.equal(reply.role, 'next-owner');
            if (!pid) assert.equal(reply.transport, 'mailbox');
          }
        } finally {
          Object.assign(floor, saved);
          process.exit = exit;
          for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
          Object.assign(process.env, env);
        }
      });
    }
  }
}
