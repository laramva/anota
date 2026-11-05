// Flashcards automáticos: lê as páginas escritas (letra à mão, slides) com a IA gratuita do Google Gemini
// e cria cartas em baralhos separados por matéria e tema. A chave fica só neste aparelho.

import * as db from './db.js';
import * as store from './store.js';
import * as C from './cards.js';
import * as R from './render.js';
import { renderPageCanvas, closeAll, loadDoc } from './pdfview.js';
import { geom } from './render.js';
import { loadPref, savePref, now, emitter } from './util.js';
import { dayKey } from './srs.js';

export const autoBus = emitter();
const API = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_PAGES_PER_RUN = 20;
const GAP_MS = 4500; // respeita o limite de pedidos por minuto do plano gratuito
let running = false;

export const getKey = () => loadPref('geminiKey', '');
export const setKey = k => savePref('geminiKey', (k || '').trim());
export const isEnabled = () => loadPref('autoCards', true);
export const isRunning = () => running;

async function call(path, key, body) {
  const res = await fetch(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `erro ${res.status}`;
    const err = new Error(res.status === 400 && /key/i.test(msg) ? 'Chave inválida. Confira se copiou a chave inteira.' : res.status === 429 ? 'Limite gratuito do dia atingido. O app continua amanhã.' : msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Escolhe automaticamente o melhor modelo "Flash" disponível para a chave (rápido e gratuito)
async function pickModel(key, refresh = false) {
  const cached = loadPref('geminiModel', null);
  if (cached && !refresh) return cached;
  const data = await call('models?pageSize=200', key);
  const ok = (data.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /flash/i.test(n) && !/(lite|tts|image|live|audio|embedding|exp|preview|thinking|8b)/i.test(n));
  const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
  ok.sort((a, b) => ver(b) - ver(a) || (a.includes('latest') ? -1 : 1));
  const model = ok[0] || 'gemini-flash-latest';
  savePref('geminiModel', model);
  return model;
}

export async function testKey(key) {
  const model = await pickModel(key, true);
  await call(`models/${model}:generateContent`, key, { contents: [{ role: 'user', parts: [{ text: 'Responda apenas: ok' }] }] });
  return model;
}

// ---------- Imagem da página (sempre em papel claro, para leitura melhor) ----------
async function pageImage(page, items) {
  const W = 1400, s = W / page.w;
  const c = document.createElement('canvas');
  c.width = W; c.height = Math.round(page.h * s);
  const ctx = c.getContext('2d');
  ctx.scale(s, s);
  const light = { ...page, paperColor: '#ffffff' };
  R.drawPaper(ctx, light, s);
  if (page.pdf) {
    try { const pc = await renderPageCanvas(page, s * 1.2); ctx.drawImage(pc, 0, 0, page.w, page.h); pc.width = 0; } catch { }
  }
  const imgs = new Map();
  for (const it of items) if (it.type === 'image' && !imgs.has(it.blobId)) {
    try { const b = await store.getFileBlob(it.blobId); if (b) imgs.set(it.blobId, await createImageBitmap(b)); } catch { }
  }
  R.drawItems(ctx, R.sortItems([...items]), { getImage: id => imgs.get(id) || null, dark: false });
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  c.width = 0;
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

function prompt(path, existing) {
  return [
    'Você é um assistente de estudos. A imagem é uma página de anotações de um estudante (pode ter letra à mão, esquemas, desenhos e slides de PDF anotados).',
    path.length ? `Matéria: ${path[0]}.` + (path[1] ? ` Tema: ${path[1]}.` : '') : '',
    'Leia o conteúdo e crie flashcards para revisar esse conteúdo depois.',
    'Regras:',
    '- uma ideia por carta; pergunta curta e objetiva; resposta curta (no máximo 2 frases);',
    '- use apenas o que está na página, sem inventar nada;',
    '- escreva em português do Brasil, corrigindo erros de grafia da letra à mão;',
    '- ignore rabiscos, partes ilegíveis, datas soltas e títulos sem conteúdo;',
    '- se a página não tiver conteúdo de estudo, devolva uma lista vazia;',
    '- no máximo 10 cartas.',
    existing.length ? 'Não repita estas perguntas que já existem: ' + existing.slice(0, 60).map(q => `"${q}"`).join('; ') : '',
  ].filter(Boolean).join('\n');
}

async function askGemini(key, model, b64, path, existing) {
  const data = await call(`models/${model}:generateContent`, key, {
    contents: [{ role: 'user', parts: [{ text: prompt(path, existing) }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { pergunta: { type: 'STRING' }, resposta: { type: 'STRING' } }, required: ['pergunta', 'resposta'] } },
    },
  });
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]';
  let arr = [];
  try { arr = JSON.parse(text); } catch { arr = []; }
  return (Array.isArray(arr) ? arr : []).map(x => ({ q: String(x.pergunta || '').trim(), a: String(x.resposta || '').trim() })).filter(x => x.q && x.a).slice(0, 10);
}

// ---------- Leitura grátis sem IA ----------
// 1) Caixas de texto (digitadas ou escritas com o Pencil pelo Rabiscar) no formato "termo: definição"
const DEF_RE = /^\s*[-•*]?\s*([^:=→\n]{2,80}?)\s*(?::|=|→|->|—|–|\s-\s)\s*(.{2,300})$/;
export function definitionsFromText(text) {
  const out = [];
  for (const line of (text || '').split('\n')) {
    const m = line.match(DEF_RE);
    if (!m) continue;
    const q = m[1].trim(), a = m[2].trim();
    if (q.split(/\s+/).length > 10 || /^\d+([.,]\d+)?$/.test(q) || /^https?$/i.test(q)) continue;
    if (/^(anota[cç][aã]o|anota[cç][oõ]es|obs|observa[cç][aã]o|nota|notas|lembrar|lembrete|importante|data|dia|hora|ex|exemplo|dica|aula|p[aá]g|p[aá]gina|cap|cap[ií]tulo|tema|assunto|t[ií]tulo|prova|tarefa|li[cç][aã]o)\.?$/i.test(q.normalize('NFC'))) continue;
    out.push({ kind: 'basic', q, a });
  }
  return out;
}

// 2) Trechos do PDF marcados com marca-texto viram cartas de lacuna
async function highlightsFromPdf(page, items) {
  const hls = items.filter(it => it.type === 'stroke' && it.tool === 'highlighter');
  if (!page.pdf || !hls.length) return [];
  let doc, pp, tc;
  try {
    doc = await loadDoc(page.pdf.blobId);
    pp = await doc.getPage(page.pdf.index + 1);
    tc = await pp.getTextContent();
  } catch { return []; }
  const vp1 = pp.getViewport({ scale: 1 });
  const vp = pp.getViewport({ scale: page.w / vp1.width });
  // caixas de cada pedaço de texto em unidades da página
  const boxes = [];
  for (const t of tc.items) {
    if (!t.str || !t.str.trim()) continue;
    const [x, y] = vp.convertToViewportPoint(t.transform[4], t.transform[5]);
    const h = Math.hypot(t.transform[2], t.transform[3]) * vp.scale || 10;
    const w = (t.width || 0) * vp.scale;
    boxes.push({ str: t.str, x0: Math.min(x, x + w), x1: Math.max(x, x + w), y0: y - h, y1: y + h * 0.2, line: Math.round((y - h / 2) / Math.max(4, h * 0.6)) });
  }
  pp.cleanup();
  const out = [];
  for (const s of hls) {
    const f = geom(s).f, r = s.size / 2;
    // para cada pedaço de texto tocado, guarda até onde (na horizontal) o marca-texto passou
    const hit = new Map();
    for (let i = 0; i < f.length; i += 3) {
      const px = f[i], py = f[i + 1];
      boxes.forEach((b, k) => {
        if (px >= b.x0 - r * 0.5 && px <= b.x1 + r * 0.5 && py >= b.y0 - r * 0.6 && py <= b.y1 + r * 0.6) {
          const h = hit.get(k) || { x0: Infinity, x1: -Infinity };
          h.x0 = Math.min(h.x0, px - r * 0.3); h.x1 = Math.max(h.x1, px + r * 0.3);
          hit.set(k, h);
        }
      });
    }
    if (!hit.size) continue;
    const hb = [...hit.keys()].map(k => boxes[k]).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    // recorta só as palavras que ficaram embaixo do marca-texto
    const piece = b => {
      const h = hit.get(boxes.indexOf(b)), w = Math.max(1, b.x1 - b.x0), n = b.str.length;
      let c0 = Math.max(0, Math.floor((h.x0 - b.x0) / w * n)), c1 = Math.min(n, Math.ceil((h.x1 - b.x0) / w * n));
      while (c0 > 0 && /\S/.test(b.str[c0 - 1])) c0--;
      while (c1 < n && /\S/.test(b.str[c1])) c1++;
      return b.str.slice(c0, c1).trim();
    };
    const marked = hb.map(piece).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (marked.length < 2 || marked.length > 160) continue;
    // contexto: as linhas tocadas (e a anterior, se o trecho for a linha inteira)
    const lines = new Set(hb.map(b => b.line));
    let ctxBoxes = boxes.filter(b => lines.has(b.line)).sort((a, b) => a.line - b.line || a.x0 - b.x0);
    let context = ctxBoxes.map(b => b.str).join(' ').replace(/\s+/g, ' ').trim();
    if (context.length - marked.length < 12) {
      const prev = Math.min(...lines) - 1;
      ctxBoxes = boxes.filter(b => b.line === prev || lines.has(b.line)).sort((a, b) => a.line - b.line || a.x0 - b.x0);
      context = ctxBoxes.map(b => b.str).join(' ').replace(/\s+/g, ' ').trim();
    }
    const at = context.indexOf(marked);
    if (at < 0 || context.length - marked.length < 8) out.push({ kind: 'basic', q: 'Explique: ' + marked, a: context || marked });
    else out.push({ kind: 'cloze', before: context.slice(0, at), hidden: marked, after: context.slice(at + marked.length) });
  }
  return out;
}

// ---------- Baralho automático da matéria/tema ----------
async function findAutoDeck(subjectId, subjects) {
  const s = subjects.find(x => x.id === subjectId);
  const key = s ? s.id : '__none';
  return (await C.listDecks()).find(x => x.autoSubject === key) || null;
}

async function deckFor(subjectId, subjects) {
  const byId = new Map(subjects.map(s => [s.id, s]));
  const s = byId.get(subjectId);
  const key = s ? s.id : '__none';
  let d = await findAutoDeck(subjectId, subjects);
  if (d) return d;
  const parent = s?.parentId ? byId.get(s.parentId) : null;
  const name = s ? (parent ? `${parent.name} › ${s.name}` : s.name) : 'Anotações sem matéria';
  d = await C.createDeck(name, s ? s.id : null);
  d.autoSubject = key;
  await store.save('deck', d);
  return d;
}

const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = t => C.htmlToText(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Páginas com escrita nova ou alterada desde a última leitura
async function changedPages(force) {
  const done = (await db.getMeta('autoPages', {})) || {};
  const firstRun = !(await db.getMeta('autoCardsStarted', false));
  const since = firstRun ? now() - 3 * 86400000 : 0;
  const notes = new Map((await store.listNotes()).filter(n => !n.trashed).map(n => [n.id, n]));
  // "autoAt" fica gravado na própria página (sincroniza): PC e iPad não leem a mesma página duas vezes
  const pageAuto = new Map((await db.getAll('pages')).map(p => [p.id, p.autoAt || 0]));
  const latest = new Map();
  for (const it of await db.getAll('items')) {
    if (it.deleted || it.type === 'image' || !notes.has(it.noteId)) continue;
    const t = it.updatedAt || 0;
    if (t < since) continue;
    const readAt = Math.max(done[it.pageId] || 0, pageAuto.get(it.pageId) || 0);
    if (t > readAt && t > (latest.get(it.pageId) || 0)) latest.set(it.pageId, t);
  }
  // espera alguns minutos sem mexer na página (não lê uma página pela metade)
  const quiet = now() - (force ? 30000 : 10 * 60000);
  return [...latest.entries()].filter(([, t]) => t < quiet).sort((a, b) => a[1] - b[1]).map(([pageId, t]) => ({ pageId, t }));
}

// Roda a leitura. force = botão "Gerar agora" (ignora "uma vez por dia")
export async function run({ force = false } = {}) {
  const key = getKey();
  if (running) return null;
  if (!force && !loadPref('autoCards', true)) return null;
  // automático: no máximo uma vez por hora (só lê o que mudou desde a última vez)
  const last = await db.getMeta('autoCardsLast', null);
  if (!force && last && now() - last.at < 60 * 60000 && !last.partial) return null;
  running = true;
  autoBus.emit('state', { running: true });
  const summary = { at: now(), day: dayKey(now()), pages: 0, cards: 0, decks: [], error: null, partial: false };
  try {
    await db.setMeta('autoCardsStarted', true);
    const pages = await changedPages(force);
    if (!pages.length) return summary;
    const useAI = !!key && navigator.onLine;
    const model = useAI ? await pickModel(key) : null;
    const subjects = await store.listSubjects();
    const byId = new Map(subjects.map(s => [s.id, s]));
    const done = (await db.getMeta('autoPages', {})) || {};
    const deckNames = new Set();
    const todo = pages.slice(0, MAX_PAGES_PER_RUN);
    summary.partial = pages.length > todo.length;
    for (let i = 0; i < todo.length; i++) {
      // se você abrir uma nota, pausa (não disputa a caneta) e continua na próxima vez
      if (document.querySelector('.editor')) { summary.partial = true; break; }
      const { pageId, t } = todo[i];
      autoBus.emit('progress', { i: i + 1, n: todo.length });
      const page = await db.get('pages', pageId);
      if (!page || page.deleted) { done[pageId] = t; continue; }
      const note = await store.getNote(page.noteId);
      const items = (await db.byIndex('items', 'noteId', page.noteId)).filter(it => !it.deleted && it.pageId === pageId);
      const s = byId.get(note?.subjectId);
      const path = s ? (s.parentId && byId.get(s.parentId) ? [byId.get(s.parentId).name, s.name] : [s.name]) : [];
      // o baralho só é criado se sair alguma carta
      let deck = await findAutoDeck(note?.subjectId, subjects);
      const existing = deck ? await C.allFnotes([deck.id]) : [];
      const seen = new Set(existing.map(f => norm(f.front)));
      const cards = [];
      const hasInk = items.some(it => it.type === 'stroke' && it.tool !== 'highlighter');
      if (useAI && (hasInk || items.some(it => it.type === 'text'))) {
        const b64 = await pageImage(page, items);
        try { cards.push(...(await askGemini(key, model, b64, path, existing.map(f => C.htmlToText(f.front)))).map(c => ({ kind: 'basic', ...c }))); }
        catch (e) {
          if (e.status === 404) savePref('geminiModel', null); // modelo saiu do ar: escolhe outro na próxima
          throw e;
        }
      } else {
        for (const it of items) if (it.type === 'text') cards.push(...definitionsFromText(it.text));
      }
      // sempre (grátis, sem internet): trechos do PDF marcados com marca-texto
      cards.push(...await highlightsFromPdf(page, items));
      let added = 0;
      for (const c of cards) {
        const front = c.kind === 'cloze' ? esc(c.before) + '{{c1::' + esc(c.hidden) + '}}' + esc(c.after) : esc(c.q);
        const k = norm(front);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        if (!deck) deck = await deckFor(note?.subjectId, subjects);
        await C.saveFnote({ deckId: deck.id, type: c.kind === 'cloze' ? 'cloze' : 'basic', front, back: c.kind === 'cloze' ? '' : esc(c.a), extra: '', tags: ['auto'], auto: true, source: { noteId: page.noteId, pageId } });
        added++;
      }
      summary.pages++;
      summary.cards += added;
      if (added && deck) deckNames.add(deck.name);
      done[pageId] = Math.max(t, now());
      await db.setMeta('autoPages', done);
      page.autoAt = done[pageId];
      await store.save('page', page);
      if (useAI && i < todo.length - 1) await new Promise(r => setTimeout(r, GAP_MS));
    }
    summary.decks = [...deckNames];
  } catch (e) {
    console.warn('autocards', e);
    summary.error = e.message || String(e);
    summary.partial = true;
  } finally {
    running = false;
    if (!document.querySelector('.editor')) closeAll(); // não fecha os PDFs de uma nota aberta
    await db.setMeta('autoCardsLast', summary);
    autoBus.emit('state', { running: false, summary });
  }
  return summary;
}

export const lastRun = () => db.getMeta('autoCardsLast', null);
