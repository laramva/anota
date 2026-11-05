// Importar PDF, exportar PDF (vetorial), miniaturas e backup completo (.zip)

import * as db from './db.js';
import * as store from './store.js';
import * as R from './render.js';
import { readPdfInfo, renderPageCanvas } from './pdfview.js';
import { getStroke } from '../vendor/perfect-freehand.mjs';
import { uid, now, el } from './util.js';
import { modal, toast } from './ui.js';

// ---------- Importar PDF ----------
export async function addPdfPages(noteId, file, orderAfter, orderBefore, progress = () => { }) {
  const data = await file.arrayBuffer();
  progress('Lendo páginas…');
  const sizes = await readPdfInfo(data);
  if (!sizes.length) throw new Error('PDF vazio');
  const blob = await store.createBlob({ noteId, data, mime: 'application/pdf', name: file.name });
  const step = (orderBefore - orderAfter) / (sizes.length + 1);
  const pages = sizes.map((s, i) => ({
    id: uid(), noteId, order: orderAfter + step * (i + 1), template: 'blank', paperColor: '#ffffff',
    w: store.PAGE_W, h: Math.round(store.PAGE_W * s.h / s.w), pdf: { blobId: blob.id, index: i }, deleted: false,
  }));
  await store.saveMany('page', pages);
  return pages;
}

export async function importPdfAsNote(file, subjectId, progress) {
  const title = file.name.replace(/\.pdf$/i, '') || 'PDF';
  const note = await store.save('note', { id: uid(), title, subjectId, createdAt: now(), trashed: false, deleted: false, thumb: null, lastOpenedAt: now() });
  await addPdfPages(note.id, file, 0, 1000, progress);
  const pages = await store.getPages(note.id);
  try { note.thumb = await renderThumb(pages[0], [], () => null); await store.save('note', note); } catch { }
  return note;
}

// ---------- Miniatura ----------
export async function renderThumb(page, items, getImage) {
  const W = 300, s = W / page.w;
  const c = document.createElement('canvas');
  c.width = W; c.height = Math.round(page.h * s);
  const ctx = c.getContext('2d');
  ctx.scale(s, s);
  R.drawPaper(ctx, page, s);
  if (page.pdf) {
    const pc = await renderPageCanvas(page, s * 1.5);
    ctx.drawImage(pc, 0, 0, page.w, page.h);
    pc.width = 0;
  }
  R.drawItems(ctx, R.sortItems([...items]), { getImage, dark: !page.pdf && R.isDarkColor(page.paperColor) });
  return c.toDataURL('image/jpeg', 0.72);
}

