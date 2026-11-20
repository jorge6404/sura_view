// Datos de la pestaña «Gráficas» (como PlotJuggler), sin DOM: campos de un mensaje,
// buscador, series con recorte por tiempo y la disposición de paneles.

const NUMERIC = new Set(['float32', 'float64', 'double', 'float', 'int8', 'uint8', 'int16', 'uint16',
  'int32', 'uint32', 'int64', 'uint64', 'byte', 'char', 'bool', 'boolean', 'octet']);
const FIXED_MAX = 64;    // arrays fijos: índices que se listan como mucho
const DYN_MAX = 64;      // arrays variables: elementos que se toman de un mensaje de muestra
// Topics enormes: no se pide muestra (el campo `data` son megas)
export const NO_SAMPLE = /\/(Image|CompressedImage|PointCloud2|PointCloud|OccupancyGrid)$/;

export const isNumericType = (t) => NUMERIC.has(t);
export const key = (topic, path) => `${topic}|${path}`;
export function splitKey(k) { const i = k.indexOf('|'); return { topic: k.slice(0, i), path: k.slice(i + 1) }; }

// rosapi /message_details: fieldarraylen -1 = no es array, 0 = variable, n = fijo.
// Devuelve { fields: [ruta], dynamic: [ruta del array variable] }.
export function fieldsFromTypedefs(typedefs, rootType) {
  const byType = new Map(typedefs.map((d) => [norm(d.type), d]));
  const fields = [], dynamic = [];
  const walk = (type, prefix, depth) => {
    const d = byType.get(norm(type));
    if (!d || depth > 12) return;
    d.fieldnames.forEach((name, i) => {
      const ft = d.fieldtypes[i], len = d.fieldarraylen[i], p = prefix ? `${prefix}/${name}` : name;
      if (ft === 'string') return;
      if (len === 0) { if (!(ft === 'uint8' || ft === 'int8' || ft === 'char' || ft === 'byte')) dynamic.push(p); return; }
      const idx = len > 0 ? Array.from({ length: Math.min(len, FIXED_MAX) }, (_, j) => `${p}[${j}]`) : [p];
      for (const q of idx) { if (isNumericType(ft)) fields.push(q); else walk(ft, q, depth + 1); }
    });
  };
  walk(rootType, '', 0);
  return { fields, dynamic };
}
const norm = (t) => t.replace('/msg/', '/');

