// Repetição espaçada com FSRS-5 (o mesmo algoritmo moderno usado pelo Anki)

const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5, FACTOR = 19 / 81;
export const DAY = 86400000, MIN = 60000;
const ROLLOVER_H = 4; // o "dia de estudo" vira às 4h da manhã

export const STATE = { NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 };
export const DEFAULT_OPTS = { newPerDay: 20, revPerDay: 200, retention: 0.9, learnSteps: [1, 10], relearnSteps: [10], maxIvl: 36500, newOrder: 'added', ttsLang: 'pt-BR' };

const clampD = d => Math.min(10, Math.max(1, d));
const initS = g => Math.max(W[g - 1], 0.1);
const initD = g => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
const nextD = (d, g) => clampD(W[7] * initD(4) + (1 - W[7]) * (d + (-W[6] * (g - 3)) * (10 - d) / 9));
const shortS = (s, g) => Math.max(0.1, s * Math.exp(W[17] * (g - 3 + W[18])));
export const retrievability = (t, s) => Math.pow(1 + FACTOR * t / s, DECAY);
const recallS = (d, s, r, g) => s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1));
const forgetS = (d, s, r) => Math.max(0.1, Math.min(W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]), s / Math.exp(W[17] * W[18])));

export function intervalDays(s, retention = 0.9, max = 36500) {
  const i = s / FACTOR * (Math.pow(retention, 1 / DECAY) - 1);
  return Math.min(max, Math.max(1, Math.round(i)));
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}
// pequena variação para as revisões não se acumularem no mesmo dia (determinística: o botão mostra o valor real)
function fuzz(ivl, seed) {
  if (ivl < 3) return ivl;
  const delta = Math.max(1, Math.round(ivl * 0.05));
  return Math.max(2, ivl + Math.round((seed - 0.5) * 2 * delta));
}

// Início (4h) do dia de estudo que contém ts
export function dayStart(ts) {
  const x = new Date(ts - ROLLOVER_H * 3600e3);
  x.setHours(ROLLOVER_H, 0, 0, 0);
  return x.getTime();
}
export const nextDayStart = ts => { const x = new Date(dayStart(ts)); x.setDate(x.getDate() + 1); return x.getTime(); };
export function dayKey(ts) {
  const x = new Date(ts - ROLLOVER_H * 3600e3);
  return x.getFullYear() * 10000 + (x.getMonth() + 1) * 100 + x.getDate();
}
function reviewDue(now, ivl) {
  const x = new Date(dayStart(now));
  x.setDate(x.getDate() + ivl);
  return x.getTime();
}

// Calcula o novo estado da carta para a nota g (1 Errei, 2 Difícil, 3 Bom, 4 Fácil)
export function schedule(c, g, now, o = DEFAULT_OPTS) {
  const learn = o.learnSteps?.length ? o.learnSteps : [1];
  const relearn = o.relearnSteps || [];
  const ret = o.retention || 0.9, max = o.maxIvl || 36500;
  const state = c.state || 0, step = c.step || 0, s = c.s || 0, d = c.d || 0;
  const seed = hash(c.id + ':' + (c.reps || 0));
  const n = { ...c, reps: (c.reps || 0) + 1, last: now };
  const graduate = S => { const ivl = fuzz(intervalDays(S, ret, max), seed); Object.assign(n, { state: STATE.REVIEW, step: 0, ivl, due: reviewDue(now, ivl) }); };

  if (state === STATE.NEW) {
    n.s = initS(g); n.d = initD(g);
    if (g === 1) Object.assign(n, { state: STATE.LEARNING, step: 0, due: now + learn[0] * MIN });
    else if (g === 2) Object.assign(n, { state: STATE.LEARNING, step: 0, due: now + (learn.length > 1 ? (learn[0] + learn[1]) / 2 : learn[0] * 1.5) * MIN });
    else if (g === 3 && learn.length > 1) Object.assign(n, { state: STATE.LEARNING, step: 1, due: now + learn[1] * MIN });
    else graduate(n.s);
  } else if (state === STATE.LEARNING || state === STATE.RELEARNING) {
    const steps = state === STATE.LEARNING ? learn : (relearn.length ? relearn : [10]);
    n.s = shortS(s, g); n.d = nextD(d, g);
    if (g === 1) Object.assign(n, { step: 0, due: now + steps[0] * MIN });
    else if (g === 2) Object.assign(n, { due: now + (step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[Math.min(step, steps.length - 1)]) * MIN });
    else if (g === 3) {
      if (step + 1 >= steps.length) graduate(n.s);
      else Object.assign(n, { step: step + 1, due: now + steps[step + 1] * MIN });
    } else graduate(n.s);
  } else {
    const t = Math.max(0, (now - (c.last || now)) / DAY);
    const r = retrievability(t, Math.max(s, 0.1));
    n.d = nextD(d, g);
    if (g === 1) {
      n.s = forgetS(d, s, r);
      n.lapses = (c.lapses || 0) + 1;
      if (relearn.length) Object.assign(n, { state: STATE.RELEARNING, step: 0, due: now + relearn[0] * MIN });
      else graduate(n.s);
    } else {
      const sh = recallS(d, s, r, 2), sg = recallS(d, s, r, 3), se = recallS(d, s, r, 4);
      let ih = intervalDays(sh, ret, max), ig = intervalDays(sg, ret, max), ie = intervalDays(se, ret, max);
      ih = Math.min(ih, ig); ig = Math.max(ig, ih + 1); ie = Math.max(ie, ig + 1);
      const base = g === 2 ? ih : g === 3 ? ig : ie;
      const ivl = Math.min(max, fuzz(base, seed));
      n.s = g === 2 ? sh : g === 3 ? sg : se;
      Object.assign(n, { state: STATE.REVIEW, step: 0, ivl, due: reviewDue(now, ivl) });
    }
  }
  return n;
}

export function formatWait(ms) {
  const m = ms / MIN;
  if (m < 1) return '<1 min';
  if (m < 60) return Math.round(m) + ' min';
  const h = m / 60;
  if (h < 20) return Math.round(h) + ' h';
  const dd = Math.round(ms / DAY);
  if (dd < 31) return dd + (dd === 1 ? ' dia' : ' dias');
  if (dd < 365) return (dd / 30).toFixed(dd < 300 ? 1 : 0).replace('.0', '').replace('.', ',') + ' meses';
  return (dd / 365).toFixed(1).replace('.0', '').replace('.', ',') + ' anos';
}

// Texto dos 4 botões (quanto tempo até a próxima revisão)
export function previews(c, now, o) {
  return [1, 2, 3, 4].map(g => {
    const n = schedule(c, g, now, o);
    return n.state === STATE.REVIEW ? formatWait(n.due - dayStart(now)) : formatWait(n.due - now);
  });
}
