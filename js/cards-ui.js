// Interface dos flashcards: baralhos, editor de cartas, estudo (revisão espaçada), cartões, teste, combinar e estatísticas

import * as C from './cards.js';
import * as db from './db.js';
import * as store from './store.js';
import { STATE, previews, formatWait, DEFAULT_OPTS, DAY, dayStart } from './srs.js';
import { el, loadPref, savePref, fmtDate, now, clamp } from './util.js';
import { icon, iconBtn, toast, menu, modal, promptText, confirmBox, pickFile, busy, closeMenu } from './ui.js';
import { getStroke } from '../vendor/perfect-freehand.mjs';
import * as R from './render.js';
import { shareOrDownload } from './export.js';
import * as auto from './autocards.js';

// ---------- Utilidades ----------
const urlCache = new Map();
async function blobUrl(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const b = await store.getFileBlob(id).catch(() => null);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urlCache.set(id, u);
  return u;
}
export function setHTML(node, html) {
  node.innerHTML = html || '';
  node.querySelectorAll('img[data-blob]').forEach(async img => { const u = await blobUrl(img.dataset.blob); if (u) img.src = u; });
  return node;
}
function speak(html, lang) {
  const t = C.htmlToText(html);
  if (!t) return;
  if (!window.speechSynthesis) return toast('Leitura em voz alta indisponível neste aparelho.');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t);
  u.lang = lang || 'pt-BR';
  const v = speechSynthesis.getVoices().find(v => v.lang.replace('_', '-').toLowerCase().startsWith(u.lang.slice(0, 2).toLowerCase()));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
const snippet = (html, n = 90) => { const t = C.htmlToText(html).replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t || (C.hasImage(html) ? '[imagem]' : '—'); };
const STATE_LABEL = c => c.suspended ? 'Suspensa' : c.state === STATE.NEW ? 'Nova' : c.state === STATE.REVIEW ? ((c.ivl || 0) >= 21 ? 'Madura' : 'Revisão') : 'Aprendendo';
const STATE_CLS = c => c.suspended ? 'st-susp' : c.state === STATE.NEW ? 'st-new' : c.state === STATE.REVIEW ? 'st-rev' : 'st-learn';

async function prepareImage(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('formato não suportado')); i.src = url; });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
    return { data: await blob.arrayBuffer(), mime: 'image/jpeg' };
  } finally { URL.revokeObjectURL(url); }
}

// ======================================================================
// Seção Flashcards (dentro da biblioteca)
// ======================================================================
export class CardsSection {
  constructor(lib) {
    this.lib = lib;
    this.view = loadPref('cardsView', { type: 'home' });
    this.filter = 'all';
    this.query = '';
  }

  async load() {
    this.decks = await C.listDecks();
    this.counts = await C.countsByDeck(this.decks);
    if (this.view.deckId && !this.decks.some(d => d.id === this.view.deckId)) this.view = { type: 'home' };
  }
  dueOf(d) { const c = this.counts[d.id] || {}; return (c.new || 0) + (c.learn || 0) + (c.review || 0); }
  dueTotal() { return (this.decks || []).reduce((s, d) => s + this.dueOf(d), 0); }
  async go(v) {
    this.view = v; savePref('cardsView', v);
    this.query = ''; this.filter = v.auto ? 'auto' : 'all';
    this.lib.root.classList.remove('side-open');
    await this.load();
    this.lib.renderSidebar(); this.lib.renderMain();
  }
  async refresh() { await this.load(); this.lib.renderSidebar(); await this.lib.renderMain(); }
  deckPath(d) {
    const s = this.lib.byId.get(d.subjectId);
    if (!s) return [];
    return this.lib.isTopic(s) ? [this.lib.byId.get(s.parentId), s] : [s];
  }
  deckColor(d) { const p = this.deckPath(d); return p.length ? this.lib.colorOf(p[0]) : '#8e8e93'; }

  // ---------- Barra lateral ----------
  renderSidebar(s, row) {
    const v = this.view;
    s.append(
      row({ label: 'Visão geral', ic: 'cards', active: v.type === 'home', count: this.dueTotal() || null, onClick: () => this.go({ type: 'home' }) }),
      row({ label: 'Todas as cartas', ic: 'list', active: v.type === 'browse', onClick: () => this.go({ type: 'browse' }) }),
      row({ label: 'Estatísticas', ic: 'chart', active: v.type === 'stats', onClick: () => this.go({ type: 'stats' }) }));
    s.append(el('div', { class: 'side-header' }, el('span', {}, 'Baralhos'), iconBtn('plus', 'Novo baralho', () => this.newDeck(), 'small')));
    const list = el('div', { class: 'side-list' });
    for (const d of this.decks) {
      list.append(row({ label: d.name, color: this.deckColor(d), active: v.type === 'deck' && v.deckId === d.id, count: this.dueOf(d) || null, onClick: () => this.go({ type: 'deck', deckId: d.id }) }));
    }
    if (!this.decks.length) list.append(el('p', { class: 'muted small pad' }, 'Crie um baralho para cada matéria ou assunto da prova.'));
    s.append(list);
  }

  // ---------- Conteúdo ----------
  async renderMain(m) {
    const v = this.view;
    if (v.type === 'deck') return this.renderDeck(m, this.decks.find(d => d.id === v.deckId));
    if (v.type === 'browse') return this.renderBrowse(m);
    if (v.type === 'stats') return this.renderStats(m);
    return this.renderHome(m);
  }

  head(m, titleNodes, actions) {
    m.append(el('header', { class: 'lib-head' },
      iconBtn('menu', 'Menu', () => this.lib.root.classList.toggle('side-open'), 'only-narrow'),
      el('h1', {}, ...titleNodes), el('div', { class: 'lib-actions' }, ...actions)));
  }

  async renderHome(m) {
    const total = this.dueTotal();
    const st = await C.stats();
    this.head(m, [el('span', {}, 'Flashcards')], [
      el('button', { class: 'btn', onclick: () => this.openImport() }, icon('upload', 18), 'Importar'),
      el('button', { class: 'btn', onclick: () => this.newDeck() }, icon('plus', 18), 'Baralho'),
      el('button', { class: 'btn primary', onclick: () => openCardEditor({ lib: this.lib, onSaved: () => this.refresh() }) }, icon('plus', 18), 'Nova carta')]);
    const hero = el('div', { class: 'fc-hero' },
      el('div', { class: 'fc-hero-main' },
        el('div', { class: 'fc-big' }, String(total)),
        el('div', {}, el('b', {}, total ? 'cartas para revisar hoje' : 'Tudo em dia!'),
          el('p', { class: 'muted small' }, total ? 'O app escolhe a hora certa de revisar cada carta, pra você lembrar mais estudando menos.' : (this.decks.length ? 'Volte amanhã, ou estude livremente qualquer baralho.' : 'Crie seu primeiro baralho para começar.')))),
      el('div', { class: 'fc-hero-stats' },
        el('div', {}, icon('fire', 20), el('b', {}, String(st.streak)), el('span', { class: 'muted small' }, st.streak === 1 ? 'dia seguido' : 'dias seguidos')),
        el('div', {}, icon('check', 20), el('b', {}, String(st.today.count)), el('span', { class: 'muted small' }, 'estudadas hoje')),
        el('div', {}, icon('brain', 20), el('b', {}, st.retention == null ? '—' : Math.round(st.retention * 100) + '%'), el('span', { class: 'muted small' }, 'de acerto (30 dias)'))),
      total ? el('button', { class: 'btn primary big', onclick: () => this.study(this.decks) }, icon('play', 18), 'Estudar tudo agora') : null);
    m.append(hero);
    // (flashcards automáticos desligados a pedido: as cartas agora são criadas pela tela "Adicionar perguntas")
    if (!this.decks.length) {
      m.append(el('div', { class: 'fc-empty' },
        el('h3', {}, 'Como funciona'),
        el('ol', {},
          el('li', {}, el('b', {}, 'Crie um baralho'), ' (ex.: "Biologia — Microscópios") e ligue a uma matéria.'),
          el('li', {}, el('b', {}, 'Escreva várias perguntas e respostas de uma vez'), ': o app cria um flashcard separado para cada uma.'),
          el('li', {}, el('b', {}, 'Ou adicione cartas uma a uma'), ': lacunas, digitar a resposta… com texto, imagens e desenhos com o Pencil.'),
          el('li', {}, el('b', {}, 'Ou crie a partir das suas anotações'), ': na nota, use o Laço para selecionar algo e toque em "Flashcard".'),
          el('li', {}, el('b', {}, 'Revise todo dia'), ': o app mostra só o que está quase esquecendo.')),
        el('div', { class: 'row-btns' },
          el('button', { class: 'btn primary', onclick: () => this.newDeck() }, icon('plus', 18), 'Criar primeiro baralho'),
          el('button', { class: 'btn', onclick: () => this.openImport() }, icon('upload', 18), 'Importar do Quizlet/Anki (texto)'))));
      return;
    }
    // baralhos agrupados por matéria
    const groups = new Map();
    for (const d of this.decks) {
      const p = this.deckPath(d);
      const key = p[0]?.id || '';
      if (!groups.has(key)) groups.set(key, { name: p[0]?.name || 'Sem matéria', color: p[0] ? this.lib.colorOf(p[0]) : '#8e8e93', decks: [] });
      groups.get(key).decks.push(d);
    }
    const sorted = [...groups.values()].sort((a, b) => (a.name === 'Sem matéria') - (b.name === 'Sem matéria') || a.name.localeCompare(b.name, 'pt-BR'));
    for (const g of sorted) {
      const sec = el('section', { class: 'note-section' },
        el('div', { class: 'section-head' }, el('div', { class: 'section-title' }, el('span', { class: 'subj-dot', style: { background: g.color } }), el('span', {}, g.name))));
      const list = el('div', { class: 'deck-list' });
      for (const d of g.decks) list.append(this.deckRow(d));
      sec.append(list);
      m.append(sec);
    }
    m.append(el('p', { class: 'muted small center' }, el('span', { class: 'cnt new' }, 'Novas'), ' · ', el('span', { class: 'cnt learn' }, 'Aprendendo'), ' · ', el('span', { class: 'cnt rev' }, 'Para revisar')));
  }