// ---------- Exportar PDF ----------
function parseColor(c) {
  const { rgb } = window.PDFLib;
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return { color: rgb((n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255), alpha: 1 };
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  return { color: rgb(r / 255, g / 255, b / 255), alpha: a };
}

// "Contexto" falso que converte os comandos de desenho do papel em caminhos SVG para o pdf-lib
class PdfPathCtx {
  constructor(pg, map) { this.pg = pg; this.map = map; this.d = ''; this.fillStyle = '#000'; this.strokeStyle = '#000'; this.lineWidth = 1; }
  pt(x, y) { const [X, Y] = this.map(x, y); return `${X.toFixed(2)} ${(-Y).toFixed(2)}`; }
  beginPath() { this.d = ''; }
  moveTo(x, y) { this.d += `M${this.pt(x, y)}`; }
  lineTo(x, y) { this.d += `L${this.pt(x, y)}`; }
  arc(x, y, r) { // apenas círculos completos (pontos do papel): aproximado por quadrado pequeno
    this.d += `M${this.pt(x - r, y - r)}L${this.pt(x + r, y - r)}L${this.pt(x + r, y + r)}L${this.pt(x - r, y + r)}Z`;
  }
  fillRect(x, y, w, h) { this.beginPath(); this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.d += 'Z'; this.fill(); }
  stroke() {
    if (!this.d) return;
    const { color, alpha } = parseColor(this.strokeStyle);
    this.pg.drawSvgPath(this.d, { x: 0, y: 0, borderColor: color, borderOpacity: alpha, borderWidth: this.lineWidth * this.s });
  }
  fill() {
    if (!this.d) return;
    const { color, alpha } = parseColor(this.fillStyle);
    this.pg.drawSvgPath(this.d, { x: 0, y: 0, color, opacity: alpha, borderWidth: 0 });
  }
}

function outlineToSvg(outline, map) {
  const n = outline.length;
  if (!n) return '';
  const P = (x, y) => { const [X, Y] = map(x, y); return `${X.toFixed(2)} ${(-Y).toFixed(2)}`; };
  let d = `M${P(outline[0][0], outline[0][1])}`;
  for (let i = 0; i < n; i++) {
    const a = outline[i], b = outline[(i + 1) % n];
    d += `Q${P(a[0], a[1])} ${P((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)}`;
  }
  return d + 'Z';
}
function polylineToSvg(f, map) {
  const P = (x, y) => { const [X, Y] = map(x, y); return `${X.toFixed(2)} ${(-Y).toFixed(2)}`; };
  const n = f.length / 3;
  let d = `M${P(f[0], f[1])}`;
  if (n === 1) return d + `L${P(f[0] + 0.1, f[1])}`;
  for (let i = 1; i < n; i++) d += `L${P(f[i * 3], f[i * 3 + 1])}`;
  return d;
}

export async function exportNotePdf(note, progress = () => { }) {
  const { PDFDocument, StandardFonts, degrees, BlendMode, LineCapStyle } = window.PDFLib;
  const out = await PDFDocument.create();
  out.setTitle(note.title || 'Nota');
  out.setCreator('Anota');
  const font = await out.embedFont(StandardFonts.Helvetica);
  const charset = new Set(font.getCharacterSet());
  const safe = s => [...s].map(ch => charset.has(ch.codePointAt(0)) ? ch : '?').join('');
  const pages = await store.getPages(note.id);
  const allItems = await store.getItems(note.id);
  const srcDocs = new Map();
  const imgCache = new Map();

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    progress(`Página ${pi + 1} de ${pages.length}…`);
    let pg, crop, rot = 0;
    if (page.pdf) {
      let src = srcDocs.get(page.pdf.blobId);
      if (!src) {
        const f = await store.getFileData(page.pdf.blobId);
        if (!f) throw new Error('PDF original não está neste aparelho');
        src = await PDFDocument.load(f.data, { ignoreEncryption: true });
        srcDocs.set(page.pdf.blobId, src);
      }
      [pg] = await out.copyPages(src, [page.pdf.index]);
      out.addPage(pg);
      crop = pg.getCropBox();
      rot = ((pg.getRotation().angle % 360) + 360) % 360;
    } else {
      const pw = page.w * 0.48, ph = page.h * 0.48;
      pg = out.addPage([pw, ph]);
      crop = { x: 0, y: 0, width: pw, height: ph };
    }
    const dispW = rot % 180 ? crop.height : crop.width;
    const s = dispW / page.w;
    const { x: cx, y: cy, width: cw, height: ch } = crop;
    // unidades da página -> espaço do PDF, respeitando rotação
    const map = (u, v) => {
      const dx = u * s, dy = v * s;
      if (rot === 90) return [cx + dy, cy + dx];
      if (rot === 180) return [cx + cw - dx, cy + dy];
      if (rot === 270) return [cx + cw - dy, cy + ch - dx];
      return [cx + dx, cy + ch - dy];
    };
    if (!page.pdf) {
      const pctx = new PdfPathCtx(pg, map);
      pctx.s = s;
      R.drawPaper(pctx, page, 1);
    }
    const items = R.sortItems(allItems.filter(i => i.pageId === page.id));
    const dark = !page.pdf && R.isDarkColor(page.paperColor);
    for (const it of items) {
      if (it.type === 'stroke') {
        const g = R.geom(it);
        const { color } = parseColor(it.tool === 'highlighter' ? it.color : R.inkColor(it.color, dark));
        if (it.tool === 'highlighter') {
          pg.drawSvgPath(polylineToSvg(g.f, map), {
            x: 0, y: 0, borderColor: color, borderWidth: it.size * s, borderOpacity: 0.38,
            borderLineCap: LineCapStyle?.Round ?? 1, blendMode: BlendMode?.Multiply,
          });
        } else if (it.shape) {
          pg.drawSvgPath(polylineToSvg(g.f, map), { x: 0, y: 0, borderColor: color, borderWidth: it.size * s, borderLineCap: LineCapStyle?.Round ?? 1 });
        } else {
          const outline = getStroke(R.toPointArray(g.f), R.strokeOpts(it));
          if (outline.length) pg.drawSvgPath(outlineToSvg(outline, map), { x: 0, y: 0, color, borderWidth: 0 });
        }
      } else if (it.type === 'text') {
        const l = R.textLayout(it);
        const { color } = parseColor(R.inkColor(it.color, dark));
        l.lines.forEach((line, i) => {
          if (!line) return;
          const [X, Y] = map(it.x, it.y + i * l.lh + it.fontSize * 0.12 + it.fontSize * 0.8);
          pg.drawText(safe(line), { x: X, y: Y, size: it.fontSize * s, font, color, rotate: degrees(rot) });
        });
      } else if (it.type === 'image') {
        let img = imgCache.get(it.blobId);
        if (!img) {
          const f = await store.getFileData(it.blobId);
          if (!f) continue;
          if (f.mime === 'image/jpeg') img = await out.embedJpg(f.data);
          else if (f.mime === 'image/png') img = await out.embedPng(f.data);
          else img = await out.embedPng(await toPng(f));
          imgCache.set(it.blobId, img);
        }
        const [X, Y] = map(it.x, it.y + it.h);
        pg.drawImage(img, { x: X, y: Y, width: it.w * s, height: it.h * s, rotate: degrees(rot) });
      }
    }
  }
  progress('Finalizando…');
  const bytes = await out.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

async function toPng(f) {
  const url = URL.createObjectURL(new Blob([f.data], { type: f.mime }));
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    return b.arrayBuffer();
  } finally { URL.revokeObjectURL(url); }
}

