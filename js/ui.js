// Componentes de interface: ícones, diálogos, menus, avisos

import { el, loadPref } from './util.js';

// ---------- Tema (escuro / claro / automático) ----------
const darkMq = matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(pref = loadPref('theme', 'dark')) {
  const t = pref === 'auto' ? (darkMq.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = t;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  window.dispatchEvent(new Event('themechange'));
}
darkMq.addEventListener?.('change', () => { if (loadPref('theme', 'dark') === 'auto') applyTheme('auto'); });
export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const P = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  pen: '<path d="M4 20l1.2-4.6L16.5 4.1a2 2 0 012.8 0l.6.6a2 2 0 010 2.8L8.6 18.8 4 20z"/><path d="M14.5 6l3.5 3.5"/>',
  highlighter: '<path d="M9 15l-4 5h6l1.5-1.5"/><path d="M9 15l7.5-10.5a2 2 0 012.8-.4l.6.5a2 2 0 01.4 2.8L13 15.5z"/><path d="M9 15l4 .5"/>',
  eraser: '<path d="M8.5 20H20"/><path d="M4.7 14.3l9.6-9.6a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L11 18l-2 2H8.5l-3.8-3.8a1.4 1.4 0 010-1.9z"/><path d="M9 10l5 5"/>',
  lasso: '<path d="M7 17.5C4.6 16.3 3 14.3 3 12c0-4 4-7 9-7s9 3 9 7-4 7-9 7c-1 0-2-.1-2.9-.4"/><circle cx="7.5" cy="18.5" r="1.8"/><path d="M7 20.3c0 1 .5 1.7 1.5 1.7"/>',
  text: '<path d="M5 6V4.5h14V6"/><path d="M12 4.5v15"/><path d="M9 19.5h6"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5L6 19.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0"/><path d="M12 17.5V21"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>',
  notes: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 01-.5-9 6 6 0 0111.4 1.6A3.8 3.8 0 0117.5 18.5z"/>',
  cloudOk: '<path d="M7 18.5a4.5 4.5 0 01-.5-9 6 6 0 0111.4 1.6A3.8 3.8 0 0117.5 18.5z"/><path d="M9.5 13.5l2 2 3.5-3.5"/>',
  cloudOff: '<path d="M7 18.5a4.5 4.5 0 01-.5-9 6 6 0 0111.4 1.6A3.8 3.8 0 0117.5 18.5z"/><path d="M4 4l16 16"/>',
  sync: '<path d="M20 11a8 8 0 00-14.3-4.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0014.3 4.3L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  file: '<path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V8.5z"/><path d="M14 3.5v5h5"/>',
  share: '<path d="M12 15V3.5"/><path d="M8 7.5l4-4 4 4"/><path d="M5.5 12v6.5a2 2 0 002 2h9a2 2 0 002-2V12"/>',
  pagePlus: '<path d="M14 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V8.5z"/><path d="M12 10.5v6M9 13.5h6"/>',
  back15: '<path d="M4 12a8 8 0 108-8H8"/><path d="M10.5 1.5L8 4l2.5 2.5"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">15</text>',
  fwd15: '<path d="M20 12a8 8 0 11-8-8h4"/><path d="M13.5 1.5L16 4l-2.5 2.5"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">15</text>',
  restore: '<path d="M4 12a8 8 0 108-8 8.2 8.2 0 00-6 2.7L4 9"/><path d="M4 4v5h5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h2"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 000 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.5-1-2.6 0-1 .8-1.7 1.8-1.7h2a3.9 3.9 0 003.9-3.9C20.5 6.8 16.7 3.5 12 3.5z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1.2" fill="currentColor"/><circle cx="15" cy="7.8" r="1.2" fill="currentColor"/>',
  finger: '<path d="M9 11V5.5a1.5 1.5 0 013 0V11"/><path d="M12 10V8.5a1.5 1.5 0 013 0V11"/><path d="M15 10.5a1.5 1.5 0 013 0V15a6 6 0 01-6 6h-1a6 6 0 01-4.6-2.2L4 15.5a1.5 1.5 0 012.3-2L9 16V11"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  pages: '<rect x="3.5" y="3.5" width="7" height="9" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="15" width="7" height="5.5" rx="1.5"/><rect x="13.5" y="15" width="7" height="5.5" rx="1.5"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
  starFill: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  inbox: '<path d="M3.5 13.5l2.5-8h12l2.5 8v5a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/><path d="M3.5 13.5h5l1 2h5l1-2h5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  tag: '<path d="M3.5 12.5V5a1.5 1.5 0 011.5-1.5h7.5l8 8-9 9z"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/>',
  cards: '<rect x="6.5" y="3.5" width="13" height="15" rx="2"/><path d="M4.5 6.5v12a2 2 0 002 2h10"/><path d="M10 9h6M10 12.5h4"/>',
  flip: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M12 5v14"/><path d="M8 10l-2 2 2 2M16 10l2 2-2 2"/>',
  quiz: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.2"/><circle cx="12" cy="16.8" r=".9" fill="currentColor"/>',
  match: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M14.5 17l2 2 3.5-4"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5" rx=".5"/><rect x="12" y="8" width="3" height="9" rx=".5"/><rect x="17" y="5" width="3" height="12" rx=".5"/>',
  brain: '<path d="M9 4.5a3 3 0 00-3 3 3 3 0 00-1.5 5.5A3 3 0 007 18a2.5 2.5 0 005 0V6.5a2 2 0 00-3-2z"/><path d="M15 4.5a3 3 0 013 3 3 3 0 011.5 5.5A3 3 0 0117 18a2.5 2.5 0 01-5 0"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"/>',
  fire: '<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.7 3-5.6 4-9.3 2.3 1.4 3.3 3.5 3.3 5.5 1-.6 1.6-1.6 1.8-2.8 1.9 1.7 3.9 4 3.9 6.8 0 3.5-2.6 6-6.5 6z"/>',
  bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  camera: '<path d="M4.5 8h3l1.5-2.5h6L16.5 8h3a1.5 1.5 0 011.5 1.5v8.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18V9.5A1.5 1.5 0 014.5 8z"/><circle cx="12" cy="13.5" r="3.5"/>',
  wave: '<path d="M4 12h1M7.5 8v8M11 5v14M14.5 9v6M18 7v10M21 12h-1"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.2"/><circle cx="12" cy="16.8" r=".9" fill="currentColor"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  flag: '<path d="M5.5 21V4"/><path d="M5.5 4.5h11l-2 4 2 4h-11"/>',
  pause2: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  download: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  upload: '<path d="M12 15V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M5 19.5h14"/>',
};

