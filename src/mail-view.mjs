// Why: 오래된 읽음·답장·인계는 저장된 현재 상태로 조회하고 새 사건만 반영한다.
// 10배 이력: 첫 재생/검증은 N, 정상 반영은 새 사건, 목록 원문은 선택한 쪽만 보관한다.
import path from 'node:path';
import {isUserActor, userActorNames} from './actors.mjs';
import {isMailTransfer} from './mail-routing.mjs';
import {createMailGenerations} from './mail-generation.mjs';
import {firstReminderSent, isSimplifiedMail} from './mail-rule.mjs';
import {createTaskCompletionChecker} from './ledger-domains.mjs';
import {withLedgerView} from './ledger-view.mjs';
import {metaGet} from './ledger-view-store.mjs';
import {applyWatchMailProjection} from './watch-mail-projection.mjs';
import {createMailViewStore, encodeMailValue, decodeMailValue, storedMailLetter,
  mailStateSelect, previousMailExpression} from './mail-view-store.mjs';

const verified = new Map();
const canAct = (by, role) => by === role || isUserActor(by);
const reminderPart = value => JSON.stringify([value]).slice(1, -1);
const exemptRecipient = role => Number(role !== '비서' && !isUserActor(role));
const addRole = (store, key, value, count, rank) => store.prepare(`INSERT INTO mail_role_counts
  VALUES(?,?,?,?,?) ON CONFLICT(domain,key) DO UPDATE SET refs=refs+excluded.refs,
  first_rank=min(first_rank,excluded.first_rank)`).run(store.scope, key, encodeMailValue(value), count, rank);

function transfer(store, entry, position) {
  if (!isMailTransfer(entry)) return false;
  const {scope, prepare, key} = store, {from, to} = entry;
  if (typeof from !== 'string' || !from.trim() || typeof to !== 'string' || !to.trim() || from === to) {
    throw new Error('우편 인계 역할 손상');
  }
  const id = key(entry.handoverId || JSON.stringify([from, to]));
  const previous = prepare('SELECT source,target FROM mail_transfers WHERE domain=? AND key=?').get(scope, id);
  if (previous) {
    if (previous.source !== from || previous.target !== to) throw new Error('우편 인계 책임 충돌');
    return false;
  }
  prepare('INSERT INTO mail_transfers VALUES(?,?,?,?)').run(scope, id, from, to);
  prepare(`UPDATE mail_current SET recipient_key=?,recipient_value=?,recipient_reminder=?,
    exempt_recipient=?,since=? WHERE domain=? AND recipient_key=?`)
    .run(key(to), encodeMailValue(to), reminderPart(to), exemptRecipient(to), position, scope, key(from));
  prepare(`INSERT OR IGNORE INTO mail_sender_roles
    SELECT domain,position,?,?,? FROM mail_current WHERE domain=? AND sender_key=?`)
    .run(key(to), encodeMailValue(to), position, scope, key(from));
  prepare('UPDATE mail_current SET sender_key=?,sender_value=? WHERE domain=? AND sender_key=?')
    .run(key(to), encodeMailValue(to), scope, key(from));
  const role = prepare('SELECT refs,first_rank FROM mail_role_counts WHERE domain=? AND key=?')
    .get(scope, key(from));
  if (role) {
    addRole(store, key(to), to, role.refs, role.first_rank);
    prepare('DELETE FROM mail_role_counts WHERE domain=? AND key=?').run(scope, key(from));
  }
  return true;
}

