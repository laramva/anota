// Inicialização e navegação

import * as db from './db.js';
import * as store from './store.js';
import * as audio from './audio.js';
import * as sync from './sync.js';
import { initSync } from './sync.js';
import { Library } from './library.js';
import { Editor } from './editor.js';
import { toast, applyTheme, modal } from './ui.js';
import { el, isIPad } from './util.js';

applyTheme();

const root = document.getElementById('app');
let current = null;
let routing = Promise.resolve();
let pendingReload = false;

function reloadIfSafe() {
  if (!pendingReload) return;
  const busyNow = current instanceof Editor || document.querySelector('.study, .modal-back') || audio.isRecording();
  if (busyNow) return;
  pendingReload = false;
  location.reload();
}

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
    if (pendingReload) { reloadIfSafe(); if (!pendingReload) return; }
    const lib = new Library(root, { openNote });
    current = lib;
    await lib.init();
  }
}

function queueRoute() { routing = routing.then(route, route); }

// Chegou pelo link do e-mail de confirmação: avisa e limpa o endereço
function handleAuthReturn() {
  const h = location.hash;
  if (!/access_token=|error_description=|type=signup|type=recovery/.test(h)) return null;
  const params = new URLSearchParams(h.slice(1));
  const err = params.get('error_description');
  history.replaceState(null, '', location.pathname + '#/');
  // link de "esqueci a senha": abre a troca de senha
  if (params.get('type') === 'recovery' && params.get('access_token')) {
    return { access_token: params.get('access_token'), refresh_token: params.get('refresh_token') };
  }
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const msg = err
    ? (/expired|invalid/i.test(err) ? 'Esse link já foi usado ou expirou. Se você já confirmou antes, é só entrar com seu e-mail e senha.' : 'Erro na confirmação: ' + err)
    : 'E-mail confirmado!';
  const next = standalone || !isIPad() ? 'Agora vá em Ajustes e toque em Entrar.' : 'Agora abra o Anota pelo ícone da Tela de Início, vá em Ajustes e toque em Entrar.';
  setTimeout(() => toast(msg + ' ' + next, { timeout: 15000, kind: err && !/expired|invalid/i.test(err) ? 'error' : '' }), 600);
  return null;
}

// Tela para escolher a senha nova depois do link de "esqueci a senha"
async function finishRecovery(tokens) {
  try { await sync.useRecoveryLink(tokens); } catch (e) { toast('Esse link de troca de senha expirou. Peça outro em Ajustes › Esqueci a senha.', { kind: 'error', timeout: 10000 }); return; }
  const p1 = el('input', { type: 'password', class: 'field', placeholder: 'Senha nova (mínimo 6 caracteres)', autocomplete: 'new-password' });
  const p2 = el('input', { type: 'password', class: 'field', placeholder: 'Repita a senha nova', autocomplete: 'new-password' });
  const msg = el('p', { class: 'small' });
  let m;
  m = modal(el('div', {}, el('h3', {}, 'Escolha sua senha nova'), p1, p2, msg,
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn primary', onclick: async () => {
      if (p1.value.length < 6) { msg.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
      if (p1.value !== p2.value) { msg.textContent = 'As duas senhas não são iguais.'; return; }
      try { await sync.updatePassword(p1.value); m.close(); toast('Senha trocada! Use a senha nova em todos os aparelhos.', { timeout: 8000 }); }
      catch (e) { msg.textContent = 'Não deu: ' + e.message; }
    } }, 'Salvar senha nova'))));
}

async function main() {
  const recovery = handleAuthReturn();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      const hadController = !!navigator.serviceWorker.controller;
      const reg = await navigator.serviceWorker.register('sw.js');
      // Atualização automática: quando sai versão nova, o app recarrega sozinho num momento seguro
      // (fora de uma nota e sem estudo aberto). Tudo já está salvo, nada se perde.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        pendingReload = true;
        reloadIfSafe();
      });
      const check = () => reg.update().catch(() => { });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { check(); reloadIfSafe(); } });
      setInterval(check, 30 * 60000);
    } catch (e) { console.warn('SW', e); }
  }
  try { await navigator.storage?.persist?.(); } catch { }
  try {
    await db.openDB();
  } catch (e) {
    root.innerHTML = '<div class="fatal"><h2>Não foi possível abrir o armazenamento</h2><p>' + (e.message || e) + '</p><p>Feche outras abas do app e tente novamente.</p></div>';
    return;
  }
  store.bus.on('save-error', e => toast(e?.name === 'QuotaExceededError'
    ? 'Espaço do aparelho cheio: libere espaço para o app conseguir salvar.'
    : 'O iPad atrasou o salvamento. O app está tentando de novo sozinho; não feche o app agora.', { kind: 'error', timeout: 8000 }));
  store.bus.on('save-ok', () => toast('Tudo salvo de novo ✓', { timeout: 4000 }));
  try {
    if (await audio.recoverRecordings()) toast('Uma gravação interrompida foi recuperada e salva.', { timeout: 6000 });
  } catch (e) { console.warn(e); }
  initSync().then(() => { if (recovery) finishRecovery(recovery); }).catch(e => console.warn('sync init', e));
  window.addEventListener('hashchange', queueRoute);
  queueRoute();
}

main();
