// IndexedDB: armazenamento local (fonte da verdade no iPad)

const DB_NAME = 'anota';
const VERSION = 2;
const SYNCED = ['subjects', 'notes', 'pages', 'items', 'recordings', 'blobs', 'decks', 'fnotes', 'fcards', 'revlog'];

let dbp = null;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = ev => {
      const db = r.result;
      const old = ev.oldVersion;
      const mk = (name, idx = []) => {
        const s = db.createObjectStore(name, { keyPath: 'id' });
        s.createIndex('dirty', '_dirty');
        for (const i of idx) s.createIndex(i, i);
      };
      if (old < 1) {
        mk('subjects'); mk('notes');
        for (const name of ['pages', 'items', 'recordings', 'blobs']) mk(name, ['noteId']);
        db.createObjectStore('files', { keyPath: 'id' });
        const c = db.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
        c.createIndex('recId', 'recId');
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (old < 2) {
        // Flashcards: baralhos, "notas" de carta (conteúdo), cartas (agendamento) e histórico de revisões
        mk('decks');
        mk('fnotes', ['deckId']);
        mk('fcards', ['deckId', 'fnoteId']);
        mk('revlog', ['cardId', 'day']);
      }
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('Banco de dados bloqueado por outra aba aberta.'));
  });
  return dbp;
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => {
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error || new Error('Transação abortada'));
});
const wtx = (db, stores) => db.transaction(stores, 'readwrite', { durability: 'strict' });

export async function get(store, key) {
  const db = await openDB();
  return req(db.transaction(store).objectStore(store).get(key));
}
export async function getAll(store) {
  const db = await openDB();
  return req(db.transaction(store).objectStore(store).getAll());
}
export async function allKeys(store) {
  const db = await openDB();
  return req(db.transaction(store).objectStore(store).getAllKeys());
}
export async function byIndex(store, index, value) {
  const db = await openDB();
  return req(db.transaction(store).objectStore(store).index(index).getAll(value));
}
export async function keysByIndex(store, index, value) {
  const db = await openDB();
  return req(db.transaction(store).objectStore(store).index(index).getAllKeys(value));
}
export async function put(store, value) {
  const db = await openDB();
  const t = wtx(db, store);
  t.objectStore(store).put(value);
  return done(t);
}
export async function putMany(store, values) {
  if (!values.length) return;
  const db = await openDB();
  const t = wtx(db, store);
  const s = t.objectStore(store);
  for (const v of values) s.put(v);
  return done(t);
}
export async function del(store, key) {
  const db = await openDB();
  const t = wtx(db, store);
  t.objectStore(store).delete(key);
  return done(t);
}
export async function delMany(store, keys) {
  if (!keys.length) return;
  const db = await openDB();
  const t = wtx(db, store);
  const s = t.objectStore(store);
  for (const k of keys) s.delete(k);
  return done(t);
}
export async function delRange(store, range) {
  const db = await openDB();
  const t = wtx(db, store);
  t.objectStore(store).delete(range);
  return done(t);
}

export async function getMeta(key, def = null) {
  const r = await get('meta', key);
  return r ? r.value : def;
}
export function setMeta(key, value) { return put('meta', { key, value }); }
export function delMeta(key) { return del('meta', key); }

export { SYNCED };
