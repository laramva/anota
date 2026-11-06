// Boas-vindas e guia "Como usar"

import { el } from './util.js';
import { icon, iconBtn, modal } from './ui.js';

const FEATURES = [
  { ic: 'pen', c: 'c-blue', t: 'Escrever à mão', d: 'Caneta com pressão, marca-texto, borracha e laço. Só o Pencil escreve: a mão apoiada não risca.',
    how: ['Toque na ferramenta para usar; toque de novo para escolher cor e espessura.', 'Desenhe e segure a caneta parada: vira linha, círculo, retângulo ou triângulo perfeitos.', 'Toque com 2 dedos = desfazer · 3 dedos = refazer · pinça = zoom.'] },
  { ic: 'mic', c: 'c-red', t: 'Gravar aula + transcrição', d: 'Grave o professor enquanto escreve. Depois, toque numa anotação e ouça exatamente aquele momento.',
    how: ['Na nota, toque em "Gravar". O texto falado aparece transcrito (precisa de internet).', 'Toque em "Áudios" para ouvir, mudar a velocidade e ler a transcrição.', 'Toque numa frase da transcrição para pular para aquele ponto do áudio.'] },
  { ic: 'file', c: 'c-orange', t: 'PDFs e slides', d: 'Importe apostilas e slides e escreva por cima. Exporte o PDF anotado quando quiser.',
    how: ['Na tela inicial: "Importar PDF". Dentro de uma nota: "Inserir" › "PDF".', 'Para exportar: menu ••• › "Exportar / compartilhar PDF".'] },
  { ic: 'camera', c: 'c-green', t: 'Fotos e imagens', d: 'Fotografe o quadro ou o livro e anote em cima. Mova e redimensione com o Laço.',
    how: ['Na nota: "Inserir" › "Tirar foto" ou "Foto da galeria".', 'Use o Laço para selecionar a imagem e arrastar ou aumentar pelo cantinho.'] },
  { ic: 'cards', c: 'c-purple', t: 'Flashcards', d: 'Cartas com repetição espaçada (o mesmo método do Anki): o app mostra cada carta na hora certa.',
    how: ['Aba "Flashcards" na barra lateral. Crie baralhos por matéria.', 'Na nota, selecione algo com o Laço e toque em "Flashcard" para virar carta.', 'Modos: Revisar, Cartões, Teste, Combinar e Estudo livre.'] },
  { ic: 'sparkle', c: 'c-purple', t: 'Flashcards automáticos (grátis)', d: 'O app cria cartas sozinho a partir das suas anotações, em baralhos separados por matéria e tema.',
    how: ['Marque um trecho do PDF com o marca-texto: vira carta de lacuna.', 'Numa caixa de texto, escreva "termo: definição" (pode escrever à mão com o Pencil): vira pergunta e resposta.', 'Para ler a letra à mão solta na página: Ajustes › Flashcards automáticos › chave grátis do Google.', 'Na aba Flashcards, filtro "✨ Automáticas" para revisar ou apagar o que não ficou bom.'] },
  { ic: 'folder', c: 'c-gray', t: 'Organização', d: 'Matéria › Tema › Notas. Favoritas, recentes e busca pelo título.',
    how: ['Crie matérias no "+" da barra lateral; dentro delas, temas.', 'Menu ••• da nota › "Mover para matéria / tema".'] },
  { ic: 'pages', c: 'c-blue', t: 'Páginas', d: 'Veja todas as páginas em miniatura, pule para qualquer uma e reordene arrastando.',
    how: ['Na nota, toque em "Páginas".', 'Arraste pelos pontinhos para mudar a ordem; ••• para duplicar ou excluir.'] },
  { ic: 'cloudOk', c: 'c-green', t: 'Tudo salvo, sempre', d: 'Salva no aparelho a cada traço, funciona sem internet e sincroniza com a nuvem.',
    how: ['Abra sempre pelo ícone da Tela de Início.', 'Ajustes › "Fazer backup agora" gera uma cópia extra para guardar no iCloud Drive.'] },
];

function featureGrid(detailed) {
  return el('div', { class: 'help-grid' }, ...FEATURES.map(f => el('div', { class: 'help-item' },
    el('span', { class: 'qa-ico ' + f.c }, icon(f.ic, 22)),
    el('div', {}, el('b', {}, f.t), el('p', { class: 'muted small' }, f.d),
      detailed ? el('ul', { class: 'small' }, ...f.how.map(h => el('li', {}, h))) : null))));
}

export function showWelcome(lib) {
  let m;
  m = modal(el('div', { class: 'welcome' },
    el('div', { class: 'welcome-top' }, el('img', { src: 'icons/icon-192.png', alt: '' }), el('div', {}, el('h2', {}, 'Boas-vindas ao Anota'), el('p', { class: 'muted' }, 'Seu caderno de estudos no iPad e no PC. Dá pra fazer muito mais do que anotar:'))),
    featureGrid(false),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: () => { m.close(); showHelp(lib); } }, 'Ver como usar cada função'),
      el('button', { class: 'btn primary', onclick: () => m.close() }, 'Começar'))), { wide: true });
}

export function showHelp() {
  let m;
  m = modal(el('div', { class: 'welcome' },
    el('div', { class: 'settings-head' }, el('h2', {}, 'Como usar'), iconBtn('x', 'Fechar', () => m.close())),
    featureGrid(true),
    el('p', { class: 'muted small center' }, 'Dica: este guia fica sempre no botão "?" embaixo da barra lateral.')), { wide: true });
}

// Dicas na primeira vez que abre uma nota
export function editorTips(onClose) {
  return el('div', { class: 'ed-tips' },
    el('div', { class: 'ed-tips-list' },
      el('span', {}, icon('pen', 16), 'Escreva com o Pencil'),
      el('span', {}, icon('undo', 16), '2 dedos = desfazer'),
      el('span', {}, icon('sparkle', 16), 'Segure a caneta = forma perfeita'),
      el('span', {}, icon('mic', 16), '"Gravar" grava a aula'),
      el('span', {}, icon('plus', 16), '"Inserir" = foto, PDF, página, flashcard')),
    el('button', { class: 'btn small primary', onclick: onClose }, 'Entendi'));
}
