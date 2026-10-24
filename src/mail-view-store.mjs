// Why: 우편 상태와 적용 위치를 원본과 분리한 재생용 DB에 보관한다.
import {randomUUID} from 'node:crypto';
import {domainProjector, completionTaskShortId} from './ledger-domains.mjs';
import {sourceViewValues} from './ledger-view.mjs';

const tables = ['mail_current', 'mail_refs', 'mail_ids', 'mail_sender_roles', 'mail_transfers',
  'mail_reminders', 'mail_done_refs', 'mail_generation', 'mail_cards', 'mail_role_counts'];
const schema = `
  CREATE TABLE mail_view_meta (domain TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE mail_current (
    domain TEXT NOT NULL, position INTEGER NOT NULL,
    recipient_key TEXT NOT NULL, recipient_value TEXT NOT NULL, recipient_reminder TEXT NOT NULL,
    sender_key TEXT NOT NULL, sender_value TEXT NOT NULL, since INTEGER NOT NULL,
    ack INTEGER NOT NULL, read INTEGER, expected INTEGER NOT NULL, notification INTEGER NOT NULL,
    exempt_kind INTEGER NOT NULL, exempt_recipient INTEGER NOT NULL,
    direct INTEGER NOT NULL, delivered_time REAL, reminder_id TEXT NOT NULL,
    reply_status TEXT NOT NULL, final_reply INTEGER, by_watch INTEGER NOT NULL, address TEXT NOT NULL,
    PRIMARY KEY(domain, position)
  ) WITHOUT ROWID;
  CREATE INDEX mail_recipient ON mail_current(domain, recipient_key, position);
  CREATE INDEX mail_sender ON mail_current(domain, sender_key, position);
  CREATE INDEX mail_reply ON mail_current(domain, reply_status, position);
  CREATE INDEX mail_read ON mail_current(domain, read, notification, position);
  CREATE INDEX mail_address ON mail_current(domain, address, position);
  CREATE TABLE mail_refs (domain TEXT NOT NULL, key TEXT NOT NULL, position INTEGER,
    PRIMARY KEY(domain, key)) WITHOUT ROWID;
  CREATE TABLE mail_ids (domain TEXT NOT NULL, key TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY(domain, key)) WITHOUT ROWID;
  CREATE TABLE mail_sender_roles (domain TEXT NOT NULL, position INTEGER NOT NULL,
    key TEXT NOT NULL, value TEXT NOT NULL, ordinal INTEGER NOT NULL,
    PRIMARY KEY(domain, position, key)) WITHOUT ROWID;
  CREATE TABLE mail_transfers (domain TEXT NOT NULL, key TEXT NOT NULL,
    source TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(domain, key)) WITHOUT ROWID;
  CREATE TABLE mail_reminders (domain TEXT NOT NULL, key TEXT NOT NULL, time REAL NOT NULL,
    PRIMARY KEY(domain, key)) WITHOUT ROWID;
  CREATE TABLE mail_done_refs (domain TEXT NOT NULL, key TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY(domain, key)) WITHOUT ROWID;
  CREATE TABLE mail_generation (domain TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL,
    value TEXT NOT NULL, PRIMARY KEY(domain, name, key)) WITHOUT ROWID;
  CREATE TABLE mail_cards (domain TEXT NOT NULL, position INTEGER NOT NULL, card TEXT NOT NULL,
    short_id TEXT NOT NULL, PRIMARY KEY(domain, position, card)) WITHOUT ROWID;
  CREATE INDEX mail_card_address ON mail_cards(domain, card, position);
  CREATE INDEX mail_card_short ON mail_cards(domain, short_id, position);
  CREATE TABLE mail_role_counts (domain TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    refs INTEGER NOT NULL, first_rank INTEGER NOT NULL, PRIMARY KEY(domain, key)) WITHOUT ROWID;
`;
export const encodeMailValue = value => JSON.stringify({value});
export const decodeMailValue = value => JSON.parse(value).value;

