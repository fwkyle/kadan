import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {WatchReports} from '../src/watch-report.mjs';

function fixture(backend) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'held-'));
  if (backend === 'sqlite') {
    createDatabase(home);
    writeStorageMarker(home, 'sqlite');
  }
  const parents = new Map([['a', '@user'], ['b', '@user']]);
  appendLedger({kind: 'start', role: 'b', session: 'kadan-b', panePid: 1}, home);
  appendLedger({kind: 'send', role: 'b', by: 'a', mailId: 'q',
    expectReply: true, transport: 'mailbox'}, home);
  const f = {home, parents, held: true, sent: []};
  const options = {home, readCards: () => [], readWorks: () => [],
    floor: {list: () => [{session: 'kadan-b', pid: 1}]},
    send: (role, message) => {
      if (f.held) throw Object.assign(new Error('입력 중'), {
        code: 'KADAN_PANE_INPUT_PENDING', delivery: 'not-sent',
      });
      f.sent.push({role, message});
    }};
  f.reports = new WatchReports(options);
  f.submit = (verdict, reason) => f.reports.submit(f.reports.request({
    source: 'supervisor-health', role: 'b', parents,
  }).requestId, verdict, reason);
  f.restart = () => { f.reports = new WatchReports(options); };
  f.rows = () => readLedger(home);
  return f;
}

for (const backend of ['jsonl', 'sqlite']) {
  for (const latestHeld of [true, false]) {
    test(`${backend}: 회복 뒤 재발하면 옛 보류 알림은 취소하고 최신 알림만 전달한다 (${latestHeld})`, () => {
      const f = fixture(backend);
      const old = f.submit('응답장애', 'OLD_OBSOLETE');
      f.submit('진행중', '정상 회복');
      f.held = latestHeld;
      const latest = f.submit('응답장애', 'LATEST');
      assert.equal(latest.notify, true);
      // 감시 재시작과 오래된 순회 스냅샷으로도 취소·전송을 반복하지 않는다.
      const snapshot = f.rows();
      f.held = false;
      f.restart();
      f.reports.retryHeld(snapshot, f.parents);
      f.reports.retryHeld(snapshot, f.parents);
      f.reports.retryHeld(f.rows(), f.parents);
      assert.equal(f.sent.length, 1);
      assert.match(f.sent[0].message, /LATEST/);
      assert.doesNotMatch(f.sent[0].message, /OLD_OBSOLETE/);
      const delivery = f.reports.receipt(old.requestId).delivery;
      assert.equal(delivery.delivery, 'cancelled');
      assert.equal(delivery.held, false);
      assert.equal(f.reports.receipt(latest.requestId).delivery.delivery, 'sent');
      assert.equal(f.rows().filter(e => e.kind === 'watch-ai-delivery'
        && e.requestId === old.requestId && e.delivery === 'cancelled').length, 1);
    });
  }

  test(`${backend}: 같은 문제의 반복 보고는 보류한 최초 알림을 잃지 않고 한 번만 전달한다`, () => {
    const f = fixture(backend);
    const first = f.submit('응답장애', '계속된 동일 문제');
    assert.equal(f.submit('응답장애', '같은 상태 재확인').notify, false);
    f.held = false;
    f.restart();
    f.reports.retryHeld(f.rows(), f.parents);
    f.reports.retryHeld(f.rows(), f.parents);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].message, /계속된 동일 문제/);
    assert.equal(f.reports.receipt(first.requestId).delivery.delivery, 'sent');
  });

  for (const ending of ['final', 'cancel']) {
    test(`${backend}: 질문 ${ending} 뒤 보류한 감독 알림은 전송하지 않는다`, () => {
      const f = fixture(backend);
      const old = f.submit('응답장애', '종료된 질문의 보류 알림');
      appendLedger(ending === 'final'
        ? {kind: 'send', by: 'b', role: 'a', mailId: 'answer', replyTo: 'q', replyFinal: true}
        : {kind: 'mail-cancel', by: 'a', role: 'b', mailId: 'q'}, f.home);
      f.held = false;
      f.reports.retryHeld(f.rows(), f.parents);
      f.reports.retryHeld(f.rows(), f.parents);
      assert.deepEqual(f.sent, []);
      assert.equal(f.reports.receipt(old.requestId).delivery.delivery, 'cancelled');
    });
  }

  for (const failure of ['unknown', 'reservation']) {
    test(`${backend}: 보류 재전송의 ${failure} 실패는 추가 전송을 만들지 않는다`, () => {
      const f = fixture(backend);
      const old = f.submit('응답장애', '보류 알림');
      let attempts = 0;
      f.reports.send = () => {
        attempts++;
        throw Object.assign(new Error('전달 결과 불명확'), {delivery: 'unknown'});
      };
      if (failure === 'reservation') {
        const record = f.reports.record;
        f.reports.record = entry => {
          if (entry.kind === 'watch-ai-delivery' && entry.held === false) {
            throw new Error('예약 기록 실패');
          }
          record(entry);
        };
        for (let i = 0; i < 2; i++) {
          assert.throws(() => f.reports.retryHeld(f.rows(), f.parents), /예약 기록 실패/);
        }
        assert.equal(attempts, 0);
      } else {
        f.reports.retryHeld(f.rows(), f.parents);
        f.reports.retryHeld(f.rows(), f.parents);
        assert.equal(attempts, 1);
        assert.equal(f.reports.receipt(old.requestId).delivery.delivery, 'unknown');
      }
    });
  }
}
