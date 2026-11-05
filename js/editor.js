// Editor de notas: Apple Pencil, gestos, ferramentas, áudio sincronizado

import * as store from './store.js';
import * as pdf from './pdfview.js';
import * as R from './render.js';
import * as audio from './audio.js';
import { el, uid, now, clamp, encodePts, loadPref, savePref, fmtTime, debounce, isIPad, defaultPaper } from './util.js';
import { icon, iconBtn, toast, menu, popover, closeMenu, promptText, confirmBox, pickFile, busy, cssVar } from './ui.js';
import { getStroke } from '../vendor/perfect-freehand.mjs';
import { addPdfPages, exportNotePdf, shareOrDownload, renderThumb } from './export.js';
import { recognize, densifyLine } from './shapes.js';
import { openCardEditor, selectionImage } from './cards-ui.js';
import { editorTips } from './help.js';

const GAP = 36, TOP = 28;

const DEFAULT_CFG = {
  pen: { color: '#1d1d1f', colors: ['#1d1d1f', '#1a5fd0', '#d63031', '#1f9d55', '#7b3fd3', '#e67e22', '#8e8e93', '#e84393', '#00a3a3'], sizes: [2, 3.5, 6], si: 1 },
  highlighter: { color: '#ffe14d', colors: ['#ffe14d', '#7bed9f', '#ff9ff3', '#74b9ff', '#ffbe76', '#c8a2ff'], sizes: [14, 22, 34], si: 1 },
  text: { color: '#1d1d1f', colors: ['#1d1d1f', '#1a5fd0', '#d63031', '#1f9d55', '#7b3fd3', '#e67e22'], sizes: [20, 28, 40], si: 1 },
  eraser: { mode: 'stroke', sizes: [12, 28, 60], si: 1 },
};

export class Editor {
  static clipboard = null;

  constructor(root, note, { onExit }) {
    this.root = root;
    this.note = note;
    this.onExit = onExit;
    this.cfg = Object.assign(structuredClone(DEFAULT_CFG), loadPref('toolcfg', {}));
    this.tool = loadPref('tool', 'pen');
    this.fingerDraw = loadPref('fingerDraw', false);
    this.cam = { x: 0, y: 0, z: 1 };
    this.items = new Map();
    this.byPage = new Map();
    this.sortDirty = new Set();
    this.undoStack = []; this.redoStack = [];
    this.touches = new Map();
    this.ignored = new Set();
    this.images = new Map();
    this.pending = new Set();
    this.changed = false;
    this.penDown = false; this.lastPenUp = 0; this.penSeen = false;
    this.lastGestureT = 0;
    this.player = null;
    this.cleanup = [];
  }

  // ---------- Carregamento ----------
  async init() {
    this.buildDom();
    await this.loadData();
    this.layout();
    this.resize();
    const saved = this.note._cam;
    if (saved && saved.fit) { this.fitWidth(false); this.cam.y = saved.y; }
    else if (saved) this.cam = { x: saved.x, y: saved.y, z: saved.z };
    else this.fitWidth(true);
    this.clampCam();
    this.render();
    this.bindEvents();
    pdf.setReadyCallback(() => this.requestRender());
    this.unsubs = [
      store.bus.on('remote', ids => { if (ids.includes(this.note.id)) this.reloadFromRemote(); }),
      audio.audioBus.on('change', () => this.updateRecUi()),
      audio.audioBus.on('interrupted', () => { toast('A gravação foi encerrada e salva porque o app saiu da tela.'); this.loadRecordings(); }),
      audio.audioBus.on('interim', t => this.showCaption(null, t)),
      audio.audioBus.on('transcript', segs => this.showCaption(segs[segs.length - 1]?.text, '')),
      audio.audioBus.on('transcript-error', () => { if (!this._srWarned) { this._srWarned = true; toast('A transcrição não está disponível agora (precisa de internet e do Ditado do iPad ligado). O áudio continua gravando.', { timeout: 7000 }); } }),
    ];
    this.updateRecUi();
    const jump = location.hash.match(/\/p\/([\w-]+)/);
    if (jump) { const p = this.pages.find(x => x.id === jump[1]); if (p) this.goToPage(p); }
    if (!loadPref('editorTips', false)) {
      const t = editorTips(() => { savePref('editorTips', true); t.remove(); });
      this.stage.append(t);
    }
  }

  showCaption(final, interim) {
    if (!this.liveCap) return;
    if (final != null) this._capFinal = final;
    this.liveCap.replaceChildren(el('span', { class: 'cap-dot' }), el('span', {}, (this._capFinal || '') + (interim ? ' ' : ''), el('i', {}, interim || '')));
  }

  async loadData() {
    this.pages = await store.getPages(this.note.id);
    if (!this.pages.length) {
      this.pages = [await store.createPage(this.note.id, { order: 1 })];
    }
    this.items.clear(); this.byPage.clear();
    for (const p of this.pages) this.byPage.set(p.id, []);
    for (const it of await store.getItems(this.note.id)) this.addMem(it);
    await this.loadRecordings();
  }

  async loadRecordings() {
    this.recordings = await store.getRecordings(this.note.id);
    this.updateRecUi();
  }

  async reloadFromRemote() {
    if (this.live || this.erase || this.lasso || this.selDrag || this.editing) {
      clearTimeout(this._reloadT);
      this._reloadT = setTimeout(() => this.reloadFromRemote(), 1500);
      return;
    }
    const note = await store.getNote(this.note.id);
    if (note) { note._cam = this.note._cam; this.note = note; this.titleBtn.textContent = note.title; }
    this.clearSel();
    await this.loadData();
    this.undoStack = []; this.redoStack = [];
    this.updateUndoUi();
    this.layout(); this.clampCam(); this.requestRender();
  }

  // ---------- Memória ----------
  addMem(it) {
    this.items.set(it.id, it);
    let arr = this.byPage.get(it.pageId);
    if (!arr) { arr = []; this.byPage.set(it.pageId, arr); }
    arr.push(it);
    this.sortDirty.add(it.pageId);
  }
  removeMem(it) {
    this.items.delete(it.id);
    const arr = this.byPage.get(it.pageId);
    if (arr) { const i = arr.indexOf(it); if (i >= 0) arr.splice(i, 1); }
  }
  pageItems(pageId) {
    const arr = this.byPage.get(pageId) || [];
    if (this.sortDirty.has(pageId)) { R.sortItems(arr); this.sortDirty.delete(pageId); }
    return arr;
  }

  persist(kind, recs) {
    if (!recs.length) return;
    this.changed = true;
    if (this.pagesOpen && kind === 'item') {
      this._thumbIds = this._thumbIds || new Set();
      for (const r of recs) this._thumbIds.add(r.pageId);
      this.refreshThumbs(this._thumbIds);
    }
    const p = store.saveMany(kind, recs).catch(e => {
      console.error(e);
      toast('ERRO ao salvar no iPad: ' + (e?.name === 'QuotaExceededError' ? 'espaço cheio' : e?.message || e), { kind: 'error', timeout: 8000 });
    }).finally(() => this.pending.delete(p));
    this.pending.add(p);
    this.touchNote();
  }
  touchNote = debounce(() => { store.save('note', this.note).catch(() => { }); }, 3000);

  // ---------- DOM ----------
  buildDom() {
    const r = this.root;
    r.innerHTML = '';
    r.className = 'editor';

    this.titleBtn = el('button', { class: 'ed-title', onclick: () => this.rename() }, this.note.title);
    this.toolBtns = {};
    // botões com nome embaixo do ícone (fica claro o que cada um faz)
    const lb = (ic, label, onClick, cls = '') => el('button', { class: 'lbtn ' + cls, title: label, 'aria-label': label, onclick: onClick }, icon(ic, 21), el('span', { class: 'lbl' }, label));
    const tools = [['pen', 'pen', 'Caneta'], ['highlighter', 'highlighter', 'Marca-texto'], ['eraser', 'eraser', 'Borracha'], ['lasso', 'lasso', 'Laço'], ['text', 'text', 'Texto']];
    const toolGroup = el('div', { class: 'tool-group' });
    for (const [id, ic, label] of tools) {
      const b = lb(ic, label, () => {
        if (this.tool === id && id !== 'lasso') this.openToolSettings(b);
        else this.setTool(id);
      }, 'tool');
      this.toolBtns[id] = b;
      toolGroup.append(b);
    }
    this.insertBtn = lb('plus', 'Inserir', e => this.openInsertMenu(e.currentTarget), 'insert');

    this.swatch = el('button', { class: 'swatch-btn', title: 'Cor', onclick: e => this.openToolSettings(e.currentTarget) });
    this.sizeGroup = el('div', { class: 'size-group' });
    this.undoBtn = iconBtn('undo', 'Desfazer', () => this.undo());
    this.redoBtn = iconBtn('redo', 'Refazer', () => this.redo());
    this.recBtn = el('button', { class: 'lbtn rec-btn', title: 'Gravar aula', onclick: () => this.toggleRecord() }, icon('mic', 21), el('span', { class: 'lbl rec-time' }, 'Gravar'));
    this.playBtn = lb('wave', 'Áudios', e => this.openRecordingsMenu(e.currentTarget));
    const moreBtn = lb('more', 'Mais', e => this.openMoreMenu(e.currentTarget));
    this.pagesBtn = lb('pages', 'Páginas', () => this.togglePages());

    const top = el('div', { class: 'ed-top' },
      el('div', { class: 'ed-left' }, iconBtn('back', 'Voltar', () => this.exit()), this.titleBtn, this.pagesBtn),
      el('div', { class: 'ed-center' }, toolGroup, this.insertBtn, el('div', { class: 'sep' }), this.swatch, this.sizeGroup),
      el('div', { class: 'ed-right' }, this.undoBtn, this.redoBtn, el('div', { class: 'sep' }), this.recBtn, this.playBtn, moreBtn));

    this.canvas = el('canvas', { class: 'ed-main' });
    this.liveCanvas = el('canvas', { class: 'ed-live' });
    this.overlay = el('div', { class: 'ed-overlay' });
    this.pageInd = el('div', { class: 'page-ind' });
    this.liveCap = el('div', { class: 'live-cap hidden' }, el('span', { class: 'cap-dot' }), el('span', { class: 'muted' }, 'Gravando… a transcrição aparece aqui'));
    this.stage = el('div', { class: 'ed-stage' }, this.canvas, this.liveCanvas, this.overlay, this.pageInd, this.liveCap);
    this.pagesPanel = el('aside', { class: 'pages-panel hidden' });
    this.body = el('div', { class: 'ed-body' }, this.stage, this.pagesPanel);
    this.playerBar = el('div', { class: 'ed-player hidden' });
    r.append(top, this.body, this.playerBar);
    this.ctx = this.canvas.getContext('2d');
    this.lctx = this.liveCanvas.getContext('2d');
    this.updateToolUi();
    this.updateUndoUi();
  }

  setTool(t) {
    if (this.editing) this.finishText();
    if (t !== 'lasso') this.clearSel();
    this.tool = t;
    savePref('tool', t);
    this.updateToolUi();
  }

