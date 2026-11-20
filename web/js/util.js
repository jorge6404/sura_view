// Utilidades sin DOM (probadas con node --test).

// Ley de Postel: «4,2», «4.2», «4,2 m», « -3 » -> número; lo demás -> null
export function parseNum(v) {
  const m = String(v ?? '').trim().replace(',', '.').match(/^[-+]?\d*\.?\d+/);
  return m ? parseFloat(m[0]) : null;
}

export function fmt(n, d = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(d).replace('.', ',').replace(/^-(0,?0*)$/, '$1');
}

// «Blue ROV 2» -> «blue_rov_2». Vacío si no queda ninguna letra.
export function normalizeName(v) {
  const s = String(v ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(s) ? s : '';
}

// Acepta «192.168.2.2», «ws://bluerov.local:9090/», «host:9090» -> «host[:puerto]» o ''
export function normalizeAddress(v) {
  const s = String(v ?? '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  return /^[\w.-]+(:\d{2,5})?$/.test(s) && s.length > 2 ? s : '';
}

export function yawFromQuaternion({ x = 0, y = 0, z = 0, w = 1 }) {
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;
export const wrap360 = (d) => ((d % 360) + 360) % 360;

export function headingLabel(d) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(wrap360(d) / 45) % 8];
}

// Antigüedad de un dato: fresco si llegó hace menos de `maxAgeMs`
export function fresh(stampMs, now = Date.now(), maxAgeMs = 2000) {
  return stampMs !== null && stampMs !== undefined && now - stampMs < maxAgeMs;
}

// sensor_msgs/BatteryState: percentage viene en 0..1 (o NaN). Devuelve 0..100 o null
export function batteryPercent(msg) {
  if (!msg) return null;
  let p = msg.percentage;
  if (p === null || p === undefined || Number.isNaN(p)) return null;
  if (p <= 1.0001) p *= 100;
  return Math.max(0, Math.min(100, p));
}

// Ring buffer de muestras [t, v] para las gráficas
export class Series {
  constructor(spanMs = 600000, max = 3000) {
    this.spanMs = spanMs;
    this.max = max;
    this.data = [];
  }

  push(t, v) {
    if (!Number.isFinite(v)) return;
    this.data.push([t, v]);
    const cut = t - this.spanMs;
    while (this.data.length && (this.data[0][0] < cut || this.data.length > this.max)) this.data.shift();
  }

  range() {
    if (!this.data.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const [, v] of this.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    return [lo, hi];
  }
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
