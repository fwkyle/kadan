import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {withWatchMailboxViews} from '../src/mail-view.mjs';
import {applyWatchMailProjection} from '../src/watch-mail-projection.mjs';
import {ledgerViewPath} from '../src/ledger-view-store.mjs';
import {fixture, card, question, fullEquivalent, replayIs} from './helpers/watch-address-add.mjs';

test('건너뛰기 뒤 콜백 실패는 주소 근거와 지문을 함께 되돌리고 다음 호출에서 다시 판정한다', () => {
  const s = fixture(), original = s.first.saved.meta.watch_mail_projection;
  const before = s.edit(db => db.prepare('SELECT value FROM watch_mail_addresses').get().value);
  s.cards = [...s.cards, card('two')];
  assert.throws(() => withWatchMailboxViews(s.home, () => { throw new Error('fixture rollback'); },
    () => s.cards, s.metrics), /fixture rollback/);
  s.edit(db => {
    assert.equal(db.prepare('SELECT value FROM watch_mail_addresses').get().value, before);
    assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM watch_mail_projection').get().value), original);
  });
  s.metrics.clear();
  const next = s.read();replayIs(s, 1, 0);fullEquivalent(s, next);
});

test('실제 COMMIT 실패 뒤에도 다음 호출은 저장된 옛 주소 근거로 다시 판정한다', () => {
  const s = fixture(), original = s.first.saved.meta.watch_mail_projection;
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === 'COMMIT' && this.prepare('PRAGMA application_id').get().application_id === 1262767154) {
      throw new Error('fixture commit failure');
    }
    return exec.call(this, sql);
  };
  try {
    s.cards = [...s.cards, card('two')];
    assert.throws(() => s.reader.readEntries(), /fixture commit failure/);
  } finally { DatabaseSync.prototype.exec = exec; }
  s.edit(db => assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM watch_mail_projection').get().value),
    original));
  s.metrics.clear();
  const next = s.read();replayIs(s, 1, 0);fullEquivalent(s, next);
});

for (const [label, mutate, expectedReason] of [
  ['투영 계수', db => db.exec("UPDATE watch_mail_projection SET value=json_set(value,'$.count',999)"), 'address'],
  ['완료 계수', db => db.exec("UPDATE watch_mail_projection SET value=json_set(value,'$.completed',999)"), 'address'],
  ['메타 손상', db => db.exec("UPDATE watch_mail_projection SET value='invalid'"), 'invalid'],
  ['위치 후퇴', db => db.exec("UPDATE watch_mail_projection SET value=json_set(value,'$.position',999)"), 'address'],
  ['원본 세대', db => db.exec("UPDATE watch_mail_projection SET value=json_set(value,'$.generation','old')"), 'generation'],
  ['주소 근거 유실', db => db.exec('DELETE FROM watch_mail_addresses'), 'address'],
  ['주소 근거 손상', db => db.exec("UPDATE watch_mail_addresses SET value='invalid'"), 'address'],
  ['주소 근거 지문 불일치', db => db.exec("UPDATE watch_mail_addresses SET value='[]'"), 'address'],
]) {
  test(`${label}: 주소가 추가돼도 기존 전체 재생 조건을 우회하지 않는다`, () => {
    const s = fixture();s.edit(mutate);
    s.cards = [...s.cards, card('two')];
    const next = s.read();replayIs(s, 0, 1);
    assert.equal(s.metrics.snapshot().replay.projection[expectedReason], 1);
    fullEquivalent(s, next);
  });
}

test('주소 변경이 없어도 기존 계수·메타 손상 이유는 그대로다', () => {
  const s = fixture();
  s.edit(db => db.exec(`UPDATE watch_mail_projection
    SET value=json_set(value,'$.count',999,'$.revision','fixture-count')`));
  s.read();
  assert.equal(s.metrics.snapshot().replay.projection.count, 1);
  assert.equal(s.metrics.snapshot().replay.projection.address, 0);
  s.metrics.clear();
  s.edit(db => db.exec("UPDATE watch_mail_projection SET value='{}'"));
  s.read();assert.equal(s.metrics.snapshot().replay.projection.invalid, 1);
});

