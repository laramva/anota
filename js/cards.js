// Flashcards: baralhos, cartas, fila de estudo, histórico e importação

import * as db from './db.js';
import * as store from './store.js';
import { uid, now } from './util.js';
import { STATE, DEFAULT_OPTS, schedule, dayKey, dayStart, nextDayStart, DAY } from './srs.js';

export const TYPES = [
  { id: 'basic', name: 'Básica', desc: 'Pergunta na frente, resposta no verso' },
  { id: 'reverse', name: 'Básica + invertida', desc: 'Gera 2 cartas: frente→verso e verso→frente' },
  { id: 'type', name: 'Digitar a resposta', desc: 'Você escreve a resposta e o app corrige' },
  { id: 'cloze', name: 'Lacunas (omissão)', desc: 'Esconde partes do texto: {{c1::resposta}}' },
];

// ---------- Baralhos ----------
export async function listDecks() {
  return (await db.getAll('decks')).filter(d => !d.deleted)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }));
}
export const getDeck = id => db.get('decks', id);
export function deckOpts(deck) { return { ...DEFAULT_OPTS, ...(deck?.opts || {}) }; }
export function createDeck(name, subjectId = null) {
  return store.save('deck', { id: uid(), name, subjectId, opts: {}, createdAt: now(), deleted: false });
}
export async function deleteDeck(deck) {
  deck.deleted = true;
  await store.save('deck', deck);
  await store.purgeDeckLocal(deck.id);
}

// ---------- Cartas ----------
export async function allCards(deckIds) {
  const all = (await db.getAll('fcards')).filter(c => !c.deleted);
  return deckIds ? all.filter(c => deckIds.includes(c.deckId)) : all;
}
export async function allFnotes(deckIds) {
  const all = (await db.getAll('fnotes')).filter(n => !n.deleted);
  return deckIds ? all.filter(n => deckIds.includes(n.deckId)) : all;
}
export const getFnote = id => db.get('fnotes', id);

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
export function clozeOrds(html) {
  const s = new Set();
  for (const m of (html || '').matchAll(CLOZE_RE)) s.add(+m[1] - 1);
  return [...s].sort((a, b) => a - b);
}
function ordsFor(fn) {
  if (fn.type === 'reverse') return [0, 1];
  if (fn.type === 'cloze') { const o = clozeOrds(fn.front); return o.length ? o : [0]; }
  return [0];
}

// Salva o conteúdo e cria/remove as cartas correspondentes
export async function saveFnote(fn) {
  const isNew = !fn.createdAt;
  if (isNew) { fn.id = fn.id || uid(); fn.createdAt = now(); fn.deleted = false; }
  fn.front = sanitize(fn.front); fn.back = sanitize(fn.back); fn.extra = sanitize(fn.extra || '');
  await store.save('fnote', fn);
  const existing = isNew ? [] : (await db.byIndex('fcards', 'fnoteId', fn.id)).filter(c => !c.deleted);
  const want = new Set(ordsFor(fn));
  const changed = [];
  for (const c of existing) {
    if (!want.has(c.ord)) { c.deleted = true; changed.push(c); }
    else if (c.deckId !== fn.deckId) { c.deckId = fn.deckId; changed.push(c); }
    want.delete(c.ord);
  }
  let i = 0;
  for (const ord of want) {
    changed.push({ id: uid(), deckId: fn.deckId, fnoteId: fn.id, ord, state: STATE.NEW, step: 0, s: 0, d: 0, due: 0, ivl: 0, reps: 0, lapses: 0, last: 0, suspended: false, buriedUntil: 0, flag: 0, createdAt: now() + (i++), deleted: false });
  }
  await store.saveMany('fcard', changed);
  return fn;
}

export async function deleteFnote(fn) {
  fn.deleted = true;
  await store.save('fnote', fn);
  const cs = await db.byIndex('fcards', 'fnoteId', fn.id);
  for (const c of cs) c.deleted = true;
  await store.saveMany('fcard', cs);
}

export async function updateCards(cards, patch) {
  for (const c of cards) Object.assign(c, typeof patch === 'function' ? patch(c) : patch);
  await store.saveMany('fcard', cards);
}
export const resetPatch = () => ({ state: STATE.NEW, step: 0, s: 0, d: 0, due: 0, ivl: 0, reps: 0, lapses: 0, last: 0 });

// ---------- Fila de estudo ----------
async function todayLogs() {
  return (await db.byIndex('revlog', 'day', dayKey(now()))).filter(r => !r.deleted);
}