// ---------- Compartilhar / baixar ----------
export async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  const tryShare = async () => {
    await navigator.share({ files: [file], title: name });
  };
  if (navigator.canShare?.({ files: [file] })) {
    try { await tryShare(); return; } catch (e) {
      if (e.name === 'AbortError') return;
      // o iPad exige um toque novo para compartilhar depois de um processamento longo
      return new Promise(res => {
        const m = modal(el('div', {},
          el('h3', {}, 'Arquivo pronto'),
          el('p', { class: 'muted' }, name),
          el('div', { class: 'modal-actions' },
            el('button', { class: 'btn', onclick: () => { m.close(); download(blob, name); res(); } }, 'Baixar'),
            el('button', { class: 'btn primary', onclick: async () => { m.close(); try { await tryShare(); } catch (err) { if (err.name !== 'AbortError') download(blob, name); } res(); } }, 'Compartilhar / Salvar em Arquivos'))));
      });
    }
  }
  download(blob, name);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
}

// ---------- Backup completo ----------
export async function exportBackup(progress = () => { }) {
  const { Zip, ZipPassThrough, strToU8 } = window.fflate;
  const data = {};
  for (const s of db.SYNCED) data[s] = (await db.getAll(s)).filter(r => !r.deleted).map(store.strip);
  const chunks = [];
  let finished;
  const done = new Promise((res, rej) => { finished = { res, rej }; });
  const zip = new Zip((err, chunk, final) => {
    if (err) return finished.rej(err);
    chunks.push(chunk);
    if (final) finished.res();
  });
  const add = (name, u8) => { const f = new ZipPassThrough(name); zip.add(f); f.push(u8, true); };
  add('anota.json', strToU8(JSON.stringify({ app: 'anota', version: 1, exportedAt: now(), data })));
  const blobs = data.blobs;
  let missing = 0;
  for (let i = 0; i < blobs.length; i++) {
    progress(`Arquivos ${i + 1} de ${blobs.length}…`);
    let f = null;
    try { f = await store.getFileData(blobs[i].id); } catch { }
    if (!f) { missing++; continue; }
    add('files/' + blobs[i].id, new Uint8Array(f.data));
  }
  zip.end();
  await done;
  await db.setMeta('lastBackupAt', now());
  return { blob: new Blob(chunks, { type: 'application/zip' }), missing };
}

export async function importBackup(file, progress = () => { }) {
  const { unzipSync, strFromU8 } = window.fflate;
  progress('Lendo arquivo…');
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const json = files['anota.json'];
  if (!json) throw new Error('Este arquivo não é um backup do Anota.');
  const { data } = JSON.parse(strFromU8(json));
  let added = 0;
  for (const s of db.SYNCED) {
    const recs = data[s] || [];
    const toPut = [];
    for (const r of recs) {
      const local = await db.get(s, r.id);
      if (local && (local.updatedAt || 0) >= (r.updatedAt || 0)) continue;
      const rec = { ...r, _dirty: 1 };
      if (s === 'blobs') { rec._needsUpload = 1; rec._have = files['files/' + r.id] ? 1 : 0; }
      if (local?._cam) rec._cam = local._cam;
      toPut.push(rec);
    }
    await db.putMany(s, toPut);
    added += toPut.length;
  }
  progress('Restaurando arquivos…');
  for (const b of data.blobs || []) {
    const u8 = files['files/' + b.id];
    if (!u8) continue;
    if (await db.get('files', b.id)) continue;
    await db.put('files', { id: b.id, data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), mime: b.mime });
  }
  store.bus.emit('dirty');
  store.bus.emit('remote', (data.notes || []).map(n => n.id));
  return added;
}
