// Desenho de páginas e itens (usado pelo editor, miniaturas e exportação)

import { getStroke } from '../vendor/perfect-freehand.mjs';
import { decodePts } from './util.js';

export const TEMPLATES = [
  { id: 'blank', name: 'Em branco' },
  { id: 'lined', name: 'Pautado' },
  { id: 'narrow', name: 'Pautado estreito' },
  { id: 'grid', name: 'Quadriculado' },
  { id: 'dots', name: 'Pontilhado' },
  { id: 'cornell', name: 'Cornell' },
];
export const PAPER_COLORS = [
  { c: '#ffffff', name: 'Branco' },
  { c: '#fbf6e9', name: 'Creme' },
  { c: '#fff8d6', name: 'Amarelo' },
  { c: '#eef1f5', name: 'Cinza' },
  { c: '#2a2c31', name: 'Escuro' },
];
export const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';

export function isDarkColor(hex) {
  const n = parseInt((hex || '#ffffff').slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 < 110;
}

// ---------- Geometria dos traços ----------
export function strokeOpts(it, last = true) {
  return {
    size: it.size,
    thinning: it.sim ? 0.5 : 0.6,
    smoothing: 0.55,
    streamline: 0.22, // menos "arrasto": o traço acompanha a ponta do Pencil
    simulatePressure: !!it.sim,
    easing: t => t,
    start: { taper: 0, cap: true },
    end: { taper: 0, cap: true },
    last,
  };
}

export function toPointArray(f) {
  const a = new Array(f.length / 3);
  for (let i = 0, j = 0; i < f.length; i += 3, j++) a[j] = [f[i], f[i + 1], f[i + 2]];
  return a;
}

export function outlinePath(outline) {
  const p = new Path2D();
  const n = outline.length;
  if (!n) return p;
  p.moveTo(outline[0][0], outline[0][1]);
  for (let i = 0; i < n; i++) {
    const a = outline[i], b = outline[(i + 1) % n];
    p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  p.closePath();
  return p;
}

export function polylinePath(f) {
  const p = new Path2D();
  const n = f.length / 3;
  if (!n) return p;
  p.moveTo(f[0], f[1]);
  if (n === 1) { p.lineTo(f[0] + 0.01, f[1]); return p; }
  for (let i = 1; i < n - 1; i++) {
    const x = f[i * 3], y = f[i * 3 + 1], nx = f[i * 3 + 3], ny = f[i * 3 + 4];
    p.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  p.lineTo(f[(n - 1) * 3], f[(n - 1) * 3 + 1]);
  return p;
}

// Formas (linha, círculo, retângulo...): segmentos retos, cantos preservados
export function straightPath(f) {
  const p = new Path2D();
  const n = f.length / 3;
  if (!n) return p;
  p.moveTo(f[0], f[1]);
  for (let i = 1; i < n; i++) p.lineTo(f[i * 3], f[i * 3 + 1]);
  if (n === 1) p.lineTo(f[0] + 0.01, f[1]);
  return p;
}

const geomCache = new WeakMap();
export function geom(it) {
  let g = geomCache.get(it);
  if (g && g.pts === it.pts && g.size === it.size && g.tool === it.tool) return g;
  const f = decodePts(it.pts);
  const path = it.shape ? straightPath(f) : it.tool === 'highlighter' ? polylinePath(f) : outlinePath(getStroke(toPointArray(f), strokeOpts(it)));
  g = { pts: it.pts, size: it.size, tool: it.tool, f, path };
  geomCache.set(it, g);
  return g;
}

export function computeBBox(f, size) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < f.length; i += 3) {
    const x = f[i], y = f[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const m = size / 2 + 1;
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}

// ---------- Texto ----------
const measureCtx = document.createElement('canvas').getContext('2d');
const textCache = new WeakMap();
export function textLayout(it) {
  let c = textCache.get(it);
  if (c && c.text === it.text && c.w === it.w && c.fs === it.fontSize) return c;
  measureCtx.font = `${it.fontSize}px ${FONT}`;
  const lines = [];
  for (const para of (it.text || '').split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && measureCtx.measureText(test).width > it.w) {
        lines.push(line.trimEnd());
        line = w.trimStart();
        // palavra maior que a caixa: quebra por caractere
        while (measureCtx.measureText(line).width > it.w && line.length > 1) {
          let k = line.length - 1;
          while (k > 1 && measureCtx.measureText(line.slice(0, k)).width > it.w) k--;
          lines.push(line.slice(0, k));
          line = line.slice(k);
        }
      } else line = test;
    }
    lines.push(line);
  }
  const lh = it.fontSize * 1.3;
  c = { text: it.text, w: it.w, fs: it.fontSize, lines, lh, h: Math.max(lh, lines.length * lh) };
  textCache.set(it, c);
  return c;
}

export function itemBBox(it) {
  if (it.type === 'stroke') return it.bbox;
  if (it.type === 'text') { const l = textLayout(it); return [it.x, it.y, it.x + it.w, it.y + l.h]; }
  return [it.x, it.y, it.x + it.w, it.y + it.h];
}

// ---------- Papel ----------
export function drawPaper(ctx, page, scale = 1) {
  const { w, h } = page;
  ctx.fillStyle = page.pdf ? '#ffffff' : (page.paperColor || '#ffffff');
  ctx.fillRect(0, 0, w, h);
  if (page.pdf) return;
  const dark = isDarkColor(page.paperColor);
  const lw = Math.max(1.1, 0.6 / scale);
  const lineCol = dark ? 'rgba(255,255,255,0.13)' : 'rgba(70,110,190,0.22)';
  const marginCol = dark ? 'rgba(255,120,120,0.30)' : 'rgba(220,70,70,0.33)';
  const t = page.template;
  ctx.lineWidth = lw;
  if (t === 'lined' || t === 'narrow' || t === 'cornell') {
    const sp = t === 'narrow' ? 36 : 46, top = t === 'cornell' ? 150 : 140;
    const bottom = t === 'cornell' ? h - 300 : h - 50;
    ctx.beginPath();
    for (let y = top; y < bottom; y += sp) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.strokeStyle = lineCol; ctx.stroke();
    ctx.beginPath();
    if (t === 'cornell') {
      ctx.moveTo(320, 100); ctx.lineTo(320, h - 300);
      ctx.moveTo(0, h - 300); ctx.lineTo(w, h - 300);
      ctx.moveTo(0, 100); ctx.lineTo(w, 100);
    } else { ctx.moveTo(110, 0); ctx.lineTo(110, h); }
    ctx.strokeStyle = marginCol; ctx.lineWidth = lw * 1.2; ctx.stroke();
  } else if (t === 'grid') {
    const sp = 40;
    ctx.beginPath();
    for (let x = sp; x < w; x += sp) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = sp; y < h; y += sp) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.strokeStyle = lineCol; ctx.stroke();
  } else if (t === 'dots') {
    if (scale < 0.18) return;
    const sp = 40, r = Math.max(1.8, 0.9 / scale);
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(60,70,90,0.35)';
    ctx.beginPath();
    for (let y = sp; y < h; y += sp) for (let x = sp; x < w; x += sp) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
    ctx.fill();
  }
}

