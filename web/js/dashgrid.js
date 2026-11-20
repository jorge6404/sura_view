// Cuadrícula del panel de Pilotar, sin DOM: 12 columnas, elementos { id, type, x, y, w, h, settings }
// en celdas. Todo devuelve listas nuevas (nunca muta la entrada) y nunca deja solapes: lo que
// choca baja y después todo sube lo que puede (como Grafana).

export const COLS = 12;

const int = (v, lo, hi = Infinity) => Math.max(lo, Math.min(hi, Math.round(v)));
const byYX = (a, b) => a.y - b.y || a.x - b.x;

export function collides(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// dentro de las 12 columnas y no más pequeño que el mínimo del widget
export function clamp(item, def = {}) {
  const w = int(item.w, Math.min(def.minW ?? 1, COLS), COLS);
  return { ...item, w, h: int(item.h, def.minH ?? 1), x: int(item.x, 0, COLS - w), y: int(item.y, 0) };
}

export function bottom(layout) {
  return layout.reduce((m, i) => Math.max(m, i.y + i.h), 0);
}

// la primera fila (desde arriba) en la que `item` cabe sin chocar con `placed`; al chocar salta
// al pie de lo que estorba (no fila a fila)
function lowestFree(item, placed) {
  let y = 0;
  for (;;) {
    const c = { ...item, y };
    const hit = placed.filter((p) => collides(c, p));
    if (!hit.length) return y;
    y = Math.max(...hit.map((p) => p.y + p.h));
  }
}

// cada elemento, por orden de arriba abajo, sube a la primera fila libre
export function compact(layout) {
  const placed = [];
  const out = new Map();
  for (const i of [...layout].sort(byYX)) {
    const c = { ...i, y: lowestFree(i, placed) };
    placed.push(c);
    out.set(i.id, c);
  }
  return layout.map((i) => out.get(i.id));
}

// `active` se queda donde se pidió; los demás se recolocan alrededor y luego se compacta todo
function settle(layout, active) {
  const placed = [active];
  const out = new Map([[active.id, active]]);
  for (const i of layout.filter((x) => x.id !== active.id).sort(byYX)) {
    const c = { ...i, y: lowestFree(i, placed) };
    placed.push(c);
    out.set(i.id, c);
  }
  return compact(layout.map((i) => out.get(i.id)));
}

export function move(layout, id, x, y) {
  const cur = layout.find((i) => i.id === id);
  if (!cur) return layout;
  return settle(layout, clamp({ ...cur, x, y }));
}

export function resize(layout, id, w, h, def) {
  const cur = layout.find((i) => i.id === id);
  if (!cur) return layout;
  return settle(layout, clamp({ ...cur, w, h }, def));
}

// sin x/y: en el primer hueco de arriba abajo y de izquierda a derecha; con x/y: ahí, empujando
export function add(layout, item, def) {
  if (Number.isFinite(item.x) && Number.isFinite(item.y)) {
    const c = clamp(item, def);
    return settle([...layout, c], c);
  }
  const c = clamp({ ...item, x: 0, y: 0 }, def);
  for (let y = 0; ; y++) {
    for (let x = 0; x + c.w <= COLS; x++) {
      const t = { ...c, x, y };
      if (!layout.some((p) => collides(t, p))) return [...layout, t];
    }
  }
}

export function remove(layout, id) {
  return compact(layout.filter((i) => i.id !== id));
}

// pantallas estrechas: una sola columna en el orden de lectura (no se guarda)
export function stack(layout) {
  let y = 0;
  return [...layout].sort(byYX).map((i) => {
    const c = { ...i, x: 0, w: COLS, y };
    y += i.h;
    return c;
  });
}

const MAX_H = 48, MAX_Y = 500;   // más que esto no es un panel, es un fichero roto

// clave propia de un objeto (no «constructor», «toString»… heredados)
export const ownKey = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

// lo que llega de localStorage o de un JSON importado: se queda lo que tiene sentido.
// defOf(type) da los mínimos de cada widget ({ minW, minH })
export function sanitize(raw, knownTypes, defOf = () => ({})) {
  if (!Array.isArray(raw)) return { layout: [], dropped: 0 };
  const ids = new Set();
  const layout = [];
  let dropped = 0;
  for (const r of raw) {
    const ok = r && typeof r === 'object' && knownTypes.has(r.type)
      && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k]))
      && r.w >= 1 && r.h >= 1 && r.h <= MAX_H && r.y >= 0 && r.y <= MAX_Y;
    if (!ok) { dropped++; continue; }
    let id = typeof r.id === 'string' && r.id ? r.id : r.type;
    for (let n = 2; ids.has(id); n++) id = `${r.type}-${n}`;
    ids.add(id);
    const settings = r.settings && typeof r.settings === 'object' && !Array.isArray(r.settings) ? { ...r.settings } : undefined;
    layout.push(clamp({ id, type: r.type, x: r.x, y: r.y, w: r.w, h: r.h, ...(settings && { settings }) }, defOf(r.type)));
  }
  return { layout: compact(layout), dropped };
}

// un fichero exportado ({ format, version, name, items }) o una lista suelta (formato antiguo)
export function readPanelFile(data, knownTypes, defOf) {
  if (Array.isArray(data)) return { ...sanitize(data, knownTypes, defOf), name: '', warn: '' };
  if (data?.format !== 'sura_view.panel') return { layout: [], dropped: 0, name: '', warn: 'Ese fichero no es un panel de sura_view' };
  const warn = data.version === 1 ? '' : `El panel es de la versión ${data.version} y esta web es de la 1: revisa que esté bien`;
  return { ...sanitize(data.items, knownTypes, defOf), name: typeof data.name === 'string' ? data.name.trim() : '', warn };
}

// id nuevo para un widget de `type` que no choque con los del panel
export function newId(layout, type) {
  const ids = new Set(layout.map((i) => i.id));
  if (!ids.has(type)) return type;
  let n = 2;
  while (ids.has(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}
