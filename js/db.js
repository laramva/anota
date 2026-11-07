// IndexedDB: armazenamento local (fonte da verdade no aparelho)
//
// No iPad, o Safari às vezes derruba a ligação com o banco quando o app vai para o fundo
// ("transação abortada" / "connection lost"). Por isso toda operação reconecta e tenta de novo.

const DB_NAME = 'anota';
const VERSION = 2;
const SYNCED = ['subjects', 'notes', 'pages', 'items', 'recordings', 'blobs', 'decks', 'fnotes', 'fcards', 'revlog'];

let dbp = null;

function upgrade(ev, db) {
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
}

export function openDB() {
  if (dbp) return dbp;
  const p = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = ev => upgrade(ev, r.result);
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      // o Safari avisa quando a ligação cai: na próxima operação abrimos de novo
      db.onclose = () => { if (dbp === p) dbp = null; };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('Banco de dados ocupado por outra aba do app. Feche as outras abas.'));
  });
  p.catch(() => { if (dbp === p) dbp = null; }); // um erro ao abrir não pode travar o app para sempre
  dbp = p;
  return p;
}

function resetConnection() {
  const old = dbp;
  dbp = null;
  old?.then(d => { try { d.close(); } catch { } }).catch(() => { });
}

const RECOVERABLE = /InvalidStateError|UnknownError|AbortError|TransactionInactiveError|connection|closing|closed|lost|abort/i;
const isRecoverable = e => !e || RECOVERABLE.test(e.name || '') || RECOVERABLE.test(e.message || '');
const wait = ms => new Promise(r => setTimeout(r, ms));

// Roda a operação; se a ligação caiu, reconecta e tenta de novo (até 3 vezes)
async function run(fn) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn(await openDB());
    } catch (e) {
      last = e;
      if (e?.name === 'QuotaExceededError' || !isRecoverable(e)) throw e;
      resetConnection();
      await wait(120 * (attempt + 1));
    }
  }
  throw last;
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => {
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
  t.onabort = () => { const e = t.error || new Error('Transação abortada'); if (!t.error) e.name = 'AbortError'; rej(e); };
});
const wtx = (db, stores) => db.transaction(stores, 'readwrite', { durability: 'strict' });

export const get = (store, key) => run(db => req(db.transaction(store).objectStore(store).get(key)));
export const getAll = store => run(db => req(db.transaction(store).objectStore(store).getAll()));
export const allKeys = store => run(db => req(db.transaction(store).objectStore(store).getAllKeys()));
export const byIndex = (store, index, value) => run(db => req(db.transaction(store).objectStore(store).index(index).getAll(value)));
export const keysByIndex = (store, index, value) => run(db => req(db.transaction(store).objectStore(store).index(index).getAllKeys(value)));

export const put = (store, value) => run(db => { const t = wtx(db, store); t.objectStore(store).put(value); return done(t); });
export async function putMany(store, values) {
  if (!values.length) return;
  return run(db => { const t = wtx(db, store); const s = t.objectStore(store); for (const v of values) s.put(v); return done(t); });
}
export const del = (store, key) => run(db => { const t = wtx(db, store); t.objectStore(store).delete(key); return done(t); });
export async function delMany(store, keys) {
  if (!keys.length) return;
  return run(db => { const t = wtx(db, store); const s = t.objectStore(store); for (const k of keys) s.delete(k); return done(t); });
}
export const delRange = (store, range) => run(db => { const t = wtx(db, store); t.objectStore(store).delete(range); return done(t); });

export async function getMeta(key, def = null) {
  const r = await get('meta', key);
  return r ? r.value : def;
}
export function setMeta(key, value) { return put('meta', { key, value }); }
export function delMeta(key) { return del('meta', key); }

// Ao voltar para o app, confere se a ligação com o banco ainda está viva
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') get('meta', '__ping').catch(() => resetConnection());
});

export { SYNCED, resetConnection };
