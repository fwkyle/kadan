import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {CardStore} from '../src/card-store.mjs';
import {appendLedger, readLedger} from '../src/ledger.mjs';
import {effectiveCardRole} from '../src/handover-state.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';

for (const mode of ['sqlite']) {
  for (const scenario of ['handover', 'chained', 'reassigned']) {
    test(`${mode}: ${scenario} 뒤 첫 결과 보고가 현재 담당과 과거 이력을 보존한다`, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-report-handover-'));
      if (mode === 'sqlite') {
        createDatabase(home);
        writeStorageMarker(home, 'sqlite');
      }
      const cards = new CardStore(home);
      let card = cards.create({repo: 'test', id: 'report', repoPath: home, body: '# 지시'});
      card = cards.update(card.key, {
        status: 'assigned', role: 'first', board: 'test', scope: '격리 시험',
        rallyId: 'test', rallyTitle: '시험', rallyRound: '1', rallyStep: 'implementation',
      }, {revision: card.revision, note: '배정'});
      const transfer = async (from, to) => {
        await delay(5);
        appendLedger({kind: 'handover', phase: 'transferred', from, to, taskIds: [card.key]}, home);
      };
      await transfer('first', 'second');
      let owner = 'second';
      if (scenario === 'chained') {
        await transfer('second', 'third');
        owner = 'third';
      }
      if (scenario === 'reassigned') {
        await delay(5);
        card = cards.update(card.key, {role: 'replacement'}, {revision: card.revision, note: '명시 재배정'});
        owner = 'replacement';
      }
      const history = card.history;
      const ledger = readLedger(home);
      await delay(5);
      fs.writeFileSync(card.resultPath, '결과 원문');
      const saved = cards.report(card.key, {revision: card.revision, outcome: 'ok', by: owner});
      assert.equal(saved.role, owner);
      assert.equal(effectiveCardRole(saved, readLedger(home), cards.listSummaries()), owner);
      assert.equal(cards.checkSend(card.key, owner).role, owner);
      assert.deepEqual(saved.history.slice(0, -1), history);
      assert.deepEqual(readLedger(home), ledger);
      assert.equal(cards.report(card.key, {revision: saved.revision, outcome: 'ok'}).revision, saved.revision);
    });
  }
}