function addLetter(store, entry, position) {
  const {scope, prepare, key, ref, state} = store;
  const parent = ref('mail_refs', entry.replyTo), source = parent ? state(parent) : null;
  const late = source && prepare(`SELECT 1 FROM mail_sender_roles
    WHERE domain=? AND position=? AND key=?`).get(scope, parent, key(entry.role));
  const recipient = late ? decodeMailValue(source.sender_value) : entry.role;
  const recipientKey = late ? source.sender_key : key(entry.role);
  const time = Date.parse(entry.t);
  prepare(`INSERT INTO mail_current VALUES(${Array(21).fill('?').join(',')})`).run(
    scope, position, recipientKey, encodeMailValue(recipient), reminderPart(recipient),
    key(entry.by), encodeMailValue(entry.by), position, 0,
    entry.mailId ? Number(entry.deliveredRead === true) : null,
    Number(entry.expectReply === true),
    Number(entry.notificationOnly === true || entry.systemGenerated === 'task-completion'),
    Number(entry.transport === 'mailbox' && isSimplifiedMail(entry)), exemptRecipient(recipient),
    Number(entry.keyDelivery != null), Number.isFinite(time) ? time : null, reminderPart(entry.mailId),
    entry.expectReply === true ? 'waiting' : 'not-requested', null, Number(entry.by === 'watch'),
    key(entry.mailId || entry.digest),
  );
  addRole(store, key(entry.by), entry.by, 1, position * 2);
  addRole(store, recipientKey, recipient, 1, position * 2 + 1);
  prepare('INSERT INTO mail_sender_roles VALUES(?,?,?,?,?)')
    .run(scope, position, key(entry.by), encodeMailValue(entry.by), position);
  if (entry.mailId) {
    if (ref('mail_ids', entry.mailId)) throw new Error('우편 원장 중복 mailId');
    prepare('INSERT INTO mail_ids VALUES(?,?,?)').run(scope, key(entry.mailId), position);
  }
  for (const value of new Set([entry.mailId, entry.digest].filter(Boolean))) {
    prepare(`INSERT INTO mail_refs VALUES(?,?,?) ON CONFLICT(domain,key)
      DO UPDATE SET position=NULL`).run(scope, key(value), position);
  }
  for (const card of new Set([entry.taskId, entry.executionKey, entry.completionTaskId, entry.workKey]
    .filter(value => typeof value === 'string'))) {
    prepare('INSERT INTO mail_cards VALUES(?,?,?,?)').run(scope, position, card, card.split('/').at(-1));
  }
}

function applyMail(store, entry, position, completionReply) {
  const {scope, prepare, ref, state, load} = store;
  if (entry.kind === 'send') addLetter(store, entry, position);
  if (entry.kind === 'mail-read' || entry.kind === 'mail-cancel') {
    const parentAt = ref('mail_ids', entry.mailId), owner = parentAt ? state(parentAt) : null;
    if (!owner) return false;
    const recipient = decodeMailValue(owner.recipient_value), sender = decodeMailValue(owner.sender_value);
    if (entry.role !== recipient) return false;
    if (entry.kind === 'mail-read' && canAct(entry.by, recipient)) {
      return Boolean(prepare('UPDATE mail_current SET ack=1,read=1 WHERE domain=? AND position=? AND ack=0')
        .run(scope, parentAt).changes);
    }
    if (entry.kind === 'mail-cancel' && owner.expected && canAct(entry.by, sender) &&
      owner.reply_status === 'waiting') {
      prepare("UPDATE mail_current SET reply_status='cancelled' WHERE domain=? AND position=?").run(scope, parentAt);
      return true;
    }
  } else if (entry.kind === 'send' && entry.replyFinal === true) {
    // 참조 모호성은 새 답장의 자기 mailId/digest까지 반영한 뒤 판정한다.
    const parentAt = ref('mail_refs', entry.replyTo), owner = parentAt ? state(parentAt) : null;
    if (!owner) return false;
    const parent = load(parentAt), sender = decodeMailValue(owner.sender_value);
    const recipient = decodeMailValue(owner.recipient_value), reply = state(position);
    const valid = entry.systemGenerated === 'task-completion' ? completionReply(entry, parent)
      : parent && entry.workKey === parent.workKey && entry.executionKey === parent.executionKey;
    if (parent !== entry && owner.expected && decodeMailValue(reply.recipient_value) === sender &&
      canAct(entry.by, recipient) && valid && owner.reply_status === 'waiting') {
      prepare(`UPDATE mail_current SET reply_status='answered',final_reply=?
        WHERE domain=? AND position=?`).run(position, scope, parentAt);
      return true;
    }
  }
  return false;
}

