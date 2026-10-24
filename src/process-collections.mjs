// Why: 중복 방지 키를 지우지 않고, 큰 모음만 프로세스 수명의 임시 DB에 보관한다.
// 10배 이력: 정상 JS 보관량은 1,000개/256KiB 이하, SQLite 페이지 캐시는 512KiB다.
// 문자열 키와 저장 후 수정하지 않는 값만 쓴다. 범용 Map의 객체 참조 공유를 제공하지 않는다.
import {DatabaseSync} from 'node:sqlite';
import {serialize, deserialize} from 'node:v8';

const registered = new WeakMap();
export const processCollectionInfo = collection => registered.get(collection)?.();

export function createProcessCollections({maxEntries = 1000, maxBytes = 256 * 1024,
  openDatabase = () => new DatabaseSync('')} = {}) {
  const collections = [];
  let db = null, statements = null, closed = false, failure = null, ordinal = 0;
  let entries = 0, bytes = 0;
  const check = () => {
    if (failure) throw failure;
    if (closed) throw new Error('프로세스 기억 저장소가 닫혔습니다');
  };
  const guarded = action => {
    check();
    try {return action();}
    catch (error) {
      failure = new Error('프로세스 기억 저장 실패: 중복 방지 상태를 확인할 수 없습니다', {cause:error});
      throw failure;
    }
  };
  const keyBytes = key => {
    if (typeof key !== 'string') throw new TypeError('프로세스 기억 키는 문자열이어야 합니다');
    // UTF-8로 바꾸면 서로 다른 고립 surrogate가 같은 문자로 바뀔 수 있다.
    return Buffer.from(key, 'utf16le');
  };
  function spill() {
    db = openDatabase();
    db.exec(`PRAGMA temp_store=FILE; PRAGMA cache_size=-512;
      PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;
      CREATE TABLE entries (collection INTEGER NOT NULL, key BLOB NOT NULL,
        value BLOB, ordinal INTEGER NOT NULL, PRIMARY KEY(collection,key)) WITHOUT ROWID;
      CREATE INDEX entry_order ON entries(collection,ordinal);`);
    statements = {
      get:db.prepare('SELECT value FROM entries WHERE collection=? AND key=?'),
      has:db.prepare('SELECT 1 FROM entries WHERE collection=? AND key=?'),
      put:db.prepare(`INSERT INTO entries VALUES(?,?,?,?) ON CONFLICT(collection,key)
        DO UPDATE SET value=excluded.value`),
      remove:db.prepare('DELETE FROM entries WHERE collection=? AND key=?'),
      clear:db.prepare('DELETE FROM entries WHERE collection=?'),
      list:db.prepare('SELECT key,value FROM entries WHERE collection=? ORDER BY ordinal'),
    };
    db.exec('BEGIN');
    for (const state of collections) {
      for (const [key, row] of state.rows) {
        statements.put.run(state.id, keyBytes(key), row.value, row.ordinal);
      }
    }
    db.exec('COMMIT');
    for (const state of collections) state.rows.clear();
    bytes = 0;
  }
  const info = () => ({storage:closed ? 'closed' : db ? 'temporary' : 'memory', entries,
    retainedEntries:db ? 0 : entries, serializedBytes:bytes});

  function collection(kind) {
    check();
    const state = {id:collections.length, rows:new Map(), size:0};
    collections.push(state);
    const has = key => guarded(() => db ? Boolean(statements.has.get(state.id, keyBytes(key)))
      : (keyBytes(key), state.rows.has(key)));
    const get = key => guarded(() => {
      const row = db ? statements.get.get(state.id, keyBytes(key)) : (keyBytes(key), state.rows.get(key));
      return row ? deserialize(row.value) : undefined;
    });
    const put = (key, value) => guarded(() => {
      const encoded = keyBytes(key), data = kind === 'set' ? null : serialize(value);
      const present = db ? Boolean(statements.has.get(state.id, encoded)) : state.rows.has(key);
      if (kind === 'set' && present) return api;
      if (db) statements.put.run(state.id, encoded, data, ++ordinal);
      else {
        const old = state.rows.get(key);
        bytes += (old ? 0 : encoded.length) + (data?.length ?? 0) - (old?.value?.length ?? 0);
        state.rows.set(key, {value:data, ordinal:old?.ordinal ?? ++ordinal});
      }
      if (!present) {state.size++;entries++;}
      if (!db && (entries > maxEntries || bytes > maxBytes)) spill();
      return api;
    });
    const remove = key => guarded(() => {
      const encoded = keyBytes(key);
      let removed;
      if (db) removed = statements.remove.run(state.id, encoded).changes > 0;
      else {
        const row = state.rows.get(key);
        removed = state.rows.delete(key);
        if (removed) bytes -= encoded.length + (row.value?.length ?? 0);
      }
      if (removed) {state.size--;entries--;}
      return removed;
    });
    function* iterate() {
      check();
      try {
        const rows = db ? statements.list.iterate(state.id) : state.rows;
        for (const row of rows) {
          const key = db ? Buffer.from(row.key).toString('utf16le') : row[0];
          const value = db ? row.value : row[1].value;
          yield kind === 'set' ? key : [key, deserialize(value)];
        }
      } catch (error) {guarded(() => {throw error;});}
    }
    const api = {
      get size() {check();return state.size;}, has, delete:remove,
      clear:() => guarded(() => {
        if (db) statements.clear.run(state.id);
        else for (const [key, row] of state.rows) bytes -= key.length * 2 + (row.value?.length ?? 0);
        state.rows.clear();entries -= state.size;state.size = 0;
      }),
      [Symbol.iterator]:iterate,
      *keys() {for (const row of iterate()) yield kind === 'set' ? row : row[0];},
      *values() {for (const row of iterate()) yield kind === 'set' ? row : row[1];},
      *entries() {for (const row of iterate()) yield kind === 'set' ? [row, row] : row;},
      ...(kind === 'set' ? {add:key => put(key)} : {get, set:put}),
    };
    registered.set(api, () => ({...info(), entries:state.size,
      retainedEntries:db ? 0 : state.size}));
    return api;
  }
  return {
    set:() => collection('set'), map:() => collection('map'), info,
    close() {
      if (closed) return;
      closed = true;
      try {db?.close();}
      finally {
        for (const state of collections) state.rows.clear();
        bytes = 0;statements = null;db = null;
      }
    },
  };
}
