// Reconhecimento de formas: desenhe e segure a caneta parada.
// Linha, círculo/elipse, retângulo (reto ou inclinado) e triângulo.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

// Simplificação Ramer–Douglas–Peucker
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps);
  return l.slice(0, -1).concat(r);
}

// Junta vértices quase alinhados (ângulo interno > limite)
function mergeCollinear(poly, minAngleDeg) {
  let changed = true;
  while (changed && poly.length > 3) {
    changed = false;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[(i - 1 + poly.length) % poly.length], c = poly[i], n = poly[(i + 1) % poly.length];
      const a1 = Math.atan2(p[1] - c[1], p[0] - c[0]), a2 = Math.atan2(n[1] - c[1], n[0] - c[0]);
      let ang = Math.abs(a1 - a2) * 180 / Math.PI;
      if (ang > 180) ang = 360 - ang;
      if (ang > minAngleDeg) { poly.splice(i, 1); changed = true; break; }
    }
  }
  return poly;
}

function polyError(P, poly) {
  let s = 0;
  for (const p of P) {
    let m = Infinity;
    for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist(p, poly[i], poly[(i + 1) % poly.length]));
    s += m;
  }
  return s / P.length;
}

function densifyPoly(poly, closed, step = 6) {
  const out = [];
  const n = closed ? poly.length : poly.length - 1;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const k = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
  }
  out.push(closed ? poly[0] : poly[poly.length - 1]);
  return out;
}

export function densifyLine(a, b) { return densifyPoly([a, b], false); }

// pts: array plano [x, y, pressão, ...]. Retorna { type, points:[[x,y],...] } ou null
export function recognize(flat) {
  const n = flat.length / 3;
  if (n < 8) return null;
  const P = [];
  for (let i = 0; i < n; i++) P.push([flat[i * 3], flat[i * 3 + 1]]);
  let L = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = P[i];
    if (i) L += dist(p, P[i - 1]);
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
  if (diag < 24) return null;
  const gap = dist(P[0], P[n - 1]);
  const closed = gap < Math.max(22, diag * 0.25) && L > diag * 1.7;

  if (!closed) {
    if (gap / L > 0.9) return { type: 'line', points: [P[0], P[n - 1]] };
    return null;
  }
  const minSide = Math.min(w, h);
  if (minSide < 12) return null;

  const cands = [];
  // elipse/círculo pelo retângulo envolvente
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let rx = w / 2, ry = h / 2;
  let eErr = 0;
  for (const p of P) eErr += Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1) * Math.min(rx, ry);
  eErr /= n;
  cands.push({ type: 'ellipse', err: eErr });
  // retângulo alinhado
  let rErr = 0;
  for (const p of P) rErr += Math.min(Math.abs(p[0] - x0), Math.abs(p[0] - x1), Math.abs(p[1] - y0), Math.abs(p[1] - y1));
  rErr /= n;
  cands.push({ type: 'rect', err: rErr * 0.9 });
  // polígono (triângulo ou quadrilátero inclinado)
  let poly = rdp([...P, P[0]], diag * 0.07).slice(0, -1);
  poly = mergeCollinear(poly, 150);
  if (poly.length === 3 || poly.length === 4) cands.push({ type: poly.length === 3 ? 'triangle' : 'quad', err: polyError(P, poly), poly });

  cands.sort((a, b) => a.err - b.err);
  const best = cands[0];
  if (best.err > minSide * 0.11 + 2.5) return null;

  if (best.type === 'ellipse') {
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) rx = ry = (rx + ry) / 2; // quase círculo -> círculo
    const k = Math.max(48, Math.ceil(Math.PI * (rx + ry) / 6));
    const pts = [];
    for (let i = 0; i <= k; i++) { const t = (i / k) * Math.PI * 2 - Math.PI / 2; pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]); }
    return { type: Math.abs(rx - ry) < 0.5 ? 'circle' : 'ellipse', points: pts };
  }
  if (best.type === 'rect') return { type: 'rect', points: densifyPoly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true) };
  return { type: best.type === 'quad' ? 'rect' : 'triangle', points: densifyPoly(best.poly, true) };
}
