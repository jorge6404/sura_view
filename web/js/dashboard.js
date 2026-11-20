// «Mi panel» de Pilotar: cuadrícula libre de widgets (dashgrid.js) con el catálogo de
// dashwidgets.js. Bloqueado mientras se pilota; «Editar panel» deja mover, redimensionar, quitar,
// añadir y ajustar. Los widgets solo están montados (suscritos) con Pilotar a la vista y en modo panel.
import { $, $$, icons, toast } from './ui.js';
import { esc } from './util.js';
import { COLS, add, bottom, move, newId, ownKey, readPanelFile, remove, resize, sanitize, stack } from './dashgrid.js';
import { GROUPS, TEMPLATES, WIDGETS, WIDGET_TYPES, widgetDef } from './dashwidgets.js';

const STORE = 'sura_view.dash';
const GAP = 10, MIN_ROW = 44, NARROW = 700, NARROW_ROW = 56, DRAG_START = 5;

const sizeOf = (type) => widgetDef(type)?.size || {};

function loadState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE)); } catch { /* almacenamiento bloqueado o roto */ }
  const layouts = {};
  const raw = s?.layouts && typeof s.layouts === 'object' ? s.layouts : {};
  // el acceso «go-3d» de la primera versión es ahora el widget de vista 3D de verdad
  const migrate = (items) => (Array.isArray(items) ? items.map((i) => (i?.type === 'go-3d' ? { ...i, type: 'viz3d', w: Math.max(i.w, 3), h: Math.max(i.h, 3) } : i)) : items);
  for (const name of Object.keys(raw)) layouts[name] = sanitize(migrate(raw[name]), WIDGET_TYPES, sizeOf).layout;
  if (!Object.keys(layouts).length) layouts['Mi panel'] = structuredClone(TEMPLATES.classic.items);
  const current = ownKey(layouts, s?.current) ? s.current : Object.keys(layouts)[0];
  return { view: s?.view === 'dash' ? 'dash' : 'classic', current, layouts };
}