  deckRow(d) {
    const c = this.counts[d.id] || {};
    const path = this.deckPath(d);
    return el('div', { class: 'deck-row', onclick: () => this.go({ type: 'deck', deckId: d.id }) },
      el('div', { class: 'deck-info' }, el('div', { class: 'deck-name' }, d.name),
        el('div', { class: 'muted small' }, (path[1] ? path[1].name + ' · ' : '') + `${c.total || 0} cartas`)),
      el('div', { class: 'deck-counts' }, el('span', { class: 'cnt new' }, c.new || 0), el('span', { class: 'cnt learn' }, c.learn || 0), el('span', { class: 'cnt rev' }, c.review || 0)),
      el('button', { class: 'btn small primary', disabled: !this.dueOf(d), onclick: e => { e.stopPropagation(); this.study([d]); } }, 'Estudar'),
      iconBtn('more', 'Opções do baralho', e => { e.stopPropagation(); this.deckMenu(e.currentTarget, d); }, 'small'));
  }

  deckMenu(anchor, d) {
    menu(anchor, [
      { label: 'Abrir', icon: 'cards', onClick: () => this.go({ type: 'deck', deckId: d.id }) },
      { label: 'Renomear', icon: 'pen', onClick: () => this.renameDeck(d) },
      { label: 'Adicionar várias perguntas', icon: 'list', onClick: () => this.bulkAdd(d) },
      { label: 'Nova carta', icon: 'plus', onClick: () => openCardEditor({ lib: this.lib, deckId: d.id, onSaved: () => this.refresh() }) },
      { label: 'Importar cartas', icon: 'upload', onClick: () => this.openImport(d.id) },
      { label: 'Opções e limites', icon: 'gear', onClick: () => this.deckOptions(d) },
      { label: 'Exportar (CSV)', icon: 'download', onClick: async () => { const csv = await C.exportCsv(d); shareOrDownload(new Blob(['﻿' + csv], { type: 'text/csv' }), d.name + '.csv'); } },
      { sep: true },
      { label: 'Excluir baralho', icon: 'trash', danger: true, onClick: async () => {
        const n = this.counts[d.id]?.total || 0;
        if (!await confirmBox(`Excluir "${d.name}"?`, `As ${n} cartas e o histórico de revisões serão apagados deste aparelho e da nuvem.`, { ok: 'Excluir', danger: true })) return;
        await C.deleteDeck(d); this.go({ type: 'home' }); this.refresh();
      } },
    ], { align: 'right' });
  }

  async newDeck() {
    const name = await promptText('Novo baralho', '', { placeholder: 'Ex.: Citologia — conceitos', ok: 'Criar' });
    if (!name) return null;
    let subjectId = this.lib.view.type === 'subject' || this.lib.view.type === 'topic' ? this.lib.view.subjectId : null;
    if (this.lib.subjects.length && !subjectId) {
      const picked = await this.lib.pickLocation('Ligar o baralho a qual matéria?', '__none');
      if (picked !== undefined && picked !== '__none') subjectId = picked;
    }
    const d = await C.createDeck(name, subjectId);
    await this.load();
    await this.go({ type: 'deck', deckId: d.id });
    this.bulkAdd(d); // já abre a tela para escrever as perguntas e respostas
    return d;
  }

  async renameDeck(d) {
    const n = await promptText('Renomear baralho', d.name, { ok: 'Salvar' });
    if (n && n !== d.name) { d.name = n; await store.save('deck', d); toast(`Renomeado para "${n}".`); this.refresh(); }
  }

