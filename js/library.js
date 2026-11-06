// Biblioteca: Matéria → Tema → Notas, recentes, favoritas, busca por título, lixeira e ajustes

import * as db from './db.js';
import * as store from './store.js';
import * as sync from './sync.js';
import { el, fmtDate, fmtBytes, loadPref, savePref, isIPad, now, defaultPaper, APP_VERSION } from './util.js';
import { icon, iconBtn, toast, menu, modal, promptText, confirmBox, pickFile, busy, applyTheme } from './ui.js';
import { importPdfAsNote, exportNotePdf, shareOrDownload, exportBackup, importBackup } from './export.js';
import { TEMPLATES, PAPER_COLORS } from './render.js';
import { CardsSection, openCardEditor } from './cards-ui.js';
import * as audio from './audio.js';
import { prepareImage } from './editor.js';
import { showWelcome, showHelp } from './help.js';
import * as auto from './autocards.js';

// Segurar o dedo (~0,5 s) abre o menu, sem disparar o toque normal
function longPress(node, fn) {
  let t = null, sx = 0, sy = 0, fired = false;
  node.addEventListener('pointerdown', e => {
    fired = false; sx = e.clientX; sy = e.clientY;
    clearTimeout(t);
    t = setTimeout(() => { fired = true; navigator.vibrate?.(10); fn(); }, 520);
  });
  const cancel = () => clearTimeout(t);
  node.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', e => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } }, true);
  node.addEventListener('contextmenu', e => e.preventDefault());
}

