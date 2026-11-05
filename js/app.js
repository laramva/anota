// Inicialização e navegação

import * as db from './db.js';
import * as store from './store.js';
import * as audio from './audio.js';
import { initSync } from './sync.js';
import { Library } from './library.js';
import { Editor } from './editor.js';
import { toast, applyTheme } from './ui.js';

applyTheme();

const root = document.getElementById('app');
let current = null;
let routing = Promise.resolve();

function openNote(id) { location.hash = '#/note/' + id; }

async function route() {
  const m = location.hash.match(/^#\/note\/([\w-]+)/);
  if (current instanceof Editor) {
    if (m && current.note.id === m[1]) return;
    const ed = current;
    current = null;
    ed.onExit = null;
    await ed.exit();
  } else if (current) { current.destroy(); current = null; }

  if (m) {
    const note = await store.getNote(m[1]);
    if (!note || note.deleted) { location.replace('#/'); return; }
    note.lastOpenedAt = Date.now();
    const ed = new Editor(root, note, { onExit: () => { if (location.hash !== '#/') location.hash = '#/'; } });
    current = ed;
    try { await ed.init(); } catch (e) {
      console.error(e);
      toast('Erro ao abrir a nota: ' + e.message, { kind: 'error', timeout: 8000 });
      location.replace('#/');
    }
  } else {
    const lib = new Library(root, { openNote });
    current = lib;
    await lib.init();
  }
}

function queueRoute() { routing = routing.then(route, route); }

// Chegou pelo link do e-mail de confirmação: avisa e limpa o endereço
function handleAuthReturn() {
  const h = location.hash;
  if (!/access_token=|error_description=|type=signup/.test(h)) return;
  const params = new URLSearchParams(h.slice(1));
  const err = params.get('error_description');
  history.replaceState(null, '', location.pathname + '#/');
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const msg = err
    ? (/expired|invalid/i.test(err) ? 'Esse link já foi usado ou expirou. Se você já confirmou antes, é só entrar com seu e-mail e senha.' : 'Erro na confirmação: ' + err)
    : 'E-mail confirmado!';
  const next = standalone ? 'Agora vá em Ajustes e toque em Entrar.' : 'Agora feche o Safari, abra o Anota pelo ícone da Tela de Início, vá em Ajustes e toque em Entrar.';
  setTimeout(() => toast(msg + ' ' + next, { timeout: 15000, kind: err && !/expired|invalid/i.test(err) ? 'error' : '' }), 600);
}

async function main() {
  handleAuthReturn();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Nova versão disponível.', { action: 'Atualizar', timeout: 0, onAction: () => location.reload() });
          }
        });
      });
    } catch (e) { console.warn('SW', e); }
  }
  try { await navigator.storage?.persist?.(); } catch { }
  try {
    await db.openDB();
  } catch (e) {
    root.innerHTML = '<div class="fatal"><h2>Não foi possível abrir o armazenamento</h2><p>' + (e.message || e) + '</p><p>Feche outras abas do app e tente novamente.</p></div>';
    return;
  }
  store.bus.on('save-error', e => toast('ERRO ao salvar: ' + (e?.name === 'QuotaExceededError' ? 'espaço do iPad cheio' : e?.message || e), { kind: 'error', timeout: 8000 }));
  try {
    if (await audio.recoverRecordings()) toast('Uma gravação interrompida foi recuperada e salva.', { timeout: 6000 });
  } catch (e) { console.warn(e); }
  initSync().catch(e => console.warn('sync init', e));
  window.addEventListener('hashchange', queueRoute);
  queueRoute();
}

main();