export function icon(name, size = 22) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] || '';
  return s;
}

export function iconBtn(name, title, onClick, cls = '') {
  return el('button', { class: 'icon-btn ' + cls, title, 'aria-label': title, onclick: onClick }, icon(name));
}

// ---------- Aviso rápido ----------
let toastWrap;
export function toast(msg, { action, onAction, timeout = 3500, kind = '' } = {}) {
  if (!toastWrap) { toastWrap = el('div', { class: 'toasts' }); document.body.append(toastWrap); }
  const t = el('div', { class: 'toast ' + kind }, el('span', {}, msg));
  if (action) t.append(el('button', { onclick: () => { onAction?.(); t.remove(); } }, action));
  toastWrap.append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
  return t;
}

// ---------- Diálogo genérico ----------
export function modal(content, { onClose, wide = false } = {}) {
  const back = el('div', { class: 'modal-back' });
  const box = el('div', { class: 'modal' + (wide ? ' wide' : '') }, content);
  back.append(box);
  const close = () => { back.remove(); onClose?.(); };
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  document.body.append(back);
  return { close, box };
}

export function promptText(title, value = '', { placeholder = '', ok = 'OK' } = {}) {
  return new Promise(res => {
    const input = el('input', { type: 'text', value, placeholder, class: 'field' });
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); res(v); };
    const form = el('form', { onsubmit: e => { e.preventDefault(); finish(input.value.trim()); } },
      el('h3', {}, title), input,
      el('div', { class: 'modal-actions' },
        el('button', { type: 'button', class: 'btn', onclick: () => finish(null) }, 'Cancelar'),
        el('button', { type: 'submit', class: 'btn primary' }, ok)));
    const m = modal(form, { onClose: () => finish(null) });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

export function confirmBox(title, text, { ok = 'OK', danger = false } = {}) {
  return new Promise(res => {
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); res(v); };
    const m = modal(el('div', {},
      el('h3', {}, title), text ? el('p', { class: 'muted' }, text) : null,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => finish(false) }, 'Cancelar'),
        el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => finish(true) }, ok))),
      { onClose: () => finish(false) });
  });
}

// ---------- Menu suspenso ----------
let openMenu = null;
export function closeMenu() { openMenu?.remove(); openMenu = null; }

export function popover(anchor, content, { align = 'left' } = {}) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const m = el('div', { class: 'popover' }, content);
  document.body.append(m);
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = align === 'right' ? r.right - mw : align === 'center' ? r.left + r.width / 2 - mw / 2 : r.left;
  x = Math.max(8, Math.min(innerWidth - mw - 8, x));
  let y = r.bottom + 6;
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  m.style.left = x + 'px'; m.style.top = y + 'px';
  openMenu = m;
  setTimeout(() => {
    const off = e => {
      if (!m.isConnected) { document.removeEventListener('pointerdown', off, true); return; }
      if (!m.contains(e.target) && !anchor.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', off, true); }
    };
    document.addEventListener('pointerdown', off, true);
  });
  return m;
}

// items: [{label, icon, onClick, danger, sep}]
export function menu(anchor, items, opts) {
  const list = el('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { list.append(el('div', { class: 'menu-sep' })); continue; }
    if (it.header) { list.append(el('div', { class: 'menu-header' }, it.header)); continue; }
    list.append(el('button', {
      class: 'menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''),
      onclick: () => { closeMenu(); it.onClick?.(); },
    }, it.icon ? icon(it.icon, 18) : el('span', { class: 'menu-ico' }), el('span', {}, it.label),
      it.checked ? icon('check', 16) : null));
  }
  return popover(anchor, list, opts);
}

export function pickFile(accept, multiple = false, camera = false) {
  return new Promise(res => {
    const inp = el('input', { type: 'file', accept, style: { display: 'none' } });
    if (multiple) inp.multiple = true;
    if (camera) inp.setAttribute('capture', 'environment');
    inp.addEventListener('change', () => { res(multiple ? [...inp.files] : inp.files[0] || null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

export function busy(msg) {
  const m = modal(el('div', { class: 'busy' }, el('div', { class: 'spinner' }), el('p', {}, msg)));
  const p = m.box.querySelector('p');
  return { close: m.close, set: t => { p.textContent = t; } };
}