  saveCfg() { savePref('toolcfg', this.cfg); }
  curSize(t = this.tool) { const c = this.cfg[t]; return c ? c.sizes[c.si] : 0; }

  updateToolUi() {
    for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle('active', id === this.tool);
    const c = this.cfg[this.tool];
    this.swatch.innerHTML = '';
    this.sizeGroup.innerHTML = '';
    const showColor = c && c.color;
    this.swatch.style.display = showColor || this.tool === 'eraser' ? '' : 'none';
    if (showColor) {
      this.swatch.append(el('span', { class: 'swatch-dot', style: { background: c.color } }));
    } else if (this.tool === 'eraser') {
      this.swatch.append(el('span', { class: 'swatch-label' }, c.mode === 'stroke' ? 'Traço' : 'Parcial'));
    }
    if (c && c.sizes) {
      c.sizes.forEach((s, i) => {
        const d = this.tool === 'text' ? el('span', { class: 'size-txt', style: { fontSize: (11 + i * 4) + 'px' } }, 'A')
          : el('span', { class: 'size-dot', style: { width: (5 + i * 5) + 'px', height: (5 + i * 5) + 'px', background: this.tool === 'eraser' ? '#888' : c.color } });
        this.sizeGroup.append(el('button', {
          class: 'size-btn' + (i === c.si ? ' active' : ''), title: 'Espessura',
          onclick: e => {
            if (c.si === i) this.openToolSettings(e.currentTarget);
            else { c.si = i; this.saveCfg(); this.updateToolUi(); }
          },
        }, d));
      });
    }
    this.stage?.classList.toggle('lasso-mode', this.tool === 'lasso');
  }

  openToolSettings(anchor) {
    const t = this.tool, c = this.cfg[t];
    if (!c) return;
    const box = el('div', { class: 'tool-pop' });
    if (t === 'eraser') {
      box.append(el('div', { class: 'pop-title' }, 'Borracha'));
      const seg = el('div', { class: 'seg' });
      for (const [m, label] of [['stroke', 'Traço inteiro'], ['partial', 'Parcial']]) {
        seg.append(el('button', { class: c.mode === m ? 'active' : '', onclick: () => { c.mode = m; this.saveCfg(); this.updateToolUi(); closeMenu(); } }, label));
      }
      box.append(seg);
    } else {
      box.append(el('div', { class: 'pop-title' }, 'Cor'));
      const grid = el('div', { class: 'color-grid' });
      for (const col of c.colors) {
        grid.append(el('button', {
          class: 'color-cell' + (col === c.color ? ' active' : ''), style: { background: col }, title: col,
          onclick: () => { c.color = col; this.saveCfg(); this.updateToolUi(); closeMenu(); },
        }));
      }
      const custom = el('input', { type: 'color', value: c.color, class: 'color-input', title: 'Cor personalizada' });
      custom.addEventListener('change', () => {
        c.color = custom.value;
        if (!c.colors.includes(custom.value)) { c.colors.unshift(custom.value); c.colors = c.colors.slice(0, 12); }
        this.saveCfg(); this.updateToolUi(); closeMenu();
      });
      grid.append(el('label', { class: 'color-cell custom', title: 'Personalizada' }, icon('plus', 16), custom));
      box.append(grid);
    }
    const max = t === 'pen' ? 16 : t === 'highlighter' ? 60 : t === 'text' ? 80 : 120;
    const min = t === 'pen' ? 0.8 : t === 'text' ? 10 : 4;
    const val = el('span', { class: 'muted' }, String(c.sizes[c.si]));
    const range = el('input', { type: 'range', min, max, step: t === 'pen' ? 0.1 : 1, value: c.sizes[c.si], class: 'range' });
    range.addEventListener('input', () => { c.sizes[c.si] = +range.value; val.textContent = range.value; this.saveCfg(); this.updateToolUi(); });
    box.append(el('div', { class: 'pop-title row' }, t === 'text' ? 'Tamanho da letra' : 'Espessura', val), range);
    popover(anchor, box, { align: 'center' });
  }