test('원본 조회 DB 재생성은 SQL과 RAM 모두 세대를 바꾼다', () => {
  const s = fixture();
  fs.renameSync(ledgerViewPath(s.home), path.join(s.home, 'previous-cache.sqlite'));
  s.cards = [...s.cards, card('two')];
  const next = s.read();
  const {replay} = s.metrics.snapshot();
  assert.equal(replay.projection.skipped, 0);
  for (const key of ['projection', 'role', 'work']) assert.equal(replay[key].full, 1);
  assert.equal(replay.mail.full, 2, '원본 우편과 해석 우편을 각각 다시 만든다');
  assert.equal(s.metrics.snapshot().replay.raw.generation, 1);
  assert.notEqual(next.projected[1], s.first.projected[1]);
  fullEquivalent(s, next);
});

test('조회 위치가 실제로 후퇴하면 주소 추가가 있어도 투영은 처음부터 만든다', () => {
  const s = fixture();
  withWatchMailboxViews(s.home, ({raw}) => {
    const db = raw.store.db;
    const before = JSON.parse(db.prepare('SELECT value FROM watch_mail_projection').get().value);
    const result = applyWatchMailProjection(s.home, db, raw.store.source,
      {...raw.info, position: 1}, [...s.cards, card('two')], s.metrics);
    assert.equal(result.info.projectionRebuilt, true);
    assert.notEqual(result.info.generation, before.revision);
    assert.equal(result.info.projectionApplied, 1);
  });
  assert.equal(s.metrics.snapshot().replay.projection.full, 1);
  assert.equal(s.metrics.snapshot().replay.projection.skipped, 0);
  // 직접 투영만 호출해 하위 상태는 아직 적용하지 않았다.
  for (const key of ['mail', 'role', 'work']) assert.equal(s.metrics.snapshot().replay[key].full, 0);
});

test('같은 캐시를 쓰는 다른 프로세스의 안전한 추가와 위험한 추가를 RAM도 따라간다', () => {
  const s = fixture(), old = s.first.projected[1];
  const script = `import {createWatchMailReader} from './src/watch-mail-reader.mjs';
    const cards=JSON.parse(process.argv[2]);
    const reader=createWatchMailReader(process.argv[1],null,{readCards:()=>cards});
    const raw=reader.readEntries();reader.project(raw,cards);`;
  const child = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, s.home,
      JSON.stringify(s.cards)], {cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 10000});
    assert.equal(result.status, 0, result.stderr);
  };
  s.cards = [...s.cards, card('two')];child();
  const added = s.read();assert.equal(added.projected[1], old);replayIs(s, 0, 0);
  s.cards = [...s.cards, card('one', 'other')];child();
  const changed = s.read();assert.notEqual(changed.projected[1], old);
  assert.equal(changed.saved.meta.watch_mail_projection.revision ===
    added.saved.meta.watch_mail_projection.revision, false);
  fullEquivalent(s, changed);
});

test('참조 색인의 위치 범위는 새 tail의 주소를 과거 참조로 오인하지 않는다', () => {
  const s = fixture();
  s.append({...question, taskId: 'two', executionKey: 'fixture/two', mailId: 'fixture-tail'});
  s.cards = [...s.cards, card('two')];
  const next = s.read();replayIs(s, 1, 0);fullEquivalent(s, next);
});

test('참조 색인이 없으면 증명할 수 없으므로 전체 재생한다', () => {
  const s = fixture();s.edit(db => db.exec('DROP TABLE short_refs'));
  s.cards = [...s.cards, card('two')];
  const next = s.read();replayIs(s, 0, 1);fullEquivalent(s, next);
});
