// Instrumentos del panel de Pilotar, sin ROS: cada uno crea su nodo y se actualiza con set().
// SVG con viewBox para que escalen con el widget; los ids internos llevan un número por instancia.
import { REDUCED } from './ui.js';
import { Series, fmt, headingLabel, wrap360 } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';
let uid = 0;

// ---------- funciones puras (con tests) ----------

// marcas de la cinta cada 0,2 m entre depth ± half (nunca por encima de la superficie)
export function tapeTicks(depth, half) {
  const out = [];
  for (let k = Math.max(0, Math.ceil((depth - half) * 5 - 1e-9)); k <= Math.floor((depth + half) * 5 + 1e-9); k++) {
    out.push({ m: k / 5, major: k % 5 === 0 });
  }
  return out;
}

// puntos [t, v] -> path SVG de w × h; invert pone los valores grandes abajo (profundidad)
export function sparkPath(points, w, h, invert = false) {
  if (!points.length) return '';
  const ts = points.map((p) => p[0]), vs = points.map((p) => p[1]);
  const t0 = Math.min(...ts), t1 = Math.max(...ts), v0 = Math.min(...vs), v1 = Math.max(...vs);
  const x = (t) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * w : 0);
  const y = (v) => {
    if (v1 === v0) return h / 2;
    const f = (v - v0) / (v1 - v0);
    return invert ? f * h : (1 - f) * h;
  };
  const r = (n) => Math.round(n * 100) / 100;
  return points.map((p, i) => `${i ? 'L' : 'M'}${r(x(p[0]))} ${r(y(p[1]))}`).join('');
}

// horizonte (dibujado alrededor del origen): gira al revés que el alabeo y baja con el morro
// arriba; cabeceo limitado a ±30°
export function attitudeTransform(pitchDeg, rollDeg, pxPerDeg) {
  const p = Math.max(-30, Math.min(30, pitchDeg));
  return `rotate(${rollDeg ? -rollDeg : 0}) translate(0 ${p * pxPerDeg})`;
}

// ---------- rosa de los vientos (muelle amortiguado como la de Pilotar) ----------
export function rose() {
  const el = document.createElementNS(SVGNS, 'svg');
  el.setAttribute('viewBox', '0 0 240 240');
  el.setAttribute('class', 'di-rose');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Rumbo');
  let ticks = '';
  for (let a = 0; a < 360; a += 10) ticks += `<line x1="120" x2="120" y1="12" y2="${a % 30 ? 19 : 26}" transform="rotate(${a} 120 120)"/>`;
  el.innerHTML = `<circle cx="120" cy="120" r="112" class="di-dial"/>
    <g class="di-card"><g class="di-ticks">${ticks}</g>
      <text x="120" y="48" class="di-n">N</text><text x="196" y="128">E</text><text x="120" y="208">S</text><text x="44" y="128">O</text></g>
    <path d="M120 2 l10 18 h-20z" class="di-lubber"/>
    <text x="120" y="132" class="di-big">—</text><text x="120" y="160" class="di-sub"></text>`;
  const card = el.querySelector('.di-card'), big = el.querySelector('.di-big'), sub = el.querySelector('.di-sub');
  let head = null, target = null, v = 0, last = 0, raf = 0;
  const step = (now) => {
    raf = 0;
    if (target === null) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    const err = ((target - head + 540) % 360) - 180;
    if (REDUCED || Math.abs(err) < 0.05 && Math.abs(v) < 0.05) { head = target; v = 0; } else { v += (err * 30 - v * 6) * dt; head += v * dt; }
    card.setAttribute('transform', `rotate(${-head} 120 120)`);
    big.textContent = `${String(Math.round(wrap360(head))).padStart(3, '0')}°`;
    sub.textContent = headingLabel(head);
    if (head !== target) raf = requestAnimationFrame(step);
  };
  return {
    el,
    set(deg) {
      if (deg === null) { target = null; big.textContent = '—'; sub.textContent = ''; return; }
      target = wrap360(deg);
      if (head === null) head = target;
      if (!raf) { last = 0; raf = requestAnimationFrame(step); }
    },
    destroy() { cancelAnimationFrame(raf); },
  };
}