  updateUndoUi() {
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  // ---------- Layout e câmera ----------
  layout() {
    let W = 0;
    for (const p of this.pages) W = Math.max(W, p.w);
    let y = TOP;
    for (const p of this.pages) { p._ox = (W - p.w) / 2; p._oy = y; y += p.h + GAP; }
    this.W = W; this.totalH = y;
    if (this.pagesOpen) { clearTimeout(this._panelT); this._panelT = setTimeout(() => this.renderPagesPanel(), 30); }
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.rect = r;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.dpr = dpr;
    const oldW = this.vw;
    this.vw = r.width; this.vh = r.height;
    for (const c of [this.canvas, this.liveCanvas]) {
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
      c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
    }
    if (oldW && Math.abs(oldW - r.width) > 2) {
      const fitOld = this._fitZ;
      if (fitOld && Math.abs(this.cam.z - fitOld) < 0.01) {
        const cy = this.cam.y; this.fitWidth(false); this.cam.y = cy;
      }
    }
    this._fitZ = this.fitZoom();
  }

  fitZoom() { return clamp((this.vw - 24) / this.W, 0.2, 1.6); }
  fitWidth(top) {
    this.cam.z = this.fitZoom();
    this._fitZ = this.cam.z;
    if (top) this.cam.y = 0;
    this.clampCam();
  }

  clampCam() {
    const c = this.cam;
    const fz = this.fitZoom();
    c.z = clamp(c.z, fz * 0.5, fz * 6);
    const vwW = this.vw / c.z, vhW = this.vh / c.z;
    if (this.W <= vwW) c.x = (this.W - vwW) / 2;
    else c.x = clamp(c.x, -30 / c.z, this.W - vwW + 30 / c.z);
    const minY = -20 / c.z, maxY = Math.max(minY, this.totalH - vhW * 0.6);
    c.y = clamp(c.y, minY, maxY);
  }

  toWorld(e) {
    const z = this.cam.z;
    return { x: this.cam.x + (e.clientX - this.rect.left) / z, y: this.cam.y + (e.clientY - this.rect.top) / z };
  }
  pageAt(x, y, pad = 0) {
    for (const p of this.pages) {
      if (y >= p._oy - pad && y <= p._oy + p.h + pad && x >= p._ox - pad && x <= p._ox + p.w + pad) return p;
    }
    return null;
  }
  currentPage() {
    const cy = this.cam.y + this.vh / this.cam.z / 2;
    let best = this.pages[0], bd = Infinity;
    for (const p of this.pages) {
      const d = cy < p._oy ? p._oy - cy : cy > p._oy + p.h ? cy - p._oy - p.h : 0;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // ---------- Renderização ----------
  requestRender() {
    if (!this.rafMain) this.rafMain = requestAnimationFrame(() => this.render());
  }
  requestLive() {
    if (!this.rafLive) this.rafLive = requestAnimationFrame(() => this.renderLive());
  }

  render() {
    if (this.rafMain) { cancelAnimationFrame(this.rafMain); this.rafMain = 0; }
    if (!this.ctx) return;
    const { ctx, dpr, vw, vh } = this;
    const { x, y, z } = this.cam;
    const k = dpr * z;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.bg || (this.bg = cssVar('--canvas') || '#e6e7eb');
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const vx0 = x, vy0 = y, vx1 = x + vw / z, vy1 = y + vh / z;
    const settled = !this.gesture && !this.inertia && performance.now() - this.lastGestureT > 160;
    const skip = this.sel && this.selDrag ? this.sel.ids : null;
    const pb = this.playbackState();
    const getImage = id => this.getImage(id);
    for (const p of this.pages) {
      if (p._oy > vy1 || p._oy + p.h < vy0 || p._ox > vx1 || p._ox + p.w < vx0) { if (p.pdf) pdf.dropDetail(p.id); continue; }
      ctx.setTransform(k, 0, 0, k, (p._ox - x) * k, (p._oy - y) * k);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(-1 / z, -1 / z, p.w + 2 / z, p.h + 3 / z);
      R.drawPaper(ctx, p, z);
      const local = [Math.max(0, vx0 - p._ox), Math.max(0, vy0 - p._oy), Math.min(p.w, vx1 - p._ox), Math.min(p.h, vy1 - p._oy)];
      if (p.pdf) this.drawPdf(ctx, p, k, local, settled);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, p.w, p.h); ctx.clip();
      R.drawItems(ctx, this.pageItems(p.id), {
        view: [vx0 - p._ox, vy0 - p._oy, vx1 - p._ox, vy1 - p._oy], skip, playback: pb, getImage,
        dark: !p.pdf && R.isDarkColor(p.paperColor), editingId: this.editing?.it.id,
      });
      ctx.restore();
    }
    if (this.sel) this.drawSelection(ctx, k);
    if (!settled) { clearTimeout(this._settleT); this._settleT = setTimeout(() => this.requestRender(), 200); }
    this.updateOverlay();
    this.updatePageInd();
  }

  drawPdf(ctx, p, k, local, settled) {
    const baseC = pdf.getBase(p, k);
    if (baseC) ctx.drawImage(baseC, 0, 0, p.w, p.h);
    else {
      ctx.fillStyle = '#9a9a9f'; ctx.font = `${28}px ${R.FONT}`; ctx.textAlign = 'center';
      ctx.fillText('Carregando PDF…', p.w / 2, p.h / 2); ctx.textAlign = 'start';
    }
    if (pdf.needsDetail(p, k) && local[2] > local[0] && local[3] > local[1]) {
      const d = pdf.getDetail(p, k, local, settled);
      if (d) ctx.drawImage(d.canvas, d.rect[0], d.rect[1], d.rect[2] - d.rect[0], d.rect[3] - d.rect[1]);
    }
  }

  getImage(blobId) {
    const e = this.images.get(blobId);
    if (e) return e.img && e.img.complete && e.img.naturalWidth ? e.img : null;
    const entry = { img: null, url: null };
    this.images.set(blobId, entry);
    store.getFileBlob(blobId).then(b => {
      if (!b) { this.images.delete(blobId); return; }
      entry.url = URL.createObjectURL(b);
      const img = new Image();
      img.onload = () => this.requestRender();
      img.src = entry.url;
      entry.img = img;
    }).catch(() => this.images.delete(blobId));
    return null;
  }

  selTransform() {
    const s = this.sel, d = this.selDrag;
    if (!d) return { dx: 0, dy: 0, sc: 1, ox: s.bbox[0], oy: s.bbox[1] };
    return { dx: d.dx, dy: d.dy, sc: d.sc, ox: s.bbox[0], oy: s.bbox[1] };
  }

  drawSelection(ctx, k) {
    const s = this.sel, p = s.page;
    const { x, y, z } = this.cam;
    const t = this.selTransform();
    ctx.setTransform(k, 0, 0, k, (p._ox - x) * k, (p._oy - y) * k);
    if (this.selDrag) {
      ctx.save();
      ctx.translate(t.ox + t.dx, t.oy + t.dy); ctx.scale(t.sc, t.sc); ctx.translate(-t.ox, -t.oy);
      R.drawItems(ctx, s.items, { getImage: id => this.getImage(id), dark: !p.pdf && R.isDarkColor(p.paperColor) });
      ctx.restore();
    }
    const [bx0, by0, bx1, by1] = s.bbox;
    const X0 = t.ox + t.dx, Y0 = t.oy + t.dy, X1 = X0 + (bx1 - bx0) * t.sc, Y1 = Y0 + (by1 - by0) * t.sc;
    const pad = 8 / z;
    ctx.lineWidth = 1.5 / z;
    ctx.setLineDash([6 / z, 5 / z]);
    ctx.strokeStyle = '#2f6fed';
    ctx.strokeRect(X0 - pad, Y0 - pad, X1 - X0 + pad * 2, Y1 - Y0 + pad * 2);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(47,111,237,0.06)';
    ctx.fillRect(X0 - pad, Y0 - pad, X1 - X0 + pad * 2, Y1 - Y0 + pad * 2);
    ctx.beginPath();
    ctx.arc(X1 + pad, Y1 + pad, 9 / z, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 2 / z; ctx.stroke();
  }

  renderLive() {
    this.rafLive = 0;
    const c = this.lctx, k = this.dpr * this.cam.z;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    const L = this.live;
    if (L && L.pts.length) {
      const p = L.page;
      c.setTransform(k, 0, 0, k, (p._ox - this.cam.x) * k, (p._oy - this.cam.y) * k);
      c.beginPath(); c.rect(0, 0, p.w, p.h); c.clip();
      const f = new Float32Array(L.pts);
      if (L.tool === 'highlighter') {
        c.globalAlpha = 0.38;
        c.strokeStyle = L.color; c.lineWidth = L.size; c.lineCap = 'round'; c.lineJoin = 'round';
        c.stroke(R.polylinePath(f));
        c.globalAlpha = 1;
      } else if (L.shape) {
        c.strokeStyle = R.inkColor(L.color, !p.pdf && R.isDarkColor(p.paperColor));
        c.lineWidth = L.size; c.lineCap = 'round'; c.lineJoin = 'round';
        c.stroke(R.straightPath(f));
      } else {
        c.fillStyle = R.inkColor(L.color, !p.pdf && R.isDarkColor(p.paperColor));
        c.fill(R.outlinePath(getStroke(R.toPointArray(f), R.strokeOpts(L, false))));
      }
    }
    const E = this.erase;
    if (E && E.cursor) {
      const p = E.page;
      c.setTransform(k, 0, 0, k, (p._ox - this.cam.x) * k, (p._oy - this.cam.y) * k);
      c.beginPath(); c.arc(E.cursor[0], E.cursor[1], this.curSize('eraser') / 2, 0, Math.PI * 2);
      c.fillStyle = 'rgba(120,120,130,0.15)'; c.fill();
      c.lineWidth = 1 / this.cam.z; c.strokeStyle = 'rgba(80,80,90,0.7)'; c.stroke();
    }
    const S = this.lasso;
    if (S && S.poly.length > 1) {
      const p = S.page;
      c.setTransform(k, 0, 0, k, (p._ox - this.cam.x) * k, (p._oy - this.cam.y) * k);
      c.beginPath();
      c.moveTo(S.poly[0][0], S.poly[0][1]);
      for (const q of S.poly) c.lineTo(q[0], q[1]);
      c.closePath();
      c.fillStyle = 'rgba(47,111,237,0.07)'; c.fill();
      c.setLineDash([5 / this.cam.z, 5 / this.cam.z]);
      c.lineWidth = 1.5 / this.cam.z; c.strokeStyle = '#2f6fed'; c.stroke();
      c.setLineDash([]);
    }
  }

  updatePageInd() {
    const cur = this.currentPage();
    const i = this.pages.indexOf(cur) + 1;
    const txt = `${i} / ${this.pages.length}`;
    if (this.pageInd.textContent !== txt) {
      this.pagesGrid?.querySelectorAll('.pthumb').forEach(c => c.classList.toggle('active', c.dataset.id === cur.id));
      this.pageInd.textContent = txt;
      this.pageInd.classList.add('show');
      clearTimeout(this._indT);
      this._indT = setTimeout(() => this.pageInd.classList.remove('show'), 1200);
    }
  }

  // ---------- Eventos ----------
  bindEvents() {
    const s = this.stage;
    const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); this.cleanup.push(() => t.removeEventListener(ev, fn, o)); };
    on(s, 'pointerdown', e => this.onDown(e));
    on(s, 'pointermove', e => this.onMove(e));
    on(s, 'pointerup', e => this.onUp(e, false));
    on(s, 'pointercancel', e => this.onUp(e, true));
    on(s, 'pointerleave', e => { if (e.pointerType === 'mouse' && !e.buttons) this.onUp(e, false); });
    const stopTouch = e => { if (!e.target.closest('textarea, input, button, .sel-bar')) e.preventDefault(); };
    on(s, 'touchstart', stopTouch, { passive: false });
    on(s, 'touchmove', stopTouch, { passive: false });
    on(s, 'gesturestart', e => e.preventDefault(), { passive: false });
    on(s, 'contextmenu', e => e.preventDefault());
    on(s, 'wheel', e => this.onWheel(e), { passive: false });
    on(window, 'keydown', e => this.onKey(e));
    on(window, 'themechange', () => { this.bg = null; this.requestRender(); });
    const ro = new ResizeObserver(() => { this.resize(); this.clampCam(); this.render(); });
    ro.observe(s);
    this.cleanup.push(() => ro.disconnect());
    on(window, 'pagehide', () => this.saveCam());
    on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') this.saveCam(); });
  }

  camSnapshot() { return { ...this.cam, fit: Math.abs(this.cam.z - this.fitZoom()) < 0.01 }; }
  saveCam() {
    this.note._cam = this.camSnapshot();
    store.save('note', this.note).catch(() => { });
  }

  isUiTarget(e) { return !!e.target.closest?.('textarea, input, button, .sel-bar'); }

  onDown(e) {
    if (this.isUiTarget(e)) return;
    closeMenu();
    const type = e.pointerType;
    if (type === 'pen') {
      this.penSeen = true;
      this.penDown = true;
      this.cancelTouchGesture(true);
    }
    if (type === 'touch') {
      if (this.penDown || performance.now() - this.lastPenUp < 300 || (this.penSeen && e.width > 70)) { this.ignored.add(e.pointerId); return; }
      if (!this.fingerDraw || this.touches.size > 0 || this.drawPointer != null) {
        if (this.drawPointer != null && this.drawType === 'touch') this.abortDraw();
        return this.touchDown(e);
      }
    }
    if (type === 'mouse' && e.button !== 0) return;
    if (this.drawPointer != null) return;
    this.drawPointer = e.pointerId;
    this.drawType = type;
    try { this.stage.setPointerCapture(e.pointerId); } catch { }
    this.drawDown(e);
  }

  onMove(e) {
    if (this.ignored.has(e.pointerId)) return;
    if (e.pointerId === this.drawPointer) return this.drawMove(e);
    if (this.touches.has(e.pointerId)) return this.touchMove(e);
  }

  onUp(e, cancel) {
    if (this.ignored.delete(e.pointerId)) return;
    if (e.pointerId === this.drawPointer) {
      this.drawPointer = null;
      if (this.drawType === 'pen') { this.penDown = false; this.lastPenUp = performance.now(); }
      this.drawUp(e, cancel);
      return;
    }
    if (this.touches.has(e.pointerId)) this.touchUp(e, cancel);
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * 0.01);
      this.zoomAt(e.clientX - this.rect.left, e.clientY - this.rect.top, this.cam.z * f);
    } else {
      this.cam.x += e.deltaX / this.cam.z;
      this.cam.y += e.deltaY / this.cam.z;
    }
    this.lastGestureT = performance.now();
    this.clampCam(); this.requestRender();
  }

  zoomAt(sx, sy, nz) {
    const c = this.cam;
    const wx = c.x + sx / c.z, wy = c.y + sy / c.z;
    const fz = this.fitZoom();
    c.z = clamp(nz, fz * 0.5, fz * 6);
    c.x = wx - sx / c.z; c.y = wy - sy / c.z;
  }

  onKey(e) {
    if (e.target.closest?.('textarea, input')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); this.deleteSel(); }
    else if (e.key === 'Escape') this.clearSel();
  }

  // ---------- Gestos com o dedo ----------
  touchDown(e) {
    this.stopInertia();
    const pt = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
    this.touches.set(e.pointerId, pt);
    try { this.stage.setPointerCapture(e.pointerId); } catch { }
    const n = this.touches.size;
    const t = performance.now();
    if (n === 1) {
      const w = this.toWorld(e);
      if (this.sel && this.hitSel(w)) {
        this.gesture = { type: 'seldrag', t0: t, maxT: 1, moved: false };
        this.startSelDrag(this.hitSel(w), w);
        return;
      }
      this.gesture = { type: 'pan', t0: t, maxT: 1, moved: false, camStart: { ...this.cam }, lx: e.clientX, ly: e.clientY, lt: t, vx: 0, vy: 0, dist: 0 };
    } else if (n === 2) {
      if (this.gesture?.type === 'seldrag') this.endSelDrag(true);
      const [a, b] = [...this.touches.values()];
      const g = this.gesture || { t0: t, maxT: 2 };
      this.gesture = {
        type: 'pinch', t0: g.t0, maxT: Math.max(2, g.maxT || 0), moved: g.moved, camStart: g.camStart || { ...this.cam },
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx0: (a.x + b.x) / 2, cy0: (a.y + b.y) / 2,
        cam0: { ...this.cam },
      };
    } else if (this.gesture) {
      this.gesture.maxT = Math.max(this.gesture.maxT, n);
    }
  }

  touchMove(e) {
    const pt = this.touches.get(e.pointerId);
    pt.x = e.clientX; pt.y = e.clientY;
    const g = this.gesture;
    if (!g) return;
    if (Math.hypot(pt.x - pt.sx, pt.y - pt.sy) > 10) g.moved = true;
    if (g.type === 'seldrag') { this.moveSelDrag(this.toWorld(e)); return; }
    if (g.type === 'pan') {
      const t = performance.now();
      const dx = e.clientX - g.lx, dy = e.clientY - g.ly, dt = Math.max(1, t - g.lt);
      g.dist += Math.hypot(dx, dy);
      this.cam.x -= dx / this.cam.z; this.cam.y -= dy / this.cam.z;
      g.vx = 0.8 * (dx / dt) + 0.2 * g.vx; g.vy = 0.8 * (dy / dt) + 0.2 * g.vy;
      g.lx = e.clientX; g.ly = e.clientY; g.lt = t;
    } else if (g.type === 'pinch' && this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const c0 = g.cam0;
      const wx = c0.x + (g.cx0 - this.rect.left) / c0.z, wy = c0.y + (g.cy0 - this.rect.top) / c0.z;
      const fz = this.fitZoom();
      let nz = clamp(c0.z * d / g.d0, fz * 0.5, fz * 6);
      if (Math.abs(nz - fz) / fz < 0.04) nz = fz; // "encaixa" na largura da página
      this.cam.z = nz;
      this.cam.x = wx - (cx - this.rect.left) / nz;
      this.cam.y = wy - (cy - this.rect.top) / nz;
    }
    this.lastGestureT = performance.now();
    this.clampCam();
    this.requestRender();
  }

  touchUp(e, cancel) {
    this.touches.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'seldrag') { this.gesture = null; this.endSelDrag(cancel); return; }
    if (this.touches.size === 1 && g.type === 'pinch') {
      const [pt] = [...this.touches.values()];
      // um dedo levantou: continua rolando com o outro, mas ainda conta como toque se ninguém se mexeu
      this.gesture = { type: 'pan', t0: g.t0, maxT: g.maxT, moved: g.moved, camStart: g.camStart, lx: pt.x, ly: pt.y, lt: performance.now(), vx: 0, vy: 0, dist: 0 };
      return;
    }
    if (this.touches.size > 0) {
      if (g.type === 'pan') { const [pt] = [...this.touches.values()]; g.lx = pt.x; g.ly = pt.y; }
      return;
    }
    this.gesture = null;
    const dur = performance.now() - g.t0;
    if (!cancel && !g.moved && dur < 380) {
      if (g.maxT >= 2 && g.camStart) { this.cam = { ...g.camStart }; this.requestRender(); }
      if (g.maxT === 2) { const ok = this.undoStack.length; this.undo(); return this.flash(ok ? 'undo' : null, ok ? 'Desfeito' : 'Nada para desfazer'); }
      if (g.maxT === 3) { const ok = this.redoStack.length; this.redo(); return this.flash(ok ? 'redo' : null, ok ? 'Refeito' : 'Nada para refazer'); }
      if (g.maxT === 1) return this.onTap(e);
    }
    if (g.type === 'pan' && !cancel && performance.now() - g.lt < 60 && Math.hypot(g.vx, g.vy) > 0.25) this.startInertia(g.vx, g.vy);
    this.requestRender();
  }

  cancelTouchGesture(revertPan) {
    const g = this.gesture;
    if (g?.type === 'pan' && revertPan && (performance.now() - g.t0 < 600 || g.dist < 40)) {
      this.cam = { ...g.camStart };
      this.requestRender();
    }
    if (g?.type === 'seldrag') this.endSelDrag(true);
    for (const id of this.touches.keys()) this.ignored.add(id);
    this.touches.clear();
    this.gesture = null;
    this.stopInertia();
  }

  startInertia(vx, vy) {
    let last = performance.now();
    const step = t => {
      const dt = Math.min(40, t - last); last = t;
      const f = Math.pow(0.95, dt / 16);
      vx *= f; vy *= f;
      this.cam.x -= vx * dt / this.cam.z; this.cam.y -= vy * dt / this.cam.z;
      this.clampCam();
      this.render();
      if (Math.hypot(vx, vy) > 0.02) this.inertia = requestAnimationFrame(step);
      else { this.inertia = 0; this.lastGestureT = performance.now(); this.requestRender(); }
    };
    this.inertia = requestAnimationFrame(step);
  }
  stopInertia() { if (this.inertia) { cancelAnimationFrame(this.inertia); this.inertia = 0; } }

  onTap(e) {
    const w = this.toWorld(e);
    const p = this.pageAt(w.x, w.y);
    if (this.sel && !this.hitSel(w)) { this.clearSel(); return; }
    if (!p) return;
    const lx = w.x - p._ox, ly = w.y - p._oy;
    // toque num traço gravado: pula o áudio para aquele momento
    const r = 14 / this.cam.z;
    const items = this.pageItems(p.id);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === 'stroke' && it.rec && R.strokeHit(it, lx, ly, r)) {
        const rec = this.recordings.find(x => x.id === it.rec.id);
        if (rec) { this.seekTo(rec, it.rec.t0 / 1000 - 1.5); return; }
      }
    }
    if (this.tool === 'text') this.textTap(p, lx, ly);
  }

  // ---------- Desenho (caneta / mouse) ----------
  drawDown(e) {
    const w = this.toWorld(e);
    if (this.editing) { this.finishText(); if (this.tool === 'text') { this.drawStart = { w, t: performance.now(), tap: true }; return; } }
    if (this.sel) {
      const h = this.hitSel(w);
      if (h) { this.startSelDrag(h, w); return; }
      this.clearSel();
    }
    this.drawStart = { w, t: performance.now() };
    const t = this.tool;
    if (t === 'pen' || t === 'highlighter') this.startStroke(e, w);
    else if (t === 'eraser') this.startErase(w);
    else if (t === 'lasso') this.startLasso(w);
  }

  drawMove(e) {
    if (this.selDrag) return this.moveSelDrag(this.toWorld(e));
    if (this.live) return this.strokeMove(e);
    if (this.erase) return this.eraseMove(e);
    if (this.lasso) {
      const w = this.toWorld(e), p = this.lasso.page;
      const q = [w.x - p._ox, w.y - p._oy], last = this.lasso.poly[this.lasso.poly.length - 1];
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) > 2 / this.cam.z) { this.lasso.poly.push(q); this.requestLive(); }
    }
  }

  drawUp(e, cancel) {
    if (this.selDrag) return this.endSelDrag(cancel);
    if (this.live) return this.endStroke();
    if (this.erase) return this.endErase();
    if (this.lasso) return this.endLasso();
    if (this.tool === 'text' && this.drawStart && !cancel) {
      const w = this.toWorld(e), s = this.drawStart;
      if (Math.hypot(w.x - s.w.x, w.y - s.w.y) * this.cam.z < 10) {
        const p = this.pageAt(w.x, w.y);
        if (p) this.textTap(p, w.x - p._ox, w.y - p._oy);
      }
    }
    this.drawStart = null;
  }

  abortDraw() {
    this.drawPointer = null;
    this.live = null; this.lasso = null;
    if (this.erase) this.endErase();
    if (this.selDrag) this.endSelDrag(true);
    this.requestLive();
  }

  // --- traço ---
  startStroke(e, w) {
    const page = this.pageAt(w.x, w.y);
    if (!page) return;
    const t = this.tool, c = this.cfg[t];
    this.live = { page, tool: t, color: c.color, size: c.sizes[c.si], sim: e.pointerType !== 'pen', pts: [], t0: performance.now(), shape: null, hold: null };
    this.pushPoints(e);
    this.armHold(e);
  }

  pushPoints(e) {
    const L = this.live, p = L.page, z = this.cam.z;
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    const list = evs.length ? evs : [e];
    for (const ev of list) {
      const x = this.cam.x + (ev.clientX - this.rect.left) / z - p._ox;
      const y = this.cam.y + (ev.clientY - this.rect.top) / z - p._oy;
      let pr = 0.5;
      if (ev.pointerType === 'pen') pr = Math.min(1, Math.pow(Math.max(0.05, ev.pressure || 0.5), 0.75));
      if (L.shape === 'line') {
        L.pts.length = 3;
        L.pts.push(x, y, 0.5);
      } else if (L.shape) {
        // forma já reconhecida: fica parada até levantar a caneta
      } else {
        const n = L.pts.length;
        if (n && Math.abs(L.pts[n - 3] - x) < 0.05 && Math.abs(L.pts[n - 2] - y) < 0.05) continue;
        L.pts.push(x, y, pr);
      }
    }
  }

  armHold(e) {
    const L = this.live;
    clearTimeout(L.holdT);
    L.hold = { x: e.clientX, y: e.clientY };
    L.holdT = setTimeout(() => {
      if (this.live !== L || L.shape) return;
      const s = recognize(L.pts);
      if (!s) return;
      L.shape = s.type === 'line' ? 'line' : s.type;
      L.sim = false;
      L.pts = s.points.flatMap(p => [p[0], p[1], 0.5]);
      navigator.vibrate?.(10);
      this.requestLive();
    }, 550);
  }

  strokeMove(e) {
    const L = this.live;
    this.pushPoints(e);
    if (L.hold && Math.hypot(e.clientX - L.hold.x, e.clientY - L.hold.y) > 4) this.armHold(e);
    this.requestLive();
  }

  endStroke() {
    const L = this.live;
    this.live = null;
    clearTimeout(L.holdT);
    if (!L.pts.length) { this.requestLive(); return; }
    if (L.shape === 'line') {
      const n = L.pts.length;
      L.pts = densifyLine([L.pts[0], L.pts[1]], [L.pts[n - 3], L.pts[n - 2]]).flatMap(p => [p[0], p[1], 0.5]);
    }
    const f = new Float32Array(L.pts);
    const recA = audio.activeRecording();
    const it = {
      id: uid(), type: 'stroke', noteId: this.note.id, pageId: L.page.id, tool: L.tool, color: L.color, size: L.size, sim: L.sim,
      shape: L.shape || null,
      pts: encodePts(f), bbox: R.computeBBox(f, L.size), z: now(), deleted: false,
      rec: recA && recA.noteId === this.note.id ? { id: recA.id, t0: Math.max(0, L.t0 - recA.startPerf) } : null,
    };
    this.addMem(it);
    this.pushUndo({ type: 'add', items: [it] });
    this.persist('item', [it]);
    this.render();
    this.lctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    this.maybeAppendPage(L.page, it.bbox[3]);
  }

  async maybeAppendPage(page, bottom) {
    if (page.pdf || page !== this.pages[this.pages.length - 1] || bottom < page.h * 0.72) return;
    const np = await store.createPage(this.note.id, { order: page.order + 1, template: page.template, paperColor: page.paperColor, w: page.w, h: page.h });
    this.pages.push(np);
    this.byPage.set(np.id, []);
    this.layout(); this.requestRender();
  }

  // --- borracha ---
  startErase(w) {
    const page = this.pageAt(w.x, w.y, 40);
    if (!page) return;
    this.erase = { page, removed: new Map(), added: new Map(), last: null, cursor: null };
    this.eraseAt(w);
  }
  eraseMove(e) {
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    for (const ev of (evs.length ? evs : [e])) this.eraseAt(this.toWorld(ev));
  }
  eraseAt(w) {
    const E = this.erase, p = E.page;
    const x = w.x - p._ox, y = w.y - p._oy;
    const r = this.curSize('eraser') / 2;
    E.cursor = [x, y];
    const pts = [];
    if (E.last) {
      const d = Math.hypot(x - E.last[0], y - E.last[1]);
      const n = Math.ceil(d / Math.max(1, r / 2));
      for (let i = 1; i <= n; i++) pts.push([E.last[0] + (x - E.last[0]) * i / n, E.last[1] + (y - E.last[1]) * i / n]);
    } else pts.push([x, y]);
    E.last = [x, y];
    const partial = this.cfg.eraser.mode === 'partial';
    let changed = false;
    for (const [px, py] of pts) {
      for (const it of [...this.pageItems(p.id)]) {
        if (it.type !== 'stroke' || !R.strokeHit(it, px, py, r)) continue;
        changed = true;
        this.removeMem(it);
        if (E.added.has(it.id)) E.added.delete(it.id); else E.removed.set(it.id, it);
        if (partial) for (const piece of this.splitStroke(it, px, py, r)) { this.addMem(piece); E.added.set(piece.id, piece); }
      }
    }
    if (changed) this.requestRender();
    this.requestLive();
  }

  splitStroke(it, x, y, r) {
    const f = R.geom(it).f;
    const n = f.length / 3;
    const rr = r + it.size * 0.35;
    const step = Math.max(0.8, r / 4);
    const out = [];
    const push = (px, py, pp) => out.push(px, py, pp);
    for (let i = 0; i < n; i++) {
      const ax = f[i * 3], ay = f[i * 3 + 1], ap = f[i * 3 + 2];
      push(ax, ay, ap);
      if (i < n - 1) {
        const bx = f[i * 3 + 3], by = f[i * 3 + 4], bp = f[i * 3 + 5];
        const d = Math.hypot(bx - ax, by - ay);
        const near = Math.min(Math.hypot(ax - x, ay - y), Math.hypot(bx - x, by - y)) < rr + d;
        if (near && d > step) {
          const k = Math.ceil(d / step);
          for (let j = 1; j < k; j++) push(ax + (bx - ax) * j / k, ay + (by - ay) * j / k, ap + (bp - ap) * j / k);
        }
      }
    }
    const pieces = [];
    let run = [];
    const flush = () => {
      if (run.length >= 6) {
        const nf = new Float32Array(run);
        pieces.push({ ...it, id: uid(), pts: encodePts(nf), bbox: R.computeBBox(nf, it.size) });
      }
      run = [];
    };
    for (let i = 0; i < out.length; i += 3) {
      if (Math.hypot(out[i] - x, out[i + 1] - y) <= rr) flush();
      else run.push(out[i], out[i + 1], out[i + 2]);
    }
    flush();
    return pieces;
  }

  endErase() {
    const E = this.erase;
    this.erase = null;
    this.requestLive();
    const removed = [...E.removed.values()], added = [...E.added.values()];
    if (!removed.length && !added.length) return;
    for (const it of removed) it.deleted = true;
    this.persist('item', [...removed, ...added]);
    this.pushUndo({ type: 'replace', removed, added });
  }

  // --- laço ---
  startLasso(w) {
    const page = this.pageAt(w.x, w.y, 30);
    if (!page) return;
    this.lasso = { page, poly: [[w.x - page._ox, w.y - page._oy]] };
  }

  endLasso() {
    const S = this.lasso;
    this.lasso = null;
    this.requestLive();
    const p = S.page;
    let sel = [];
    const items = this.pageItems(p.id);
    if (S.poly.length < 5) {
      // toque simples: seleciona o item tocado
      const [x, y] = S.poly[0];
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        const b = R.itemBBox(it);
        const hit = it.type === 'stroke' ? R.strokeHit(it, x, y, 10 / this.cam.z) : x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
        if (hit) { sel = [it]; break; }
      }
    } else {
      const poly = S.poly;
      for (const it of items) {
        if (it.type === 'stroke') {
          const f = R.geom(it).f, n = f.length / 3;
          const stepN = Math.max(1, Math.floor(n / 24));
          let inside = 0, total = 0;
          for (let i = 0; i < n; i += stepN) { total++; if (R.pointInPoly(f[i * 3], f[i * 3 + 1], poly)) inside++; }
          if (inside / total >= 0.5) sel.push(it);
        } else {
          const b = R.itemBBox(it);
          if (R.pointInPoly((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, poly)) sel.push(it);
        }
      }
    }
    if (sel.length) this.setSel(p, sel); else this.clearSel();
  }

  // ---------- Seleção ----------
  setSel(page, items) {
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const it of items) {
      const b = R.itemBBox(it);
      bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]); bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]);
    }
    this.sel = { page, items, ids: new Set(items.map(i => i.id)), bbox: bb };
    this.buildSelBar();
    this.requestRender();
  }
  clearSel() {
    if (!this.sel) return;
    this.sel = null;
    this.selBar?.remove(); this.selBar = null;
    this.requestRender();
  }

  hitSel(w) {
    const s = this.sel;
    if (!s) return null;
    const x = w.x - s.page._ox, y = w.y - s.page._oy, z = this.cam.z;
    const pad = 8 / z;
    const [x0, y0, x1, y1] = s.bbox;
    if (Math.hypot(x - (x1 + pad), y - (y1 + pad)) < 22 / z) return 'resize';
    if (x >= x0 - pad - 6 / z && x <= x1 + pad + 6 / z && y >= y0 - pad - 6 / z && y <= y1 + pad + 6 / z) return 'move';
    return null;
  }

  startSelDrag(mode, w) {
    const s = this.sel;
    this.selDrag = { mode, sx: w.x, sy: w.y, dx: 0, dy: 0, sc: 1 };
    if (this.selBar) this.selBar.style.display = 'none';
    this.requestRender();
  }
  moveSelDrag(w) {
    const d = this.selDrag, s = this.sel;
    if (!d) return;
    if (d.mode === 'move') { d.dx = w.x - d.sx; d.dy = w.y - d.sy; }
    else {
      const [x0, y0, x1, y1] = s.bbox;
      const ox = s.page._ox + x0, oy = s.page._oy + y0;
      const d0 = Math.hypot(x1 - x0, y1 - y0) || 1;
      const d1 = Math.hypot(w.x - ox, w.y - oy);
      d.sc = clamp(d1 / d0, 0.1, 10);
    }
    this.requestRender();
  }
  endSelDrag(cancel) {
    const d = this.selDrag, s = this.sel;
    this.selDrag = null;
    if (!s) return;
    if (cancel || (Math.abs(d.dx) < 0.5 && Math.abs(d.dy) < 0.5 && Math.abs(d.sc - 1) < 0.005)) {
      if (this.selBar) this.selBar.style.display = '';
      this.requestRender();
      return;
    }
    const before = s.items.map(it => ({ ...it }));
    const [x0, y0, x1, y1] = s.bbox;
    // centro final em coordenadas do mundo -> página de destino
    const cx = s.page._ox + x0 + d.dx + (x1 - x0) * d.sc / 2;
    const cy = s.page._oy + y0 + d.dy + (y1 - y0) * d.sc / 2;
    const target = this.pageAt(cx, cy) || s.page;
    const shx = s.page._ox - target._ox, shy = s.page._oy - target._oy;
    for (const it of s.items) {
      this.removeMem(it);
      transformItem(it, x0, y0, d.sc, d.dx + shx, d.dy + shy);
      it.pageId = target.id;
      this.addMem(it);
    }
    const after = s.items.map(it => ({ ...it }));
    this.persist('item', s.items);
    this.pushUndo({ type: 'update', before, after });
    this.setSel(target, s.items);
  }

  buildSelBar() {
    this.selBar?.remove();
    const s = this.sel;
    const hasColor = s.items.some(i => i.type !== 'image');
    const bar = el('div', { class: 'sel-bar' },
      el('button', { onclick: () => this.deleteSel() }, icon('trash', 18), 'Excluir'),
      el('button', { onclick: () => this.duplicateSel() }, icon('copy', 18), 'Duplicar'),
      el('button', { onclick: () => { Editor.clipboard = s.items.map(i => ({ ...i })); toast('Copiado. Use "Inserir › Colar" em qualquer nota.'); } }, icon('file', 18), 'Copiar'),
      el('button', { onclick: e => this.selToFlashcard(e.currentTarget) }, icon('cards', 18), 'Flashcard'),
      hasColor ? el('button', { onclick: e => this.colorSel(e.currentTarget) }, icon('palette', 18), 'Cor') : null,
      s.items.length === 1 && s.items[0].type === 'text' ? el('button', { onclick: () => { const it = s.items[0]; this.clearSel(); this.editText(it, false); } }, icon('text', 18), 'Editar') : null);
    this.overlay.append(bar);
    this.selBar = bar;
    this.updateOverlay();
  }

  selToFlashcard(anchor) {
    const s = this.sel;
    if (!s) return;
    const make = async side => {
      const img = await selectionImage(s.items, s.bbox, s.page, id => this.getImage(id));
      openCardEditor({ prefill: { frontImage: img, side, source: { noteId: this.note.id, pageId: s.page.id } } });
    };
    menu(anchor, [
      { header: 'Criar flashcard com a seleção' },
      { label: 'A seleção é a pergunta', icon: 'quiz', onClick: () => make('front') },
      { label: 'A seleção é a resposta', icon: 'check', onClick: () => make('back') },
    ], { align: 'center' });
  }

  deleteSel() {
    const s = this.sel;
    if (!s) return;
    for (const it of s.items) { this.removeMem(it); it.deleted = true; }
    this.persist('item', s.items);
    this.pushUndo({ type: 'remove', items: s.items });
    this.clearSel();
  }

  duplicateSel() {
    const s = this.sel;
    const clones = s.items.map(it => {
      const c = { ...it, id: uid(), z: now() + Math.random(), rec: null };
      transformItem(c, 0, 0, 1, 30, 30);
      return c;
    });
    clones.forEach(c => this.addMem(c));
    this.persist('item', clones);
    this.pushUndo({ type: 'add', items: clones });
    this.setSel(s.page, clones);
  }

  pasteClipboard() {
    const src = Editor.clipboard;
    if (!src?.length) return;
    const p = this.currentPage();
    const clones = src.map(it => ({ ...it, id: uid(), noteId: this.note.id, pageId: p.id, z: now() + Math.random(), rec: null, deleted: false }));
    clones.forEach(c => this.addMem(c));
    this.persist('item', clones);
    this.pushUndo({ type: 'add', items: clones });
    this.setTool('lasso');
    this.setSel(p, clones);
  }

  colorSel(anchor) {
    const s = this.sel;
    const colors = [...new Set([...this.cfg.pen.colors, ...this.cfg.highlighter.colors])];
    const grid = el('div', { class: 'color-grid' });
    for (const col of colors) grid.append(el('button', {
      class: 'color-cell', style: { background: col },
      onclick: () => {
        const before = s.items.map(i => ({ ...i }));
        const changed = s.items.filter(i => i.type !== 'image');
        changed.forEach(i => { i.color = col; });
        this.persist('item', changed);
        this.pushUndo({ type: 'update', before, after: s.items.map(i => ({ ...i })) });
        closeMenu(); this.requestRender();
      },
    }));
    popover(anchor, el('div', { class: 'tool-pop' }, el('div', { class: 'pop-title' }, 'Mudar cor'), grid), { align: 'center' });
  }

  updateOverlay() {
    const z = this.cam.z;
    if (this.selBar && this.sel && !this.selDrag) {
      const s = this.sel;
      const sx = (s.page._ox + (s.bbox[0] + s.bbox[2]) / 2 - this.cam.x) * z;
      let sy = (s.page._oy + s.bbox[1] - this.cam.y) * z - 56;
      if (sy < 8) sy = (s.page._oy + s.bbox[3] - this.cam.y) * z + 24;
      const bw = this.selBar.offsetWidth;
      this.selBar.style.left = clamp(sx - bw / 2, 8, this.vw - bw - 8) + 'px';
      this.selBar.style.top = clamp(sy, 8, this.vh - 56) + 'px';
    }
    if (this.editing) {
      const { it, ta } = this.editing;
      const p = this.pages.find(pg => pg.id === it.pageId);
      if (!p) return;
      ta.style.left = ((p._ox + it.x - this.cam.x) * z) + 'px';
      ta.style.top = ((p._oy + it.y - this.cam.y) * z) + 'px';
      ta.style.width = (it.w * z) + 'px';
      ta.style.fontSize = (it.fontSize * z) + 'px';
      ta.style.height = 'auto';
      ta.style.height = Math.max(it.fontSize * 1.3 * z, ta.scrollHeight) + 'px';
    }
  }

  // ---------- Texto ----------
  textTap(p, x, y) {
    const items = this.pageItems(p.id);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type !== 'text') continue;
      const b = R.itemBBox(it);
      if (x >= b[0] - 6 && x <= b[2] + 6 && y >= b[1] - 6 && y <= b[3] + 6) return this.editText(it, false);
    }
    const fs = this.curSize('text');
    const w = clamp(p.w - x - 40, 200, 700);
    const it = { id: uid(), type: 'text', noteId: this.note.id, pageId: p.id, x, y: y - fs * 0.65, w, text: '', fontSize: fs, color: this.cfg.text.color, z: now(), deleted: false };
    this.editText(it, true);
  }

  editText(it, isNew) {
    if (this.editing) this.finishText();
    const ta = el('textarea', { class: 'text-edit', spellcheck: 'true', autocapitalize: 'sentences' });
    ta.value = it.text;
    const pg = this.pages.find(x => x.id === it.pageId);
    const darkPaper = pg && !pg.pdf && R.isDarkColor(pg.paperColor);
    ta.style.color = R.inkColor(it.color, darkPaper);
    if (darkPaper) ta.style.background = 'rgba(0,0,0,0.25)';
    ta.style.lineHeight = '1.3';
    this.editing = { it, ta, isNew, before: { ...it } };
    ta.addEventListener('input', () => { it.text = ta.value; this.updateOverlay(); });
    ta.addEventListener('blur', () => setTimeout(() => { if (this.editing?.ta === ta) this.finishText(); }, 50));
    ta.addEventListener('keydown', e => { if (e.key === 'Escape') ta.blur(); });
    this.overlay.append(ta);
    this.requestRender();
    this.updateOverlay();
    setTimeout(() => ta.focus(), 20);
  }

  finishText() {
    const E = this.editing;
    if (!E) return;
    this.editing = null;
    E.ta.remove();
    const it = E.it;
    it.text = E.ta.value.replace(/\s+$/, '');
    if (E.isNew) {
      if (it.text) { this.addMem(it); this.persist('item', [it]); this.pushUndo({ type: 'add', items: [it] }); }
    } else if (!it.text) {
      this.removeMem(it); it.deleted = true; this.persist('item', [it]);
      this.pushUndo({ type: 'remove', items: [it] });
    } else if (it.text !== E.before.text) {
      this.persist('item', [it]);
      this.pushUndo({ type: 'update', before: [E.before], after: [{ ...it }] });
    }
    this.requestRender();
  }

  openInsertMenu(anchor) {
    menu(anchor, [
      { label: 'Foto ou imagem da galeria', icon: 'image', onClick: () => this.insertImage() },
      { label: 'Tirar foto (quadro, livro)', icon: 'camera', onClick: () => this.insertImage(true) },
      { label: 'PDF (slides, apostila)', icon: 'file', onClick: () => this.importPdfHere() },
      { label: 'Página em branco', icon: 'pagePlus', onClick: () => this.addPageAfter(this.currentPage()) },
      { label: 'Caixa de texto (digitar)', icon: 'text', onClick: () => { this.setTool('text'); toast('Toque na página onde quer escrever.'); } },
      { sep: true },
      { label: 'Nova flashcard', icon: 'cards', onClick: () => openCardEditor({ prefill: { source: { noteId: this.note.id, pageId: this.currentPage().id } } }) },
      Editor.clipboard?.length ? { label: 'Colar', icon: 'copy', onClick: () => this.pasteClipboard() } : null,
    ]);
  }

  // ---------- Imagem ----------
  async insertImage(camera = false) {
    const file = await pickFile('image/*', false, camera);
    if (!file) return;
    try {
      const { data, mime, w, h } = await prepareImage(file);
      const blob = await store.createBlob({ noteId: this.note.id, data, mime, name: file.name });
      const p = this.currentPage();
      const iw = Math.min(p.w * 0.6, w), ih = iw * h / w;
      const cy = clamp(this.cam.y + this.vh / this.cam.z / 2 - p._oy - ih / 2, 20, Math.max(20, p.h - ih - 20));
      const it = { id: uid(), type: 'image', noteId: this.note.id, pageId: p.id, x: (p.w - iw) / 2, y: cy, w: iw, h: ih, blobId: blob.id, z: now(), deleted: false };
      this.addMem(it);
      this.persist('item', [it]);
      this.pushUndo({ type: 'add', items: [it] });
      this.setTool('lasso');
      this.setSel(p, [it]);
    } catch (e) {
      console.error(e);
      toast('Não consegui inserir a imagem: ' + e.message, { kind: 'error' });
    }
  }

  // ---------- Desfazer ----------
  flash(ic, text) {
    this.stage.querySelector('.undo-flash')?.remove();
    const f = el('div', { class: 'undo-flash' }, ic ? icon(ic, 16) : null, text);
    this.stage.append(f);
    setTimeout(() => f.remove(), 950);
  }

  pushUndo(a) {
    this.undoStack.push(a);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoUi();
  }
  undo() { const a = this.undoStack.pop(); if (a) { this.applyAction(a, true); this.redoStack.push(a); } this.updateUndoUi(); }
  redo() { const a = this.redoStack.pop(); if (a) { this.applyAction(a, false); this.undoStack.push(a); } this.updateUndoUi(); }

  applyAction(a, inverse) {
    if (this.editing) this.finishText();
    this.clearSel();
    const hide = list => { for (const it of list) { this.removeMem(it); it.deleted = true; } return list; };
    const show = list => { for (const it of list) { it.deleted = false; this.removeMem(it); this.addMem(it); } return list; };
    let changed = [];
    if (a.type === 'add') changed = inverse ? hide(a.items) : show(a.items);
    else if (a.type === 'remove') changed = inverse ? show(a.items) : hide(a.items);
    else if (a.type === 'replace') changed = inverse ? [...hide(a.added), ...show(a.removed)] : [...hide(a.removed), ...show(a.added)];
    else if (a.type === 'update') {
      const snaps = inverse ? a.before : a.after;
      for (const snap of snaps) {
        const it = this.items.get(snap.id);
        if (!it) continue;
        this.removeMem(it);
        Object.assign(it, snap);
        this.addMem(it);
        changed.push(it);
      }
    }
    this.persist('item', changed);
    this.requestRender();
  }

  // ---------- Páginas ----------
  async addPageAfter(p) {
    const i = this.pages.indexOf(p);
    const next = this.pages[i + 1];
    const order = next ? (p.order + next.order) / 2 : p.order + 1;
    const np = await store.createPage(this.note.id, { order, template: p.pdf ? 'lined' : p.template, paperColor: p.pdf ? defaultPaper() : p.paperColor, w: p.w, h: p.pdf ? Math.round(p.w * 1.4145) : p.h });
    this.pages.splice(i + 1, 0, np);
    this.byPage.set(np.id, []);
    this.layout();
    this.cam.y = np._oy - 20 / this.cam.z;
    this.clampCam(); this.requestRender();
  }

  async deletePage(p) {
    if (this.pages.length <= 1) return toast('A nota precisa de pelo menos uma página.');
    if (!await confirmBox('Excluir esta página?', 'Tudo que estiver escrito nela será apagado.', { ok: 'Excluir', danger: true })) return;
    const items = [...this.pageItems(p.id)];
    for (const it of items) { this.removeMem(it); it.deleted = true; }
    this.persist('item', items);
    p.deleted = true;
    await store.save('page', p);
    this.pages = this.pages.filter(x => x !== p);
    this.undoStack = this.undoStack.filter(a => !(a.items || a.added || a.after || []).some(i => i.pageId === p.id));
    this.updateUndoUi();
    this.layout(); this.clampCam(); this.requestRender();
  }

  openPaperMenu(anchor) {
    const p = this.currentPage();
    let tpl = p.template, col = p.paperColor;
    const box = el('div', { class: 'tool-pop paper-pop' });
    const tgrid = el('div', { class: 'tpl-grid' });
    const cgrid = el('div', { class: 'color-grid' });
    const draw = () => {
      tgrid.innerHTML = '';
      for (const t of R.TEMPLATES) tgrid.append(el('button', { class: 'tpl' + (t.id === tpl ? ' active' : ''), onclick: () => { tpl = t.id; draw(); } }, tplPreview(t.id, col), el('span', {}, t.name)));
      cgrid.innerHTML = '';
      for (const c of R.PAPER_COLORS) cgrid.append(el('button', { class: 'color-cell' + (c.c === col ? ' active' : ''), title: c.name, style: { background: c.c }, onclick: () => { col = c.c; draw(); } }));
    };
    draw();
    const apply = async all => {
      const targets = (all ? this.pages : [p]).filter(x => !x.pdf);
      for (const x of targets) { x.template = tpl; x.paperColor = col; }
      await store.saveMany('page', targets);
      closeMenu(); this.requestRender();
    };
    box.append(el('div', { class: 'pop-title' }, 'Modelo'), tgrid, el('div', { class: 'pop-title' }, 'Cor do papel'), cgrid,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => apply(true) }, 'Todas as páginas'),
        el('button', { class: 'btn primary', onclick: () => apply(false) }, 'Esta página')));
    if (p.pdf) box.prepend(el('p', { class: 'muted small' }, 'Páginas de PDF mantêm o fundo do PDF.'));
    popover(anchor, box, { align: 'right' });
  }

  async importPdfHere() {
    const file = await pickFile('application/pdf');
    if (!file) return;
    const b = busy('Importando PDF…');
    try {
      const p = this.currentPage();
      const i = this.pages.indexOf(p);
      const next = this.pages[i + 1];
      const pages = await addPdfPages(this.note.id, file, p.order, next ? next.order : p.order + 1000, t => b.set(t));
      this.pages.splice(i + 1, 0, ...pages);
      for (const np of pages) this.byPage.set(np.id, []);
      this.layout();
      this.cam.y = pages[0]._oy - 20 / this.cam.z;
      this.clampCam(); this.requestRender();
    } catch (e) {
      console.error(e);
      toast('Não consegui importar o PDF: ' + e.message, { kind: 'error' });
    } finally { b.close(); }
  }

  async exportPdf() {
    const b = busy('Gerando PDF…');
    try {
      await Promise.all([...this.pending]);
      const blob = await exportNotePdf(this.note, t => b.set(t));
      b.close();
      await shareOrDownload(blob, (this.note.title || 'nota') + '.pdf');
    } catch (e) {
      b.close();
      console.error(e);
      toast('Erro ao exportar: ' + e.message, { kind: 'error' });
    }
  }

  openMoreMenu(anchor) {
    const p = this.currentPage();
    menu(anchor, [
      { label: 'Adicionar página depois desta', icon: 'pagePlus', onClick: () => this.addPageAfter(p) },
      { label: 'Modelo e cor do papel', icon: 'notes', onClick: () => setTimeout(() => this.openPaperMenu(anchor)) },
      { label: 'Importar PDF nesta nota', icon: 'file', onClick: () => this.importPdfHere() },
      Editor.clipboard?.length ? { label: 'Colar', icon: 'copy', onClick: () => this.pasteClipboard() } : null,
      { sep: true },
      { label: 'Exportar / compartilhar PDF', icon: 'share', onClick: () => this.exportPdf() },
      { label: 'Ajustar à largura', icon: 'search', onClick: () => { const cy = this.cam.y + this.vh / this.cam.z / 2; this.fitWidth(false); this.cam.y = cy - this.vh / this.cam.z / 2; this.clampCam(); this.requestRender(); } },
      { label: 'Desenhar com o dedo', icon: 'finger', checked: this.fingerDraw, onClick: () => { this.fingerDraw = !this.fingerDraw; savePref('fingerDraw', this.fingerDraw); toast(this.fingerDraw ? 'O dedo agora desenha. Use dois dedos para rolar.' : 'Só o Apple Pencil desenha. O dedo rola a página.'); } },
      { sep: true },
      { label: 'Excluir esta página', icon: 'trash', danger: true, onClick: () => this.deletePage(p) },
    ], { align: 'right' });
  }

  async rename() {
    const t = await promptText('Nome da nota', this.note.title);
    if (t == null || !t) return;
    this.note.title = t;
    this.titleBtn.textContent = t;
    await store.save('note', this.note);
  }

  // ---------- Painel de páginas (miniaturas) ----------
  togglePages(force) {
    this.pagesOpen = force ?? !this.pagesOpen;
    this.pagesPanel.classList.toggle('hidden', !this.pagesOpen);
    this.pagesBtn.classList.toggle('active', this.pagesOpen);
    if (this.pagesOpen) this.renderPagesPanel();
    else { this.thumbObs?.disconnect(); this.pagesPanel.innerHTML = ''; this.pagesGrid = null; }
  }

  renderPagesPanel() {
    if (!this.pagesOpen) return;
    const panel = this.pagesPanel;
    const keepScroll = this.pagesGrid?.scrollTop;
    this.thumbObs?.disconnect();
    panel.innerHTML = '';
    const cur = this.currentPage();
    const grid = el('div', { class: 'pages-grid' });
    this.thumbObs = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) { this.thumbObs.unobserve(en.target); this.drawThumb(en.target); }
    }, { root: grid, rootMargin: '300px' });
    this.pages.forEach((p, i) => {
      const cv = el('canvas', { class: 'pthumb-c', style: { aspectRatio: `${p.w} / ${p.h}` } });
      cv._page = p;
      const cell = el('div', { class: 'pthumb' + (p === cur ? ' active' : ''), 'data-id': p.id },
        el('button', { class: 'pthumb-img', title: 'Ir para a página ' + (i + 1), onclick: () => this.goToPage(p) }, cv),
        el('div', { class: 'pthumb-bar' },
          el('span', { class: 'pthumb-grip', title: 'Arraste para mudar a ordem' }, icon('grip', 18)),
          el('span', { class: 'pthumb-num' }, String(i + 1)),
          iconBtn('more', 'Opções da página', e => this.pageMenu(e.currentTarget, p), 'small')));
      cell.querySelector('.pthumb-grip').addEventListener('pointerdown', e => this.startPageDrag(e, p, cell));
      grid.append(cell);
      this.thumbObs.observe(cv);
    });
    panel.append(
      el('div', { class: 'pages-head' }, el('b', {}, `Páginas · ${this.pages.length}`),
        iconBtn('pagePlus', 'Adicionar página no fim', () => this.addPageAfter(this.pages[this.pages.length - 1])),
        iconBtn('x', 'Fechar', () => this.togglePages(false))),
      grid,
      el('p', { class: 'muted small center pages-tip' }, 'Toque para ir · arraste pelos pontinhos para reordenar'));
    this.pagesGrid = grid;
    if (keepScroll != null) grid.scrollTop = keepScroll;
    else grid.querySelector('.pthumb.active')?.scrollIntoView({ block: 'center' });
  }

  async drawThumb(cv) {
    const p = cv._page;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(140 * dpr);
    cv.width = W; cv.height = Math.round(W * p.h / p.w);
    const ctx = cv.getContext('2d');
    const s = W / p.w;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    R.drawPaper(ctx, p, s);
    if (p.pdf) {
      try {
        this._thumbChain = (this._thumbChain || Promise.resolve()).catch(() => { }).then(() => pdf.renderPageCanvas(p, s));
        const pc = await this._thumbChain;
        ctx.drawImage(pc, 0, 0, p.w, p.h);
        pc.width = 0;
      } catch { }
    }
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, p.w, p.h); ctx.clip();
    R.drawItems(ctx, this.pageItems(p.id), { getImage: id => this.getImage(id), dark: !p.pdf && R.isDarkColor(p.paperColor) });
    ctx.restore();
  }

  refreshThumbs = debounce(ids => {
    if (!this.pagesGrid) return;
    for (const cv of this.pagesGrid.querySelectorAll('canvas')) if (ids.has(cv._page.id)) this.drawThumb(cv);
    this._thumbIds = new Set();
  }, 700);

  goToPage(p) {
    this.cam.y = p._oy - 16 / this.cam.z;
    this.clampCam(); this.requestRender();
    if (this.vw < 520) this.togglePages(false);
  }

  pageMenu(anchor, p) {
    const i = this.pages.indexOf(p);
    menu(anchor, [
      { label: 'Adicionar página depois', icon: 'pagePlus', onClick: () => this.addPageAfter(p) },
      { label: 'Duplicar página', icon: 'copy', onClick: () => this.duplicatePage(p) },
      i > 0 ? { label: 'Mover para cima', icon: 'up', onClick: () => this.movePageTo(p, i - 1) } : null,
      i < this.pages.length - 1 ? { label: 'Mover para baixo', icon: 'down', onClick: () => this.movePageTo(p, i + 1) } : null,
      { sep: true },
      { label: 'Excluir página', icon: 'trash', danger: true, onClick: () => this.deletePage(p) },
    ], { align: 'right' });
  }

  // idx = posição final na lista
  async movePageTo(p, idx) {
    const arr = this.pages.filter(x => x !== p);
    idx = clamp(idx, 0, arr.length);
    const prev = arr[idx - 1], next = arr[idx];
    p.order = prev && next ? (prev.order + next.order) / 2 : prev ? prev.order + 1 : next ? next.order - 1 : 1;
    arr.splice(idx, 0, p);
    this.pages = arr;
    await store.save('page', p);
    this.layout(); this.clampCam(); this.requestRender();
  }

  async duplicatePage(p) {
    const i = this.pages.indexOf(p);
    const next = this.pages[i + 1];
    const order = next ? (p.order + next.order) / 2 : p.order + 1;
    const np = await store.save('page', { ...store.strip(p), id: uid(), order, deleted: false });
    const clones = this.pageItems(p.id).map(it => ({ ...store.strip(it), id: uid(), pageId: np.id, rec: null, deleted: false }));
    this.pages.splice(i + 1, 0, np);
    this.byPage.set(np.id, []);
    clones.forEach(c => this.addMem(c));
    this.persist('item', clones);
    this.layout(); this.requestRender();
    toast('Página duplicada.');
  }

  startPageDrag(e, p, cell) {
    e.preventDefault(); e.stopPropagation();
    const grid = this.pagesGrid;
    const r = cell.getBoundingClientRect();
    const ghost = cell.cloneNode(true);
    const src = cell.querySelector('canvas'), gc = ghost.querySelector('canvas');
    gc.width = src.width; gc.height = src.height;
    gc.getContext('2d').drawImage(src, 0, 0);
    ghost.classList.add('pthumb-ghost');
    ghost.style.width = r.width + 'px';
    document.body.append(ghost);
    cell.classList.add('dragging');
    const offX = e.clientX - r.left, offY = e.clientY - r.top;
    let target = this.pages.indexOf(p);
    let scrollV = 0, raf = 0;
    const tick = () => { if (scrollV) { grid.scrollTop += scrollV; raf = requestAnimationFrame(tick); } else raf = 0; };
    const move = ev => {
      ghost.style.left = (ev.clientX - offX) + 'px';
      ghost.style.top = (ev.clientY - offY) + 'px';
      const gr = grid.getBoundingClientRect();
      scrollV = ev.clientY < gr.top + 50 ? -10 : ev.clientY > gr.bottom - 50 ? 10 : 0;
      if (scrollV && !raf) raf = requestAnimationFrame(tick);
      const cells = [...grid.querySelectorAll('.pthumb')];
      let idx = cells.length;
      for (let k = 0; k < cells.length; k++) {
        const cr = cells[k].getBoundingClientRect();
        if (ev.clientY < cr.top || (ev.clientY <= cr.bottom && ev.clientX < cr.left + cr.width / 2)) { idx = k; break; }
      }
      cells.forEach(c => c.classList.remove('drop-before', 'drop-after'));
      if (idx < cells.length) cells[idx].classList.add('drop-before'); else cells[cells.length - 1]?.classList.add('drop-after');
      target = idx;
    };
    const up = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      scrollV = 0;
      ghost.remove();
      cell.classList.remove('dragging');
      grid.querySelectorAll('.drop-before, .drop-after').forEach(c => c.classList.remove('drop-before', 'drop-after'));
      const from = this.pages.indexOf(p);
      const to = target > from ? target - 1 : target;
      if (to !== from) await this.movePageTo(p, to);
      else this.renderPagesPanel();
    };
    move(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // ---------- Áudio ----------
  async toggleRecord() {
    if (audio.isRecording()) {
      const r = await audio.stopRecording();
      if (r) { toast('Gravação salva.'); await this.loadRecordings(); }
      return;
    }
    if (this.player) this.closePlayer();
    try {
      await audio.startRecording(this.note.id);
      toast('Gravando… O que você escrever fica ligado ao áudio.');
    } catch (e) {
      console.error(e);
      toast(e.name === 'NotAllowedError' ? 'Permita o acesso ao microfone nos Ajustes do iPad (Safari > Microfone).' : 'Não foi possível gravar: ' + e.message, { kind: 'error', timeout: 7000 });
    }
  }

  updateRecUi() {
    if (!this.recBtn) return;
    const r = audio.activeRecording();
    const on = !!r && r.noteId === this.note.id;
    this.recBtn.classList.toggle('recording', on);
    clearInterval(this._recT);
    const timeEl = this.recBtn.querySelector('.rec-time');
    if (on) {
      const tick = () => { timeEl.textContent = fmtTime(audio.elapsedMs() / 1000); };
      tick();
      this._recT = setInterval(tick, 500);
    } else timeEl.textContent = 'Gravar';
    this.recBtn.title = on ? 'Parar gravação' : 'Gravar aula';
    this.liveCap?.classList.toggle('hidden', !on);
    this.playBtn.classList.toggle('has-dot', !!this.recordings?.length);
  }

  openRecordingsMenu(anchor) {
    const list = el('div', { class: 'menu rec-menu' });
    list.append(el('div', { class: 'menu-header' }, 'Gravações desta nota'));
    if (!this.recordings.length) list.append(el('p', { class: 'muted small pad' }, 'Nenhuma gravação ainda. Toque no microfone para gravar a aula enquanto escreve.'));
    for (const r of this.recordings) {
      list.append(el('div', { class: 'rec-row' },
        el('button', { class: 'menu-item', onclick: () => { closeMenu(); this.openPlayer(r); } }, icon('play', 16), el('span', {}, r.title), el('span', { class: 'muted small' }, fmtTime(r.duration))),
        el('button', { class: 'icon-btn small', title: 'Renomear', onclick: async () => { closeMenu(); const t = await promptText('Nome da gravação', r.title); if (t) { r.title = t; await store.save('recording', r); } } }, icon('text', 16)),
        el('button', { class: 'icon-btn small danger', title: 'Excluir', onclick: async () => { closeMenu(); if (await confirmBox('Excluir gravação?', r.title, { ok: 'Excluir', danger: true })) { if (this.player?.rec.id === r.id) this.closePlayer(); r.deleted = true; await store.save('recording', r); await this.loadRecordings(); } } }, icon('trash', 16))));
    }
    popover(anchor, list, { align: 'right' });
  }

  playbackState() {
    const P = this.player;
    if (!P) return null;
    return { recId: P.rec.id, t: P.audio.currentTime * 1000 };
  }

  async openPlayer(rec, seek = null, autoplay = false) {
    if (audio.isRecording()) return toast('Pare a gravação antes de ouvir.');
    if (this.player?.rec.id === rec.id) {
      if (seek != null) { this.player.audio.currentTime = Math.max(0, seek); if (autoplay) this.player.audio.play(); }
      return;
    }
    this.closePlayer();
    const bar = this.playerBar;
    bar.classList.remove('hidden');
    bar.innerHTML = '';
    bar.append(el('div', { class: 'muted' }, 'Carregando áudio…'));
    const blob = await store.getFileBlob(rec.blobId).catch(() => null);
    if (!blob) { bar.innerHTML = ''; bar.append(el('div', { class: 'muted' }, 'Este áudio ainda não foi baixado da nuvem. Conecte-se à internet e tente de novo.'), iconBtn('x', 'Fechar', () => this.closePlayer())); return; }
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    a.preload = 'auto';
    a.src = url;
    const P = { rec, audio: a, url, rate: 1 };
    this.player = P;
    const playBtn = iconBtn('play', 'Tocar', () => a.paused ? a.play() : a.pause(), 'big');
    const cur = el('span', { class: 'time' }, '0:00');
    const dur = el('span', { class: 'time' }, fmtTime(rec.duration));
    const range = el('input', { type: 'range', min: 0, max: rec.duration || 1, step: 0.1, value: 0, class: 'range grow' });
    range.addEventListener('input', () => { a.currentTime = +range.value; this.requestRender(); });
    const rateBtn = el('button', { class: 'btn small', onclick: () => { const rates = [1, 1.25, 1.5, 2, 0.75]; P.rate = rates[(rates.indexOf(P.rate) + 1) % rates.length]; a.playbackRate = P.rate; rateBtn.textContent = P.rate + 'x'; } }, '1x');
    bar.innerHTML = '';
    bar.append(
      el('span', { class: 'rec-title' }, rec.title),
      iconBtn('back15', 'Voltar 15 s', () => { a.currentTime = Math.max(0, a.currentTime - 15); this.requestRender(); }),
      playBtn,
      iconBtn('fwd15', 'Avançar 15 s', () => { a.currentTime = Math.min(rec.duration, a.currentTime + 15); this.requestRender(); }),
      cur, range, dur, rateBtn,
      rec.transcript?.length ? el('button', { class: 'btn small', onclick: () => this.toggleTranscript() }, icon('text', 16), 'Transcrição') : null,
      iconBtn('x', 'Fechar', () => this.closePlayer()));
    const sync = () => {
      cur.textContent = fmtTime(a.currentTime);
      range.value = a.currentTime;
      this.highlightSeg(a.currentTime * 1000);
      this.requestRender();
    };
    a.addEventListener('timeupdate', sync);
    a.addEventListener('play', () => { playBtn.replaceChildren(icon('pause')); P.tick = setInterval(sync, 120); });
    a.addEventListener('pause', () => { playBtn.replaceChildren(icon('play')); clearInterval(P.tick); sync(); });
    a.addEventListener('ended', () => { playBtn.replaceChildren(icon('play')); clearInterval(P.tick); });
    if (seek != null) {
      const go = () => { a.currentTime = Math.max(0, seek); if (autoplay) a.play().catch(() => { }); };
      if (a.readyState >= 1) go(); else a.addEventListener('loadedmetadata', go, { once: true });
    }
    this.resize(); this.clampCam();
    this.requestRender();
  }

  seekTo(rec, sec) { this.openPlayer(rec, Math.max(0, sec), true); }

  toggleTranscript() {
    const P = this.player;
    if (this.trPanel) { this.trPanel.remove(); this.trPanel = null; this.resize(); this.render(); return; }
    if (!P) return;
    const segs = P.rec.transcript || [];
    const full = segs.map(s => s.text).join(' ');
    const list = el('div', { class: 'tr-list' });
    segs.forEach((s, i) => list.append(el('button', { class: 'tr-seg', 'data-i': i, onclick: () => { P.audio.currentTime = s.t / 1000; P.audio.play().catch(() => { }); } },
      el('span', { class: 'tr-time' }, fmtTime(s.t / 1000)), el('span', {}, s.text))));
    this.trPanel = el('div', { class: 'tr-panel' },
      el('div', { class: 'tr-head' }, el('b', {}, 'Transcrição'), el('span', { class: 'muted small' }, 'toque numa frase para ouvir'),
        el('span', { style: { flex: 1 } }),
        el('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(full).then(() => toast('Texto copiado.'), () => toast('Não foi possível copiar.')) }, icon('copy', 16), 'Copiar'),
        el('button', { class: 'btn small', onclick: () => this.transcriptToNote(full) }, icon('text', 16), 'Colocar na nota'),
        iconBtn('x', 'Fechar', () => this.toggleTranscript(), 'small')),
      list);
    this.root.insertBefore(this.trPanel, this.playerBar);
    this._segI = -1;
    this.highlightSeg(P.audio.currentTime * 1000);
    this.resize(); this.render();
  }

  highlightSeg(ms) {
    if (!this.trPanel || !this.player) return;
    const segs = this.player.rec.transcript || [];
    let i = -1;
    for (let k = 0; k < segs.length; k++) if (segs[k].t <= ms) i = k; else break;
    if (i === this._segI) return;
    this._segI = i;
    this.trPanel.querySelectorAll('.tr-seg').forEach(b => b.classList.toggle('active', +b.dataset.i === i));
    this.trPanel.querySelector('.tr-seg.active')?.scrollIntoView({ block: 'nearest' });
  }

  async transcriptToNote(text) {
    if (!text) return;
    const p = this.currentPage();
    await this.addPageAfter(p);
    const np = this.pages[this.pages.indexOf(p) + 1];
    const it = { id: uid(), type: 'text', noteId: this.note.id, pageId: np.id, x: 70, y: 70, w: np.w - 140, text: 'Transcrição — ' + (this.player?.rec.title || '') + '\n\n' + text, fontSize: 24, color: '#1d1d1f', z: now(), deleted: false };
    this.addMem(it);
    this.persist('item', [it]);
    this.pushUndo({ type: 'add', items: [it] });
    this.requestRender();
    toast('Transcrição colocada numa página nova.');
  }

  closePlayer() {
    const P = this.player;
    if (!P) return;
    this.trPanel?.remove(); this.trPanel = null;
    this.player = null;
    P.audio.pause();
    clearInterval(P.tick);
    URL.revokeObjectURL(P.url);
    this.playerBar.classList.add('hidden');
    this.playerBar.innerHTML = '';
    this.requestRender();
  }

  // ---------- Saída ----------
  async exit() {
    if (this._exiting) return;
    this._exiting = true;
    if (this.editing) this.finishText();
    if (audio.isRecording()) { const r = await audio.stopRecording(); if (r) toast('Gravação salva.'); }
    this.closePlayer();
    await Promise.all([...this.pending]);
    this.note._cam = this.camSnapshot();
    if (this.changed || !this.note.thumb) {
      try { this.note.thumb = await renderThumb(this.pages[0], this.pageItems(this.pages[0].id), id => this.getImage(id)); } catch (e) { console.warn(e); }
    }
    this.touchNote.cancel();
    await store.save('note', this.note).catch(() => { });
    this.destroy();
    this.onExit?.();
  }

  destroy() {
    this.cleanup.forEach(f => f());
    this.unsubs?.forEach(f => f());
    clearInterval(this._recT);
    cancelAnimationFrame(this.rafMain); cancelAnimationFrame(this.rafLive);
    this.stopInertia();
    pdf.closeAll();
    for (const e of this.images.values()) if (e.url) URL.revokeObjectURL(e.url);
    this.images.clear();
    this.ctx = null;
  }
}

// Aplica escala (em torno de ox,oy) e deslocamento a um item
function transformItem(it, ox, oy, sc, dx, dy) {
  const fx = x => ox + (x - ox) * sc + dx, fy = y => oy + (y - oy) * sc + dy;
  if (it.type === 'stroke') {
    const f = R.geom(it).f.slice();
    for (let i = 0; i < f.length; i += 3) { f[i] = fx(f[i]); f[i + 1] = fy(f[i + 1]); }
    it.size = it.size * sc;
    it.pts = encodePts(f);
    it.bbox = R.computeBBox(f, it.size);
  } else {
    it.x = fx(it.x); it.y = fy(it.y); it.w *= sc;
    if (it.type === 'text') it.fontSize *= sc;
    else it.h *= sc;
  }
}

export async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('formato não suportado')); i.src = url; });
    let w = img.naturalWidth, h = img.naturalHeight;
    const max = 2200;
    if (file.size < 1_500_000 && Math.max(w, h) <= max && /^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      return { data: await file.arrayBuffer(), mime: file.type, w, h };
    }
    const s = Math.min(1, max / Math.max(w, h));
    w = Math.round(w * s); h = Math.round(h * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.88));
    return { data: await blob.arrayBuffer(), mime: 'image/jpeg', w, h };
  } finally { URL.revokeObjectURL(url); }
}

function tplPreview(t, col) {
  const c = document.createElement('canvas');
  c.width = 62; c.height = 84;
  const ctx = c.getContext('2d');
  ctx.scale(62 / 1240, 84 / 1754);
  R.drawPaper(ctx, { w: 1240, h: 1754, template: t, paperColor: col }, 0.3);
  return c;
}
