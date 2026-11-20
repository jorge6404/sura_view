// Pestaña «Gráficas», como PlotJuggler: árbol de topics con buscador, arrastrar campos a
// paneles que se parten, varias pestañas, zoom, cursor compartido y gráficas XY.
// Solo se grafica desde que se arrastra el campo (no hay historial previo).

import {
  NO_SAMPLE, Series, allKeys, fieldsFromTypedefs, findLeaf, flattenMsg, getter, key, leaves, matches,
  newLeaf, parseLayout, remove, serializeLayout, split, splitKey, toCsv,
} from './plotdata.js';
import { $, errMsg, icons, toast } from './ui.js';
import { esc } from './util.js';

// Ocho colores que se distinguen sobre grafito y sobre blanco; el rojo queda para peligro.
const COLORS = ['#4fa8e0', '#e8a33d', '#5cb85c', '#d36fb0', '#9b8ae6', '#e8d031', '#3fb8a8', '#c98a5a'];
const STORE = 'sura_view.plots';
const M = { l: 56, r: 10, t: 8, b: 22 };   // márgenes del área de dibujo (px CSS)
const EDGE = 0.2;                           // franja del borde que parte el panel
const MAX_DRAG = 16;                        // campos como mucho al arrastrar un topic entero

export class PlotView {
  constructor(sura) {
    this.sura = sura;
    this.ros = sura.ros;
    this.el = $('#v-plots');
    this.topics = [];                 // [{ name, type }]
    this.typeFields = new Map();      // tipo -> { fields, dynamic }
    this.sampled = new Map();         // topic -> rutas sacadas de un mensaje real
    this.open = new Set();            // nodos desplegados del árbol
    this.series = new Map();          // clave -> Series
    this.subs = new Map();            // topic -> { unsub, keys: Map(clave -> getter) }
    this.maxAge = 600;
    this.t0 = Date.now() / 1000;
    this.view = { follow: true, xmin: 0, xmax: 10, cursor: null };
    this.panels = new Map();          // id de hoja -> { el, canvas, legend, yRange, xyRange }
    this.drag = null;
    this.lastDraw = 0;
    this.state = this.load();
    this.bindUi();
    this.renderTabs();
    this.rebuildGrid();
    this.syncSubs();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    sura.addEventListener('robot', () => { if (this.visible) this.refresh(); });
  }

  get tab() { return this.state.tabs[this.state.active] ?? this.state.tabs[0]; }
  get visible() { return this.el.classList.contains('on'); }
  now() { return Date.now() / 1000 - this.t0; }