// ---------- horizonte artificial ----------
export function horizon() {
  const id = `diClip${++uid}`;
  const el = document.createElementNS(SVGNS, 'svg');
  el.setAttribute('viewBox', '0 0 240 240');
  el.setAttribute('class', 'di-horizon');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Horizonte artificial');
  let ladder = '';
  for (const p of [-20, -10, 10, 20]) {
    const y = -p * 3, w = Math.abs(p) === 20 ? 36 : 22;
    ladder += `<line x1="${-w}" x2="${w}" y1="${y}" y2="${y}"/><text x="${w + 6}" y="${y + 4}">${Math.abs(p)}</text>`;
  }
  el.innerHTML = `<defs><clipPath id="${id}"><circle cx="120" cy="120" r="108"/></clipPath></defs>
    <g clip-path="url(#${id})"><g transform="translate(120 120)">
      <g class="di-rot"><rect x="-320" y="-520" width="640" height="520" class="di-sky"/><rect x="-320" y="0" width="640" height="520" class="di-ground"/>
      <line x1="-320" x2="320" y1="0" y2="0" class="di-line"/><g class="di-ladder">${ladder}</g></g></g></g>
    <circle cx="120" cy="120" r="108" class="di-bezel"/>
    <path d="M70 120 h32 l8 10 l8 -10 h32" class="di-plane"/><circle cx="120" cy="120" r="3" class="di-dot"/>`;
  const rot = el.querySelector('.di-rot');
  return {
    el,
    set(a) {
      if (!a) { rot.removeAttribute('transform'); return; }
      rot.setAttribute('transform', attitudeTransform(a.pitchDeg, a.rollDeg, 3));
    },
    destroy() {},
  };
}

// ---------- cinta de profundidad (como la regla de la cámara de Pilotar) ----------
export function depthTape() {
  const el = document.createElement('div');
  el.className = 'di-tape';
  el.innerHTML = '<div class="di-scale"></div><div class="di-now"><b>—</b></div><div class="di-alt"></div>';
  const scale = el.querySelector('.di-scale'), now = el.querySelector('.di-now'), alt = el.querySelector('.di-alt');
  return {
    el,
    set(s) {
      if (!s || s.depth === null || s.depth === undefined) { scale.innerHTML = ''; now.firstChild.textContent = 'sin datos'; alt.textContent = ''; return; }
      const h = el.clientHeight || 300, pxPerM = Math.max(60, h / 4), half = h / 2 / pxPerM;
      let html = '';
      for (const t of tapeTicks(s.depth, half + 0.4)) {
        html += `<div class="di-tick ${t.major ? 'major' : ''}" style="top:${h / 2 + (t.m - s.depth) * pxPerM}px"><i></i>${t.major ? `<span>${t.m}</span>` : ''}</div>`;
      }
      if (Number.isFinite(s.target)) html += `<div class="di-target" style="top:${h / 2 + (s.target - s.depth) * pxPerM}px" title="Consigna"></div>`;
      scale.innerHTML = html;
      now.firstChild.textContent = `${fmt(s.depth, 2)} m`;
      now.classList.toggle('limit', !!(s.maxDepth && s.depth > s.maxDepth));
      alt.textContent = s.altitude > 0 ? `${fmt(s.altitude, 2)} m al fondo` : '';
    },
    destroy() {},
  };
}

// ---------- celdas de batería ----------
export function cells(n = 10) {
  const el = document.createElement('div');
  el.className = 'di-cells';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<i></i>'.repeat(n);
  return {
    el,
    set(pct) {
      const on = pct === null || pct === undefined ? 0 : Math.ceil((pct / 100) * n);
      const lvl = pct === null || pct === undefined ? '' : pct < 20 ? 'err' : pct < 40 ? 'warn' : 'ok';
      [...el.children].forEach((c, i) => { c.className = i < on ? lvl : ''; });
    },
    destroy() {},
  };
}

// ---------- mini-gráfica del último minuto ----------
export function spark(windowMs = 60000, invert = false) {
  const el = document.createElementNS(SVGNS, 'svg');
  el.setAttribute('viewBox', '0 0 100 30');
  el.setAttribute('preserveAspectRatio', 'none');
  el.setAttribute('class', 'di-spark');
  el.innerHTML = '<path class="di-fill"/><path class="di-stroke"/>';
  const [fill, stroke] = el.querySelectorAll('path');
  const s = new Series(windowMs);
  return {
    el,
    push(t, v) { if (Number.isFinite(v)) s.push(t, v); },
    draw() {
      const pts = s.data;     // Series de util.js: [[t, v]] del último minuto
      const d = sparkPath(pts, 100, 28, invert);
      stroke.setAttribute('d', d);
      fill.setAttribute('d', d ? `${d}L100 30L0 30Z` : '');
      return pts.length ? pts[pts.length - 1][1] : null;
    },
    clear() { s.data = []; },
    destroy() {},
  };
}