  // ---------- Várias perguntas de uma vez: cada linha vira um flashcard separado ----------
  bulkAdd(d) {
    const draftKey = 'bulkDraft:' + d.id;
    const rowsBox = el('div', { class: 'bulk-rows' });
    const count = el('span', { class: 'muted small' });
    const typeSel = el('select', { class: 'field' },
      el('option', { value: 'basic' }, 'Pergunta → resposta'),
      el('option', { value: 'reverse' }, 'Pergunta → resposta e também ao contrário'),
      el('option', { value: 'type' }, 'Digitar a resposta'));
    typeSel.value = loadPref('bulkType', 'basic');
    typeSel.addEventListener('change', () => savePref('bulkType', typeSel.value));
    let saved = false, saveT = null, m;
    const grow = t => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; };
    const rows = () => [...rowsBox.querySelectorAll('.bulk-row')].map(r => ({ r, q: r.querySelector('.bulk-q'), a: r.querySelector('.bulk-a') }));
    const values = () => rows().map(x => ({ q: x.q.value.trim(), a: x.a.value.trim(), x }));
    const storeDraft = () => { if (saved) return; const v = values().filter(x => x.q || x.a).map(({ q, a }) => ({ q, a })); savePref(draftKey, v.length ? v : null); };
    const update = () => {
      const v = values(), ready = v.filter(x => x.q && x.a).length;
      rows().forEach((x, i) => { x.r.querySelector('.bulk-n').textContent = i + 1; });
      count.textContent = ready ? `${ready} flashcard(s) prontos para criar` : 'Escreva pelo menos uma pergunta e a resposta.';
      saveBtn.textContent = ready ? `Criar ${ready} flashcard${ready > 1 ? 's' : ''}` : 'Criar flashcards';
      clearTimeout(saveT); saveT = setTimeout(storeDraft, 400);
    };
    const addRow = (q = '', a = '', focus = false) => {
      const qa = el('textarea', { class: 'field ta bulk-q', rows: 1, placeholder: 'Pergunta', 'aria-label': 'Pergunta' });
      const an = el('textarea', { class: 'field ta bulk-a', rows: 1, placeholder: 'Resposta', 'aria-label': 'Resposta' });
      qa.value = q; an.value = a;
      const row = el('div', { class: 'bulk-row' },
        el('span', { class: 'bulk-n' }),
        el('div', { class: 'bulk-fields' }, qa, an),
        iconBtn('x', 'Apagar esta pergunta', () => { row.remove(); if (!rowsBox.children.length) addRow(); update(); }, 'small'));
      for (const t of [qa, an]) t.addEventListener('input', () => { grow(t); update(); });
      // "Enter" passa para o próximo campo (Shift+Enter pula linha dentro do campo)
      qa.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); an.focus(); } });
      an.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        e.preventDefault();
        const next = row.nextElementSibling;
        if (next) next.querySelector('.bulk-q').focus(); else addRow('', '', true);
      });
      rowsBox.append(row);
      requestAnimationFrame(() => { grow(qa); grow(an); });
      if (focus) { qa.focus(); row.scrollIntoView?.({ block: 'nearest' }); }
      update();
      return row;
    };
    const saveBtn = el('button', { class: 'btn primary', onclick: async () => {
      const v = values().filter(x => x.q || x.a);
      const missing = v.find(x => !x.q || !x.a);
      if (missing) {
        const n = rows().indexOf(missing.x) + 1;
        toast(missing.q ? `A pergunta ${n} está sem resposta.` : `A resposta ${n} está sem pergunta.`, { timeout: 4000 });
        (missing.q ? missing.x.a : missing.x.q).focus();
        return;
      }
      if (!v.length) { toast('Escreva pelo menos uma pergunta e a resposta.'); return; }
      const html = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      const b = busy('Criando flashcards…');
      try {
        for (const x of v) await C.saveFnote({ deckId: d.id, type: typeSel.value, front: html(x.q), back: html(x.a), extra: '', tags: [] });
      } finally { b.close(); }
      saved = true; savePref(draftKey, null);
      m.close();
      toast(`✓ ${v.length} flashcard(s) criados em "${d.name}".`, { timeout: 5000 });
      this.refresh();
    } }, 'Criar flashcards');
    m = modal(el('div', { class: 'bulk' },
      el('div', { class: 'settings-head' }, el('h2', {}, 'Perguntas e respostas'), iconBtn('x', 'Fechar', () => m.close())),
      el('p', { class: 'muted small' }, `Baralho: `, el('b', {}, d.name), '. Escreva cada pergunta com a sua resposta. Cada uma vira um flashcard separado. Dica: no teclado, "Enter" pula para o próximo campo.'),
      rowsBox,
      el('div', { class: 'row-btns' },
        el('button', { class: 'btn', onclick: () => addRow('', '', true) }, icon('plus', 18), 'Mais uma pergunta'),
        el('button', { class: 'btn small', onclick: () => { m.close(); this.openImport(d.id); } }, icon('upload', 16), 'Colar uma lista pronta')),
      el('label', { class: 'field-row' }, el('span', {}, 'Tipo de carta'), typeSel),
      el('div', { class: 'modal-actions bulk-actions' }, count, el('button', { class: 'btn', onclick: () => m.close() }, 'Fechar'), saveBtn)),
      { wide: true, onClose: () => { clearTimeout(saveT); storeDraft(); } });
    const draft = loadPref(draftKey, null);
    if (Array.isArray(draft) && draft.length) { draft.forEach(x => addRow(x.q, x.a)); toast('Continuando de onde você parou (rascunho guardado).', { timeout: 3500 }); }
    else { addRow(); addRow(); addRow(); }
    setTimeout(() => rowsBox.querySelector('.bulk-q')?.focus(), 80);
  }

  async deckOptions(d) {
    const o = C.deckOpts(d);
    const num = (v, min, max) => el('input', { type: 'number', class: 'field num', value: v, min, max, inputmode: 'numeric' });
    const name = el('input', { type: 'text', class: 'field', value: d.name });
    const newPer = num(o.newPerDay, 0, 9999), revPer = num(o.revPerDay, 0, 99999);
    const ret = el('input', { type: 'range', class: 'range', min: 80, max: 97, step: 1, value: Math.round(o.retention * 100) });
    const retLbl = el('b', {}, Math.round(o.retention * 100) + '%');
    ret.addEventListener('input', () => { retLbl.textContent = ret.value + '%'; });
    const steps = el('input', { type: 'text', class: 'field', value: o.learnSteps.join(' ') });
    const resteps = el('input', { type: 'text', class: 'field', value: o.relearnSteps.join(' ') });
    const order = el('select', { class: 'field' }, el('option', { value: 'added', selected: o.newOrder === 'added' }, 'Na ordem em que foram criadas'), el('option', { value: 'random', selected: o.newOrder === 'random' }, 'Aleatória'));
    const langs = [['pt-BR', 'Português'], ['en-US', 'Inglês'], ['es-ES', 'Espanhol'], ['fr-FR', 'Francês'], ['de-DE', 'Alemão'], ['it-IT', 'Italiano'], ['ja-JP', 'Japonês'], ['zh-CN', 'Chinês'], ['ko-KR', 'Coreano']];
    const lang = el('select', { class: 'field' }, ...langs.map(([v, l]) => el('option', { value: v, selected: o.ttsLang === v }, l)));
    const subjBtn = el('button', { class: 'btn', onclick: async () => {
      const id = await this.lib.pickLocation('Ligar o baralho a…', d.subjectId || '__none');
      if (id === undefined) return;
      d.subjectId = id === '__none' ? null : id;
      subjBtn.textContent = this.deckPath(d).map(p => p.name).join(' › ') || 'Sem matéria';
    } }, this.deckPath(d).map(p => p.name).join(' › ') || 'Sem matéria');
    let m;
    const parseSteps = s => s.split(/[\s,;]+/).map(Number).filter(x => x > 0 && x < 100000);
    const save = async () => {
      d.name = name.value.trim() || d.name;
      d.opts = {
        newPerDay: clamp(+newPer.value || 0, 0, 9999), revPerDay: clamp(+revPer.value || 0, 0, 99999), retention: +ret.value / 100,
        learnSteps: parseSteps(steps.value).length ? parseSteps(steps.value) : DEFAULT_OPTS.learnSteps,
        relearnSteps: parseSteps(resteps.value), newOrder: order.value, ttsLang: lang.value,
      };
      await store.save('deck', d);
      m.close(); toast('Opções salvas.'); this.refresh();
    };
    m = modal(el('div', { class: 'settings' },
      el('div', { class: 'settings-head' }, el('h2', {}, 'Opções do baralho'), iconBtn('x', 'Fechar', () => m.close())),
      el('section', {}, el('label', { class: 'field-row' }, el('span', {}, 'Nome'), name),
        el('div', { class: 'field-row' }, el('span', {}, 'Matéria / tema'), subjBtn)),
      el('section', {}, el('h4', {}, 'Limites diários'),
        el('label', { class: 'field-row' }, el('span', {}, 'Cartas novas por dia'), newPer),
        el('label', { class: 'field-row' }, el('span', {}, 'Revisões por dia (máximo)'), revPer),
        el('label', { class: 'field-row' }, el('span', {}, 'Ordem das novas'), order)),
      el('section', {}, el('h4', {}, 'Memória'),
        el('div', { class: 'field-row' }, el('span', {}, 'Meta de lembrança'), retLbl), ret,
        el('p', { class: 'muted small' }, 'Quanto maior, mais revisões (e mais você lembra). 90% é o equilíbrio recomendado. O app usa o algoritmo FSRS, o mesmo do Anki moderno.'),
        el('label', { class: 'field-row' }, el('span', {}, 'Passos de aprendizado (minutos)'), steps),
        el('label', { class: 'field-row' }, el('span', {}, 'Passos ao errar uma revisão (minutos)'), resteps)),
      el('section', {}, el('label', { class: 'field-row' }, el('span', {}, 'Idioma da leitura em voz alta'), lang)),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), el('button', { class: 'btn primary', onclick: save }, 'Salvar'))), { wide: true });
  }

  // ---------- Baralho ----------
  async renderDeck(m, d) {
    if (!d) return this.renderHome(m);
    const c = this.counts[d.id] || {};
    const path = this.deckPath(d);
    this.head(m, [
      el('button', { class: 'crumb', onclick: () => this.go({ type: 'home' }) }, icon('cards', 18), 'Flashcards'), el('span', { class: 'crumb-sep' }, icon('chevron', 18)),
      el('span', { class: 'subj-dot big', style: { background: this.deckColor(d) } }),
      el('button', { class: 'title-edit deck-title', title: 'Toque para renomear', onclick: () => this.renameDeck(d) }, el('span', {}, d.name), icon('pen', 18))], [
      el('button', { class: 'btn', onclick: () => this.openImport(d.id) }, icon('upload', 18), 'Importar'),
      el('button', { class: 'btn', onclick: () => this.deckOptions(d) }, icon('gear', 18), 'Opções'),
      iconBtn('more', 'Mais', e => this.deckMenu(e.currentTarget, d)),
      el('button', { class: 'btn', onclick: () => openCardEditor({ lib: this.lib, deckId: d.id, onSaved: () => this.refresh() }) }, icon('plus', 18), 'Nova carta'),
      el('button', { class: 'btn primary', onclick: () => this.bulkAdd(d) }, icon('list', 18), 'Adicionar perguntas')]);
    if (path.length) m.append(el('p', { class: 'muted small' }, path.map(p => p.name).join(' › ')));
    const cards = await C.allCards([d.id]);
    const fnotes = new Map((await C.allFnotes([d.id])).map(n => [n.id, n]));
    const due = this.dueOf(d);
    const mode = (ic, title, desc, onClick, opts = {}) => el('button', { class: 'mode-tile' + (opts.primary ? ' primary' : ''), disabled: opts.disabled, onclick: onClick },
      el('span', { class: 'mode-ico' }, icon(ic, 26)), el('span', { class: 'mode-title' }, title), el('span', { class: 'mode-desc' }, desc));
    const enough = cards.length >= 4;
    m.append(el('div', { class: 'modes' },
      mode('brain', due ? `Revisar (${due})` : 'Revisar', due ? el('span', {}, el('span', { class: 'cnt new' }, c.new || 0), ' novas · ', el('span', { class: 'cnt learn' }, c.learn || 0), ' aprendendo · ', el('span', { class: 'cnt rev' }, c.review || 0), ' revisões') : 'Tudo em dia por hoje', () => this.study([d]), { primary: true, disabled: !due }),
      mode('flip', 'Cartões', 'Vire as cartas e separe o que já sabe', () => flipMode(d, cards, fnotes), { disabled: !cards.length }),
      mode('quiz', 'Teste', 'Múltipla escolha, V ou F e escrita', () => testMode(d, cards, fnotes), { disabled: !enough }),
      mode('match', 'Combinar', 'Jogo: ligue termos e respostas contra o tempo', () => matchMode(d, cards, fnotes), { disabled: cards.length < 3 }),
      mode('bolt', 'Estudo livre', 'Todas as cartas, sem mexer no agendamento', () => this.cram(d, cards), { disabled: !cards.length })));
    if (!enough && cards.length) m.append(el('p', { class: 'muted small' }, 'O modo Teste precisa de pelo menos 4 cartas.'));
    m.append(this.cardList(cards, fnotes, { deck: d }));
  }

  cardList(cards, fnotes, { deck, showDeck } = {}) {
    const wrap = el('div', { class: 'card-list-wrap' });
    const search = el('input', { type: 'search', class: 'search', placeholder: 'Buscar nas cartas…', value: this.query });
    const hasAuto = cards.some(c => fnotes.get(c.fnoteId)?.auto); // filtro só aparece se ainda existirem cartas automáticas antigas
    if (!hasAuto && this.filter === 'auto') this.filter = 'all';
    const filters = [['all', 'Todas'], ...(hasAuto ? [['auto', '✨ Automáticas']] : []), ['new', 'Novas'], ['learn', 'Aprendendo'], ['review', 'Revisão'], ['flag', 'Marcadas'], ['susp', 'Suspensas']];
    const seg = el('div', { class: 'chips' });
    const list = el('div', { class: 'card-list' });
    const draw = () => {
      seg.innerHTML = '';
      for (const [k, l] of filters) seg.append(el('button', { class: 'chip-btn' + (this.filter === k ? ' active' : ''), onclick: () => { this.filter = k; draw(); } }, l));
      list.innerHTML = '';
      const q = this.query.trim().toLowerCase();
      const rows = cards.filter(c => {
        const f = this.filter;
        if (f === 'new' && (c.state !== STATE.NEW || c.suspended)) return false;
        if (f === 'learn' && (c.state === STATE.NEW || c.state === STATE.REVIEW || c.suspended)) return false;
        if (f === 'review' && (c.state !== STATE.REVIEW || c.suspended)) return false;
        if (f === 'flag' && !c.flag) return false;
        if (f === 'susp' && !c.suspended) return false;
        if (f === 'auto' && !fnotes.get(c.fnoteId)?.auto) return false;
        if (q) { const fn = fnotes.get(c.fnoteId); if (!fn) return false; const t = (C.htmlToText(fn.front) + ' ' + C.htmlToText(fn.back) + ' ' + (fn.tags || []).join(' ')).toLowerCase(); if (!t.includes(q)) return false; }
        return true;
      }).sort((a, b) => a.createdAt - b.createdAt);
      if (!rows.length) { list.append(el('p', { class: 'muted small empty-inline' }, cards.length ? 'Nenhuma carta com esse filtro.' : 'Nenhuma carta ainda. Toque em "Adicionar perguntas" para escrever várias de uma vez.')); return; }
      const deckName = new Map((this.decks || []).map(d => [d.id, d.name]));
      for (const c of rows.slice(0, 500)) {
        const fn = fnotes.get(c.fnoteId);
        if (!fn) continue;
        const s = C.sides(fn, c);
        const dueTxt = c.suspended ? '' : c.state === STATE.NEW ? '' : c.due <= now() ? 'agora' : 'em ' + formatWait(c.due - now());
        list.append(el('div', { class: 'card-row', onclick: () => openCardEditor({ lib: this.lib, fnote: fn, onSaved: () => this.refresh() }) },
          c.flag ? el('span', { class: 'flag-dot' }, icon('flag', 14)) : null,
          el('div', { class: 'card-row-q' }, snippet(s.front, 80)),
          el('div', { class: 'card-row-a muted' }, snippet(s.back, 80)),
          showDeck ? el('span', { class: 'muted small' }, deckName.get(c.deckId) || '') : null,
          el('span', { class: 'st-chip ' + STATE_CLS(c) }, STATE_LABEL(c)),
          el('span', { class: 'muted small due' }, dueTxt),
          iconBtn('more', 'Opções da carta', e => { e.stopPropagation(); this.cardMenu(e.currentTarget, c, fn); }, 'small')));
      }
      if (rows.length > 500) list.append(el('p', { class: 'muted small center' }, `Mostrando 500 de ${rows.length}. Use a busca para achar outras.`));
    };
    search.addEventListener('input', () => { this.query = search.value; draw(); });
    draw();
    wrap.append(el('div', { class: 'card-list-head' }, el('h3', {}, `Cartas (${cards.length})`), search), seg, list);
    return wrap;
  }

  cardMenu(anchor, c, fn) {
    menu(anchor, [
      { label: 'Editar', icon: 'text', onClick: () => openCardEditor({ lib: this.lib, fnote: fn, onSaved: () => this.refresh() }) },
      { label: c.flag ? 'Desmarcar' : 'Marcar (bandeira)', icon: 'flag', onClick: async () => { await C.updateCards([c], { flag: c.flag ? 0 : 1 }); this.refresh(); } },
      { label: c.suspended ? 'Reativar' : 'Suspender (não aparece no estudo)', icon: 'pause2', onClick: async () => { await C.updateCards([c], { suspended: !c.suspended }); this.refresh(); } },
      { label: 'Recomeçar do zero', icon: 'restore', onClick: async () => { if (await confirmBox('Recomeçar esta carta?', 'Ela volta a ser uma carta nova.', { ok: 'Recomeçar' })) { await C.updateCards([c], C.resetPatch()); this.refresh(); } } },
      fn.source ? { label: 'Ver na anotação', icon: 'notes', onClick: () => { location.hash = `#/note/${fn.source.noteId}/p/${fn.source.pageId}`; } } : null,
      { sep: true },
      { label: 'Excluir carta', icon: 'trash', danger: true, onClick: async () => { if (await confirmBox('Excluir esta carta?', fn.type === 'reverse' || fn.type === 'cloze' ? 'As cartas ligadas a ela (invertida/lacunas) também serão excluídas.' : '', { ok: 'Excluir', danger: true })) { await C.deleteFnote(fn); this.refresh(); } } },
    ], { align: 'right' });
  }

  async renderBrowse(m) {
    this.head(m, [el('span', {}, 'Todas as cartas')], [
      el('button', { class: 'btn primary', onclick: () => openCardEditor({ lib: this.lib, onSaved: () => this.refresh() }) }, icon('plus', 18), 'Nova carta')]);
    const cards = await C.allCards();
    const fnotes = new Map((await C.allFnotes()).map(n => [n.id, n]));
    m.append(this.cardList(cards, fnotes, { showDeck: true }));
  }

  async renderStats(m) {
    this.head(m, [el('span', {}, 'Estatísticas')], []);
    const st = await C.stats();
    const mins = Math.round(st.today.ms / 60000);
    const box = (big, label) => el('div', { class: 'stat-box' }, el('b', {}, big), el('span', { class: 'muted small' }, label));
    m.append(el('div', { class: 'stat-grid' },
      box(String(st.today.count), 'cartas hoje'), box(mins + ' min', 'tempo hoje'),
      box(st.today.correct == null ? '—' : Math.round(st.today.correct * 100) + '%', 'acertos hoje'),
      box(String(st.streak), 'dias seguidos'), box(st.retention == null ? '—' : Math.round(st.retention * 100) + '%', 'lembrança real (30 dias)'),
      box(String(st.total), 'cartas no total')));
    // mapa de calor (últimas 26 semanas)
    const heat = el('div', { class: 'heatmap' });
    const start = new Date(dayStart(now())); start.setDate(start.getDate() - 7 * 26 + 1);
    start.setDate(start.getDate() - start.getDay());
    const max = Math.max(1, ...st.byDay.values());
    for (let i = 0; i < 7 * 27; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      if (d.getTime() > now()) break;
      const key = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      const n = st.byDay.get(key) || 0;
      heat.append(el('span', { class: 'hm', title: `${d.toLocaleDateString('pt-BR')}: ${n} revisões`, style: { opacity: n ? 0.25 + 0.75 * n / max : 1, background: n ? 'var(--accent)' : 'var(--soft)' } }));
    }
    m.append(el('section', { class: 'note-section' }, el('div', { class: 'section-head' }, el('div', { class: 'section-title' }, icon('fire', 18), el('span', {}, 'Dias de estudo'))), heat));
    // previsão
    const fmax = Math.max(1, ...st.forecast);
    const bars = el('div', { class: 'bars' });
    st.forecast.forEach((n, i) => bars.append(el('div', { class: 'bar', title: `${i === 0 ? 'Hoje' : 'Em ' + i + ' dia(s)'}: ${n}` }, el('span', { style: { height: (n / fmax * 100) + '%' } }), el('small', {}, i % 5 === 0 ? (i === 0 ? 'hoje' : '+' + i) : ''))));
    m.append(el('section', { class: 'note-section' }, el('div', { class: 'section-head' }, el('div', { class: 'section-title' }, icon('chart', 18), el('span', {}, 'Revisões previstas (próximos 30 dias)'))), bars));
    // estados
    const s = st.states, tot = Math.max(1, s.new + s.learning + s.young + s.mature + s.suspended);
    const seg = (n, cls, label) => n ? el('span', { class: 'stk ' + cls, style: { flex: n / tot }, title: `${label}: ${n}` }) : null;
    m.append(el('section', { class: 'note-section' }, el('div', { class: 'section-head' }, el('div', { class: 'section-title' }, icon('cards', 18), el('span', {}, 'Suas cartas'))),
      el('div', { class: 'stack' }, seg(s.new, 'st-new', 'Novas'), seg(s.learning, 'st-learn', 'Aprendendo'), seg(s.young, 'st-rev', 'Jovens'), seg(s.mature, 'st-mature', 'Maduras'), seg(s.suspended, 'st-susp', 'Suspensas')),
      el('div', { class: 'legend' },
        ...[['st-new', 'Novas', s.new], ['st-learn', 'Aprendendo', s.learning], ['st-rev', 'Jovens (< 21 dias)', s.young], ['st-mature', 'Maduras (≥ 21 dias)', s.mature], ['st-susp', 'Suspensas', s.suspended]]
          .map(([c, l, n]) => el('span', {}, el('i', { class: 'stk ' + c }), `${l}: ${n}`)))));
  }

  // ---------- Estudo ----------
  study(decks) {
    new Study({ decks, onClose: () => this.refresh() }).start();
  }
  cram(d, cards) {
    new Study({ decks: [d], cram: cards.filter(c => !c.suspended), onClose: () => this.refresh() }).start();
  }

  // ---------- Importar ----------
  openImport(deckId) {
    const ta = el('textarea', { class: 'field ta', rows: 8, placeholder: 'Uma carta por linha, frente e verso separados por TAB, ponto e vírgula ou " - ".\nEx.:\nMitocôndria;Produz energia (ATP)\nRibossomo;Faz síntese de proteínas' });
    const deckSel = el('select', { class: 'field' }, ...this.decks.map(d => el('option', { value: d.id, selected: d.id === deckId }, d.name)), el('option', { value: '__new' }, '+ Novo baralho…'));
    const typeSel = el('select', { class: 'field' }, el('option', { value: 'basic' }, 'Básica'), el('option', { value: 'reverse' }, 'Básica + invertida'), el('option', { value: 'type' }, 'Digitar a resposta'));
    const info = el('p', { class: 'small muted' }, '');
    const upd = () => { const rows = C.parseImport(ta.value); info.textContent = rows.length ? `${rows.length} carta(s) encontradas. Ex.: "${C.htmlToText(rows[0].front).slice(0, 40)}" → "${C.htmlToText(rows[0].back).slice(0, 40)}"` : ''; };
    ta.addEventListener('input', upd);
    let m;
    const go = async () => {
      const rows = C.parseImport(ta.value);
      if (!rows.length) return toast('Nada para importar.');
      let did = deckSel.value;
      if (did === '__new' || !did) {
        const name = await promptText('Nome do novo baralho', 'Importado', { ok: 'Criar' });
        if (!name) return;
        did = (await C.createDeck(name)).id;
      }
      const b = busy('Importando…');
      try {
        for (let i = 0; i < rows.length; i++) {
          await C.saveFnote({ deckId: did, type: typeSel.value, front: rows[i].front, back: rows[i].back, extra: '', tags: rows[i].tags });
          if (i % 25 === 0) b.set(`Importando ${i + 1} de ${rows.length}…`);
        }
      } finally { b.close(); }
      m.close();
      toast(`${rows.length} carta(s) importadas.`);
      await this.load();
      this.go({ type: 'deck', deckId: did });
    };
    m = modal(el('div', {},
      el('h3', {}, 'Importar cartas'),
      el('p', { class: 'muted small' }, 'Funciona com listas do Quizlet (Exportar → copiar), Anki (Exportar → Notas em texto simples), planilhas ou qualquer texto.'),
      ta, info,
      el('div', { class: 'row-btns' }, el('button', { class: 'btn small', onclick: async () => { const f = await pickFile('.txt,.csv,.tsv,text/plain,text/csv'); if (f) { ta.value = await f.text(); upd(); } } }, icon('file', 16), 'Escolher arquivo')),
      el('label', { class: 'field-row' }, el('span', {}, 'Baralho'), deckSel),
      el('label', { class: 'field-row' }, el('span', {}, 'Tipo de carta'), typeSel),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'), el('button', { class: 'btn primary', onclick: go }, 'Importar'))), { wide: true });
  }
}

// ======================================================================
// Editor de carta
// ======================================================================
// opts: { lib, deckId, fnote, prefill:{frontImage:{data,mime}, source}, onSaved }
export async function openCardEditor(opts = {}) {
  let decks = await C.listDecks();
  const fn = opts.fnote ? { ...opts.fnote, tags: [...(opts.fnote.tags || [])] } : { type: loadPref('lastCardType', 'basic'), front: '', back: '', extra: '', tags: [], source: opts.prefill?.source || null };
  let deckId = fn.deckId || opts.deckId || loadPref('lastDeck', null);
  if (!decks.some(d => d.id === deckId)) deckId = decks[0]?.id;
  if (!deckId) {
    const name = await promptText('Primeiro, crie um baralho', 'Geral', { ok: 'Criar' });
    if (!name) return;
    deckId = (await C.createDeck(name)).id;
    decks = await C.listDecks();
  }
  const isEdit = !!opts.fnote;

  const deckSel = el('select', { class: 'field' }, ...decks.map(d => el('option', { value: d.id, selected: d.id === deckId }, d.name)), el('option', { value: '__new' }, '+ Novo baralho…'));
  deckSel.addEventListener('change', async () => {
    if (deckSel.value === '__new') {
      const name = await promptText('Novo baralho', '', { ok: 'Criar' });
      if (name) { const d = await C.createDeck(name); deckSel.insertBefore(el('option', { value: d.id }, d.name), deckSel.lastChild); deckSel.value = d.id; }
      else deckSel.value = deckId;
    }
    deckId = deckSel.value;
  });
  const typeSel = el('select', { class: 'field' }, ...C.TYPES.map(t => el('option', { value: t.id, selected: t.id === fn.type }, t.name)));
  const typeDesc = el('p', { class: 'muted small type-desc' });

  const front = richField('Frente (pergunta)');
  const back = richField('Verso (resposta)');
  const extra = richField('Explicação extra (opcional, aparece depois da resposta)');
  const tags = el('input', { type: 'text', class: 'field', placeholder: 'Etiquetas (opcional), separadas por espaço', value: fn.tags.join(' ') });
  const warn = el('p', { class: 'small warn-text' });
  setHTML(front.box, fn.front); setHTML(back.box, fn.back); setHTML(extra.box, fn.extra || '');
  if (!fn.extra) extra.wrap.classList.add('collapsed');

  const clozeBtns = el('div', { class: 'cloze-btns' },
    el('button', { class: 'btn small', onmousedown: e => e.preventDefault(), onclick: () => wrapCloze(false) }, '[…] Esconder seleção'),
    el('button', { class: 'btn small ghost', onmousedown: e => e.preventDefault(), onclick: () => wrapCloze(true) }, '[…] mesma lacuna'));
  front.tools.append(clozeBtns);
  const wrapCloze = same => {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !front.box.contains(sel.anchorNode)) return toast('Selecione no texto da frente a parte que deve ficar escondida.');
    const ords = C.clozeOrds(front.box.innerHTML);
    const n = same ? Math.max(1, ords.length) : ords.length + 1;
    const text = sel.toString();
    document.execCommand('insertText', false, `{{c${n}::${text}}}`);
  };
  const refreshType = () => {
    fn.type = typeSel.value;
    const t = C.TYPES.find(t => t.id === fn.type);
    typeDesc.textContent = t.desc + (fn.type === 'cloze' ? '. Selecione um trecho da frente e toque em "[…] Esconder seleção". Cada lacuna vira uma carta.' : '');
    clozeBtns.style.display = fn.type === 'cloze' ? '' : 'none';
    front.label.textContent = fn.type === 'cloze' ? 'Texto com lacunas' : 'Frente (pergunta)';
    back.label.textContent = fn.type === 'cloze' ? 'Verso extra (opcional)' : fn.type === 'type' ? 'Resposta esperada (o que você vai digitar)' : 'Verso (resposta)';
  };
  typeSel.addEventListener('change', refreshType);
  refreshType();

  // imagem vinda do laço (anotação)
  if (opts.prefill?.frontImage) {
    const b = await store.createBlob({ noteId: deckId, data: opts.prefill.frontImage.data, mime: opts.prefill.frontImage.mime, name: 'anotacao' });
    const html = `<img data-blob="${b.id}">`;
    if (opts.prefill.side === 'back') setHTML(back.box, html); else setHTML(front.box, html);
  }

  front.box.addEventListener('blur', async () => {
    const t = C.htmlToText(front.box.innerHTML).toLowerCase();
    if (!t) { warn.textContent = ''; return; }
    const dup = (await C.allFnotes([deckId])).find(n => n.id !== fn.id && C.htmlToText(n.front).toLowerCase() === t);
    warn.textContent = dup ? 'Atenção: já existe uma carta com essa frente neste baralho.' : '';
  });

  let m;
  const save = async (andNext) => {
    const html = front.box.innerHTML;
    if (!C.htmlToText(html) && !C.hasImage(html)) return toast('Escreva algo na frente da carta.');
    if (fn.type === 'cloze' && !C.clozeOrds(html).length) return toast('Marque pelo menos uma lacuna: selecione um trecho e toque em "[…] Esconder seleção".');
    if (fn.type !== 'cloze' && !C.htmlToText(back.box.innerHTML) && !C.hasImage(back.box.innerHTML)) return toast('Escreva a resposta no verso.');
    Object.assign(fn, { deckId, front: html, back: back.box.innerHTML, extra: extra.box.innerHTML, tags: tags.value.split(/\s+/).filter(Boolean) });
    // imagens ficam guardadas junto do baralho escolhido
    for (const img of [front.box, back.box, extra.box].flatMap(b => [...b.querySelectorAll('img[data-blob]')])) {
      const meta = await db.get('blobs', img.dataset.blob);
      if (meta && meta.noteId !== deckId) { meta.noteId = deckId; await store.save('blob', meta); }
    }
    await C.saveFnote(fn);
    savePref('lastDeck', deckId); savePref('lastCardType', fn.type);
    opts.onSaved?.();
    if (andNext) {
      toast('Carta salva. Próxima!');
      delete fn.id; delete fn.createdAt; fn.source = null;
      setHTML(front.box, ''); setHTML(back.box, ''); setHTML(extra.box, '');
      front.box.focus();
    } else { m.close(); toast(isEdit ? 'Carta atualizada.' : 'Carta criada.'); }
  };

  const box = el('div', { class: 'card-editor' },
    el('div', { class: 'settings-head' }, el('h2', {}, isEdit ? 'Editar carta' : 'Nova carta'), iconBtn('x', 'Fechar', () => m.close())),
    el('div', { class: 'ce-row' }, el('label', {}, el('span', { class: 'muted small' }, 'Baralho'), deckSel), el('label', {}, el('span', { class: 'muted small' }, 'Tipo'), typeSel)),
    typeDesc, front.wrap, warn, back.wrap,
    el('button', { class: 'btn small ghost', onclick: () => extra.wrap.classList.toggle('collapsed') }, icon('plus', 16), 'Explicação extra'), extra.wrap,
    tags,
    el('div', { class: 'modal-actions' },
      isEdit ? el('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('Excluir esta carta?', '', { ok: 'Excluir', danger: true })) { await C.deleteFnote(opts.fnote); m.close(); opts.onSaved?.(); } } }, 'Excluir') : null,
      el('span', { style: { flex: 1 } }),
      !isEdit ? el('button', { class: 'btn', onclick: () => save(true) }, 'Salvar e criar outra') : null,
      el('button', { class: 'btn primary', onclick: () => save(false) }, 'Salvar')));
  m = modal(box, { wide: true });
  setTimeout(() => front.box.focus(), 80);

  function richField(labelText) {
    const label = el('span', { class: 'rf-label' }, labelText);
    const boxEl = el('div', { class: 'rf-box', contenteditable: 'true', spellcheck: 'true' });
    boxEl.addEventListener('paste', e => {
      e.preventDefault();
      const h = e.clipboardData.getData('text/html'), t = e.clipboardData.getData('text/plain');
      if (h) document.execCommand('insertHTML', false, C.sanitize(h));
      else document.execCommand('insertText', false, t);
    });
    const cmd = (c, v) => { boxEl.focus(); document.execCommand(c, false, v); };
    const tb = (label, title, fnc, cls = '') => el('button', { class: 'rf-btn ' + cls, title, onmousedown: e => e.preventDefault(), onclick: fnc }, label);
    const tools = el('div', { class: 'rf-tools' },
      tb(el('b', {}, 'N'), 'Negrito', () => cmd('bold')),
      tb(el('i', {}, 'I'), 'Itálico', () => cmd('italic')),
      tb(el('u', {}, 'S'), 'Sublinhado', () => cmd('underline')),
      tb(el('span', { class: 'hl-sample' }, 'A'), 'Marca-texto', () => cmd('hiliteColor', '#fff3a0')),
      tb(el('span', { style: { color: '#e5484d', fontWeight: 700 } }, 'A'), 'Vermelho', () => cmd('foreColor', '#e5484d')),
      tb(el('span', { style: { color: '#2f6fed', fontWeight: 700 } }, 'A'), 'Azul', () => cmd('foreColor', '#2f6fed')),
      tb(icon('list', 16), 'Lista', () => cmd('insertUnorderedList')),
      tb(icon('image', 16), 'Imagem', async () => {
        const f = await pickFile('image/*');
        if (!f) return;
        const { data, mime } = await prepareImage(f);
        const b = await store.createBlob({ noteId: deckId, data, mime, name: f.name });
        boxEl.focus();
        document.execCommand('insertHTML', false, `<img data-blob="${b.id}">`);
        setHTML(boxEl, boxEl.innerHTML);
      }),
      tb(icon('pen', 16), 'Desenhar com o Pencil', async () => {
        const res = await sketchPad();
        if (!res) return;
        const b = await store.createBlob({ noteId: deckId, data: res.data, mime: 'image/png', name: 'desenho' });
        boxEl.focus();
        document.execCommand('insertHTML', false, `<img data-blob="${b.id}">`);
        setHTML(boxEl, boxEl.innerHTML);
      }));
    const wrap = el('div', { class: 'rf' }, el('div', { class: 'rf-head' }, label, tools), boxEl);
    return { wrap, box: boxEl, label, tools };
  }
}

// Desenho rápido com o Pencil para colocar numa carta
function sketchPad() {
  return new Promise(res => {
    const W = 900, H = 560;
    const cv = el('canvas', { class: 'sketch-c', width: W, height: H });
    const ctx = cv.getContext('2d');
    const strokes = [];
    let color = '#1d1d1f', size = 5, cur = null;
    const redraw = () => {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      for (const s of strokes) {
        ctx.fillStyle = s.color;
        ctx.fill(R.outlinePath(getStroke(s.pts, { size: s.size, thinning: 0.6, smoothing: 0.5, streamline: 0.4, simulatePressure: s.sim, last: true })));
      }
    };
    redraw();
    const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height, e.pointerType === 'pen' ? Math.max(0.1, e.pressure) : 0.5]; };
    cv.addEventListener('pointerdown', e => { e.preventDefault(); cv.setPointerCapture(e.pointerId); cur = { color, size, sim: e.pointerType !== 'pen', pts: [pos(e)] }; strokes.push(cur); });
    cv.addEventListener('pointermove', e => { if (!cur) return; for (const ev of (e.getCoalescedEvents?.() || [e])) cur.pts.push(pos(ev)); redraw(); });
    const up = () => { cur = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    const colors = ['#1d1d1f', '#2f6fed', '#e5484d', '#30a46c', '#f5a524'];
    const cbar = el('div', { class: 'sketch-tools' },
      ...colors.map(c => el('button', { class: 'color-cell' + (c === color ? ' active' : ''), style: { background: c, width: '30px' }, onclick: e => { color = c; cbar.querySelectorAll('.color-cell').forEach(b => b.classList.remove('active')); e.currentTarget.classList.add('active'); } })),
      el('button', { class: 'btn small', onclick: () => { strokes.pop(); redraw(); } }, icon('undo', 16), 'Desfazer'),
      el('button', { class: 'btn small', onclick: () => { strokes.length = 0; redraw(); } }, 'Limpar'));
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); res(v); };
    const m = modal(el('div', { class: 'sketch' }, el('h3', {}, 'Desenhar'), cv, cbar,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => finish(null) }, 'Cancelar'),
        el('button', { class: 'btn primary', onclick: async () => {
          if (!strokes.length) return finish(null);
          const b = await new Promise(r => cv.toBlob(r, 'image/png'));
          finish({ data: await b.arrayBuffer() });
        } }, 'Inserir na carta'))), { wide: true, onClose: () => finish(null) });
  });
}