// ---------- Itens ----------
const LAYER = { image: 0, hl: 1, pen: 2, text: 3 };
export function layerOf(it) {
  if (it.type === 'stroke') return it.tool === 'highlighter' ? LAYER.hl : LAYER.pen;
  return LAYER[it.type] ?? 2;
}
export function sortItems(arr) {
  return arr.sort((a, b) => layerOf(a) - layerOf(b) || a.z - b.z);
}

// opts: { view:[x0,y0,x1,y1], skip:Set, playback:{recId,t}, getImage(blobId), dark, editingId }
export function drawItems(ctx, items, opts = {}) {
  const v = opts.view;
  for (const it of items) {
    if (opts.skip && opts.skip.has(it.id)) continue;
    if (opts.editingId === it.id) continue;
    if (v) {
      const b = itemBBox(it);
      if (b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3]) continue;
    }
    drawItem(ctx, it, opts);
  }
}

function luminance(hex) {
  const n = parseInt((hex || '#000000').slice(1, 7), 16);
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
}
// No papel escuro, tinta preta aparece clara (e volta a ser preta no papel claro)
export function inkColor(c, dark) {
  return dark && c && c[0] === '#' && luminance(c) < 45 ? '#ececef' : c;
}

export function drawItem(ctx, it, opts = {}) {
  let alpha = 1;
  const pb = opts.playback;
  if (pb && it.rec && it.rec.id === pb.recId && it.rec.t0 > pb.t) alpha = 0.16;
  if (it.type === 'stroke') {
    const g = geom(it);
    if (it.tool === 'highlighter') {
      ctx.globalAlpha = 0.38 * alpha;
      ctx.globalCompositeOperation = opts.dark ? 'source-over' : 'multiply';
      ctx.strokeStyle = it.color;
      ctx.lineWidth = it.size;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke(g.path);
      ctx.globalCompositeOperation = 'source-over';
    } else if (it.shape) {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = inkColor(it.color, opts.dark);
      ctx.lineWidth = it.size;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke(g.path);
    } else {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = inkColor(it.color, opts.dark);
      ctx.fill(g.path);
    }
    ctx.globalAlpha = 1;
  } else if (it.type === 'text') {
    const l = textLayout(it);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = inkColor(it.color, opts.dark);
    ctx.font = `${it.fontSize}px ${FONT}`;
    ctx.textBaseline = 'top';
    for (let i = 0; i < l.lines.length; i++) ctx.fillText(l.lines[i], it.x, it.y + i * l.lh + it.fontSize * 0.12);
    ctx.globalAlpha = 1;
  } else if (it.type === 'image') {
    const img = opts.getImage?.(it.blobId);
    if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h);
    else {
      ctx.fillStyle = 'rgba(0,0,0,0.06)';
      ctx.fillRect(it.x, it.y, it.w, it.h);
    }
  }
}

// Distância de um ponto a um traço (para borracha e toque no áudio)
export function strokeHit(it, x, y, r) {
  const b = it.bbox;
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const f = geom(it).f;
  const rr = r + it.size / 2;
  const rr2 = rr * rr;
  const n = f.length / 3;
  if (n === 1) return (f[0] - x) ** 2 + (f[1] - y) ** 2 <= rr2;
  for (let i = 0; i < n - 1; i++) {
    const ax = f[i * 3], ay = f[i * 3 + 1], bx = f[i * 3 + 3], by = f[i * 3 + 4];
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy;
    let t = L ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx - x, py = ay + t * dy - y;
    if (px * px + py * py <= rr2) return true;
  }
  return false;
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
