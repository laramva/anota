// Gravação de áudio: salva pedaços a cada 2 s no aparelho (não se perde se o app fechar)

import * as db from './db.js';
import * as store from './store.js';
import { uid, now, emitter, loadPref } from './util.js';

export const audioBus = emitter();
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canTranscribe = () => !!SR;

// Transcrição ao vivo (reconhecimento de fala do próprio iPad). Se falhar, o áudio continua gravando.
function startTranscription(rec) {
  rec.transcript = [];
  let fails = 0;
  const run = () => {
    if (active !== rec || rec.srFailed) return;
    const r = new SR();
    r.lang = loadPref('transcribeLang', 'pt-BR');
    r.continuous = true;
    r.interimResults = true;
    let segStart = null;
    r.onresult = e => {
      fails = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (segStart == null) segStart = performance.now() - rec.startPerf;
        if (res.isFinal) {
          const text = res[0].transcript.trim();
          if (text) {
            rec.transcript.push({ t: Math.max(0, Math.round(segStart - 1200)), text });
            db.setMeta('activeRecTranscript', { id: rec.id, segs: rec.transcript }).catch(() => { });
            audioBus.emit('transcript', rec.transcript);
          }
          segStart = null;
          audioBus.emit('interim', '');
        } else audioBus.emit('interim', res[0].transcript);
      }
    };
    r.onerror = e => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(e.error)) {
        rec.srFailed = true;
        audioBus.emit('transcript-error', e.error);
      } else fails++;
    };
    r.onend = () => { if (active === rec && !rec.srFailed && fails < 8) setTimeout(run, 300); };
    try { r.start(); rec.sr = r; } catch { rec.srFailed = true; audioBus.emit('transcript-error', 'start'); }
  };
  run();
}
let active = null; // { id, noteId, startedAt, startPerf, mr, stream, seq, mime, pending:Set, wake }

function pickMime() {
  const opts = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm'];
  if (!window.MediaRecorder) return null;
  for (const m of opts) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return '';
}

export const isRecording = () => !!active;
export const activeRecording = () => active;
export function elapsedMs() { return active ? performance.now() - active.startPerf : 0; }

export async function startRecording(noteId) {
  if (active) return active;
  if (!navigator.mediaDevices?.getUserMedia || pickMime() === null) throw new Error('Este navegador não permite gravar áudio.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = pickMime();
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : { audioBitsPerSecond: 48000 });
  const rec = { id: uid(), noteId, startedAt: now(), startPerf: performance.now(), mr, stream, seq: 0, mime: mr.mimeType || mime || 'audio/mp4', pending: new Set(), wake: null };
  await db.setMeta('activeRec', { id: rec.id, noteId, startedAt: rec.startedAt, mime: rec.mime });
  mr.ondataavailable = e => {
    if (!e.data || !e.data.size) return;
    const seq = rec.seq++;
    const t = performance.now() - rec.startPerf;
    const p = e.data.arrayBuffer().then(buf => db.put('chunks', { recId: rec.id, seq, data: buf, t }))
      .catch(err => { console.error(err); audioBus.emit('error', err); })
      .finally(() => rec.pending.delete(p));
    rec.pending.add(p);
  };
  mr.onerror = e => { audioBus.emit('error', e.error || e); stopRecording(); };
  mr.start(2000);
  active = rec;
  if (SR && loadPref('transcribe', true)) startTranscription(rec);
  try { rec.wake = await navigator.wakeLock?.request('screen'); } catch { }
  audioBus.emit('change');
  return rec;
}

export async function stopRecording() {
  const rec = active;
  if (!rec) return null;
  active = null;
  await new Promise(res => {
    if (rec.mr.state === 'inactive') return res();
    rec.mr.addEventListener('stop', () => res(), { once: true });
    try { rec.mr.stop(); } catch { res(); }
  });
  try { rec.sr?.stop(); } catch { }
  rec.stream.getTracks().forEach(t => t.stop());
  try { await rec.wake?.release(); } catch { }
  await Promise.all([...rec.pending]);
  const duration = (performance.now() - rec.startPerf) / 1000;
  const r = await finalize(rec.id, rec.noteId, rec.startedAt, rec.mime, duration, rec.transcript || []);
  audioBus.emit('change');
  return r;
}

async function finalize(recId, noteId, startedAt, mime, duration, transcript = []) {
  const chunks = (await db.byIndex('chunks', 'recId', recId)).sort((a, b) => a.seq - b.seq);
  if (!chunks.length) { await db.delMeta('activeRec'); return null; }
  const total = chunks.reduce((s, c) => s + c.data.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(new Uint8Array(c.data), off); off += c.data.byteLength; }
  if (!duration) duration = (chunks[chunks.length - 1].t || 0) / 1000;
  const blob = await store.createBlob({ noteId, data: buf.buffer, mime: mime.split(';')[0], name: 'audio' });
  const d = new Date(startedAt);
  const rec = await store.save('recording', {
    id: recId, noteId, blobId: blob.id, startedAt, duration, mime: blob.mime, deleted: false, transcript,
    title: 'Gravação ' + d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  });
  await db.delRange('chunks', IDBKeyRange.bound([recId, -Infinity], [recId, Infinity]));
  await db.delMeta('activeRec');
  await db.delMeta('activeRecTranscript');
  return rec;
}

// Ao abrir o app: recupera gravação interrompida (app fechado, bateria, etc.)
export async function recoverRecordings() {
  const meta = await db.getMeta('activeRec');
  if (!meta) return 0;
  const exists = await db.get('recordings', meta.id);
  if (exists) { await db.delMeta('activeRec'); return 0; }
  const tr = await db.getMeta('activeRecTranscript');
  const r = await finalize(meta.id, meta.noteId, meta.startedAt, meta.mime, 0, tr?.id === meta.id ? tr.segs : []);
  return r ? 1 : 0;
}

// Se o app sair da tela, o iPad corta o microfone: encerramos e salvamos
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && active) {
    try { active.mr.requestData(); } catch { }
    stopRecording().then(r => { if (r) audioBus.emit('interrupted'); });
  }
});
