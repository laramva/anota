// Renderização de PDFs com pdf.js (com cache e "tile" de detalhe para zoom)

import { getFileData } from './store.js';

const pdfjs = window.pdfjsLib;
pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const MAX_BASE_PX = 3_500_000;
const MAX_ENTRIES = 10;

const docs = new Map();   // blobId -> Promise<PDFDocumentProxy>
const base = new Map();   // pageId -> { u, canvas, used }
const detail = new Map(); // pageId -> { u, rect, canvas }
const queue = new Map();  // chave -> job
let busy = false;
let onReady = () => { };

export function setReadyCallback(fn) { onReady = fn; }

export function loadDoc(blobId) {
  if (!docs.has(blobId)) {
    const p = (async () => {
      const f = await getFileData(blobId);
      if (!f) throw new Error('PDF não disponível neste aparelho ainda');
      return pdfjs.getDocument({ data: new Uint8Array(f.data.slice(0)), isEvalSupported: false }).promise;
    })();
    p.catch(() => docs.delete(blobId));
    docs.set(blobId, p);
  }
  return docs.get(blobId);
}

// Lê o PDF e devolve o tamanho de cada página (em pontos)
export async function readPdfInfo(data) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false }).promise;
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
    p.cleanup();
  }
  await doc.destroy();
  return sizes;
}

function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; } }

function evict() {
  if (base.size <= MAX_ENTRIES) return;
  const arr = [...base.entries()].sort((a, b) => a[1].used - b[1].used);
  while (arr.length > MAX_ENTRIES) {
    const [id, e] = arr.shift();
    freeCanvas(e.canvas);
    base.delete(id);
  }
}

// u = pixels por unidade da página desejados
export function getBase(page, u) {
  const capU = Math.sqrt(MAX_BASE_PX / (page.w * page.h));
  const want = Math.min(u, capU);
  const e = base.get(page.id);
  if (e) e.used = performance.now();
  if (!e || (e.u < want * 0.8 && !queue.has('b' + page.id))) {
    enqueue('b' + page.id, { kind: 'base', page, u: want });
  }
  return e ? e.canvas : null;
}

export function needsDetail(page, u) {
  const capU = Math.sqrt(MAX_BASE_PX / (page.w * page.h));
  return u > capU * 1.05;
}

// rect = área visível da página em unidades locais
export function getDetail(page, u, rect, settled) {
  const e = detail.get(page.id);
  const ok = e && e.u >= u * 0.85 && e.u <= u * 1.6 &&
    e.rect[0] <= rect[0] + 1 && e.rect[1] <= rect[1] + 1 && e.rect[2] >= rect[2] - 1 && e.rect[3] >= rect[3] - 1;
  if (!ok && settled) {
    const pad = 0.15;
    const w = rect[2] - rect[0], h = rect[3] - rect[1];
    const r = [Math.max(0, rect[0] - w * pad), Math.max(0, rect[1] - h * pad), Math.min(page.w, rect[2] + w * pad), Math.min(page.h, rect[3] + h * pad)];
    enqueue('d' + page.id, { kind: 'detail', page, u, rect: r });
  }
  return e || null;
}

export function dropDetail(pageId) {
  const e = detail.get(pageId);
  if (e) { freeCanvas(e.canvas); detail.delete(pageId); }
}

function enqueue(key, job) {
  job.t = performance.now();
  queue.set(key, job);
  pump();
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.size) {
      // prioriza o pedido mais recente
      let key = null, job = null;
      for (const [k, j] of queue) if (!job || j.t > job.t) { key = k; job = j; }
      queue.delete(key);
      try { await run(job); onReady(); } catch (e) { console.warn('pdf render', e); }
    }
  } finally { busy = false; }
}

// Renderiza com limite de tempo: se travar, cancela e libera a fila
function renderWithTimeout(pp, params, ms = 20000) {
  const task = pp.render(params);
  let timer;
  return Promise.race([
    task.promise,
    new Promise((_, rej) => { timer = setTimeout(() => { try { task.cancel(); } catch { } rej(new Error('render timeout')); }, ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function run(job) {
  const { page } = job;
  const doc = await loadDoc(page.pdf.blobId);
  const pp = await doc.getPage(page.pdf.index + 1);
  const vp1 = pp.getViewport({ scale: 1 });
  const s = (page.w * job.u) / vp1.width;
  const vp = pp.getViewport({ scale: s });
  const canvas = document.createElement('canvas');
  if (job.kind === 'base') {
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    await renderWithTimeout(pp, { canvasContext: canvas.getContext('2d'), viewport: vp });
    const old = base.get(page.id);
    if (old) freeCanvas(old.canvas);
    base.set(page.id, { u: job.u, canvas, used: performance.now() });
    evict();
  } else {
    const [x0, y0, x1, y1] = job.rect;
    canvas.width = Math.ceil((x1 - x0) * job.u); canvas.height = Math.ceil((y1 - y0) * job.u);
    await renderWithTimeout(pp, { canvasContext: canvas.getContext('2d'), viewport: vp, transform: [1, 0, 0, 1, -x0 * job.u, -y0 * job.u] });
    dropDetail(page.id);
    detail.set(page.id, { u: job.u, rect: job.rect, canvas });
  }
  pp.cleanup();
}

// Renderiza uma página isolada (miniatura / exportação)
export async function renderPageCanvas(page, u) {
  const doc = await loadDoc(page.pdf.blobId);
  const pp = await doc.getPage(page.pdf.index + 1);
  const vp1 = pp.getViewport({ scale: 1 });
  const vp = pp.getViewport({ scale: (page.w * u) / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  await renderWithTimeout(pp, { canvasContext: c.getContext('2d'), viewport: vp }, 10000);
  pp.cleanup();
  return c;
}

export function closeAll() {
  queue.clear();
  for (const e of base.values()) freeCanvas(e.canvas);
  for (const e of detail.values()) freeCanvas(e.canvas);
  base.clear(); detail.clear();
  for (const p of docs.values()) p.then(d => d.destroy()).catch(() => { });
  docs.clear();
}