function applyState(store, info, actors, cold) {
  const {prepare, scope} = store;
  let meta = store.metadata(), rebuilt = !meta || meta.version !== 1 ||
    meta.generation !== info.generation || meta.actors !== actors ||
    !Number.isSafeInteger(meta.position) || meta.position < 0 || meta.position > info.position ||
    !Number.isSafeInteger(meta.count) || meta.count < 0 || typeof meta.revision !== 'string' || !meta.revision ||
    !Number.isSafeInteger(meta.stateVersion) || meta.stateVersion < 0 || meta.stateVersion > meta.position;
  if (!rebuilt && cold) rebuilt = prepare('SELECT count(*) AS n FROM mail_current WHERE domain=?')
    .get(scope).n !== meta.count;
  if (rebuilt) meta = store.reset(info.generation, actors);
  const generations = createMailGenerations(Object.fromEntries(
    ['live', 'seen', 'bounds', 'resumes'].map(name => [name, store.map(name)])));
  const completionReply = createTaskCompletionChecker([], store.lookup);
  let applied = 0;
  const previousPosition = meta.position;
  while (true) {
    const rows = prepare(`SELECT position FROM views WHERE domain=? AND position>? AND position<=?
      ORDER BY position LIMIT 256`).all(scope, meta.position, info.position);
    if (!rows.length) break;
    for (const {position} of rows) {
      const entry = store.load(position);
      if (entry == null || entry.broken) throw new Error('원장 손상: 우편 상태 확인 불가');
      if (transfer(store, entry, position)) meta.stateVersion = position;
      generations.apply(entry, position);
      if (entry.kind === 'start' || entry.kind === 'stop') meta.stateVersion = position;
      for (const [key, time] of firstReminderSent([entry])) {
        if (prepare('INSERT OR IGNORE INTO mail_reminders VALUES(?,?,?)').run(scope, key, time).changes) {
          meta.stateVersion = position;
        }
      }
      if (entry.kind === 'done') {
        prepare('INSERT OR IGNORE INTO mail_done_refs VALUES(?,?,?)')
          .run(scope, store.key(entry.completionMailId), position);
      }
      if (applyMail(store, entry, position, completionReply)) meta.stateVersion = position;
      if (entry.kind === 'send') meta.count++;
      meta.position = position;applied++;
    }
    store.clear();
  }
  meta.position = info.position;
  if (applied || rebuilt || previousPosition !== meta.position) store.save(meta);
  return {...info, mailApplied:applied, mailRebuilt:rebuilt, mailGeneration:meta.revision,
    mailStateVersion:meta.stateVersion, mailCount:meta.count};
}

export function withMailboxView(home, read, {domain = null, cards = null} = {}) {
  if (![null, 'mailbox', 'watch'].includes(domain)) throw new Error('우편 조회 영역 확인 필요');
  if (domain === 'watch' && !Array.isArray(cards)) throw new Error('감시 우편의 카드 주소 수집이 필요합니다');
  return withLedgerView(home, (db, info, source) => {
    const value = mailboxView(home, db, info, source, domain, cards);
    return read(value.store, value.info);
  });
}

// 원문과 주소 해석 후의 상태를 같은 원본 snapshot/조회 DB transaction에서 얻는다.
export function withWatchMailboxViews(home, read, readCards = null) {
  return withLedgerView(home, (db, info, source) => {
    const raw = mailboxView(home, db, info, source, null, null);
    let cards = null;
    // 카드 읽기 실패는 기존 감시의 readCards 경계에서 보고한다. 원장 실패로 바꾸지 않는다.
    try { cards = readCards?.() ?? null; } catch { /* 원문 우편은 계속 조회할 수 있다. */ }
    const projected = cards ? mailboxView(home, db, info, source, 'watch', cards) : null;
    return read({raw, projected, cards});
  });
}

