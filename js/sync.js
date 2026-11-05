// Sincronização com o Supabase (nuvem). O iPad continua sendo a fonte principal:
// tudo é salvo localmente primeiro e enviado quando houver internet.

import * as db from './db.js';
import * as store from './store.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { emitter, now } from './util.js';

export const syncBus = emitter();
const ORDER = ['subjects', 'notes', 'pages', 'blobs', 'recordings', 'items', 'decks', 'fnotes', 'fcards', 'revlog'];
const SCHEMA = 2; // ao mudar, baixa tudo de novo uma vez (tipos novos que versões antigas ignoravam)
const BUCKET = 'files';

let client = null;
let user = null;
const state = { status: 'off', pending: 0, lastSync: null, error: null };
let running = false, again = false, timer = null, lastDirty = 0, pendT = null;
function pendingSoon() { clearTimeout(pendT); pendT = setTimeout(updatePending, 2500); }
const downloads = new Map();

export const configured = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);
export const getUser = () => user;
export const getState = () => ({ ...state, user });

function setStatus(status, error = null) {
  state.status = status;
  state.error = error ? (error.message || String(error)) : null;
  syncBus.emit('status', getState());
}

export async function initSync() {
  state.lastSync = await db.getMeta('lastSync', null);
  if ((await db.getMeta('syncSchema', 1)) < SCHEMA) {
    await db.delMeta('pullCursor');
    await db.setMeta('syncSchema', SCHEMA);
  }
  // enquanto você escreve, nada de sincronizar nem contar pendências (isso roubava tempo da caneta)
  store.bus.on('dirty', () => { lastDirty = Date.now(); pendingSoon(); schedule(4000); });
  updatePending();
  if (!configured() || !window.supabase) { setStatus('off'); return; }
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'anota-auth', detectSessionInUrl: false },
  });
  store.setFileFetcher(downloadFile);
  try {
    const { data } = await client.auth.getSession();
    user = data.session?.user || null;
  } catch { user = null; }
  client.auth.onAuthStateChange((ev, session) => {
    const nu = session?.user || null;
    const changed = (nu?.id || null) !== (user?.id || null);
    user = nu;
    if (changed) {
      if (user) onSignedIn().then(() => schedule(0));
      setStatus(user ? 'idle' : 'signed-out');
    }
  });
  if (user) await onSignedIn();
  setStatus(user ? 'idle' : 'signed-out');
  window.addEventListener('online', () => schedule(0));
  window.addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(500); else syncNow(true);
  });
  setInterval(() => schedule(0), 45000);
  schedule(800);
}

// Se outra conta entrar neste aparelho, reenviamos tudo para a conta nova
async function onSignedIn() {
  const last = await db.getMeta('syncUser', null);
  if (last !== user.id) {
    if (last) {
      for (const s of ORDER) {
        const all = await db.getAll(s);
        for (const r of all) { r._dirty = 1; if (s === 'blobs') r._needsUpload = 1; }
        await db.putMany(s, all);
      }
    }
    await db.delMeta('pullCursor');
    await db.setMeta('syncUser', user.id);
  }
}

export async function signIn(email, password) {
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signUp(email, password) {
  // Endereço exato do app (ex.: https://laramva.github.io/anota/) para o link do e-mail voltar aqui
  const back = location.origin + location.pathname.replace(/index\.html$/, '');
  const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: back } });
  if (error) throw error;
  return { needsConfirm: !data.session };
}
export async function signOut() {
  await syncNow(true).catch(() => { });
  await client.auth.signOut();
}

export function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), ms);
}

export async function syncNow(force = false) {
  if (!client || !user) return;
  if (!force && Date.now() - lastDirty < 3000) { schedule(3500); return; } // ainda escrevendo
  if (running) { again = true; return; }
  if (!navigator.onLine) { setStatus('offline'); return; }
  running = true;
  setStatus('syncing');
  try {
    await push();
    await pull();
    await push();
    state.lastSync = now();
    await db.setMeta('lastSync', state.lastSync);
    setStatus('ok');
    downloadMissing();
  } catch (e) {
    console.warn('sync', e);
    setStatus(navigator.onLine ? 'error' : 'offline', e);
    schedule(30000);
  } finally {
    running = false;
    await updatePending();
    if (again) { again = false; schedule(1000); }
  }
}

export async function updatePending() {
  let n = 0;
  for (const s of ORDER) n += (await db.keysByIndex(s, 'dirty', 1)).length;
  state.pending = n;
  syncBus.emit('status', getState());
  return n;
}