// Contagens por baralho: novas (respeitando limite diário), aprendendo, revisões
export async function countsByDeck(decks) {
  const t = now(), end = nextDayStart(t);
  const cards = await allCards();
  const logs = await todayLogs();
  const newDone = {}, revDone = {};
  for (const l of logs) {
    if (l.state === STATE.NEW) newDone[l.deckId] = (newDone[l.deckId] || 0) + 1;
    else if (l.state === STATE.REVIEW) revDone[l.deckId] = (revDone[l.deckId] || 0) + 1;
  }
  const out = {};
  for (const d of decks) out[d.id] = { new: 0, learn: 0, review: 0, total: 0 };
  for (const c of cards) {
    const o = out[c.deckId];
    if (!o) continue;
    o.total++;
    if (c.suspended || (c.buriedUntil && c.buriedUntil > t)) continue;
    if (c.state === STATE.NEW) o.new++;
    else if (c.state === STATE.REVIEW) { if (c.due < end) o.review++; }
    else if (c.due < end) o.learn++;
  }
  for (const d of decks) {
    const op = deckOpts(d), o = out[d.id];
    o.new = Math.max(0, Math.min(o.new, op.newPerDay - (newDone[d.id] || 0)));
    o.review = Math.max(0, Math.min(o.review, op.revPerDay - (revDone[d.id] || 0)));
  }
  return out;
}

export async function buildQueue(decks) {
  const t = now(), end = nextDayStart(t);
  const ids = decks.map(d => d.id);
  const cards = await allCards(ids);
  const counts = await countsByDeck(decks);
  const learn = [], review = [], fresh = {};
  for (const c of cards) {
    if (c.suspended || (c.buriedUntil && c.buriedUntil > t)) continue;
    if (c.state === STATE.NEW) (fresh[c.deckId] ||= []).push(c);
    else if (c.state === STATE.REVIEW) { if (c.due < end) review.push(c); }
    else if (c.due < end) learn.push(c);
  }
  // revisões: atrasadas primeiro, limitadas por baralho
  review.sort((a, b) => a.due - b.due);
  const revLimited = [], perDeck = {};
  for (const c of review) {
    perDeck[c.deckId] = (perDeck[c.deckId] || 0) + 1;
    if (perDeck[c.deckId] <= counts[c.deckId].review) revLimited.push(c);
  }
  const news = [];
  for (const d of decks) {
    const list = fresh[d.id] || [];
    if (deckOpts(d).newOrder === 'random') shuffle(list); else list.sort((a, b) => a.createdAt - b.createdAt);
    news.push(...list.slice(0, counts[d.id].new));
  }
  learn.sort((a, b) => a.due - b.due);
  return { learn, review: shuffle(revLimited), news };
}

// Registra a resposta, salva e devolve dados para desfazer
export async function answer(card, g, ms, deck) {
  const before = { ...card };
  const t = now();
  const n = schedule(card, g, t, deckOpts(deck));
  Object.assign(card, n);
  const log = { id: uid(), cardId: card.id, deckId: card.deckId, ts: t, day: dayKey(t), rating: g, state: before.state || 0, ivl: card.ivl || 0, ms: Math.min(ms, 60000), deleted: false };
  await store.save('fcard', card);
  await store.save('revlog', log);
  // enterra as "irmãs" (outras cartas da mesma nota) até amanhã
  const sib = (await db.byIndex('fcards', 'fnoteId', card.fnoteId)).filter(c => c.id !== card.id && !c.deleted && (c.state === STATE.NEW || c.state === STATE.REVIEW) && !(c.buriedUntil > t));
  for (const s of sib) s.buriedUntil = nextDayStart(t);
  if (sib.length) await store.saveMany('fcard', sib);
  return { card, before, log, sib };
}

export async function undoAnswer(u) {
  Object.assign(u.card, u.before);
  await store.save('fcard', u.card);
  u.log.deleted = true;
  await store.save('revlog', u.log);
  for (const s of u.sib) s.buriedUntil = 0;
  if (u.sib.length) await store.saveMany('fcard', u.sib);
}

// ---------- Estatísticas ----------
export async function stats(deckIds) {
  const t = now();
  const logs = (await db.getAll('revlog')).filter(l => !l.deleted && (!deckIds || deckIds.includes(l.deckId)));
  const cards = await allCards(deckIds);
  const byDay = new Map();
  for (const l of logs) byDay.set(l.day, (byDay.get(l.day) || 0) + 1);
  const today = dayKey(t);
  const todays = logs.filter(l => l.day === today);
  // sequência de dias
  let streak = 0;
  const d = new Date(dayStart(t));
  if (!byDay.has(today)) d.setDate(d.getDate() - 1);
  for (; ;) { const k = dayKey(d.getTime() + 3600e3 * 5); if (byDay.has(k)) { streak++; d.setDate(d.getDate() - 1); } else break; }
  // previsão 30 dias
  const forecast = new Array(30).fill(0);
  const start = dayStart(t);
  for (const c of cards) {
    if (c.suspended || c.state === STATE.NEW) continue;
    const idx = Math.max(0, Math.floor((c.due - start) / DAY));
    if (idx < 30) forecast[idx]++;
  }
  const states = { new: 0, learning: 0, young: 0, mature: 0, suspended: 0 };
  for (const c of cards) {
    if (c.suspended) states.suspended++;
    else if (c.state === STATE.NEW) states.new++;
    else if (c.state !== STATE.REVIEW) states.learning++;
    else if ((c.ivl || 0) >= 21) states.mature++;
    else states.young++;
  }
  const month = logs.filter(l => l.ts > t - 30 * DAY && l.state === STATE.REVIEW);
  const retention = month.length ? month.filter(l => l.rating > 1).length / month.length : null;
  return {
    today: { count: todays.length, ms: todays.reduce((s, l) => s + (l.ms || 0), 0), correct: todays.length ? todays.filter(l => l.rating > 1).length / todays.length : null },
    streak, byDay, forecast, states, retention, total: cards.length, reviews: logs.length,
  };
}