  load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) { const st = parseLayout(raw); return { ...st, active: 0 }; }
    } catch { /* sin disposición guardada */ }
    return { window: 10, active: 0, tabs: [{ name: 'Pestaña 1', root: newLeaf() }] };
  }
  save() {
    try { localStorage.setItem(STORE, serializeLayout(this.state)); } catch { /* almacenamiento bloqueado */ }
  }
  changed() { this.save(); this.syncSubs(); this.rebuildGrid(); }

  // ---------------- topics y campos ----------------
  async refresh() {
    try {
      const r = await this.ros.callService('/rosapi/topics', {}, { timeoutMs: 5000 });
      this.topics = r.topics.map((name, i) => ({ name, type: r.types[i] })).sort((a, b) => a.name.localeCompare(b.name));
      $('#pjCount').textContent = `${this.topics.length} topics`;
      this.renderTree();
      // typedefs de todos los tipos, para buscar también por campo
      // todos los tipos de una vez al servidor (introspección de rosidl); lo que no tenga
      // instalado se pide a rosapi de uno en uno (a la vez se pasa del timeout o mezcla respuestas)
      let types = [...new Set(this.topics.map((t) => t.type))].filter((t) => !this.typeFields.has(t));
      try {
        const got = await this.sura.rpc('msg.fields', { types }, 10000);
        for (const [t, f] of Object.entries(got)) this.typeFields.set(t, f);
        types = types.filter((t) => !this.typeFields.has(t));
        this.renderTree();
      } catch { /* servidor viejo o caído: todo por rosapi */ }
      for (const t of types) { await this.loadType(t); this.renderTreeSoon(); }
      this.renderTree();
    } catch (e) {
      $('#pjTree').innerHTML = `<p class="pj-empty">No se pudo pedir la lista de topics a rosapi.<br>${esc(errMsg(e))}</p>`;
    }
  }

  async loadType(type) {
    if (this.typeFields.has(type)) return this.typeFields.get(type);
    try {
      const r = await this.ros.callService('/rosapi/message_details', { type }, { timeoutMs: 5000 });
      const f = fieldsFromTypedefs(r.typedefs, type);
      if (!r.typedefs.some((d) => d.type === type.replace('/msg/', '/'))) return f;   // respuesta de otro tipo
      this.typeFields.set(type, f);
      return f;
    } catch {
      return { fields: [], dynamic: [] };   // sin cachear: se reintenta al desplegar o actualizar
    }
  }

  renderTreeSoon() {
    if (this.treeTimer) return;
    this.treeTimer = setTimeout(() => { this.treeTimer = null; this.renderTree(); }, 300);
  }

  // Arrays variables: se leen de un mensaje real (un solo mensaje y fuera).
  sample(topic) {
    if (this.sampled.has(topic.name) || NO_SAMPLE.test(topic.type)) return;
    const f = this.typeFields.get(topic.type);
    if (!f?.dynamic.length) return;
    this.sampled.set(topic.name, null);
    const stop = this.ros.subscribe(topic.name, topic.type, (msg) => {
      stop(); clearTimeout(timer);
      const dyn = f.dynamic;
      this.sampled.set(topic.name, flattenMsg(msg).filter((p) => dyn.some((d) => p.startsWith(`${d}[`))));
      this.renderTree();
    }, { id: 'pj-sample', queue_length: 1 });
    const timer = setTimeout(() => { stop(); this.sampled.delete(topic.name); }, 4000);
  }

  fieldsOf(topic) {
    const f = this.typeFields.get(topic.type);
    return [...(f?.fields ?? []), ...(this.sampled.get(topic.name) ?? [])];
  }

  renderTree() {
    const q = $('#pjSearch').value.trim();
    const tree = $('#pjTree');
    if (!this.topics.length) { tree.innerHTML = '<p class="pj-empty">Sin topics. ¿Está en marcha rosbridge?</p>'; return; }
    const html = [];
    let shown = 0;
    for (const t of this.topics) {
      if (shown > 400) { html.push('<p class="pj-empty">Hay más resultados: afina la búsqueda.</p>'); break; }
      const fields = this.fieldsOf(t);
      if (q) {
        const topicHit = matches(t.name, q);
        const hits = fields.filter((p) => matches(`${t.name}/${p}`, q));
        if (!topicHit && !hits.length) continue;
        html.push(this.topicRow(t, true, fields.length));
        for (const p of (topicHit && !hits.length ? fields : hits).slice(0, 60)) { html.push(this.fieldRow(t, p, p, 1)); shown++; }
      } else {
        const open = this.open.has(t.name);
        html.push(this.topicRow(t, open, fields.length));
        if (open) html.push(this.subTree(t, fields));
      }
      shown++;
    }
    tree.innerHTML = html.join('') || '<p class="pj-empty">Nada coincide con la búsqueda.</p>';
  }

  topicRow(t, open, n) {
    const short = t.type.split('/').pop();
    return `<div class="pj-row pj-topic" role="treeitem" aria-expanded="${open}" draggable="true" data-topic="${esc(t.name)}" data-prefix="" title="${esc(t.name)} · ${esc(t.type)}">
      <i class="pj-car">${open ? '▾' : '▸'}</i><span class="pj-name">${esc(t.name)}</span><small>${esc(short)}${n ? '' : ' · sin campos'}</small></div>`;
  }

  fieldRow(t, path, label, depth) {
    const k = key(t.name, path), s = this.series.get(k);
    return `<div class="pj-row pj-field${s ? ' plotted' : ''}" role="treeitem" draggable="true" data-topic="${esc(t.name)}" data-path="${esc(path)}" style="--d:${depth}" title="${esc(t.name)}/${esc(path)}">
      <span class="pj-name">${esc(label)}</span><b class="num" data-val="${esc(k)}"></b></div>`;
  }

  // Árbol por segmentos de la ruta: «pose/position/z» -> pose ▸ position ▸ z
  subTree(t, fields) {
    const root = new Map();
    for (const p of fields) {
      let node = root;
      const segs = p.split('/');
      segs.forEach((s, i) => {
        if (i === segs.length - 1) { node.set(s, p); return; }
        if (!(node.get(s) instanceof Map)) node.set(s, new Map());
        node = node.get(s);
      });
    }
    const out = [];
    const walk = (node, prefix, depth) => {
      for (const [name, v] of node) {
        if (typeof v === 'string') { out.push(this.fieldRow(t, v, name, depth)); continue; }
        const id = `${t.name}|${prefix}${name}`;
        const open = this.open.has(id);
        out.push(`<div class="pj-row pj-group" role="treeitem" aria-expanded="${open}" draggable="true" data-topic="${esc(t.name)}" data-prefix="${esc(prefix + name)}/" data-node="${esc(id)}" style="--d:${depth}">
          <i class="pj-car">${open ? '▾' : '▸'}</i><span class="pj-name">${esc(name)}</span></div>`);
        if (open) walk(v, `${prefix}${name}/`, depth + 1);
      }
    };
    walk(root, '', 1);
    const f = this.typeFields.get(t.type);
    if (f?.dynamic.length && !this.sampled.get(t.name)) out.push(`<p class="pj-empty" style="--d:1">${NO_SAMPLE.test(t.type) ? 'Datos binarios: no se grafican' : 'Esperando un mensaje para los arrays…'}</p>`);
    if (!fields.length && !f?.dynamic.length) out.push('<p class="pj-empty" style="--d:1">Sin campos numéricos</p>');
    return out.join('');
  }

  // ---------------- datos ----------------
  syncSubs() {
    const want = allKeys(this.state.tabs);
    for (const k of [...this.series.keys()]) if (!want.has(k)) this.series.delete(k);
    const byTopic = new Map();
    for (const [k, type] of want) {
      const { topic, path } = splitKey(k);
      if (!byTopic.has(topic)) byTopic.set(topic, { type, paths: new Map() });
      byTopic.get(topic).paths.set(k, getter(path));
      if (!this.series.has(k)) this.series.set(k, new Series(this.maxAge));
    }
    for (const [topic, s] of this.subs) if (!byTopic.has(topic)) { s.unsub(); this.subs.delete(topic); }
    for (const [topic, { type, paths }] of byTopic) {
      const cur = this.subs.get(topic);
      if (cur) { cur.keys = paths; continue; }
      const entry = { keys: paths, unsub: null };
      entry.unsub = this.ros.subscribe(topic, type || this.typeOf(topic), (msg) => {
        const t = this.now();
        for (const [k, g] of entry.keys) { const v = g(msg); if (v !== null && Number.isFinite(v)) this.series.get(k)?.push(t, v); }
      }, { id: 'pj', throttle_rate: 0, queue_length: 100 });
      this.subs.set(topic, entry);
    }
  }
  typeOf(topic) { return this.topics.find((t) => t.name === topic)?.type ?? ''; }

  // ---------------- UI ----------------
  bindUi() {
    $('#pjSearch').addEventListener('input', () => this.renderTree());
    $('#pjRefresh').addEventListener('click', () => this.refresh());
    const tree = $('#pjTree');
    tree.addEventListener('click', (e) => {
      const row = e.target.closest('.pj-topic, .pj-group');
      if (!row) return;
      const id = row.dataset.node || row.dataset.topic;
      if (this.open.has(id)) this.open.delete(id); else this.open.add(id);
      if (row.classList.contains('pj-topic')) {
        const t = this.topics.find((x) => x.name === row.dataset.topic);
        if (t && !this.typeFields.has(t.type)) this.loadType(t.type).then(() => { this.sample(t); this.renderTree(); });
        else if (t) this.sample(t);
      }
      this.renderTree();
    });
    tree.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.pj-row');
      if (!row) return;
      const t = this.topics.find((x) => x.name === row.dataset.topic);
      if (!t) return;
      const paths = row.dataset.path ? [row.dataset.path]
        : this.fieldsOf(t).filter((p) => p.startsWith(row.dataset.prefix)).slice(0, MAX_DRAG);
      if (!paths.length) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/x-sura-plot', JSON.stringify({ type: t.type, keys: paths.map((p) => key(t.name, p)) }));
      e.dataTransfer.effectAllowed = 'copy';
    });

    $('#pjWin').value = this.state.window;
    $('#pjWin').addEventListener('change', () => {
      const w = parseFloat(String($('#pjWin').value).replace(',', '.'));
      if (w > 0 && w <= this.maxAge) { this.state.window = w; this.save(); this.view.follow = true; } else $('#pjWin').value = this.state.window;
      this.renderPause();
    });
    $('#pjPause').addEventListener('click', () => {
      if (this.view.follow) { this.view.follow = false; this.view.xmax = this.now(); this.view.xmin = this.view.xmax - this.state.window; } else this.live();
      this.renderPause();
    });
    $('#pjClear').addEventListener('click', () => { for (const s of this.series.values()) s.clear(); toast('Datos de las gráficas borrados', 'ok', 'eraser'); });
    $('#pjCsv').addEventListener('click', () => this.exportCsv());
    $('#pjSave').addEventListener('click', () => download('graficas_sura_view.json', serializeLayout(this.state), 'application/json'));
    $('#pjOpen').addEventListener('click', () => $('#pjFile').click());
    $('#pjFile').addEventListener('change', async () => {
      const f = $('#pjFile').files[0];
      $('#pjFile').value = '';
      if (!f) return;
      try {
        const st = parseLayout(await f.text());
        this.state = { ...st, active: 0 };
        $('#pjWin').value = st.window;
        this.renderTabs(); this.changed();
        toast(`Disposición «${f.name}» abierta`, 'ok', 'folder-open');
      } catch (e) { toast(errMsg(e), 'err'); }
    });
    $('#pjAddTab').addEventListener('click', () => {
      this.state.tabs.push({ name: `Pestaña ${this.state.tabs.length + 1}`, root: newLeaf() });
      this.state.active = this.state.tabs.length - 1;
      this.renderTabs(); this.changed();
    });
    $('#pjTabs').addEventListener('click', (e) => {
      const x = e.target.closest('[data-close]');
      if (x) { this.closeTab(+x.dataset.close); return; }
      const b = e.target.closest('[data-tab]');
      if (b) { this.state.active = +b.dataset.tab; this.renderTabs(); this.rebuildGrid(); }
    });
    $('#pjTabs').addEventListener('dblclick', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      const name = prompt('Nombre de la pestaña', this.state.tabs[+b.dataset.tab].name);
      if (name?.trim()) { this.state.tabs[+b.dataset.tab].name = name.trim(); this.save(); this.renderTabs(); }
    });
  }

  live() { this.view.follow = true; for (const p of this.panels.values()) { p.yRange = null; p.xyRange = null; } }

  renderPause() {
    const b = $('#pjPause');
    b.innerHTML = this.view.follow ? '<i data-lucide="pause"></i>Pausar' : '<i data-lucide="play"></i>Directo';
    b.setAttribute('aria-pressed', !this.view.follow);
    icons(b);
  }

  closeTab(i) {
    if (this.state.tabs.length === 1) { this.state.tabs[0] = { name: 'Pestaña 1', root: newLeaf() }; }
    else this.state.tabs.splice(i, 1);
    this.state.active = Math.min(this.state.active, this.state.tabs.length - 1);
    this.renderTabs(); this.changed();
  }

  renderTabs() {
    $('#pjTabs').innerHTML = this.state.tabs.map((t, i) => `<span class="pj-tab" aria-selected="${i === this.state.active}">
      <button data-tab="${i}" title="Doble clic para renombrar">${esc(t.name)}</button><button class="x" data-close="${i}" aria-label="Cerrar ${esc(t.name)}">✕</button></span>`).join('');
  }

  // ---------------- paneles ----------------
  rebuildGrid() {
    const grid = $('#pjGrid');
    const old = this.panels;
    this.panels = new Map();
    grid.innerHTML = '';
    grid.append(this.nodeEl(this.tab.root, old));
    this.renderPause();
  }

  nodeEl(node, old) {
    if (node.dir) {
      const el = document.createElement('div');
      el.className = `pj-split pj-dir-${node.dir}`;
      const a = this.nodeEl(node.a, old), b = this.nodeEl(node.b, old);
      a.style.flex = `${node.ratio} 1 0`; b.style.flex = `${1 - node.ratio} 1 0`;
      const h = document.createElement('div');
      h.className = 'pj-handle';
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        const r = el.getBoundingClientRect();
        const move = (ev) => {
          const f = node.dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
          node.ratio = Math.min(0.9, Math.max(0.1, f));
          a.style.flex = `${node.ratio} 1 0`; b.style.flex = `${1 - node.ratio} 1 0`;
        };
        const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); this.save(); };
        h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
      });
      el.append(a, h, b);
      return el;
    }
    const prev = old.get(node.id);
    const el = document.createElement('div');
    el.className = 'pj-panel';
    el.innerHTML = `<canvas></canvas><div class="pj-legend"></div><div class="pj-drop"></div>
      <button class="pj-close" title="Quitar gráfica" aria-label="Quitar gráfica">✕</button>
      <p class="pj-hint-empty">Arrastra aquí un campo de la izquierda</p>`;
    const p = { leaf: node, el, canvas: el.querySelector('canvas'), legend: el.querySelector('.pj-legend'),
      yRange: prev?.yRange ?? null, xyRange: prev?.xyRange ?? null, vals: [] };
    this.panels.set(node.id, p);
    this.renderLegend(p);
    el.querySelector('.pj-close').addEventListener('click', () => { this.tab.root = remove(this.tab.root, node.id); this.changed(); });
    this.bindDrop(p);
    this.bindMouse(p);
    return el;
  }

  renderLegend(p) {
    const l = p.leaf;
    p.el.classList.toggle('empty', !l.curves.length);
    p.el.classList.toggle('xy', !!l.xy);
    const xy = l.xy ? `<div class="pj-li xyx" title="${esc(l.xy.x)}"><span>X:</span><span class="pj-n">${esc(label(l.xy.x))}</span><b class="num"></b><button data-x="1" aria-label="Volver a tiempo">✕</button></div>` : '';
    p.legend.innerHTML = xy + l.curves.map((c, i) => `<div class="pj-li${c.hidden ? ' off' : ''}" title="${esc(c.key)}">
      <i style="background:${COLORS[i % COLORS.length]}"></i><button class="pj-n" data-i="${i}">${esc(label(c.key))}</button><b class="num"></b><button data-rm="${i}" aria-label="Quitar curva">✕</button></div>`).join('');
    p.vals = [...p.legend.querySelectorAll('.pj-li:not(.xyx) b')];
    p.xval = p.legend.querySelector('.xyx b');
    p.legend.onclick = (e) => {
      const n = e.target.closest('[data-i]'), rm = e.target.closest('[data-rm]'), x = e.target.closest('[data-x]');
      if (n) { const c = l.curves[+n.dataset.i]; c.hidden = !c.hidden; this.save(); this.renderLegend(p); }
      if (rm) { l.curves.splice(+rm.dataset.rm, 1); if (!l.curves.length) l.xy = null; this.changed(); }
      if (x) { l.xy = null; p.xyRange = null; this.changed(); }
    };
  }

  bindDrop(p) {
    const zone = (e) => {
      const r = p.el.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
      const side = Object.keys(d).reduce((a, b) => (d[a] < d[b] ? a : b));
      return d[side] < EDGE ? side : 'center';
    };
    p.el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-sura-plot')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      p.el.dataset.drop = e.shiftKey && p.leaf.curves.length ? 'xy' : zone(e);
    });
    p.el.addEventListener('dragleave', (e) => { if (!p.el.contains(e.relatedTarget)) delete p.el.dataset.drop; });
    p.el.addEventListener('drop', (e) => {
      e.preventDefault();
      delete p.el.dataset.drop;
      let d;
      try { d = JSON.parse(e.dataTransfer.getData('application/x-sura-plot')); } catch { return; }
      const curves = d.keys.map((k) => ({ key: k, type: d.type, hidden: false }));
      const z = zone(e);
      if (e.shiftKey && p.leaf.curves.length) {
        // XY: lo que ya había es Y; lo soltado es X
        p.leaf.xy = { x: d.keys[0], xType: d.type };
        p.xyRange = null;
        toast(`XY: ${label(d.keys[0])} en el eje X`, 'ok', 'scatter-chart');
      } else if (z === 'center' || !p.leaf.curves.length) {
        for (const c of curves) if (!p.leaf.curves.some((x) => x.key === c.key)) p.leaf.curves.push(c);
      } else {
        const leaf = newLeaf();
        leaf.curves = curves;
        this.tab.root = split(this.tab.root, p.leaf.id, z, leaf);
      }
      this.changed();
      this.renderTree();
    });
  }

  bindMouse(p) {
    const c = p.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.25 : 0.8;
      const pt = this.toData(p, e);
      if (p.leaf.xy) {
        const r = p.xyRange ?? p.lastRange;
        if (!r) return;
        p.xyRange = { x: zoomAround(r.x, pt.x, f), y: zoomAround(r.y, pt.y, f) };
        return;
      }
      this.freeze();
      [this.view.xmin, this.view.xmax] = zoomAround([this.view.xmin, this.view.xmax], pt.x, f);
      this.renderPause();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      if (!p.lastRange) return;
      c.setPointerCapture(e.pointerId);
      const start = { e, data: this.toData(p, e), range: structuredClone(p.lastRange), view: { ...this.view } };
      this.drag = { p, start, box: e.button === 0 ? { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY } : null };
      if (e.button !== 0) this.freeze();
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!p.leaf.xy) this.view.cursor = this.toData(p, e).x;
      if (!d || d.p !== p) return;
      if (d.box) { d.box.x1 = e.offsetX; d.box.y1 = e.offsetY; return; }
      // arrastre con el botón derecho o central: desplazar
      const w = c.clientWidth - M.l - M.r, h = c.clientHeight - M.t - M.b;
      const r = d.start.range;
      const dx = ((e.clientX - d.start.e.clientX) / w) * (r.x[1] - r.x[0]);
      const dy = ((e.clientY - d.start.e.clientY) / h) * (r.y[1] - r.y[0]);
      const y = [r.y[0] + dy, r.y[1] + dy];
      if (p.leaf.xy) { p.xyRange = { x: [r.x[0] - dx, r.x[1] - dx], y }; return; }
      this.view.xmin = d.start.view.xmin - dx; this.view.xmax = d.start.view.xmax - dx;
      p.yRange = y;
    });
    const end = () => {
      const d = this.drag;
      if (!d || d.p !== p) return;
      this.drag = null;
      const b = d.box;
      if (!b || Math.abs(b.x1 - b.x0) < 6) return;
      const a = this.toData(p, { offsetX: b.x0, offsetY: b.y0 }), z = this.toData(p, { offsetX: b.x1, offsetY: b.y1 });
      const xr = [Math.min(a.x, z.x), Math.max(a.x, z.x)], yr = [Math.min(a.y, z.y), Math.max(a.y, z.y)];
      const tall = Math.abs(b.y1 - b.y0) >= 6;
      if (p.leaf.xy) { p.xyRange = { x: xr, y: tall ? yr : p.lastRange.y }; return; }
      this.freeze();
      [this.view.xmin, this.view.xmax] = xr;
      if (tall) p.yRange = yr;
      this.renderPause();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', () => { this.drag = null; });
    c.addEventListener('pointerleave', () => { this.view.cursor = null; });
    c.addEventListener('dblclick', () => { p.yRange = null; p.xyRange = null; if (!p.leaf.xy) this.live(); this.renderPause(); });
  }

  freeze() {
    if (!this.view.follow) return;
    this.view.follow = false;
    this.view.xmax = this.now();
    this.view.xmin = this.view.xmax - this.state.window;
  }

  toData(p, e) {
    const r = p.lastRange ?? { x: [0, 1], y: [0, 1] };
    const w = p.canvas.clientWidth - M.l - M.r, h = p.canvas.clientHeight - M.t - M.b;
    return {
      x: r.x[0] + ((e.offsetX - M.l) / w) * (r.x[1] - r.x[0]),
      y: r.y[1] - ((e.offsetY - M.t) / h) * (r.y[1] - r.y[0]),
    };
  }

  // ---------------- dibujo ----------------
  loop(ts) {
    requestAnimationFrame(this.loop);
    if (!this.visible || ts - this.lastDraw < 33) return;
    this.lastDraw = ts;
    if (this.view.follow) { this.view.xmax = this.now(); this.view.xmin = this.view.xmax - this.state.window; }
    const css = getComputedStyle(this.el);
    const theme = { fg: css.getPropertyValue('--fg').trim() || '#e8eaec', line: css.getPropertyValue('--line').trim() || '#444', deck: css.getPropertyValue('--deck').trim() || '#e8b931' };
    for (const p of this.panels.values()) this.draw(p, theme);
    this.liveValues();
  }

  // valores en vivo en el árbol, para ver qué se mueve
  liveValues() {
    for (const b of $('#pjTree').querySelectorAll('b[data-val]')) {
      const s = this.series.get(b.dataset.val);
      b.textContent = s?.length ? fmtNum(s.last()) : '';
    }
  }

  draw(p, theme) {
    const c = p.canvas, dpr = devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const curves = p.leaf.curves.map((cv, i) => ({ ...cv, color: COLORS[i % COLORS.length], s: this.series.get(cv.key) }));
    const vis = curves.filter((cv) => !cv.hidden && cv.s);
    const pw = W - M.l - M.r, ph = H - M.t - M.b;
    let xr, yr;

    if (p.leaf.xy) {
      const X = this.series.get(p.leaf.xy.x);
      const tr = [this.view.xmin, this.view.xmax];
      const pts = vis.map((cv) => xyPoints(cv.s, X, tr));
      const auto = boundsXY(pts);
      xr = p.xyRange?.x ?? pad(auto.x); yr = p.xyRange?.y ?? pad(auto.y);
      p.lastRange = { x: xr, y: yr };
      axes(g, theme, xr, yr, W, H, false);
      const sx = (v) => M.l + ((v - xr[0]) / (xr[1] - xr[0])) * pw, sy = (v) => M.t + (1 - (v - yr[0]) / (yr[1] - yr[0])) * ph;
      clip(g, W, H, () => vis.forEach((cv, j) => {
        const P = pts[j];
        g.strokeStyle = cv.color; g.lineWidth = 1.5; g.beginPath();
        P.forEach(([x, y], i) => (i ? g.lineTo(sx(x), sy(y)) : g.moveTo(sx(x), sy(y))));
        g.stroke();
        const lp = P.at(-1);
        if (lp) { g.fillStyle = cv.color; g.beginPath(); g.arc(sx(lp[0]), sy(lp[1]), 4, 0, 7); g.fill(); }
      }));
      if (p.xval) p.xval.textContent = fmtNum(X?.last());
      curves.forEach((cv, i) => { if (p.vals[i]) p.vals[i].textContent = fmtNum(cv.s?.last()); });
    } else {
      xr = [this.view.xmin, this.view.xmax];
      if (p.yRange) yr = p.yRange;
      else {
        let lo = Infinity, hi = -Infinity;
        for (const cv of vis) {
          const s = cv.s;
          for (let i = Math.max(s.start, s.indexAt(xr[0]) - 1); i < s.t.length && s.t[i] <= xr[1]; i++) { const v = s.v[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        }
        yr = pad(lo <= hi ? [lo, hi] : [-1, 1]);
      }
      p.lastRange = { x: xr, y: yr };
      axes(g, theme, xr, yr, W, H, true);
      const kx = pw / (xr[1] - xr[0]), ky = ph / (yr[1] - yr[0]);
      clip(g, W, H, () => {
        for (const cv of vis) {
          const s = cv.s;
          g.strokeStyle = cv.color; g.lineWidth = 1.5; g.beginPath();
          // un segmento vertical min-max por columna de píxel cuando hay muchos puntos
          let col = null, mn = 0, mx = 0, first = true;
          const flush = () => { if (col !== null) { g.lineTo(col, M.t + (yr[1] - mn) * ky); g.lineTo(col, M.t + (yr[1] - mx) * ky); } };
          for (let i = Math.max(s.start, s.indexAt(xr[0]) - 1); i < s.t.length; i++) {
            const X = Math.round(M.l + (s.t[i] - xr[0]) * kx), v = s.v[i];
            if (X !== col) {
              flush();
              const Y = M.t + (yr[1] - v) * ky;
              if (first) { g.moveTo(X, Y); first = false; } else g.lineTo(X, Y);
              col = X; mn = mx = v;
            } else { if (v < mn) mn = v; if (v > mx) mx = v; }
            if (s.t[i] > xr[1]) break;
          }
          flush();
          g.stroke();
        }
      });
      const cur = this.view.cursor;
      if (cur !== null && cur >= xr[0] && cur <= xr[1]) {
        const X = M.l + (cur - xr[0]) * kx;
        g.strokeStyle = theme.deck; g.lineWidth = 1; g.setLineDash([4, 3]);
        g.beginPath(); g.moveTo(X, M.t); g.lineTo(X, H - M.b); g.stroke(); g.setLineDash([]);
        for (const cv of vis) {
          const v = cv.s.valueAt(cur);
          if (v === null) continue;
          g.fillStyle = cv.color; g.beginPath(); g.arc(X, M.t + (yr[1] - v) * ky, 3.5, 0, 7); g.fill();
        }
      }
      const at = cur !== null && cur >= xr[0] && cur <= xr[1] ? cur : null;
      curves.forEach((cv, i) => { if (p.vals[i]) p.vals[i].textContent = fmtNum(at === null ? cv.s?.last() : cv.s?.valueAt(at)); });
    }

    const b = this.drag?.p === p ? this.drag.box : null;
    if (b) {
      g.fillStyle = 'rgba(232,185,49,.12)'; g.strokeStyle = theme.deck; g.lineWidth = 1;
      g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    }
  }

  exportCsv() {
    const named = [];
    for (const l of leaves(this.tab.root)) for (const c of l.curves) {
      const s = this.series.get(c.key);
      if (s?.length && !named.some((n) => n.name === c.key)) named.push({ name: c.key, series: s });
    }
    if (!named.length) { toast('No hay datos que exportar en esta pestaña', 'warn'); return; }
    download(`${this.tab.name.replace(/[^\w-]+/g, '_')}.csv`, toCsv(named), 'text/csv');
    toast(`CSV con ${named.length} series (tiempo en s desde que se abrió la app)`, 'ok', 'download');
  }

  findLeaf(id) { return findLeaf(this.tab.root, id); }
}

// ---------------- utilidades de dibujo ----------------
function label(k) {
  const { topic, path } = splitKey(k);
  return `${topic.split('/').filter(Boolean).slice(-1)[0]}/${path}`;
}
function fmtNum(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  const a = Math.abs(v);
  return a !== 0 && (a >= 1e5 || a < 1e-3) ? v.toExponential(2) : String(+v.toPrecision(5)).replace('.', ',');
}
function pad([lo, hi]) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];
  if (hi - lo < 1e-9) { const d = Math.abs(lo) * 0.1 || 1; return [lo - d, hi + d]; }
  const m = (hi - lo) * 0.06;
  return [lo - m, hi + m];
}
function zoomAround([a, b], x, f) { return [x - (x - a) * f, x + (b - x) * f]; }
function ticks(lo, hi, n) {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
function axes(g, theme, xr, yr, W, H, time) {
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  g.font = '11px "Barlow Condensed", "Barlow", sans-serif';
  g.strokeStyle = theme.line; g.fillStyle = theme.fg; g.lineWidth = 1;
  g.globalAlpha = 0.9;
  g.strokeRect(M.l + 0.5, M.t + 0.5, pw, ph);
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const v of ticks(yr[0], yr[1], Math.max(2, Math.floor(ph / 32)))) {
    const y = Math.round(M.t + (1 - (v - yr[0]) / (yr[1] - yr[0])) * ph) + 0.5;
    g.globalAlpha = 0.35; g.beginPath(); g.moveTo(M.l, y); g.lineTo(M.l + pw, y); g.stroke();
    g.globalAlpha = 0.8; g.fillText(fmtNum(v) || '0', M.l - 6, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const v of ticks(xr[0], xr[1], Math.max(2, Math.floor(pw / 80)))) {
    const x = Math.round(M.l + ((v - xr[0]) / (xr[1] - xr[0])) * pw) + 0.5;
    g.globalAlpha = 0.35; g.beginPath(); g.moveTo(x, M.t); g.lineTo(x, M.t + ph); g.stroke();
    g.globalAlpha = 0.8; g.fillText(time ? `${fmtNum(v) || '0'} s` : fmtNum(v) || '0', x, M.t + ph + 5);
  }
  g.globalAlpha = 1;
}
function clip(g, W, H, fn) {
  g.save(); g.beginPath(); g.rect(M.l, M.t, W - M.l - M.r, H - M.t - M.b); g.clip(); fn(); g.restore();
}
// XY: cada muestra de Y con el último valor de X en ese instante
function xyPoints(Y, X, [t0, t1]) {
  if (!X) return [];
  const out = [];
  for (let i = Math.max(Y.start, Y.indexAt(t0)); i < Y.t.length && Y.t[i] <= t1; i++) {
    const x = X.valueAt(Y.t[i]);
    if (x !== null) out.push([x, Y.v[i]]);
  }
  return out;
}
function boundsXY(sets) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const P of sets) for (const [x, y] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x0 <= x1 ? { x: [x0, x1], y: [y0, y1] } : { x: [-1, 1], y: [-1, 1] };
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