// ======================================================================
// Estudo com repetição espaçada (e estudo livre)
// ======================================================================
class Study {
  constructor({ decks, cram = null, onClose }) {
    this.decks = decks; this.cram = cram; this.onClose = onClose;
    this.deckMap = new Map(decks.map(d => [d.id, d]));
    this.history = [];
    this.done = 0; this.correct = 0; this.t0 = now();
  }

  async start() {
    this.fnotes = new Map((await C.allFnotes(this.decks.map(d => d.id))).map(n => [n.id, n]));
    if (this.cram) this.q = { cram: C.shuffle([...this.cram]) };
    else this.q = await C.buildQueue(this.decks);
    this.root = el('div', { class: 'study' });
    document.body.append(this.root);
    this.onKey = e => this.key(e);
    window.addEventListener('keydown', this.onKey);
    this.next();
  }

  close() {
    window.removeEventListener('keydown', this.onKey);
    speechSynthesis?.cancel?.();
    this.root.remove();
    this.onClose?.();
  }

  pick() {
    if (this.cram) return this.q.cram.shift() || null;
    const t = now();
    const q = this.q;
    q.learn.sort((a, b) => a.due - b.due);
    if (q.learn.length && q.learn[0].due <= t) return { card: q.learn.shift(), kind: 'learn' };
    const useNew = q.news.length && (!q.review.length || this.done % 4 === 3);
    if (useNew) return { card: q.news.shift(), kind: 'new' };
    if (q.review.length) return { card: q.review.shift(), kind: 'review' };
    if (q.news.length) return { card: q.news.shift(), kind: 'new' };
    if (q.learn.length && q.learn[0].due - t < 20 * 60000) return { card: q.learn.shift(), kind: 'learn' };
    return null;
  }

