// Camada de dados: tudo que é salvo passa por aqui (marca "sujo" para sincronizar)

import * as db from './db.js';
import { uid, now, emitter } from './util.js';

export const KIND_STORE = {
  subject: 'subjects', note: 'notes', page: 'pages', item: 'items', recording: 'recordings', blob: 'blobs',
  deck: 'decks', fnote: 'fnotes', fcard: 'fcards', revlog: 'revlog',
};
export const STORE_KIND = Object.fromEntries(Object.entries(KIND_STORE).map(([k, v]) => [v, k]));
export const bus = emitter();

export const PAGE_W = 1240;
export const PAGE_H = 1754; // proporção A4

// Campos que começam com "_" são locais e não vão para a nuvem
export function strip(rec) {
  const o = {};
  for (const k in rec) if (k[0] !== '_') o[k] = rec[k];
  return o;
}

function stamp(rec) {
  rec.updatedAt = Math.max(now(), (rec.updatedAt || 0) + 1);
  rec._dirty = 1;
  return rec;
}

// Rede de segurança: o que não conseguiu salvar fica na fila (em memória) e é salvo de novo
// sozinho a cada 2 segundos, até dar certo. Só avisa você se continuar falhando.
const failed = new Map(); // "store:id" -> { store, rec }
let retryT = null, failingSince = 0, warned = false;

function queueFailed(store, recs, e) {
  for (const r of recs) failed.set(store + ':' + (r.id ?? r.key), { store, rec: r });
  if (!failingSince) failingSince = Date.now();
  if (e?.name === 'QuotaExceededError' || (!warned && Date.now() - failingSince > 4000)) { warned = true; bus.emit('save-error', e); }
  clearTimeout(retryT);
  retryT = setTimeout(retryFailed, 2000);
}

export async function retryFailed() {
  if (!failed.size) return true;
  const byStore = new Map();
  for (const { store, rec } of failed.values()) { if (!byStore.has(store)) byStore.set(store, []); byStore.get(store).push(rec); }
  try {
    for (const [store, recs] of byStore) await db.putMany(store, recs);
    failed.clear();
    if (warned) bus.emit('save-ok');
    failingSince = 0; warned = false;
    bus.emit('dirty');
    return true;
  } catch (e) {
    queueFailed('', [], e);
    return false;
  }
}
export const pendingSaves = () => failed.size;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retryFailed(); });

export async function save(kind, rec) {
  stamp(rec);
  const store = KIND_STORE[kind];
  try {
    await db.put(store, rec);
  } catch (e) {
    console.warn('salvar', e);
    queueFailed(store, [rec], e);
    return rec;
  }
  bus.emit('dirty', kind, rec);
  return rec;
}

export async function saveMany(kind, recs) {
  if (!recs.length) return;
  for (const r of recs) stamp(r);
  const store = KIND_STORE[kind];
  try {
    await db.putMany(store, recs);
  } catch (e) {
    console.warn('salvar', e);
    queueFailed(store, recs, e);
    return;
  }
  bus.emit('dirty', kind, recs[0]);
}

// ---------- Matérias ----------
// Matérias (parentId = null) e temas dentro de uma matéria (parentId = id da matéria)
export async function listSubjects() {
  return (await db.getAll('subjects')).filter(s => !s.deleted)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }));
}
export function createSubject(name, color, parentId = null) {
  return save('subject', { id: uid(), name, color, parentId, order: now(), createdAt: now(), deleted: false });
}

// ---------- Notas ----------
export async function listNotes() {
  return (await db.getAll('notes')).filter(n => !n.deleted);
}
export const getNote = id => db.get('notes', id);

export async function createNote({ title = 'Sem título', subjectId = null, template = 'lined', paperColor = '#ffffff' } = {}) {
  const note = await save('note', { id: uid(), title, subjectId, createdAt: now(), trashed: false, deleted: false, thumb: null, lastOpenedAt: now() });
  await createPage(note.id, { order: 1, template, paperColor });
  return note;
}

export async function getPages(noteId) {
  return (await db.byIndex('pages', 'noteId', noteId)).filter(p => !p.deleted).sort((a, b) => a.order - b.order);
}
export function createPage(noteId, { order, template = 'lined', paperColor = '#ffffff', w = PAGE_W, h = PAGE_H, pdf = null }) {
  return save('page', { id: uid(), noteId, order, template, paperColor, w, h, pdf, deleted: false });
}
export async function getItems(noteId) {
  return (await db.byIndex('items', 'noteId', noteId)).filter(i => !i.deleted);
}
export async function getRecordings(noteId) {
  return (await db.byIndex('recordings', 'noteId', noteId)).filter(r => !r.deleted).sort((a, b) => a.startedAt - b.startedAt);
}

// Apaga de vez (depois da lixeira): marca a nota como excluída e remove os filhos localmente
export async function purgeNote(note) {
  note.deleted = true;
  note.thumb = null;
  await save('note', note);
  await purgeChildrenLocal(note.id);
}
export async function purgeChildrenLocal(noteId) {
  for (const store of ['pages', 'items', 'recordings', 'blobs']) {
    const keys = await db.keysByIndex(store, 'noteId', noteId);
    if (store === 'blobs') await db.delMany('files', keys);
    await db.delMany(store, keys);
  }
}

// Remove localmente tudo de um baralho excluído (cartas, histórico e imagens)
export async function purgeDeckLocal(deckId) {
  const cardIds = await db.keysByIndex('fcards', 'deckId', deckId);
  for (const cid of cardIds) await db.delMany('revlog', await db.keysByIndex('revlog', 'cardId', cid));
  await db.delMany('fcards', cardIds);
  await db.delMany('fnotes', await db.keysByIndex('fnotes', 'deckId', deckId));
  const blobKeys = await db.keysByIndex('blobs', 'noteId', deckId);
  await db.delMany('files', blobKeys);
  await db.delMany('blobs', blobKeys);
}

// ---------- Arquivos (PDF, áudio, imagens) ----------
let fileFetcher = null; // definido pela sincronização: baixa da nuvem se faltar localmente
export function setFileFetcher(fn) { fileFetcher = fn; }

export async function createBlob({ noteId, data, mime, name = '' }) {
  const id = uid();
  await db.put('files', { id, data, mime });
  const meta = { id, noteId, mime, size: data.byteLength, name, deleted: false, _needsUpload: 1, _have: 1 };
  await save('blob', meta);
  return meta;
}

export async function getFileData(id) {
  let f = await db.get('files', id);
  if (!f && fileFetcher) {
    await fileFetcher(id);
    f = await db.get('files', id);
  }
  return f || null;
}
export async function getFileBlob(id) {
  const f = await getFileData(id);
  return f ? new Blob([f.data], { type: f.mime }) : null;
}

// ---------- Uso de espaço ----------
export async function storageInfo() {
  let est = null, persisted = null;
  try { est = await navigator.storage?.estimate?.(); } catch { }
  try { persisted = await navigator.storage?.persisted?.(); } catch { }
  return { usage: est?.usage ?? null, quota: est?.quota ?? null, persisted };
}