export function createMailViewStore(db, source, domain,
  {projector = domainProjector(domain), projectEntry = entry => entry} = {}) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_view_meta'").get()) db.exec(schema);
  const scope = domain ?? '', statements = new Map(), objects = new Map(), positions = new WeakMap();
  const objectKeys = new WeakMap(), project = projector;
  let unknown = 0;
  const prepare = sql => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  const remember = (position, entry) => {
    objects.set(position, entry);
    if (entry && typeof entry === 'object') {
      positions.set(entry, position);
      for (const [field, value] of Object.entries(entry)) {
        if (value && typeof value === 'object') objectKeys.set(value, `${position}:${field}`);
      }
    }
    return entry;
  };
  const key = value => {
    if (value && typeof value === 'object') {
      if (!objectKeys.has(value)) objectKeys.set(value, `unknown:${++unknown}`);
      return `object:${objectKeys.get(value)}`;
    }
    return `${typeof value}:${JSON.stringify(value)}`;
  };
  const load = position => {
    if (objects.has(position)) return objects.get(position);
    const row = prepare('SELECT stream,seq,payload FROM source_rows WHERE position=?').get(position);
    if (!row) throw new Error('우편 조회 위치 손상');
    const value = row.payload === null ? sourceViewValues(source, [row])[0] : JSON.parse(row.payload);
    const entry = projectEntry(
      (row.stream === 'ledger.jsonl' ? project.legacy([value]) : project.rows([value]))[0]);
    return remember(position, entry);
  };
  const map = name => ({
    get(value) {
      const row = prepare('SELECT value FROM mail_generation WHERE domain=? AND name=? AND key=?')
        .get(scope, name, key(value));
      return row ? decodeMailValue(row.value) : undefined;
    },
    has:value => Boolean(prepare('SELECT 1 FROM mail_generation WHERE domain=? AND name=? AND key=?')
      .get(scope, name, key(value))),
    set:(value, data) => prepare(`INSERT INTO mail_generation VALUES(?,?,?,?) ON CONFLICT(domain,name,key)
      DO UPDATE SET value=excluded.value`).run(scope, name, key(value), encodeMailValue(data)),
    delete:value => prepare('DELETE FROM mail_generation WHERE domain=? AND name=? AND key=?')
      .run(scope, name, key(value)),
    add:value => prepare('INSERT OR IGNORE INTO mail_generation VALUES(?,?,?,?)')
      .run(scope, name, key(value), encodeMailValue(true)),
  });
  const ref = (table, value) => prepare(`SELECT position FROM ${table} WHERE domain=? AND key=?`)
    .get(scope, key(value))?.position;
  const state = position => prepare('SELECT * FROM mail_current WHERE domain=? AND position=?').get(scope, position);
  return {
    db, source, scope, prepare, key, load, remember, map, ref, state,
    position:entry => positions.get(entry), clear:() => objects.clear(),
    metadata() {
      const row = prepare('SELECT value FROM mail_view_meta WHERE domain=?').get(scope);
      return row ? JSON.parse(row.value) : null;
    },
    save(meta) {
      prepare(`INSERT INTO mail_view_meta VALUES(?,?) ON CONFLICT(domain)
        DO UPDATE SET value=excluded.value`).run(scope, JSON.stringify(meta));
    },
    reset(generation, actors) {
      for (const table of tables) prepare(`DELETE FROM ${table} WHERE domain=?`).run(scope);
      return {version:1, generation, actors, revision:randomUUID(), position:0, count:0, stateVersion:0};
    },
    lookup:{
      positions:{get:entry => positions.get(entry)},
      doneByMail:{get(value) {
        const position = ref('mail_done_refs', value);
        return position ? load(position) : undefined;
      }},
      before(done) {
        const end = positions.get(done), task = completionTaskShortId(done);
        return prepare(`SELECT r.position FROM source_rows r JOIN views v USING(position)
          WHERE v.domain=? AND r.short_task=? AND r.position<?
          UNION ALL SELECT r.position FROM source_rows r JOIN views v USING(position)
          WHERE v.domain=? AND r.transfer=1 AND r.position<? ORDER BY position`)
          .all(scope, task, end, scope, end).map(row => load(row.position));
      },
    },
  };
}

// 저장된 값의 자료형을 보존한다. 원문에 없는 속성을 null로 바꾸지 않는다.
export function storedMailLetter(store, row) {
  const entry = store.load(row.position);
  const senderRoles = store.prepare(`SELECT value FROM mail_sender_roles
    WHERE domain=? AND position=? ORDER BY ordinal`).all(store.scope, row.position);
  return {...entry, currentRecipient:decodeMailValue(row.recipient_value),
    currentSender:decodeMailValue(row.sender_value), replyRecipients:senderRoles.map(r => decodeMailValue(r.value)),
    previousGeneration:Boolean(row.previous), read:row.read === null ? null : Boolean(row.read),
    readKind:row.ack ? 'recipient-ack' : entry.mailId && entry.deliveredRead === true ? 'delivered-read' : null,
    expectReply:entry.expectReply === true, replyFinal:entry.replyFinal === true,
    replyStatus:row.reply_status, cancelled:row.reply_status === 'cancelled',
    ...(row.reply_status === 'answered' ? {finalReplyId:store.load(row.final_reply).mailId} : {}),
  };
}

export const mailStateJoins = `LEFT JOIN mail_generation g
    ON g.domain=m.domain AND g.name='bounds' AND g.key=m.recipient_key
  LEFT JOIN mail_reminders reminder ON reminder.domain=m.domain
    AND reminder.key='[' || m.reminder_id || ',' || m.recipient_reminder || ']'`;
export const mailStateFrom = `FROM mail_current m ${mailStateJoins}`;
export const previousMailExpression = `COALESCE(json_extract(g.value,'$.value.index')>m.since,0)
  AND NOT (m.exempt_kind=1 AND m.exempt_recipient=1 AND (
    CASE WHEN m.direct=1 THEN m.delivered_time ELSE reminder.time END IS NULL
    OR json_extract(g.value,'$.value.time') IS NULL
    OR json_extract(g.value,'$.value.time') <=
      CASE WHEN m.direct=1 THEN m.delivered_time ELSE reminder.time END))`;
export const mailStateSelect = `SELECT m.*,(${previousMailExpression}) AS previous ${mailStateFrom}`;