  next() {
    const p = this.pick();
    if (!p) return this.finish();
    this.cur = this.cram ? { card: p, kind: 'cram' } : p;
    this.revealed = false;
    this.shownAt = now();
    this.render();
  }

  counts() {
    if (this.cram) return el('span', { class: 'muted small' }, `${this.q.cram.length + 1} restantes`);
    const q = this.q, k = this.cur.kind;
    return el('span', { class: 'st-counts' },
      el('span', { class: 'cnt new' + (k === 'new' ? ' cur' : '') }, q.news.length + (k === 'new' ? 1 : 0)), ' ',
      el('span', { class: 'cnt learn' + (k === 'learn' ? ' cur' : '') }, q.learn.length + (k === 'learn' ? 1 : 0)), ' ',
      el('span', { class: 'cnt rev' + (k === 'review' ? ' cur' : '') }, q.review.length + (k === 'review' ? 1 : 0)));
  }

  render() {
    const { card } = this.cur;
    const fn = this.fnotes.get(card.fnoteId);
    if (!fn) return this.next();
    const deck = this.deckMap.get(card.deckId);
    const lang = C.deckOpts(deck).ttsLang;
    const s = C.sides(fn, card);
    const r = this.root;
    r.innerHTML = '';
    const area = el('div', { class: 'study-card' });
    const frontEl = setHTML(el('div', { class: 'sc-front' }), s.front);
    area.append(frontEl);
    let typed = null;
    if (fn.type === 'type' && !this.revealed) {
      typed = el('input', { type: 'text', class: 'field type-in', placeholder: 'Digite sua resposta e toque em Mostrar resposta', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done' });
      typed.value = this.typedValue || '';
      typed.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.typedValue = typed.value; this.reveal(); } });
      area.append(typed);
      setTimeout(() => typed.focus(), 50);
    }
    if (this.revealed) {
      area.append(el('hr', { class: 'sc-sep' }));
      if (fn.type === 'type') {
        const res = C.checkTyped(this.typedValue, s.answerText);
        this.suggest = res.ok ? 3 : 1;
        area.append(el('div', { class: 'typed-res ' + (res.ok ? 'ok' : 'bad') },
          res.ok ? (res.exact ? '✓ Correto!' : '✓ Quase perfeito — aceito') : '✗ Não foi dessa vez',
          this.typedValue ? el('div', { class: 'small' }, 'Você escreveu: ', el('b', {}, this.typedValue)) : null));
      }
      area.append(setHTML(el('div', { class: 'sc-back' }), s.back));
      if (s.extra) area.append(setHTML(el('div', { class: 'sc-extra' }), s.extra));
      if (fn.source) area.append(el('button', { class: 'btn small ghost', onclick: () => { this.close(); location.hash = `#/note/${fn.source.noteId}/p/${fn.source.pageId}`; } }, icon('notes', 16), 'Ver na anotação'));
    }
    if (!this.revealed) area.addEventListener('click', e => { if (!e.target.closest('input, button')) this.reveal(); });
    // rascunho (escrever com o Pencil antes de ver a resposta)
    const scratch = this.scratchOn ? scratchCanvas() : null;