// ---------- Importação / exportação ----------
export function parseImport(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const seps = ['\t', ';', ' - ', ' — ', ','];
  let sep = seps.find(s => lines.filter(l => l.includes(s)).length >= Math.ceil(lines.length * 0.6)) || '\t';
  return lines.map(l => {
    const parts = splitLine(l, sep);
    return { front: esc(parts[0] || '').trim(), back: esc(parts[1] || '').trim(), tags: (parts[2] || '').split(/[\s,]+/).filter(Boolean) };
  }).filter(r => r.front);
}
function splitLine(line, sep) {
  if (sep !== ',' && sep !== ';') return line.split(sep);
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === sep && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function exportCsv(deck) {
  const notes = await allFnotes([deck.id]);
  const q = s => '"' + htmlToText(s).replace(/"/g, '""') + '"';
  return notes.map(n => [q(n.front), q(n.back), q((n.tags || []).join(' '))].join(';')).join('\n');
}

// ---------- HTML seguro ----------
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI', 'SPAN', 'IMG', 'SUB', 'SUP', 'MARK', 'S', 'H3', 'BLOCKQUOTE', 'CODE']);
function clean(node) {
  for (const ch of [...node.childNodes]) {
    if (ch.nodeType === 3) continue;
    if (ch.nodeType !== 1) { ch.remove(); continue; }
    clean(ch);
    if (!ALLOWED.has(ch.tagName)) { ch.replaceWith(...ch.childNodes); continue; }
    for (const a of [...ch.attributes]) {
      if (ch.tagName === 'IMG' && a.name === 'data-blob') continue;
      if (a.name === 'style') {
        const color = ch.style.color, bg = ch.style.backgroundColor;
        ch.removeAttribute('style');
        if (color) ch.style.color = color;
        if (bg) ch.style.backgroundColor = bg;
        continue;
      }
      ch.removeAttribute(a.name);
    }
    if (ch.tagName === 'IMG' && !ch.getAttribute('data-blob')) ch.remove();
  }
}
export function sanitize(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstChild;
  clean(root);
  return root.innerHTML.replace(/(<br>\s*)+$/, '').trim();
}
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(`<div>${(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n')}</div>`, 'text/html');
  return doc.body.textContent.replace(CLOZE_RE, '$2').replace(/\n{3,}/g, '\n\n').trim();
}
export const hasImage = html => /<img/i.test(html || '');

// Lado da carta para exibir (HTML)
export function sides(fn, card) {
  if (fn.type === 'cloze') {
    const k = card.ord + 1;
    const front = fn.front.replace(CLOZE_RE, (m, n, text, hint) => +n === k ? `<span class="cloze">[${hint || '…'}]</span>` : text);
    const back = fn.front.replace(CLOZE_RE, (m, n, text) => +n === k ? `<span class="cloze shown">${text}</span>` : text);
    return { front, back, extra: [fn.back, fn.extra].filter(Boolean).join('<br>'), answerText: htmlToText(fn.front.match(new RegExp(`\\{\\{c${k}::([\\s\\S]*?)(?:::[\\s\\S]*?)?\\}\\}`))?.[1] || '') };
  }
  if (fn.type === 'reverse' && card.ord === 1) return { front: fn.back, back: fn.front, extra: fn.extra, answerText: htmlToText(fn.front) };
  return { front: fn.front, back: fn.back, extra: fn.extra, answerText: htmlToText(fn.back) };
}

// Correção de resposta digitada: ignora maiúsculas, acentos e pontuação; tolera erros pequenos
export function checkTyped(typed, expected) {
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const a = norm(typed), b = norm(expected);
  if (!a) return { ok: false, score: 0 };
  if (a === b) return { ok: true, exact: true, score: 1 };
  const dist = lev(a, b);
  const score = 1 - dist / Math.max(a.length, b.length);
  return { ok: score >= 0.85, score };
}
function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