// ---------- Envio ----------
function batches(recs, maxBytes = 1_200_000, maxN = 400) {
  const out = [];
  let cur = [], size = 0;
  for (const r of recs) {
    const sz = (r.pts?.length || 0) + 400;
    if (cur.length && (size + sz > maxBytes || cur.length >= maxN)) { out.push(cur); cur = []; size = 0; }
    cur.push(r); size += sz;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function push() {
  for (const s of ORDER) {
    const kind = store.STORE_KIND[s];
    const dirty = await db.byIndex(s, 'dirty', 1);
    if (!dirty.length) continue;
    for (const batch of batches(dirty)) {
      if (kind === 'blob') {
        for (const b of batch) if (b._needsUpload && !b.deleted) await uploadFile(b);
      }
      const rows = batch.map(r => ({
        id: r.id, kind,
        note_id: kind === 'note' ? r.id : (r.noteId || r.deckId || null),
        data: store.strip(r),
        updated_at: r.updatedAt,
        deleted: !!r.deleted,
      }));
      const { error } = await client.rpc('push_records', { rows });
      if (error) throw error;
      const clean = [];
      for (const r of batch) {
        const cur = await db.get(s, r.id);
        if (cur && cur.updatedAt === r.updatedAt) {
          cur._dirty = 0;
          if (kind === 'blob') cur._needsUpload = r._needsUpload;
          clean.push(cur);
        }
      }
      await db.putMany(s, clean);
      if (kind === 'note' || kind === 'deck') for (const r of batch) if (r.deleted) await purgeRemote(r.id).catch(e => console.warn(e));
    }
  }
}

async function uploadFile(b) {
  const f = await db.get('files', b.id);
  if (!f) { b._needsUpload = 0; return; }
  const { error } = await client.storage.from(BUCKET).upload(`${user.id}/${b.id}`, new Blob([f.data], { type: f.mime }), { upsert: true, contentType: f.mime });
  if (error && !/exists/i.test(error.message || '')) throw error;
  b._needsUpload = 0;
  const cur = await db.get('blobs', b.id);
  if (cur) { cur._needsUpload = 0; await db.put('blobs', cur); }
}

async function purgeRemote(noteId) {
  const { data } = await client.from('records').select('id').eq('note_id', noteId).eq('kind', 'blob');
  if (data?.length) await client.storage.from(BUCKET).remove(data.map(r => `${user.id}/${r.id}`));
  await client.rpc('purge_note', { nid: noteId });
}

// ---------- Recebimento ----------
async function pull() {
  const cursor = await db.getMeta('pullCursor', null);
  let since = cursor ? new Date(new Date(cursor).getTime() - 10000).toISOString() : '1970-01-01T00:00:00Z';
  const changed = new Set();
  for (; ;) {
    const { data, error } = await client.from('records')
      .select('id,kind,note_id,data,updated_at,deleted,server_ts')
      .gt('server_ts', since).order('server_ts', { ascending: true }).limit(500);
    if (error) throw error;
    if (!data.length) break;
    await merge(data, changed);
    since = data[data.length - 1].server_ts;
    await db.setMeta('pullCursor', since);
    if (data.length < 500) break;
  }
  if (changed.size) store.bus.emit('remote', [...changed]);
}

async function merge(rows, changed) {
  const byStore = new Map();
  for (const row of rows) {
    const s = store.KIND_STORE[row.kind];
    if (!s) continue;
    const local = await db.get(s, row.id);
    const ru = Number(row.updated_at);
    if (local && (local.updatedAt || 0) >= ru) continue; // já temos (ou temos versão mais nova)
    const rec = { ...row.data, id: row.id, updatedAt: ru, deleted: row.deleted, _dirty: 0 };
    if (row.kind === 'blob') { rec._needsUpload = 0; rec._have = (await db.get('files', row.id)) ? 1 : 0; }
    if (local?._cam) rec._cam = local._cam;
    if (!byStore.has(s)) byStore.set(s, []);
    byStore.get(s).push(rec);
    if (row.kind === 'note' && row.deleted) await store.purgeChildrenLocal(row.id);
    if (row.kind === 'deck' && row.deleted) await store.purgeDeckLocal(row.id);
    changed.add(row.kind === 'note' || row.kind === 'deck' ? row.id : row.note_id);
    if (['deck', 'fnote', 'fcard', 'revlog'].includes(row.kind)) changed.add('__cards');
  }
  for (const [s, recs] of byStore) await db.putMany(s, recs);
}

// ---------- Arquivos ----------
export function downloadFile(id) {
  if (!client || !user) return Promise.resolve(false);
  if (downloads.has(id)) return downloads.get(id);
  const p = (async () => {
    const { data, error } = await client.storage.from(BUCKET).download(`${user.id}/${id}`);
    if (error || !data) return false;
    const meta = await db.get('blobs', id);
    await db.put('files', { id, data: await data.arrayBuffer(), mime: meta?.mime || data.type });
    if (meta) { meta._have = 1; await db.put('blobs', meta); }
    return true;
  })().finally(() => downloads.delete(id));
  downloads.set(id, p);
  return p;
}

let bgDownloading = false;
async function downloadMissing() {
  if (bgDownloading) return;
  bgDownloading = true;
  try {
    const all = await db.getAll('blobs');
    for (const b of all) {
      if (b.deleted || b._have) continue;
      if (await db.get('files', b.id)) { b._have = 1; await db.put('blobs', b); continue; }
      if (!navigator.onLine) break;
      await downloadFile(b.id).catch(() => { });
    }
  } finally { bgDownloading = false; }
}