    const footer = el('div', { class: 'study-foot' });
    if (!this.revealed) {
      footer.append(el('button', { class: 'btn primary big reveal', onclick: () => { if (typed) this.typedValue = typed.value; this.reveal(); } }, 'Mostrar resposta'));
    } else if (this.cram) {
      footer.append(
        el('button', { class: 'rate r1', onclick: () => this.rateCram(false) }, el('b', {}, 'Errei'), el('small', {}, 'volta daqui a pouco')),
        el('button', { class: 'rate r3', onclick: () => this.rateCram(true) }, el('b', {}, 'Acertei'), el('small', {}, 'próxima')));
    } else {
      const pv = previews(card, now(), C.deckOpts(deck));
      const names = ['Errei', 'Difícil', 'Bom', 'Fácil'];
      names.forEach((n, i) => footer.append(el('button', { class: `rate r${i + 1}` + (this.suggest === i + 1 ? ' suggested' : ''), onclick: () => this.rate(i + 1) }, el('b', {}, n), el('small', {}, pv[i]))));
    }
    const header = el('div', { class: 'study-head' },
      iconBtn('x', 'Fechar', () => this.close()),
      el('div', { class: 'sh-title' }, el('b', {}, this.decks.length === 1 ? this.decks[0].name : 'Todos os baralhos'), this.counts()),
      iconBtn('volume', 'Ouvir', () => speak(this.revealed ? s.back : s.front, lang)),
      iconBtn('pen', 'Rascunho (escreva com o Pencil)', () => { this.scratchOn = !this.scratchOn; this.render(); }, this.scratchOn ? 'active' : ''),
      iconBtn('undo', 'Desfazer última resposta', () => this.undo()),
      iconBtn('more', 'Mais', e => this.cardMenuStudy(e.currentTarget, card, fn)));
    r.append(header, el('div', { class: 'study-body' }, area, scratch), footer);
    if (this.history.length === 0) header.querySelector('[title="Desfazer última resposta"]').disabled = true;
  }

  reveal() { this.revealed = true; this.render(); }

  async rate(g) {
    const { card } = this.cur;
    const deck = this.deckMap.get(card.deckId);
    const u = await C.answer(card, g, now() - this.shownAt, deck);
    u.kind = this.cur.kind;
    this.history.push(u);
    this.done++; if (g > 1) this.correct++;
    this.typedValue = ''; this.suggest = null;
    if (card.state === STATE.LEARNING || card.state === STATE.RELEARNING) this.q.learn.push(card);
    // irmãs enterradas saem da fila de hoje
    const sibIds = new Set(u.sib.map(s => s.id));
    if (sibIds.size) { this.q.news = this.q.news.filter(c => !sibIds.has(c.id)); this.q.review = this.q.review.filter(c => !sibIds.has(c.id)); }
    this.next();
  }

  rateCram(ok) {
    this.done++; if (ok) this.correct++;
    this.typedValue = ''; this.suggest = null;
    if (!ok) this.q.cram.splice(Math.min(this.q.cram.length, 3 + Math.floor(Math.random() * 3)), 0, this.cur.card);
    this.history.push({ cram: true, card: this.cur.card, ok });
    this.next();
  }

  async undo() {
    const u = this.history.pop();
    if (!u) return;
    if (u.cram) {
      if (!u.ok) { const i = this.q.cram.indexOf(u.card); if (i >= 0) this.q.cram.splice(i, 1); } else this.correct--;
      this.done--;
      this.q.cram.unshift(this.cur.card);
      this.cur = { card: u.card, kind: 'cram' };
    } else {
      await C.undoAnswer(u);
      this.done--; if (u.log.rating > 1) this.correct--;
      this.q.learn = this.q.learn.filter(c => c.id !== u.card.id);
      // devolve a carta atual para a fila e mostra a anterior
      const cur = this.cur;
      if (cur) (cur.kind === 'new' ? this.q.news : cur.kind === 'review' ? this.q.review : this.q.learn).unshift(cur.card);
      this.cur = { card: u.card, kind: u.kind };
    }
    this.revealed = false; this.shownAt = now();
    toast('Resposta desfeita.');
    this.render();
  }

  cardMenuStudy(anchor, card, fn) {
    menu(anchor, [
      { label: 'Editar esta carta', icon: 'text', onClick: () => openCardEditor({ fnote: fn, onSaved: async () => { this.fnotes.set(fn.id, await C.getFnote(fn.id)); this.render(); } }) },
      { label: card.flag ? 'Desmarcar' : 'Marcar (bandeira)', icon: 'flag', onClick: async () => { await C.updateCards([card], { flag: card.flag ? 0 : 1 }); toast(card.flag ? 'Marcada.' : 'Desmarcada.'); } },
      !this.cram ? { label: 'Pular até amanhã', icon: 'clock', onClick: async () => { await C.updateCards([card], { buriedUntil: dayStart(now()) + DAY }); this.next(); } } : null,
      !this.cram ? { label: 'Suspender', icon: 'pause2', onClick: async () => { await C.updateCards([card], { suspended: true }); toast('Carta suspensa.'); this.next(); } } : null,
    ], { align: 'right' });
  }

  key(e) {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!this.revealed) this.reveal(); else if (this.cram) this.rateCram(true); else this.rate(this.suggest || 3); }
    else if (this.revealed && !this.cram && ['1', '2', '3', '4'].includes(e.key)) this.rate(+e.key);
    else if (e.key === 'Escape') this.close();
    else if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey)) this.undo();
  }

  finish() {
    const r = this.root;
    r.innerHTML = '';
    const mins = Math.max(1, Math.round((now() - this.t0) / 60000));
    const pct = this.done ? Math.round(this.correct / this.done * 100) : 0;
    const learnLeft = !this.cram && this.q.learn.length;
    r.append(el('div', { class: 'study-head' }, iconBtn('x', 'Fechar', () => this.close()), el('div', { class: 'sh-title' }, el('b', {}, 'Fim da sessão'))),
      el('div', { class: 'study-done' },
        el('div', { class: 'done-emoji' }, this.done ? '🎉' : '✅'),
        el('h2', {}, this.done ? 'Parabéns!' : 'Nada para revisar agora'),
        this.done ? el('p', {}, `${this.done} carta(s) em ${mins} min · ${pct}% de acerto`) : null,
        learnLeft ? el('p', { class: 'muted' }, `Ainda há ${learnLeft} carta(s) em aprendizado. Elas voltam em alguns minutos: abra o estudo de novo daqui a pouco.`) : el('p', { class: 'muted' }, 'O app vai te mostrar cada carta de novo na hora certa.'),
        el('div', { class: 'row-btns center' },
          !this.cram ? el('button', { class: 'btn', onclick: async () => { for (const d of this.decks) await C.addNewToday(d, 10); this.q = await C.buildQueue(this.decks); this.next(); } }, '+10 cartas novas hoje') : null,
          el('button', { class: 'btn primary', onclick: () => this.close() }, 'Concluir'))));
  }
}

