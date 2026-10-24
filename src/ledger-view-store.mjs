// Why: 재생 가능한 조회 상태와 적용 위치만 별도 DB에 둔다. 사건 원본은 이 파일에서 쓰지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {assertTestHome} from './test-home-guard.mjs';
import {completionTaskShortId} from './ledger-domains.mjs';
import {isMailTransfer} from './mail-routing.mjs';
import {enableWal} from './storage.mjs';

const APP_ID = 1262767154;
const checked = new Map();
export const ledgerViewPath = home => path.join(home, '.cache', 'ledger-view-v1.sqlite');
export const viewDomains = [null, 'tasks', 'mail', 'mailbox', 'system'];
const schema = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE cursors (stream TEXT PRIMARY KEY, seq INTEGER NOT NULL, hash TEXT,
    prefix_hash TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE source_rows (
    position INTEGER PRIMARY KEY, stream TEXT NOT NULL, seq INTEGER NOT NULL,
    payload TEXT CHECK(payload IS NULL OR json_valid(payload)), short_task TEXT, transfer INTEGER NOT NULL,
    UNIQUE(stream, seq)
  );
  CREATE INDEX source_task ON source_rows(short_task, position);
  CREATE INDEX source_transfer ON source_rows(transfer, position);
  CREATE TABLE mail_index (key TEXT PRIMARY KEY, position INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE seen_mail (key TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TABLE completions (key TEXT PRIMARY KEY, position INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE last_orders (key TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE done_seen (domain TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(domain, key)) WITHOUT ROWID;
  CREATE TABLE views (domain TEXT NOT NULL, position INTEGER NOT NULL, routine INTEGER NOT NULL,
    PRIMARY KEY(domain, position)) WITHOUT ROWID;
  CREATE INDEX view_visible ON views(domain, routine, position);
  CREATE TABLE filters (position INTEGER PRIMARY KEY, incident INTEGER NOT NULL,
    routine INTEGER NOT NULL, date TEXT);
  CREATE INDEX filter_date ON filters(date, position);
  CREATE INDEX filter_incident ON filters(incident, position);
  CREATE TABLE roles (role TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(role, position)) WITHOUT ROWID;
  CREATE TABLE card_refs (card TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(card, position)) WITHOUT ROWID;
  CREATE TABLE short_refs (card TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(card, position)) WITHOUT ROWID;
  CREATE TABLE transfers (key TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL) WITHOUT ROWID;
  PRAGMA application_id=${APP_ID};
  PRAGMA user_version=1;
`;

export const metaGet = (db, key) => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
export const metaSet = (db, key, value) => db.prepare(
  'INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
).run(key, String(value));

export function openLedgerView(home) {
  assertTestHome(home);
  const file = ledgerViewPath(home), dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  let fileStat;
  try {fileStat = fs.lstatSync(file);} catch (error) {if (error.code !== 'ENOENT') throw error;}
  if (fs.lstatSync(dir).isSymbolicLink() || fileStat?.isSymbolicLink()) {
    throw new Error('조회 캐시 링크는 지원하지 않습니다');
  }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=15000; PRAGMA synchronous=FULL;');
    const mark = db.prepare('PRAGMA application_id').get().application_id;
    if (mark !== APP_ID && (mark !== 0 ||
      db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n !== 0)) {
      throw new Error('다른 종류의 조회 캐시입니다');
    }
    enableWal(db);
    db.exec('BEGIN IMMEDIATE');
    // 다른 최초 조회가 기다리는 동안 생성했을 수 있으므로 잠금을 얻은 뒤 다시 확인한다.
    if (db.prepare('PRAGMA application_id').get().application_id === 0) db.exec(schema);
    if (db.prepare('PRAGMA application_id').get().application_id !== APP_ID ||
      db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('조회 캐시 버전 확인 필요');
    const stat = fs.statSync(file), identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    if (checked.get(file) !== identity) {
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('조회 캐시 손상');
      checked.delete(file);checked.set(file, identity);
      while (checked.size > 8) checked.delete(checked.keys().next().value);
    }
    fs.chmodSync(file, 0o600);
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();throw error;
  }
}

export function resetLedgerView(db, identity) {
  // 원본 events와 무관한 재생용 표만 초기화한다. 세대·상태·cursor는 같은 commit에 속한다.
  for (const table of ['meta', 'cursors', 'source_rows', 'mail_index', 'seen_mail',
    'completions', 'last_orders', 'done_seen', 'views', 'filters', 'roles', 'card_refs',
    'short_refs', 'transfers']) db.exec(`DELETE FROM ${table}`);
  metaSet(db, 'identity', identity);
  metaSet(db, 'generation', randomUUID());
  metaSet(db, 'expected', 1);
  metaSet(db, 'position', 0);
}

export function storedValidatorState(db) {
  // 한 묶음의 객체만 공유한다. 완료 검증의 === 의미도 원본 위치별 동일 객체로 보존한다.
  const objects = new Map(), positions = new WeakMap(), objectKeys = new WeakMap();
  const statements = new Map();
  const prepare = sql => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  let unknownKey = 0;
  const remember = (position, value) => {
    objects.set(position, value);
    if (value && typeof value === 'object') {
      positions.set(value, position);
      if (value.mailId && typeof value.mailId === 'object') objectKeys.set(value.mailId, `mail:${position}`);
      if (value.handoverId && typeof value.handoverId === 'object') {
        objectKeys.set(value.handoverId, `transfer:${position}`);
      }
    }
    return value;
  };
  const load = position => {
    if (objects.has(position)) return objects.get(position);
    const row = prepare('SELECT payload FROM source_rows WHERE position=?').get(position);
    if (!row || row.payload === null) throw new Error('조회 캐시 사건 연결 손상');
    return remember(position, JSON.parse(row.payload));
  };
  const key = value => {
    if (value && typeof value === 'object') {
      if (!objectKeys.has(value)) objectKeys.set(value, `unknown:${++unknownKey}`);
      return `object:${objectKeys.get(value)}`;
    }
    return `${typeof value}:${JSON.stringify(value)}`;
  };
  const referenceMap = table => ({
    get(value) {
      const row = prepare(`SELECT position FROM ${table} WHERE key=?`).get(key(value));
      return row ? load(row.position) : undefined;
    },
    has: value => Boolean(prepare(`SELECT 1 FROM ${table} WHERE key=?`).get(key(value))),
    set(value, entry) {
      const position = positions.get(entry);
      if (!position) throw new Error('조회 캐시 사건 위치 없음');
      prepare(`INSERT INTO ${table} VALUES(?,?) ON CONFLICT(key)
        DO UPDATE SET position=excluded.position`).run(key(value), position);
    },
  });
  return {
    expected:Number(metaGet(db, 'expected')),
    remember, load, key, prepare,
    clearObjects: () => objects.clear(),
    mailIds:{
      has: value => Boolean(prepare('SELECT 1 FROM seen_mail WHERE key=?').get(key(value))),
      add: value => prepare('INSERT OR IGNORE INTO seen_mail VALUES(?)').run(key(value)),
    },
    mails:referenceMap('mail_index'), completions:referenceMap('completions'),
    lastByStream:{
      get: stream => prepare('SELECT value FROM last_orders WHERE key=?').get(stream)?.value,
      set: (stream, value) => prepare(`INSERT INTO last_orders VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(stream, value),
    },
    lookup:{
      add() {}, // source_rows가 먼저 같은 트랜잭션 안에 들어 있다.
      before(done) {
        const at = positions.get(done), task = completionTaskShortId(done);
        return prepare(`SELECT position FROM source_rows WHERE short_task=? AND position<?
          UNION ALL SELECT position FROM source_rows WHERE transfer=1 AND position<?
          ORDER BY position`).all(task, at, at).map(row => load(row.position));
      },
    },
  };
}

export function storeSourceRow(db, state, position, source) {
  const {stream, seq, value} = source;
  const transfer = isMailTransfer(value) && Array.isArray(value.taskIds);
  const task = transfer ? null : completionTaskShortId(value);
  // 과거 연결 검증이 쓰는 우편·실행·인계만 복사한다. 화면 원문은 원본의 (stream,seq)에서 읽는다.
  const payload = value?.kind === 'send' || transfer || task !== null ? JSON.stringify(value) : null;
  state.prepare('INSERT INTO source_rows VALUES(?,?,?,?,?,?)').run(position, stream, seq,
    payload, task, Number(transfer));
  state.remember(position, value);
}