const SUBJECT_COLORS =['#2f6fed', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#e93d82', '#6e6e73', '#d9730d', '#5b5bd6'];

const NONE = '__none';

export class Library {
  constructor(root, { openNote }) {
    this.root = root;
    this.openNote = openNote;
    this.view = loadPref('libView', { type: 'recent' });
    this.sort = loadPref('libSort', 'updated');
    this.expanded = new Set(loadPref('expanded', []));
    this.query = '';
    this.unsubs = [];
    this.section = loadPref('section', 'notes');
    this.cards = new CardsSection(this);
  }

  async setSection(s) {
    this.section = s;
    savePref('section', s);
    this.root.classList.remove('side-open');
    await this.cards.load();
    this.renderSidebar();
    this.renderMain();
  }

  async init() {
    this.root.className = 'library';
    this.root.innerHTML = '';
    this.sidebar = el('aside', { class: 'lib-side' });
    this.main = el('main', { class: 'lib-main' });
    this.root.append(this.sidebar, this.main);
    this.unsubs.push(
      store.bus.on('remote', () => this.refresh()),
      sync.syncBus.on('status', () => this.renderSyncChip()),
    );
    await this.refresh();
    if (!loadPref('welcomed', false)) { savePref('welcomed', true); showWelcome(this); }
    // flashcards automáticos das anotações (roda sozinho, fora da nota aberta)
    this.autoT = setTimeout(() => this.runAuto(false), 4000);
    const vis = () => { if (document.visibilityState === 'visible') { clearTimeout(this.autoT); this.autoT = setTimeout(() => this.runAuto(false), 4000); } };
    document.addEventListener('visibilitychange', vis);
    this.unsubs.push(() => document.removeEventListener('visibilitychange', vis), () => clearTimeout(this.autoT));
  }

  async runAuto(force) {
    if (!force && !auto.isEnabled()) return;
    if (force) toast('Lendo suas anotações para criar flashcards…', { timeout: 2500 });
    const s = await auto.run({ force });
    if (!s) return;
    if (s.cards) {
      toast(`✨ ${s.cards} flashcard(s) novos criados das suas anotações${s.decks.length ? ' em ' + s.decks.join(', ') : ''}.`, {
        timeout: 9000, action: 'Ver', onAction: async () => { await this.setSection('cards'); this.cards.filter = 'auto'; this.cards.go({ type: 'browse', auto: true }); },
      });
    } else if (force) toast(s.error ? 'Não deu para ler agora: ' + s.error : s.pages ? 'Li suas páginas, mas não encontrei conteúdo novo para virar carta.' : 'Nenhuma página nova ou alterada para ler.', { timeout: 7000 });
    if (s.error && !force && /chave|key/i.test(s.error)) toast('Flashcards automáticos: ' + s.error, { timeout: 8000 });
    if (this.root.isConnected) this.refresh();
  }

  destroy() { this.unsubs.forEach(f => f()); }

  // ---------- Estrutura ----------
  async refresh() {
    this.subjects = await store.listSubjects();
    this.notes = await store.listNotes();
    this.byId = new Map(this.subjects.map(s => [s.id, s]));
    this.materias = this.subjects.filter(s => !s.parentId || !this.byId.has(s.parentId));
    const v = this.view;
    if ((v.type === 'subject' || v.type === 'topic') && !this.byId.has(v.subjectId)) this.view = { type: 'recent' };
    await this.cards.load();
    this.renderSidebar();
    await this.renderMain();
  }

  topicsOf(mid) { return this.subjects.filter(s => s.parentId === mid); }
  isTopic(s) { return !!(s?.parentId && this.byId.has(s.parentId)); }
  live() { return this.notes.filter(n => !n.trashed); }
  // [matéria, tema?] da nota
  pathOf(n) {
    const s = this.byId.get(n.subjectId);
    if (!s) return [];
    return this.isTopic(s) ? [this.byId.get(s.parentId), s] : [s];
  }
  countIn(sid) {
    const ids = new Set([sid, ...this.topicsOf(sid).map(t => t.id)]);
    return this.live().filter(n => ids.has(n.subjectId)).length;
  }
  colorOf(s) { return s.color || (s.parentId && this.byId.get(s.parentId)?.color) || '#6e6e73'; }

  setView(v) {
    this.view = v;
    this.query = '';
    savePref('libView', v);
    if (v.type === 'topic') { const t = this.byId.get(v.subjectId); if (t?.parentId) this.expanded.add(t.parentId); }
    if (v.type === 'subject') this.expanded.add(v.subjectId);
    savePref('expanded', [...this.expanded]);
    this.root.classList.remove('side-open');
    this.renderSidebar();
    this.renderMain();
  }

  // ---------- Barra lateral ----------
  renderSidebar() {
    const s = this.sidebar;
    s.innerHTML = '';
    const live = this.live();
    const v = this.view;
    const row = ({ label, ic, color, active, onClick, count, extra, cls = '' }) =>
      el('div', { class: 'side-row ' + cls + (active ? ' active' : ''), onclick: onClick },
        color ? el('span', { class: 'subj-dot', style: { background: color } }) : icon(ic, 20),
        el('span', { class: 'side-label' }, label),
        count != null ? el('span', { class: 'count' }, count) : null, extra);

    s.append(el('div', { class: 'brand' }, el('img', { src: 'icons/icon-192.png', alt: '' }), el('span', {}, 'Anota')));
    const due = this.cards.dueTotal();
    s.append(el('div', { class: 'seg-tabs' },
      el('button', { class: this.section === 'notes' ? 'active' : '', onclick: () => this.setSection('notes') }, icon('notes', 18), 'Notas'),
      el('button', { class: this.section === 'cards' ? 'active' : '', onclick: () => this.setSection('cards') }, icon('cards', 18), 'Flashcards', due ? el('span', { class: 'badge' }, due > 99 ? '99+' : due) : null)));
    if (this.section === 'cards') {
      this.cards.renderSidebar(s, row);
      this.syncChip = el('button', { class: 'sync-chip', onclick: () => (sync.getUser() ? this.openSyncCheck() : this.openSettings()) });
      s.append(el('div', { class: 'side-foot' }, this.syncChip, iconBtn('help', 'Como usar', () => showHelp(this)), iconBtn('gear', 'Ajustes', () => this.openSettings())));
      this.renderSyncChip();
      return;
    }
    s.append(
      row({ label: 'Recentes', ic: 'clock', active: v.type === 'recent', onClick: () => this.setView({ type: 'recent' }) }),
      row({ label: 'Favoritas', ic: 'star', active: v.type === 'starred', count: live.filter(n => n.starred).length || null, onClick: () => this.setView({ type: 'starred' }) }),
      row({ label: 'Todas as notas', ic: 'notes', active: v.type === 'all', count: live.length, onClick: () => this.setView({ type: 'all' }) }),
      row({ label: 'Sem matéria', ic: 'inbox', active: v.type === 'unfiled', count: live.filter(n => !this.byId.has(n.subjectId)).length || null, onClick: () => this.setView({ type: 'unfiled' }) }));

    s.append(el('div', { class: 'side-header' }, el('span', {}, 'Matérias'), iconBtn('plus', 'Nova matéria', () => this.newSubject(), 'small')));
    const list = el('div', { class: 'side-list' });
    for (const m of this.materias) {
      const topics = this.topicsOf(m.id);
      const open = this.expanded.has(m.id);
      const chev = el('button', {
        class: 'chev' + (open ? ' open' : '') + (topics.length ? '' : ' no-topics'), title: open ? 'Recolher' : 'Mostrar temas',
        onclick: e => { e.stopPropagation(); open ? this.expanded.delete(m.id) : this.expanded.add(m.id); savePref('expanded', [...this.expanded]); this.renderSidebar(); },
      }, icon('chevron', 14));
      const more = iconBtn('more', 'Opções da matéria', e => { e.stopPropagation(); this.subjectMenu(e.currentTarget, m); }, 'side-more');
      const r = row({ label: m.name, color: this.colorOf(m), active: v.type === 'subject' && v.subjectId === m.id, count: this.countIn(m.id), extra: more, onClick: () => this.setView({ type: 'subject', subjectId: m.id }) });
      r.prepend(chev);
      longPress(r, () => this.subjectMenu(more, m));
      list.append(r);
      if (open) {
        for (const t of topics) {
          const tmore = iconBtn('more', 'Opções do tema', e => { e.stopPropagation(); this.topicMenu(e.currentTarget, t); }, 'side-more');
          const tr = row({ label: t.name, ic: 'tag', cls: 'child', active: v.type === 'topic' && v.subjectId === t.id, count: live.filter(n => n.subjectId === t.id).length, extra: tmore, onClick: () => this.setView({ type: 'topic', subjectId: t.id }) });
          tr.querySelector('svg').style.color = this.colorOf(m);
          longPress(tr, () => this.topicMenu(tmore, t));
          list.append(tr);
        }
        list.append(el('div', { class: 'side-row child add', onclick: () => this.newTopic(m) }, icon('plus', 16), el('span', { class: 'side-label' }, 'Novo tema')));
      }
    }
    if (!this.materias.length) list.append(el('p', { class: 'muted small pad' }, 'Crie uma matéria (ex.: Biologia) e, dentro dela, temas (ex.: Citologia, Genética).'));
    s.append(list);
    const trashed = this.notes.filter(n => n.trashed).length;
    s.append(row({ label: 'Lixeira', ic: 'trash', active: v.type === 'trash', count: trashed || null, onClick: () => this.setView({ type: 'trash' }) }));
    this.syncChip = el('button', { class: 'sync-chip', onclick: () => (sync.getUser() ? this.openSyncCheck() : this.openSettings()) });
    s.append(el('div', { class: 'side-foot' }, this.syncChip, iconBtn('help', 'Como usar', () => showHelp(this)), iconBtn('gear', 'Ajustes', () => this.openSettings())));
    this.renderSyncChip();
  }

  renderSyncChip() {
    if (!this.syncChip) return;
    const st = sync.getState();
    let ic = 'cloudOff', txt = 'Só neste aparelho', cls = '';
    if (st.status === 'off') { ic = 'cloudOff'; txt = 'Nuvem não configurada'; }
    else if (st.status === 'signed-out') { ic = 'cloudOff'; txt = 'Entrar para sincronizar'; cls = 'warn'; }
    else if (st.status === 'syncing') { ic = 'sync'; txt = 'Sincronizando…'; cls = 'spin'; }
    else if (st.status === 'offline') { ic = 'cloudOff'; txt = st.pending ? `Offline · ${st.pending} pendentes` : 'Offline · salvo neste aparelho'; }
    else if (st.status === 'error') { ic = 'cloudOff'; txt = 'Erro na sincronização'; cls = 'warn'; }
    else if (st.pending) { ic = 'cloud'; txt = `${st.pending} pendentes`; }
    else { ic = 'cloudOk'; txt = 'Tudo salvo na nuvem'; cls = 'ok'; }
    this.syncChip.className = 'sync-chip ' + cls;
    this.syncChip.replaceChildren(icon(ic, 18), el('span', {}, txt));
  }

  // ---------- Matérias e temas ----------
  async newSubject() {
    const name = await promptText('Nova matéria', '', { placeholder: 'Ex.: Biologia', ok: 'Criar' });
    if (!name) return null;
    const sub = await store.createSubject(name, SUBJECT_COLORS[this.materias.length % SUBJECT_COLORS.length]);
    await this.refresh();
    this.setView({ type: 'subject', subjectId: sub.id });
    return sub;
  }

  async newTopic(m, { go = true } = {}) {
    const name = await promptText(`Novo tema em ${m.name}`, '', { placeholder: 'Ex.: Citologia', ok: 'Criar' });
    if (!name) return null;
    const t = await store.createSubject(name, null, m.id);
    this.expanded.add(m.id); savePref('expanded', [...this.expanded]);
    await this.refresh();
    if (go) this.setView({ type: 'topic', subjectId: t.id });
    return t;
  }

  async renameSubject(s) {
    const topic = this.isTopic(s);
    const n = await promptText(topic ? 'Renomear tema' : 'Renomear matéria', s.name, { ok: 'Salvar' });
    if (!n || n === s.name) return;
    s.name = n;
    await store.save('subject', s);
    toast(`Renomeado para "${n}".`);
    this.refresh();
  }

  subjectMenu(anchor, m) {
    menu(anchor, [
      { header: m.name },
      { label: 'Renomear', icon: 'pen', onClick: () => this.renameSubject(m) },
      { label: 'Novo tema dentro desta matéria', icon: 'plus', onClick: () => this.newTopic(m) },
      { label: 'Mudar cor', icon: 'palette', onClick: () => this.pickColor(m) },
      { sep: true },
      { label: 'Excluir matéria', icon: 'trash', danger: true, onClick: async () => {
        const topics = this.topicsOf(m.id);
        if (!await confirmBox(`Excluir "${m.name}"?`, `Nenhuma nota é apagada: as ${this.countIn(m.id)} nota(s) vão para "Sem matéria"${topics.length ? ` e os ${topics.length} tema(s) são removidos` : ''}.`, { ok: 'Excluir', danger: true })) return;
        const ids = new Set([m.id, ...topics.map(t => t.id)]);
        for (const n of this.notes.filter(n => ids.has(n.subjectId))) { n.subjectId = null; await store.save('note', n); }
        for (const t of topics) { t.deleted = true; await store.save('subject', t); }
        m.deleted = true; await store.save('subject', m);
        this.view = { type: 'unfiled' };
        this.refresh();
      } },
    ]);
  }

  topicMenu(anchor, t) {
    const parent = this.byId.get(t.parentId);
    menu(anchor, [
      { header: t.name },
      { label: 'Renomear', icon: 'pen', onClick: () => this.renameSubject(t) },
      this.materias.length > 1 ? { label: 'Mover para outra matéria', icon: 'folder', onClick: () => this.moveTopic(t) } : null,
      { sep: true },
      { label: 'Excluir tema', icon: 'trash', danger: true, onClick: async () => {
        const count = this.live().filter(n => n.subjectId === t.id).length;
        if (!await confirmBox(`Excluir o tema "${t.name}"?`, `Nenhuma nota é apagada: ${count ? `as ${count} nota(s) ficam em "${parent.name}", sem tema` : 'o tema está vazio'}.`, { ok: 'Excluir', danger: true })) return;
        for (const n of this.notes.filter(n => n.subjectId === t.id)) { n.subjectId = parent.id; await store.save('note', n); }
        t.deleted = true; await store.save('subject', t);
        this.view = { type: 'subject', subjectId: parent.id };
        this.refresh();
      } },
    ]);
  }

  moveTopic(t) {
    let m;
    const list = el('div', { class: 'pick-tree' });
    for (const mat of this.materias) {
      list.append(el('button', { class: 'pick-row' + (mat.id === t.parentId ? ' current' : ''), onclick: async () => { t.parentId = mat.id; await store.save('subject', t); m.close(); this.refresh(); } },
        el('span', { class: 'subj-dot', style: { background: this.colorOf(mat) } }), el('span', {}, mat.name), mat.id === t.parentId ? icon('check', 16) : null));
    }
    m = modal(el('div', {}, el('h3', {}, `Mover "${t.name}" para…`), list));
  }

  pickColor(sub) {
    const grid = el('div', { class: 'color-grid' });
    let m;
    for (const c of SUBJECT_COLORS) grid.append(el('button', { class: 'color-cell' + (c === sub.color ? ' active' : ''), style: { background: c }, onclick: async () => { sub.color = c; await store.save('subject', sub); m.close(); this.refresh(); } }));
    m = modal(el('div', {}, el('h3', {}, 'Cor da matéria'), grid));
  }

  // Escolher onde guardar uma nota (matéria / tema). Resolve com id, NONE ou undefined (cancelado)
  pickLocation(title, currentId) {
    return new Promise(res => {
      let done = false;
      const finish = v => { if (done) return; done = true; m.close(); res(v); };
      const box = el('div', {});
      const draw = () => {
        box.innerHTML = '';
        const list = el('div', { class: 'pick-tree' });
        const rowBtn = (label, id, opts = {}) => el('button', {
          class: 'pick-row' + (opts.child ? ' child' : '') + ((currentId ?? NONE) === id ? ' current' : ''),
          onclick: () => finish(id),
        }, opts.color ? el('span', { class: 'subj-dot', style: { background: opts.color } }) : icon(opts.ic || 'inbox', 18),
          el('span', {}, label), (currentId ?? NONE) === id ? icon('check', 16) : null);
        list.append(rowBtn('Sem matéria', NONE));
        for (const mat of this.materias) {
          list.append(rowBtn(mat.name + (this.topicsOf(mat.id).length ? ' · sem tema' : ''), mat.id, { color: this.colorOf(mat) }));
          for (const t of this.topicsOf(mat.id)) {
            const b = rowBtn(t.name, t.id, { child: true, ic: 'tag' });
            b.querySelector('svg').style.color = this.colorOf(mat);
            list.append(b);
          }
          list.append(el('button', { class: 'pick-row child add', onclick: async () => { const t = await this.newTopic(mat, { go: false }); if (t) finish(t.id); } }, icon('plus', 16), el('span', {}, `Novo tema em ${mat.name}`)));
        }
        box.append(el('h3', {}, title), list,
          el('div', { class: 'modal-actions' },
            el('button', { class: 'btn', onclick: async () => {
              const name = await promptText('Nova matéria', '', { placeholder: 'Ex.: Biologia', ok: 'Criar' });
              if (!name) return;
              const s = await store.createSubject(name, SUBJECT_COLORS[this.materias.length % SUBJECT_COLORS.length]);
              await this.refresh();
              finish(s.id);
            } }, icon('plus', 18), 'Nova matéria'),
            el('button', { class: 'btn', onclick: () => finish(undefined) }, 'Cancelar')));
      };
      draw();
      const m = modal(box, { onClose: () => finish(undefined) });
    });
  }

  // ---------- Conteúdo principal ----------
  viewInfo() {
    const v = this.view;
    const s = this.byId.get(v.subjectId);
    switch (v.type) {
      case 'recent': return { title: 'Recentes', icon: 'clock', target: undefined };
      case 'starred': return { title: 'Favoritas', icon: 'star', target: undefined };
      case 'unfiled': return { title: 'Sem matéria', icon: 'inbox', target: NONE };
      case 'subject': return { title: s.name, color: this.colorOf(s), target: s.id };
      case 'topic': return { title: s.name, parent: this.byId.get(s.parentId), color: this.colorOf(s), target: s.id };
      case 'trash': return { title: 'Lixeira', icon: 'trash', target: undefined };
      default: return { title: 'Todas as notas', icon: 'notes', target: undefined };
    }
  }

  sortList(list) {
    const by = {
      updated: (a, b) => b.updatedAt - a.updatedAt,
      created: (a, b) => b.createdAt - a.createdAt,
      name: (a, b) => (a.title || '').localeCompare(b.title || '', 'pt-BR', { numeric: true, sensitivity: 'base' }),
    }[this.sort];
    return list.sort(by);
  }

  async renderMain() {
    const m = this.main;
    const keepFocus = document.activeElement?.classList.contains('search');
    if (this.section === 'cards') {
      const holder = el('div', {});
      await this.cards.renderMain(holder);
      m.replaceChildren(...holder.childNodes);
      return;
    }
    m.innerHTML = '';
    const v = this.view;
    const info = this.viewInfo();
    const search = el('input', { type: 'search', class: 'search', placeholder: 'Buscar pelo título…', value: this.query, enterkeyhint: 'search' });
    search.addEventListener('input', () => { this.query = search.value; this.renderBody(); });
    const sortLabels = { updated: 'Modificadas', created: 'Criadas', name: 'Nome (A–Z)' };
    const sortBtn = el('button', { class: 'btn ghost', onclick: e => menu(e.currentTarget, Object.entries(sortLabels).map(([k, l]) => ({ label: l, checked: this.sort === k, onClick: () => { this.sort = k; savePref('libSort', k); this.renderBody(); } })), { align: 'right' }) }, icon('list', 18), 'Ordenar');
    const actions = el('div', { class: 'lib-actions' }, search, sortBtn);
    if (v.type !== 'trash') {
      if (v.type === 'subject') actions.append(el('button', { class: 'btn', onclick: () => this.newTopic(this.byId.get(v.subjectId)) }, icon('tag', 18), 'Novo tema'));
      actions.append(
        el('button', { class: 'btn', onclick: () => this.importPdf() }, icon('file', 18), 'Importar PDF'),
        el('button', { class: 'btn primary', onclick: () => this.newNote() }, icon('plus', 18), 'Nova nota'));
    } else if (this.notes.some(n => n.trashed)) {
      actions.append(el('button', { class: 'btn danger', onclick: () => this.emptyTrash() }, icon('trash', 18), 'Esvaziar lixeira'));
    }
    const titleEl = el('h1', {});
    if (info.parent) {
      titleEl.append(el('button', { class: 'crumb', onclick: () => this.setView({ type: 'subject', subjectId: info.parent.id }) },
        el('span', { class: 'subj-dot', style: { background: this.colorOf(info.parent) } }), info.parent.name), el('span', { class: 'crumb-sep' }, icon('chevron', 18)));
    } else if (info.color) titleEl.append(el('span', { class: 'subj-dot big', style: { background: info.color } }));
    const subj = (v.type === 'subject' || v.type === 'topic') ? this.byId.get(v.subjectId) : null;
    if (subj) {
      // toque no nome para renomear + botão de opções sempre visível
      titleEl.append(el('button', { class: 'title-edit', title: 'Renomear', onclick: () => this.renameSubject(subj) }, el('span', {}, info.title), icon('pen', 18)));
      actions.prepend(el('button', { class: 'btn', onclick: e => (this.isTopic(subj) ? this.topicMenu(e.currentTarget, subj) : this.subjectMenu(e.currentTarget, subj)) }, icon('more', 18), 'Opções'));
    } else titleEl.append(el('span', {}, info.title));
    m.append(el('header', { class: 'lib-head' },
      iconBtn('menu', 'Matérias', () => this.root.classList.toggle('side-open'), 'only-narrow'), titleEl, actions));
    const banner = await this.banner();
    if (banner) m.append(banner);
    this.body = el('div', { class: 'lib-body' });
    m.append(this.body);
    this.renderBody();
    if (keepFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  renderBody() {
    const b = this.body;
    if (!b) return;
    b.innerHTML = '';
    const v = this.view;
    const q = this.query.trim().toLowerCase();
    // Busca: sempre em todas as notas (fora da lixeira), só pelo título
    if (q) {
      const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const nq = norm(q);
      const res = this.sortList(this.live().filter(n => norm(n.title).includes(nq)));
      b.append(el('p', { class: 'muted small' }, `${res.length} resultado(s) para “${this.query.trim()}” em todas as notas`));
      b.append(this.grid(res, { showPath: true, empty: 'Nenhuma nota com esse título.' }));
      return;
    }
    const live = this.live();
    if (v.type === 'recent') {
      b.append(this.quickActions());
      const list = [...live].sort((a, c) => (c.lastOpenedAt || c.updatedAt) - (a.lastOpenedAt || a.updatedAt)).slice(0, 40);
      if (list.length) b.append(el('h3', { class: 'sub-h' }, 'Abertas recentemente'));
      if (!this.materias.length && live.length) b.append(this.tip());
      b.append(this.grid(list, { showPath: true, empty: 'Nenhuma nota ainda. Toque em "Nova nota" ou importe um PDF.' }));
    } else if (v.type === 'starred') {
      b.append(this.grid(this.sortList(live.filter(n => n.starred)), { showPath: true, empty: 'Nenhuma favorita. No menu ••• de uma nota, toque em "Favoritar".' }));
    } else if (v.type === 'unfiled') {
      b.append(this.grid(this.sortList(live.filter(n => !this.byId.has(n.subjectId))), { empty: 'Tudo organizado! Nenhuma nota sem matéria.' }));
    } else if (v.type === 'subject') {
      this.renderSubjectSections(this.byId.get(v.subjectId));
    } else if (v.type === 'topic') {
      b.append(this.grid(this.sortList(live.filter(n => n.subjectId === v.subjectId)), { empty: 'Nenhuma nota neste tema ainda. Toque em "Nova nota".' }));
    } else if (v.type === 'trash') {
      b.append(this.grid(this.sortList(this.notes.filter(n => n.trashed)), { showPath: true, trash: true, empty: 'A lixeira está vazia.' }));
      b.append(el('p', { class: 'muted small center' }, 'Notas na lixeira podem ser restauradas. Elas só são apagadas de verdade quando você exclui definitivamente.'));
    } else {
      if (!this.materias.length && live.length) b.append(this.tip());
      b.append(this.grid(this.sortList([...live]), { showPath: true, empty: 'Nenhuma nota ainda. Toque em "Nova nota" ou importe um PDF.' }));
    }
  }

  // Atalhos para tudo que o app faz (além de anotar)
  quickActions() {
    const due = this.cards.dueTotal();
    const tile = (ic, title, desc, onClick, cls = '') => el('button', { class: 'qa-tile ' + cls, onclick: onClick },
      el('span', { class: 'qa-ico' }, icon(ic, 24)), el('span', { class: 'qa-title' }, title), el('span', { class: 'qa-desc' }, desc));
    return el('div', { class: 'qa-grid' },
      tile('pen', 'Nova nota', 'Escreva à mão com o Apple Pencil', () => this.newNote(), 'c-blue'),
      tile('mic', 'Gravar aula', 'Áudio + transcrição ligados ao que você escreve', () => this.recordLecture(), 'c-red'),
      tile('file', 'Importar PDF', 'Slides e apostilas para anotar por cima', () => this.importPdf(), 'c-orange'),
      tile('camera', 'Foto ou imagem', 'Foto do quadro, do livro ou da galeria', () => this.photoNote(), 'c-green'),
      tile('cards', due ? `Flashcards (${due})` : 'Flashcards', due ? `${due} cartas para revisar hoje` : 'Memorize com repetição espaçada', () => this.setSection('cards'), 'c-purple'),
      tile('help', 'Como usar', 'Todas as funções explicadas', () => showHelp(this), 'c-gray'));
  }

  async recordLecture() {
    const subjectId = await this.targetFor();
    if (subjectId === undefined) return;
    const d = new Date();
    const note = await store.createNote({
      title: 'Aula ' + d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      subjectId, template: loadPref('defaultTemplate', 'lined'), paperColor: defaultPaper(),
    });
    try { await audio.startRecording(note.id); toast('Gravando a aula. Escreva normalmente: cada anotação fica ligada ao momento do áudio.'); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Permita o microfone em Ajustes do iPad › Safari › Microfone.' : 'Não foi possível gravar: ' + e.message, { kind: 'error', timeout: 7000 }); }
    this.openNote(note.id);
  }

  async photoNote() {
    const file = await pickFile('image/*');
    if (!file) return;
    const subjectId = await this.targetFor();
    if (subjectId === undefined) return;
    const b = busy('Preparando a imagem…');
    try {
      const d = new Date();
      const note = await store.createNote({ title: 'Foto ' + d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), subjectId, template: 'blank', paperColor: defaultPaper() });
      const [page] = await store.getPages(note.id);
      const { data, mime, w, h } = await prepareImage(file);
      const blob = await store.createBlob({ noteId: note.id, data, mime, name: file.name });
      const iw = page.w - 120, ih = Math.min(page.h - 120, iw * h / w), iw2 = ih * w / h;
      await store.save('item', { id: crypto.randomUUID(), type: 'image', noteId: note.id, pageId: page.id, x: (page.w - iw2) / 2, y: 60, w: iw2, h: ih, blobId: blob.id, z: now(), deleted: false });
      b.close();
      this.openNote(note.id);
    } catch (e) { b.close(); toast('Não consegui usar a imagem: ' + e.message, { kind: 'error' }); }
  }

  tip() {
    return el('div', { class: 'banner' }, icon('folder', 20),
      el('div', {}, el('b', {}, 'Organize assim: '), 'Matéria (ex.: Biologia) → Tema (ex.: Citologia) → Notas. Crie uma matéria no "+" da barra lateral.'));
  }

  // Dentro da matéria: uma seção por tema + "Sem tema"
  renderSubjectSections(m) {
    const b = this.body;
    const live = this.live();
    const topics = this.topicsOf(m.id);
    const color = this.colorOf(m);
    b.append(el('p', { class: 'muted small' }, `${topics.length} tema(s) · ${this.countIn(m.id)} nota(s)`));
    if (!topics.length) {
      b.append(el('div', { class: 'banner' }, icon('tag', 20),
        el('div', {}, el('b', {}, 'Dica: '), `divida ${m.name} em temas (ex.: capítulos ou assuntos da prova) para achar tudo mais rápido.`),
        el('button', { class: 'btn small primary', onclick: () => this.newTopic(m) }, 'Criar tema')));
    }
    const section = (title, list, sid, isTopic, topic) => {
      const head = el('div', { class: 'section-head' },
        el('button', { class: 'section-title', onclick: isTopic ? () => this.setView({ type: 'topic', subjectId: sid }) : null },
          icon(isTopic ? 'tag' : 'notes', 18), el('span', {}, title), el('span', { class: 'count' }, list.length)),
        el('button', { class: 'btn small ghost', onclick: () => this.newNote(sid) }, icon('plus', 16), 'Nota'),
        isTopic ? iconBtn('more', 'Opções do tema', e => this.topicMenu(e.currentTarget, topic), 'small') : null);
      head.querySelector('svg').style.color = color;
      b.append(el('section', { class: 'note-section' }, head,
        this.grid(this.sortList(list), { compactEmpty: true, empty: isTopic ? 'Nenhuma nota neste tema.' : 'Nenhuma nota sem tema.' })));
    };
    for (const t of topics) section(t.name, live.filter(n => n.subjectId === t.id), t.id, true, t);
    const general = live.filter(n => n.subjectId === m.id);
    if (general.length || !topics.length) section(topics.length ? 'Sem tema' : 'Notas', general, m.id, false);
  }

  grid(list, { showPath = false, trash = false, empty = '', compactEmpty = false } = {}) {
    const g = el('div', { class: 'note-grid' });
    if (!list.length) {
      g.append(compactEmpty ? el('p', { class: 'muted small empty-inline' }, empty)
        : el('div', { class: 'empty' }, icon(trash ? 'trash' : 'notes', 48), el('p', {}, empty)));
      return g;
    }
    for (const n of list) {
      const path = showPath ? this.pathOf(n) : [];
      const more = el('button', { class: 'icon-btn small card-more', title: 'Opções', onclick: e => { e.stopPropagation(); trash ? this.trashMenu(e.currentTarget, n) : this.noteMenu(e.currentTarget, n); } }, icon('more', 18));
      const card = el('div', { class: 'note-card', onclick: () => { if (trash) this.trashMenu(more, n); else this.openNote(n.id); } },
        el('div', { class: 'thumb' }, n.thumb ? el('img', { src: n.thumb, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb-empty' }),
          n.starred ? el('span', { class: 'star-badge' }, icon('starFill', 14)) : null),
        el('div', { class: 'card-info' },
          el('div', { class: 'card-title' }, n.title || 'Sem título'),
          path.length ? el('div', { class: 'card-path', style: { '--c': this.colorOf(path[0]) } }, el('span', { class: 'subj-dot' }), path.map(p => p.name).join(' › ')) : null,
          el('div', { class: 'card-meta' }, el('span', {}, fmtDate(n.updatedAt))),
          more));
      g.append(card);
    }
    return g;
  }

  async banner() {
    const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    if (isIPad() && !standalone) {
      return el('div', { class: 'banner warn' }, icon('download', 20),
        el('div', {}, el('b', {}, 'Adicione à Tela de Início para seus dados ficarem seguros. '),
          'No Safari, toque em Compartilhar (quadrado com seta) → "Adicionar à Tela de Início" e abra o app pelo ícone. No Safari comum, o iPad pode apagar os dados de sites não usados por 7 dias.'));
    }
    const st = sync.getState();
    if (st.status === 'signed-out') {
      return el('div', { class: 'banner' }, icon('cloud', 20), el('div', {}, el('b', {}, 'Entre na sua conta para ter cópia na nuvem. '), 'Suas notas já estão salvas neste aparelho.'),
        el('button', { class: 'btn small primary', onclick: () => this.openSettings() }, 'Entrar'));
    }
    const lastBackup = await db.getMeta('lastBackupAt', null);
    const days = lastBackup ? (now() - lastBackup) / 86400000 : Infinity;
    if (st.status === 'off' && this.notes.length && days > 7) {
      return el('div', { class: 'banner' }, icon('download', 20), el('div', {}, el('b', {}, 'Faça um backup. '), lastBackup ? `Último backup há ${Math.floor(days)} dias.` : 'Você ainda não fez nenhum backup.'),
        el('button', { class: 'btn small primary', onclick: () => this.doBackup() }, 'Fazer backup'));
    }
    return null;
  }

  // ---------- Ações de notas ----------
  async targetFor(forced) {
    if (forced !== undefined) return forced === NONE ? null : forced;
    const t = this.viewInfo().target;
    if (t !== undefined) return t === NONE ? null : t;
    if (!this.subjects.length) return null;
    const picked = await this.pickLocation('Onde guardar a nota?', NONE);
    if (picked === undefined) return undefined;
    return picked === NONE ? null : picked;
  }

  async newNote(forcedSubject) {
    const subjectId = await this.targetFor(forcedSubject);
    if (subjectId === undefined) return;
    const tpl = loadPref('defaultTemplate', 'lined'), col = defaultPaper();
    const d = new Date();
    const note = await store.createNote({
      title: 'Nota ' + d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      subjectId, template: tpl, paperColor: col,
    });
    if (this.view.type === 'starred') { note.starred = true; await store.save('note', note); }
    this.openNote(note.id);
  }

  async importPdf() {
    const subjectId = await this.targetFor();
    if (subjectId === undefined) return;
    const files = await pickFile('application/pdf', true);
    if (!files?.length) return;
    const b = busy('Importando PDF…');
    let last = null;
    try {
      for (const f of files) {
        b.set(`Importando ${f.name}…`);
        last = await importPdfAsNote(f, subjectId, t => b.set(`${f.name}: ${t}`));
      }
    } catch (e) {
      console.error(e);
      toast('Não consegui importar: ' + e.message, { kind: 'error' });
    } finally { b.close(); }
    if (files.length === 1 && last) this.openNote(last.id); else this.refresh();
  }

  noteMenu(anchor, n) {
    const path = this.pathOf(n);
    menu(anchor, [
      path.length ? { header: path.map(p => p.name).join(' › ') } : null,
      { label: 'Abrir', icon: 'notes', onClick: () => this.openNote(n.id) },
      { label: 'Renomear', icon: 'text', onClick: async () => { const t = await promptText('Nome da nota', n.title); if (t) { n.title = t; await store.save('note', n); this.refresh(); } } },
      { label: n.starred ? 'Tirar das favoritas' : 'Favoritar', icon: n.starred ? 'starFill' : 'star', onClick: async () => { n.starred = !n.starred; await store.save('note', n); this.refresh(); } },
      { label: 'Mover para matéria / tema…', icon: 'folder', onClick: async () => {
        const id = await this.pickLocation(`Mover "${n.title}" para…`, n.subjectId && this.byId.has(n.subjectId) ? n.subjectId : NONE);
        if (id === undefined) return;
        n.subjectId = id === NONE ? null : id;
        await store.save('note', n);
        const p = this.pathOf(n);
        toast(p.length ? `Movida para ${p.map(x => x.name).join(' › ')}` : 'Movida para "Sem matéria"');
        this.refresh();
      } },
      { label: 'Exportar PDF', icon: 'share', onClick: async () => {
        const b = busy('Gerando PDF…');
        try { const blob = await exportNotePdf(n, t => b.set(t)); b.close(); await shareOrDownload(blob, (n.title || 'nota') + '.pdf'); }
        catch (e) { b.close(); toast('Erro ao exportar: ' + e.message, { kind: 'error' }); }
      } },
      { sep: true },
      { label: 'Mover para a lixeira', icon: 'trash', danger: true, onClick: async () => {
        n.trashed = true; await store.save('note', n); this.refresh();
        toast('Nota movida para a lixeira.', { action: 'Desfazer', onAction: async () => { n.trashed = false; await store.save('note', n); this.refresh(); } });
      } },
    ], { align: 'right' });
  }

  trashMenu(anchor, n) {
    menu(anchor, [
      { label: 'Restaurar', icon: 'restore', onClick: async () => { n.trashed = false; await store.save('note', n); this.refresh(); toast('Nota restaurada.'); } },
      { label: 'Excluir definitivamente', icon: 'trash', danger: true, onClick: async () => {
        if (!await confirmBox('Excluir definitivamente?', `"${n.title}" será apagada deste aparelho e da nuvem. Não dá para desfazer.`, { ok: 'Excluir', danger: true })) return;
        await store.purgeNote(n); this.refresh();
      } },
    ], { align: 'right' });
  }

  async emptyTrash() {
    const list = this.notes.filter(n => n.trashed);
    if (!await confirmBox(`Esvaziar a lixeira (${list.length})?`, 'Essas notas serão apagadas deste aparelho e da nuvem. Não dá para desfazer.', { ok: 'Esvaziar', danger: true })) return;
    for (const n of list) await store.purgeNote(n);
    this.refresh();
  }

  // ---------- Backup ----------
  async doBackup() {
    const b = busy('Preparando backup…');
    try {
      const { blob, missing } = await exportBackup(t => b.set(t));
      b.close();
      const d = new Date();
      await shareOrDownload(blob, `Anota-backup-${d.toISOString().slice(0, 10)}.zip`);
      if (missing) toast(`${missing} arquivo(s) não estavam neste aparelho e ficaram de fora (estão na nuvem).`, { timeout: 7000 });
      this.renderMain();
    } catch (e) {
      b.close();
      console.error(e);
      toast('Erro no backup: ' + e.message, { kind: 'error' });
    }
  }

  async doRestore() {
    const f = await pickFile('.zip,application/zip');
    if (!f) return;
    const b = busy('Restaurando…');
    try {
      const n = await importBackup(f, t => b.set(t));
      b.close();
      toast(`Backup restaurado (${n} registros).`);
      this.refresh();
    } catch (e) {
      b.close();
      toast('Erro ao restaurar: ' + e.message, { kind: 'error' });
    }
  }

  // ---------- Ajustes ----------
  async openSettings() {
    const box = el('div', { class: 'settings' });
    const m = modal(box, { wide: true });
    const draw = async () => {
      box.innerHTML = '';
      box.append(el('div', { class: 'settings-head' }, el('h2', {}, 'Ajustes'), iconBtn('x', 'Fechar', () => m.close())));
      box.append(await this.accountSection(draw));
      box.append(await this.autoSection(draw, m));
      box.append(el('section', {},
        el('h4', {}, 'Backup em arquivo'),
        el('p', { class: 'muted small' }, 'Gera um arquivo .zip com todas as notas, PDFs e áudios. Salve no app Arquivos ou no iCloud Drive. Serve para restaurar tudo em qualquer aparelho.'),
        el('p', { class: 'small' }, 'Último backup: ' + ((await db.getMeta('lastBackupAt')) ? fmtDate(await db.getMeta('lastBackupAt')) : 'nunca')),
        el('div', { class: 'row-btns' },
          el('button', { class: 'btn primary', onclick: () => { m.close(); this.doBackup(); } }, icon('download', 18), 'Fazer backup agora'),
          el('button', { class: 'btn', onclick: () => { m.close(); this.doRestore(); } }, icon('upload', 18), 'Restaurar backup'))));
      const info = await store.storageInfo();
      const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
      box.append(el('section', {},
        el('h4', {}, 'Armazenamento neste aparelho'),
        el('p', { class: 'small' }, info.usage != null ? `Usando ${fmtBytes(info.usage)}${info.quota ? ' de ' + fmtBytes(info.quota) + ' disponíveis' : ''}.` : 'Uso não disponível.'),
        el('p', { class: 'small' }, 'Armazenamento protegido: ', el('b', {}, info.persisted ? 'sim' : 'não'),
          info.persisted ? '' : ' (abra pelo ícone da Tela de Início; a nuvem e o backup protegem seus dados de qualquer forma)'),
        el('p', { class: 'small' }, 'Aberto como app da Tela de Início: ', el('b', {}, standalone ? 'sim' : 'não')),
        el('p', { class: 'muted small' }, 'Atenção: se você apagar o ícone do app da Tela de Início, o iPad apaga os dados locais junto. Com a nuvem ligada, é só entrar de novo que tudo volta.')));
      const tplSel = el('select', { class: 'field' }, ...TEMPLATES.map(t => el('option', { value: t.id, selected: loadPref('defaultTemplate', 'lined') === t.id }, t.name)));
      tplSel.addEventListener('change', () => savePref('defaultTemplate', tplSel.value));
      const chosen = loadPref('defaultPaper', null);
      const colSel = el('select', { class: 'field' }, el('option', { value: '', selected: !chosen }, 'Igual ao tema do app'),
        ...PAPER_COLORS.map(c => el('option', { value: c.c, selected: chosen === c.c }, c.name)));
      colSel.addEventListener('change', () => savePref('defaultPaper', colSel.value || null));
      const darkAll = el('button', { class: 'btn small', onclick: async () => {
        const col = colSel.value || defaultPaper();
        const name = PAPER_COLORS.find(c => c.c === col)?.name || 'escolhida';
        if (!await confirmBox(`Usar o papel "${name}" em todas as notas?`, 'Muda a cor das folhas das notas que já existem (PDFs continuam como são). O que você escreveu não muda; a tinta preta fica clara no papel escuro.', { ok: 'Aplicar' })) return;
        const pages = (await db.getAll('pages')).filter(p => !p.deleted && !p.pdf && p.paperColor !== col);
        for (const p of pages) p.paperColor = col;
        await store.saveMany('page', pages);
        const ids = new Set(pages.map(p => p.noteId));
        for (const n of this.notes.filter(n => ids.has(n.id))) { n.thumb = null; await store.save('note', n); }
        toast(`${pages.length} página(s) atualizadas.`);
        this.refresh();
      } }, 'Aplicar às notas que já existem');
      const themeSel = el('select', { class: 'field' }, ...[['dark', 'Escuro'], ['light', 'Claro'], ['auto', 'Automático (igual ao iPad)']].map(([v, l]) => el('option', { value: v, selected: loadPref('theme', 'dark') === v }, l)));
      themeSel.addEventListener('change', () => { savePref('theme', themeSel.value); applyTheme(themeSel.value); });
      const finger = el('input', { type: 'checkbox' });
      finger.checked = loadPref('fingerDraw', false);
      finger.addEventListener('change', () => savePref('fingerDraw', finger.checked));
      const trans = el('input', { type: 'checkbox' });
      trans.checked = loadPref('transcribe', true);
      trans.addEventListener('change', () => savePref('transcribe', trans.checked));
      const tlang = el('select', { class: 'field' }, ...[['pt-BR', 'Português'], ['en-US', 'Inglês'], ['es-ES', 'Espanhol'], ['fr-FR', 'Francês']].map(([v, l]) => el('option', { value: v, selected: loadPref('transcribeLang', 'pt-BR') === v }, l)));
      tlang.addEventListener('change', () => savePref('transcribeLang', tlang.value));
      box.append(el('section', {},
        el('h4', {}, 'Aparência e escrita'),
        el('label', { class: 'field-row' }, el('span', {}, 'Tema do app'), themeSel),
        el('label', { class: 'field-row' }, el('span', {}, 'Papel padrão das notas novas'), tplSel),
        el('label', { class: 'field-row' }, el('span', {}, 'Cor do papel das notas novas'), colSel),
        el('div', { class: 'field-row' }, el('span', { class: 'muted small' }, 'Quer mudar também as notas antigas?'), darkAll),
        el('label', { class: 'field-row' }, el('span', {}, 'Desenhar com o dedo (desligado = só o Apple Pencil escreve)'), finger),
        el('label', { class: 'field-row' }, el('span', {}, 'Transcrever o áudio ao gravar (precisa de internet)'), trans),
        el('label', { class: 'field-row' }, el('span', {}, 'Idioma da transcrição'), tlang),
        el('div', { class: 'row-btns' }, el('button', { class: 'btn', onclick: () => { m.close(); showHelp(this); } }, icon('help', 18), 'Ver como usar todas as funções'))));
      box.append(el('p', { class: 'muted small center' }, `Anota ${APP_VERSION}`));
    };
    draw();
  }

  async autoSection(redraw, m) {
    const sec = el('section', {}, el('h4', {}, '✨ Flashcards automáticos (grátis)'));
    const on = el('input', { type: 'checkbox' });
    on.checked = loadPref('autoCards', true);
    on.addEventListener('change', () => savePref('autoCards', on.checked));
    const last = await auto.lastRun();
    const hasKey = !!auto.getKey();
    sec.append(
      el('p', { class: 'muted small' }, 'Sozinho, sem você fazer nada, o app cria cartas a partir das suas anotações e guarda em baralhos separados por matéria e tema:'),
      el('ul', { class: 'small auto-list' },
        el('li', {}, el('b', {}, 'Marca-texto em PDF'), ' → vira carta de lacuna (sem internet, sem conta).'),
        el('li', {}, el('b', {}, 'Caixa de texto com "termo: definição"'), ' → vira pergunta e resposta. Dica: na caixa de texto você pode escrever à mão com o Pencil que o iPad converte em texto.'),
        el('li', {}, el('b', {}, 'Letra à mão solta na página'), ' → precisa da chave gratuita do Google abaixo (opcional).')),
      el('label', { class: 'field-row' }, el('span', {}, 'Criar flashcards automaticamente'), on));
    const keyIn = el('input', { type: 'text', class: 'field', placeholder: 'Cole aqui a chave do Google AI Studio (começa com AIza…)', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', value: auto.getKey() });
    const msg = el('p', { class: 'small' }, hasKey ? '✓ Chave salva neste aparelho. A letra à mão também está sendo lida.' : '');
    sec.append(
      el('details', { class: 'auto-key', open: !hasKey ? true : null },
        el('summary', {}, hasKey ? 'Leitura da letra à mão: ligada' : 'Ligar a leitura da letra à mão (grátis, 1 minuto)'),
        el('ol', { class: 'small' },
          el('li', {}, 'Toque em ', el('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'aistudio.google.com/apikey'), ' e entre com sua conta Google.'),
          el('li', {}, 'Toque em "Create API key" (Criar chave). É grátis, sem cartão.'),
          el('li', {}, 'Copie a chave, volte aqui, cole abaixo e toque em "Salvar e testar".')),
        keyIn, msg,
        el('div', { class: 'row-btns' },
          el('button', { class: 'btn primary', onclick: async () => {
            const k = keyIn.value.trim();
            if (!k) { auto.setKey(''); msg.textContent = 'Chave removida.'; return; }
            msg.className = 'small'; msg.textContent = 'Testando…';
            try { const model = await auto.testKey(k); auto.setKey(k); msg.textContent = `✓ Funcionou! (${model}). A letra à mão agora também vira flashcard.`; }
            catch (e) { msg.className = 'small error'; msg.textContent = 'Não funcionou: ' + e.message; }
          } }, 'Salvar e testar'),
          hasKey ? el('button', { class: 'btn', onclick: () => { auto.setKey(''); keyIn.value = ''; msg.textContent = 'Chave removida deste aparelho.'; } }, 'Remover chave') : null),
        el('p', { class: 'muted small' }, 'A chave fica só neste aparelho (não vai para a nuvem nem para o GitHub). As imagens das páginas são enviadas ao Google para leitura; no plano gratuito o Google pode usar esse conteúdo para melhorar os serviços dele. Sem chave, nada sai do aparelho.')),
      el('p', { class: 'small' }, 'Última leitura: ' + (last ? `${fmtDate(last.at)} · ${last.pages} página(s) · ${last.cards} carta(s) nova(s)` + (last.error ? ` · aviso: ${last.error}` : '') : 'ainda não')),
      el('div', { class: 'row-btns' }, el('button', { class: 'btn', onclick: () => { m.close(); this.runAuto(true); } }, icon('sparkle', 18), 'Gerar agora')));
    return sec;
  }

  // Tela que mostra, com certeza, se este aparelho e a nuvem estão iguais e quais aparelhos estão conectados
  openSyncCheck() {
    const box = el('div', { class: 'settings sync-check' });
    const m = modal(box, { wide: true });
    const head = () => el('div', { class: 'settings-head' }, el('h2', {}, 'Verificar sincronização'), iconBtn('x', 'Fechar', () => m.close()));
    const rel = ts => {
      const s = (Date.now() - ts) / 1000;
      if (s < 90) return 'agora mesmo';
      if (s < 3600) return `há ${Math.round(s / 60)} min`;
      if (s < 86400) return `há ${Math.round(s / 3600)} h`;
      return 'em ' + fmtDate(ts);
    };
    const busyView = txt => box.replaceChildren(head(), el('div', { class: 'busy' }, el('div', { class: 'spinner' }), el('p', {}, txt)));
    const action = async (txt, fn) => { busyView(txt); try { await fn(); } catch (e) { toast('Erro: ' + e.message, { kind: 'error' }); } load(); };
    const render = r => {
      const others = r.devices.filter(d => d.id !== r.me);
      let verdict;
      if (r.ok) verdict = el('div', { class: 'verdict ok' }, icon('cloudOk', 30), el('div', {}, el('b', {}, 'Tudo sincronizado ✓'),
        el('p', {}, 'Este aparelho e a nuvem têm exatamente o mesmo conteúdo, item por item. Todo aparelho conectado na mesma conta recebe tudo isso.')));
      else if (r.same && !r.pending && !r.toUpload && r.toDownload) verdict = el('div', { class: 'verdict warn' }, icon('download', 30), el('div', {}, el('b', {}, 'Quase lá: baixando arquivos'),
        el('p', {}, `${r.toDownload} arquivo(s) (PDF, áudio ou imagem) ainda estão chegando neste aparelho. Deixe o app aberto com internet por alguns minutos e verifique de novo.`)));
      else verdict = el('div', { class: 'verdict warn' }, icon('sync', 30), el('div', {}, el('b', {}, 'Ainda não está tudo igual'),
        el('p', {}, 'Toque em "Sincronizar agora". Se continuar diferente, use "Reenviar tudo deste aparelho". Nada é apagado.')));
      const nameIn = el('input', { type: 'text', class: 'field', value: sync.deviceInfo().name, placeholder: 'Nome deste aparelho' });
      const table = el('div', { class: 'sync-table' },
        el('div', { class: 'st-row st-head' }, el('span', {}, 'O quê'), el('span', {}, 'Neste aparelho'), el('span', {}, 'Na nuvem'), el('span', {}, '')),
        ...r.rows.map(x => el('div', { class: 'st-row' + (x.local === x.cloud ? '' : ' diff') }, el('span', {}, x.label), el('b', {}, String(x.local)), el('b', {}, String(x.cloud)), el('span', {}, x.local === x.cloud ? '✓' : '⚠'))));
      box.replaceChildren(head(), verdict,
        el('section', {},
          el('h4', {}, 'Aparelhos conectados nesta conta'),
          el('p', { class: 'muted small' }, 'Conta: ', el('b', {}, r.email)),
          el('div', { class: 'dev-list' }, ...r.devices.map(d => el('div', { class: 'dev-row' + (d.id === r.me ? ' me' : '') },
            el('span', { class: 'qa-ico ' + (/iPad|iPhone/.test(d.kind) ? 'c-purple' : 'c-blue') }, icon(/iPad|iPhone/.test(d.kind) ? 'pages' : 'notes', 20)),
            el('div', {}, el('b', {}, d.name + (d.id === r.me ? ' (este aparelho)' : '')),
              el('div', { class: 'muted small' }, `${d.app || ''} · versão ${d.version || '?'} · sincronizou ${rel(d.lastSync || d.at)}`))))),
          !others.length ? el('p', { class: 'small warn-text' }, 'Só este aparelho apareceu até agora. Abra o Anota no outro aparelho, entre com a mesma conta (Ajustes › Entrar) e verifique de novo.') : null,
          el('div', { class: 'field-row' }, el('span', { class: 'small' }, 'Nome deste aparelho'), nameIn,
            el('button', { class: 'btn small', onclick: () => action('Salvando…', async () => { sync.setDeviceName(nameIn.value); await sync.syncNow(true); }) }, 'Salvar'))),
        el('section', {}, el('h4', {}, 'Conteúdo: este aparelho × nuvem'), table,
          el('p', { class: 'small muted' }, `Alterações esperando envio: ${r.pending} · arquivos para enviar: ${r.toUpload} · arquivos para baixar: ${r.toDownload}`)),
        el('div', { class: 'row-btns' },
          el('button', { class: 'btn primary', onclick: () => load() }, icon('sync', 18), 'Sincronizar agora e verificar'),
          el('button', { class: 'btn', onclick: () => action('Reenviando tudo deste aparelho…', () => sync.resendAll()) }, icon('upload', 18), 'Reenviar tudo deste aparelho'),
          el('button', { class: 'btn', onclick: () => action('Baixando tudo da nuvem…', () => sync.redownloadAll()) }, icon('download', 18), 'Baixar tudo da nuvem de novo')),
        el('p', { class: 'muted small' }, 'Para ter certeza nos dois: faça esta verificação no PC e no iPad. Os dois precisam aparecer em "Aparelhos conectados" e mostrar "Tudo sincronizado ✓".'));
      this.refresh();
    };
    const load = async () => {
      busyView('Sincronizando e comparando com a nuvem…');
      try { render(await sync.verify()); }
      catch (e) {
        box.replaceChildren(head(), el('div', { class: 'verdict bad' }, icon('cloudOff', 30), el('div', {}, el('b', {}, 'Não deu para verificar agora'), el('p', {}, e.message))),
          el('div', { class: 'row-btns' }, el('button', { class: 'btn primary', onclick: load }, 'Tentar de novo')));
      }
    };
    load();
  }

  async accountSection(redraw) {
    const sec = el('section', {}, el('h4', {}, 'Nuvem (sincronização)'));
    if (!sync.configured()) {
      sec.append(el('p', { class: 'muted small' }, 'A nuvem ainda não foi configurada neste app. Suas notas estão salvas só neste aparelho. Faça backups.'));
      return sec;
    }
    const st = sync.getState();
    if (!st.user) {
      const email = el('input', { type: 'email', class: 'field', placeholder: 'E-mail', autocomplete: 'username', autocapitalize: 'off' });
      const pass = el('input', { type: 'password', class: 'field', placeholder: 'Senha (mínimo 6 caracteres)', autocomplete: 'current-password' });
      const msg = el('p', { class: 'small' });
      const go = async up => {
        msg.textContent = 'Aguarde…'; msg.className = 'small';
        try {
          if (up) {
            const r = await sync.signUp(email.value.trim(), pass.value);
            if (r.needsConfirm) { msg.textContent = 'Conta criada! Confirme pelo link que enviamos no seu e-mail e depois toque em Entrar.'; return; }
          } else await sync.signIn(email.value.trim(), pass.value);
          toast('Conectado! Sincronizando…');
          redraw();
        } catch (e) {
          msg.className = 'small error';
          msg.textContent = /invalid login/i.test(e.message) ? 'E-mail ou senha incorretos.'
            : /signups? not allowed|signup.*disabled/i.test(e.message) ? 'Novos cadastros estão desligados neste app. Use "Entrar" com a conta que você já tem.'
            : /confirm/i.test(e.message) ? 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada).' : e.message;
        }
      };
      sec.append(el('p', { class: 'muted small' }, 'Entre para guardar uma cópia de tudo na nuvem e recuperar em qualquer aparelho.'),
        email, pass, msg,
        el('div', { class: 'row-btns' },
          el('button', { class: 'btn primary', onclick: () => go(false) }, 'Entrar'),
          el('button', { class: 'btn', onclick: () => go(true) }, 'Criar conta')));
      return sec;
    }
    const labels = { ok: 'Tudo sincronizado', syncing: 'Sincronizando…', offline: 'Sem internet (salvo neste aparelho)', error: 'Erro: ' + (st.error || ''), idle: 'Aguardando' };
    sec.append(
      el('p', { class: 'small' }, 'Conta: ', el('b', {}, st.user.email)),
      el('p', { class: 'small' }, 'Status: ', labels[st.status] || st.status, st.pending ? ` · ${st.pending} alterações para enviar` : ''),
      el('p', { class: 'small' }, 'Última sincronização: ' + (st.lastSync ? fmtDate(st.lastSync) : 'ainda não')),
      el('div', { class: 'row-btns' },
        el('button', { class: 'btn primary', onclick: () => this.openSyncCheck() }, icon('check', 18), 'Verificar sincronização'),
        el('button', { class: 'btn', onclick: async () => { await sync.syncNow(true); redraw(); } }, icon('sync', 18), 'Sincronizar agora'),
        el('button', { class: 'btn', onclick: async () => {
          if (!await confirmBox('Sair da conta?', 'Suas notas continuam neste aparelho, mas param de ir para a nuvem.', { ok: 'Sair' })) return;
          await sync.signOut(); redraw();
        } }, 'Sair')));
    return sec;
  }
}