function scratchCanvas() {
  const cv = el('canvas', { class: 'scratch' });
  const strokes = [];
  let cur = null;
  const draw = () => {
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
    for (const s of strokes) ctx.fill(R.outlinePath(getStroke(s, { size: 4, thinning: 0.6, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last: true })));
  };
  requestAnimationFrame(() => {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
  });
  const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, e.pointerType === 'pen' ? Math.max(0.1, e.pressure) : 0.5]; };
  cv.addEventListener('pointerdown', e => { e.preventDefault(); cv.setPointerCapture(e.pointerId); cur = [pos(e)]; strokes.push(cur); });
  cv.addEventListener('pointermove', e => { if (!cur) return; for (const ev of (e.getCoalescedEvents?.() || [e])) cur.push(pos(ev)); draw(); });
  cv.addEventListener('pointerup', () => { cur = null; });
  const wrap = el('div', { class: 'scratch-wrap' }, cv, el('button', { class: 'btn small scratch-clear', onclick: () => { strokes.length = 0; draw(); } }, 'Limpar rascunho'));
  return wrap;
}

// ======================================================================
// Modo Cartões (virar e separar)
// ======================================================================
function overlay(title, onClose) {
  const root = el('div', { class: 'study' });
  const body = el('div', { class: 'study-body' });
  const head = el('div', { class: 'study-head' }, iconBtn('x', 'Fechar', () => { root.remove(); onClose?.(); }), el('div', { class: 'sh-title' }, el('b', {}, title)));
  root.append(head, body);
  document.body.append(root);
  return { root, body, head, close: () => { root.remove(); onClose?.(); } };
}

function flipMode(deck, cards, fnotes, subset = null) {
  let list = C.shuffle((subset || cards).filter(c => !c.suspended && fnotes.get(c.fnoteId)));
  let i = 0, flipped = false, backFirst = loadPref('flipBackFirst', false);
  const know = [], learning = [];
  const ov = overlay('Cartões · ' + deck.name);
  const lang = C.deckOpts(deck).ttsLang;
  const draw = () => {
    ov.body.innerHTML = '';
    if (i >= list.length) {
      ov.body.append(el('div', { class: 'study-done' },
        el('div', { class: 'done-emoji' }, '🃏'), el('h2', {}, 'Você passou por todas!'),
        el('p', {}, `Sei: ${know.length} · Ainda aprendendo: ${learning.length}`),
        el('div', { class: 'row-btns center' },
          learning.length ? el('button', { class: 'btn primary', onclick: () => { list = C.shuffle([...learning]); know.length = 0; learning.length = 0; i = 0; draw(); } }, `Estudar só as ${learning.length} que faltam`) : null,
          el('button', { class: 'btn', onclick: () => { list = C.shuffle(list.concat()); i = 0; know.length = 0; learning.length = 0; draw(); } }, 'Recomeçar'),
          el('button', { class: 'btn', onclick: () => ov.close() }, 'Concluir'))));
      return;
    }
    const c = list[i], fn = fnotes.get(c.fnoteId), s = C.sides(fn, c);
    const faceA = backFirst ? s.back : s.front, faceB = backFirst ? s.front : s.back;
    const card = el('div', { class: 'flip-card' + (flipped ? ' flipped' : '') },
      el('div', { class: 'flip-inner' },
        setHTML(el('div', { class: 'flip-face front' }), faceA),
        setHTML(el('div', { class: 'flip-face back' }), faceB + (s.extra ? `<div class="sc-extra">${s.extra}</div>` : ''))));
    card.addEventListener('click', () => { flipped = !flipped; card.classList.toggle('flipped', flipped); });
    // arrastar para os lados
    let sx = null;
    card.addEventListener('pointerdown', e => { sx = e.clientX; });
    card.addEventListener('pointerup', e => { if (sx == null) return; const dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 80) { e.stopPropagation(); mark(dx > 0); } });
    ov.body.append(el('div', { class: 'flip-wrap' },
      el('div', { class: 'muted small center' }, `${i + 1} de ${list.length} · toque para virar · arraste → se sabe, ← se não`),
      card,
      el('div', { class: 'flip-btns' },
        el('button', { class: 'rate r1', onclick: () => mark(false) }, el('b', {}, 'Ainda aprendendo')),
        iconBtn('volume', 'Ouvir', () => speak(flipped ? faceB : faceA, lang)),
        el('button', { class: 'btn small', onclick: () => { backFirst = !backFirst; savePref('flipBackFirst', backFirst); flipped = false; draw(); } }, backFirst ? 'Começar pela frente' : 'Começar pelo verso'),
        el('button', { class: 'rate r3', onclick: () => mark(true) }, el('b', {}, 'Sei')))));
  };
  const mark = ok => { (ok ? know : learning).push(list[i]); i++; flipped = false; draw(); };
  draw();
}