// Todas las rutas numéricas de un mensaje real (para los arrays variables).
export function flattenMsg(msg, prefix = '', out = []) {
  if (msg === null || msg === undefined) return out;
  if (typeof msg === 'number' || typeof msg === 'boolean') { out.push(prefix); return out; }
  if (Array.isArray(msg)) {
    msg.slice(0, DYN_MAX).forEach((v, i) => flattenMsg(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof msg === 'object') for (const [k, v] of Object.entries(msg)) flattenMsg(v, prefix ? `${prefix}/${k}` : k, out);
  return out;
}

// «pose/position/z», «ranges[3]» -> función que lo lee del mensaje (número o null)
const getterCache = new Map();
export function getter(path) {
  let g = getterCache.get(path);
  if (g) return g;
  const steps = [];
  for (const seg of path.split('/')) {
    const m = seg.match(/^([^[]*)((?:\[\d+\])*)$/);
    if (m[1]) steps.push(m[1]);
    for (const ix of m[2].matchAll(/\[(\d+)\]/g)) steps.push(+ix[1]);
  }
  g = (msg) => {
    let v = msg;
    for (const s of steps) { if (v === null || v === undefined) return null; v = v[s]; }
    if (typeof v === 'boolean') return v ? 1 : 0;
    return typeof v === 'number' ? v : null;
  };
  getterCache.set(path, g);
  return g;
}

// Buscador: trozos separados por espacios, en orden y sin mayúsculas («nav pos z»).
export function matches(text, query) {
  const toks = query.toLowerCase().split(/\s+/).filter(Boolean);
  const t = text.toLowerCase();
  let from = 0;
  for (const tok of toks) {
    const i = t.indexOf(tok, from);
    if (i < 0) return false;
    from = i + tok.length;
  }
  return true;
}

// Serie con tiempos crecientes; lo más viejo que maxAge se descarta.
export class Series {
  constructor(maxAge = 600) { this.t = []; this.v = []; this.start = 0; this.maxAge = maxAge; }
  get length() { return this.t.length - this.start; }
  push(t, v) {
    this.t.push(t); this.v.push(v);
    const lim = t - this.maxAge;
    if (this.t[this.start] < lim) {
      this.start = lowerBound(this.t, lim, this.start);
      if (this.start > 4096 && this.start > this.t.length / 2) {
        this.t = this.t.slice(this.start); this.v = this.v.slice(this.start); this.start = 0;
      }
    }
  }
  // índice del primer punto con t >= x (desde start)
  indexAt(x) { return lowerBound(this.t, x, this.start); }
  // último valor con t <= x, o null
  valueAt(x) {
    const i = upperBound(this.t, x, this.start) - 1;
    return i >= this.start ? this.v[i] : null;
  }
  last() { return this.length ? this.v[this.t.length - 1] : null; }
  clear() { this.t = []; this.v = []; this.start = 0; }
}
export function lowerBound(a, x, lo = 0) {
  let hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
function upperBound(a, x, lo = 0) {
  let hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

// ---------- disposición: árbol de paneles ----------
// hoja: { id, curves: [{ key, type, hidden }], xy: null | { x: key, xType } }
// partición: { id, dir: 'row' | 'col', ratio, a, b }
let nid = 0;
export const newLeaf = () => ({ id: `p${Date.now().toString(36)}${(nid++).toString(36)}`, curves: [], xy: null });

export function findLeaf(node, id) {
  if (!node) return null;
  if (node.id === id && !node.dir) return node;
  return node.dir ? findLeaf(node.a, id) || findLeaf(node.b, id) : null;
}
export function leaves(node, out = []) {
  if (!node) return out;
  if (node.dir) { leaves(node.a, out); leaves(node.b, out); } else out.push(node);
  return out;
}
// side: 'left' | 'right' | 'top' | 'bottom'. Devuelve la raíz nueva.
export function split(node, id, side, leaf) {
  if (!node.dir) {
    if (node.id !== id) return node;
    const dir = side === 'left' || side === 'right' ? 'row' : 'col';
    const first = side === 'left' || side === 'top';
    return { id: `s${Date.now().toString(36)}${(nid++).toString(36)}`, dir, ratio: 0.5, a: first ? leaf : node, b: first ? node : leaf };
  }
  return { ...node, a: split(node.a, id, side, leaf), b: split(node.b, id, side, leaf) };
}
// Quita un panel; si era el único queda uno vacío.
export function remove(node, id) {
  if (!node.dir) return node.id === id ? newLeaf() : node;
  if (!node.a.dir && node.a.id === id) return node.b;
  if (!node.b.dir && node.b.id === id) return node.a;
  return { ...node, a: remove(node.a, id), b: remove(node.b, id) };
}
export function allKeys(tabs) {
  const out = new Map();
  for (const tab of tabs) for (const l of leaves(tab.root)) {
    for (const c of l.curves) out.set(c.key, c.type);
    if (l.xy) out.set(l.xy.x, l.xy.xType);
  }
  return out;
}

export function serializeLayout(state) {
  return JSON.stringify({ version: 1, window: state.window, tabs: state.tabs }, null, 1);
}
export function parseLayout(text) {
  const o = JSON.parse(text);
  if (!o || !Array.isArray(o.tabs) || !o.tabs.length) throw new Error('No es una disposición de gráficas de sura_view');
  const fixNode = (n) => {
    if (n?.dir) return { id: n.id || newLeaf().id, dir: n.dir === 'col' ? 'col' : 'row', ratio: +n.ratio || 0.5, a: fixNode(n.a), b: fixNode(n.b) };
    return { id: n?.id || newLeaf().id, xy: n?.xy?.x ? { x: String(n.xy.x), xType: String(n.xy.xType || '') } : null,
      curves: (n?.curves || []).filter((c) => typeof c.key === 'string' && c.key.includes('|'))
        .map((c) => ({ key: c.key, type: String(c.type || ''), hidden: !!c.hidden })) };
  };
  return { window: +o.window > 0 ? +o.window : 10, tabs: o.tabs.map((t, i) => ({ name: String(t.name || `Pestaña ${i + 1}`), root: fixNode(t.root) })) };
}

// CSV ancho: una columna de tiempo y una por serie; celdas vacías donde una serie no tiene muestra.
export function toCsv(named) {
  const all = [];
  named.forEach(({ series }, j) => { for (let i = series.start; i < series.t.length; i++) all.push([series.t[i], j, series.v[i]]); });
  all.sort((p, q) => p[0] - q[0]);
  const lines = [['t', ...named.map((n) => n.name)].map(csvCell).join(',')];
  let row = null, rt = null;
  for (const [t, j, v] of all) {
    if (t !== rt) { if (row) lines.push(row.join(',')); row = [t.toFixed(4), ...named.map(() => '')]; rt = t; }
    row[j + 1] = String(v);
  }
  if (row) lines.push(row.join(','));
  return `${lines.join('\n')}\n`;
}
const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