export class Dashboard {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = loadState();
    this.active = false;          // Pilotar a la vista
    this.editing = false;
    this.mounted = new Map();     // id -> { el, body, inst, key }
    this.root = $('#dashRoot');
    this.grid = $('#dashGrid');
    this.bindUi();
    new ResizeObserver(() => this.layout()).observe(this.grid);
    this.applyView();
  }

  get items() { return this.state.layouts[this.state.current]; }
  set items(l) { this.state.layouts[this.state.current] = l; this.save(); }
  get narrow() { return this.grid.clientWidth > 0 && this.grid.clientWidth < NARROW; }

  save() {
    const { view, current, layouts } = this.state;
    try { localStorage.setItem(STORE, JSON.stringify({ view, current, layouts })); } catch { /* sigue en memoria */ }
  }

  // ---------------------------------------------------------------- vista
  setActive(on) { this.active = on; this.applyView(); }

  setView(view) {
    this.state.view = view;
    this.save();
    if (view === 'classic') this.setEditing(false);
    this.applyView();
  }

  applyView() {
    const dash = this.state.view === 'dash';
    $('#v-pilot').classList.toggle('dash', dash);
    for (const seg of $$('.viewseg')) for (const b of seg.children) b.setAttribute('aria-pressed', b.dataset.v === this.state.view);
    if (dash && this.active) this.render();
    else this.unmountAll();
  }

  setEditing(on) {
    if (on && this.narrow) { toast('Para editar el panel hace falta una pantalla más ancha', 'warn', 'monitor'); return; }
    this.editing = on;
    this.root.classList.toggle('editing', on);
    $('#dashEdit').innerHTML = on ? '<i data-lucide="check"></i>Hecho' : '<i data-lucide="layout-dashboard"></i>Editar panel';
    $('#dashEdit').classList.toggle('primary', on);
    $('#dashCatalog').hidden = !on;
    this.closePop();
    for (const m of this.mounted.values()) m.el.tabIndex = on ? 0 : -1;
    icons();
    this.render();
  }

  // ---------------------------------------------------------------- montaje
  unmountAll() {
    for (const [id, m] of this.mounted) { m.inst?.destroy?.(); m.el.remove(); this.mounted.delete(id); }
    $('#dashEmpty').hidden = true;
  }

  render() {
    if (this.state.view !== 'dash' || !this.active) return;
    $('#dashName').textContent = this.state.current;
    const items = this.items;
    $('#dashEmpty').hidden = items.length > 0;
    const ids = new Set(items.map((i) => i.id));
    for (const [id, m] of this.mounted) if (!ids.has(id)) { m.inst?.destroy?.(); m.el.remove(); this.mounted.delete(id); }
    for (const it of items) {
      const key = `${it.type}|${JSON.stringify(it.settings || {})}`;
      const m = this.mounted.get(it.id);
      if (m && m.key === key) continue;
      if (m) { m.inst?.destroy?.(); m.el.remove(); }
      this.mount(it, key);
    }
    this.layout();
  }

  mount(it, key) {
    const def = widgetDef(it.type);
    const el = document.createElement('article');
    el.className = `panel dw dw-${it.type}`;
    el.dataset.id = it.id;
    el.tabIndex = this.editing ? 0 : -1;
    el.setAttribute('aria-label', def.name);
    el.innerHTML = `<header class="dw-head">
        <i data-lucide="${def.icon}"></i><h2>${esc(def.name)}</h2>
        ${def.settings ? `<button class="dw-tool dw-gear" aria-label="Ajustes de ${esc(def.name)}" title="Ajustes"><i data-lucide="settings-2"></i></button>` : ''}
        <button class="dw-tool dw-x" aria-label="Quitar ${esc(def.name)}" title="Quitar"><i data-lucide="x"></i></button>
      </header><div class="dw-body"></div><span class="dw-resize" aria-hidden="true"></span>`;
    this.grid.append(el);
    let inst = null;
    try { inst = def.mount(el.querySelector('.dw-body'), this.ctx, it.settings || {}, it.id); } catch (e) {
      el.querySelector('.dw-body').innerHTML = `<p class="dw-sub">Este widget ha fallado: ${esc(e.message)}</p>`;
    }
    this.mounted.set(it.id, { el, body: el.querySelector('.dw-body'), inst, key });
    icons();
  }

  // ---------------------------------------------------------------- geometría
  metrics() {
    const W = this.grid.clientWidth, H = this.grid.clientHeight;
    const cw = (W - GAP * (COLS - 1)) / COLS;
    const rh = this.narrow ? NARROW_ROW : Math.max(MIN_ROW, (H - GAP * 11) / 12);
    return { cw, rh, sx: cw + GAP, sy: rh + GAP };
  }

  shown() { return this.narrow ? stack(this.items) : (this.preview || this.items); }

  layout() {
    if (this.state.view !== 'dash' || !this.active || !this.grid.clientWidth) return;
    const { cw, rh, sx, sy } = this.metrics();
    const l = this.shown();
    this.root.classList.toggle('narrow', this.narrow);
    if (this.narrow && this.editing) this.setEditing(false);
    this.grid.style.setProperty('--cw', `${cw}px`);
    this.grid.style.setProperty('--rh', `${rh}px`);
    const rows = Math.max(bottom(l) + (this.editing ? 3 : 0), 12);
    $('#dashSpace').style.height = `${rows * sy - GAP}px`;
    let ny = 0;    // en una columna: cada widget con al menos 3 filas, uno debajo de otro
    for (const it of l) {
      const m = this.mounted.get(it.id);
      if (!m || m.el === this.drag?.el) continue;
      const h = (this.narrow ? Math.max(it.h, 3) : it.h) * sy - GAP;
      const top = this.narrow ? ny : it.y * sy;
      ny += h + GAP;
      const first = !m.placed;      // recién montado: a su sitio sin animar desde la esquina
      if (first) m.el.style.transition = 'none';
      Object.assign(m.el.style, { width: `${it.w * sx - GAP}px`, height: `${h}px`, transform: `translate(${it.x * sx}px, ${top}px)` });
      if (first) { m.placed = true; m.el.getBoundingClientRect(); m.el.style.transition = ''; }
    }
    if (this.narrow) $('#dashSpace').style.height = `${ny - GAP}px`;
    const g = $('#dashGhost'), p = this.drag && this.preview?.find((i) => i.id === this.drag.id);
    g.hidden = !p;
    if (p) Object.assign(g.style, { width: `${p.w * sx - GAP}px`, height: `${p.h * sy - GAP}px`, transform: `translate(${p.x * sx}px, ${p.y * sy}px)` });
  }

  // ---------------------------------------------------------------- arrastrar y redimensionar
  cellAt(clientX, clientY) {
    const r = this.grid.getBoundingClientRect(), { sx, sy } = this.metrics();
    return { x: (clientX - r.left + this.grid.scrollLeft) / sx, y: (clientY - r.top + this.grid.scrollTop) / sy };
  }

  startDrag(e, id, mode) {
    const m = this.mounted.get(id), it = this.items.find((i) => i.id === id);
    if (!m || !it) return;
    e.preventDefault();
    const r = m.el.getBoundingClientRect(), g = this.grid.getBoundingClientRect();
    this.drag = { id, el: m.el, mode, x0: e.clientX, y0: e.clientY, moved: false, scroll0: this.grid.scrollTop,
      left: r.left - g.left + this.grid.scrollLeft, top: r.top - g.top + this.grid.scrollTop, w: r.width, h: r.height, it };
    m.el.setPointerCapture(e.pointerId);
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0 + this.grid.scrollTop - d.scroll0;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_START) return;
    if (!d.moved) { d.moved = true; d.el.classList.add('dragging'); this.root.classList.add('dragging'); }
    const { sx, sy } = this.metrics();
    if (d.mode === 'move') {
      d.el.style.transform = `translate(${d.left + dx}px, ${d.top + dy}px)`;
      this.preview = move(this.items, d.id, Math.round((d.left + dx) / sx), Math.round((d.top + dy) / sy));
    } else {
      const w = Math.max(80, d.w + dx), h = Math.max(MIN_ROW, d.h + dy);
      Object.assign(d.el.style, { width: `${w}px`, height: `${h}px` });
      this.preview = resize(this.items, d.id, Math.round((w + GAP) / sx), Math.round((h + GAP) / sy), widgetDef(d.it.type).size);
    }
    this.autoScroll(e.clientY);
    this.layout();
  }

  onUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.el.classList.remove('dragging');
    this.root.classList.remove('dragging');
    if (d.moved && this.preview) this.items = this.preview;
    this.preview = null;
    this.layout();
  }

  autoScroll(clientY) {
    const r = this.grid.getBoundingClientRect();
    if (clientY > r.bottom - 40) this.grid.scrollTop += 12;
    else if (clientY < r.top + 40) this.grid.scrollTop -= 12;
  }

  // desde el catálogo: arrastrar al panel o clic (va al primer hueco)
  startAdd(e, type) {
    if (e.button !== 0) return;
    e.preventDefault();
    const def = widgetDef(type);
    const card = e.currentTarget;
    const t = { type, x0: e.clientX, y0: e.clientY, moved: false, ghost: null };
    const moveH = (ev) => {
      if (!t.moved && Math.hypot(ev.clientX - t.x0, ev.clientY - t.y0) < DRAG_START) return;
      if (!t.moved) {
        t.moved = true;
        t.ghost = card.cloneNode(true);
        t.ghost.classList.add('dash-fly');
        document.body.append(t.ghost);
        this.root.classList.add('dragging');
      }
      t.ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;
      const r = this.grid.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      const g = $('#dashGhost');
      if (!inside) { g.hidden = true; t.cell = null; return; }
      const c = this.cellAt(ev.clientX, ev.clientY);
      t.cell = { x: Math.max(0, Math.floor(c.x - def.size.w / 2 + 0.5)), y: Math.max(0, Math.floor(c.y)) };
      const { sx, sy } = this.metrics();
      const x = Math.min(t.cell.x, COLS - def.size.w);
      g.hidden = false;
      Object.assign(g.style, { width: `${def.size.w * sx - GAP}px`, height: `${def.size.h * sy - GAP}px`, transform: `translate(${x * sx}px, ${t.cell.y * sy}px)` });
      this.autoScroll(ev.clientY);
    };
    const upH = (ev) => {
      document.removeEventListener('pointermove', moveH);
      document.removeEventListener('pointerup', upH);
      document.removeEventListener('pointercancel', upH);
      t.ghost?.remove();
      $('#dashGhost').hidden = true;
      this.root.classList.remove('dragging');
      if (ev.type === 'pointercancel' || (t.moved && !t.cell)) return;
      this.addWidget(type, t.moved ? t.cell : null);
    };
    document.addEventListener('pointermove', moveH);
    document.addEventListener('pointerup', upH);
    document.addEventListener('pointercancel', upH);
  }

  addWidget(type, cell) {
    const def = widgetDef(type);
    const item = { id: newId(this.items, type), type, w: def.size.w, h: def.size.h, ...(cell || {}) };
    this.items = add(this.items, item, def.size);
    this.render();
    const m = this.mounted.get(item.id);
    m?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    m?.el.classList.add('fresh');
    setTimeout(() => m?.el.classList.remove('fresh'), 900);
  }

  // lo que un widget deja abierto fuera de la página (la pty de una terminal) se cierra al quitarlo
  forget(items) {
    for (const it of items) widgetDef(it.type)?.forget?.(it.id, this.ctx);
  }

  removeWidget(id) {
    this.forget(this.items.filter((i) => i.id === id));
    this.items = remove(this.items, id);
    this.render();
  }

  // ---------------------------------------------------------------- teclado (en edición)
  onKey(e) {
    if (e.key === 'Escape' && this.editing) { if (this.pop) this.closePop(); else this.setEditing(false); return; }
    const el = e.target.closest?.('.dw');
    if (!this.editing || !el || e.target !== el) return;
    const id = el.dataset.id, it = this.items.find((i) => i.id === id);
    if (!it) return;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (d) {
      e.preventDefault();
      this.items = e.shiftKey ? resize(this.items, id, it.w + d[0], it.h + d[1], widgetDef(it.type).size) : move(this.items, id, it.x + d[0], it.y + d[1]);
      this.layout();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const next = el.nextElementSibling?.classList.contains('dw') ? el.nextElementSibling : null;
      this.removeWidget(id);
      next?.focus();
    }
  }

  // ---------------------------------------------------------------- ajustes de un widget
  openSettings(id, anchor) {
    this.closePop();
    const it = this.items.find((i) => i.id === id), def = widgetDef(it.type);
    const pop = document.createElement('div');
    pop.className = 'dash-pop glass';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Ajustes de ${def.name}`);
    pop.innerHTML = `<b>${esc(def.name)}</b>${def.settings.map((s) => `<label>${esc(s.label)}<select data-k="${s.k}">${s.options(this.ctx).map((o) => `<option value="${esc(o.value)}" ${(it.settings?.[s.k] ?? '') === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`).join('')}`;
    pop.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      this.items = this.items.map((i) => (i.id === id ? { ...i, settings: { ...i.settings, [k]: e.target.value } } : i));
      this.render();
    });
    this.root.append(pop);
    const a = anchor.getBoundingClientRect(), r = this.root.getBoundingClientRect();
    pop.style.left = `${Math.min(a.right - r.left - pop.offsetWidth, r.width - pop.offsetWidth - 8)}px`;
    pop.style.top = `${a.bottom - r.top + 6}px`;
    pop.querySelector('select')?.focus();
    this.pop = pop;
  }

  closePop() { this.pop?.remove(); this.pop = null; }

  // ---------------------------------------------------------------- paneles y plantillas
  menu(kind, anchor) {
    const m = $('#dashMenu');
    if (m.classList.contains('on') && m.dataset.kind === kind) { m.classList.remove('on'); return; }
    m.dataset.kind = kind;
    if (kind === 'panels') {
      const names = Object.keys(this.state.layouts);
      m.innerHTML = `<span class="label">Tus paneles</span>${names.map((n) => `<button data-act="open" data-name="${esc(n)}" aria-current="${n === this.state.current}"><i data-lucide="${n === this.state.current ? 'check' : 'layout-dashboard'}"></i><div>${esc(n)}<small>${this.state.layouts[n].length} widgets</small></div></button>`).join('')}
        <hr><button data-act="new"><i data-lucide="plus"></i><div>Panel nuevo vacío</div></button>
        <button data-act="dup"><i data-lucide="copy"></i><div>Duplicar este panel</div></button>
        <button data-act="rename"><i data-lucide="pencil"></i><div>Renombrar</div></button>
        <button data-act="export"><i data-lucide="download"></i><div>Exportar<small>Fichero .json para otro ordenador</small></div></button>
        <button data-act="import"><i data-lucide="upload"></i><div>Importar…</div></button>
        <button data-act="delete" ${names.length < 2 ? 'disabled' : ''}><i data-lucide="trash-2"></i><div>Borrar este panel</div></button>`;
    } else {
      m.innerHTML = `<span class="label">Empezar desde una plantilla</span>${Object.entries(TEMPLATES).map(([k, t]) => `<button data-act="tpl" data-tpl="${k}"><i data-lucide="layout-template"></i><div>${esc(t.name)}<small>${esc(t.desc)}</small></div></button>`).join('')}`;
    }
    const a = anchor.getBoundingClientRect(), r = this.root.getBoundingClientRect();
    m.style.left = `${a.left - r.left}px`;
    m.style.top = `${a.bottom - r.top + 6}px`;
    m.classList.add('on');
    icons();
  }

  onMenu(btn) {
    $('#dashMenu').classList.remove('on');
    const act = btn.dataset.act, L = this.state.layouts;
    const askName = (q, def) => {
      const n = (prompt(q, def) || '').trim();
      if (!n) return null;
      if (ownKey(L, n) && n !== this.state.current) { toast(`Ya hay un panel «${n}»`, 'warn'); return null; }
      return n;
    };
    if (act === 'open') this.state.current = btn.dataset.name;
    else if (act === 'new') { const n = askName('Nombre del panel nuevo', 'Panel nuevo'); if (!n) return; L[n] = []; this.state.current = n; this.setEditing(true); }
    else if (act === 'dup') { const n = askName('Nombre de la copia', `${this.state.current} (copia)`); if (!n) return; L[n] = structuredClone(this.items); this.state.current = n; }
    else if (act === 'rename') {
      const n = askName('Nuevo nombre', this.state.current);
      if (!n || n === this.state.current) return;
      const next = {};
      for (const [k, v] of Object.entries(L)) next[k === this.state.current ? n : k] = v;
      this.state.layouts = next; this.state.current = n;
    } else if (act === 'delete') {
      if (!confirm(`¿Borrar el panel «${this.state.current}»? No se puede deshacer.`)) return;
      this.forget(this.items);
      delete L[this.state.current];
      this.state.current = Object.keys(L)[0];
    } else if (act === 'export') { this.exportJson(); return; }
    else if (act === 'import') { $('#dashFile').click(); return; }
    else if (act === 'tpl') {
      const t = TEMPLATES[btn.dataset.tpl];
      if (this.items.length && !confirm(`¿Cambiar «${this.state.current}» por la plantilla ${t.name}? Se pierde cómo está ahora.`)) return;
      this.forget(this.items);
      this.items = structuredClone(t.items);
      toast(`Plantilla ${t.name}`, 'ok', 'layout-template');
    }
    this.save();
    this.render();
  }

  exportJson() {
    const blob = new Blob([JSON.stringify({ format: 'sura_view.panel', version: 1, name: this.state.current, items: this.items }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `panel-${this.state.current.replace(/[^\w-]+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Panel exportado: ${a.download}`, 'ok', 'download');
  }

  async importJson(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('Ese fichero no es un panel (no es JSON válido)', 'err'); return; }
    const { layout, dropped, name: given, warn } = readPanelFile(data, WIDGET_TYPES, sizeOf);
    if (!layout.length) { toast(`${warn || (dropped ? `Ningún widget del fichero se puede usar (${dropped} descartados)` : 'Ese fichero no trae ningún widget')}. El panel no ha cambiado.`, 'err'); return; }
    const base = given || file.name.replace(/\.json$/i, '').trim() || 'Importado';
    let name = base;
    for (let n = 2; ownKey(this.state.layouts, name); n++) name = `${base} (${n})`;
    this.state.layouts[name] = layout;
    this.state.current = name;
    this.save();
    this.render();
    if (warn) toast(warn, 'warn');
    else toast(dropped ? `Importado «${name}»; ${dropped === 1 ? 'un widget no se reconoce y se ha quitado' : `${dropped} widgets no se reconocen y se han quitado`}` : `Importado «${name}»`, dropped ? 'warn' : 'ok', 'upload');
  }

  // ---------------------------------------------------------------- catálogo e interfaz
  buildCatalog() {
    $('#dashCatalogList').innerHTML = GROUPS.map((g) => `<section><h3 class="label">${g}</h3>${WIDGETS.filter((w) => w.group === g).map((w) => `
      <button class="dash-card" data-type="${w.type}" title="Arrastra al panel o pulsa para añadir">
        <span class="dash-card-ic"><i data-lucide="${w.icon}"></i></span>
        <span class="dash-card-tx"><b>${esc(w.name)}</b><small>${esc(w.desc)}</small></span>
      </button>`).join('')}</section>`).join('');
    for (const c of $$('.dash-card')) {
      c.addEventListener('pointerdown', (e) => this.startAdd(e, c.dataset.type));
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.addWidget(c.dataset.type, null); } });
    }
  }

  bindUi() {
    for (const seg of $$('.viewseg')) seg.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) this.setView(b.dataset.v); });
    $('#dashEdit').addEventListener('click', () => this.setEditing(!this.editing));
    $('#dashPanels').addEventListener('click', (e) => this.menu('panels', e.currentTarget));
    $('#dashTemplates').addEventListener('click', (e) => this.menu('templates', e.currentTarget));
    $('#dashMenu').addEventListener('click', (e) => { const b = e.target.closest('button[data-act]'); if (b && !b.disabled) this.onMenu(b); });
    $('#dashFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.importJson(f); });
    $('#dashEmpty').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b?.dataset.tpl) { this.items = structuredClone(TEMPLATES[b.dataset.tpl].items); this.render(); }
      else if (b) this.setEditing(true);
    });
    $('#dashEmpty').innerHTML = `<i data-lucide="layout-dashboard"></i><h3>Este panel está vacío</h3><p>Empieza con una plantilla o monta el tuyo desde el catálogo.</p>
      <div class="dash-empty-tpl">${Object.entries(TEMPLATES).map(([k, t]) => `<button class="btn" data-tpl="${k}"><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></button>`).join('')}</div>
      <button class="btn primary" data-catalog><i data-lucide="plus"></i>Abrir el catálogo</button>`;
    this.grid.addEventListener('pointerdown', (e) => {
      if (!this.editing) return;
      const el = e.target.closest('.dw');
      if (!el || e.button !== 0) return;
      if (e.target.closest('.dw-x')) { this.removeWidget(el.dataset.id); return; }
      if (e.target.closest('.dw-gear')) { e.preventDefault(); this.openSettings(el.dataset.id, e.target.closest('.dw-gear')); return; }
      if (e.target.closest('.dw-resize')) this.startDrag(e, el.dataset.id, 'resize');
      else if (e.target.closest('.dw-head')) this.startDrag(e, el.dataset.id, 'move');
    });
    this.grid.addEventListener('pointermove', (e) => this.onMove(e));
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) this.grid.addEventListener(ev, () => this.onUp());
    this.grid.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.state.view === 'dash' && this.active) this.onKey(e); });
    document.addEventListener('pointerdown', (e) => {
      if (this.pop && !this.pop.contains(e.target) && !e.target.closest('.dw-gear')) this.closePop();
      if (!e.target.closest('#dashMenu, #dashPanels, #dashTemplates')) $('#dashMenu').classList.remove('on');
    });
    this.buildCatalog();
    icons();
  }
}