function mailboxView(home, db, info, source, domain, cards) {
  const key = `${path.resolve(home)}:${domain ?? ''}`;
  if (!db) return {store:null, info:{...info, mailCount:0, mailStateVersion:0, mailGeneration:null}};
  if (domain && metaGet(db, 'legacyBad')) throw new Error('과거 원장 손상: 도메인 조회 불가');
  if (metaGet(db, 'mailboxError')) throw new Error(metaGet(db, 'mailboxError'));
  const projection = domain === 'watch' ? applyWatchMailProjection(home, db, source, info, cards) : null;
  if (projection) info = projection.info;
  const store = createMailViewStore(db, source, domain, projection ?? undefined);
  const actors = JSON.stringify([...new Set(userActorNames())].sort());
  const previous = store.metadata(), stamp = JSON.stringify([info.generation, actors, previous?.revision]);
  const value = applyState(store, info, actors, verified.get(key) !== stamp);
  // 콜백 실패나 바깥 commit 실패 뒤에도 source/cursor 재확인이 먼저 실행된다.
  verified.delete(key);verified.set(key, JSON.stringify([info.generation, actors, value.mailGeneration]));
  while (verified.size > 8) verified.delete(verified.keys().next().value);
  return {store, info:value};
}

export function readMailboxViewPage(home, {domain = null, before = null, limit = 50} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
    before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new Error('우편 조회 범위 확인 필요');
  return withMailboxView(home, (store, info) => {
    if (!store) return {...info, items:[], next:null};
    const rows = store.prepare(`${mailStateSelect} WHERE m.domain=? AND m.position<?
      ORDER BY m.position DESC LIMIT ?`).all(store.scope, before ?? info.position + 1, limit + 1);
    return {...info, items:rows.slice(0, limit).map(row => storedMailLetter(store, row)),
      next:rows.length > limit ? rows[limit - 1].position : null};
  }, {domain});
}

// 숫자/알림 후보만 읽는 소비자는 전체 우편 객체를 만들지 않는다. withMailboxView 안에서 호출한다.
export function mailboxWaitingCount(store) {
  return store ? store.prepare(`SELECT count(*) AS n FROM mail_current
    WHERE domain=? AND reply_status='waiting'`).get(store.scope).n : 0;
}

// 조건 열이 색인된 조회는 PK(domain, position) 순회가 아니라 그 색인으로 읽는다. 힌트가 없으면 SQLite가 position 정렬을
// 피하려 영역의 모든 행을 훑는다(10배 과거 자료에서 호출당 0.06→2.8ms). 색인이 없는 옛 파일이면 힌트 없이 같은 질의를 쓴다.
function hintedRows(store, index, tail, params) {
  const hinted = mailStateSelect.replace('FROM mail_current m', `FROM mail_current m INDEXED BY ${index}`);
  try { return store.prepare(`${hinted} ${tail}`).all(...params); }
  catch (error) {
    if (!/no such index/iu.test(error?.message ?? '')) throw error;
    return store.prepare(`${mailStateSelect} ${tail}`).all(...params);
  }
}

export function mailReminderCandidates(store) {
  if (!store) return [];
  // notification에는 notificationOnly와 완료 우편이 포함된다. 둘 다 기존 알림 제외 조건이다.
  const rows = hintedRows(store, 'mail_read', `WHERE m.domain=? AND m.read=0 AND m.notification=0
    AND NOT COALESCE((${previousMailExpression}),0) ORDER BY m.position`, [store.scope]);
  return rows.map(row => storedMailLetter(store, row));
}

export function mailWaitingLetters(store) {
  if (!store) return [];
  const rows = hintedRows(store, 'mail_reply', `WHERE m.domain=? AND m.reply_status='waiting'
    ORDER BY m.position`, [store.scope]);
  return rows.map(row => storedMailLetter(store, row));
}

export function mailRecentLetters(store, role) {
  if (!store) return [];
  // 양쪽 주소 색인에서 12개씩만 읽는다. 오래된 전체 우편을 OR/정렬로 훑지 않는다.
  const positions = store.prepare(`SELECT position FROM (
      SELECT position FROM (SELECT position FROM mail_current
        WHERE domain=? AND recipient_key=? ORDER BY position DESC LIMIT 12)
      UNION SELECT position FROM (SELECT position FROM mail_current
        WHERE domain=? AND sender_key=? ORDER BY position DESC LIMIT 12)
    ) ORDER BY position DESC LIMIT 12`).all(store.scope, store.key(role), store.scope, store.key(role));
  return positions.reverse().map(({position}) => storedMailLetter(store,
    store.prepare(`${mailStateSelect} WHERE m.domain=? AND m.position=?`).get(store.scope, position)));
}
