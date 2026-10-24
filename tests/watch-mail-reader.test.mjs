import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDatabase, writeStorageMarker, appendStream} from '../src/storage.mjs';
import {appendLedger} from '../src/ledger.mjs';
import {readLedgerIncremental} from '../src/ledger-incremental.mjs';
import {createWatchMailReader} from '../src/watch-mail-reader.mjs';
import {MailWatch} from '../src/watch-mail.mjs';

const at = n => new Date(n).toISOString();
const homeOf = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-watch-mail-reader-'));
  createDatabase(home);writeStorageMarker(home, 'sqlite');return home;
};
const initial = [
  {kind:'start', role:'fixture-worker', session:'kadan-fixture-worker', panePid:31, t:at(0)},
  {kind:'send', mailId:'question', role:'fixture-worker', by:'fixture-lead', expectReply:true,
    transport:'mailbox', mailRule:1, t:at(0)},
];

test('같은 수집의 원장·후보를 유지하고 새 ack 뒤에는 새 후보로 바뀐다', () => {
  const home = homeOf();for (const event of initial) appendLedger(event, home);
  const reader = createWatchMailReader(home, () => readLedgerIncremental(home));
  const old = reader.readEntries();
  assert.deepEqual(reader.letters(old).map(m => m.mailId), ['question']);
  appendLedger({kind:'mail-read', mailId:'question', role:'fixture-worker', by:'fixture-worker', t:at(1)}, home);
  const current = reader.readEntries();
  assert.equal(current.at(-1).kind, 'mail-read');assert.deepEqual(reader.letters(current), []);
  assert.deepEqual(reader.letters(old).map(m => m.mailId), ['question']);
  assert.throws(() => reader.letters([...current]), /수집 버전/);
  appendStream(home, 'mail/events.jsonl', {kind:'send', mailId:'broken'});
  assert.throws(() => reader.readEntries());
});

function run(mode, change) {
  const home = homeOf(), records = [], sent = [];
  for (const event of initial) appendLedger(event, home);
  const reader = createWatchMailReader(home, () => readLedgerIncremental(home));
  const readEntries = mode === 'view' ? reader.readEntries : () => readLedgerIncremental(home);
  let injected = false, now = 300_000;
  const works = [{key:'fixture/work', status:'open', executions:[]}];
  const record = value => {
    const event = {...value, t:at(now)};records.push(event);appendLedger(event, home);
    if (value.action !== 'reserved' || injected) return;
    injected = true;
    if (change === 'ack') appendLedger({kind:'mail-read', mailId:'question',
      role:'fixture-worker', by:'fixture-worker', t:at(now)}, home);
    if (change === 'handover') appendLedger({kind:'handover', phase:'transferred',
      from:'fixture-worker', to:'fixture-next', handoverId:'transfer', t:at(now)}, home);
    if (change === 'generation') appendLedger({kind:'start', role:'fixture-worker',
      session:'kadan-fixture-worker', panePid:32, t:at(now)}, home);
  };
  const floor = {list:() => [{session:'kadan-fixture-worker', alive:true, pid:31}], read:() => '›'};
  const make = () => new MailWatch({record, send:(...args) => sent.push(args),
    readLetters:mode === 'view' ? reader.letters : null});
  const tick = watch => watch.tick({entries:readEntries(), cards:[], works, now, floor,
    readEntries, readCards:() => [], readWorks:() => works});
  const watch = make();
  try {tick(watch);now += 300_000;tick(watch);} finally {watch.close();}
  const restarted = make();
  try {tick(restarted);} finally {restarted.close();}
  return {sent, records};
}

test('상태표 후보도 예약 후 ack·인계·세대 변경과 재시작의 기록·전송이 같다', () => {
  for (const change of ['none', 'ack', 'handover', 'generation']) {
    const expected = run('legacy', change), actual = run('view', change);
    assert.deepEqual(actual, expected, change);
    if (change === 'ack') assert.equal(actual.sent.length, 0);
    if (change === 'none') assert.ok(actual.sent.length > 0);
  }
});
