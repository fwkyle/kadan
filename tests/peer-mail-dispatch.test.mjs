import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {appendLedger, readLedger, readTaskLedger} from '../src/ledger.mjs';
import {createDatabase, writeStorageMarker} from '../src/storage.mjs';
import {CardStore} from '../src/card-store.mjs';
import {parseHierarchy} from '../src/hierarchy.mjs';
import {buildWatchScope} from '../src/watch-scope.mjs';
import {MailWatch} from '../src/watch-mail.mjs';

for (const backend of ['sqlite']) {
  test(`${backend}: 슈퍼 mail의 배정 카드 연결은 저장·알림만 하고 발령·대기를 바꾸지 않는다`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-peer-dispatch-'));
    if (backend === 'sqlite') {
      createDatabase(home);
      writeStorageMarker(home, 'sqlite');
    }
    const hierarchy = {'r-super': '@user', 'k-super': '@user'};
    const file = path.join(home, 'hierarchy.json');
    fs.writeFileSync(file, JSON.stringify(hierarchy));
    appendLedger({kind: 'hierarchy-loaded', path: file}, home);
    const store = new CardStore(home);
    let card = store.create({repo: 'k', id: 'current', repoPath: home, body: '# 지시'});
    card = store.update(card.key, {
      status: 'assigned', role: 'k-super', board: 'k', scope: '시험 범위',
      rallyId: 'rally', rallyTitle: '묶음', rallyRound: '1', rallyStep: 'implementation',
    }, {revision: card.revision, note: '시험 배정'});
    appendLedger({kind: 'send', role: 'k-super', taskId: card.id,
      executionKey: card.key, t: '2026-01-01T00:00:00Z'}, home);
    card = store.update(card.key, {activity: 'waiting'}, {
      revision: card.revision, by: 'k-super', note: '대기', noteKind: 'progress',
    });
    const tasks = readTaskLedger(home);
    const scope = () => [...buildWatchScope(store.list(), readLedger(home)).sessions];
    assert.deepEqual(scope(), []);
    const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
    const call = (...args) => spawnSync(process.execPath, [cli, ...args], {
      env: {...process.env, KADAN_HOME: home, KADAN_ROLE: 'r-super', KADAN_FLOOR: 'herdr',
        KADAN_HERDR_SOCKET: path.join(home, 'nonexistent.sock'), KADAN_NOTIFY: 'off'},
      encoding: 'utf8', input: '', timeout: 10000,
    });
    const result = call('mail', 'k-super', '--execution', card.key, '참고 맥락');
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'stored');
    assert.equal(receipt.wake, 'watch-required');
    const letter = readLedger(home).find(entry => entry.mailId === receipt.mailId);
    assert.equal(letter.transport, 'mailbox');
    assert.equal(letter.executionKey, card.key);
    assert.equal(letter.taskId, undefined);
    assert.deepEqual(readTaskLedger(home), tasks);
    assert.deepEqual(store.get(card.key), card);
    assert.deepEqual(scope(), []);

    // 실제 CLI가 저장한 우편을 감시기에 연결한다. 입력 보호·한 번 알림은 가짜 수신기로 검증한다.
    const entries = [...readLedger(home), {kind: 'start', role: 'k-super',
      session: 'kadan-k-super', panePid: 123, t: letter.t}];
    const sent = [];
    let held = true;
    const watcher = new MailWatch({record: entry => entries.push(entry),
      send: (...args) => sent.push(args),
      hold: () => held ? {code: 'KADAN_HUMAN_ACTIVE', message: '입력 중'} : null});
    const tick = () => watcher.tick({entries: [...entries], cards: store.list(), works: [],
      now: Date.parse(letter.t) + 1000, parents: parseHierarchy(hierarchy),
      floor: {list: () => [{session: 'kadan-k-super', pid: 123}]},
      readEntries: () => [...entries], readCards: () => store.list(), readWorks: () => []});
    tick();
    assert.equal(sent.length, 0);
    held = false;
    tick();
    tick();
    assert.equal(sent.length, 1);
    assert.match(sent[0][1], /inbox/);
    assert.deepEqual(readTaskLedger(home), tasks);
    assert.deepEqual(store.get(card.key), card);
    assert.deepEqual(scope(), []);

    const beforeRejected = readLedger(home);
    for (const options of [['--raw'], ['--task', card.key]]) {
      const rejected = call('mail', 'k-super', '--execution', card.key, ...options, '금지');
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, options[0] === '--raw' ? /--raw 없이/ : /mail.*--task/);
      assert.deepEqual(readLedger(home), beforeRejected);
      assert.deepEqual(readTaskLedger(home), tasks);
    }
  });
}