// ======================================================================
// Modo Teste
// ======================================================================
function testMode(deck, cards, fnotes) {
  const pool = cards.filter(c => !c.suspended && fnotes.get(c.fnoteId)).map(c => ({ c, s: C.sides(fnotes.get(c.fnoteId), c) }))
    .filter(x => C.htmlToText(x.s.back) || C.hasImage(x.s.back));
  const ov = overlay('Teste · ' + deck.name);
  const types = { mc: true, tf: true, wr: true };
  let n = Math.min(20, pool.length);
  const setup = () => {
    ov.body.innerHTML = '';
    const num = el('input', { type: 'number', class: 'field num', value: n, min: 1, max: pool.length });
    const chk = (k, label) => { const i = el('input', { type: 'checkbox' }); i.checked = types[k]; i.addEventListener('change', () => { types[k] = i.checked; }); return el('label', { class: 'field-row' }, el('span', {}, label), i); };
    ov.body.append(el('div', { class: 'test-setup' },
      el('h2', {}, 'Montar teste'),
      el('label', { class: 'field-row' }, el('span', {}, `Número de perguntas (máx. ${pool.length})`), num),
      chk('mc', 'Múltipla escolha'), chk('tf', 'Verdadeiro ou falso'), chk('wr', 'Escrever a resposta'),
      el('p', { class: 'muted small' }, 'O teste não muda o agendamento das revisões. É pra você se avaliar antes da prova.'),
      el('div', { class: 'row-btns' }, el('button', { class: 'btn primary', onclick: () => { n = clamp(+num.value || 1, 1, pool.length); start(); } }, 'Começar'))));
  };
  let qs = [], qi = 0, score = 0, wrong = [];
  const start = (from = null) => {
    const kinds = Object.keys(types).filter(k => types[k]);
    if (!kinds.length) return toast('Escolha pelo menos um tipo de pergunta.');
    const chosen = from || C.shuffle([...pool]).slice(0, n);
    qs = chosen.map(x => {
      let k = kinds[Math.floor(Math.random() * kinds.length)];
      const textAns = C.htmlToText(x.s.back);
      if ((k === 'mc' || k === 'tf') && pool.length < 4) k = 'wr';
      if (k === 'wr' && !textAns) k = 'mc';
      const q = { x, k };
      if (k === 'mc') {
        const others = C.shuffle(pool.filter(o => o !== x && C.htmlToText(o.s.back) !== textAns)).slice(0, 3);
        q.options = C.shuffle([x, ...others]);
      } else if (k === 'tf') {
        q.truth = Math.random() < 0.5;
        q.shown = q.truth ? x : C.shuffle(pool.filter(o => o !== x && C.htmlToText(o.s.back) !== textAns))[0] || x;
        if (q.shown === x) q.truth = true;
      }
      return q;
    });
    qi = 0; score = 0; wrong = [];
    ask();
  };
  const ask = () => {
    ov.body.innerHTML = '';
    if (qi >= qs.length) return result();
    const q = qs[qi];
    const wrap = el('div', { class: 'test-q' }, el('div', { class: 'muted small' }, `Pergunta ${qi + 1} de ${qs.length}`), setHTML(el('div', { class: 'sc-front' }), q.x.s.front));
    const feedback = el('div', { class: 'test-fb' });
    const done = ok => {
      if (ok) score++; else wrong.push(q.x);
      wrap.querySelectorAll('button.opt').forEach(b => { b.disabled = true; });
      feedback.append(el('div', { class: 'typed-res ' + (ok ? 'ok' : 'bad') }, ok ? '✓ Correto!' : '✗ Resposta certa:'),
        ok ? null : setHTML(el('div', { class: 'sc-back' }), q.x.s.back),
        el('button', { class: 'btn primary', onclick: () => { qi++; ask(); } }, qi + 1 < qs.length ? 'Próxima' : 'Ver resultado'));
    };
    if (q.k === 'mc') {
      const opts = el('div', { class: 'opts' });
      q.options.forEach(o => {
        const b = setHTML(el('button', { class: 'opt' }), o.s.back);
        b.addEventListener('click', () => { b.classList.add(o === q.x ? 'right' : 'wrong'); if (o !== q.x) opts.querySelectorAll('.opt')[q.options.indexOf(q.x)].classList.add('right'); done(o === q.x); });
        opts.append(b);
      });
      wrap.append(el('p', { class: 'small muted' }, 'Escolha a resposta certa:'), opts);
    } else if (q.k === 'tf') {
      wrap.append(el('p', { class: 'small muted' }, 'Esta é a resposta certa?'), setHTML(el('div', { class: 'tf-shown' }), q.shown.s.back),
        el('div', { class: 'opts two' },
          el('button', { class: 'opt', onclick: e => { e.currentTarget.classList.add(q.truth ? 'right' : 'wrong'); done(q.truth); } }, 'Verdadeiro'),
          el('button', { class: 'opt', onclick: e => { e.currentTarget.classList.add(!q.truth ? 'right' : 'wrong'); done(!q.truth); } }, 'Falso')));
    } else {
      const inp = el('input', { type: 'text', class: 'field type-in', placeholder: 'Escreva a resposta', autocapitalize: 'off', autocomplete: 'off', enterkeyhint: 'done' });
      const go = () => { if (inp.disabled) return; inp.disabled = true; const r = C.checkTyped(inp.value, C.htmlToText(q.x.s.back)); done(r.ok); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      wrap.append(inp, el('button', { class: 'btn primary opt', onclick: go }, 'Responder'));
      setTimeout(() => inp.focus(), 50);
    }
    wrap.append(feedback);
    ov.body.append(wrap);
  };
  const result = () => {
    const pct = Math.round(score / qs.length * 100);
    ov.body.append(el('div', { class: 'study-done' },
      el('div', { class: 'done-emoji' }, pct >= 90 ? '🏆' : pct >= 70 ? '👏' : '📚'),
      el('h2', {}, `${pct}% de acerto`), el('p', {}, `${score} de ${qs.length} corretas`),
      wrong.length ? el('div', { class: 'wrong-list' }, el('h4', {}, 'Para revisar:'), ...wrong.map(x => el('div', { class: 'wrong-item' }, setHTML(el('div', {}), x.s.front), setHTML(el('div', { class: 'muted' }, ''), x.s.back)))) : null,
      el('div', { class: 'row-btns center' },
        wrong.length ? el('button', { class: 'btn primary', onclick: () => start([...wrong]) }, 'Refazer as erradas') : null,
        el('button', { class: 'btn', onclick: setup }, 'Novo teste'),
        el('button', { class: 'btn', onclick: () => ov.close() }, 'Concluir'))));
  };
  setup();
}

// ======================================================================
// Modo Combinar (jogo contra o tempo)
// ======================================================================
function matchMode(deck, cards, fnotes) {
  const pool = cards.filter(c => !c.suspended && fnotes.get(c.fnoteId)).map(c => C.sides(fnotes.get(c.fnoteId), c))
    .map(s => ({ a: C.htmlToText(s.front), b: C.htmlToText(s.back) })).filter(x => x.a && x.b && x.a.length <= 120 && x.b.length <= 120);
  const ov = overlay('Combinar · ' + deck.name);
  if (pool.length < 3) { ov.body.append(el('p', { class: 'center muted' }, 'Precisa de pelo menos 3 cartas só com texto curto.')); return; }
  const bestKey = 'matchBest:' + deck.id;
  let timer;
  const play = () => {
    clearInterval(timer);
    ov.body.innerHTML = '';
    const pairs = C.shuffle([...pool]).slice(0, Math.min(6, pool.length));
    const tiles = C.shuffle(pairs.flatMap((p, i) => [{ t: p.a, i }, { t: p.b, i }]));
    const t0 = performance.now(); let penalty = 0, left = pairs.length, sel = null;
    const clock = el('div', { class: 'match-clock' }, '0,0 s');
    timer = setInterval(() => { clock.textContent = ((performance.now() - t0) / 1000 + penalty).toFixed(1).replace('.', ',') + ' s'; }, 100);
    const grid = el('div', { class: 'match-grid' });
    for (const tile of tiles) {
      const b = el('button', { class: 'match-tile' }, tile.t);
      b.addEventListener('click', () => {
        if (b.classList.contains('gone')) return;
        if (!sel) { sel = { b, tile }; b.classList.add('sel'); return; }
        if (sel.b === b) { b.classList.remove('sel'); sel = null; return; }
        if (sel.tile.i === tile.i) {
          sel.b.classList.add('gone'); b.classList.add('gone'); sel = null; left--;
          if (!left) {
            clearInterval(timer);
            const total = (performance.now() - t0) / 1000 + penalty;
            const best = loadPref(bestKey, null);
            const isBest = best == null || total < best;
            if (isBest) savePref(bestKey, total);
            setTimeout(() => {
              ov.body.innerHTML = '';
              ov.body.append(el('div', { class: 'study-done' }, el('div', { class: 'done-emoji' }, isBest ? '🏆' : '⏱️'),
                el('h2', {}, total.toFixed(1).replace('.', ',') + ' segundos'),
                el('p', { class: 'muted' }, isBest ? 'Novo recorde!' : `Seu recorde: ${best.toFixed(1).replace('.', ',')} s`),
                el('div', { class: 'row-btns center' }, el('button', { class: 'btn primary', onclick: play }, 'Jogar de novo'), el('button', { class: 'btn', onclick: () => ov.close() }, 'Concluir'))));
            }, 300);
          }
        } else {
          penalty += 1;
          const a = sel.b; a.classList.add('bad'); b.classList.add('bad');
          setTimeout(() => { a.classList.remove('bad', 'sel'); b.classList.remove('bad'); }, 450);
          sel = null;
        }
      });
      grid.append(b);
    }
    ov.body.append(el('div', { class: 'match-wrap' }, el('div', { class: 'match-top' }, el('span', { class: 'muted small' }, 'Toque num termo e depois na resposta dele. Erro = +1 s.'), clock), grid));
  };
  const origClose = ov.close;
  ov.close = () => { clearInterval(timer); origClose(); };
  play();
}

// Imagem de uma seleção da anotação (para criar flashcard a partir do laço)
export async function selectionImage(items, bbox, page, getImage) {
  const pad = 16, scale = 2;
  const w = bbox[2] - bbox[0] + pad * 2, h = bbox[3] - bbox[1] + pad * 2;
  const c = document.createElement('canvas');
  c.width = Math.min(2400, Math.round(w * scale)); c.height = Math.round(c.width * h / w);
  const s = c.width / w;
  const ctx = c.getContext('2d');
  const dark = !page.pdf && R.isDarkColor(page.paperColor);
  ctx.fillStyle = dark ? page.paperColor : '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(s, 0, 0, s, (-bbox[0] + pad) * s, (-bbox[1] + pad) * s);
  R.drawItems(ctx, R.sortItems([...items]), { getImage, dark });
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return { data: await blob.arrayBuffer(), mime: 'image/png' };
}
